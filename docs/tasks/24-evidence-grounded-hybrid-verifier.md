# Task 24: Evidence-Grounded Hybrid Verifier

> **Target release:** v0.10.0
> **Depends on:** Tasks 21-23

## Problem

The verifier can currently alter claims, cite prose that does not prove them,
invent actions, and return a verdict whose explanation supports the opposite
answer. It also asks an LLM to decide facts QAgent already recorded
deterministically. A larger prompt or stronger model changed these errors but
did not remove them.

## Goal

Constrain semantic verification to source-grounded claims and real evidence,
while resolving already-known browser facts in code.

## Scope

- Represent decomposed items as plain objects with an ID, normalized text,
  exact source quote, kind (`assertion` or `instruction`), and comparison
  (`semantic` or `exact`).
- Require every source quote to exist in the shared verification goal.
- Aggregate only assertions; retain excluded instructions for audit.
- Give each assertion only its relevant structured actions and page-state
  evidence instead of the complete transcript.
- Require checks to return supporting and contradicting evidence IDs.
- Validate every evidence reference locally before aggregation.
- Derive `yes`, `no`, or `unknown` from validated support and contradiction;
  prose explanations remain non-authoritative.
- Resolve literal exact-copy checks locally when the claim identifies a quoted
  string and a cited text boundary. Leave semantic equivalence to the LLM.
- Resolve action existence, action success, selected values, and exact URLs
  from structured evidence rather than LLM prose.
- Keep proof-complete aggregation: a required `no` or `unknown` fails.
- Preserve current `outcome`, `checks`, `evidence`, and `humanEvidence` fields;
  add source and evidence metadata without renaming existing fields.
- Add an additive failure kind for `assertion`, `unverified`, `verifier`, and
  existing technical execution errors. Do not automatically label ambiguous
  test wording as a product or test-author defect.
- Treat invalid source grounding or nonexistent evidence references as a
  verifier protocol error after the existing retry, not as a product failure or
  a fallback to a weaker ungrounded verdict.

## Why This Fits QAgent

The LLM remains responsible for semantic meaning. Deterministic code owns facts
already known to QAgent, schema validation, and final aggregation. This makes
smaller models more viable without exposing a programming language to users.

## Non-Goals

- No second verifier, majority vote, or confidence threshold.
- No condition AST, rules engine, or general assertion engine.
- No `unknown`-to-pass policy.
- No automatic relaxation of exact or binding requirements.
- No screenshot vision or pixel-diff verification.
- No public accuracy slider or Playwright-style matcher syntax.
- No automatic claim that a failed test is inaccurate; that remains a human
  benchmark label unless QAgent has objective evidence.

## Acceptance Criteria

- An altered or invented claim cannot enter authoritative aggregation.
- A successful-click claim cannot pass without a cited successful action ID.
- Visible controls are never treated as actions without matching action
  evidence.
- Assertions about separate native control groups use their distinct evidence.
- A check cannot cite a nonexistent action or page-state ID.
- A verdict cannot disagree with its validated support and contradiction sets.
- Explicit exact copy is compared consistently; semantic wording remains an LLM
  decision.
- `unknown` remains a proof-complete failure but is reported separately from a
  contradicted assertion and from a verifier protocol error.
- Existing public result fields and reporters remain compatible.
- Task 21 replay meets every listed release gate and introduces no new false
  passes.

## Changelog

When implemented, add this note under `v0.10.0` in `CHANGELOG.md`:

> Verifier claims are now grounded in the shared goal and stable evidence IDs;
> deterministic browser facts are checked locally, while the LLM is limited to
> semantic judgments.
