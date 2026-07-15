# Task 14: Cross-Application Behavioral Release Benchmark

> **Target release:** v0.9.0
> **Depends on:** Tasks 08-13 for the v0.9.0 baseline

## Problem

Unit tests cover helpers, but they did not catch interactions between snapshot
presentation, settling, model decisions, and verifier aggregation. External
site benchmarks provide realism but are not deterministic enough to be the only
release signal. A calculator-only benchmark would push QAgent toward one site's
markup and workflow.

## Goal

Add a small behavioral benchmark that measures QAgent's generic end-to-end
contracts across different UI patterns and makes false passes visible before a
release.

## Scope

- Add three small local fixtures or fixture applications:
  1. a delayed multi-step wizard;
  2. a grouped form with repeated option labels and accessible state;
  3. a navigation flow with permitted and forbidden recovery cases.
- Run real driver and verifier loops with the recommended model separately from
  deterministic unit tests.
- Report at least:
  - goal completion rate;
  - false-pass count;
  - technical/execution termination count as a benchmark metric, not a new API
    taxonomy;
  - median turns, elapsed time, and cost.
- Keep the existing external-site script as a smoke benchmark, not a merge gate.
- Re-run the 20 calculator scenarios as a post-change regression dataset, but do
  not copy calculator behavior into local fixtures.
- Document the command and the v0.9.0 baseline results.

## Why This Fits QAgent

QAgent is model-driven, so helper tests alone cannot establish behavioral
reliability. A small multi-pattern benchmark protects the general
Observe -> Decide -> Act -> Verify architecture without becoming a regression
suite for customer applications.

## Non-Goals

- No claim that QAgent itself is a deterministic CI regression framework.
- No calculator-specific merge gate.
- No public `technical | business` failure classification.
- No large benchmark service or dashboard.

## Acceptance Criteria

- One documented command runs the three behavioral scenarios repeatedly.
- v0.9.0 has zero false passes in the local benchmark.
- Delayed transitions, grouped-field evidence, proof-complete verification, and
  constrained recovery are each exercised by at least one scenario.
- Results report completion and verdict correctness separately.
- The same 20 calculator goals are rerun and compared with the July 13 baseline:
  2 genuine completions, 3 false passes, and 15 reported failures.
- External network failures do not fail the deterministic local benchmark.

## Changelog

When implemented, add this short note under `v0.9.0` in `CHANGELOG.md`:

> The release benchmark now covers delayed wizards, accessible grouped forms,
> and constrained navigation recovery, with false-pass, completion, turn, time,
> and cost reporting kept separate from external-site smoke runs.
