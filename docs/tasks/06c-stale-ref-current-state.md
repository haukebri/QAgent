# Task 06c: Stale-Ref Current-State Observation

Source analysis: `docs/analysis/task-06-mvp-gaps.md` (gap #5).
Builds on: Task 06 MVP.

## Problem

When the driver picks a ref that isn't in the current snapshot, the executor rejects the action before running any browser tool and pushes an error entry with no `observation`. The next prompt only tells the driver `ref X is not present in the current snapshot`. The driver re-snapshots and tries to figure out from scratch what happened.

Often the ref is missing because the page progressed successfully (e.g. Submit button gone after submit, modal closed, list re-sorted). The MVP's observation system already has the data to say so — it's just not surfaced on the ref-miss path.

## Goal

On stale-ref rejection, attach a current-state observation that compares the post-action page (where the ref is missing) to the snapshot the driver was looking at when it picked the ref. Surface the diff in the next prompt.

## Scope

In `src/executor.js`, the ref-miss branch:

```js
if (!snapshot.includes(`[ref=${action.ref}]`)) {
  lastError = `ref ${action.ref} is not present in the current snapshot; pick a ref from the latest snapshot above`;
  ...continue;
}
```

Add: compute `diffSnapshots(prev.snapshot, snapshot, prev.url, url)` against whatever the driver's last seen baseline was (`prev.snapshot` is "after the most recent performed action"; the snapshot the driver saw at action-pick time *is* the current `snapshot` var, so we compare against `prev.snapshot`). If the diff shows meaningful change (`urlChanged || snapshotChanged && (addedText.length || removedText.length)`), enrich the message:

```
ref e379 is no longer present because the page progressed since your last action:
URL unchanged. Page changed (-1420 chars).
Removed: "Submit Inquiry"
Added: "Thank you for your project inquiry!"
Re-pick a ref from the latest snapshot.
```

If the diff shows no meaningful change, keep the current message — the model genuinely picked a non-existent ref.

Attach the diff observation to the ref-miss entry's `observation` field for trace analysis.

## Non-Goals

- No retry of the action with a different ref.
- No fuzzy ref matching.
- No history guard changes (Task 06a covers the related done-gate logic).

## Acceptance Criteria

- A ref-miss caused by page progression produces a prompt block that explains the progression, not just the error.
- A ref-miss on a genuinely invented ref still produces the existing terse message.
- The ref-miss entry in result JSON has an `observation` field reflecting the page diff at the point of rejection.

## Example

Pre-Task-06c, hypothetical gravityforms trace:
```
T15 click ref e379  ERROR: ref e379 is not present in the current snapshot
T16 (model re-picks blindly)
```

Post-Task-06c:
```
T15 click ref e379  ERROR: ref e379 is no longer present because the page progressed:
                          Page changed (-1420 chars). Removed: "Submit Inquiry".
                          Added: "Thank you for your project inquiry!"
T16 done            (model can now correctly conclude the goal is met)
```
