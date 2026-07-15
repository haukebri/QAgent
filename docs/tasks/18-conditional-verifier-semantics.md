# Task 18: Conditional Verifier Semantics

> **Target release:** v0.10.0
> **Builds on:** Task 09

## Problem

Claim decomposition can turn `if X appears, do Y` into an unconditional claim
that Y occurred. Proof-complete aggregation then correctly fails the resulting
`unknown`, but the claim no longer matches the user's specification.

Calculator warning checks and optional booking branches exposed this mismatch.
Gravity Forms also showed the opposite case: a cookie dialog did appear and the
required action was skipped, which must remain a failure.

## Goal

Preserve conditional requirements as implications while retaining
proof-complete outcomes.

## Scope

- Update claim decomposition guidance so an antecedent and consequence remain
  together in one checkable claim.
- Update claim-check guidance to evaluate the antecedent before requiring the
  consequence.
- Treat a condition as satisfied when evidence shows the antecedent did not
  occur or was not offered.
- Require positive proof of the consequence when the antecedent is observed.
- Keep genuinely indeterminate conditional evidence as `unknown`, which remains
  a failed aggregate outcome.
- Cover cookie dialogs, optional choices, warnings, and validation recovery with
  generic verifier fixtures.

## Why This Fits QAgent

Task 09 defines how verified claims aggregate; it should not compensate for a
claim that changed the meaning of the natural-language goal. This fixes claim
modeling while preserving the independent, proof-complete verifier.

## Non-Goals

- No relaxation of `unknown -> fail` aggregation.
- No new top-level `inconclusive` outcome.
- No condition AST, rules engine, or extra verifier phase.
- No cookie-, calculator-, or booking-specific prompt exceptions.
- No retries or actions performed by the verifier.

## Acceptance Criteria

- Dialog absent and main outcome complete: the conditional dismissal
  requirement is satisfied.
- Dialog present and dismissed: the conditional requirement is satisfied.
- Dialog present and skipped: the conditional requirement fails.
- An optional choice that evidence shows was not offered does not become an
  unverified mandatory action.
- A validation-recovery clause is satisfied by immediate success when no
  validation error occurs.
- Any required claim that remains genuinely unknown still fails aggregation.

## Changelog

When implemented, add this note under `v0.10.0` in `CHANGELOG.md`:

> Conditional goal requirements now preserve their trigger during verification,
> so untriggered branches are not treated as unconditional missing actions.
