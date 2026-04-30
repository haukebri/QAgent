# Stuck Detection — Design

Source task: `docs/tasks/02-stuck-detection.md`.

## Problem

The executor loop currently tells the driver about each failed or no-op action via `lastError`, but does not detect that the run is going in circles. Real failures show this clearly:

- `results/2026-04-29T10-00HE7AA.json`: 98 clicks of Landefeld `Accept all`, every one returning `click blocked by overlay: iframe#I0_1777456322093`.
- A Devstral run alternated AIDA `Ändern` and `Speichern` 29 / N times until the 100-turn cap.
- GPT runs repeatedly clicked the same sidebar/search ref with no URL or snapshot change.

We need executor-level detection that forces a strategy change before the run burns its turn or cost budget.

## Goal

Detect repeated REF_ACTIONs with no meaningful progress and escalate in two stages:

1. **Warn** the driver via `lastError` after the third no-progress occurrence in a sliding window.
2. **Terminate** the todo as `fail` if the driver tries the warned action again.

## Scope

Implemented entirely in `src/executor.js`. No new modules, no changes to `tools.js`, `verifier.js`, `recorder.js`, or the recorder schema.

## Detection logic

### What gets tracked

For every `REF_ACTIONS` turn (`click | fill | selectOption | type | pressKey`) — successful or failed — we build a record:

```js
{
  sig: `${action}|${ref}|${urlBefore}`,
  noProgress: urlBefore === urlAfter && Math.abs(snapshotDelta) < 200,
}
```

Records live in a sliding window of the last **5** entries. Detection counts entries where `r.sig === current.sig && r.noProgress === true`; entries that made progress (URL changed or large snapshot delta) are skipped by the count even though they share the window slot.

**Timing.** `urlBefore` is captured at the top of the turn (before the action). `urlAfter` is `page.url()` after the action returns. The action's `snapshotDelta` is only computable at the *start of the following turn*, when the new snapshot is observed (it is the existing `snapshot.length - prevSnapshotLen` value the executor already computes for the "Page unchanged / grew / shrunk" hint). So:

1. At end of a REF_ACTION turn, stash a *pending record* with everything except `noProgress`.
2. At the top of the next turn, after `observe()` and `snapshotDelta` are computed, finalize `noProgress`, push the record onto the window, and run stage-1 detection. Then proceed with prompting the driver — so any new warning is included in `lastError` for that turn's prompt.

This works regardless of what the next turn is (`wait`, `navigate`, REF_ACTION, etc.), because the snapshot taken at its top reflects the prior REF_ACTION's effect.

**Other turn types.** `navigate`, `wait`, parse-error, ref-miss, and LLM-error turns do not enter the window and do not reset it. They are recovery / control-flow turns. They also don't disturb the pending-record finalization above — the pending record from the last REF_ACTION still gets finalized at the next turn's observe.

**Why `error` is NOT in `sig`.** A signature of `action+ref+url` (without error) lets stage 1 and stage 2 use the same key — stage 2's pre-execute check would otherwise have to reconstruct the error from history, which is fragile. Mixed flake (a button that sometimes errors and sometimes succeeds) is handled correctly: only the no-progress entries count toward the threshold, so a button that occasionally works does not falsely trip. We reuse the existing `±200` char threshold so the executor's stuck judgment is coherent with what the driver is told.

### Stage 1 — warn

After appending a record, count entries in the window with the same `sig` AND `noProgress === true`. If that count is **≥ 3** and the signature is not already in `warnedSignatures`:

- Set `lastError` to:

  ```
  Stuck: you repeated <action> <ref> 3 times with no URL or page-state change. Do not <action> that ref again. Choose a different control, wait for a specific state, navigate directly if valid, or fail with evidence.
  ```

- Add the signature to `warnedSignatures` (a `Set<string>` scoped to the todo).
- Continue the loop. The driver will see the warning on the next turn's prompt.

A 5-of-window-of-5 alternation case (e.g. Ändern, Speichern, Ändern, Speichern, Ändern) trips because Ändern's signature reaches count 3.

### Stage 2 — terminate

Before executing a chosen REF_ACTION, compute the prospective signature using the *current* URL:

```js
const prospectiveSig = `${action.action}|${action.ref}|${page.url()}`;
if (warnedSignatures.has(prospectiveSig)) {
  verdict = {
    action: 'fail',
    summary: null,
    reason: `repeated blocked action after stuck warning: ${prospectiveSig}`,
  };
  // record the entry, fire onTurn, break the loop
}
```

**Any** future attempt at that exact action+ref+url terminates regardless of what error the page might produce. That is the desired property: once we've told the driver "do not do X", doing X is a failure.

Termination produces a real `verdict`, so the existing post-loop pipeline runs: the verifier still judges the run, the failure screenshot is captured, the recorder writes the trace.

## Lifetime of warnings

`warnedSignatures` persists for the entire todo run. No decay. The signatures are specific enough (`action+ref+url`) that false positives across distant turns are not a concern, and persistence guarantees the property "once warned, always blocking".

## Files touched

- `src/executor.js` — add closure-local state inside `runTodo` (the window, the `warnedSignatures` set, and a slot for the pending record), a small helper to build the signature, and the two-stage check around the existing action-execution block.

That is the entire change.

## Acceptance

Maps directly to the task doc's criteria:

- Landefeld `Accept all` overlay loop: turn 1 / 2 / 3 each click the same ref with overlay error and no URL change. At the start of turn 4 the third record finalizes, count reaches 3, the warning fires and is included in turn 4's prompt. If the driver retries the same click on turn 4 (typical), stage 2 terminates immediately. ≤ 4 REF_ACTION turns instead of 98+.
- Devstral edit/save alternation: window of 5 catches Ändern at count 3 (e.g. positions 1, 3, 5 of the window). Warning fires. On the next Ändern attempt, terminate.
- GPT sidebar repeat: identical mechanics to Landefeld, error component irrelevant since `sig` excludes it.
- Normal multi-step form filling: each field has a different ref, so signatures differ; no false positive.
- Stuck warning message explicitly tells the driver not to do that action+ref again.

## Non-goals

- No site-specific heuristics.
- No change to Playwright action semantics or to `lastError` content for non-stuck cases.
- No detection for repeated `wait` or `navigate` — those are recovery tools, not stuck candidates.
- No persistence across todos within a run; each todo starts with a fresh window and warning set.
