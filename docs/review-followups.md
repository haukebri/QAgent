# Review Follow-ups

Items surfaced by the README review (4 personas: AI user, architect, devops, PM) that are out of scope for the README itself. Listed by source and suggested action.

## Code / behavior

### 1. ndjson `done` envelope: `cost` and `totalTokens` are driver-only

`src/reporters.js` — `ndjsonReporter().onEnd` populates:

```js
cost: result.tokens?.cost ?? 0,
totalTokens: result.tokens?.totalTokens ?? 0,
```

These are the **executor (driver)** numbers. The **verifier**'s tokens and cost (`result.verifierTokens`) are silently dropped from the ndjson envelope, even though the `list` reporter does sum them in its footer (so the two reporters disagree on the same run).

**Fix options:** sum driver + verifier into `cost` / `totalTokens`, or split into `driverCost` / `verifierCost` / `totalCost` (preferred — explicit). Either way, document in the README's ndjson schema after the fix lands.

Source: AI-user reviewer (asked what `cost` units / scope mean).

### 2. No wall-clock timeout

`--max-turns` caps LLM turns; nothing caps wall time. A hung `navigate` or `fill` (page never settles) pins the process indefinitely.

**Fix options:** add `--timeout <duration>` flag (e.g. `5m`, `90s`), kill the run + close the browser when hit, exit code 3. Or document `timeout(1)` as the official workaround and leave it at that.

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

## Documentation (outside the README)

### 6. `CLAUDE.md` falsely says verifier is pure code

Line 30 of `CLAUDE.md`:

> | verifier.js | End-state checks (pure code, no LLM) | — |

Same bug as the README. The README is being fixed in this round; `CLAUDE.md` should be corrected in the same spirit (the verifier is an LLM judge per `src/verifier.js`).

Source: Architect reviewer.

## Status messaging (process)

### 7. Maturity disclaimer was buried

The "Status: pre-1.0" line was originally at the bottom of the README, after polished CLI Reference and ndjson schema sections. Adopters reading top-to-bottom would form a "production-ready" impression before hitting the disclaimer. Being addressed in this round (callout moved above the fold).

Source: PM reviewer.
