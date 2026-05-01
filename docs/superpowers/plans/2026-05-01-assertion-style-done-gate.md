# Assertion-Style Terminal Verdict Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `done` run an extended assertion-style settle pass (longer poll, longer max budget) before the verifier judges, and make the history guard observation-aware so a `done` after an action that errored-but-transitioned-the-page is accepted. Drop the cap-bypass; if the gate rejects, terminate as `fail` with structured evidence.

**Architecture:** Add a thin sibling entry point `observeForVerdict()` in `src/observe-settle.js` that delegates to `observeWithSettle` with longer defaults (`pollMs: 250`, `stableSamples: 3`, `maxSettleMs: 10000`) — the loop, fingerprint, and diff stay shared. In `src/executor.js`, replace the current `done` block: always run a terminal settle, attach the compact observation to the `done` history entry as `{ ...obs, terminal: true }`, update `finalSnapshot`, then run an observation-aware `findBlockingPriorError`. On reject, terminate the run as `fail` (no `continue`, no rejection cap). The history guard ignores pre-execution rejections (entries without `entry.ms` — parse-errors and ref-misses) so dropping the cap-bypass doesn't regress those paths. Hermetic HTML fixtures + a deterministic Playwright-only verification script (no LLM) prove the new settle and guard behavior.

**Tech Stack:** Node 20+ ESM, Playwright `ariaSnapshot({ mode: 'ai' })`, `node:crypto` sha1. No test framework (project convention — `node --check` per task plus a deterministic verification script and an end-to-end smoke run).

**Spec:** `docs/tasks/06a-assertion-style-done-gate.md`. Builds on `docs/superpowers/specs/2026-05-01-settle-and-diff-observation-design.md` (the Task 06 MVP this layers on top of).

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/observe-settle.js` | MODIFY | add `observeForVerdict()` — extended-defaults wrapper around `observeWithSettle` |
| `src/executor.js` | MODIFY | rewrite the `done` block: terminal settle, observation-aware guard, terminate-on-reject; remove `doneRejections` and the cap-bypass; rewrite `findBlockingPriorError` |
| `scripts/verdict-gate-fixtures/delayed-success.html` | NEW | button reveals success heading after ~2.5s |
| `scripts/verdict-gate-fixtures/instant-stable.html` | NEW | static page that should settle quickly |
| `scripts/verdict-gate-fixtures/infinite-spinner.html` | NEW | page that mutates forever |
| `scripts/verdict-gate-fixtures/no-prior-action.html` | NEW | static page used for the `prev == null` path |
| `scripts/verify-verdict-gate.js` | NEW | deterministic harness: drives each fixture in Playwright (no LLM) and asserts the new settle + guard behavior |
| `package.json` | unchanged | — |

The fixtures live under `scripts/` (not `src/`) so they stay out of the published npm package — `package.json` `files` already excludes scripts/. Same convention as the existing `scripts/probe-openai.js`.

---

## Task 1: Add `observeForVerdict()` to `src/observe-settle.js`

**Files:**
- Modify: `src/observe-settle.js`

- [ ] **Step 1: Append the wrapper after `observeWithSettle`**

In `src/observe-settle.js`, find the closing `}` of `observeWithSettle` (the function that ends with `return { snapshot, url, settled, settleMs: Date.now() - t0, ...diff };`).

Immediately after that function, append:

```js
const VERDICT_DEFAULT_POLL_MS = 250;
const VERDICT_DEFAULT_STABLE_SAMPLES = 3;
const VERDICT_DEFAULT_MAX_SETTLE_MS = 10000;

