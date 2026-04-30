# Stuck Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop QAgent runs from burning the turn budget on repeated no-progress actions by detecting them in the executor and escalating: warn the driver after 3 same-signature no-progress entries in a window of 5, then terminate the todo as `fail` if the driver attempts the warned action again.

**Architecture:** All changes live in `src/executor.js` inside `runTodo`. Closure-local state holds a sliding window of the last 5 REF_ACTION records and a `Set` of warned signatures. A REF_ACTION's `noProgress` flag depends on the snapshot delta from the *next* turn's observe, so we stash a pending record at end-of-turn and finalize / detect at the top of the next turn — right before prompting the driver, so the warning lands in the same turn's `lastError`. Before executing any REF_ACTION we also check the prospective signature against `warnedSignatures` and terminate if it matches.

**Tech Stack:** Node.js ESM, Playwright. No new dependencies. Project rule: no test framework — verification is by code review and a manual end-to-end smoke run.

**Spec:** `docs/superpowers/specs/2026-04-30-stuck-detection-design.md`.

---

## File Structure

Single file modified — `src/executor.js`. No new files.

| Region in `runTodo` | Existing role | New role added |
|---|---|---|
| Top-of-file constants (after line `const REF_ACTIONS = new Set(...)`) | Action-name set | Plus stuck-detection constants |
| Top of `runTodo` (alongside `let lastError = null;` etc.) | Loop-state vars | Plus `recentRefActions`, `warnedSignatures`, `pendingRefAction` |
| Just before `askNextAction(...)` call | Builds prompt context | Finalize pending record + run stage-1 detection (may set `lastError`) |
| After ref-in-snapshot guard, before building `entry` | Validates ref | Run stage-2 pre-execute termination |
| End of action try/catch | Pushes entry to history | Stash pending record if action was a REF_ACTION |

---

## Task 1: Add constants and closure-local state

**Files:**
- Modify: `src/executor.js`

- [ ] **Step 1: Add stuck-detection constants**

In `src/executor.js`, just after the line `const REF_ACTIONS = new Set(['click', 'fill', 'selectOption', 'type', 'pressKey']);`, add:

```js
const STUCK_WINDOW = 5;
const STUCK_THRESHOLD = 3;
const STUCK_DELTA_TOLERANCE = 200;
```

- [ ] **Step 2: Add closure-local state inside `runTodo`**

In `runTodo`, locate the block of `let` declarations that currently ends with `let finalSnapshot = '';` (around the variables `turns`, `lastError`, `verdict`, `fatalError`, `wallClockExpired`, `finalSnapshot`). Just after `let finalSnapshot = '';`, add:

```js
const recentRefActions = [];
const warnedSignatures = new Set();
let pendingRefAction = null;
```

`recentRefActions` is the sliding window. `warnedSignatures` persists for the entire `runTodo` call. `pendingRefAction` holds the unfinalized record between the REF_ACTION turn that produced it and the start of the next turn.

- [ ] **Step 3: Smoke-check the file parses**

Run from the repo root:

```bash
node --check src/executor.js
```

Expected: no output (success). If you get a syntax error, fix the placement.

- [ ] **Step 4: Commit**

```bash
git add src/executor.js
git commit -m "executor: add stuck-detection constants and state slots"
```

---

## Task 2: Stash pending record after REF_ACTION execution

**Files:**
- Modify: `src/executor.js`

- [ ] **Step 1: Capture `urlBefore` for the action**

In `runTodo`, the existing line `const url = page.url();` (just after `finalSnapshot = snapshot;`) already gives us the URL at the start of the turn. We will reuse it as `urlBefore` for the pending record — no change here, just be aware that `url` *is* `urlBefore`.

- [ ] **Step 2: Stash pending record after the action try/catch**

Locate the action try/catch block in `runTodo` — the one that begins `const tAction = Date.now();` and ends with `lastError = msg;` inside the catch. Immediately after the closing `}` of that try/catch (and *before* the outer `} catch (err) { fatalError = ... }` for the whole turn), add:

```js
      if (REF_ACTIONS.has(action.action) && action.ref) {
        pendingRefAction = {
          sig: `${action.action}|${action.ref}|${url}`,
          urlBefore: url,
          urlAfter: entry.url,
          actionName: action.action,
          ref: action.ref,
        };
      }
```

Notes:
- `url` is the turn's URL captured before the action (== `urlBefore`).
- `entry.url` is set to `page.url()` in *both* branches of the try/catch, so it is always present here.
- A failed REF_ACTION still produces a pending record. The error didn't change the page (`urlAfter === urlBefore` is the typical case), so the next turn will likely see `noProgress = true` and feed the count.

- [ ] **Step 3: Smoke-check**

