# Task 10: Meaningful Post-Action Settle

> **Target release:** v0.9.0

## Problem

Ordinary post-action settling accepts two identical accessibility snapshots as
stable after roughly one polling interval. A page can remain briefly unchanged
before an SPA transition begins, so the next driver turn may receive the old
question and stale refs. Terminal settling already has a meaningful-departure
concept, while explicit `wait` actions bypass settling and take a one-shot
snapshot.

## Goal

Give every mutating action a bounded, generic observation result that clearly
means either:

- the page departed from the pre-action state and then stabilized; or
- no observable change occurred during the allowed grace period; or
- the page did not settle before the timeout.

## Scope

- Extend the existing settle implementation rather than adding another polling
  subsystem.
- Do not accept unchanged samples immediately after a mutating action. Allow a
  bounded grace period for delayed transitions to begin.
- Once a meaningful URL, accessible text, state, or structural departure is
  observed, require the normal stable-sample window.
- Return an explicit settle reason such as `changed`, `no-change`, or `timeout`
  in internal/recorded observation data.
- After an explicit driver `wait`, treat its requested duration as the minimum
  delay and then run the same settle loop.
- Keep total action and wall-clock budgets bounded.

## Why This Fits QAgent

Settling belongs to the executor's Observe -> Decide -> Act boundary. It should
describe browser behavior generically, not infer intent from application button
labels.

## Non-Goals

- No special list of Continue, Next, Save, Submit, or Calculate labels.
- No site-specific delay configuration.
- No requirement that every selection visibly changes the accessibility tree.
- No unbounded network-idle wait.

## Acceptance Criteria

- A fixture that stays unchanged for 500-1000ms before replacing its heading
  supplies the new state before the next driver decision.
- A synchronous radio/checkbox selection completes without waiting for the full
  settle timeout when its checked state is exposed.
- A genuinely unchanged action returns bounded `no-change` evidence.
- A continuously mutating page returns `timeout` without hanging.
- An explicit `wait` is followed by settle sampling rather than a one-shot
  observation.
- Tests do not match application-specific control text.

## Changelog

When implemented, add this short note under `v0.9.0` in `CHANGELOG.md`:

> Post-action observation now waits for delayed page changes to begin and then
> stabilize, while explicitly distinguishing changed, unchanged, and timed-out
> states; explicit wait actions use the same settle path.
