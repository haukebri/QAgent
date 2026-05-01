# Task 06 MVP Gap Review

Date: 2026-05-01

This note records what is still missing from the first MVP implementation of
`docs/tasks/06-settle-and-diff-observation.md`.

The MVP is useful: result files now contain per-action `observation` metadata,
and the driver receives a concise "Previous action result" block before the next
snapshot. This makes failures much easier to understand. The remaining gaps are
about using that signal to make better terminal decisions and about completing
the generic readiness model described in the task.

## What The MVP Already Has

- `src/observe-settle.js` with snapshot fingerprinting, repeated observation,
  compact diffing, added/removed text, added/removed refs, and changed-section
  counts.
- Executor wiring so most performed non-terminal actions receive a compact
  `observation` object in result JSON.
- Follow-up prompts that include a concise previous-action summary before the
  current snapshot.
- Basic no-progress detection for repeated ref actions when the URL and
  snapshot do not change.
- Result recording that rewrites `settleMs` to `settleSec`, making the run
  artifacts easier to scan.

## Missing From The Full Task

### 1. Terminal `done` still does not run an assertion-style settle

Task 06 explicitly says that when the driver calls `done`, QAgent should not
verify the current single snapshot immediately. It should first run a settle /
observe pass and verify against the stable snapshot.

The MVP does not do this in the common path. If the previous action already has
an observation, `done` is accepted into the terminal verifier immediately. This
is why Gravity Forms can still fail right after submit: the submit click is
observed after roughly 0.2 seconds, the model calls `done`, and the verifier
judges the too-early form snapshot.

Required follow-up:

- Add a terminal pre-verifier observation step for every `done`.
- Use an extended timeout here, closer to Playwright assertion behavior.
- Record this terminal observation separately, or attach it to the terminal
  entry, so analysis can tell what snapshot the verifier actually judged.

### 2. The current settle condition is too eager

The MVP declares the page settled after two matching samples with a default
150ms poll interval. In the result files, most action observations settle in
0.2 seconds.

That is enough to say "the DOM was momentarily stable." It is not enough to say
"the user-visible result had enough time to appear."

Required follow-up:

- Keep the short settle for ordinary action feedback if desired.
- Add a longer assertion-style settle for terminal verification, for example:
  poll until a stable window is reached, but allow up to 10-30 seconds.
- Reset the stable window whenever URL or normalized snapshot changes.
- Run the verifier only after the browser is stable or the timeout expires.

This must stay generic. The wait is not "wait for form success"; it is "wait for
the browser state to stop changing before judging the natural-language goal."

### 3. `wait` actions bypass the settle loop

For `wait`, the MVP sleeps for the requested duration and then performs a single
observation with `settleMs: 0`.

That records what was visible at the end of the sleep, but it does not check
whether the page is still mutating after that point.

Required follow-up:

- After a `wait`, run the same settle sampler instead of a one-shot observe.
- Keep the explicit wait duration as the minimum delay, then settle from there.

### 4. The done gate is not observation-aware

The existing history guard rejects `done` when the previous action has an error.
That is sometimes correct, but the post-Task-06 data shows a counterexample:
a click can time out while the page still changes successfully to the desired
state.

In the Gravity pass, the click timed out, but the observation showed a large
page replacement and the final snapshot contained the thank-you message. The
history guard still rejected `done` twice before the cap allowed the verifier to
pass it.

Required follow-up:

- If an action errored but its observation shows meaningful URL or snapshot
  change, do not automatically reject `done`.
- Let the verifier judge the stable final state.
- Keep hard rejection for errors with no visible state change.
- Remove or redesign the cap-based retry behavior so it does not create fake
  recovery loops.

### 5. Ref-miss and pre-action validation failures still lack observation data

Several post-MVP result steps have no `observation` because the executor rejects
the action before running a browser tool, for example stale refs or invalid basic
auth navigation errors.

Task 06 wanted stale refs to be easier to interpret, especially when a ref is
missing because the page already changed successfully. The MVP often gives the
driver only "ref is not present" without attaching a fresh observation to that
failed turn.

Required follow-up:

- On stale-ref failures, observe the current page and record a compact
  observation or current-state marker.
- If the current page differs meaningfully from the snapshot that contained the
  old ref, say so explicitly in the next prompt.
- Distinguish "ref disappeared because the app progressed" from "model picked a
  ref that never existed in the latest snapshot."

### 6. Semantic loop detection is still narrow

The MVP detects repeated no-progress actions mainly through
`action|ref|url`. That catches some repeated clicks on the same control, but it
does not fully implement the Task 06 acceptance criterion:

> Repeated no-op actions are detected using normalized page fingerprints, not
> only `action|ref|url`.

Required follow-up:

- Track recent normalized page fingerprints independently of exact ref/action.
- Detect loops where the model alternates between different controls but returns
  to the same state.
- Use this as a deterministic fail or strong prompt intervention once a bounded
  threshold is reached.

### 7. Readiness signals are incomplete

The task called for generic readiness indicators beyond snapshot equality:

- `document.readyState`
- pending requests
- empty page detection
- skeleton / loading-state hints
- still-loading indicators

The MVP currently relies mostly on aria snapshot fingerprint stability.

Required follow-up:

- Add a lightweight readiness probe around observation.
- Record readiness metadata in compact form.
- Include it in the previous-action result when it explains why the page should
  not be judged yet.

### 8. Stored metadata is useful but not complete enough for deeper analysis

The MVP stores `summaryTier`, added/removed text and refs, and
`changedSectionsCount`. It strips the actual section changes and fingerprints
from the recorded compact observation.

That keeps results small, but it makes later analysis harder when we need to
know which area changed or whether two states are identical.

Required follow-up:

- Store a small stable fingerprint before/after, or a redacted short hash.
- Store a capped list of changed section descriptors, not only the count.
- Store terminal verifier observation metadata so verifier decisions can be
  audited without manually opening snapshots.

## Priority Order

1. Add terminal assertion-style settle before verifier.
2. Make the done/history guard observation-aware.
3. Settle after explicit `wait` actions.
4. Add stale-ref current-state observation.
5. Expand semantic loop detection beyond exact `action|ref|url`.
6. Add readiness probes and richer compact metadata.

The first two items are the biggest correctness gap. They directly explain why
the post-MVP Gravity runs are clearer but still mostly failing.