```bash
node --check src/executor.js
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add src/executor.js
git commit -m "executor: stash pending REF_ACTION record at end of turn"
```

---

## Task 3: Finalize pending record + stage-1 detection

**Files:**
- Modify: `src/executor.js`

- [ ] **Step 1: Insert finalize + detect block before `askNextAction`**

In `runTodo`, locate the line that begins `const recentActions = recentActionsBlock(history, 3);` (just before the `askNextAction({...})` call). *Before* that line, insert:

```js
      if (pendingRefAction && snapshotDelta != null) {
        const noProgress =
          pendingRefAction.urlBefore === pendingRefAction.urlAfter &&
          Math.abs(snapshotDelta) < STUCK_DELTA_TOLERANCE;
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
              `Choose a different control, wait for a specific state, navigate directly if valid, or fail with evidence.`;
          }
        }

        pendingRefAction = null;
      }
```

What it does:
1. If a pending record exists and we have a real `snapshotDelta` (non-null), finalize `noProgress` using the spec's two conditions.
2. Push the record onto the window and trim to `STUCK_WINDOW`.
3. If the signature is not already warned, count matching no-progress entries in the window. If ≥ threshold, set `lastError` to the stuck warning and remember the signature.
4. Always clear `pendingRefAction` so it doesn't leak into the next turn.

If `snapshotDelta` is `null` (first turn / after a `wait` turn), we leave the pending record in place; in practice the pending only exists after a REF_ACTION turn whose effect is reflected at the very next observe (where `last.action` is the click, not a wait), so delta is non-null. The guard is defensive.

- [ ] **Step 2: Smoke-check**

```bash
node --check src/executor.js
```

Expected: no output.

- [ ] **Step 3: Logic walk-through**

Trace by hand on paper or in a comment that the Landefeld scenario produces the warning at the start of turn 4:

- Turn 1: click `e184` → entry pushed, `pendingRefAction` set with sig `click|e184|<url>`.
- Top of Turn 2: `snapshotDelta` reflects turn 1's click effect. `noProgress = true` (no URL change, small delta). Window = `[A]`. matchCount = 1. No warning.
- Turn 2: click `e184` → pending set again.
- Top of Turn 3: window = `[A, A]`. matchCount = 2. No warning.
- Turn 3: click `e184` → pending set.
- Top of Turn 4: window = `[A, A, A]`. matchCount = 3. **Warning fires.** `lastError` set, sig added to `warnedSignatures`.
- Turn 4 prompt now contains the stuck warning.

(Stage 2 — what happens if the driver retries on turn 4 — comes in Task 4.)

- [ ] **Step 4: Commit**

```bash
git add src/executor.js
git commit -m "executor: detect repeated no-progress REF_ACTIONs and warn driver"
```

---

## Task 4: Stage-2 pre-execute termination

**Files:**
- Modify: `src/executor.js`

- [ ] **Step 1: Insert stage-2 check after the ref-in-snapshot guard**

In `runTodo`, locate the existing block that validates the ref is present in the snapshot. It looks like:

```js
      if (REF_ACTIONS.has(action.action) && action.ref) {
        if (!snapshot.includes(`[ref=${action.ref}]`)) {
          lastError = `ref ${action.ref} is not present in the current snapshot; pick a ref from the latest snapshot above`;
          const refMissEntry = { turn: turns, atMs: Date.now() - t0, action, url, error: lastError };
          history.push(refMissEntry);
          onTurn?.(refMissEntry);
          continue;
        }
      }
```

Immediately after the closing `}` of *that* outer `if` (i.e. after the ref-presence guard, before the `const entry = { turn: turns, atMs: Date.now() - t0, action };` line), add:

```js
      if (REF_ACTIONS.has(action.action) && action.ref) {
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
            url,
            error: `stuck termination: ${prospectiveSig}`,
          };
          history.push(stuckEntry);
          onTurn?.(stuckEntry);
          break;
        }
      }
```

What it does:
- Builds the prospective signature using the *current* turn-start `url` — the same URL stage-1 used to build the warned signature. (Between `observe()` and this point there are no awaits that touch the page, so `url` is still authoritative.)
- If that signature is in `warnedSignatures`, set the loop-level `verdict` to a `fail` with a precise reason, push a synthetic entry to history (so the trace shows what happened), fire `onTurn`, and `break` out of the while loop. The existing post-loop pipeline picks up `verdict !== null` and runs the verifier on it.

- [ ] **Step 2: Smoke-check**

```bash
node --check src/executor.js
```

Expected: no output.

- [ ] **Step 3: Mental trace continuation**

Continuing from Task 3's walk-through:

