# Settle And Diff Observation (MVP) — Design

Source task: `docs/tasks/06-settle-and-diff-observation.md`.
Related: task 02 (stuck detection), task 03 (done gate, currently history-guard only), task 05 (dynamic waits).

## Problem

After every action the executor takes one snapshot and tells the model only `Page grew/shrunk/unchanged ±NNN chars`. That signal is too weak for the question the driver actually has to answer next: **what did my last action do to the browser?**

Two failure shapes seen in `results/`:

- **Stale ref after success.** `2026-05-01T06-30HA157.json` turn 15: `click button 'Submit Inquiry'` returns `locator.click: Timeout 2000ms exceeded`. The form had already submitted and been replaced by the success message; the click target was gone. The current loop tells the driver only that the click errored — not that the success state is now visible — so the model loops on `done` until the cap-bypass accepts it.
- **Action with no visible effect.** Repeated re-fills and re-submits because the model can't tell a no-op apart from incidental whitespace drift.

The current loop also waits up to 2s for `networkidle` per `observe()`. Real SPA pages with analytics/polling never reach networkidle; this wait usually times out without giving us a stability guarantee.

## Goal

After each non-terminal action, deterministically answer:

- Did the page settle?
- Did the URL change?
- Did the normalized snapshot change?
- Which accessible names appeared / disappeared?
- Which interactive refs appeared / disappeared?

Surface a concise summary as a "Previous action result" block to the driver before the snapshot, persist the structured form in step history and the result JSON, and unify all "did the page change" decisions on one fingerprint.

This is the MVP cut from the full task. Pass 2 (out of scope here) will revisit done-gating, empty/skeleton hints, and pending-request tracking once we have traces from this layer.

## Scope

### Files touched
- **New:** `src/observe-settle.js` — `observeWithSettle()`, `fingerprint()`, `diffSnapshots()`.
- `src/tools.js` — drop the 2s `networkidle` wait inside `observe()`; it becomes a thin one-shot `ariaSnapshot` call.
- `src/executor.js` — call `observeWithSettle` in place of the current observe + snapshotDelta block; wire result into `buildFollowUpPrompt`; replace stuck-detection's `snapshotDelta` heuristic with the fingerprint signal; record `observation` per history entry.
- `src/recorder.js` — pass through the new per-step `observation` object.

### Out of scope for this pass
- Settle-before-done verification. Task 03 was reverted; we re-evaluate it after seeing diff data.
- Empty / skeleton page hints.
- Pending-request tracking via `document.readyState` / Performance API.
- Any change to the verifier or to the `fail` action.
- Any site-specific heuristics.

## API

### `observeWithSettle(page, prev, opts?)`

```js
const result = await observeWithSettle(page, {
  previousSnapshot,   // string | null  - last stable snapshot we saw
  previousUrl,        // string | null
}, {
  pollMs: 150,
  stableSamples: 2,
  maxSettleMs: 3000,
});
```

Returns:

```js
{
  snapshot,            // raw ariaSnapshot YAML
  url,                 // page.url()
  settled,             // bool: stableSamples consecutive samples matched within maxSettleMs
  settleMs,            // wall time spent in the settle loop
  fingerprintBefore,   // sha1 string, null if previousSnapshot null
  fingerprintAfter,    // sha1 string
  urlChanged,          // bool
  snapshotChanged,     // bool: fingerprintBefore !== fingerprintAfter
  deltaChars,          // int: snapshot.length - previousSnapshot.length (0 if previous null)
  changedSections,     // [{ role, ref, deltaChars }] from sliceSections sha1 diff
  addedText,           // string[] - accessible names present after, not before
  removedText,         // string[] - present before, not after
  addedRefs,           // string[] - eN tokens present after, not before
  removedRefs,         // string[] - present before, not after
  summaryTier,         // "unchanged" | "small" | "large"
}
```

### `fingerprint(snapshot)`

```js
sha1(snapshot.replace(/\[ref=e\d+\]/g, '').replace(/\s+/g, ' ').trim())
```

Strips refs (Playwright re-numbers them deterministically; identical DOM produces identical numbers, but stripping makes the predicate robust to incidental renumbering caused by unrelated DOM tweaks). Collapses all whitespace runs. Keeps state attributes like `[expanded]`, `[selected]`, `[checked]` so flips count as change — per the user's constraint, *a flipped switch or a mini error string IS the difference an action made*.

### `diffSnapshots(prev, next)`

Pure function over two snapshot strings. Used by `observeWithSettle` after settle resolves; exported separately so the executor (and tests) can reuse it.

- `addedText` / `removedText`: extract every quoted accessible name (`/^\s*-\s*\w+\s+"([^"]+)"/m` over each line) into two sets, take set difference both ways. Set semantics handle trivial reorderings.
- `addedRefs` / `removedRefs`: extract every `[ref=eN]` token, set difference.
- `changedSections`: run `sliceSections` (from `src/snapshot-compress.js`) on both, match by `ref`, keep entries whose `sha1` differs. `deltaChars` per section = `next.text.length - prev.text.length`.
- `summaryTier`:
  - `"unchanged"` if `!urlChanged && !snapshotChanged`.
  - `"large"` if `addedText.length > 8 || removedText.length > 8 || changedSections.length / sliceSections(next).length > 0.5`.
  - `"small"` otherwise.

