import { randomUUID } from 'node:crypto';
import { Agent } from '@earendil-works/pi-agent-core';
import { streamWithRequestAuth } from './llm-auth.js';
import { observe, inspectTarget, click, fill, selectOption, pressKey, type, goBack } from './tools.js';
import { verify } from './verifier.js';
import { compressAgainstBaseline } from './snapshot-compress.js';
import { observeWithSettle, observeForVerdict, diffSnapshots, compactObservation, formatPreviousActionResult } from './observe-settle.js';

const SNAPSHOT_BEGIN = '<<SNAPSHOT_BEGIN>>';
const SNAPSHOT_END = '<<SNAPSHOT_END>>';
const SCRUBBED_SNAPSHOT = '[snapshot omitted; see latest snapshot below]';
const REF_ACTIONS = new Set(['click', 'fill', 'selectOption', 'type', 'pressKey']);

const STUCK_WINDOW = 5;
const STUCK_THRESHOLD = 3;

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
  'If the current page does not match the goal, first try to recover: use "goBack" after a wrong click, or re-read the snapshot for the element you actually need. ' +
  'Pick "fail" only when the goal is impossible and you have attempted recovery, or when no recovery action exists; include what you tried in the "reason". ' +
  "Don't fabricate: if you cannot literally verify what the goal asks for, use \"fail\".\n\n" +
  'Element heuristics: prefer refs labelled `link` (which show a `- /url: …` line) or ' +
  '`button`, `textbox`, `menuitem`. A `generic [cursor=pointer]` span is often a ' +
  'dropdown / mega-menu trigger that expands inline rather than navigating — if you ' +
  'click one and the next "Previous action" block reports `Page changed` with new entries ' +
  'in `Added:` and no URL change, those are the new menu items; look for them in the ' +
  'snapshot below instead of re-clicking the same ref.\n\n' +
  'Form submits or other actions might take extra time to complete. Use the `wait` tool to wait for the action to complete before re-checking.\n\n' +
  'goBack — return to the previous page, e.g. after clicking a wrong link.\n\n' +
  'Form-tool heuristics: ' +
  'Use `selectOption` for `combobox` refs whose YAML lists `option` children — these are native `<select>` dropdowns. ' +
  'Pass the visible option label as `value` (e.g. "Frau"); for `<select multiple>` pass an array of labels. ' +
  'For ARIA comboboxes (no `option` children visible until expanded), use `click` to open, then `pressKey` ArrowDown / Enter, or `type` then `pressKey` Enter.\n' +
  'Use `pressKey` for Enter (submit a form ONLY when no visible submit button is present), Escape (dismiss modals/cookie banners), Tab (advance focus), ArrowDown / ArrowUp / Enter (navigate ARIA combobox suggestions). ' +
  'Omit `ref` for a global key press (e.g. Escape to close whatever modal is open). Modifier combos like Control+A are NOT supported.\n' +
  'Use `type` only when `fill` silently failed (the input still appears empty in the next snapshot after a fill turn). It types character-by-character via real keyboard events for inputs that ignore programmatic value injection. ' +
  'It does NOT clear the existing value, so do not use it to replace text that is already there.\n\n' +
  `Snapshots in earlier user messages are replaced with "${SCRUBBED_SNAPSHOT}" — only the latest snapshot is current. ` +
  'Always pick refs from the latest snapshot.\n\n' +
  'A user message beginning "Baseline anchor (turn N)." is a pinned reference snapshot kept in full. ' +
  'In the latest snapshot, a section body may read "# unchanged since turn N" — that section is byte-identical to the baseline anchor\'s, ' +
  'so its refs are the SAME numbers as in the anchor. Look up element details there.';