// Extended assertion-style settle for terminal verification. Same loop and
// diff as observeWithSettle, just with a longer poll, more required stable
// samples, and a wider max-settle budget. Stable window is recomputed from
// the last sample whenever URL or normalized snapshot changes (inherited
// from observeWithSettle).
export async function observeForVerdict(page, prev, opts = {}) {
  return observeWithSettle(page, prev, {
    pollMs: opts.pollMs ?? VERDICT_DEFAULT_POLL_MS,
    stableSamples: opts.stableSamples ?? VERDICT_DEFAULT_STABLE_SAMPLES,
    maxSettleMs: opts.maxSettleMs ?? VERDICT_DEFAULT_MAX_SETTLE_MS,
  });
}
```

- [ ] **Step 2: Verify the file parses**

Run from the repo root:

```bash
node --check src/observe-settle.js
```

Expected: no output.

- [ ] **Step 3: Sanity check that the wrapper threads opts through**

```bash
node -e "
import('./src/observe-settle.js').then(m => {
  // observeForVerdict is a thin wrapper. We can't easily exercise the loop
  // without a page, but we can confirm the function exists and accepts the
  // documented argument shape.
  if (typeof m.observeForVerdict !== 'function') throw new Error('not exported');
  console.log('observeForVerdict exported:', typeof m.observeForVerdict);
});
"
```

Expected: `observeForVerdict exported: function`.

- [ ] **Step 4: Commit**

```bash
git add src/observe-settle.js
git commit -m "observe-settle: add observeForVerdict() with extended settle defaults"
```

---

## Task 2: Make `findBlockingPriorError` observation-aware and skip pre-execution rejections

This task only rewrites the helper function; the call site is rewritten in Task 3.

**Files:**
- Modify: `src/executor.js`

- [ ] **Step 1: Locate the existing helper**

In `src/executor.js`, find:

```js
function findBlockingPriorError({ history, warnings, turns }) {
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry.action?.action === 'done') continue;
    if (entry.error) {
      warnings.push(`done-gate: rejected by history guard at turn ${turns} — previous action errored: ${entry.error}`);
      return `Your previous action did not succeed: ${entry.error}. Resolve the failure or fail with a reason.`;
    }
    break;
  }
  return null;
}
```

- [ ] **Step 2: Replace it with the observation-aware version**

Replace the function with:

```js
function findBlockingPriorError({ history, warnings, turns }) {
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
```

- [ ] **Step 3: Verify the file parses**

```bash
node --check src/executor.js
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add src/executor.js
git commit -m "executor: make done-gate observation-aware; skip pre-exec rejections"
```

---

## Task 3: Rewrite the `done` block in `src/executor.js` to run a terminal settle and terminate on reject

This is the integration step. Multiple coordinated edits inside `runTodo`. Each sub-step is small.

**Files:**
- Modify: `src/executor.js`

- [ ] **Step 1: Add `observeForVerdict` to the existing observe-settle import**

In `src/executor.js`, find the import line:

```js
import { observeWithSettle, diffSnapshots, compactObservation, formatPreviousActionResult } from './observe-settle.js';
```

Replace with:

```js
import { observeWithSettle, observeForVerdict, diffSnapshots, compactObservation, formatPreviousActionResult } from './observe-settle.js';
```

- [ ] **Step 2: Remove `doneRejections` state**

Find:

```js
  let fatalError = null;
  let wallClockExpired = false;
  let finalSnapshot = '';
  let doneRejections = 0;
  const recentRefActions = [];
```

Replace with (the only change is dropping the `doneRejections` line):

```js
  let fatalError = null;
  let wallClockExpired = false;
  let finalSnapshot = '';
  const recentRefActions = [];
```

- [ ] **Step 3: Replace the entire done-gate block**

Find this block (currently lines ~214–229):

```js
      if (action.action === 'done') {
        if (doneRejections < 2) {
          const doneProblem = findBlockingPriorError({ history, warnings, turns });
          if (doneProblem) {
            doneRejections++;
            lastError = doneProblem;
            const rejEntry = { turn: turns, atMs: Date.now() - t0, action, url, error: doneProblem };
            if (usage) rejEntry.tokens = stepTokens(usage);
            history.push(rejEntry);
            onTurn?.(rejEntry);
            continue;
          }
        } else {
          warnings.push(`done-gate: cap reached (2 rejections) at turn ${turns} — accepting done; end-of-run verifier is authoritative`);
        }
      }

      if (action.action === 'done' || action.action === 'fail') {
        verdict = {
          action: action.action,
          summary: action.summary ?? null,
          reason: action.reason ?? null,
        };
        const verdictEntry = { turn: turns, atMs: Date.now() - t0, action, url: page.url() };
        if (usage) verdictEntry.tokens = stepTokens(usage);
        history.push(verdictEntry);
        onTurn?.(verdictEntry);
        break;
      }
```

Replace with:

```js
      if (action.action === 'done') {
        // Terminal assertion-style settle: wait for the page to stop changing
        // before the verifier judges it. Diff against the prior performed
        // action's snapshot when we have one; otherwise (turn-1 done, or done
        // after a parse-error/ref-miss with no performed action this run) diff
        // against the snapshot we just observed at the top of this turn.
        let terminalObs = null;
        try {
          const prevSnap = prev ? prev.snapshot : snapshot;
          const prevU = prev ? prev.url : url;
          const settle = await observeForVerdict(page, {
            previousSnapshot: prevSnap,
            previousUrl: prevU,
          });
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

        const doneProblem = findBlockingPriorError({ history, warnings, turns });
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
          onTurn?.(rejEntry);
          break;
        }

        verdict = { action: 'done', summary: action.summary ?? null, reason: null };
        const doneEntry = { turn: turns, atMs: Date.now() - t0, action, url: page.url() };
        if (terminalObs) {
          doneEntry.observation = { ...compactObservation(terminalObs), terminal: true };
        }
        if (usage) doneEntry.tokens = stepTokens(usage);
        history.push(doneEntry);
        onTurn?.(doneEntry);
        break;
      }

      if (action.action === 'fail') {
        verdict = {
          action: 'fail',
          summary: null,
          reason: action.reason ?? null,
        };
        const verdictEntry = { turn: turns, atMs: Date.now() - t0, action, url: page.url() };
        if (usage) verdictEntry.tokens = stepTokens(usage);
        history.push(verdictEntry);
        onTurn?.(verdictEntry);
        break;
      }
```

Notes:
- The done branch attaches `{ ...compactObservation(settle), terminal: true }` to its history entry. `compactObservation` already strips heavy fields; `terminal: true` is a marker for analysis (no recorder transform needed — `transformObservation` already passes unknown fields through).
- `fail` is split into its own block with the same shape as before. Splitting the combined `if (done || fail)` block keeps the done flow self-contained and avoids re-running the settle on `fail`.
- `prev.actionEntry.observation = compactObservation(settle)` overwrites the per-action observation that was attached at the top of this turn — by design, since the verdict observation is more authoritative for the prior action's settled state.

- [ ] **Step 4: Verify the file parses**

```bash
node --check src/executor.js
```

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add src/executor.js
git commit -m "executor: terminal settle + terminate-on-reject for done; drop cap-bypass"
```

---

## Task 4: Add hermetic HTML fixtures

Each fixture is a single self-contained HTML file that exercises one acceptance scenario. Tests load them via `file://` URLs in Task 5.

**Files:**
- Create: `scripts/verdict-gate-fixtures/delayed-success.html`
- Create: `scripts/verdict-gate-fixtures/instant-stable.html`
- Create: `scripts/verdict-gate-fixtures/infinite-spinner.html`
- Create: `scripts/verdict-gate-fixtures/no-prior-action.html`

- [ ] **Step 1: Create the directory and `delayed-success.html`**

```bash
mkdir -p scripts/verdict-gate-fixtures
```

Write `scripts/verdict-gate-fixtures/delayed-success.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Delayed Success</title></head>
<body>
  <main>
    <h1>Order Form</h1>
    <button id="submit-btn">Submit</button>
    <div id="result" aria-live="polite"></div>
  </main>
  <script>
    document.getElementById('submit-btn').addEventListener('click', () => {
      setTimeout(() => {
        document.getElementById('result').innerHTML =
          '<h2>Order Confirmed</h2><p>Thank you for your purchase.</p>';
      }, 2500);
    });
  </script>
</body>
</html>
```

- [ ] **Step 2: Create `instant-stable.html`**

Write `scripts/verdict-gate-fixtures/instant-stable.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Instant Stable</title></head>
<body>
  <main>
    <h1>Welcome</h1>
    <p>This page never changes.</p>
    <a href="#info">Learn more</a>
  </main>
</body>
</html>
```

- [ ] **Step 3: Create `infinite-spinner.html`**

Write `scripts/verdict-gate-fixtures/infinite-spinner.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Infinite Spinner</title></head>
<body>
  <main>
    <h1>Loading</h1>
    <p id="ticker" aria-live="polite">Tick 0</p>
  </main>
  <script>
    let n = 0;
    setInterval(() => {
      n += 1;
      document.getElementById('ticker').textContent = 'Tick ' + n;
    }, 100);
  </script>
</body>
</html>
```

- [ ] **Step 4: Create `no-prior-action.html`**

Write `scripts/verdict-gate-fixtures/no-prior-action.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Information Page</title></head>
<body>
  <main>
    <h1>Project Status</h1>
    <p>Currently 42 active projects.</p>
  </main>
</body>
</html>
```

- [ ] **Step 5: Sanity check the files exist and are well-formed**

```bash
ls scripts/verdict-gate-fixtures/
```

Expected:
```
delayed-success.html
infinite-spinner.html
instant-stable.html
no-prior-action.html
```

- [ ] **Step 6: Commit**

```bash
git add scripts/verdict-gate-fixtures
git commit -m "verdict-gate: add hermetic HTML fixtures"
```

---

## Task 5: Write the deterministic verification harness `scripts/verify-verdict-gate.js`

The harness is Playwright-only — no LLM calls — so the assertions are deterministic. It exercises the new `observeForVerdict` against each fixture and the new `findBlockingPriorError` against synthetic history.

**Files:**
- Create: `scripts/verify-verdict-gate.js`

- [ ] **Step 1: Create the script**

Write `scripts/verify-verdict-gate.js`:

```js
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchPage } from '../src/browser.js';
import { observeForVerdict } from '../src/observe-settle.js';

const FIX_DIR = resolve('scripts/verdict-gate-fixtures');
const fileUrl = (name) => pathToFileURL(resolve(FIX_DIR, name)).href;

const failures = [];
const record = (name, ok, detail) => {
  const status = ok ? 'PASS' : 'FAIL';
  console.log(`${status} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures.push(name);
};

