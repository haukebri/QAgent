# Task 17: Exact Goal Requirement Fidelity

> **Target release:** v0.10.0
> **Builds on:** Tasks 11 and 15

## Problem

The driver can recognize that an exact required product, route, value, or step
was not completed and still substitute a similar alternative before declaring
`done`. In both Vorwerk smoke runs it added a VM7 while explicitly acknowledging
that the goal required a PB440.

The verifier correctly failed those runs, but the driver wasted turns and
produced a misleading terminal summary.

## Goal

Treat explicit products, values, URLs, routes, prohibitions, and required steps
in the natural-language goal as constraints rather than suggestions.

## Scope

- Add one concise driver rule forbidding substitution of exact named
  requirements with similar alternatives.
- Tell the driver to use `fail` with concrete evidence when exact compliance is
  impossible after allowed recovery.
- Keep the independent verifier authoritative over the final outcome.
- Add a behavioral scenario where the required item is absent but a similar
  item is available.
- Retain verifier coverage proving that a substituted path or item cannot pass.

## Why This Fits QAgent

The natural-language goal is the test specification. This extends the existing
constraint-aware recovery rule without adding a goal parser, planner, or
application-specific policy.

## Non-Goals

- No structured constraint AST or additional planning layer.
- No executor-side interpretation of product, route, or business semantics.
- No acceptance of equivalent products or alternate routes unless the goal
  explicitly permits them.
- No site adapters, search fallback, reload, or direct navigation action.
- No restoration of an executor-side LLM done check.

## Acceptance Criteria

- Driver guidance explicitly says exact named products, values, routes, URLs,
  and mandatory steps cannot be substituted.
- In a live-model behavioral fixture, an absent required item plus a similar
  available item does not produce a successful substitution summary.
- A driver may fail with evidence when the exact requirement is unavailable.
- A canned premature `done` after substitution is still rejected by the
  verifier.
- Permitted alternatives expressed in the goal continue to work.

## Changelog

When implemented, add this note under `v0.10.0` in `CHANGELOG.md`:

> The driver now treats exact named products, values, routes, URLs, and required
> steps as binding constraints instead of substituting similar alternatives.
