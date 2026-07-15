# Task 15: Single Authoritative Terminal Verifier

> **Target release:** v0.9.0
> **Depends on:** Task 09

## Problem

The executor currently makes an additional driver-model call to decide whether
a `done` summary is contradicted by compact observation data before the separate
verifier runs. This creates two LLM judgment layers at the terminal boundary,
adds cost, and can turn a premature `done` into an executor failure even though
the verifier is already responsible for judging the frozen trajectory and final
state.

Once Task 09 requires complete evidence for a pass, this extra judgment no
longer protects against an unproven success: the authoritative verifier will
fail it.

## Goal

Restore one clear terminal boundary: the executor settles and freezes evidence;
the verifier alone decides the final outcome.

## Scope

- Keep deterministic terminal settling and deterministic runtime/history safety
  checks.
- Remove the executor's LLM-based done-summary contradiction call and its prompt.
- When the driver emits `done`, freeze the settled final snapshot and trajectory,
  then invoke the normal verifier.
- Keep the driver's summary as non-authoritative evidence in the trace.
- Preserve any deterministic guard that prevents data loss, invalid execution,
  or verification against a known stale snapshot.
- Update token/cost expectations and documentation.

## Why This Fits QAgent

The core design assigns action selection to the driver and outcome judgment to a
separate verifier. Removing a second terminal judge makes that boundary explicit
and reduces cost and disagreement paths.

## Non-Goals

- No removal of terminal settle.
- No rule that automatically accepts a driver `done`.
- No rule that automatically preserves a driver `fail`.
- No weakening of Task 09's proof-complete pass policy.
- No verifier-in-the-loop polling or retry planner.

## Acceptance Criteria

- Exactly one LLM component determines the final pass/fail outcome: the
  verifier.
- A premature driver `done` with an unverified required claim fails in the
  verifier.
- A driver `done` contradicted by concrete final evidence fails in the verifier.
- A mistaken driver `fail` may pass only when every required claim is verified
  `yes`.
- Terminal settle metadata and the driver summary remain available in traces.
- Driver token/cost totals no longer include a done-contradiction judgment call.

## Changelog

When implemented, add this short note under `v0.9.0` in `CHANGELOG.md`:

> Final outcomes are now decided by the independent verifier after deterministic
> terminal settling; the duplicate executor-side LLM contradiction check has
> been removed.
