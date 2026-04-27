import { createHash, randomUUID } from 'node:crypto';
import { Agent } from '@mariozechner/pi-agent-core';
import { observe, click, fill, navigate } from './tools.js';
import { verify } from './verifier.js';
import { sliceSections, compressAgainstBaseline } from './snapshot-compress.js';

const SNAPSHOT_BEGIN = '<<SNAPSHOT_BEGIN>>';
const SNAPSHOT_END = '<<SNAPSHOT_END>>';
const SCRUBBED_SNAPSHOT = '[snapshot omitted; see latest snapshot below]';

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
  'appeared in the snapshot; look for them instead of re-clicking the same ref.\n\n' +
  `Snapshots in earlier user messages are replaced with "${SCRUBBED_SNAPSHOT}" — only the latest snapshot is current. ` +
  'Always pick refs from the latest snapshot.\n\n' +
  'A user message beginning "Baseline anchor (turn N)." is a pinned reference snapshot kept in full. ' +
  'In the latest snapshot, a section body may read "# unchanged since turn N" — that section is byte-identical to the baseline anchor\'s, ' +
  'so its refs are the SAME numbers as in the anchor. Look up element details there.';

export async function runTodo(page, goal, model, apiKey, maxTurns = 20, verifierModel = null, onTurn = null) {
  const t0 = Date.now();

  const scrubState = { baselineTurn: 0 };
  const agent = new Agent({
    initialState: { systemPrompt: SYSTEM_PROMPT, model },
    sessionId: randomUUID(),
    transformContext: async (messages) => scrubOldSnapshots(messages, scrubState.baselineTurn),
    getApiKey: async () => apiKey,
  });

  const history = [];
  const warnings = [];
  const snapshotStats = [];
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
  let turns = 0;
  let lastError = null;
  let verdict = null;
  let fatalError = null;
  let finalSnapshot = '';

  let prevSnapshotLen = null;
  let baseline = null;
  let prevCompressionRatio = null;

  while (turns < maxTurns) {
    turns++;
    try {
      const snapshot = await observe(page);
      let snapshotDelta = null;
      if (prevSnapshotLen !== null && history.length > 0) {
        const last = history[history.length - 1];
        if (last.action?.action !== 'wait') {
          snapshotDelta = snapshot.length - prevSnapshotLen;
          last.snapshotDelta = snapshotDelta;
        }
      }
      prevSnapshotLen = snapshot.length;
      finalSnapshot = snapshot;
      const sections = sliceSections(snapshot);
      const statEntry = {
        turn: turns,
        bytes: snapshot.length,
        sha1: createHash('sha1').update(snapshot).digest('hex'),
        sections: sections.map(s => ({ role: s.role, ref: s.ref, bytes: s.text.length, sha1: s.sha1 })),
      };
      snapshotStats.push(statEntry);
      const url = page.url();

      const shouldReset = !baseline
        || url !== baseline.url
        || (prevCompressionRatio != null && prevCompressionRatio > 0.6)
        || turns - baseline.turn >= 6
        || (lastError && snapshotDelta != null && snapshotDelta > 500);

      let messageSnapshot;
      let isBaselineTurn;
      if (shouldReset) {
        baseline = { turn: turns, url, yaml: snapshot };
        scrubState.baselineTurn = turns;
        messageSnapshot = snapshot;
        isBaselineTurn = true;
        prevCompressionRatio = null;
      } else {
        const { text, stats } = compressAgainstBaseline(snapshot, baseline.yaml, baseline.turn);
        messageSnapshot = text;
        isBaselineTurn = false;
        prevCompressionRatio = stats.origBytes > 0 ? stats.compressedBytes / stats.origBytes : 1;
        statEntry.compression = stats;
      }

      const { action, usage } = await askNextAction({ agent, goal, url, messageSnapshot, isBaselineTurn, baselineTurn: baseline.turn, lastError, snapshotDelta });
      if (usage) {
        tokens.input += usage.input ?? 0;
        tokens.output += usage.output ?? 0;
        tokens.cacheRead += usage.cacheRead ?? 0;
        tokens.cacheWrite += usage.cacheWrite ?? 0;
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
          const refMissEntry = { turn: turns, atMs: Date.now() - t0, action, url, error: lastError };
          history.push(refMissEntry);
          onTurn?.(refMissEntry);
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
        onTurn?.(entry);
        lastError = null;
      } catch (err) {
        lastError = err.message.split('\n')[0];
        entry.ms = Date.now() - tAction;
        entry.url = page.url();
        entry.error = lastError;
        history.push(entry);
        onTurn?.(entry);
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
      history, warnings, snapshotStats,
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
    history, warnings, snapshotStats,
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

async function askNextAction({ agent, goal, url, messageSnapshot, isBaselineTurn, baselineTurn, lastError, snapshotDelta }) {
  const isFirstTurn = agent.state.messages.length === 0;
  const message = isFirstTurn
    ? buildInitialPrompt({ goal, url, snapshot: messageSnapshot, baselineTurn })
    : buildFollowUpPrompt({ url, snapshot: messageSnapshot, lastError, snapshotDelta, isBaselineTurn, baselineTurn });
  await agent.prompt(message);
  const last = [...agent.state.messages].reverse().find(m => m.role === 'assistant');
  const text = last?.content.filter(c => c.type === 'text').map(c => c.text).join('') ?? '';
  const usage = last?.usage ?? null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`no JSON in LLM response: ${text}`);
  return { action: JSON.parse(match[0]), usage };
}

function buildInitialPrompt({ goal, url, snapshot, baselineTurn }) {
  return (
    `Baseline anchor (turn ${baselineTurn}).\n\n` +
    `Goal: ${goal}\n\n` +
    `Current URL: ${url}\n\n` +
    `${SNAPSHOT_BEGIN}\n${snapshot}\n${SNAPSHOT_END}\n\n` +
    `Next action (JSON only):`
  );
}

function buildFollowUpPrompt({ url, snapshot, lastError, snapshotDelta, isBaselineTurn, baselineTurn }) {
  const lines = [];
  if (isBaselineTurn) lines.push(`Baseline anchor (turn ${baselineTurn}).`, '');
  if (lastError) lines.push(`Previous action failed: ${lastError}`);
  lines.push(`Current URL: ${url}`);
  if (typeof snapshotDelta === 'number') {
    if (snapshotDelta > 200) lines.push(`Page grew +${snapshotDelta} chars (new content appeared).`);
    else if (snapshotDelta < -200) lines.push(`Page shrunk ${snapshotDelta} chars (content removed).`);
    else lines.push('Page unchanged.');
  }
  lines.push('');
  lines.push(`${SNAPSHOT_BEGIN}\n${snapshot}\n${SNAPSHOT_END}`);
  lines.push('');
  lines.push('Next action (JSON only):');
  return lines.join('\n');
}

function scrubOldSnapshots(messages, keepBaselineTurn) {
  const lastUserIdx = findLastUserIndex(messages);
  if (lastUserIdx < 0) return messages;
  const snapRe = new RegExp(`${SNAPSHOT_BEGIN}[\\s\\S]*?${SNAPSHOT_END}`, 'g');
  const anchorPrefix = keepBaselineTurn ? `Baseline anchor (turn ${keepBaselineTurn}).` : null;
  return messages.map((m, i) => {
    if (m.role !== 'user' || i === lastUserIdx) return m;
    if (anchorPrefix && m.content.some(c => c.type === 'text' && c.text.startsWith(anchorPrefix))) return m;
    const newContent = m.content.map(c => {
      if (c.type !== 'text' || !c.text.includes(SNAPSHOT_BEGIN)) return c;
      return { ...c, text: c.text.replace(snapRe, SCRUBBED_SNAPSHOT) };
    });
    return { ...m, content: newContent };
  });
}

function findLastUserIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return i;
  }
  return -1;
}
