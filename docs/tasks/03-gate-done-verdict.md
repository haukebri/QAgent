# Task 03: Gate Driver `done` Before Ending a Run

## Problem

Some failed runs ended because the driver called `done` even though the final page state clearly did not satisfy the goal.

Examples:

- AIDA: driver claimed insurance was reached while still on `/kabine`.
- Ryanair: driver claimed results were available while the snapshot still showed the search form or a disabled Search button.
- Gravity Forms: driver claimed submission succeeded while validation errors were still visible.

The verifier catches these as failures, but by then the executor has already stopped. The driver gets no chance to recover from an overconfident `done`.

## Goal

Before accepting `done`, run cheap deterministic checks against the current URL, final snapshot, and recent history. If the checks find obvious contradiction, reject `done` and feed a targeted correction back to the driver.

## Scope

Add a `validateDoneCandidate` helper in `src/executor.js`.

The helper should inspect:

- Driver `done.summary`.
- Current URL.
- Current snapshot.
- Goal text.
- Recent actions/errors.

Reject `done` when obvious blockers are present:

- Visible validation errors: `required`, `field is required`, `There was a problem with your submission`, `Bitte füllen Sie`.
- Disabled submit/search/continue controls relevant to the goal.
- Loading or transitional states.
- Goal asks for results/prices/options, but snapshot still only shows the input form.
- Goal asks for a specific step/page, but URL or heading is still on an earlier step.
- Recent actions show repeated errors or no meaningful progress.

On rejection, set `lastError` to a message such as:

```text
Cannot accept done: the snapshot still shows "There was a problem with your submission" and "Services Needed: This field is required". Continue fixing the form or fail with evidence.
```

Then continue the loop instead of ending.

## Non-Goals

- Do not replace the verifier.
- Do not make final pass/fail decisions with regexes.
- Do not require the deterministic gate to understand every possible goal.
- Do not block `done` when there is no obvious contradiction.

## Suggested Implementation

In `runTodo`, before this branch accepts terminal actions:

```js
if (action.action === 'done' || action.action === 'fail') {
```

Add a special case for `done`:

```js
if (action.action === 'done') {
  const doneProblem = validateDoneCandidate({ goal, url, snapshot, action, history, lastError });
  if (doneProblem) {
    lastError = doneProblem;
    history.push({ turn: turns, atMs: Date.now() - t0, action, url, error: doneProblem });
    onTurn?.(history.at(-1));
    continue;
  }
}
```

Keep `fail` terminal. If the driver can clearly explain why the goal cannot be completed, it should still be allowed to stop.

## Acceptance Criteria

- `done` is rejected when the snapshot contains visible validation errors.
- `done` is rejected when the goal asks for results/prices but only a search/input form is visible.
- `done` is rejected when the goal asks for a later AIDA step but the URL/heading is still on an earlier step.
- Rejected `done` actions are recorded in history with an explanatory error.
- Valid `done` actions still end the run normally.
- The verifier remains the final source of truth for pass/fail.

## Example Failure This Prevents

`results/2026-04-30T07-33HED79.json` ended with:

```text
The project inquiry form submitted...
```

But the final snapshot still contained:

```text
There was a problem with your submission
Services Needed: This field is required
```

The executor should reject that `done` and require the driver to resolve the validation error or fail explicitly.
