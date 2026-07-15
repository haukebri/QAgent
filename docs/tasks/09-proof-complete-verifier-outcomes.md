# Task 09: Proof-Complete Verifier Outcomes

> **Target release:** v0.9.0
> **Depends on:** none

## Problem

Claim-based verification currently fails a run only when a claim is explicitly
`no`. Required claims marked `unknown` produce warnings but still aggregate to
`pass`. That allowed runs whose driver terminated early and left most required
steps unverified to be reported as successful.

This weakens QAgent's central promise: a pass should mean the natural-language
goal was proven by browser evidence.

## Goal

Return `pass` only when every required claim has concrete positive evidence.
Missing proof must be a non-pass result with evidence that says what could not
be verified.

## Scope

- Change claim aggregation to:
  - all claims `yes` -> `pass`;
  - any claim `no` -> `fail` with the concrete contradiction;
  - otherwise, any required claim `unknown` -> `fail` with an "unverified"
    explanation.
- Preserve each claim's `yes | no | unknown` value in structured output.
- Keep the verifier authoritative. A driver `fail` may still be overridden when
  every required claim is independently verified as `yes`.
- Update `humanEvidence`, README examples, changelog guidance, and tests that
  currently describe unknown claims as passing with warnings.
- Keep warnings if useful, but do not use them to turn incomplete proof into a
  pass.

## Why This Fits QAgent

The driver acts and the verifier judges. Tightening proof aggregation preserves
that separation while eliminating false positives. A mistaken driver verdict
does not decide the result; complete frozen evidence does.

## Non-Goals

- No new `inconclusive` top-level outcome in v0.9.0.
- No rule that makes every driver `fail` authoritative.
- No calculator-specific claims or verifier prompt exceptions.
- No change to provider or model selection.

## Acceptance Criteria

- `all yes` aggregates to `pass`.
- `yes + no` aggregates to `fail` and names the contradicted claim.
- `yes + unknown` aggregates to `fail` and names the unverified claim.
- A terminal driver failure followed by complete positive evidence can still
  pass.
- A terminal driver failure with any unknown required claim cannot pass.
- Re-aggregating calculator runs 05, 07, and 11 cannot produce a pass.

## Changelog

When implemented, add this short note under `v0.9.0` in `CHANGELOG.md`:

> Verifier passes now require positive evidence for every required claim;
> unverified claims remain visible as `unknown` checks but make the run fail
> instead of producing a warning-only pass.