- Turn 4 prompt has the stuck warning in `lastError`.
- The driver picks `click e184` again (typical of stuck loops).
- Stage-2 check: `prospectiveSig = "click|e184|<url>"`. It's in `warnedSignatures`.
- `verdict = { action: 'fail', reason: 'repeated blocked action after stuck warning: click|e184|<url>' }`.
- `stuckEntry` pushed; loop breaks.
- Post-loop: verifier runs on the `fail` verdict, screenshot captured, recorder writes the trace.

If the driver instead picks something else on turn 4 — say, scroll to find a different control or `fail` with a clear reason — the loop continues normally. The warning persists in `warnedSignatures` so any *future* attempt at `click e184` on the same URL still terminates.

- [ ] **Step 4: Commit**

```bash
git add src/executor.js
git commit -m "executor: terminate todo when warned action is retried"
```

---

## Task 5: End-to-end smoke verification

**Files:**
- None modified.

- [ ] **Step 1: Identify a stuck-prone goal**

The clearest reproducer in the repo is Landefeld's `Accept all` overlay loop documented in the task spec (`docs/tasks/02-stuck-detection.md`) and seen in `results/2026-04-29T10-00HE7AA.json`. If the user has a `goals.json` or `qagent.config.json` that reproduces this, use it. Otherwise, ask the user for a goal that historically gets stuck on a cookie banner / overlay, or for any URL where clicking a banner button is blocked.

- [ ] **Step 2: Run the goal**

From the repo root, with API keys configured:

```bash
node src/cli.js <goal-or-config-pointer>
```

Watch the per-turn log on stdout (the recorder also writes a JSON trace under `results/`).

- [ ] **Step 3: Verify the trace**

Open the newest file under `results/` matching `*.json`. Look for:

- A `lastError` containing `Stuck: you repeated click ... 3 times with no URL or page-state change.` on or before turn ~5.
- A subsequent `error` field on a single entry that reads `stuck termination: click|<ref>|<url>`.
- The run's outcome in the trace is a verifier verdict on a `fail` (not `stuck`, not `error`).
- The total turn count is much smaller than the historical 98 — typically 4-6 for the Landefeld pattern.

If the run does *not* terminate early (it reaches the maxTurn cap), one of these is wrong:

  - The driver keeps producing different `ref` values for the cookie banner each turn (real progress in the snapshot caused refs to renumber). In that case the signature changes and detection won't trigger — this is intended behaviour, not a bug.
  - The page actually grew/shrunk by more than 200 chars after each click. Inspect `snapshotDelta` in the trace — if this is the case, raise `STUCK_DELTA_TOLERANCE` cautiously OR accept that the case isn't truly stuck.
  - A bug in the new code. Re-read the diff.

- [ ] **Step 4: Confirm normal flows still pass**

Run any existing healthy goal (one that historically succeeded). Confirm the trace shows no `Stuck:` warning in `lastError` for any turn and the outcome is unchanged from the prior behaviour.

- [ ] **Step 5: Final commit (if any cleanup was needed)**

If steps 1–4 surfaced nothing, no commit is needed here. If you adjusted thresholds or wording, commit them with a message describing the empirical reason:

```bash
git add src/executor.js
git commit -m "executor: tune stuck thresholds based on smoke run"
```

---

## Spec coverage check

| Spec section | Implemented in |
|---|---|
| Window size 5, threshold 3 | Task 1 (constants) + Task 3 (`STUCK_WINDOW`, `STUCK_THRESHOLD`) |
| Signature `action+ref+url` (no error) | Task 2 (sig built when stashing) |
| `noProgress` filter (URL unchanged AND \|delta\| < 200) | Task 3 |
| Other turn types skip the window | Tasks 2 + 3 (only REF_ACTIONs stash; pending finalized regardless of next turn type) |
| Pending finalized at top of next turn | Task 3 |
| Stage 1 sets `lastError` exactly per spec | Task 3 |
| `warnedSignatures` persists for whole todo | Task 1 (declared at top of `runTodo`) |
| Stage 2 pre-execute check on prospective sig | Task 4 |
| Stage 2 produces real `verdict='fail'` so verifier still runs | Task 4 |
| No site-specific heuristics | Plan touches only signature-string logic |
| No new files / modules | Plan touches only `src/executor.js` |

## Acceptance verification (from spec)

- [ ] Landefeld 98-click loop → ≤ 4 REF_ACTION turns with `Stuck:` + `stuck termination`. **Verified in Task 5.**
- [ ] Devstral Ändern/Speichern alternation → stops before max-turn cap. **Verified in Task 5 if a similar reproducer exists.**
- [ ] Stuck message explicitly tells the model not to do that action+ref again. **Implemented in Task 3 message string.**
- [ ] Normal multi-step flows unaffected. **Verified in Task 5 step 4.**
