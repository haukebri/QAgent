import { randomUUID } from 'node:crypto';
import { Agent } from '@earendil-works/pi-agent-core';
import { streamWithRequestAuth } from './llm-auth.js';
import { observe, visibleText, inspectTarget, click, fill, selectOption, pressKey, type, goBack } from './tools.js';
import { verify } from './verifier.js';
import { extractJsonObject } from './json.js';
import { observeWithSettle, observeForVerdict, compactObservation, formatPreviousActionResult } from './observe-settle.js';

const SNAPSHOT_BEGIN = '<<SNAPSHOT_BEGIN>>';
const SNAPSHOT_END = '<<SNAPSHOT_END>>';
const SCRUBBED_SNAPSHOT = '[snapshot omitted; see latest snapshot below]';
const REF_ACTIONS = new Set(['click', 'fill', 'selectOption', 'type', 'pressKey']);

const STUCK_WINDOW = 5;
const STUCK_THRESHOLD = 3;
const MAX_DRIVER_WAIT_MS = 10_000;

const SYSTEM_PROMPT =
  'You plan one browser action at a time toward a goal. Respond with a single JSON object and nothing else (no markdown fences, no commentary).\n\n' +
  'Schema:\n' +
  '  { "action": "click" | "fill" | "selectOption" | "pressKey" | "type" | "goBack" | "wait" | "done" | "fail",\n' +
  '    "ref"?: string, "value"?: string | string[], "key"?: string, "ms"?: number, "summary"?: string, "reason"?: string }\n\n' +
  'Examples:\n' +
  '  {"action": "click", "ref": "e6"}\n' +
  '  {"action": "fill", "ref": "e40", "value": "playwright"}\n' +
  '  {"action": "selectOption", "ref": "e20", "value": "Frau"}\n' +
  '  {"action": "selectOption", "ref": "e20", "value": ["Red", "Blue"]}\n' +
  '  {"action": "pressKey", "key": "Enter"}\n' +
  '  {"action": "pressKey", "ref": "e15", "key": "ArrowDown"}\n' +
  '  {"action": "type", "ref": "e15", "value": "Springfi"}\n' +
  '  {"action": "goBack"}\n' +
  '  {"action": "wait", "ms": 1500}\n' +
  '  {"action": "done", "summary": "There are 42 projects."}\n' +
  '  {"action": "fail", "reason": "The admin page shows counts only; no user list is rendered."}\n\n' +
  'Use "wait" when the page is in a transitional state (loading spinners, "Signing in..." buttons, disabled submit buttons). ' +
  "NEVER call done if the URL still matches a login page, or if loading indicators/disabled submit buttons are visible. " +
  'Wait first, then re-check.\n\n' +
  'Pick "done" when the goal is clearly complete — include a "summary" that answers any question the goal asked for. ' +
  'Before choosing done, re-read the most recent observation. If it contains error, validation, or failure messages related to your goal, the task is NOT done — resolve them (fix fields, resubmit, dismiss and retry) instead. Your done summary must not contradict the observation. ' +
  'If the current page does not match the goal, re-read the snapshot and recover only with actions allowed by the goal. Explicit goal constraints govern recovery. ' +
  'Exact named products, values, URLs, routes, prohibitions, and mandatory steps are binding unless the goal explicitly permits alternatives: never substitute a similar alternative; after allowed recovery, fail with concrete evidence if exact compliance is impossible. ' +
  'Pick "fail" only when the goal is impossible and you have attempted recovery, or when no recovery action exists; include what you tried in the "reason". ' +
  "Don't fabricate: if you cannot literally verify what the goal asks for, use \"fail\".\n\n" +
  'Element heuristics: prefer refs labelled `link` (which show a `- /url: …` line) or ' +
  '`button`, `textbox`, `menuitem`. A `generic [cursor=pointer]` span is often a ' +
  'dropdown / mega-menu trigger that expands inline rather than navigating — if you ' +
  'click one and the next "Previous action" block reports `Page changed` with new entries ' +
  'in `Added:` and no URL change, those are the new menu items; look for them in the ' +
  'snapshot below instead of re-clicking the same ref.\n\n' +
  'Form submits or other actions might take extra time to complete. Use the `wait` tool to wait for the action to complete before re-checking.\n\n' +
  'goBack — return after a genuine in-run navigation, only when the goal permits browser-back recovery.\n\n' +
  'Form-tool heuristics: ' +
  'Use `selectOption` for `combobox` refs whose YAML lists `option` children — these are native `<select>` dropdowns. ' +
  'Pass the visible option label as `value` (e.g. "Frau"); for `<select multiple>` pass an array of labels. ' +
  'For ARIA comboboxes (no `option` children visible until expanded), use `click` to open, then `pressKey` ArrowDown / Enter, or `type` then `pressKey` Enter.\n' +
  'Use `pressKey` for Enter (submit a form ONLY when no visible submit button is present), Escape (dismiss modals/cookie banners), Tab (advance focus), ArrowDown / ArrowUp / Enter (navigate ARIA combobox suggestions). ' +
  'Omit `ref` for a global key press (e.g. Escape to close whatever modal is open). Modifier combos like Control+A are NOT supported.\n' +
  'Use `type` only when `fill` silently failed (the input still appears empty in the next snapshot after a fill turn). It types character-by-character via real keyboard events for inputs that ignore programmatic value injection. ' +
  'It does NOT clear the existing value, so do not use it to replace text that is already there.\n\n' +
  `Snapshots in earlier user messages are replaced with "${SCRUBBED_SNAPSHOT}" — only the latest snapshot is current and complete. ` +
  'Always pick refs from the latest snapshot.';

