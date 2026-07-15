# Task 11: Constraint-Aware Safe Recovery

> **Target release:** v0.9.0

## Problem

The driver system prompt currently recommends `goBack` after a wrong click even
when the user's goal explicitly forbids browser back. Because QAgent
pre-navigates before the driver loop, `goBack` may also return to the browser's
initial `about:blank` page when no reversible in-run navigation occurred.

Recovery is useful, but it must not violate the test specification or destroy a
valid application state.

## Goal

Keep generic recovery available while making explicit goal constraints and
observed browser history authoritative.

## Scope

- Remove unconditional `goBack` advice from the system prompt.
- Tell the driver that explicit goal constraints govern all recovery actions.
- Track whether the driver loop observed a URL/history transition that can be
  reversed safely.
- Reject `goBack` before execution when:
  - the goal explicitly forbids browser back; or
  - no reversible in-run navigation has been observed.
- Return a concise error telling the driver to re-read the current state or fail
  with evidence instead.
- Keep `goBack` for permitted recovery from a genuine wrong navigation.

## Why This Fits QAgent

The natural-language goal is the test specification. Executor safety checks may
constrain an unsafe action, but generic recovery guidance must never overrule
the user's route and interaction requirements.

## Non-Goals

- No automatic reload, restart, or direct driver navigation.
- No site-specific recovery sequences.
- No attempt to parse every possible natural-language prohibition. Cover clear
  back-navigation constraints and keep the rule small.
- No removal of `goBack` from the public action union.

## Acceptance Criteria

- A goal containing an explicit "do not use browser back" instruction executes
  zero `goBack` actions across repeated runs.
- `goBack` is rejected before it can reach `about:blank` when no in-run
  navigation has occurred.
- A permitted run that navigates to a wrong page can still recover with
  `goBack`.
- Recovery rejection is recorded in the trace with a human-readable reason.
- No calculator-specific URL or text appears in implementation or tests.

## Changelog

When implemented, add this short note under `v0.9.0` in `CHANGELOG.md`:

> Browser-back recovery now respects explicit goal constraints and is blocked
> when QAgent has not observed a reversible in-run navigation, preventing
> destructive recovery to `about:blank`.
