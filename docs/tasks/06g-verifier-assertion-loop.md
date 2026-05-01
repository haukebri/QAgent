# Task 06g: Deferred Verifier Assertion Loop

> **Status: deferred.** Do not implement before Task 06a result data proves a
> single terminal settle + single verifier call is insufficient.

## Problem

Task 06a intentionally uses a bounded terminal settle followed by one verifier
call. A stronger design would repeatedly observe and verify during a `done`
assertion window, similar to Playwright's `expect(...).toPass()`.

That design is not suitable yet:

- `src/verifier.js` creates a fresh verifier agent per call, so repeated
  verifier calls would pay the full prompt and snapshot cost each time.
- The verifier is stochastic. Repeated sampling can turn a false positive into
  a one-way ratchet: exit on the first accidental `pass`.
- Live timestamps, animations, spinners, and streaming UI can keep changing the
  snapshot and trigger unnecessary verifier calls until timeout.

## Preconditions

Only reconsider this task after:

- Verifier prompt caching or verifier session reuse is available.
- Task 06a has shipped and produced enough result data to show that
  settle-once / verify-once is empirically insufficient.
- The verifier loop can be tested with an injectable deterministic
  `verifierFn`.

## Possible Design

Add an `observeUntilVerified` helper with bounded polling:

```js
await observeUntilVerified(page, {
  previousSnapshot,
  previousUrl,
  maxMs: 10000,
  pollMs: 250,
  stableSamples: 3,
  verifierFn,
});
```

Candidate behavior:

- Observe until URL + normalized snapshot are stable.
- Run the verifier only when the stable fingerprint changes, plus once at
  timeout.
- Require `pass` plus one confirmation sample before accepting, so a single
  stochastic pass is not enough.
- Cap verifier calls per terminal gate.
- Record all verifier attempts with snapshot fingerprints and cost.

## Non-Goals

- Do not implement this in Task 06a.
- Do not poll the verifier every `pollMs`.
- Do not use external sites as the primary test coverage.

## Acceptance Criteria

- Unit tests can use an injectable deterministic `verifierFn`.
- A false-positive verifier response does not immediately end the assertion
  unless the confirmation rule also passes.
- Verifier calls are bounded and visible in result metadata.
- Cost impact is measurable before rollout to regular runs.
