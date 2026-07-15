# Task 21: Frozen Verifier Accuracy Benchmark

> **Target release:** v0.10.0
> **Builds on:** Task 14

## Problem

The calculator verifier comparisons reran the driver as well as the verifier.
Different browser trajectories therefore made raw pass rates an unreliable
measure of verifier quality. A model can also produce more passing results by
becoming less strict, which is not an accuracy improvement.

## Goal

Measure verifier accuracy against the same frozen goals and browser evidence
before and after Tasks 22-24.

## Scope

- Add a small replayable corpus derived from the July 15 calculator runs.
- Cover the observed failure classes: acceptance-scope expansion, altered or
  invented claims, separate form groups treated as overwrites, visible controls
  treated as clicks, conditional-polarity errors, exact-copy checks, missing
  transient text, and insufficient evidence.
- Label both what happened in the browser and what the supplied evidence can
  prove. These are different when evidence capture is incomplete.
- Replay identical inputs through a selected verifier without launching a
  browser or driver.
- Report decomposition errors, false passes, false failures, correct unknowns,
  evidence coverage, verifier errors, tokens, cost, and latency separately.
- Keep driver completion as a separate live-benchmark metric.
- Extend the existing behavioral benchmark conventions instead of adding a
  service, dashboard, or benchmark framework.

## Why This Fits QAgent

QAgent needs trustworthy verdicts, not a higher pass count. Frozen replay makes
verifier changes comparable while the existing live benchmark continues to
measure end-to-end reliability.

## Non-Goals

- No calculator-specific production behavior.
- No requirement to copy all screenshots or all 20 raw runs into the repository.
- No pass-rate target without a human-adjudicated expected verdict.
- No hosted benchmark service, model leaderboard, or merge-time network call.
- No replacement for the cross-application behavioral benchmark.

## Acceptance Criteria

- One documented command replays the same evidence through any configured
  verifier model without running the driver.
- The corpus includes at least one case for every failure class listed in Scope.
- Expected labels distinguish actual browser truth from evidence available to
  the verifier.
- Results report false passes and false failures separately from technical or
  verifier-protocol errors.
- Baseline results are recorded for the current verifier before Task 22 changes
  its input contract.
- Tasks 22-24 add or update a replay case for every fixed regression.

## Release Gates for Tasks 22-24

- Zero invented or altered binding claims.
- Zero successful-click claims without a successful cited action.
- Separate form groups are never interpreted as overwrites.
- Explicit exact-copy mismatches fail consistently.
- Known conditional-polarity cases receive the expected verdict.
- Evidence references always point to real recorded evidence.
- No new false passes in contradictory fixtures.

## Changelog

No consumer changelog entry is required. This is development infrastructure.

## Frozen corpus and baseline

`npm run benchmark:verifier` replays the `2026-07-15-v1` corpus through the
configured verifier model without launching a browser or driver. Select another
model with `QAGENT_VERIFIER_MODEL`; provider and API-key resolution match the
other repository benchmarks.

The frozen labels record browser truth separately from what the captured
evidence proves. Output reports false passes, false failures, correct unknowns,
decomposition and verifier errors, evidence coverage, tokens, cost, and latency.
Driver completion remains a separate metric in `npm run benchmark:model`.

The pre-change verifier at commit `9a717dd` and the completed v0.10.0 worktree
were replayed on 2026-07-15 with `google/gemma-4-26b-a4b-it` through OpenRouter:

| Metric | `9a717dd` baseline | Tasks 22-24 |
|---|---:|---:|
| Correct verdicts | 6/8 | 8/8 |
| False passes | 0 | 0 |
| False failures | 2 | 0 |
| Unknown accuracy | 1/1 | 1/1 |
| Evidence coverage | 7/8 | 7/8 |
| Decomposition errors | 0 | 0 |
| Verifier errors | 0 | 0 |
| Tokens | 17,481 | 8,753 |
| Cost | $0.00119445 | $0.00073362 |
| Latency | 55,416 ms | 24,782 ms |

These are verifier-correctness metrics against human labels; they are not a
pass-rate comparison. Driver completion remains separately reported by the live
behavioral benchmark. Reproduce the final replay with:

```bash
QAGENT_PROVIDER=openrouter QAGENT_VERIFIER_MODEL=google/gemma-4-26b-a4b-it npm run benchmark:verifier > verifier-baseline-v0.10.0.json
```

Run it with `OPENROUTER_API_KEY` set in the environment.