async function withPage(fn) {
  const { browser, page } = await launchPage();
  try { return await fn(page); } finally { await browser.close(); }
}

// ---------------- observeForVerdict scenarios ----------------

async function testDelayedSuccess() {
  await withPage(async (page) => {
    await page.goto(fileUrl('delayed-success.html'), { waitUntil: 'load' });
    const before = await page.locator('body').ariaSnapshot({ mode: 'ai' });
    const beforeUrl = page.url();
    // Click without waiting — the success element appears ~2.5s later.
    await page.locator('#submit-btn').click({ timeout: 1000 });
    const t0 = Date.now();
    const r = await observeForVerdict(page, { previousSnapshot: before, previousUrl: beforeUrl });
    const elapsed = Date.now() - t0;
    const sawSuccess = r.addedText.some(t => /Order Confirmed/i.test(t));
    record(
      'delayed-success: gate waits for success element',
      r.settled && sawSuccess && elapsed >= 2000 && elapsed <= 9000,
      `settled=${r.settled} settleMs=${r.settleMs} elapsed=${elapsed} added=${JSON.stringify(r.addedText.slice(0,3))}`,
    );
  });
}

async function testInstantStable() {
  await withPage(async (page) => {
    await page.goto(fileUrl('instant-stable.html'), { waitUntil: 'load' });
    const t0 = Date.now();
    const r = await observeForVerdict(page, { previousSnapshot: null, previousUrl: null });
    const elapsed = Date.now() - t0;
    record(
      'instant-stable: gate exits quickly on a stable page',
      r.settled && elapsed < 2000,
      `settled=${r.settled} settleMs=${r.settleMs} elapsed=${elapsed}`,
    );
  });
}