export async function runTodo(
  page,
  goal,
  model,
  resolveRequestAuth,
  maxTurns = 20,
  verifierModel = null,
  onTurn = null,
  testTimeoutMs = 300_000,
  actionTimeoutMs = 2_000,
  evidenceRecorder = null,
) {
  const t0 = Date.now();
  const emitTurn = entry => onTurn?.(toPublicStep(entry));

  const agent = new Agent({
    initialState: { systemPrompt: SYSTEM_PROMPT, model },
    sessionId: randomUUID(),
    transformContext: async (messages) => scrubOldSnapshots(messages),
    streamFn: streamWithRequestAuth(resolveRequestAuth),
  });

  const history = [];
  const warnings = [];
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
  let turns = 0;
  let lastError = null;
  let verdict = null;
  let fatalError = null;
  let wallClockExpired = false;
  let terminalEntry = null;
  let finalSnapshot = '';
  let finalUrl = '';
  let finalVisibleText = '';
  let observed = false;
  const recordPageState = (snapshot, url, text) => {
    finalSnapshot = snapshot;
    finalUrl = url;
    finalVisibleText = text;
  };
  const recentRefActions = [];
  const warnedSignatures = new Set();
  let pendingRefAction = null;
  const initialHistoryIndex = await browserHistoryIndex(page);
  let reversibleNavigations = 0;

  let prev = null;             // { snapshot, url, actionEntry } after a performed action; null on turn 1
  while (turns < maxTurns) {
    if (Date.now() - t0 > testTimeoutMs) {
      wallClockExpired = true;
      break;
    }
    turns++;
    try {
      let snapshot, url, observation;
      if (prev && prev.actionEntry.observation == null) {
        const settle = await observeWithSettle(page, {
          previousSnapshot: prev.snapshot,
          previousUrl: prev.url,
          previousVisibleText: prev.visibleText,
        });
        snapshot = settle.snapshot;
        url = settle.url;
        observation = settle;
        recordPageState(snapshot, url, settle.visibleText);
        prev.actionEntry.observation = compactObservation(observation);
      } else if (!observed) {
        const settle = await observeWithSettle(page, null);
        snapshot = settle.snapshot;
        url = settle.url;
        recordPageState(snapshot, url, settle.visibleText);
        observation = null;
      } else {
        // Retry turn after parse-error or ref-miss (no performed action since
        // the last settled observation).
        snapshot = await observe(page);
        url = page.url();
        recordPageState(snapshot, url, await visibleText(page));
        observation = null;
      }
      observed = true;
      const currentHistoryIndex = await browserHistoryIndex(page);
      if (initialHistoryIndex != null && currentHistoryIndex != null) {
        reversibleNavigations = Math.max(0, currentHistoryIndex - initialHistoryIndex);
      }

      if (pendingRefAction && observation) {
        const noProgress = !observation.urlChanged && !observation.snapshotChanged;
        recentRefActions.push({ sig: pendingRefAction.sig, noProgress });
        if (recentRefActions.length > STUCK_WINDOW) recentRefActions.shift();

        const sig = pendingRefAction.sig;
        if (!warnedSignatures.has(sig)) {
          let matchCount = 0;
          for (const r of recentRefActions) {
            if (r.sig === sig && r.noProgress) matchCount++;
          }
          if (matchCount >= STUCK_THRESHOLD) {
            warnedSignatures.add(sig);
            lastError =
              `Stuck: you repeated ${pendingRefAction.actionName} ${pendingRefAction.ref} ` +
              `${STUCK_THRESHOLD} times with no URL or page-state change. ` +
              `Do not ${pendingRefAction.actionName} that ref again. ` +
              `Choose a different control, wait for a specific state, or fail with evidence.`;
          }
        }

        pendingRefAction = null;
      }

      const recentActions = recentActionsBlock(history, 3);
      const previousActionResult = observation && history.length > 0
        ? formatPreviousActionResult(history[history.length - 1], observation, snapshot, url)
        : null;
      const { action, usage, parseError, llmError } = await askNextAction({ agent, goal, url, snapshot, lastError, previousActionResult, recentActions });
      if (usage) {
        tokens.input += usage.input ?? 0;
        tokens.output += usage.output ?? 0;
        tokens.cacheRead += usage.cacheRead ?? 0;
        tokens.cacheWrite += usage.cacheWrite ?? 0;
        tokens.totalTokens += usage.totalTokens ?? 0;
        tokens.cost += usage.cost?.total ?? 0;
      }

      if (llmError) {
        fatalError = `driver LLM unavailable: ${oneLine(llmError)}`;
        const llmEntry = { turn: turns, atMs: Date.now() - t0, error: fatalError, url };
        if (usage) llmEntry.tokens = stepTokens(usage);
        history.push(llmEntry);
        await emitTurn(llmEntry);
        break;
      }

      if (parseError) {
        lastError = `your previous response was not valid JSON: ${parseError}. Respond with a single JSON object only — no markdown fences, no commentary, no examples.`;
        const parseEntry = { turn: turns, atMs: Date.now() - t0, error: lastError, url };
        if (usage) parseEntry.tokens = stepTokens(usage);
        history.push(parseEntry);
        await emitTurn(parseEntry);
        continue;
      }

      if (action.action === 'done') {
        verdict = { action: 'done', summary: action.summary ?? null, reason: null };
        const doneEntry = { turn: turns, atMs: Date.now() - t0, action, url };
        if (usage) doneEntry.tokens = stepTokens(usage);
        history.push(doneEntry);
        terminalEntry = doneEntry;
        break;
      }

      if (action.action === 'fail') {
        verdict = {
          action: 'fail',
          summary: null,
          reason: action.reason ?? null,
        };
        const verdictEntry = { turn: turns, atMs: Date.now() - t0, action, url };
        if (usage) verdictEntry.tokens = stepTokens(usage);
        history.push(verdictEntry);
        terminalEntry = verdictEntry;
        break;
      }

      let targetInfo = null;
      if (REF_ACTIONS.has(action.action) && action.ref) {
        if (!snapshot.includes(`[ref=${action.ref}]`)) {
          lastError = `ref ${action.ref} is not present in the current snapshot; pick a ref from the latest snapshot above`;
          const refMissEntry = {
            turn: turns,
            atMs: Date.now() - t0,
            action,
            success: false,
            target: 'element no longer present in the current page',
            url,
            error: lastError,
          };
          history.push(refMissEntry);
          await emitTurn(refMissEntry);
          continue;
        }

        targetInfo = await inspectTarget(page, action.ref, snapshot);

        const prospectiveSig = `${action.action}|${action.ref}|${url}`;
        if (warnedSignatures.has(prospectiveSig)) {
          verdict = {
            action: 'fail',
            summary: null,
            reason: `repeated blocked action after stuck warning: ${prospectiveSig}`,
          };
          const stuckEntry = {
            turn: turns,
            atMs: Date.now() - t0,
            action,
            success: false,
            ...targetInfo,
            url,
            error: `stuck termination: ${prospectiveSig}`,
          };
          if (usage) stuckEntry.tokens = stepTokens(usage);
          history.push(stuckEntry);
          await emitTurn(stuckEntry);
          break;
        }
      }

      const entry = {
        turn: turns, atMs: Date.now() - t0, action, ...targetInfo,
      };
      if (usage) entry.tokens = stepTokens(usage);
      await addStepScreenshot(entry, evidenceRecorder, page);
      const tAction = Date.now();
      try {
        if (action.action === 'goBack') {
          const reason = backRecoveryError(goal, reversibleNavigations);
          if (reason) throw new Error(reason);
        }
        let recoveredVia = null;
        if (action.action === 'click') recoveredVia = await click(page, action.ref, actionTimeoutMs);
        else if (action.action === 'fill') recoveredVia = await fill(page, action.ref, action.value, actionTimeoutMs);
        else if (action.action === 'selectOption') recoveredVia = await selectOption(page, action.ref, action.value, actionTimeoutMs);
        else if (action.action === 'pressKey') recoveredVia = await pressKey(page, action.ref, action.key, actionTimeoutMs);
        else if (action.action === 'type') recoveredVia = await type(page, action.ref, action.value, actionTimeoutMs);
        else if (action.action === 'goBack') recoveredVia = await goBack(page);
        else if (action.action === 'wait') await page.waitForTimeout(driverWaitMs(action.ms));
        else throw new Error(`unknown action: ${action.action}`);
        entry.ms = Date.now() - tAction;
        entry.url = page.url();
        entry.success = true;
        if (recoveredVia) entry.recoveredVia = recoveredVia;
        history.push(entry);
        await emitTurn(entry);
        lastError = null;
      } catch (err) {
        const msg = err.message.split('\n')[0];
        entry.ms = Date.now() - tAction;
        entry.url = page.url();
        entry.error = msg;
        entry.success = false;
        history.push(entry);
        await emitTurn(entry);
        lastError = msg;
      }
      if (REF_ACTIONS.has(action.action) && action.ref) {
        pendingRefAction = {
          sig: `${action.action}|${action.ref}|${url}`,
          urlBefore: url,
          urlAfter: entry.url,
          actionName: action.action,
          ref: action.ref,
          entry,
        };
      }
      prev = { snapshot, url, visibleText: finalVisibleText, actionEntry: entry };
    } catch (err) {
      fatalError = err.message.split('\n')[0];
      break;
    }
  }

  // Every exit shares one bounded settle-and-freeze boundary. The verifier and
  // persisted failure evidence only receive values captured before it runs.
  try {
    const frozen = await observeForVerdict(page, observed
      ? { previousSnapshot: finalSnapshot, previousUrl: finalUrl, previousVisibleText: finalVisibleText }
      : null);
    finalSnapshot = frozen.snapshot;
    finalUrl = frozen.url;
    finalVisibleText = frozen.visibleText;
    recordPageState(finalSnapshot, finalUrl, finalVisibleText);
    const lastEntry = history.at(-1);
    if (lastEntry?.action?.action === 'done' || lastEntry?.action?.action === 'fail') {
      lastEntry.url = finalUrl;
      lastEntry.observation = { ...compactObservation(frozen), terminal: true };
    } else if (prev && prev.actionEntry.observation == null) {
      prev.actionEntry.observation = compactObservation(frozen);
    }
  } catch {
    // Best-effort; keep the latest complete sample if the page disappeared.
    try { finalUrl = page.url(); } catch {}
  }

  const frozenScreenshot = await captureScreenshot(page);
  const finalScreenshot = await evidenceRecorder?.captureFinal(page);
  const elapsedMs = Date.now() - t0;
  if (terminalEntry) {
    try {
      await emitTurn(terminalEntry);
    } catch (err) {
      fatalError = oneLine(err?.message);
    }
  }

  if (fatalError !== null) {
    return {
      outcome: 'error',
      failureKind: 'execution',
      goal,
      evidence: fatalError,
      llmVerdict: sanitizeAction(verdict),
      turns, elapsedMs,
      tokens, verifierTokens: null,
      finalUrl, finalSnapshot, failureScreenshot: frozenScreenshot,
      ...(finalScreenshot ? { finalScreenshot } : {}),
      history: history.map(toPublicStep), warnings,
    };
  }

  if (wallClockExpired) {
    const seconds = Math.round(testTimeoutMs / 1000);
    warnings.push(`wall-clock test-timeout (${seconds}s) reached at turn ${turns}`);
  }

  const verifierVerdict = verdict ?? (
    wallClockExpired
      ? {
          action: 'fail',
          summary: null,
          reason: `wall-clock timeout: ${Math.round(elapsedMs / 1000)}s elapsed across ${turns} turns without a terminal verdict`,
        }
      : { action: 'stuck', summary: null, reason: null }
  );
  const judgeModel = verifierModel ?? model;

  let outcome;
  let evidence;
  let verifierTokens = null;
  let failureKind = null;
  try {
    const result = await verify(goal, verifierVerdict, history, finalUrl, finalSnapshot, judgeModel, resolveRequestAuth);
    outcome = result.outcome;
    evidence = result.evidence;
    failureKind = result.failureKind ?? null;
    warnings.push(...(result.warnings ?? []));
    verifierTokens = result.tokens;
  } catch (err) {
    const message = err.message.split('\n')[0];
    warnings.push(...(err.warnings ?? []));
    warnings.push(`verifier unavailable: ${message}`);
    outcome = 'error';
    failureKind = err.failureKind ?? 'verifier';
    verifierTokens = err.tokens ?? null;
    evidence = `verifier unavailable: ${message}`;
  }

  const failureScreenshot = outcome !== 'pass' ? frozenScreenshot : null;

  return {
    outcome,
    failureKind,
    goal,
    evidence,
    llmVerdict: sanitizeAction(verdict),
    turns, elapsedMs,
    tokens, verifierTokens,
    finalUrl, finalSnapshot, failureScreenshot,
    ...(finalScreenshot ? { finalScreenshot } : {}),
    history: history.map(toPublicStep), warnings,
  };
}

