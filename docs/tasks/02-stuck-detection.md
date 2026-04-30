# Task 02: Add Stuck Detection for Repeated No-Progress Actions

## Problem

Several failing runs spent many turns repeating the same action against the same page state:

- Landefeld clicked `Accept all` 98 times while an iframe overlay kept blocking it.
- Devstral clicked AIDA `Ändern` 29 times and alternated with `Speichern` until the 100-turn cap.
- GPT models repeatedly clicked sidebar or search refs without URL or snapshot progress.

The executor currently reports each failed or no-op action back to the driver, but it does not detect that the run is stuck.

## Goal

Add executor-level stuck detection that identifies repeated actions with no meaningful progress and forces a strategy change before the run burns the turn/cost budget.

## Scope

Track recent action outcomes in `src/executor.js` using:

- Canonical action name.
- Ref, if present.
- Current URL.
- Action error, if present.
- Snapshot delta or a simple snapshot hash.
- Whether the URL changed after the action.

Detect patterns such as:

- Same `action + ref + url` repeated 3 times with no URL change and little/no snapshot change.
- Same action returning the same error 2-3 times.
- Same ref clicked repeatedly after the page reports `Page unchanged`.

When detected, set `lastError` to a strong instruction such as:

```text
Stuck: you repeated click e184 three times with no URL or page-state change. Do not click that ref again. Choose a different control, wait for a specific state, navigate directly if valid, or fail with evidence.
```

If the model repeats the same blocked action again after that warning, end the run early with a `fail` verdict instead of waiting for the max-turn cap.

## Non-Goals

- Do not make stuck detection site-specific.
- Do not change Playwright action semantics.
- Do not classify every unchanged page as stuck; normal form filling can leave the URL unchanged.
- Do not prevent intentional repeated typing, tabbing, or date-picker navigation unless the page state is clearly not changing.

## Suggested Implementation

Add a small progress tracker in `runTodo`.

One possible shape:

```js
const progressState = {
  repeatedNoProgressCount: 0,
  lastSignature: null,
  warnedSignature: null,
};
```

Build a signature after each action:

```js
{
  action: action.action,
  ref: action.ref ?? null,
  urlBefore,
  urlAfter,
  error: entry.error ?? null,
  snapshotDeltaBucket,
}
```

On the next turn, compare the new signature with the previous one. Use a small threshold so benign cases can recover, but obvious loops stop quickly.

## Acceptance Criteria

- A run that clicks the same ref 3 times with the same URL and no snapshot change receives a clear stuck warning.
- A run that repeats the same blocked-click error after a stuck warning terminates early as `fail`.
- The stuck message explicitly tells the model not to click that ref again.
- Normal successful multi-step flows are not interrupted just because the URL stays the same.
- The Landefeld-style `Accept all` loop would stop before 10 turns instead of reaching 100.
- The Devstral AIDA edit/save loop would stop before the max-turn cap.

## Example Failure This Prevents

`results/2026-04-29T10-00HE7AA.json` clicked Landefeld `Accept all` 98 times. Every click reported:

```text
click blocked by overlay: iframe#I0_1777456322093
```

The executor had enough evidence by the third repeated error to force a new strategy or terminate cleanly.
