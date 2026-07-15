# Task 23: Structured Browser Evidence

> **Target release:** v0.10.0
> **Depends on:** Tasks 21 and 22
> **Builds on:** Task 13

## Problem

The verifier currently reconstructs browser facts from prose action history and
ARIA snapshots. Separate controls can lose their question context, successful
selections can produce no snapshot change, and transient visible warnings can
be absent from accessibility evidence. This caused field-overwrite false
failures, invented action history, and repeated driver clicks.

## Goal

Record the browser facts QAgent already knows as small structured evidence and
reuse them for driver feedback and verification.

## Scope

- Extend the existing action record; do not add a parallel event subsystem.
- Give recorded actions stable IDs and before/after observation IDs.
- Record action success or error, target role/name, locator metadata, and URL.
- For inputs and input-backed clickable controls, record native identity and
  before/after state when available: `type`, `name`, `value`, `checked`,
  `selected`, `disabled`, and current input value.
- Preserve the nearest accessible group and add the nearest useful visible
  question or section label when accessible markup is insufficient.
- Feed concise post-action state back to the driver so an unchanged snapshot
  does not make it repeat a successful selection.
- Add a bounded normalized visible-text delta after actions and at the frozen
  final state, alongside the ARIA snapshot.
- Include the structured evidence in verifier input and trace output while
  preserving existing public action fields.
- Exercise the behavior with a generic local grouped-form fixture, not the
  calculator website.

## Why This Fits QAgent

Playwright already knows whether an action succeeded and whether a control is
selected. Recording those facts once is cheaper and more reliable than asking
both LLMs to infer them from page prose.

## Non-Goals

- No screenshot vision, OCR, or pixel comparison.
- No complete DOM dump or unbounded `innerText` history.
- No calculator-specific labels or selectors.
- No new browser-event database or event-sourcing abstraction.
- No guarantee that every custom JavaScript widget exposes native state.
- No page-phase classifier.

## Acceptance Criteria

- Every executed referenced action has a stable evidence ID and explicit
  success or error state.
- A radio, checkbox, select, or input action records its resulting native state
  when the page exposes one.
- Repeated option labels in different groups retain distinct group identity.
- A successful selection with no ARIA snapshot change is reported as successful
  to the driver and is not retried solely for lack of snapshot change.
- A transient rendered warning can be present in verifier evidence even when it
  is absent from the final ARIA snapshot.
- Visible-text evidence is normalized and bounded by existing observation or
  transcript limits.
- Existing result consumers can ignore the additive fields.
- One focused fixture test protects group identity, post-action state, and
  transient visible text.

## Changelog

When implemented, add this note under `v0.10.0` in `CHANGELOG.md`:

> Action evidence now records stable IDs, control-group context, resulting
> native state, and bounded visible-text changes, improving both driver progress
> detection and verifier accuracy.
