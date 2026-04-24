# tasks

Optimizations for the single-goal CLI (`src/demo.js` + executor loop).
Investigate and tackle one at a time. Not ordered by priority.

## 1. Better trust in `done` / `fail` without hardcoded rules

Today pass/fail is whatever the LLM declares. The one guard is the
`initialUrl` check in `executor.js:88`. Heuristics like "reject done if
URL still matches /login" are out — they break legitimate tests (e.g.
testing the login form itself).

Two review findings belong here:

- `executor.js` currently treats `done` as terminal only when
  `summary !== null`, and `fail` as terminal only when `reason !== null`.
  Because the prompt schema makes both fields optional, a real terminal
  action can currently be downgraded to `stuck`. That is a correctness
  bug in the loop, not just a product-design question.
- Even when `summary` / `reason` are present, pass/fail is still pure
  model self-report. There is no code-side grounding step or verifier
  gate before we record the result.

Open question: how do we raise trust in the LLM's verdict without
baking in assumptions about what an app looks like? Options to explore
(none picked yet):

- First, make terminal state explicit in executor state (`done` / `fail`
  seen) instead of inferring it from payload presence. Decide separately
  whether missing `summary` / `reason` should be a hard error, a retry,
  or a degraded-but-terminal result.
- Second-pass verification turn: after `done`, re-observe and ask the
  model to justify the verdict against the fresh snapshot.
- Require the `summary` / `reason` to reference text actually present
  in the final snapshot (content-grounding check, still generic).
- Lean on the architecture's eventual `verifier.js` — but per-test
  end-states belong to specs, which is out of scope for now.

No implementation yet. Needs a design pass.

## 2. Keep the LLM session alive across turns

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

## 3. Click timeout issues

Seen in real run results: clicks occasionally time out. Symptoms and
root cause not yet characterized (element detached? navigation in
flight? animation? overlay?).

Todo: collect 2–3 failing traces, then decide whether the fix is in
`tools.js` (smarter click wait), in the executor (retry policy), or
upstream in the observer (don't surface refs for elements that aren't
ready).

## 4. Richer action descriptions in the trace

The trace is the primary debugging tool, but `{"action":"click","ref":"e6"}`
alone is uninformative — you can't tell what was clicked without
cross-referencing the snapshot from the same turn.

Proposed direction: at action time, pull a short label from the
snapshot (role + accessible name, e.g. `button['Buy now']`,
`textbox['Email']`) and attach it to the history entry. Shape TBD —
something like `{"action":"click","ref":"e6","target":"button['Buy now']"}`.
Applies to click and fill; navigate already has a URL.

Keep it cheap — read from the already-captured snapshot string, don't
do a second Playwright query.

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