## Settle loop

```text
t0 = now()
last = await observe(page); lastUrl = page.url()
matchStreak = 1                                    # the first sample counts as one
loop:
  if matchStreak >= stableSamples: break (settled = true)
  if now() - t0 >= maxSettleMs:    break (settled = false)
  await sleep(pollMs)
  cur = await observe(page); curUrl = page.url()
  if curUrl === lastUrl && fingerprint(cur) === fingerprint(last):
    matchStreak += 1
  else:
    matchStreak = 1
    last = cur; lastUrl = curUrl
return { settled, snapshot: last, url: lastUrl, settleMs: now() - t0 }
```

Default `stableSamples: 2` means: first sample, sleep, second sample, if both match → return. Page-becomes-non-HTML or `observe()` throws → bail out, return whatever sample we last got, mark `settled: false`. The loop never throws.

The diff is computed **once at the end**, against `previousSnapshot` (the prior stable snapshot the executor passed in), not against the intermediate samples. Intermediate samples exist only to detect stability.

### When the loop runs (per action type)

| Action just performed | Top of next turn calls |
|---|---|
| `navigate` | `observeWithSettle` (uniform; `goto` blocks on `load`, settle handles post-load hydration we used to wait for via networkidle) |
| `click`, `fill`, `selectOption`, `pressKey`, `type` | `observeWithSettle` |
| `wait` | one `observe()` + `diffSnapshots(prev, next)` (driver chose the duration) |
| (no prior action — turn 1) | one `observe()`, no diff, no block |
| `done`, `fail` | terminal — verifier path; no settle in this MVP |

Concretely the executor loop changes from:

```
turn N:
  snapshot = observe(page)
  ... build prompt with snapshotDelta hint ...
  perform action
```

to:

```
turn N:
  if turn === 1:
    snapshot = observe(page); url = page.url()
    observation = null   # no Previous-action block
  elif prev.action.action === 'wait':
    snapshot = observe(page); url = page.url()
    observation = diffSnapshots(prev.snapshot, snapshot) merged with
                  { settled: true, settleMs: 0, urlChanged: url !== prev.url }
  else:
    { snapshot, url, settled, settleMs } = observeWithSettle(page, prev)
    observation = diffSnapshots(prev.snapshot, snapshot) merged with the settle fields
  ... build prompt with the Previous-action block (or skip on turn 1) ...
  perform action
  prev = { snapshot, url, action, target }     # used by next turn
```

## Prompt format — "Previous action result" block

Inserted in `buildFollowUpPrompt` before the URL/snapshot. **Turn 1 emits no block** (no previous action exists; current `buildInitialPrompt` is unchanged).

### Action succeeded

**Tier `unchanged`:**
```
Previous action: click button 'Continue' (380ms; settled in 450ms).
URL unchanged. Page unchanged — action produced no visible state change.
```

**Tier `small`** (lists capped at 5 each, each entry truncated to 80 chars):
```
Previous action: click button 'Submit Inquiry' (430ms; settled in 900ms).
URL unchanged. Page changed (-1420 chars, 1 section).
Added: "Thank you for your project inquiry!"
Removed: "Submit Inquiry"
```

**Tier `large`:**
```
Previous action: click button 'Search' (200ms; settled in 1200ms).
URL changed → /trip/flights/select. Page largely replaced.
New heading: "Select your flight"
+34 refs, -47 refs across 5 sections.
```
*New heading*: first line in `addedText` whose source line matches `^\s*-\s*heading\s+"([^"]+)"`. Falls back to the first item of `addedText`. Falls back to `(no new heading)` if `addedText` is empty.

### Action failed but page changed (the gravityforms stale-ref case)

```
Previous action: click button 'Submit Inquiry' — ERROR: locator.click: Timeout 2000ms exceeded.
But the page did change while the action was running:
URL unchanged. Page changed (-1420 chars, 1 section).
Added: "Thank you for your project inquiry!"
Removed: "Submit Inquiry"
```
This makes the diff layer actually fix the gravityforms regression — the LLM sees both the click failure AND the success state, and can `done` correctly.

### Settle never reached stable

```
Previous action: click button 'Submit' (200ms; did NOT settle within 3000ms — page still mutating).
URL unchanged. Page changed (+800 chars).
Added: "Loading…"
```

### Navigate

```
Previous action: navigate https://… (820ms; settled in 1100ms).
URL → /home. New heading: "Welcome".
```

### Wait (no settle)

```
Previous action: wait 2000ms.
URL unchanged. Page unchanged.
```
(Single observe, no settle stats line.)

## Stuck detection — replace the length heuristic

Today (`executor.js:140-164`):
```js
const noProgress =
  pendingRefAction.urlBefore === pendingRefAction.urlAfter &&
  Math.abs(snapshotDelta) < STUCK_DELTA_TOLERANCE; // 200
```

