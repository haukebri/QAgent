# Settle And Diff Observation (MVP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the executor's coarse "Page grew/shrunk/unchanged ±NNN chars" hint with a structured per-action observation (settle + URL/snapshot fingerprint + accessible-name diff), surfaced as a "Previous action result" block in the next LLM prompt and persisted in step history and result JSON.

**Architecture:** New `src/observe-settle.js` exports `observeWithSettle()`, `fingerprint()`, `diffSnapshots()`, `formatPreviousActionResult()`, and `compactObservation()`. The executor calls `observeWithSettle` at the top of each non-terminal turn after a non-wait action (single `observe()` for turn 1 and post-wait turns), feeds the result into a new prompt block, attaches a compact form to the prior step's history entry, and uses `urlChanged`/`snapshotChanged` as the single source of truth for stuck detection and compression-baseline reset. `observe()` itself loses its 2 s networkidle wait — `observeWithSettle` subsumes it.

**Tech Stack:** Node 20+ ESM, Playwright `ariaSnapshot({ mode: 'ai' })`, `node:crypto` sha1. No test framework (project convention — manual `node --check` per task plus end-to-end smoke run at the end).

**Spec:** `docs/superpowers/specs/2026-05-01-settle-and-diff-observation-design.md`.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/observe-settle.js` | NEW | `fingerprint()`, `diffSnapshots()`, `observeWithSettle()`, `compactObservation()`, `formatPreviousActionResult()` |
| `src/tools.js` | MODIFY | drop the 2 s networkidle wait inside `observe()` |
| `src/executor.js` | MODIFY | replace observe-and-snapshotDelta block; insert "Previous action result" prompt block; rewire stuck detection and compression-reset to use the observation; attach `observation` to performed history entries |
| `src/recorder.js` | MODIFY | pass through the per-step `observation` object |
| `package.json` | unchanged | — |

`observe-settle.js` will end up around 180–200 lines. Keeping the prompt formatter (`formatPreviousActionResult`) in this module instead of `executor.js` keeps the formatting next to the data shape it formats.

---

## Task 1: Scaffold `src/observe-settle.js` with `fingerprint()`

**Files:**
- Create: `src/observe-settle.js`

- [ ] **Step 1: Create the file with the fingerprint helper**

Write `src/observe-settle.js`:

```js
import { createHash } from 'node:crypto';

// Stable hash of an ariaSnapshot YAML string. Strips refs (Playwright re-numbers
// them deterministically; identical DOM produces identical numbers, but
// stripping makes the predicate robust to incidental renumbering caused by
// unrelated DOM tweaks). Collapses all whitespace runs. Keeps state attributes
// like [expanded], [selected], [checked] so flips count as change.
export function fingerprint(snapshot) {
  if (snapshot == null) return null;
  const normalized = snapshot
    .replace(/\[ref=e\d+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha1').update(normalized).digest('hex');
}
```

- [ ] **Step 2: Verify the file parses**

Run from the repo root:

```bash
node --check src/observe-settle.js
```

Expected: no output.

- [ ] **Step 3: Sanity check the function in a one-off node invocation**

```bash
node -e "import('./src/observe-settle.js').then(m => { console.log(m.fingerprint('- button \"Submit\" [ref=e1]')); console.log(m.fingerprint('- button \"Submit\" [ref=e99]')); console.log(m.fingerprint('- button \"Cancel\" [ref=e1]')); })"
```

Expected: the first two lines print the same hash (refs differ but stripped); the third prints a different hash (different name).

- [ ] **Step 4: Commit**

```bash
git add src/observe-settle.js
git commit -m "observe-settle: scaffold module with fingerprint()"
```

---

## Task 2: Add `diffSnapshots()` to `src/observe-settle.js`

**Files:**
- Modify: `src/observe-settle.js`

- [ ] **Step 1: Append helper extractors and the diff function**

Append to `src/observe-settle.js`:

```js
import { sliceSections } from './snapshot-compress.js';

const QUOTED_NAME_RE = /^\s*-\s*\w+\s+"([^"]+)"/gm;
const REF_RE = /\[ref=(e\d+)\]/g;
const HEADING_RE = /^\s*-\s*heading\s+"([^"]+)"/m;

function extractQuotedNames(snapshot) {
  const out = new Set();
  if (!snapshot) return out;
  for (const m of snapshot.matchAll(QUOTED_NAME_RE)) out.add(m[1]);
  return out;
}

