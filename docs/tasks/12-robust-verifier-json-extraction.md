# Task 12: Robust Verifier JSON Extraction

> **Target release:** v0.9.0

## Problem

Verifier calls extract JSON with a greedy `{[\s\S]*}` match. A model response
containing one valid object followed by commentary or another object is captured
as one invalid JSON string, causing retries and fallback to the less structured
single-call verifier.

The driver already needs and uses equivalent logic for extracting the first
complete JSON object. Maintaining a weaker parser in the verifier creates an
unnecessary reliability difference between the two LLM boundaries.

## Goal

Use one small, shared first-complete-JSON-object parser for driver and verifier
responses.

## Scope

- Extract or reuse the driver's balanced-object parser.
- Correctly handle braces inside quoted strings and escaped quotes.
- Use the same helper for decomposition, claim checking, human summary,
  single-verifier fallback, done checks, and driver action parsing where
  applicable.
- Keep schema validation and the existing retry/fallback behavior after parsing.
- Preserve verifier fallback telemetry and token accounting.

## Why This Fits QAgent

Both driver and verifier consume a single JSON object from an LLM. One parser is
less code and makes both boundaries behave consistently without adding a new
provider abstraction.

## Non-Goals

- No provider-specific structured-output integration.
- No permissive repair of malformed JSON fields or values.
- No removal of verifier retry or fallback mode.
- No change to verifier decision semantics.

## Acceptance Criteria

- Parses a plain JSON object.
- Parses a fenced JSON object.
- Parses the first valid object followed by commentary or a second object.
- Handles braces and escaped quotes inside strings.
- Rejects incomplete or malformed objects with the existing useful error path.
- The calculator-style responses that previously triggered greedy-match parse
  failures no longer force single-verifier fallback.

## Changelog

When implemented, add this short note under `v0.9.0` in `CHANGELOG.md`:

> Driver and verifier responses now share robust first-object JSON extraction,
> avoiding unnecessary verifier fallback when a model appends commentary or a
> second object after valid JSON.
