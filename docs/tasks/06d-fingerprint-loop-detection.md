# Task 06d: Fingerprint-Based Semantic Loop Detection

Source analysis: `docs/analysis/task-06-mvp-gaps.md` (gap #6).
Source acceptance bullet from Task 06: *"Repeated no-op actions are detected using normalized page fingerprints, not only `action|ref|url`."*
Builds on: Task 02 (existing stuck detection), Task 06 MVP (`fingerprint()`).

## Problem

The current stuck detection uses `action|ref|url` as the no-progress signature. It catches "click the same button repeatedly" but misses the broader patterns visible in the post-MVP traces:

- AIDA `2026-05-01T11-25H3492.json` repeated `click 'Kabine auswählen'` 5× and `'Weiter zur Kabinenauswahl'` 4× without tripping stuck detection — URL drifted between attempts so the sigs differed.
- Models that alternate between two different controls but end up in the same observable state.
- Navigation cycles: A → B → A → B with different signatures each time.

Task 06's acceptance criterion requires fingerprint-based no-op detection on top of the existing exact-sig detection, not in place of it.

## Goal

Track recent normalized snapshot fingerprints. Detect cycles where the model returns to a previously-seen state, regardless of how it got there. Warn first; terminate on persistence.

## Scope

In `src/executor.js`'s `runTodo`:

- Add `recentFingerprints` window (e.g. last 10 entries: `{ fingerprint, turn }`). Append at the end of every performed-action turn from the just-attached observation.
- After append, count how many entries in the window share the most-recent fingerprint.
- Threshold (start with 3): when the same fingerprint appears 3 times in the last 10 turns, set `lastError`:

```
You have returned to the same page state 3 times via different actions in the last 10 turns. The current approach is not making progress. Try a different strategy or fail with evidence.
```

- Track which fingerprints have already triggered the warning (`warnedFingerprints` set) to avoid repeating it.
- Optional escalation: if the same fingerprint appears 5 times after the warning, terminate the todo as `fail` with a structured reason (`fingerprint loop: 5 returns to state X`). This mirrors the two-stage Task 02 pattern.

Reuse `observation.fingerprintAfter` from the existing observation object (Task 06 MVP already computes it; we just need to keep it on the compact form — see Task 06f).

## Non-Goals

- No change to the existing `action|ref|url` stuck detection (this is additive).
- No fuzzy fingerprint matching.
- No site-specific cycle patterns.
- No suggestion of which alternative action to try.

## Acceptance Criteria

- A run that visits the same normalized page state 3 times within 10 turns receives a structured warning in the next prompt.
- If the loop continues to 5 visits, the todo terminates as `fail` with `fingerprint loop` in the evidence.
- An exact-sig stuck case still trips the existing Task 02 detection at its threshold (3) before the broader fingerprint check fires (since exact-sig implies same fingerprint too).
- Warnings appear in `result.warnings[]`.
- A normal multi-step run that visits each state at most once has no false positives.

## Notes

Depends on Task 06f (or this task can extend `compactObservation` itself) to retain `fingerprintAfter` in the per-step observation. Otherwise there's nothing to compare across turns at this layer.
