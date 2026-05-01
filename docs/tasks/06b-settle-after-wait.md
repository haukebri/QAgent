# Task 06b: Settle After Explicit Wait

Source analysis: `docs/analysis/task-06-mvp-gaps.md` (gap #3).
Builds on: Task 06 MVP, Task 06a (extended settle).

## Problem

The MVP treats `wait` specially: it sleeps for the requested duration, then takes a single observation with `settleMs: 0`. If the page is still mutating at the end of the sleep window, the recorded observation captures a transient state and the next prompt asks the model to act on that.

The driver's intent when calling `wait` is "give the page time to finish doing something." The MVP only honors the *minimum* of that — never the full intent.

## Goal

After a `wait`, treat the requested duration as the minimum delay, then run the same settle predicate (short or extended depending on what 06a wires up) until the page is stable.

## Scope

In `src/executor.js`'s top-of-loop branch where `prev.action.action === 'wait'`:

```text
sleep(prev.action.ms)               # already done by the wait tool
snapshot = await observe(page)      # current behavior
url = page.url()
observation = { settled: true, settleMs: 0, ...diffSnapshots(...) }   # current
```

Replace with:

```text
const settle = await observeWithSettle(page, { previousSnapshot, previousUrl })
snapshot = settle.snapshot
url = settle.url
observation = settle
```

(The wait was already performed when the action ran; we just settle from there.)

## Non-Goals

- No change to the `wait` action itself (driver still chooses the duration).
- No replacement of the bounded settle defaults from 06a / Task 06 MVP.

## Acceptance Criteria

- After a `wait`, the resulting observation has a non-zero `settleMs` when the page was still mutating; zero (or near-zero) on a quiet page.
- Quiet-page behavior is unchanged in user-visible terms.
- Compact observation shape is unchanged.

## Notes

This is small, but it removes an asymmetry: every action class now runs the same settle. Easier to reason about in traces ("if `settleMs` is large, the page was busy regardless of action type").