export function backRecoveryError(goal, reversibleNavigations) {
  if (/\b(?:do not|don't|never|must not|without)\b.{0,40}\b(?:browser\s+back|go\s*back|back\s+button)\b/iu.test(goal)) {
    return 'goBack rejected: the goal explicitly forbids browser-back recovery; re-read the current state or fail with evidence';
  }
  if (reversibleNavigations < 1) {
    return 'goBack rejected: no reversible in-run navigation was observed; re-read the current state or fail with evidence';
  }
  return null;
}

async function browserHistoryIndex(page) {
  try {
    return await page.evaluate(() => globalThis.navigation?.currentEntry?.index ?? null);
  } catch {
    return null;
  }
}

export function driverWaitMs(value) {
  const ms = value ?? 1000;
  if (!Number.isFinite(ms) || ms < 0 || ms > MAX_DRIVER_WAIT_MS) {
    throw new Error(`wait rejected: ms must be between 0 and ${MAX_DRIVER_WAIT_MS}`);
  }
  return ms;
}

function stepTokens(usage) {
  return {
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    cacheRead: usage.cacheRead ?? 0,
    cacheWrite: usage.cacheWrite ?? 0,
    totalTokens: usage.totalTokens ?? 0,
    cost: Math.round((usage.cost?.total ?? 0) * 1000) / 1000,
  };
}

async function captureScreenshot(page) {
  return page.screenshot({ fullPage: true, timeout: 5000 }).catch(() => null);
}

async function addStepScreenshot(entry, evidence, page) {
  const screenshot = await evidence?.captureStep(page, entry.turn);
  if (screenshot) entry.screenshot = screenshot;
}

export function toPublicStep(entry) {
  if (!entry) return entry;
  const out = { ...entry, action: sanitizeAction(entry.action) };
  if (out.error) out.error = sanitizeRefs(out.error);
  if (out.observation) out.observation = publicObservation(out.observation);
  return out;
}

function publicObservation(observation) {
  const { addedRefs = [], removedRefs = [], ...out } = observation;
  if (addedRefs.length) out.addedElementsCount = addedRefs.length;
  if (removedRefs.length) out.removedElementsCount = removedRefs.length;
  return out;
}

function sanitizeAction(action) {
  if (!action) return action;
  const { ref, ...out } = action;
  if (out.reason) out.reason = sanitizeRefs(out.reason);
  if (out.summary) out.summary = sanitizeRefs(out.summary);
  return out;
}

function sanitizeRefs(value) {
  return String(value).replace(/\b(?:ref\s+)?(?:f\d+)?e\d+\b/giu, 'selected element');
}

function oneLine(value) {
  return String(value ?? 'unknown error').split('\n')[0];
}

async function askNextAction({ agent, goal, url, snapshot, lastError, previousActionResult, recentActions }) {
  const isFirstTurn = agent.state.messages.length === 0;
  const message = isFirstTurn
    ? buildInitialPrompt({ goal, url, snapshot })
    : buildFollowUpPrompt({ url, snapshot, lastError, previousActionResult, recentActions });
  await agent.prompt(message);
  const last = [...agent.state.messages].reverse().find(m => m.role === 'assistant');
  const usage = last?.usage ?? null;
  if (!last) {
    return { action: null, usage, llmError: 'no assistant message returned by LLM' };
  }
  const errorMessage = last?.errorMessage ?? agent.state.errorMessage;
  if (last?.stopReason === 'error' || errorMessage) {
    return { action: null, usage, llmError: errorMessage ?? 'provider returned an error stop reason' };
  }
  const content = Array.isArray(last?.content) ? last.content : [];
  const text = content.filter(c => c.type === 'text').map(c => c.text).join('');
  const jsonStr = extractJsonObject(text);
  if (!jsonStr) {
    return { action: null, usage, parseError: `no JSON object in LLM response (got: ${text.slice(0, 200)})` };
  }
  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    return { action: null, usage, parseError: `${err.message}; raw: ${jsonStr.slice(0, 200)}` };
  }
  const normalized = normalizeActionShape(parsed);
  if (normalized.error) {
    return { action: null, usage, parseError: normalized.error };
  }
  return { action: normalized.action, usage };
}

