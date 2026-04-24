# tasks

Optimizations for the single-goal CLI (`src/demo.js` + executor loop).
Investigate and tackle one at a time. Not ordered by priority.

## 1. Better trust in `done` / `fail` without hardcoded rules — DONE

Done in commit `2362bc9`. Spec:
`docs/superpowers/specs/2026-04-24-verifier-design.md`.

`src/verifier.js` is now an LLM judge over (goal, driver verdict,
action history, final URL, final snapshot) and is the source of truth
for the run outcome. Outcome is binary (`pass` / `fail`); `stuck` is
gone. The terminal-state bug (`done` / `fail` downgraded to `stuck`
when `summary` / `reason` missing) is fixed along the way. Amends
`docs/project-architecture.md` — verifier.js is no longer "pure code,
no LLM".

## 2. Keep the LLM session alive across turns DONE

`executor.js:110` calls `agent.reset()` every turn, so the system
prompt + full snapshot are re-sent on every single call. A 20-turn run
re-sends the same ~2–3 KB of system prompt 20×, and each snapshot
round-trips fresh with no prompt caching.

Proposed direction: keep one conversation. After each action, append
an assistant/tool-style turn like
`"I did as you asked. New URL: ... New snapshot: ..."` and let the
model continue. Expected win: meaningful token reduction + prompt
caching becomes possible on providers that support it.

Needs: check what `pi-agent-core` exposes for continuing a session,
and how snapshots should be represented so older ones don't bloat
context.

## 3. Click timeout issues DONE

Seen in real run results: clicks occasionally time out. Symptoms and
root cause not yet characterized (element detached? navigation in
flight? animation? overlay?).

Todo: collect 2–3 failing traces, then decide whether the fix is in
`tools.js` (smarter click wait), in the executor (retry policy), or
upstream in the observer (don't surface refs for elements that aren't
ready).

## 4. Richer action descriptions in the trace — DONE

Done in commit `2362bc9` alongside task 1. Click / fill history entries
now carry a `target` field like `"button 'Sign in'"`, parsed from the
ariaSnapshot line via `labelForRef` in `src/executor.js`. Each entry
also carries a `url` field captured after the action settles, so the
trace shows navigation journeys without cross-referencing snapshots.

## 5. Observer signal filtering (future)

`observer.js` returns whatever `ariaSnapshot({ mode: 'ai' })` produces.
Known noise source: cookie banners, which burn turns on every run that
starts on a fresh origin. Ads, chat widgets, analytics modals are
plausible but unverified.

Deferred: we don't yet know what else is worth filtering, and
premature filtering risks hiding real UI the test needs. Revisit once
we have enough run traces to see the actual noise distribution.

## 6. Always write a result file, including setup failures

Today `src/demo.js` only normalizes failures that happen inside
`runTodo()`. If browser launch, context creation, init-script injection,
or `newPage()` fails, the process exits before `record()` runs.

That leaves the least observable failures with no artifact, which fights
the architecture note that every run should produce a result file.

Proposed direction:

- Wrap the whole startup + execution path in one result accumulator.
- Normalize setup failures into the same result shape we already record
  for executor failures (`outcome: 'error'`, single-line reason,
  whatever URL/history are available).
- Keep the trace format consistent so downstream tooling does not need a
  second code path for "failed before the loop started".

## 7. Make locale / timezone configurable instead of hard-coded

`src/demo.js` and `src/observe.js` hard-code `locale: 'en-US'` and
`timezoneId: 'Europe/Berlin'`. That may help with a stable browser
fingerprint, but it also bakes hidden assumptions into every run.

This can skew tests that depend on formatting, translations, time zones,
regional defaults, or geo-sensitive flows.

Proposed direction:

- Keep a sensible default for anti-bot stability, but make locale and
  timezone explicit inputs to the runner / CLI.
- Document the default behavior and when to override it.
- Decide whether these belong in the spec, CLI flags, env vars, or some
  combination of the three.