async function testInfiniteSpinner() {
  await withPage(async (page) => {
    await page.goto(fileUrl('infinite-spinner.html'), { waitUntil: 'load' });
    // Override maxSettleMs to keep the test fast — the signal we want is
    // "loop terminates with settled=false on a chatty page", which a 1500ms
    // budget proves just as well as 10000ms.
    const t0 = Date.now();
    const r = await observeForVerdict(
      page,
      { previousSnapshot: null, previousUrl: null },
      { maxSettleMs: 1500 },
    );
    const elapsed = Date.now() - t0;
    record(
      'infinite-spinner: gate hits maxSettleMs and returns settled=false',
      !r.settled && elapsed >= 1500 && elapsed < 4000,
      `settled=${r.settled} settleMs=${r.settleMs} elapsed=${elapsed}`,
    );
  });
}

async function testNoPriorAction() {
  await withPage(async (page) => {
    await page.goto(fileUrl('no-prior-action.html'), { waitUntil: 'load' });
    // The prev==null path: we pass previousSnapshot/previousUrl as null.
    const r = await observeForVerdict(page, { previousSnapshot: null, previousUrl: null });
    const heading = r.addedText.find(t => /Project Status/i.test(t)) ?? null;
    record(
      'no-prior-action: gate handles prev==null without throwing',
      r.settled && r.snapshot.length > 0 && heading != null,
      `settled=${r.settled} snapshotLen=${r.snapshot.length} heading=${JSON.stringify(heading)}`,
    );
  });
}