const SHORTHAND_KEYS = ['click', 'fill', 'selectOption', 'type', 'pressKey', 'wait'];

function normalizeActionShape(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'response must be a JSON object like {"action":"click","ref":"e184"}' };
  }
  if (typeof parsed.action === 'string') return { action: parsed };

  const found = SHORTHAND_KEYS.filter(k => k in parsed);
  if (found.length === 0) {
    return { error: 'missing "action". Use {"action":"click","ref":"e184"}, not {"click":"e184"}.' };
  }
  if (found.length > 1) {
    return { error: `ambiguous shorthand: keys [${found.join(', ')}] are all set. Send a single canonical action like {"action":"click","ref":"e184"}.` };
  }

  const verb = found[0];
  const value = parsed[verb];
  const rest = { ...parsed };
  delete rest[verb];

  if (verb === 'click' || verb === 'fill' || verb === 'selectOption' || verb === 'type') {
    if (typeof value !== 'string') {
      return { error: `${verb} shorthand needs a ref string. Use {"action":"${verb}","ref":"e184"${verb === 'click' ? '' : ',"value":"..."'}}.` };
    }
    return { action: { action: verb, ref: value, ...rest } };
  }
  if (verb === 'pressKey') {
    if (typeof value !== 'string') {
      return { error: 'pressKey shorthand needs a string. Use {"action":"pressKey","key":"Enter"} for a global press, or {"action":"pressKey","ref":"e15","key":"Enter"} to target an element.' };
    }
    if (typeof rest.key === 'string') return { action: { action: 'pressKey', ref: value, ...rest } };
    return { action: { action: 'pressKey', key: value, ...rest } };
  }
  if (verb === 'wait') {
    if (typeof value !== 'number') {
      return { error: 'wait shorthand needs a number of ms. Use {"action":"wait","ms":1500}.' };
    }
    return { action: { action: 'wait', ms: value, ...rest } };
  }
  return { error: `unsupported shorthand "${verb}"` };
}