const DONE_CHECK_PROMPT =
  'You are a QA verifier. Decide whether a browser driver\'s done summary is contradicted by the final observation.\n\n' +
  'Respond with a single JSON object and nothing else (no markdown fences, no commentary):\n' +
  '  { "contradicted": true | false, "reason": "<one sentence citing concrete observation text when contradicted>" }\n\n' +
  'Rules:\n' +
  '- Base the decision only on the supplied goal, driver summary, final URL, and observation JSON.\n' +
  '- The observation JSON may include `mostRecentBeforeDone` and `terminalAfterDone`; inspect the addedText/removedText fields in both.\n' +
  "- Ask explicitly: does the final observation contradict the driver's success summary (e.g. visible error or validation messages)?\n" +
  '- If the observation shows the goal still failed, still needs correction, or still displays a validation/submission failure related to the goal, return contradicted=true.\n' +
  '- If contradicted=true, the reason must quote or name the concrete observation text.\n' +
  '- If the observation is merely incomplete or ambiguous, return contradicted=false.';

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

  const scrubState = { baselineTurn: 0 };
  const agent = new Agent({
    initialState: { systemPrompt: SYSTEM_PROMPT, model },
    sessionId: randomUUID(),
    transformContext: async (messages) => scrubOldSnapshots(messages, scrubState.baselineTurn),
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
  let finalSnapshot = '';
  const recentRefActions = [];
  const warnedSignatures = new Set();
  let pendingRefAction = null;

  let prev = null;             // { snapshot, url, actionEntry } after a performed action; null on turn 1
  let baseline = null;
  let prevCompressionRatio = null;

  while (turns < maxTurns) {
    if (Date.now() - t0 > testTimeoutMs) {
      wallClockExpired = true;
      break;
    }
    turns++;
    try {
      let snapshot, url, observation;
      if (prev && prev.actionEntry.observation == null) {
        if (prev.actionEntry.action.action === 'wait') {
          snapshot = await observe(page);
          url = page.url();
          observation = {
            settled: true,
            settleMs: 0,
            ...diffSnapshots(prev.snapshot, snapshot, prev.url, url),
          };
        } else {
          const settle = await observeWithSettle(page, {
            previousSnapshot: prev.snapshot,
            previousUrl: prev.url,
          });
          snapshot = settle.snapshot;
          url = settle.url;
          observation = settle;
        }
        prev.actionEntry.observation = compactObservation(observation);
      } else {
        // Turn 1, or a retry turn after parse-error / ref-miss / done-rejected
        // (no new performed action since the last observation).
        snapshot = await observe(page);
        url = page.url();
        observation = null;
      }
      finalSnapshot = snapshot;

      const shouldReset = !baseline
        || url !== baseline.url
        || (prevCompressionRatio != null && prevCompressionRatio > 0.6)
        || turns - baseline.turn >= 6
        || (lastError && observation && observation.deltaChars > 500);

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
      const { action, usage, parseError, llmError } = await askNextAction({ agent, goal, url, messageSnapshot, isBaselineTurn, baselineTurn: baseline.turn, lastError, previousActionResult, recentActions });
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
        // Terminal assertion-style settle. Baseline is the snapshot the LLM
        // saw at the top of THIS turn — `done` is a verdict on that state, so
        // we wait for the page to depart from it before judging. When prev is
        // null (turn-1 done, or done after a parse-error/ref-miss with no
        // performed action this run), pass a null baseline so observeForVerdict
        // skips the requireChange gate and just confirms inter-sample stability
        // quickly — there's no prior action to wait on.
        let terminalObs = null;
        try {
          const settle = await observeForVerdict(page, prev
            ? { previousSnapshot: snapshot, previousUrl: url }
            : { previousSnapshot: null, previousUrl: null });
          terminalObs = settle;
          finalSnapshot = settle.snapshot;
          // Refresh the prior action's history-entry observation with the
          // post-settle view — that's what the (now observation-aware) guard
          // inspects on the very next line.
          if (prev) prev.actionEntry.observation = compactObservation(settle);
        } catch {
          // Best-effort. If settle throws, fall back to the pre-settle snapshot
          // already captured at the top of this turn; the guard runs below
          // either way.
        }

        let doneProblem = findBlockingPriorError({ history, warnings, turns });
        if (!doneProblem) {
          const doneCheck = await checkDoneContradiction({
            goal,
            summary: action.summary ?? '',
            finalUrl: page.url(),
            observation: {
              mostRecentBeforeDone: observation ? compactObservation(observation) : prev?.actionEntry?.observation ?? null,
              terminalAfterDone: terminalObs ? compactObservation(terminalObs) : null,
            },
            model,
            resolveRequestAuth,
          });
          if (doneCheck.usage) addTokenUsage(tokens, doneCheck.usage);
          doneProblem = doneCheck.problem;
        }
        if (doneProblem) {
          // Terminate the run as fail — no retry, no cap-bypass. The verifier
          // still runs at the end of runTodo against finalSnapshot.
          verdict = { action: 'fail', summary: null, reason: doneProblem };
          const rejEntry = {
            turn: turns,
            atMs: Date.now() - t0,
            action,
            url: page.url(),
            error: `done-gate rejected: ${doneProblem}`,
          };
          if (terminalObs) {
            rejEntry.observation = { ...compactObservation(terminalObs), terminal: true };
          }
          if (usage) rejEntry.tokens = stepTokens(usage);
          history.push(rejEntry);
          await emitTurn(rejEntry);
          break;
        }

        verdict = { action: 'done', summary: action.summary ?? null, reason: null };
        const doneEntry = { turn: turns, atMs: Date.now() - t0, action, url: page.url() };
        if (terminalObs) {
          doneEntry.observation = { ...compactObservation(terminalObs), terminal: true };
        }
        if (usage) doneEntry.tokens = stepTokens(usage);
        history.push(doneEntry);
        await emitTurn(doneEntry);
        break;
      }

      if (action.action === 'fail') {
        // Same terminal-settle treatment as `done` — but only when there was
        // a recent mutating action (prev != null). On a turn-1 fail or after
        // retry-only turns there's nothing to wait for; the LLM is calling
        // it impossible based on what's already on screen.
        let terminalObs = null;
        if (prev) {
          try {
            const settle = await observeForVerdict(page, {
              previousSnapshot: snapshot,
              previousUrl: url,
            });
            terminalObs = settle;
            finalSnapshot = settle.snapshot;
            prev.actionEntry.observation = compactObservation(settle);
          } catch {
            // Best-effort.
          }
        }
        verdict = {
          action: 'fail',
          summary: null,
          reason: action.reason ?? null,
        };
        const verdictEntry = { turn: turns, atMs: Date.now() - t0, action, url: page.url() };
        if (terminalObs) {
          verdictEntry.observation = { ...compactObservation(terminalObs), terminal: true };
        }
        if (usage) verdictEntry.tokens = stepTokens(usage);
        history.push(verdictEntry);
        await emitTurn(verdictEntry);
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

      const entry = { turn: turns, atMs: Date.now() - t0, action, ...targetInfo };
      if (usage) entry.tokens = stepTokens(usage);
      await addStepScreenshot(entry, evidenceRecorder, page);
      const tAction = Date.now();
      try {
        let recoveredVia = null;
        if (action.action === 'click') recoveredVia = await click(page, action.ref, actionTimeoutMs);
        else if (action.action === 'fill') recoveredVia = await fill(page, action.ref, action.value, actionTimeoutMs);
        else if (action.action === 'selectOption') recoveredVia = await selectOption(page, action.ref, action.value, actionTimeoutMs);
        else if (action.action === 'pressKey') recoveredVia = await pressKey(page, action.ref, action.key, actionTimeoutMs);
        else if (action.action === 'type') recoveredVia = await type(page, action.ref, action.value, actionTimeoutMs);
        else if (action.action === 'goBack') recoveredVia = await goBack(page);
        else if (action.action === 'wait') await page.waitForTimeout(action.ms ?? 1000);
        else throw new Error(`unknown action: ${action.action}`);
        entry.ms = Date.now() - tAction;
        entry.url = page.url();
        if (recoveredVia) entry.recoveredVia = recoveredVia;
        history.push(entry);
        await emitTurn(entry);
        lastError = null;
      } catch (err) {
        const msg = err.message.split('\n')[0];
        entry.ms = Date.now() - tAction;
        entry.url = page.url();
        entry.error = msg;
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
        };
      }
      prev = { snapshot, url, actionEntry: entry };
    } catch (err) {
      fatalError = err.message.split('\n')[0];
      break;
    }
  }

  // If the loop ended without a follow-up turn (turn cap, wall-clock timeout,
  // stuck stage-2 termination, fatal error), the last performed action's
  // observation was never captured. Run one final pass so analysts see what
  // that action did.
  if (prev && prev.actionEntry.observation == null) {
    try {
      if (prev.actionEntry.action.action === 'wait') {
        const finalSnap = await observe(page);
        const finalU = page.url();
        prev.actionEntry.observation = compactObservation({
          settled: true,
          settleMs: 0,
          ...diffSnapshots(prev.snapshot, finalSnap, prev.url, finalU),
        });
        finalSnapshot = finalSnap;
      } else {
        const settle = await observeWithSettle(page, {
          previousSnapshot: prev.snapshot,
          previousUrl: prev.url,
        });
        prev.actionEntry.observation = compactObservation(settle);
        finalSnapshot = settle.snapshot;
      }
    } catch {
      // Best-effort; do not let a final-observation failure mask a real verdict.
    }
  }

  const finalUrl = page.url();
  const elapsedMs = Date.now() - t0;
  const finalScreenshot = await evidenceRecorder?.captureFinal(page);

  if (fatalError !== null) {
    const failureScreenshot = await captureScreenshot(page);
    return {
      outcome: 'error',
      evidence: fatalError,
      llmVerdict: sanitizeAction(verdict),
      turns, elapsedMs,
      tokens, verifierTokens: null,
      finalUrl, finalSnapshot, failureScreenshot,
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
  let humanEvidence;
  let checks = [];
  let verifierMode = null;
  let verifierTokens = null;
  try {
    const result = await verify(goal, verifierVerdict, history, finalUrl, finalSnapshot, judgeModel, resolveRequestAuth);
    outcome = result.outcome;
    evidence = result.evidence;
    humanEvidence = result.humanEvidence;
    checks = result.checks ?? [];
    verifierMode = result.verifierMode ?? null;
    warnings.push(...(result.warnings ?? []));
    verifierTokens = result.tokens;
  } catch (err) {
    const message = err.message.split('\n')[0];
    verifierMode = err.verifierMode ?? verifierMode;
    warnings.push(...(err.warnings ?? []));
    warnings.push(`verifier unavailable: ${message}`);
    outcome = 'error';
    evidence = `verifier unavailable: ${message}`;
    humanEvidence = evidence;
  }

  const failureScreenshot = outcome !== 'pass' ? await captureScreenshot(page) : null;

  return {
    outcome,
    evidence,
    humanEvidence,
    llmVerdict: sanitizeAction(verdict),
    turns, elapsedMs,
    tokens, verifierTokens,
    finalUrl, finalSnapshot, failureScreenshot,
    ...(finalScreenshot ? { finalScreenshot } : {}),
    history: history.map(toPublicStep), warnings, checks, verifierMode,
  };
}

export async function checkDoneContradiction({ goal, summary, finalUrl, observation, model, resolveRequestAuth }) {
  const agent = new Agent({
    initialState: { systemPrompt: DONE_CHECK_PROMPT, model },
    streamFn: streamWithRequestAuth(resolveRequestAuth),
  });

  await agent.prompt(
    `Goal: ${goal}\n\n` +
    `Driver done summary: ${summary || '(none)'}\n\n` +
    `Final URL: ${finalUrl}\n\n` +
    `Final observation JSON:\n${JSON.stringify(observation, null, 2)}\n\n` +
    'Your JSON:',
  );

  const last = [...agent.state.messages].reverse().find(m => m.role === 'assistant');
  const usage = last?.usage ?? null;
  if (!last) throw new Error('no assistant message returned by done check LLM');
  const errorMessage = last?.errorMessage ?? agent.state.errorMessage;
  if (last?.stopReason === 'error' || errorMessage) {
    throw new Error(errorMessage ?? 'provider returned an error stop reason');
  }
  const content = Array.isArray(last?.content) ? last.content : [];
  const text = content.filter(c => c.type === 'text').map(c => c.text).join('');
  const jsonStr = extractActionJson(text);
  if (!jsonStr) throw new Error(`no JSON in done check response: ${text.slice(0, 200)}`);

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    throw new Error(`${err.message}; raw: ${jsonStr.slice(0, 200)}`);
  }
  if (typeof parsed.contradicted !== 'boolean') {
    throw new Error(`invalid done check contradicted value: ${parsed.contradicted}`);
  }
  if (!parsed.contradicted) return { problem: null, usage };

  const reason = typeof parsed.reason === 'string' && parsed.reason.trim()
    ? parsed.reason.trim()
    : 'the final observation contradicts the driver success summary';
  return { problem: `Your done summary contradicts the final observation: ${reason}`, usage };
}

export function findBlockingPriorError({ history, warnings, turns }) {
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry.action?.action === 'done') continue;
    // Pre-execution rejections (parse-error, ref-miss) carry an `error` but no
    // `ms` — they describe LLM/validation issues, not page state. Skip them
    // and look further back for the most recent performed action.
    if (entry.ms == null) continue;
    if (entry.error) {
      const obs = entry.observation;
      const meaningfulChange =
        obs && (obs.urlChanged || obs.snapshotChanged || (obs.addedText && obs.addedText.length > 0));
      if (meaningfulChange) return null;
      warnings.push(`done-gate: rejected by history guard at turn ${turns} — previous action errored: ${entry.error}`);
      return `Your previous action did not succeed: ${entry.error}. Resolve the failure or fail with a reason.`;
    }
    break;
  }
  return null;
}

