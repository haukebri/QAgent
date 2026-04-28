# Review Follow-ups

Items surfaced by the README review (4 personas: AI user, architect, devops, PM) that are out of scope for the README itself. Listed by source and suggested action.

## Code / behavior

### 1. ndjson `done` envelope: `cost` and `totalTokens` are driver-only ✅ done

`src/reporters.js` — `ndjsonReporter().onEnd` previously emitted only the **executor (driver)** numbers as `cost` / `totalTokens`, silently dropping the **verifier**'s tokens and cost (`result.verifierTokens`). The `list` reporter summed them in its footer, so the two reporters disagreed on the same run.

**Resolution:** the `done` envelope now emits explicit, non-overlapping fields: `driverCost` / `verifierCost` / `totalCost` and `driverTokens` / `verifierTokens` / `totalTokens`. README ndjson schema updated to match.

Source: AI-user reviewer (asked what `cost` units / scope mean).

### 2. No wall-clock timeout ✅ done

`--max-turns` capped LLM turns but nothing capped wall time. A hung `navigate` or `fill` (page never settles) could pin the process indefinitely.

**Resolution:** added three timeout flags, all in seconds, with config + env layering:
- `--test-timeout` (default 300) — wall-clock loop budget. On hit, the loop exits cleanly and the verifier still runs against the final state (the verifier can read the trajectory and explain *why* the run timed out — that's the intent). Outcome follows the verifier's call, not a forced exit code.
- `--network-timeout` (default 30) — merges the previous `NAVIGATE_TIMEOUT_MS` (15s) + `OBSERVE_NETWORKIDLE_TIMEOUT_MS` (5s) into one knob covering `page.goto()` and post-action `networkidle` waits.
- `--action-timeout` (default 2) — replaces hardcoded `ACTION_TIMEOUT_MS` (1.5s); per click/fill actionability check.

Caveats: the wall-clock check fires at loop boundaries, so worst-case overshoot is one in-flight network call (~30s) or one LLM-decided `wait`. The verifier itself is not bounded by `--test-timeout`. Item #8 (navigate soft-fail) is unrelated and stays open.

Source: DevOps reviewer (CI hang risk), AI-user reviewer (orchestrator stall recovery).

### 3. No cost ceiling

A 2-turn run is `$0.0001`; a 20-turn run on a complex SPA can be orders of magnitude more. There's no `--max-cost` and no documented mechanism to abort when cost exceeds a threshold.

**Fix options:** add `--max-cost <usd>` flag that aborts mid-run when token cost crosses the threshold, exit code 3. Until then, `--max-turns` is the only knob.

Source: Architect reviewer (worst-case bounds), PM reviewer (budget predictability).

### 4. Trace filename collision risk

`record()` uses `results/<iso>.json` with `Date.now()` resolution. Two parallel `qagent` invocations on the same machine starting in the same millisecond would collide. Unlikely in practice but theoretically possible.

**Fix options:** append a short random suffix (e.g. 4-char nanoid) to the filename; or accept the risk and document.

Source: DevOps reviewer (concurrency on shared runners).

### 5. Verifier could optionally be pure-code

Today `src/verifier.js` is always an LLM judge. Some goals (e.g. "page contains 'Welcome'") have trivial deterministic verifiers; for those, a pure-code path would be cheaper and more reproducible.

**Fix options:** post-MVP, allow a goal to declare a deterministic post-condition (e.g. via a future spec format), and skip the LLM judge when present. Only worth doing once the spec format is on the table.

Source: Architect reviewer (questioning the README's "verifiers are pure code" claim, which was inaccurate — see #6).

### 8. `navigate` timeout is a soft-fail in practice

`src/tools.js:93-95` — `navigate()` throws when `page.goto()` exceeds `NAVIGATE_TIMEOUT_MS` (15s). That throw is caught one frame up in `src/executor.js:160-167`, recorded as the turn's `error`, and surfaced to the LLM via `lastError`. The driver then keeps going and typically retries or pivots.

That makes the navigate timeout a **soft-fail with a warning**, not a hard stop, even though the comment block in `tools.js` describes it as "fail fast" and implies abort. Net effect: a navigate timeout costs one turn + one error message and the run continues. Users observing this expect the run to terminate; today it doesn't.

**Fix options:** (a) leave the soft-fail behaviour but update the misleading comment; (b) make it a fatal error (push to `fatalError` instead of `lastError`) so the run aborts on a navigate timeout; (c) leave it soft-fail but bound the retry — N navigate timeouts in a row → fatal. The new wall-clock `--test-timeout` (#2) makes this less urgent, but the comment/behaviour mismatch is still a bug.

Source: User observation while planning the timeout overhaul.

## Documentation (outside the README)

### 6. `CLAUDE.md` falsely says verifier is pure code ✅ done

Both the project-overview line and the module table in `CLAUDE.md` claimed the verifier was pure code. Corrected to reflect that `src/verifier.js` is an LLM judge (separate model from the driver, takes goal + trajectory + final snapshot, returns `{outcome, evidence}`).

Source: Architect reviewer.

## Status messaging (process)

### 7. Maturity disclaimer was buried

The "Status: pre-1.0" line was originally at the bottom of the README, after polished CLI Reference and ndjson schema sections. Adopters reading top-to-bottom would form a "production-ready" impression before hitting the disclaimer. Being addressed in this round (callout moved above the fold).

Source: PM reviewer.
