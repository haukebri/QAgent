# Task 26: Remove Claim and Evidence Plumbing

> **Target release:** v0.11.0
> **Depends on:** Task 25
> **Supersedes:** Task 23's verifier-facing scope

## Problem

The executor, tools, recorder, reporters, and public result format now carry
IDs, contracts, citations, native-state proof, and claim metadata used only by
the verifier architecture removed in Task 25. Keeping that plumbing would leave
the complexity and maintenance cost behind after removing its behavior.

## Goal

Delete verifier-specific data flow and return the runtime and result format to
the smallest useful set of browser facts.

## Scope

- Delete `src/goal-contract.js` and its callers and tests.
- Remove action evidence IDs and before/after observation IDs.
- Remove structured page-state evidence and `browserEvidence` output.
- Remove native-state capture and comparison when it has no remaining driver
  use.
- Remove `goalContract`, `checks`, `excludedItems`, `verifierMode`, claim source
  metadata, and citation metadata from results and reporters.
- Print the verifier's `evidence` directly; remove a separate human-summary
  representation unless compatibility requires `humanEvidence: evidence` for
  one release.
- Keep the ordinary compact action history: action, target, URL, observation,
  success, and error.
- Keep final URL, screenshot, trace, turns, timing, tokens, cost, and a small
  stage-level failure kind (`execution`, `assertion`, or `verifier`).
- Simplify the driver prompt to goal, current URL, current page, available
  actions, and previous action result.
- Update README and architecture documentation to describe outcome testing,
  not claim-level workflow auditing.

## Non-Goals

- No empty compatibility objects for removed features.
- No replacement evidence graph or event system.
- No new public assertion syntax.
- No full revert of browser settling, recovery, screenshots, or telemetry.

## Acceptance Criteria

- No production module imports or creates a goal contract.
- No verifier-specific ID or citation is recorded during a browser run.
- Public JSON contains the goal, outcome, evidence, final URL, steps, optional
  screenshot, statistics, and technical failure information without claim
  fields.
- The list reporter shows the same decisive evidence as the JSON reporter.
- Driver and verifier prompts contain no binding-goal or claim terminology.
- Existing browser settling, action errors, timeout handling, screenshots, and
  token accounting still work.
- Tests for deleted internal structures are removed rather than rewritten to
  preserve them.

## Changelog

When implemented, add this note under `v0.11.0` in `CHANGELOG.md`:

> Removed verifier-specific contracts, claim metadata, citations, and
> structured evidence plumbing from the runtime and public result format.