function extractRefs(snapshot) {
  const out = new Set();
  if (!snapshot) return out;
  for (const m of snapshot.matchAll(REF_RE)) out.add(m[1]);
  return out;
}

function setDifference(a, b) {
  const out = [];
  for (const v of a) if (!b.has(v)) out.push(v);
  return out;
}

// Pure diff between two ariaSnapshot YAML strings. Returns the structured
// observation fields (excluding settle stats — those come from observeWithSettle).
export function diffSnapshots(prev, next, prevUrl, nextUrl) {
  const fingerprintBefore = fingerprint(prev);
  const fingerprintAfter = fingerprint(next);
  const urlChanged = prevUrl !== nextUrl;
  const snapshotChanged = fingerprintBefore !== fingerprintAfter;
  const deltaChars = (next?.length ?? 0) - (prev?.length ?? 0);

  const prevNames = extractQuotedNames(prev);
  const nextNames = extractQuotedNames(next);
  const addedText = setDifference(nextNames, prevNames);
  const removedText = setDifference(prevNames, nextNames);

  const prevRefs = extractRefs(prev);
  const nextRefs = extractRefs(next);
  const addedRefs = setDifference(nextRefs, prevRefs);
  const removedRefs = setDifference(prevRefs, nextRefs);

  const prevSections = prev ? sliceSections(prev) : [];
  const nextSections = next ? sliceSections(next) : [];
  const prevByRef = new Map();
  for (const s of prevSections) if (s.ref) prevByRef.set(s.ref, s);
  const changedSections = [];
  for (const s of nextSections) {
    if (!s.ref) continue;
    const prevS = prevByRef.get(s.ref);
    if (!prevS) continue;
    if (prevS.sha1 === s.sha1) continue;
    changedSections.push({
      role: s.role,
      ref: s.ref,
      deltaChars: s.text.length - prevS.text.length,
    });
  }

  let summaryTier;
  if (!urlChanged && !snapshotChanged) {
    summaryTier = 'unchanged';
  } else if (
    addedText.length > 8 ||
    removedText.length > 8 ||
    (nextSections.length > 0 && changedSections.length / nextSections.length > 0.5)
  ) {
    summaryTier = 'large';
  } else {
    summaryTier = 'small';
  }

  return {
    fingerprintBefore,
    fingerprintAfter,
    urlChanged,
    snapshotChanged,
    deltaChars,
    changedSections,
    addedText,
    removedText,
    addedRefs,
    removedRefs,
    summaryTier,
  };
}
```

- [ ] **Step 2: Verify the file parses**

```bash
node --check src/observe-settle.js
```

Expected: no output.

- [ ] **Step 3: Sanity check `diffSnapshots`**

```bash
node -e "import('./src/observe-settle.js').then(m => {
  const before = '- button \"Submit Inquiry\" [ref=e379]\n- textbox \"Email\" [ref=e261]';
  const after  = '- heading \"Thank you for your project inquiry!\" [ref=e680]';
  const d = m.diffSnapshots(before, after, '/form', '/form');
  console.log(JSON.stringify({ tier: d.summaryTier, added: d.addedText, removed: d.removedText, addedRefs: d.addedRefs, removedRefs: d.removedRefs }, null, 2));
})"
```

Expected output (order may vary inside arrays):

```json
{
  "tier": "small",
  "added": ["Thank you for your project inquiry!"],
  "removed": ["Submit Inquiry", "Email"],
  "addedRefs": ["e680"],
  "removedRefs": ["e379", "e261"]
}
```

If `tier` is wrong or arrays are off, fix the regex / logic before continuing.

- [ ] **Step 4: Commit**

```bash
git add src/observe-settle.js
git commit -m "observe-settle: add diffSnapshots with tier classification"
```

---

## Task 3: Add `observeWithSettle()` to `src/observe-settle.js`

**Files:**
- Modify: `src/observe-settle.js`

- [ ] **Step 1: Import `observe` from tools and add the settle loop**

Add `import { observe } from './tools.js';` to the top of `src/observe-settle.js` (alongside the existing imports).

Then append:

```js
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function safeObserve(page) {
  try {
    return { snapshot: await observe(page), url: page.url(), ok: true };
  } catch (err) {
    return { snapshot: null, url: null, ok: false, err };
  }
}

