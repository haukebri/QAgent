# Task 28: Lean Outcome Verifier Benchmark

> **Target release:** v0.11.0
> **Depends on:** Tasks 25-27
> **Replaces:** Task 21's claim-oriented release gates

## Problem

The eight-case claim/evidence replay reported perfect verifier accuracy but did
not predict the live calculator result, where only four of fifteen completed
journeys passed. The benchmark measures removed internals and is too small in
the wrong dimensions.

## Goal

Keep one small, real-artifact benchmark that measures only whether QAgent's
final pass, fail, or verifier error agrees with human judgment.

## Scope

- Reuse the existing replay command with the single-call verifier.
- Freeze six real artifacts containing only goal, compact action history, final
  URL/snapshot, and expected outcome:
  1. completed calculator with the expected result;
  2. calculator stuck before submission;
  3. completed Vorwerk cart without a blocking cookie dialog;
  4. wrong product or substituted route;
  5. transient confirmation flow recorded in history;
  6. unsubmitted form with insufficient evidence.
- Report correct pass, correct fail, false pass, false fail, and verifier error.
- Remove decomposition, evidence-coverage, unknown-accuracy, citation, and claim
  metrics.
- Keep browser completion separate from verifier accuracy in live reports.
- Use three live release journeys: Reply, Vorwerk, and one representative
  calculator scenario, repeated three times.
- Do not include AIDA until new-page or popup adoption is supported behavior.

## Release Gate

- Zero false passes, false fails, and verifier errors on the six frozen cases.
- Live reporting clearly separates browser completion from final-verdict
  agreement.
- Model cost and verifier call count are reported without claim-level metrics.

## Non-Goals

- No benchmark taxonomy for removed verifier internals.
- No large synthetic corpus.
- No screenshot vision or pixel comparison.
- No claim that a small frozen replay replaces live cross-application runs.

## Acceptance Criteria

- `npm run benchmark:verifier` executes the six outcome-labeled fixtures.
- The report contains only outcome confusion counts, verifier errors, tokens,
  cost, and latency.
- One fixture guards against a false pass and one guards against a false fail.
- One fixture proves that transient history can matter without becoming a
  per-step assertion system.
- Release documentation reports browser and verifier results separately.

## Changelog

When implemented, add this note under `v0.11.0` in `CHANGELOG.md`:

> The verifier benchmark now replays real browser outcomes and reports final
> verdict agreement instead of claim-pipeline internals.