// ---------------- findBlockingPriorError scenarios ----------------
// The helper is internal to executor.js. We re-implement it inline here to
// document and lock its contract. If the helper changes, update both
// definitions in lockstep.

function findBlockingPriorError({ history, warnings, turns }) {
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry.action?.action === 'done') continue;
    if (entry.ms == null) continue;
    if (entry.error) {
      const obs = entry.observation;
      const meaningfulChange =
        obs && (obs.urlChanged || obs.snapshotChanged || (obs.addedText && obs.addedText.length > 0));
      if (meaningfulChange) return null;
      warnings.push(`rejected at turn ${turns}: ${entry.error}`);
      return `Your previous action did not succeed: ${entry.error}. Resolve the failure or fail with a reason.`;
    }
    break;
  }
  return null;
}

function testGuardAdmitsErrorWithMeaningfulChange() {
  const history = [{
    turn: 13,
    action: { action: 'click', ref: 'e379' },
    target: "button 'Submit Inquiry'",
    ms: 2050,
    url: 'https://example.com/form',
    error: 'locator.click: Timeout 2000ms exceeded',
    observation: {
      settled: true, settleMs: 200,
      urlChanged: false, snapshotChanged: true,
      summaryTier: 'large',
      addedText: [], removedText: ['Agency Project Inquiry', 'Name (Required)'],
      addedRefs: [], removedRefs: ['e379', 'e261'],
      changedSectionsCount: 5,
    },
  }];
  const warnings = [];
  const result = findBlockingPriorError({ history, warnings, turns: 14 });
  record(
    'guard admits done after stale-ref click that replaced the page',
    result === null && warnings.length === 0,
    `result=${result === null ? 'null' : 'string'} warnings=${warnings.length}`,
  );
}

function testGuardRejectsErrorWithNoChange() {
  const history = [{
    turn: 5,
    action: { action: 'click', ref: 'e10' },
    target: "button 'Save'",
    ms: 2050,
    url: 'https://example.com/x',
    error: 'locator.click: Timeout 2000ms exceeded',
    observation: {
      settled: true, settleMs: 200,
      urlChanged: false, snapshotChanged: false,
      summaryTier: 'unchanged',
      addedText: [], removedText: [],
      addedRefs: [], removedRefs: [],
      changedSectionsCount: 0,
    },
  }];
  const warnings = [];
  const result = findBlockingPriorError({ history, warnings, turns: 6 });
  record(
    'guard rejects done after errored click with no observable change',
    typeof result === 'string' && warnings.length === 1,
    `result=${typeof result} warnings=${warnings.length}`,
  );
}

function testGuardSkipsParseError() {
  // performed action 1: success, no error, observation present
  // entry 2: parse-error (no ms, no action.action, has error)
  // The guard should walk past the parse-error and admit done based on entry 1.
  const history = [
    {
      turn: 1,
      action: { action: 'click', ref: 'e1' },
      ms: 100,
      url: 'https://x/',
      observation: {
        settled: true, settleMs: 100,
        urlChanged: false, snapshotChanged: true,
        summaryTier: 'small',
        addedText: ['ok'], removedText: [],
        addedRefs: [], removedRefs: [],
        changedSectionsCount: 1,
      },
    },
    { turn: 2, error: 'your previous response was not valid JSON', url: 'https://x/' },
  ];
  const warnings = [];
  const result = findBlockingPriorError({ history, warnings, turns: 3 });
  record(
    'guard skips parse-error entries (no ms) and admits done',
    result === null && warnings.length === 0,
    `result=${result === null ? 'null' : 'string'}`,
  );
}