function addTokenUsage(tokens, usage) {
  tokens.input += usage.input ?? 0;
  tokens.output += usage.output ?? 0;
  tokens.cacheRead += usage.cacheRead ?? 0;
  tokens.cacheWrite += usage.cacheWrite ?? 0;
  tokens.totalTokens += usage.totalTokens ?? 0;
  tokens.cost += usage.cost?.total ?? 0;
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
  return page.screenshot({ fullPage: true }).catch(() => null);
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

async function askNextAction({ agent, goal, url, messageSnapshot, isBaselineTurn, baselineTurn, lastError, previousActionResult, recentActions }) {
  const isFirstTurn = agent.state.messages.length === 0;
  const message = isFirstTurn
    ? buildInitialPrompt({ goal, url, snapshot: messageSnapshot, baselineTurn })
    : buildFollowUpPrompt({ url, snapshot: messageSnapshot, lastError, previousActionResult, isBaselineTurn, baselineTurn, recentActions });
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
  const jsonStr = extractActionJson(text);
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

// Extract the first balanced JSON object from an LLM response. Strips markdown
// fences (```json ... ```), then walks brace depth while respecting strings
// and escapes — so a `}` inside a string value won't end the match early, and
// a second JSON object after the first is ignored.
function extractActionJson(text) {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const src = fenceMatch ? fenceMatch[1] : text;
  const start = src.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
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

function buildFollowUpPrompt({ url, snapshot, lastError, previousActionResult, isBaselineTurn, baselineTurn, recentActions }) {
  const lines = [];
  if (isBaselineTurn) lines.push(`Baseline anchor (turn ${baselineTurn}).`, '');
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
