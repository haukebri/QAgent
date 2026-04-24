import { Agent } from '@mariozechner/pi-agent-core';
import { observe } from './observer.js';
import { click, fill, navigate } from './tools.js';

const HISTORY_WINDOW = 5;

const SYSTEM_PROMPT =
  'You plan one browser action at a time toward a goal. Respond with a single JSON object and nothing else (no markdown fences, no commentary).\n\n' +
  'Schema:\n' +
  '  { "action": "navigate" | "click" | "fill" | "wait" | "done" | "fail",\n' +
  '    "url"?: string, "ref"?: string, "value"?: string, "ms"?: number, "summary"?: string, "reason"?: string }\n\n' +
  'Examples:\n' +
  '  {"action": "navigate", "url": "https://example.com"}\n' +
  '  {"action": "click", "ref": "e6"}\n' +
  '  {"action": "fill", "ref": "e40", "value": "playwright"}\n' +
  '  {"action": "wait", "ms": 1500}\n' +
  '  {"action": "done", "summary": "There are 42 projects."}\n' +
  '  {"action": "fail", "reason": "The admin page shows counts only; no user list is rendered."}\n\n' +
  'Use "wait" when the page is in a transitional state (loading spinners, "Signing in..." buttons, disabled submit buttons). ' +
  "NEVER call done if the URL still matches a login page, or if loading indicators/disabled submit buttons are visible. " +
  'Wait first, then re-check.\n\n' +
  'Pick "done" when the goal is clearly complete — include a "summary" that answers any question the goal asked for. ' +
  'Pick "fail" when the goal is clearly impossible on this page/app — include a clear "reason". ' +
  "Don't fabricate: if you cannot literally verify what the goal asks for, use \"fail\".";

export async function runTodo(page, goal, model, apiKey, maxTurns = 20) {
  const initialUrl = page.url();
  const t0 = Date.now();

  const agent = new Agent({
    initialState: { systemPrompt: SYSTEM_PROMPT, model },
    getApiKey: async () => apiKey,
  });

  const history = [];
  const warnings = [];
  const tokens = { input: 0, output: 0, totalTokens: 0, cost: 0 };
  let turns = 0;
  let lastError = null;
  let summary = null;
  let reason = null;

  while (turns < maxTurns) {
    turns++;
    const snapshot = await observe(page);
    const url = page.url();

    const { action, usage } = await askNextAction({ agent, goal, url, snapshot, history, lastError });
    if (usage) {
      tokens.input += usage.input ?? 0;
      tokens.output += usage.output ?? 0;
      tokens.totalTokens += usage.totalTokens ?? 0;
      tokens.cost += usage.cost?.total ?? 0;
    }

    if (action.action === 'done') { summary = action.summary ?? null; break; }
    if (action.action === 'fail') { reason = action.reason ?? null; break; }

    if ((action.action === 'click' || action.action === 'fill') && action.ref) {
      if (!snapshot.includes(`[ref=${action.ref}]`)) {
        lastError = `ref ${action.ref} is not present in the current snapshot; pick a ref from the latest snapshot above`;
        history.push({ turn: turns, action, error: lastError });
        continue;
      }
    }

    try {
      if (action.action === 'navigate') await navigate(page, action.url);
      else if (action.action === 'click') await click(page, action.ref);
      else if (action.action === 'fill') await fill(page, action.ref, action.value);
      else if (action.action === 'wait') await page.waitForTimeout(action.ms ?? 1000);
      else throw new Error(`unknown action: ${action.action}`);
      history.push({ turn: turns, action });
      lastError = null;
    } catch (err) {
      lastError = err.message.split('\n')[0];
      history.push({ turn: turns, action, error: lastError });
    }
  }

  const finalUrl = page.url();
  if (summary !== null && finalUrl === initialUrl) {
    warnings.push(`done called but URL never changed from initial (${initialUrl})`);
  }

  const outcome = summary !== null ? 'pass' : reason !== null ? 'fail' : 'stuck';
  return { outcome, summary, reason, turns, elapsedMs: Date.now() - t0, tokens, finalUrl, history, warnings };
}

async function askNextAction({ agent, goal, url, snapshot, history, lastError }) {
  agent.reset();
  const historyBlock = history.length
    ? `\n\nRecent actions (most recent last):\n${history.slice(-HISTORY_WINDOW).map((h, i) => `  ${i + 1}. ${JSON.stringify(h.action)}${h.error ? ` -> error: ${h.error}` : ''}`).join('\n')}\n`
    : '';
  const errorBlock = lastError ? `\n\nPrevious action failed: ${lastError}\nAdjust your choice.\n` : '';
  await agent.prompt(
    `Goal: ${goal}\n\nCurrent URL: ${url}${historyBlock}${errorBlock}\n\nCurrent snapshot:\n${snapshot}\n\nNext action (JSON only):`
  );
  const last = [...agent.state.messages].reverse().find(m => m.role === 'assistant');
  const text = last?.content.filter(c => c.type === 'text').map(c => c.text).join('') ?? '';
  const usage = last?.usage ?? null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`no JSON in LLM response: ${text}`);
  return { action: JSON.parse(match[0]), usage };
}
