# Task 25: Restore One Goal, One Verifier

> **Target release:** v0.11.0
> **Supersedes:** Tasks 22 and 24

## Problem

QAgent now turns one natural-language goal into a second goal contract, many
claims, many verifier calls, and a locally aggregated verdict. The latest
calculator run reached the expected result in 15 of 20 scenarios but reported
only four passes: nine completed runs were rejected and two ended in verifier
protocol errors.

The claim system is making the product harder to explain and less accurate at
its main job.

## Goal

Return to one natural-language goal, one browser run, and one independent
verifier call that returns `{ outcome, evidence }`.

## Scope

- Pass the same goal to the driver and verifier.
- Remove the goal-contract and `Acceptance:` parsing path.
- Replace claim decomposition, per-claim checking, deterministic matching,
  aggregation, and fallback modes with one verifier judgment.
- Give the verifier the final URL, frozen final snapshot, compact successful and
  failed action history, and the driver's terminal response as non-authoritative
  context.
- Keep one retry for provider, parsing, or schema failure.
- Keep robust first-JSON-object extraction.
- Treat malformed verifier output after retry as a verifier error, not a failed
  product assertion.
- Return a short evidence sentence with every pass or fail.
- Make end-state verification the default. Use action history only when the
  goal explicitly makes a route or interaction part of the requested outcome.

## Product Boundary

QAgent verifies an observable outcome. It does not promise deterministic proof
of every intermediate action. Independent checkpoints should be separate
QAgent runs; durable workflow assertions belong in Playwright.

## Non-Goals

- No claim decomposition or checklist generation.
- No exact-versus-semantic claim modes.
- No `yes`, `no`, or `unknown` aggregation.
- No evidence-ID validation or deterministic assertion engine.
- No confidence score, majority vote, or second verifier.
- No compatibility layer that recreates removed verifier behavior.

## Acceptance Criteria

- A run makes exactly one successful verifier call in the normal path.
- The driver and verifier receive the same goal text.
- The verifier returns only a pass or fail plus one evidence string.
- A correct visible final state can pass even when the driver declared failure.
- An incorrect visible final state fails even when the driver declared success.
- A required route can be judged from action history when the goal explicitly
  requires that route.
- Two invalid verifier responses produce a verifier error.
- The nine completed calculator runs that failed only on compound exercise
  claims are no longer rejected for those intermediate fields.

## Changelog

When implemented, add this note under `v0.11.0` in `CHANGELOG.md`:

> QAgent again uses one natural-language goal and one independent final
> verifier judgment, removing claim decomposition and local assertion logic.
