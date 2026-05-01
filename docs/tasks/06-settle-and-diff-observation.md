# Task 06: Add Generic Settle And Diff Observation

## Problem

The executor currently observes the page once per turn and only reports a coarse snapshot length delta:

```text
Page grew +NNN chars
Page shrunk -NNN chars
Page unchanged
```

This is too weak for real QA flows. After a click, submit, route transition, configuration change, or search action, the driver needs to know whether the browser actually settled and what changed.

The Gravity Forms failures made this visible, but the issue is generic:

- A submit or next-step click can need a short async render window before the success state appears.
- A booking flow can change content without a URL change.
- A configuration wizard can update selected values while staying on the same route.
- A search/find-information task can reveal results lower on the same page.
- A stale ref can happen because the page already changed successfully, not because the action failed.

The current loop often gives the model a huge page tree again, without a concise answer to the important mechanical question:

```text
What did my previous action do to the browser state?
```

## Browser-Use Research

Browser-use has useful related mechanics, but not the full primitive we need.

Useful patterns:

- It performs light page-readiness checks before building state.
- It tracks pending network requests through `document.readyState` and the Performance API.
- It serializes a filtered DOM instead of a full browser tree.
- It includes page stats such as link count, iframe count, interactive element count, and empty/skeleton hints.
- It marks newly appearing interactive nodes.
- It fingerprints page state for loop-detection nudges.
- It stores action results as structured `ActionResult` objects.

Limitations:

- Its loop detection is a soft nudge, not a QA-grade decision.
- It does not produce a strong per-action diff summary.
- Its judge does not override the agent's self-reported success.
- It still leaves much of the "did that action work?" reasoning to the LLM.

QAgent should borrow the generic mechanics, but make the action-result observability stricter because this is a test runner.

## Goal

Add a generic observation layer that runs after actions and before terminal verification:

```text
settle -> observe -> compare with previous stable state -> summarize change -> feed concise result to the driver/verifier
```

This must stay domain-agnostic. Do not hardcode form submission, Gravity Forms, booking flows, or any specific site.

The runner should deterministically answer:

- Did the page settle?
- Did the URL change?
- Did the normalized page state change?
- Which major sections changed?
- Which visible lines/text appeared or disappeared?
- Which interactive refs appeared or disappeared?
- Did the page look empty, skeleton-like, or still loading?
- Did the last action execute but produce no meaningful change?

The LLM can still judge whether the changed state satisfies the natural-language goal.

## Scope

Add a new helper, likely in a new module such as `src/observe-settle.js`, with an API similar to:

```js
const result = await observeWithSettle(page, {
  previousSnapshot,
  previousUrl,
  timeoutMs: 3000,
  stableWindowMs: 400,
  pollMs: 150,
});
```

Return structured data:

```js
{
  snapshot,
  url,
  settled: true,
  settleMs: 850,
  readyState: "complete",
  pendingRequests: 0,
  urlChanged: false,
  snapshotChanged: true,
  deltaChars: 412,
  fingerprintBefore: "...",
  fingerprintAfter: "...",
  changedSections: [
    { role: "main", ref: "e12", deltaChars: -1200 },
    { role: "generic", ref: "e680", deltaChars: 180 }
  ],
  addedText: [
    "Thank you for your project inquiry!"
  ],
  removedText: [
    "Submit Inquiry"
  ],
  addedRefs: ["e680"],
  removedRefs: ["e379"]
}
```

The exact schema can be smaller for the first implementation, but it should be structured and recorded in history.

## Non-Goals

- Do not hardcode checks such as "form submitted" or "result page reached".
- Do not replace the verifier.
- Do not require every action to change the page.
- Do not make long waits the default; keep all waits bounded.
- Do not dump a huge textual diff into every prompt.
- Do not remove `waitForText` / `waitForUrl` style explicit waits from Task 05; those remain useful when the model knows what evidence to wait for.

## Suggested Implementation

### 1. Normalize snapshots before hashing

Create a stable fingerprint from the aria snapshot:

- Strip or normalize volatile refs when comparing semantic state.
- Collapse whitespace.
- Optionally remove obvious transient attributes or cursor markers.
- Keep a second ref-aware comparison for actionable ref changes.

Use this for:

- page-state hash
- stagnant-page detection
- before/after action comparison

### 2. Settle by repeated observation

After each non-terminal action, repeatedly observe until one of these happens:

- URL and normalized snapshot fingerprint are unchanged for two consecutive samples.
- A max settle timeout is reached.
- The page becomes non-HTML or unobservable.

Use short polling. Initial defaults can be conservative:

```text
pollMs: 150
stableSamples: 2
maxSettleMs: 3000
```

Keep the existing `networkidle` best effort, but do not rely on network idle alone. Many real sites keep network activity alive.

### 3. Compute a compact diff

Use existing section slicing from `src/snapshot-compress.js` as a starting point.

Diff should prioritize:

- URL changed / unchanged.
- Snapshot changed / unchanged.
- Changed top-level sections.
- Added and removed short text lines.
- Added and removed interactive refs.
- Empty page / skeleton-like page indicators.

Only send a concise summary to the model. Store fuller metadata in result JSON for analysis.

Example prompt fragment:

```text
Previous action result:
- click button 'Submit Inquiry' executed in 430ms.
- Browser settled after 900ms.
- URL unchanged.
- Page changed: main section shrunk by 1420 chars.
- Added text: "Thank you for your project inquiry!"
- Removed text: "Submit Inquiry"
```

For no-op actions:

```text
Previous action result:
- click button 'Continue' executed in 380ms.
- Browser settled after 450ms.
- URL unchanged.
- Page unchanged.
- This action appears to have produced no visible state change.
```

### 4. Feed action result before the snapshot

Update `buildFollowUpPrompt` in `src/executor.js` so the model sees the concise action-result summary before the compressed snapshot.

Current pattern:

```text
Current URL
Page grew/shrunk/unchanged
Snapshot
Recent actions
```

Target pattern:

```text
Previous action result
Current URL
Snapshot
Recent actions
```

This helps the model reason from the action outcome instead of re-reading a huge tree from scratch.

### 5. Use settle before terminal verification

When the driver calls `done`, do not immediately verify the current single snapshot.

Instead:

1. Run the same settle/observe pass.
2. Verify against the stable snapshot.
3. If verifier passes, accept `done`.
4. If verifier fails, terminate as `fail` with verifier evidence, unless a later task explicitly adds a constrained recovery mode.

This avoids using the verifier gate as an accidental wait loop.

### 6. Record richer history

Each history entry should include compact action result metadata:

```js
{
  turn,
  action,
  target,
  url,
  ms,
  observation: {
    settled,
    settleMs,
    urlChanged,
    snapshotChanged,
    deltaChars,
    addedText,
    removedText,
    addedRefs,
    removedRefs
  }
}
```

This will make future run analysis much easier and less dependent on manually opening snapshots.

## Interaction With Existing Tasks

- Task 02 exact ref stuck detection should remain, but semantic stagnation should use the new fingerprint/diff metadata.
- Task 03 done gating should be revised after this task. Rejected `done` should not return to the broad loop.
- Task 05 dynamic waits are still useful for explicit evidence waits. This task is the default generic settle/diff layer around all actions.

## Acceptance Criteria

- Every non-terminal action records a structured post-action observation summary.
- The next LLM prompt includes a concise "Previous action result" block before the snapshot.
- The executor can distinguish at least:
  - URL changed.
  - URL unchanged but page changed.
  - URL unchanged and page unchanged.
  - Page failed to settle before timeout.
  - Page became unobservable/non-HTML.
- Repeated no-op actions are detected using normalized page fingerprints, not only `action|ref|url`.
- `done` verification runs after a settle pass.
- No site-specific rules are introduced.
- Result JSON files contain enough observation metadata to analyze whether actions made progress without manually diffing snapshots.

## Example Failure This Should Improve

In `results/2026-05-01T04-38HCC79.json`, the driver repeatedly refilled the same Gravity Forms workflow after `done` was rejected. A generic settle/diff layer should have shown:

```text
click Submit Inquiry executed
URL unchanged
page unchanged or still shows same form controls
same submit attempt produced no visible state transition
```

Then a later `done` rejection should end the todo as failed with evidence, not invite another full reload/refill cycle.

In `results/2026-05-01T04-40H8E5B.json`, a stale ref happened after the form had already been replaced by the thank-you message. A settle/diff layer should make that clear:

```text
ref miss occurred because previous page state changed
added text: "Thank you for your project inquiry!"
removed ref: old Submit Inquiry button
```

That lets the verifier judge the actual stable state instead of treating the stale-ref error as proof of failure.
