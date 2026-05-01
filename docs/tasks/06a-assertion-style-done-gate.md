# Task 06a: Assertion-Style Terminal Verdict Gate

> **Status: focus.** Highest-priority follow-up to the Task 06 MVP. Other 06* sub-tasks improve clarity and cost; this one moves the pass rate.

Source analysis: `docs/analysis/task-06-mvp-gaps.md` (gaps #1, #2, #4).
Builds on: Task 06 MVP (`docs/superpowers/specs/2026-05-01-settle-and-diff-observation-design.md`), Task 03 (history-guard, current done-gate behavior).

## Problem

Two related defects in the current `done` flow let the executor hand the verifier a snapshot that has not yet shown the user-visible result:

1. **No assertion-style settle before the verifier.** Task 06 spec §5 explicitly says `done` should run a settle pass before terminal verification. The MVP only does this when the prior action's observation hasn't been captured yet (`executor.js` final-observation block); in the common path the prior action was observed ~0.2s after it ran, the model immediately says `done`, and the verifier judges a snapshot that captured the form before it transitioned. Five of six gravityforms post-MVP runs fail this way (e.g. `results/2026-05-01T11-15H9945.json`).

2. **History guard is blunt.** It rejects `done` whenever the most recent non-`done` step has an `error` field. But the MVP's observation data shows that an action can error (e.g. stale-ref click after submit) while the page transitioned successfully. Gravityforms pass `2026-05-01T11-21H4F79.json`: T15 click `ERR locator.click: Timeout 2000ms exceeded` carries an observation with `tier: 'large'`, removedText including `Agency Project Inquiry`, `Name (Required)` (the entire form removed). The guard still rejected `done` twice; only the cap-bypass let the verifier (correctly) pass it.

The MVP's settle (150ms × 2 samples, 3s max) is also too eager for terminal verification — it proves the DOM was momentarily stable, not that the user-visible result had time to render. Playwright's assertion auto-wait is the right mental model.

## Goal

When the driver emits `done`, run an extended assertion-style settle pass before the verifier judges. Make the history guard observation-aware so that a `done` after an action that errored-but-transitioned-the-page is accepted.

## Scope

### Extended settle for terminal verification

Add an `observeWithSettle` mode (or a sibling entry point such as `observeForVerdict`) with longer defaults:

```text
pollMs: 250
stableSamples: 3
maxSettleMs: 10000  (configurable)
```

Stable window is recomputed from the last sample whenever URL or normalized snapshot changes. Verifier sees the post-settle snapshot.

### Wire into the `done` flow

In `src/executor.js`, when `action.action === 'done'`:

1. Run the extended settle pass against the prior `prev.snapshot` / `prev.url`.
2. Attach the resulting compact observation to the `done` history entry as `entry.observation` (mirrors the field on performed-action steps but tagged as terminal).
3. Update `finalSnapshot` to the post-settle snapshot so the verifier judges the right state.
4. Run the (now observation-aware) history guard.
5. If accepted, set the verdict and break. Verifier runs against `finalSnapshot`.

If `prev == null` (for example a turn-1 `done` on an information-check task),
take a fresh observation as the baseline and run the same settle pass against
the current page / URL. With no prior action there is no prior action error, so
the history guard auto-admits and the verifier judges the settled current page.

### Observation-aware history guard

Replace the current "reject `done` if previous step has `error`" with:

```text
reject `done` only if the previous step has `error`
              AND the prior step's observation is null OR shows no meaningful change
              (!urlChanged && !snapshotChanged && addedText.length === 0)
```

"Meaningful change" reuses the existing observation fields. Using `addedText.length === 0` (rather than `summaryTier === 'unchanged'`) admits the gravityforms stale-ref-after-submit case (`tier: 'large'`, removedText non-empty, addedText empty when the success message hasn't rendered yet — but the form *did* disappear, which is meaningful).

Drop the cap-bypass. `done` enters this terminal gate exactly once. If the
history guard rejects it, terminate the run as `fail` with structured evidence
from the guard and the terminal observation. Do not return to the broad driver
loop, and do not accept `done` after a rejection cap.

### Recorder

Pass `entry.observation` through unchanged for `done` entries (the recorder already does this). Optionally surface a `verdictObservation` top-level field on the result JSON for easier analysis (Task 06f covers this if not done here).

### CLI / config

Optional: `--verdict-settle-timeout <s>` flag (default 10s). If too far-reaching for this task, hardcode the default and add the flag in Task 06f.

## Non-Goals

- No reintroduction of the LLM verifier-gate from the reverted Task 03. The gate stays deterministic.
- No change to the verifier itself.
- No site-specific rules.
- No retry of the prior failed action; the gate just decides whether to let `done` through.

## Acceptance Criteria

- Every accepted `done` carries an observation describing what happened during the terminal settle (settled, settleMs, urlChanged, snapshotChanged, summaryTier).
- The verifier judges against the post-settle snapshot, not the pre-settle one (`finalSnapshot` is updated).
- Hermetic fixture: `delayed-success.html` has a button click that reveals a success element after roughly 2.5s. When the driver says `done` immediately after the click, the terminal gate waits and the verifier judges the success state.
- Hermetic fixture: `instant-stable.html` is already stable. The terminal gate exits quickly, ideally under 750ms, and does not impose a full timeout on happy stable pages.
- Hermetic fixture: `infinite-spinner.html` keeps changing or never reaches a stable useful state. The terminal gate hits `maxSettleMs` and fails with structured evidence instead of hanging.
- Hermetic fixture: `no-prior-action.html` exercises the `prev == null` path. A turn-1 `done` settles the current page and verifies without a prior-action guard rejection.
- Gravityforms remains a tracked smoke check: when the model says `done` shortly after Submit Inquiry, the executor waits up to 10s before the verifier runs. Pass rate should improve over the post-MVP baseline (currently 1/6), but this external site must not be the merge gate.
- A `done` after a stale-ref click on a button that successfully replaced the page (gravityforms H4F79 pattern) is now accepted by the gate without needing the cap-bypass.
- A `done` after a click that errored AND produced no observable change is still rejected.
- The cap-bypass (`done-gate: cap reached (2 rejections)`) no longer appears in result warnings; if the gate rejects, the run terminates as `fail` with structured evidence.
- No site-specific text or selector heuristics introduced.

## Example

Pre-Task-06a, gravityforms FAIL `2026-05-01T11-15H9945.json`:
```
T13 click button 'Submit Inquiry' (settled in 0.2s, tier=small, addedText=[], removedText=[])
T14 done                                       # accepted immediately
verifier: FAIL (form fields still visible in finalSnapshot)
```

Post-Task-06a expected behavior:
```
T13 click button 'Submit Inquiry' (settled in 0.2s, tier=small, addedText=[], removedText=[])
T14 done                                       # triggers extended settle
   verdict observation: settled in 1.4s, tier=large, addedText=["Thank you for your project inquiry!"]
   gate: accept (no prior error)
   finalSnapshot updated
verifier: PASS (sees thank-you text)
```

## Out of Scope (handled by sibling tasks)

- Settle after explicit `wait` actions → Task 06b.
- Stale-ref enrichment → Task 06c.
- Fingerprint-based loop detection → Task 06d.
- Readiness probes (readyState, pending requests, skeleton hints) → Task 06e.
- Richer recorder metadata (verdictObservation top-level, fingerprints, capped section list) → Task 06f.
- Verifier-in-the-loop assertion polling → Task 06g.
