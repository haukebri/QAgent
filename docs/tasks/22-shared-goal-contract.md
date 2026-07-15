# Task 22: Shared Goal Contract

> **Target release:** v0.10.0
> **Depends on:** Task 21

## Problem

The driver receives the full natural-language goal while the verifier later
creates its own interpretation. Recent verifier models ignored explicit wording
such as "only the Acceptance section is binding," promoted persona guidance to
required assertions, changed requested values, and invented requirements.

The two agents are therefore not reliably working toward the same definition
of success.

## Goal

Create one small, auditable goal contract before execution and pass that same
contract to both the driver and verifier.

## Scope

- Add one function that derives a contract from the original goal.
- Preserve the original goal as execution guidance.
- When a goal explicitly says that an `Acceptance:` section is the only binding
  section, select that section as the binding verification goal.
- Otherwise preserve current behavior by using the full goal as binding.
- Return plain data such as `{ fullGoal, verificationGoal, source }`; do not add
  a class or a second model call.
- Give the driver the full guidance plus the exact binding verification goal.
- Give claim decomposition and the single-call fallback only the binding
  verification goal.
- Store the selected source and verification text in structured results and
  traces so the meaning of PASS is auditable.
- Document the explicit `Acceptance:` convention without introducing assertion
  syntax.

## Why This Fits QAgent

Users still write natural-language tests. QAgent interprets an explicit scope
boundary once instead of allowing the driver and verifier to reinterpret it
independently.

## Non-Goals

- No planner or specification service.
- No LLM call to detect an explicit section boundary.
- No general Markdown parser or fuzzy heading grammar.
- No public `contains()`, `equals()`, selector, or Playwright-style language.
- No inferred easy, balanced, strict, confidence, or accuracy level.
- No relaxation of proof-complete verification for binding requirements.

## Acceptance Criteria

- An explicitly acceptance-scoped goal produces one shared contract before the
  driver starts.
- The driver sees both the original guidance and the selected binding goal.
- All verifier paths judge only the selected binding goal.
- Unstructured goals retain current full-goal behavior.
- Result and trace output identify whether verification used the full goal or
  an explicit Acceptance section.
- Easy calculator replay cases no longer promote persona inputs outside the
  Acceptance section into binding claims.
- The original user goal remains present in public results.
- Focused tests cover explicit scope, missing scope language, missing heading,
  and verifier fallback behavior.

## Changelog

When implemented, add this note under `v0.10.0` in `CHANGELOG.md`:

> Driver and verifier now share one auditable goal contract; tests that
> explicitly bind only an Acceptance section are verified against that section
> while retaining the full goal as execution guidance.
