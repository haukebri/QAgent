# Task 06f: Richer Recorder Metadata

Source analysis: `docs/analysis/task-06-mvp-gaps.md` (gap #8).
Builds on: Task 06 MVP, Task 06a (terminal observation), Task 06d (needs `fingerprintAfter`), Task 06e (needs `readiness`).

## Problem

`compactObservation` strips the snapshot fingerprints and the full `changedSections` list, keeping only `changedSectionsCount`. This minimizes per-step JSON size but makes downstream analysis painful:

- "Are these two states actually identical?" requires re-opening snapshot files.
- "Which area of the page changed?" requires re-running `sliceSections` over the snapshots.
- Task 06a adds a terminal/verdict observation that needs a clean place to live in the result JSON.
- Task 06d (fingerprint loop detection) needs `fingerprintAfter` retained in the compact form.
- Task 06e (readiness) wants `readiness` retained too.

## Goal

Expand the recorder schema with the minimum metadata needed for offline analysis, while keeping per-step JSON small.

## Scope

### `compactObservation` retentions

Extend `src/observe-settle.js`'s `compactObservation` to also keep:

- `fingerprintBefore` (sha1 hex, 40 chars).
- `fingerprintAfter` (sha1 hex, 40 chars).
- `changedSections` capped at first 5 entries (`{ role, ref, deltaChars }`); the existing `changedSectionsCount` stays.
- `readiness` (whatever shape Task 06e settles on); pass-through.

Existing caps stay (text 20, refs 50, prompt-side 5/80).

### Top-level result JSON additions

In `src/recorder.js` `buildPayload`:

- `verdictObservation`: the compact observation captured during the terminal settle (Task 06a). Mirrors the per-step shape; placed top-level alongside `evidence`, `finalUrl`, etc.
- Optional: `goalFingerprintTrail`: an ordered list of fingerprints the run visited, for cross-run analysis. Cheap to add; can defer if not needed.

### Schema doc

Add a brief schema section to `docs/project-architecture.md` (or a new `docs/result-schema.md`) listing every persisted field with one-line descriptions. The result file is becoming the primary debugging artifact; an authoritative description prevents future drift.

## Non-Goals

- No persistence of full snapshots inline (they remain in `*.snapshot.yaml` next to the result).
- No new query layer or result-file tooling.
- No retroactive migration of older result files.

## Acceptance Criteria

- Every step's compact observation contains `fingerprintBefore`, `fingerprintAfter`, and a capped `changedSections` list.
- Result JSON has a top-level `verdictObservation` field on every run that ended with `done` or `fail`.
- A run that hits Task 06d's fingerprint-loop detection can be diagnosed from the result JSON alone (no snapshot re-reading).
- Per-step JSON size grows by < 200 bytes on average (two 40-char sha1s + at most five short objects).
- Schema doc lists every persisted field.
