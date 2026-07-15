# Task 08: Self-Contained Current Observation

> **Target release:** v0.9.0

## Problem

The driver currently receives a baseline snapshot from an earlier turn plus a
current snapshot where unchanged sections may be replaced with `# unchanged
since turn N`. This saves tokens, but it makes the current page state depend on
the model correctly reconstructing controls from an older message.

In the calculator runs, the raw page and screenshots still contained the form,
but the driver repeatedly interpreted an elided current section as a missing or
crashed page. This is especially harmful to the smaller models QAgent intends to
support.

## Goal

Every driver decision is based on one self-contained current accessibility
snapshot. Older snapshots may be scrubbed, but the latest observation must list
all currently actionable refs with their current roles and names.

## Scope

- Stop baseline-eliding sections from the latest snapshot sent to the driver.
- Scrub all older snapshots from the conversation so only one full page snapshot
  remains in active context.
- Keep compact previous-action diffs and bounded history metadata.
- Remove the baseline-anchor instructions from the driver system prompt.
- Remove `snapshot-compress.js` if it has no remaining caller after the change.
- Update architecture and user documentation that currently says each turn sends
  a compressed snapshot.

## Why This Fits QAgent

The executor owns observation truth; compression must not change what the driver
believes is on the current page. One complete current observation also gives
small models a simpler protocol than cross-turn reference reconstruction.

## Non-Goals

- No empty-page detector or automatic reload.
- No calculator-specific preservation rules.
- No screenshot or vision input for the driver.
- No new snapshot compression scheme in this task. Reintroduce compression only
  after measured token pressure and only if the current message stays
  self-contained.

## Acceptance Criteria

- Every actionable ref in the raw current snapshot has its role and accessible
  name in the latest driver message.
- Older driver messages contain no raw page snapshots.
- A generic multi-step wizard with a large unchanged form section never presents
  that section as absent after selecting one option.
- Existing action execution, stale-ref handling, traces, and final verification
  continue to use the raw current snapshot.
- Unit tests cover latest-snapshot completeness and old-snapshot scrubbing.

## Changelog

When implemented, add this short note under `v0.9.0` in `CHANGELOG.md`:

> Driver turns now receive one complete current accessibility snapshot instead
> of reconstructing unchanged sections from an older baseline, preventing
> unchanged form content from being mistaken for a missing page.