// Repeatedly observe until URL+normalized snapshot are stable for `stableSamples`
// consecutive samples, or `maxSettleMs` elapses. Returns the latest sample plus
// the structured diff against `previousSnapshot` / `previousUrl`.
//
// Never throws: a Playwright failure inside the loop returns settled=false with
// whatever sample we last successfully captured.
export async function observeWithSettle(page, prev, opts = {}) {
  const pollMs = opts.pollMs ?? 150;
  const stableSamples = opts.stableSamples ?? 2;
  const maxSettleMs = opts.maxSettleMs ?? 3000;
  const previousSnapshot = prev?.previousSnapshot ?? null;
  const previousUrl = prev?.previousUrl ?? null;

  const t0 = Date.now();
  let last = await safeObserve(page);
  let settled = false;
  let matchStreak = last.ok ? 1 : 0;

  while (true) {
    if (matchStreak >= stableSamples) { settled = true; break; }
    if (Date.now() - t0 >= maxSettleMs) break;
    await sleep(pollMs);
    const cur = await safeObserve(page);
    if (!cur.ok) break;
    if (!last.ok) {
      last = cur;
      matchStreak = 1;
      continue;
    }
    if (cur.url === last.url && fingerprint(cur.snapshot) === fingerprint(last.snapshot)) {
      matchStreak += 1;
    } else {
      matchStreak = 1;
      last = cur;
    }
  }

  const snapshot = last.snapshot ?? '';
  const url = last.url ?? page.url();
  const diff = diffSnapshots(previousSnapshot, snapshot, previousUrl, url);
  return {
    snapshot,
    url,
    settled,
    settleMs: Date.now() - t0,
    ...diff,
  };
}
```

- [ ] **Step 2: Verify the file parses**

```bash
node --check src/observe-settle.js
```

Expected: no output.

- [ ] **Step 3: Live smoke test against a real page**

The repo already has a debug entrypoint (`src/observe.js`) that opens a page and prints the snapshot. We want a similar but settle-flavored quick check. Run:

```bash
node -e "
import('./src/browser.js').then(async ({ launchPage }) => {
  const m = await import('./src/observe-settle.js');
  const { browser, page } = await launchPage();
  try {
    await page.goto('https://example.com', { waitUntil: 'load', timeout: 15000 });
    const r = await m.observeWithSettle(page, { previousSnapshot: null, previousUrl: null });
    console.log({
      settled: r.settled, settleMs: r.settleMs, url: r.url,
      snapshotLen: r.snapshot.length,
      tier: r.summaryTier,
      addedText: r.addedText.slice(0, 3),
    });
  } finally { await browser.close(); }
});
"
```

Expected: `settled: true`, `settleMs` typically <500ms on example.com, `tier: 'large'` (since previousSnapshot is null, every name is added), `addedText` shows entries like `'Example Domain'` / `'More information...'`.

If `settled: false` on example.com or `settleMs` is near 3000ms, something is wrong with the loop predicate — fix before continuing.

- [ ] **Step 4: Commit**

```bash
git add src/observe-settle.js
git commit -m "observe-settle: add observeWithSettle loop"
```

---

## Task 4: Add `compactObservation()` and `formatPreviousActionResult()` to `src/observe-settle.js`

**Files:**
- Modify: `src/observe-settle.js`

- [ ] **Step 1: Append the compactor and prompt formatter**

Append to `src/observe-settle.js`:

```js
const HISTORY_TEXT_CAP = 20;
const HISTORY_REF_CAP = 50;
const PROMPT_TEXT_CAP = 5;
const PROMPT_TEXT_TRUNC = 80;

const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// Strip the heavy fields (raw snapshot, url, fingerprints, full changedSections)
// and apply per-list caps so a single step's observation can't blow up the
// result JSON.
export function compactObservation(obs) {
  if (!obs) return null;
  return {
    settled: obs.settled,
    settleMs: obs.settleMs,
    urlChanged: obs.urlChanged,
    snapshotChanged: obs.snapshotChanged,
    deltaChars: obs.deltaChars,
    summaryTier: obs.summaryTier,
    addedText: obs.addedText.slice(0, HISTORY_TEXT_CAP),
    removedText: obs.removedText.slice(0, HISTORY_TEXT_CAP),
    addedRefs: obs.addedRefs.slice(0, HISTORY_REF_CAP),
    removedRefs: obs.removedRefs.slice(0, HISTORY_REF_CAP),
    changedSectionsCount: obs.changedSections.length,
  };
}