function testGuardSkipsRefMiss() {
  // entry 1: click ref-miss (action set, error set, no ms, no observation)
  // The guard should keep walking; no earlier performed action means admit.
  const history = [
    { turn: 1, action: { action: 'click', ref: 'e999' }, error: 'ref e999 is not present', url: 'https://x/' },
  ];
  const warnings = [];
  const result = findBlockingPriorError({ history, warnings, turns: 2 });
  record(
    'guard skips ref-miss entries (no ms) and admits done',
    result === null && warnings.length === 0,
    `result=${result === null ? 'null' : 'string'}`,
  );
}

// ---------------- runner ----------------

const all = [
  testDelayedSuccess,
  testInstantStable,
  testInfiniteSpinner,
  testNoPriorAction,
  testGuardAdmitsErrorWithMeaningfulChange,
  testGuardRejectsErrorWithNoChange,
  testGuardSkipsParseError,
  testGuardSkipsRefMiss,
];

for (const fn of all) {
  try { await fn(); }
  catch (err) {
    record(fn.name, false, `threw: ${err.message?.split('\n')[0]}`);
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nAll verdict-gate scenarios passed.');
```

Note about the inlined `findBlockingPriorError`: the function in `src/executor.js` is not exported (the file has no clean module boundary for it). Re-implementing it in the harness pins the contract down explicitly; the comment in the harness flags the duplication. Future tasks may extract it; for now KISS wins.

- [ ] **Step 2: Verify the file parses**

```bash
node --check scripts/verify-verdict-gate.js
```

Expected: no output.

- [ ] **Step 3: Run the harness**

```bash
node scripts/verify-verdict-gate.js
```

Expected: all eight scenarios print `PASS`, then `All verdict-gate scenarios passed.` Exit code 0.

If any scenario reports `FAIL`, the printed `detail` line tells you what was off:
- `delayed-success` failure with `elapsed < 2000`: `observeForVerdict` is exiting before the success element appears — check `pollMs` / `stableSamples` defaults in Task 1.
- `instant-stable` with `elapsed >= 2000`: stable-window detection is too eager to reset — check the loop's same-fingerprint branch.
- `infinite-spinner` with `settled=true`: fingerprint isn't catching the ticker text — confirm `ariaSnapshot({ mode: 'ai' })` includes the live-region text.
- `guard admits ...` failure: review the change in Task 2; the meaningful-change predicate should be `urlChanged || snapshotChanged || addedText.length > 0`.

- [ ] **Step 4: Commit**

```bash
git add scripts/verify-verdict-gate.js
git commit -m "verdict-gate: add deterministic verification harness"
```

---

## Task 6: End-to-end smoke run against the gravityforms goal

This task does no code changes. It verifies that the changes from Tasks 1–3 produce the expected behavior on the failure case the spec called out. Per the task spec, this is a tracked smoke check, NOT the merge gate.

**Files:** none modified.

- [ ] **Step 1: Run the gravityforms goal**

Run:

```bash
node src/cli.js run "I can visit https://www.gravityforms.com/form-templates/project-inquiry-form/, fill the mandatory form fields (email admin@haukebrinkmann.de) and send the form. I will see the 'result' page which tells me that I have sent the form"
```

(If the project's CLI uses a different invocation in your environment — e.g. `qagent` instead of `node src/cli.js run` — substitute it. Look for the result-file path printed at the end.)

- [ ] **Step 2: Inspect the result JSON for terminal-observation fields**

Open the produced `results/<timestamp>.json`. Find the `done` step (action.action === 'done'). Confirm:

- It has an `observation` object with `terminal: true` plus the standard fields (`settled`, `settleSec`, `urlChanged`, `snapshotChanged`, `summaryTier`, `addedText`, `removedText`, `addedRefs`, `removedRefs`, `changedSectionsCount`).
- The `warnings` array does NOT contain a string starting with `done-gate: cap reached`.

- [ ] **Step 3: Inspect the Submit-Inquiry path**

Find the step where the action is `click` against the Submit Inquiry button. Two acceptable shapes:

- **Best case:** click succeeds, the next-step observation shows `addedText` containing the thank-you text, and the run hits `done` cleanly without any `done-gate: rejected by history guard` warning.
- **Acceptable:** click errors with `Timeout 2000ms exceeded`, but its `observation` shows a meaningful change (`snapshotChanged: true`, `summaryTier: 'large'`, removedText non-empty). The next turn's `done` is admitted by the new observation-aware guard. No `done-gate` warning, no cap-bypass warning.

- [ ] **Step 4: Confirm the verifier saw the post-settle snapshot**

Open the `<timestamp>.json` and the matching `<timestamp>.snapshot.yaml` (only written when `outcome !== 'pass'`; if the run passed, skip this step).

If present, the snapshot YAML should be the post-settle state — for gravityforms, that means the form should be gone or replaced by the success message. If the snapshot still shows the unchanged form fields and the verifier verdict is `fail` with form-fields-still-visible evidence, the terminal settle didn't actually run; check the wiring in Task 3 (especially Step 3).

- [ ] **Step 5: Record the result file path; do not commit**

If you keep a worklog, note the result-file timestamp and outcome (pass / fail). No commit in this task. Per the task spec, gravityforms is a tracked smoke check — pass-rate improvement is the goal but a single-run failure does not block merge.

---

## Self-review

Spec coverage check:

| Spec section | Task |
|---|---|
| Extended settle for terminal verification (`pollMs: 250`, `stableSamples: 3`, `maxSettleMs: 10000`, stable window resets on URL/snapshot change) | Task 1 (defaults); Task 5 fixture `delayed-success` proves the wait |
| Wire into the `done` flow (settle → attach to entry → update finalSnapshot → guard → accept/terminate) | Task 3 Step 3 |
| `prev == null` baseline-and-settle path | Task 3 Step 3 (the `prev ? prev.snapshot : snapshot` fallback); Task 5 `no-prior-action` proves the call shape |
| Observation-aware history guard predicate | Task 2 Step 2; Task 5 `guard admits ...` and `guard rejects ...` scenarios |
| Drop the cap-bypass; terminate as `fail` on reject | Task 3 Step 2 (remove `doneRejections`); Task 3 Step 3 (`break` on guard reject, no `continue`) |
| Done entry carries `entry.observation` (mirrors performed-action entries, tagged terminal) | Task 3 Step 3 (`{ ...compactObservation(settle), terminal: true }`) |
| Recorder passes through unchanged | No-op (recorder's existing `transformObservation` already passes unknown fields through) |
| Acceptance: `delayed-success.html`, `instant-stable.html`, `infinite-spinner.html`, `no-prior-action.html` | Task 4 (fixtures); Task 5 (assertions) |
| Acceptance: gravityforms remains a tracked smoke (not merge gate) | Task 6 |
| Acceptance: stale-ref-after-submit admitted without cap-bypass | Task 5 `guard admits ...` (synthetic gravityforms shape); Task 6 (real-site confirmation) |
| Acceptance: errored-with-no-change still rejected | Task 5 `guard rejects ...` |
| Acceptance: cap-bypass warning gone from result warnings | Task 3 Step 2 (constant removed); Task 3 Step 3 (warning string never written) |
| Non-goal: no LLM verifier-gate, no verifier change, no site-specific rules, no retry of failed action | Plan introduces none of these |

Placeholder scan: every step contains the actual code or command. No "TBD" / "implement later" markers.

Type consistency: `observeForVerdict` is referenced in Task 1 (creation) and Task 3 (import + call) — same name. `findBlockingPriorError` is rewritten in Task 2 and called unchanged in Task 3 — same signature `{ history, warnings, turns }` returning `string | null`. Compact observation field names (`urlChanged`, `snapshotChanged`, `addedText`) match `compactObservation()` in `src/observe-settle.js`.

CLI flag (`--verdict-settle-timeout`) deferred to Task 06f per the task spec ("If too far-reaching for this task, hardcode the default and add the flag in Task 06f."). The 10s default is hardcoded as `VERDICT_DEFAULT_MAX_SETTLE_MS` in Task 1.
