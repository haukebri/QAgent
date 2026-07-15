# Task 27: Stop Retrying Successful Unchanged Clicks

> **Target release:** v0.11.0

## Problem

Four scenarios in `results/20260715-221850` repeatedly clicked the generic
`Female` control and terminated as stuck. Playwright executed the click, but
the accessibility snapshot did not visibly change, so the driver treated the
selection as unsuccessful.

The structured native-state system did not solve this for wrapper-backed
controls and should not grow into a custom-widget state engine.

## Goal

Make the driver trust a successful click once and continue when no visible page
change is expected.

## Scope

- Report a successful click as successful even when URL and snapshot are
  unchanged.
- Tell the driver that an unchanged successful click may be a completed
  selection and should not be repeated solely to force a visual delta.
- Keep existing repeated-action stuck protection as the final bound.
- Remove native-state feedback if this simpler result makes it redundant.
- Add one local generic-wrapper radio or checkbox regression fixture.
- Rerun the four affected female-persona scenarios after the change.

## Escalation Rule

Do not add associated-input or descendant-control state inference initially.
Add the smallest such lookup only if the regression fixture or live rerun still
repeats successful wrapper clicks.

## Non-Goals

- No general custom-widget state model.
- No DOM diff engine.
- No calculator-specific selector or label.
- No weakening of genuine repeated-failure termination.

## Acceptance Criteria

- One successful unchanged click is described to the driver as successful.
- The driver is not told that lack of a snapshot change means the click failed.
- The local wrapper-control fixture proceeds to the next field without clicking
  the selected option repeatedly.
- A genuinely failing or stale click remains an error.
- Repeated ineffective actions still terminate within the existing bound.

## Changelog

When implemented, add this note under `v0.11.0` in `CHANGELOG.md`:

> Successful clicks no longer need a visible snapshot change before the driver
> can continue, preventing repeated selection of wrapper-backed controls.
