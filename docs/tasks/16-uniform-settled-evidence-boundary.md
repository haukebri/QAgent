# Task 16: Uniform Settled Evidence Boundary

> **Target release:** v0.10.0
> **Builds on:** Tasks 10 and 15

## Problem

Post-action and normal terminal states use bounded settling, but the first driver
turn still uses a one-shot observation and a turn-one `fail` skips terminal
settling. Failure screenshots are also captured after verifier calls, so the
live page may change between the snapshot used for judgment and the screenshot
saved for a human.

The AIDA smoke runs exposed both gaps: the frozen snapshot and later screenshot
described different page states.

## Goal

Use one deterministic `settle -> freeze -> verify` boundary for every run so the
driver, verifier, trace, and human evidence refer to the same stable browser
state.

## Scope

- Extend the existing settle helpers to cover the initial page state before the
  first driver decision.
- Settle terminal `done` and `fail` states even when they occur on turn one.
- Apply the same final settling path after stuck detection, timeout, turn cap,
  and fatal execution paths when a page is still available.
- Freeze final URL, accessibility snapshot, and screenshot together before
  invoking the verifier.
- Persist the frozen screenshot for failed traces instead of recapturing the
  live page after verifier calls.
- Keep all waits bounded by the existing test and settle budgets.

## Why This Fits QAgent

The executor owns browser truth and the verifier judges only frozen evidence.
This completes the existing boundary without adding another observer, site
heuristics, or a second terminal judge.

## Non-Goals

- No site-specific delays or error-message handling.
- No network-idle waiting, reload, restart, or direct recovery navigation.
- No screenshot or vision input for the driver or verifier.
- No new public outcome or failure taxonomy.
- No broader tuning of intermediate post-action settling without a reproducing
  fixture.

## Acceptance Criteria

- A fixture that initially exposes a transient state and then stable content is
  observed in its stable state before the first driver decision.
- A turn-one `fail` still produces a settled final snapshot.
- A page that mutates while verifier calls run cannot change the persisted final
  screenshot or the verifier's snapshot.
- The saved snapshot and screenshot describe the same frozen page state.
- Existing delayed-action, terminal-settle, timeout, and evidence tests remain
  green.

## Changelog

When implemented, add this note under `v0.10.0` in `CHANGELOG.md`:

> Initial and terminal browser states now share one bounded settle-and-freeze
> boundary, and persisted screenshots match the evidence judged by the
> verifier.