function pickNewHeading(addedText, snapshot) {
  if (snapshot) {
    const m = snapshot.match(HEADING_RE);
    if (m && addedText.includes(m[1])) return m[1];
  }
  if (addedText.length > 0) return addedText[0];
  return null;
}

// One-line action descriptor for the prompt block.
// Examples:
//   "click button 'Submit Inquiry'"
//   "fill textbox 'Email' with \"hauke@…\""
//   "navigate https://example.com"
//   "wait 1500ms"
//   "pressKey Enter"
function describeAction(action, target) {
  switch (action.action) {
    case 'navigate':
      return `navigate ${action.url}`;
    case 'wait':
      return `wait ${action.ms ?? 1000}ms`;
    case 'click':
      return target ? `click ${target}` : `click ref ${action.ref}`;
    case 'fill': {
      const v = typeof action.value === 'string' ? truncate(action.value, 40) : action.value;
      return target ? `fill ${target} with ${JSON.stringify(v)}` : `fill ref ${action.ref}`;
    }
    case 'selectOption':
      return target ? `select ${JSON.stringify(action.value)} in ${target}` : `selectOption ref ${action.ref}`;
    case 'pressKey':
      return action.ref ? `pressKey ${action.key} on ${target ?? `ref ${action.ref}`}` : `pressKey ${action.key}`;
    case 'type': {
      const v = typeof action.value === 'string' ? truncate(action.value, 40) : action.value;
      return target ? `type ${JSON.stringify(v)} into ${target}` : `type ref ${action.ref}`;
    }
    default:
      return action.action;
  }
}

// Format the "Previous action result" block. `entry` is the executor history
// entry for the action whose effects `observation` describes. `snapshot` is
// the post-action snapshot (used to look up a heading line for the large
// tier). `nextUrl` is the post-action URL. Returns a string (no trailing
// newline) or null when no block should be emitted.
export function formatPreviousActionResult(entry, observation, snapshot, nextUrl) {
  if (!entry || !observation) return null;
  const desc = describeAction(entry.action, entry.target);
  const ms = entry.ms ?? 0;

  const lines = [];

  // Wait gets a minimal block — no settle stats line.
  if (entry.action.action === 'wait') {
    lines.push(`Previous action: ${desc}.`);
    appendChangeLines(lines, observation, snapshot, nextUrl);
    return lines.join('\n');
  }

  // Header line. Includes ERROR if the action threw, plus settle status.
  if (entry.error) {
    lines.push(`Previous action: ${desc} — ERROR: ${entry.error}`);
    if (observation.urlChanged || observation.snapshotChanged) {
      lines.push('But the page did change while the action was running:');
    }
  } else {
    const settleNote = observation.settled
      ? `settled in ${observation.settleMs}ms`
      : `did NOT settle within ${observation.settleMs}ms — page still mutating`;
    lines.push(`Previous action: ${desc} (${ms}ms; ${settleNote}).`);
  }

  appendChangeLines(lines, observation, snapshot, nextUrl);
  return lines.join('\n');
}

function appendChangeLines(lines, obs, snapshot, nextUrl) {
  const urlPart = obs.urlChanged
    ? `URL changed → ${truncate(urlPath(nextUrl), 80)}`
    : 'URL unchanged';

  if (obs.summaryTier === 'unchanged') {
    lines.push(`${urlPart}. Page unchanged — action produced no visible state change.`);
    return;
  }

  if (obs.summaryTier === 'small') {
    const sectionPart =
      obs.changedSections.length > 0
        ? `, ${obs.changedSections.length} section${obs.changedSections.length === 1 ? '' : 's'}`
        : '';
    const deltaPart = obs.deltaChars >= 0 ? `+${obs.deltaChars}` : `${obs.deltaChars}`;
    lines.push(`${urlPart}. Page changed (${deltaPart} chars${sectionPart}).`);
    if (obs.addedText.length > 0) {
      lines.push(
        'Added: ' +
          obs.addedText
            .slice(0, PROMPT_TEXT_CAP)
            .map(s => `"${truncate(s, PROMPT_TEXT_TRUNC)}"`)
            .join(', '),
      );
    }
    if (obs.removedText.length > 0) {
      lines.push(
        'Removed: ' +
          obs.removedText
            .slice(0, PROMPT_TEXT_CAP)
            .map(s => `"${truncate(s, PROMPT_TEXT_TRUNC)}"`)
            .join(', '),
      );
    }
    return;
  }

  // tier === 'large'
  lines.push(`${urlPart}. Page largely replaced.`);
  const heading = pickNewHeading(obs.addedText, snapshot);
  lines.push(heading ? `New heading: "${truncate(heading, 80)}"` : '(no new heading)');
  lines.push(
    `+${obs.addedRefs.length} refs, -${obs.removedRefs.length} refs across ${obs.changedSections.length} section${obs.changedSections.length === 1 ? '' : 's'}.`,
  );
}

