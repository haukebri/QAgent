import { chromium } from 'playwright';
import { Agent } from '@mariozechner/pi-agent-core';
import { getModel } from '@mariozechner/pi-ai';
import { observe } from './observer.js';
import { click, fill, navigate } from './tools.js';

const modelId = process.env.LLM_MODEL;
const apiKey = process.env.LLM_API_KEY;
if (!modelId || !apiKey) throw new Error('LLM_MODEL / LLM_API_KEY missing (use --env-file=.env)');
const model = getModel('openrouter', modelId);
if (!model) throw new Error(`unknown model: ${modelId}`);

const GOAL =
  'Navigate to https://req-eng-frontend.haukebrinkmann.com/ and log in using ' +
  'email "haukebr@gmail.com" and password "test123". After logging in, navigate ' +
  'to the admin page and verify that a list of users (names, emails, or similar ' +
  'per-user rows) is visible. Emit {"action": "done", "summary": "..."} with a ' +
  'description of the list if you see one. If only counts/statistics are shown ' +
  'but no actual user list, emit {"action": "fail", "reason": "..."}.';
const MAX_TURNS = 20;
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

// Reuse a single Agent across turns (reset between calls) instead of new Agent per turn.
const agent = new Agent({
  initialState: { systemPrompt: SYSTEM_PROMPT, model },
  getApiKey: async () => apiKey,
});

async function askNextAction({ goal, url, snapshot, history, lastError }) {
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

const browser = await chromium.launch();
const context = await browser.newContext({
  httpCredentials: { username: 'req', password: 'req' },
});
const page = await context.newPage();
const initialUrl = page.url();

const t0 = Date.now();
try {
  let turns = 0;
  let finalSummary = null;
  let finalFailure = null;
  let lastError = null;
  const history = [];
  const total = { input: 0, output: 0, totalTokens: 0, cost: 0 };

  while (turns < MAX_TURNS) {
    turns++;
    const snapshot = await observe(page);
    const url = page.url();
    const { action, usage } = await askNextAction({ goal: GOAL, url, snapshot, history, lastError });
    if (usage) {
      total.input += usage.input ?? 0;
      total.output += usage.output ?? 0;
      total.totalTokens += usage.totalTokens ?? 0;
      total.cost += usage.cost?.total ?? 0;
    }
    console.log(`turn ${turns}: ${JSON.stringify(action)}`);

    if (action.action === 'done') { finalSummary = action.summary ?? null; break; }
    if (action.action === 'fail') { finalFailure = action.reason ?? null; break; }

    // Ref staleness pre-check — avoid 10s Playwright timeouts on known-bad refs.
    if ((action.action === 'click' || action.action === 'fill') && action.ref) {
      if (!snapshot.includes(`[ref=${action.ref}]`)) {
        lastError = `ref ${action.ref} is not present in the current snapshot; pick a ref from the latest snapshot above`;
        history.push({ turn: turns, action, error: lastError });
        console.log(`  error (pre-check): ${lastError}`);
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
      console.log(`  error: ${lastError}`);
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const perTurn = turns ? (elapsed / turns).toFixed(1) : '-';
  console.log(`final url: ${page.url()}`);
  console.log(`turns: ${turns} | elapsed: ${elapsed}s | avg/turn: ${perTurn}s`);
  console.log(`tokens: ${total.totalTokens} (in=${total.input}, out=${total.output}) | cost: $${total.cost.toFixed(4)}`);
  if (finalSummary !== null) {
    console.log(`PASS: ${finalSummary}`);
    if (page.url() === initialUrl) {
      console.log(`⚠  WARNING: done called but URL never changed from initial (${initialUrl})`);
    }
  } else if (finalFailure !== null) {
    console.log(`FAIL: ${finalFailure}`);
  } else {
    console.log(`STUCK: hit turn cap (${MAX_TURNS})`);
  }
} finally {
  await browser.close();
}