Replace with:
```js
const noProgress = !observation.urlChanged && !observation.snapshotChanged;
```

Delete `STUCK_DELTA_TOLERANCE`, `prevSnapshotLen`, and the `snapshotDelta` calculation. Same warning text, same window/threshold (5/3), same two-stage escalation — only the no-progress predicate changes. The fingerprint is what the length tolerance was approximating; one definition of "did the page change" across the system removes a footgun.

Behavior change at the margin: a `[expanded=true]` flip on a dropdown now counts as progress (previously it did, but only if it crossed the 200-char threshold). That is the right answer.

## Compression baseline reset interaction

`executor.js:119-138` resets the compression baseline when `lastError && snapshotDelta > 500`. We replace `snapshotDelta` with `observation.deltaChars` here. The other reset triggers (URL change, compression ratio > 0.6, age ≥ 6 turns) are unchanged.

## History entry shape

Each REF_ACTION / navigate / wait history entry gains an `observation` object:

```js
{
  turn,
  atMs,
  action,
  target?,
  url,
  ms,
  recoveredVia?,
  error?,
  observation: {
    settled, settleMs,
    urlChanged, snapshotChanged, deltaChars,
    summaryTier,
    addedText, removedText,        // capped server-side too: max 20 items each
    addedRefs, removedRefs,        // max 50 each
    changedSectionsCount,          // int (full list isn't useful in JSON)
  },
}
```

Caps prevent any single step's observation from inflating the result file. Wait turns get `observation` populated from the single observe + diff (`settled: true`, `settleMs: 0`, real `urlChanged` / `snapshotChanged` from the fingerprint compare).

**Where it gets attached.** Step N's action runs at the end of turn N; the observation that describes its effect is computed at the *start* of turn N+1 (after settle). The executor attaches it back onto step N's entry (kept by reference for one turn). This way `history[i].observation` always describes what `history[i].action` did.

**Loop exits without a follow-up turn** (turn cap, wall-clock timeout, fatal error, stuck-stage-2 termination): if a non-terminal step is left in `prev` without an observation attached, run one final `observeWithSettle` (or single observe for prior-was-wait) before returning, and attach. Terminal steps (`done`/`fail`) carry no `observation` themselves; the verifier still runs against the post-action snapshot as today.

`recorder.js` passes `observation` through unchanged (alongside its existing `atSec`/`durationSec` rewrites).

## Changes to `observe()`

```js
// before
export async function observe(page) {
  try { await page.waitForLoadState('networkidle', { timeout: 2000 }); } catch {}
  return await page.locator('body').ariaSnapshot({ mode: 'ai' });
}

// after
export async function observe(page) {
  return await page.locator('body').ariaSnapshot({ mode: 'ai' });
}
```

`observeWithSettle` subsumes the stability wait. Calling `observe()` from places other than the executor loop (none today besides `src/observe.js` debug script) still works — they just get one immediate snapshot without the network wait, which matches what they actually wanted anyway.

## Acceptance

Maps to the MVP subset of task 06's acceptance criteria:

- Every non-terminal action records an `observation` summary in history and in the result JSON.
- The next LLM prompt for non-terminal turns includes a "Previous action result" block before the snapshot. Turn 1 is unchanged.
- The executor distinguishes URL-changed / URL-unchanged-page-changed / both-unchanged / settle-timeout via the structured fields.
- Stuck detection is driven by `!urlChanged && !snapshotChanged`, not by a length tolerance.
- The gravityforms run pattern (`2026-05-01T06-30HA157.json`): the post-`Submit Inquiry` turn now surfaces the success message in the prompt block even though the click errored. Driver can call `done` from real evidence on the next turn instead of via cap-bypass.
- Result JSON contains enough observation metadata to analyze whether actions made progress without re-opening snapshots.
- No site-specific rules introduced.

## Risks & open questions

- **Settle wall cost on quiet pages.** One extra `observe()` per action (~50–150ms). Acceptable given current per-turn LLM latency dominates.
- **Settle never reaches stable on chatty pages.** Bounded at `maxSettleMs: 3000`. Output marks `settled: false` and the LLM still gets the diff against whatever final sample we captured. Future tuning lives in pass 2.
- **`addedText` / `removedText` quote extraction misses pure text nodes** that aren't part of an aria role with a name. The user accepted this for the MVP; the tier-3 ("page largely replaced") branch with `New heading: …` covers most "the page totally changed" cases. If we miss real signal in pass-1 traces, layer in a second pass over visible text in pass 2.
- **`changedSections` matched by ref.** When refs renumber wholesale (page-replaced), nearly every section reads as added/removed rather than changed — which is exactly what tier-3 is for, so the prompt still says the right thing. The structured count just inflates; that's fine for analysis.

## Non-goals (recap)

- No replacement of the verifier. End-of-run verifier remains source of truth for pass/fail.
- No change to the done-gate (still the history guard from task 03).
- No requirement that every action change the page.
- No long waits as a default. All waits remain bounded.
- No site-specific text or selector heuristics.