function urlPath(u) {
  try { return new URL(u).pathname || '/'; } catch { return u ?? ''; }
}
```

- [ ] **Step 2: Verify the file parses**

```bash
node --check src/observe-settle.js
```

Expected: no output.

- [ ] **Step 3: Sanity check the formatter on synthesized observations**

```bash
node -e "
import('./src/observe-settle.js').then(m => {
  const obs = {
    settled: true, settleMs: 900,
    urlChanged: false, snapshotChanged: true, deltaChars: -1420,
    summaryTier: 'small',
    changedSections: [{ role: 'main', ref: 'e12', deltaChars: -1420 }],
    addedText: ['Thank you for your project inquiry!'],
    removedText: ['Submit Inquiry'],
    addedRefs: ['e680'], removedRefs: ['e379'],
  };
  const entry = {
    action: { action: 'click', ref: 'e379' },
    target: \"button 'Submit Inquiry'\",
    ms: 430,
  };
  console.log(m.formatPreviousActionResult(entry, obs, null, 'https://example.com/form'));
  console.log('---');
  // Error case
  const errEntry = { ...entry, error: 'locator.click: Timeout 2000ms exceeded.' };
  console.log(m.formatPreviousActionResult(errEntry, obs, null, 'https://example.com/form'));
});
"
```

Expected first block:
```
Previous action: click button 'Submit Inquiry' (430ms; settled in 900ms).
URL unchanged. Page changed (-1420 chars, 1 section).
Added: "Thank you for your project inquiry!"
Removed: "Submit Inquiry"
```

Expected second block: same minus the timing line, replaced by an `ERROR:` header and the `But the page did change while the action was running:` line.

- [ ] **Step 4: Commit**

```bash
git add src/observe-settle.js
git commit -m "observe-settle: add compactObservation + formatPreviousActionResult"
```

---

## Task 5: Drop networkidle from `observe()`

**Files:**
- Modify: `src/tools.js:19-24`

- [ ] **Step 1: Replace the function**

In `src/tools.js`, find:

```js
// Brief soft-fail networkidle wait lets SPA route transitions settle before we
// snapshot. 2s cap is intentional: on chatty pages networkidle never fires; on
// quiet pages it lands in <1s. Beyond that we snapshot anyway and let the LLM
// iterate. Internal-only — not user-tunable.
export async function observe(page) {
  try {
    await page.waitForLoadState('networkidle', { timeout: 2000 });
  } catch {}
  return await page.locator('body').ariaSnapshot({ mode: 'ai' });
}
```

Replace with:

```js
// One-shot snapshot. The post-action settle loop in observe-settle.js subsumes
// the previous networkidle wait by polling observe() until URL + normalized
// snapshot are stable, which is a stricter signal than network state.
export async function observe(page) {
  return await page.locator('body').ariaSnapshot({ mode: 'ai' });
}
```

- [ ] **Step 2: Verify the file parses**

```bash
node --check src/tools.js
```

Expected: no output.

- [ ] **Step 3: Verify the debug script still runs**

```bash
node src/observe.js https://example.com 2>&1 | head -5
```

Expected: aria YAML output (first few lines), not an error.

- [ ] **Step 4: Commit**

```bash
git add src/tools.js
git commit -m "tools: drop networkidle wait inside observe()"
```

---

## Task 6: Replace observe-and-snapshotDelta machinery in `src/executor.js`

This is the integration step. Multiple coordinated edits inside `runTodo`. Each sub-step is small.

**Files:**
- Modify: `src/executor.js`

- [ ] **Step 1: Add the new import**

In `src/executor.js`, find the import line:

```js
import { compressAgainstBaseline } from './snapshot-compress.js';
```

Add immediately below it:

```js
import { observeWithSettle, diffSnapshots, compactObservation, formatPreviousActionResult } from './observe-settle.js';
```

- [ ] **Step 2: Remove snapshot-length constants, add nothing new at the top**

In `src/executor.js`, find:

```js
const STUCK_WINDOW = 5;
const STUCK_THRESHOLD = 3;
const STUCK_DELTA_TOLERANCE = 200;
```

Remove `STUCK_DELTA_TOLERANCE`. Final state:

```js
const STUCK_WINDOW = 5;
const STUCK_THRESHOLD = 3;
```

- [ ] **Step 3: Replace `prevSnapshotLen` with `prev`**

In `runTodo`, find the block:

```js
let prevSnapshotLen = null;
let baseline = null;
let prevCompressionRatio = null;
```

Replace with:

```js
let prev = null;             // { snapshot, url, actionEntry } after a performed action; null on turn 1
let baseline = null;
let prevCompressionRatio = null;
```

- [ ] **Step 4: Replace the top-of-loop observe block**

In `runTodo`, find this block at the top of the `while (turns < maxTurns)` body (immediately inside `try {`):

```js
const snapshot = await observe(page);
let snapshotDelta = null;
if (prevSnapshotLen !== null && history.length > 0) {
  const last = history[history.length - 1];
  if (last.action?.action !== 'wait') {
    snapshotDelta = snapshot.length - prevSnapshotLen;
  }
}
prevSnapshotLen = snapshot.length;
finalSnapshot = snapshot;
const url = page.url();
```

Replace with:

```js
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
```

Note: `prev.snapshot` and `prev.url` are the snapshot/URL captured *after* the prior action ran. We set them in step 11 below.

- [ ] **Step 5: Update the compression-baseline reset condition**

Just below the new observe block, find:

```js
const shouldReset = !baseline
  || url !== baseline.url
  || (prevCompressionRatio != null && prevCompressionRatio > 0.6)
  || turns - baseline.turn >= 6
  || (lastError && snapshotDelta != null && snapshotDelta > 500);
```

Replace with:

```js
const shouldReset = !baseline
  || url !== baseline.url
  || (prevCompressionRatio != null && prevCompressionRatio > 0.6)
  || turns - baseline.turn >= 6
  || (lastError && observation && observation.deltaChars > 500);
```

- [ ] **Step 6: Update the stuck-detection predicate**

Find:

```js
if (pendingRefAction && snapshotDelta != null) {
  const noProgress =
    pendingRefAction.urlBefore === pendingRefAction.urlAfter &&
    Math.abs(snapshotDelta) < STUCK_DELTA_TOLERANCE;
  recentRefActions.push({ sig: pendingRefAction.sig, noProgress });
```

Replace with:

```js
if (pendingRefAction && observation) {
  const noProgress = !observation.urlChanged && !observation.snapshotChanged;
  recentRefActions.push({ sig: pendingRefAction.sig, noProgress });
```

(Only the first two lines of the block change; leave the rest of the stuck-detection block intact.)

- [ ] **Step 7: Update the call to `askNextAction`**

Find:

```js
const recentActions = recentActionsBlock(history, 3);
const { action, usage, parseError, llmError } = await askNextAction({ agent, goal, url, messageSnapshot, isBaselineTurn, baselineTurn: baseline.turn, lastError, snapshotDelta, recentActions });
```

Replace with:

```js
const recentActions = recentActionsBlock(history, 3);
const previousActionResult = observation && history.length > 0
  ? formatPreviousActionResult(history[history.length - 1], observation, snapshot, url)
  : null;
const { action, usage, parseError, llmError } = await askNextAction({ agent, goal, url, messageSnapshot, isBaselineTurn, baselineTurn: baseline.turn, lastError, previousActionResult, recentActions });
```

- [ ] **Step 8: Update `askNextAction` and `buildFollowUpPrompt` signatures**

Find `askNextAction`:

```js
async function askNextAction({ agent, goal, url, messageSnapshot, isBaselineTurn, baselineTurn, lastError, snapshotDelta, recentActions }) {
```

Replace with:

```js
async function askNextAction({ agent, goal, url, messageSnapshot, isBaselineTurn, baselineTurn, lastError, previousActionResult, recentActions }) {
```

Find the line inside `askNextAction`:

```js
const message = isFirstTurn
  ? buildInitialPrompt({ goal, url, snapshot: messageSnapshot, baselineTurn })
  : buildFollowUpPrompt({ url, snapshot: messageSnapshot, lastError, snapshotDelta, isBaselineTurn, baselineTurn, recentActions });
```

Replace with:

```js
const message = isFirstTurn
  ? buildInitialPrompt({ goal, url, snapshot: messageSnapshot, baselineTurn })
  : buildFollowUpPrompt({ url, snapshot: messageSnapshot, lastError, previousActionResult, isBaselineTurn, baselineTurn, recentActions });
```

Find `buildFollowUpPrompt`:

```js
function buildFollowUpPrompt({ url, snapshot, lastError, snapshotDelta, isBaselineTurn, baselineTurn, recentActions }) {
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
  ...
```

Replace with:

```js
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
  ...
```

(Leave the rest of `buildFollowUpPrompt` — `recentActions`, `Next action (JSON only):` — unchanged.)

- [ ] **Step 9: Set `prev` after a performed action (success and error paths)**

The existing `pendingRefAction = { ... }` block at the end of the iteration body looks like:

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

Immediately AFTER this block (still inside the outer `try { ... }` of the iteration), add:

```js
prev = { snapshot, url, actionEntry: entry };
```

This sets `prev` regardless of action success or failure (both paths reach this line via the inner try/catch). On a fatal navigate error, the inner catch re-throws — the assignment is skipped and the outer catch breaks the loop, leaving `prev` untouched. That is intentional: the post-loop final-observation handler only runs when `prev.actionEntry.observation` is null AND `prev` exists, so a fatal-navigate run simply records the error entry without an observation.

- [ ] **Step 10: Drop `prev` updates that should NOT happen for non-execute paths**

Verify each `continue` statement in the loop body — they all happen *before* the action-execution block, which means `prev` is not touched. That's correct: parse-error / ref-miss / done-rejected paths leave `prev` pointing at the prior performed action, so the next turn's observation still describes that action's effect.

(No code change in this step. Just a code-review checkpoint. If you find a path that pushes a *performed-action* entry without setting `prev`, fix it.)

- [ ] **Step 11: Add a final-observation pass after the loop**

Find the block immediately after `while (turns < maxTurns)`:

```js
const finalUrl = page.url();
const elapsedMs = Date.now() - t0;

if (fatalError !== null) {
```

Insert between the `while` close brace and `const finalUrl`:

```js
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
```

- [ ] **Step 12: Verify the file parses**

```bash
node --check src/executor.js
```

Expected: no output.

- [ ] **Step 13: Commit**

```bash
git add src/executor.js
git commit -m "executor: wire observeWithSettle, replace snapshot-length signals"
```

---

## Task 7: Pass `observation` through `src/recorder.js`

**Files:**
- Modify: `src/recorder.js`

- [ ] **Step 1: Verify the recorder already passes `observation` through**

Read `src/recorder.js`. The `transformStep` function does:

```js
function transformStep(s) {
  const out = { ...s };
  if ('atMs' in out) { out.atSec = toSec(out.atMs); delete out.atMs; }
  if ('ms' in out)   { out.durationSec = toSec(out.ms); delete out.ms; }
  if (out.tokens) out.tokens = transformTokens(out.tokens);
  return out;
}
```

`{...s}` already shallow-copies the `observation` field. No change needed unless we want to rename or further transform.

If you find the function as above, no edit is required for this task — proceed to step 2.

- [ ] **Step 2: Add a `settleSec` derivation for symmetry**

To match the existing `atSec` / `durationSec` rewrite of milliseconds-to-seconds, edit `transformStep` so the observation's `settleMs` becomes `settleSec` in the JSON. Replace:

```js
function transformStep(s) {
  const out = { ...s };
  if ('atMs' in out) { out.atSec = toSec(out.atMs); delete out.atMs; }
  if ('ms' in out)   { out.durationSec = toSec(out.ms); delete out.ms; }
  if (out.tokens) out.tokens = transformTokens(out.tokens);
  return out;
}
```

with:

```js
function transformObservation(o) {
  if (!o) return o;
  const out = { ...o };
  if ('settleMs' in out) { out.settleSec = toSec(out.settleMs); delete out.settleMs; }
  return out;
}

function transformStep(s) {
  const out = { ...s };
  if ('atMs' in out) { out.atSec = toSec(out.atMs); delete out.atMs; }
  if ('ms' in out)   { out.durationSec = toSec(out.ms); delete out.ms; }
  if (out.tokens) out.tokens = transformTokens(out.tokens);
  if (out.observation) out.observation = transformObservation(out.observation);
  return out;
}
```

- [ ] **Step 3: Verify the file parses**

```bash
node --check src/recorder.js
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add src/recorder.js
git commit -m "recorder: rewrite observation.settleMs to settleSec"
```

---

## Task 8: End-to-end smoke run against the gravityforms goal

This task does no code changes. It verifies that the changes from tasks 1–7 produce the expected behavior on the failure case the spec called out.

**Files:** none modified.

- [ ] **Step 1: Run the gravityforms goal**

Run:

```bash
node src/cli.js run "I can visit https://www.gravityforms.com/form-templates/project-inquiry-form/, fill the mandatory form fields (email admin@haukebrinkmann.de) and send the form. I will see the 'result' page which tells me that I have sent the form"
```

Wait for the run to finish (typically <2 minutes). Note the result file path printed at the end.

- [ ] **Step 2: Inspect the result JSON for `observation` fields**

Read the produced `results/<timestamp>.json`. For each step that has an `action` of type `click`, `fill`, `selectOption`, `pressKey`, `type`, `wait`, or `navigate`, confirm there is an `observation` object with at least:

- `settled` (bool)
- `settleSec` (number)
- `urlChanged`, `snapshotChanged` (bool)
- `summaryTier` ("unchanged" | "small" | "large")
- `addedText`, `removedText`, `addedRefs`, `removedRefs` (arrays)
- `changedSectionsCount` (number)

Confirm `done` / `fail` entries do NOT have `observation`.

- [ ] **Step 3: Inspect a Submit-Inquiry step**

Find the step where the action is `click` against the Submit Inquiry button. Confirm one of the following two outcomes:

- **(Best case)** No error on the click; next-step's `observation` shows `summaryTier: 'small' or 'large'`, `addedText` containing `"Thank you for your project inquiry!"`, `removedText` containing `"Submit Inquiry"`. Driver calls `done` on the next turn cleanly.
- **(Acceptable)** Click errors with `Timeout 2000ms exceeded` (the form submitted before the click completed). The same observation appears on that step (added "Thank you…", removed "Submit Inquiry"). Driver calls `done` on the next turn. No `done-gate: cap reached` warning.

If you see the run regress to the prior pattern (multiple `done-gate` rejections, cap-reached warning), open the trace and check the prompt block — likely a wiring issue in Task 6. Common causes: forgetting `prev = { snapshot, url, actionEntry: entry }` in the catch path, or `formatPreviousActionResult` getting called with a stale entry.

- [ ] **Step 4: Verify a no-op turn produces the expected block (optional)**

If the trace contains a step where the click landed but the page didn't change (`observation.summaryTier === 'unchanged'`), the next step's prompt would have read:

```
Previous action: click <target> (<ms>ms; settled in <ms>ms).
URL unchanged. Page unchanged — action produced no visible state change.
```

That prompt content isn't persisted in the result JSON; you can confirm the underlying mechanic by inspecting the `observation` object on the no-op step (settled true, summaryTier "unchanged", urlChanged/snapshotChanged both false).

- [ ] **Step 5: Commit nothing; record the result file path**

If you keep a worklog, note the result-file timestamp and outcome. No commit in this task.

---

## Self-review

Spec coverage check:

| Spec section | Task |
|---|---|
| `fingerprint()` | Task 1 |
| `diffSnapshots()` (added/removed text + refs, changedSections, summaryTier) | Task 2 |
| `observeWithSettle()` (poll, stable, max-budget, never throws) | Task 3 |
| `compactObservation()` (caps, drop heavy fields) | Task 4 |
| `formatPreviousActionResult()` (all tiers, error case, settle-timeout case, wait, navigate) | Task 4 |
| Drop networkidle from `observe()` | Task 5 |
| Wire observeWithSettle into executor + skip on turn 1 / wait | Task 6 (steps 4, 11) |
| "Previous action result" inserted before snapshot in follow-up prompt | Task 6 (step 8) |
| Replace stuck-detection length tolerance with fingerprint predicate | Task 6 (step 6); STUCK_DELTA_TOLERANCE removed in step 2 |
| Compression-baseline reset uses `observation.deltaChars` | Task 6 (step 5) |
| Attach observation to performed history entry; survive non-execute paths | Task 6 (steps 4, 9, 10) |
| Final observation after loop exit without follow-up turn | Task 6 (step 11) |
| Recorder passes `observation` through; settleMs→settleSec | Task 7 |
| Acceptance: gravityforms case behaves correctly | Task 8 |

No placeholder / TBD steps; every step contains the actual code. Function signatures used in later tasks match the names declared in earlier tasks (`observeWithSettle`, `diffSnapshots`, `compactObservation`, `formatPreviousActionResult`).
