# Task 06e: Readiness Probes

Source analysis: `docs/analysis/task-06-mvp-gaps.md` (gap #7).
Source background: Task 06 "Browser-Use Research" section (light page-readiness checks, pending-request tracking, empty/skeleton hints).
Builds on: Task 06 MVP, Task 06a (terminal settle predicate).

## Problem

The MVP uses aria snapshot fingerprint stability as the only readiness signal. That misses cases where:

- The DOM is briefly stable mid-mutation (between two render passes).
- The page returns `document.readyState === 'loading'` or `'interactive'` because resources are still in flight.
- The page is showing a skeleton/loading screen that has stable content (e.g. shimmer placeholders) but no real data yet.
- Pending network requests indicate a result is still rendering.

The settle loop (and especially the assertion-style settle from Task 06a) should not declare "settled" while these signals indicate work in progress.

## Goal

Add lightweight, generic readiness probes around observation. Combine them with the fingerprint-stability signal in the settle predicate. Surface readiness state in the prompt block when it explains why the page should not be judged yet.

## Scope

### Probe collection

New `readinessSnapshot(page)` (in `src/observe-settle.js` or a new `src/readiness.js`) that returns:

```js
{
  readyState,              // 'loading' | 'interactive' | 'complete'
  pendingRequests,         // count of in-flight fetches/XHRs (via Performance API)
  looksEmpty,              // true if the snapshot has fewer than N visible nodes/text
  looksLoading,            // true if the snapshot contains skeleton/spinner-like patterns
}
```

Implementations:

- `readyState`: `await page.evaluate(() => document.readyState)`.
- `pendingRequests`: `await page.evaluate(() => performance.getEntriesByType('resource').filter(r => r.responseEnd === 0).length)`. Lightweight; no event listeners.
- `looksEmpty`: heuristic over the YAML — count of `[ref=eN]` tokens below a threshold (e.g. < 5) AND total length < 500 chars.
- `looksLoading`: regex over the YAML for common loading/skeleton role names: `/^\s*-\s*progressbar\b/m`, `/^\s*-\s*\w+\s+"(Loading|Loading\.\.\.|Bitte warten)"/im`, generic-with-skeleton-class hints. Keep the patterns generic; no site-specific text.

### Plumb into observation

Extend the observation object with a `readiness` sub-field. The compact form retains it.

### Settle integration

In `observeWithSettle` (and the Task 06a extended-settle variant), after the fingerprint-stability check passes, also require `readyState === 'complete' && pendingRequests === 0 && !looksLoading` before declaring settled. If those fail and budget remains, keep polling.

In the prompt block, when `readyState !== 'complete'` or `looksLoading === true`, append a one-line note:

```
Page state: still loading (readyState=interactive, 3 pending requests).
```

### Cost concerns

Three `page.evaluate` calls per settle iteration is non-trivial. Mitigate by:
- Combining all four probes into a single `evaluate` call.
- Skipping the `looksEmpty` / `looksLoading` regex passes when the snapshot length is large (cheap heuristic: > 5000 chars).

## Non-Goals

- No fancy network-request hooking (keep the probe in a single eval).
- No site-specific selectors or text strings.
- No interaction with the page (these are read-only).

## Acceptance Criteria

- Every `observation` includes a `readiness` sub-field with the four signals.
- The settle predicate considers readiness when deciding "settled."
- A "Page state: still loading" line appears in the prompt block when relevant.
- Compact observation persists readiness in result JSON for analysis.
- No measurable per-turn latency regression on quiet pages (one probe call is < 10ms).
