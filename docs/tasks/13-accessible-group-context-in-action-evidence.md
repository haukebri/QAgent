# Task 13: Accessible Group Context in Action Evidence

> **Target release:** v0.9.0
> **Builds on:** v0.8.1 semantic action targets

## Problem

Semantic action targets record role, accessible name, locator candidates, and
some ancestor context. For grouped controls, a value such as "Mostly sitting"
is not sufficient evidence when the same or similar value can appear in several
fields. The verifier may otherwise compare an action from one group with a claim
about another.

The browser already exposes reliable group context when applications use
`fieldset`/`legend`, labelled ARIA groups, forms, regions, or dialogs. QAgent
should preserve that context instead of building a separate form-state model.

## Goal

When accessible group semantics exist, include them in the existing action
target and locator evidence so actions from sibling fields remain distinct.

## Scope

- Extend `inspectTarget()`'s existing context extraction to prefer the nearest
  labelled `fieldset`, ARIA group/radiogroup, form, region, or dialog.
- Use `legend`, `aria-label`, `aria-labelledby`, or an explicit accessible
  heading owned by that container.
- Preserve the current target/locator result shape unless an additive context
  field is materially clearer.
- Ensure verifier transcript formatting includes the semantic context already
  recorded on the action.
- When no accessible context exists, leave it unknown; do not infer a field from
  arbitrary nearby text or CSS classes.

## Why This Fits QAgent

This extends the one semantic evidence path added in v0.8.1 and keeps QAgent
aligned with standard browser accessibility semantics. It avoids site adapters
and duplicate state tracking.

## Non-Goals

- No calculator-specific activity-section knowledge.
- No CSS-based form-group guessing.
- No persistent per-field state ledger.
- No requirement to make inaccessible custom controls fully testable.

## Acceptance Criteria

- Identical option labels inside two accessible groups produce distinct action
  targets containing the correct group names.
- Existing form/dialog context tests continue to pass.
- Missing group semantics produce no invented context.
- Verifier fixtures treat an action in one named group as neither proof nor
  contradiction for a different named group.
- Public events remain free of internal accessibility refs.

## Changelog

When implemented, add this short note under `v0.9.0` in `CHANGELOG.md`:

> Semantic action evidence now includes the nearest accessible field or control
> group when available, helping traces and verifier checks distinguish identical
> option labels in different parts of a form.
