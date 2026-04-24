# Verifier design

Date: 2026-04-24
Status: design approved, not yet implemented
Scope: `docs/tasks.md` task 1 (trust in `done`/`fail`) and task 4 (action target labels)

## Problem

Today pass/fail is whatever the LLM declares inside the executor loop. There is no code-side grounding. Two concrete issues in `src/executor.js`:

1. **Terminal-state bug.** `done` counts as terminal only when `summary !== null`, and `fail` only when `reason !== null`. Both fields are optional in the schema, so a real terminal action with missing text silently becomes `stuck`.
2. **Self-report only.** Even with text present, the verdict is never cross-checked against the final page state or the trajectory that produced it.

We need a gate between "LLM says done" and "result file says pass" that uses only generic signals (goal + trajectory + final page state), so it stays test-agnostic and does not bake in assumptions about what an app looks like.

## Decisions

- **Binary outcome.** `pass` | `fail`. `stuck` is removed as a final outcome. `error` stays for infra failures.
- **Hard gate.** The verifier is the source of truth. Its outcome replaces the LLM's verdict in the result file; the LLM's raw verdict is preserved for debugging.
- **LLM-based verifier.** `verifier.js` becomes a single LLM call over frozen executor state, not pure code. This **amends `docs/project-architecture.md:26`**, which currently states verifier.js is "pure code, no LLM". Update that file as part of the change.
- **Decision-time snapshot.** The verifier receives the final snapshot captured inside the executor loop, not a fresh observation. Re-observing would race against UI state that motivated the verdict (toasts, focus state, conditional buttons like "buy" appearing only when all fields are filled).
- **One retry, then fall back.** If the verifier call fails or returns unparseable JSON twice, fall back to the LLM's verdict and record a warning. Verifier outages do not translate 1:1 into test failures.
- **Separately configurable judge model.** Optional `VERIFIER_MODEL` env var; if unset, verifier uses `LLM_MODEL`. Same API key.

## Module changes

### `src/verifier.js` (new)

One export:

```js
export async function verify(goal, verdict, history, finalUrl, finalSnapshot, model, apiKey)
// verdict:  { action: 'done'|'fail'|'stuck', summary?: string, reason?: string }
// history:  [{ turn, action, target?, error? }]
// returns:  { outcome: 'pass'|'fail', evidence: string, tokens: {input, output, cost} }
// throws:   VerifierError after one retry
```

No dependency on `playwright`. Uses `pi-ai` / `pi-agent-core` the same way executor.js does.

### `src/executor.js`

- Track `verdict = { action, summary, reason }` explicitly when the loop exits on `done` or `fail`. Loop also exits on turn cap with `verdict = { action: 'stuck' }`.
- Capture the final turn's snapshot (`finalSnapshot`) and final URL before returning.
- At action time, for `click` / `fill`, attach a `target` label to the history entry using the parsed role/name from the current snapshot (task 4 — details below).
- After the loop, call `verify(...)`. Return:
  ```js
  {
    outcome,            // 'pass' | 'fail' | 'error'
    evidence,           // verifier's one-sentence justification, or fallback reason
    llmVerdict,         // { action, summary, reason } as seen from the loop
    turns, elapsedMs,
    tokens,             // executor tokens
    verifierTokens,     // verifier call tokens
    finalUrl, finalSnapshot,
    history,
    warnings,
  }
  ```
- On `VerifierError`, fall back: `done+summary` → `pass`; `fail+reason` → `fail`; anything else (including bare `done`/`fail` without text, and `stuck`) → `fail` with a synthesized reason. Append warning: `verifier unavailable: <msg>; fell back to driver verdict`.
- Infra exceptions in the loop still produce `outcome: 'error'` and skip the verifier (no verdict to verify).

### `src/tools.js`

Add an internal helper for extracting the target label from a snapshot line:

```js
// Given an ariaSnapshot string and a ref like "e6", return "button 'Add to cart'"
// or null if not found. String parsing only, no Playwright call.
function labelForRef(snapshot, ref)
```

This is not exported if the two-export cap in `src/tools.js` is tight. It can live in `src/executor.js` or be inlined — implementation detail. The contract: one cheap call per click/fill action.

### `src/recorder.js`

Record both `outcome`/`evidence` and `llmVerdict` at the top level of the trace file, plus `finalSnapshot`, `verifierTokens`, and per-step `target` labels. Disagreement between driver and judge must be visible in a single glance at the trace.

### `docs/project-architecture.md`

Update the `verifier.js` entry. Proposed text:

> End-state judge. Single LLM call over (goal, driver verdict, action history, final URL, final snapshot); returns `{ outcome: 'pass'|'fail', evidence }`. Source of truth for the run's outcome. Does not call playwright — the executor freezes state and passes it in.

## Target labels (task 4)

Inside the executor, right before pushing a `click` or `fill` entry to history, look up the ref in the current snapshot and attach `target: "<role> '<name>'"`. Examples:

```json
{"turn": 2, "action": {"action": "click", "ref": "e6"}, "target": "button 'Sign in'"}
{"turn": 3, "action": {"action": "fill", "ref": "e40", "value": "jane@example.com"}, "target": "textbox 'Email'"}
```

If the ref is not present in the snapshot, the action would already have been rejected earlier in the loop; if the label cannot be extracted, omit `target` rather than synthesizing one. Navigate actions already carry their URL, no label needed.

## Judge prompt

Single call, JSON response, same request pattern as the executor's `askNextAction`.

```
You are a QA verifier. Given a goal, the action trajectory an AI driver took,
and the final page state, decide whether the goal was actually achieved.

Respond with a single JSON object and nothing else:
  { "outcome": "pass" | "fail",
    "evidence": "<one sentence citing concrete text/URL/elements from the
      final snapshot or history that justifies the outcome>" }

Rules:
- Base the decision on evidence actually present in the inputs below. Do not
  infer facts that are not visible.
- The driver's own verdict is one signal but not authoritative — if the
  trajectory shows repeated errors on the same ref or no meaningful
  progress, that is evidence of failure regardless of what the driver said.
- If the goal asks a question, the evidence sentence must contain the
  answer, or explicitly state the answer is not present.

Goal: <goal>
Driver verdict: <verdict JSON>
Final URL: <url>
Actions taken:
  1. {"action":"navigate","url":"..."}
  2. {"action":"click","ref":"e6","target":"button 'Sign in'"}
  ...
Final snapshot:
<snapshot>

Your JSON:
```

Notes:
- Driver verdict is shown, not hidden. Hiding it would cause the judge to re-derive the same reasoning less reliably; showing it lets the prompt name it as "one signal, not authoritative".
- Single-sentence evidence forces citation over vibes and keeps traces readable. No scratchpad field — add later if small-model judges need it.

## Error handling summary

| Condition | Outcome |
|---|---|
| Loop terminates on `done` with summary, verifier agrees | `pass`, evidence from verifier |
| Loop terminates on `done` with summary, verifier disagrees | `fail`, evidence from verifier |
| Loop terminates on `fail` with reason, verifier agrees | `fail` |
| Loop terminates on `fail` with reason, verifier says pass | `pass` (upgrade) |
| Turn cap hit (no terminal action), verifier finds evidence | `pass` (salvage) |
| Turn cap hit, verifier finds no evidence | `fail` |
| Verifier call fails twice | Fall back to driver verdict; record warning |
| Browser / infra exception inside loop | `error`; verifier skipped |

## Config

New optional env var:

- `VERIFIER_MODEL` — OpenRouter model id for the judge. Falls back to `LLM_MODEL` if unset.

Existing env unchanged: `LLM_MODEL`, `LLM_API_KEY`, `BASIC_AUTH_USER`, `BASIC_AUTH_PASS`.

## Result file shape

```json
{
  "timestamp": "...",
  "goal": "...",
  "model": "<executor model>",
  "verifierModel": "<verifier model>",
  "outcome": "pass",
  "evidence": "Final snapshot shows 'Order confirmed' heading and URL is /orders/42.",
  "llmVerdict": { "action": "done", "summary": "Order placed." },
  "finalUrl": "...",
  "finalSnapshot": "<snapshot YAML>",
  "stats": {
    "turns": 5,
    "elapsedMs": 12345,
    "tokens": { "input": ..., "output": ..., "totalTokens": ..., "cost": ... },
    "verifierTokens": { "input": ..., "output": ..., "totalTokens": ..., "cost": ... }
  },
  "steps": [
    { "turn": 1, "action": { "action": "navigate", "url": "..." } },
    { "turn": 2, "action": { "action": "click", "ref": "e6" }, "target": "button 'Sign in'" }
  ],
  "warnings": []
}
```

## Out of scope

- Per-test end-state verifiers defined in specs (task 1's "eventual `verifier.js`" option). Belongs with runner/planner work.
- Re-observing the page during verification.
- Multi-todo runs. Still single-goal CLI.
- Judge self-consistency (N-of-M voting).
- Automated test suite for the verifier itself.
