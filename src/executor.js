import { Agent } from '@mariozechner/pi-agent-core';
import { observe, click, fill, navigate } from './tools.js';
import { verify } from './verifier.js';

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
  "Don't fabricate: if you cannot literally verify what the goal asks for, use \"fail\".\n\n" +
  'Element heuristics: prefer refs labelled `link` (which show a `- /url: …` line) or ' +
  '`button`, `textbox`, `menuitem`. A `generic [cursor=pointer]` span is often a ' +
  'dropdown / mega-menu trigger that expands inline rather than navigating — if you ' +
  'click one and see "page grew +NNN chars" without a URL change, new menu items ' +
  'appeared in the snapshot; look for them instead of re-clicking the same ref.';

export async function runTodo(page, goal, model, apiKey, maxTurns = 20, verifierModel = null) {
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
  let verdict = null;
  let fatalError = null;
  let finalSnapshot = '';

  let prevSnapshotLen = null;

  while (turns < maxTurns) {
    turns++;
    try {
      const snapshot = await observe(page);
      // Retroactively annotate the previous action with the DOM effect it had:
      // the delta in snapshot size between before-action and after-action.
      // This lets the LLM distinguish clicks that mutated the page (opened a
      // dropdown, loaded content) from clicks that were true no-ops.
      if (prevSnapshotLen !== null && history.length > 0) {
        const last = history[history.length - 1];
        if (last.action?.action !== 'wait') {
          last.snapshotDelta = snapshot.length - prevSnapshotLen;
        }
      }
      prevSnapshotLen = snapshot.length;
      finalSnapshot = snapshot;
      const url = page.url();

      const { action, usage } = await askNextAction({ agent, goal, url, snapshot, history, lastError });
      if (usage) {
        tokens.input += usage.input ?? 0;
        tokens.output += usage.output ?? 0;
        tokens.totalTokens += usage.totalTokens ?? 0;
        tokens.cost += usage.cost?.total ?? 0;
      }

      if (action.action === 'done' || action.action === 'fail') {
        verdict = {
          action: action.action,
          summary: action.summary ?? null,
          reason: action.reason ?? null,
        };
        break;
      }

      if ((action.action === 'click' || action.action === 'fill') && action.ref) {
        if (!snapshot.includes(`[ref=${action.ref}]`)) {
          lastError = `ref ${action.ref} is not present in the current snapshot; pick a ref from the latest snapshot above`;
          history.push({ turn: turns, atMs: Date.now() - t0, action, url, error: lastError });
          continue;
        }
      }

      const entry = { turn: turns, atMs: Date.now() - t0, action };
      if (action.action === 'click' || action.action === 'fill') {
        const target = labelForRef(snapshot, action.ref);
        if (target) entry.target = target;
      }
      const tAction = Date.now();
      try {
        if (action.action === 'navigate') await navigate(page, action.url);
        else if (action.action === 'click') await click(page, action.ref);
        else if (action.action === 'fill') await fill(page, action.ref, action.value);
        else if (action.action === 'wait') await page.waitForTimeout(action.ms ?? 1000);
        else throw new Error(`unknown action: ${action.action}`);
        entry.ms = Date.now() - tAction;
        entry.url = page.url();
        history.push(entry);
        lastError = null;
      } catch (err) {
        lastError = err.message.split('\n')[0];
        entry.ms = Date.now() - tAction;
        entry.url = page.url();
        entry.error = lastError;
        history.push(entry);
      }
    } catch (err) {
      fatalError = err.message.split('\n')[0];
      break;
    }
  }

  const finalUrl = page.url();
  const elapsedMs = Date.now() - t0;

  if (fatalError !== null) {
    return {
      outcome: 'error',
      evidence: fatalError,
      llmVerdict: verdict,
      turns, elapsedMs,
      tokens, verifierTokens: null,
      finalUrl, finalSnapshot,
      history, warnings,
    };
  }

  const verifierVerdict = verdict ?? { action: 'stuck', summary: null, reason: null };
  const judgeModel = verifierModel ?? model;

  let outcome;
  let evidence;
  let verifierTokens = null;
  try {
    const result = await verify(goal, verifierVerdict, history, finalUrl, finalSnapshot, judgeModel, apiKey);
    outcome = result.outcome;
    evidence = result.evidence;
    verifierTokens = result.tokens;
  } catch (err) {
    warnings.push(`verifier unavailable: ${err.message.split('\n')[0]}; fell back to driver verdict`);
    ({ outcome, evidence } = fallbackFromVerdict(verifierVerdict));
  }

  return {
    outcome,
    evidence,
    llmVerdict: verdict,
    turns, elapsedMs,
    tokens, verifierTokens,
    finalUrl, finalSnapshot,
    history, warnings,
  };
}

function fallbackFromVerdict(v) {
  if (v.action === 'done' && v.summary) return { outcome: 'pass', evidence: v.summary };
  if (v.action === 'fail' && v.reason) return { outcome: 'fail', evidence: v.reason };
  if (v.action === 'done') return { outcome: 'fail', evidence: "driver said 'done' without summary" };
  if (v.action === 'fail') return { outcome: 'fail', evidence: "driver said 'fail' without reason" };
  return { outcome: 'fail', evidence: 'turn cap hit; no terminal verdict' };
}

function labelForRef(snapshot, ref) {
  const re = new RegExp(`^\\s*-\\s*(\\w+)(?:\\s+"([^"]*)")?[^\\n]*\\[ref=${ref}\\]`, 'm');
  const m = snapshot.match(re);
  if (!m) return null;
  const [, role, name] = m;
  return name ? `${role} '${name}'` : role;
}

function formatHistoryEntry(h) {
  const act = JSON.stringify(h.action);
  if (h.error) return `${act} -> error: ${h.error}`;
  const bits = [];
  if (h.url) bits.push(`url=${h.url}`);
  if (typeof h.snapshotDelta === 'number') {
    const d = h.snapshotDelta;
    if (d > 200) bits.push(`page grew +${d} chars (new content appeared)`);
    else if (d < -200) bits.push(`page shrunk ${d} chars (content removed)`);
    else bits.push('page unchanged');
  }
  return bits.length ? `${act} -> ${bits.join('; ')}` : act;
}

async function askNextAction({ agent, goal, url, snapshot, history, lastError }) {
  agent.reset();
  const historyBlock = history.length
    ? `\n\nRecent actions (most recent last):\n${history.slice(-HISTORY_WINDOW).map((h, i) => `  ${i + 1}. ${formatHistoryEntry(h)}`).join('\n')}\n`
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