function buildInitialPrompt({ goal, url, snapshot }) {
  return (
    `Goal:\n${goal}\n\n` +
    `Current URL: ${url}\n\n` +
    `${SNAPSHOT_BEGIN}\n${snapshot}\n${SNAPSHOT_END}\n\n` +
    `Next action (JSON only):`
  );
}

function buildFollowUpPrompt({ url, snapshot, lastError, previousActionResult, recentActions }) {
  const lines = [];
  if (previousActionResult) {
    lines.push(previousActionResult);
    lines.push('');
  }
  if (lastError) lines.push(`Previous action failed: ${lastError}`);
  lines.push(`Current URL: ${url}`);
  lines.push('');
  lines.push(`${SNAPSHOT_BEGIN}\n${snapshot}\n${SNAPSHOT_END}`);
  if (recentActions) {
    lines.push('');
    lines.push('Recent actions:');
    lines.push(recentActions);
  }
  lines.push('');
  lines.push('Next action (JSON only):');
  return lines.join('\n');
}

function formatRecentAction(e) {
  const t = `T${e.turn}`;
  if (!e.action) return e.error ? `${t} (no action) ERROR: ${e.error}` : `${t} (no action)`;
  let line = `${t} ${JSON.stringify(e.action)}`;
  if (e.url) line += ` → ${e.url}`;
  if (e.error) line += ` ERROR: ${e.error}`;
  return line;
}

function recentActionsBlock(history, n) {
  const recent = history.slice(-n);
  if (recent.length === 0) return null;
  return recent.map(formatRecentAction).join('\n');
}

export function scrubOldSnapshots(messages) {
  const lastUserIdx = findLastUserIndex(messages);
  if (lastUserIdx < 0) return messages;
  const snapRe = new RegExp(`${SNAPSHOT_BEGIN}[\\s\\S]*?${SNAPSHOT_END}`, 'g');
  return messages.map((m, i) => {
    if (m.role !== 'user' || i === lastUserIdx) return m;
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
