# Task 03: Gate Driver `done` Before Ending a Run

> **Superseded by [Task 06a](06a-assertion-style-done-gate.md).** The history-guard behavior described below — including the 2-rejection cap-bypass — was replaced by an observation-aware terminal gate that runs an extended settle pass and terminates the run as `fail` (no retry, no cap-bypass) when the guard rejects.

## Status

Partially implemented. The verifier-based gate was reverted after empirical testing showed it caused harm.

## Problem

Some failed runs ended because the driver called `done` even though the final page state clearly did not satisfy the goal. Examples:

- AIDA: driver claimed insurance was reached while still on `/kabine`.
- Ryanair: driver claimed results were available while the snapshot still showed the search form or a disabled Search button.
- Gravity Forms: driver claimed submission succeeded while validation errors were still visible.

The end-of-run verifier catches these as failures, but by then the executor has already stopped, so the driver never gets a chance to recover from an overconfident `done`.

## What was kept

A deterministic history-error guard in `src/executor.js` (`findBlockingPriorError`). When the driver returns `done`, it walks `history` backwards, skips earlier rejected `done` entries, and finds the most recent non-`done` step. If that step has an `error` field (tool error, missing ref, JSON parse failure, etc.), the gate rejects `done`, sets `lastError` to a targeted message, appends a rejection entry to `history`, and continues the loop.

A cap of 2 rejections per todo prevents pathological loops; the third `done` attempt is accepted and the end-of-run verifier remains authoritative. Rejections and the cap-reached event are surfaced in `result.warnings[]`.

This catches the "driver hit a tool error and gave up" pattern at near-zero cost (no extra LLM calls).

## What was reverted

A second check that called the LLM verifier mid-loop on each `done` candidate, fed the verifier's evidence back to the driver as `lastError`, and let the loop continue.

In testing across 13 runs on the Gravity Forms project-inquiry-form goal (timestamps 2026-05-01T02:52Z onward), the verifier-gate produced no outcome lift over the existing end-of-run verifier and consistently caused harm:

- Run `04-38HCC79` (fail, 44 turns): driver re-navigated to the form URL and re-filled every field from scratch after each rejection. Three identical fill cycles, two extra verifier calls, then cap-bypass.
- Run `04-16H3978` (fail, 100 turns): rejection at turn 86 burned 14 more turns thrashing on stale refs.
- Runs `04-39H6098` and `04-40H8E5B` (pass): both passes were re-observation timing artifacts after async form confirmation rendered, not gate-driven recovery. `04-40H8E5B` passed via cap-bypass.

Root cause: the verifier's evidence is *descriptive* of page state ("form fields still populated"), not *diagnostic* of the failed action. A stateless one-turn driver, told the page state is wrong, redoes the workflow rather than debugging the specific action that didn't take effect. Asking the driver to model the verifier in one turn does not work.

The verifier-gate code, the rejection cap-related verifier-token accounting, and the `judgeModel` hoisting were removed.

## Non-goals

- Do not replace the end-of-run verifier — it remains the source of truth for pass/fail.
- Do not introduce phrase lists, regex patterns, or site-specific heuristics.
- Do not change the `fail` action path.

## Acceptance criteria (current)

- A driver `done` immediately after a tool error is rejected by the history guard. The rejection is recorded in `history` and `warnings`, and the loop continues.
- After two history-guard rejections within a single todo, the next `done` is accepted with a cap-reached warning, and the run terminates normally.
- A valid `done` (no preceding error) terminates the loop with no extra warnings.
- The end-of-run verifier still runs on the accepted verdict.
- `fail` is unchanged.
