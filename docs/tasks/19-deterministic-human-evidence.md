# Task 19: Deterministic Human Evidence

> **Target release:** v0.10.0
> **Builds on:** Tasks 09 and 15

## Problem

After the authoritative checks determine an outcome, a prose-only LLM call
rewrites them as `humanEvidence`. It cannot change `outcome`, but it can produce
contradictory text such as saying a failed goal was successfully completed. It
also adds one model call, latency, cost, retry handling, and another disagreement
path.

## Goal

Generate concise human evidence deterministically from the authoritative
outcome and decisive structured checks.

## Scope

- Remove the prose-only verifier summary model call and prompt.
- Preserve the public `humanEvidence` field.
- For a pass, report that all required claims were verified.
- For a `no` claim, name the contradicted claim and its concrete evidence.
- For an `unknown` claim, state that the required claim could not be verified
  and include its evidence.
- Keep `checks` and compact `evidence` authoritative and machine-readable.
- Update verifier token accounting, documentation, and tests for one fewer call.

## Why This Fits QAgent

One verifier should decide the result once. Formatting that result does not need
another LLM, and deterministic prose is cheaper and more trustworthy.

## Non-Goals

- No second LLM validator or word-filter heuristic.
- No change to claim decomposition, checking, or aggregation semantics.
- No removal or renaming of `humanEvidence`.
- No new templating dependency or localization system.
- No public failure taxonomy.

## Acceptance Criteria

- A failed outcome never says the goal or test completed successfully.
- A denied claim produces a concise failure message naming the claim and
  contradiction.
- An unknown claim produces a concise unverified-requirement message.
- An all-yes result produces a concise pass message with the claim count.
- `humanEvidence` generation performs no model call and consumes no tokens.
- JSON, NDJSON, trace, list, and direct-run outputs retain `humanEvidence`.

## Changelog

When implemented, add this note under `v0.10.0` in `CHANGELOG.md`:

> Human verdict text is now generated deterministically from authoritative
> claim checks, eliminating contradictory prose and one verifier model call.
