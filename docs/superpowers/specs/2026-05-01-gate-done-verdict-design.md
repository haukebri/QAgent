# Gate Driver `done` Before Ending a Run

Date: 2026-05-01
Task: `docs/tasks/03-gate-done-verdict.md`

## Problem

The driver LLM sometimes calls `done` while the final page state clearly does not satisfy the goal. The end-of-run verifier catches these as failures, but the executor has already exited the loop, so the driver never gets a chance to recover from an overconfident `done`.

Audit of recent runs (17/17 driver-said-done-but-verifier-failed cases sampled) showed every verifier `evidence` sentence was already actionable — describing the page state in a way that implicitly tells the driver what is still missing (disabled Search button, form still visible, validation text present, wrong AIDA step). The bottleneck is purely that this evidence is generated too late and never reaches the driver.

## Goal

Before accepting `done` as terminal, run a generic gate that can reject the candidate and feed actionable feedback back to the driver, so the loop continues. The gate must be site- and goal-agnostic (no phrase lists, no domain heuristics).

`fail` remains terminal and unchanged — the driver retains an explicit escape hatch when the goal is genuinely impossible.

## Non-Goals

- Do not replace the end-of-run verifier — it remains the source of truth for the final pass/fail decision.
- Do not introduce phrase lists, regex patterns for validation errors, or site-specific heuristics. The gate must work without understanding the goal text.
- Do not change the `fail` action path.
- Do not block `done` when neither check finds a contradiction.

## Design

Add a function `validateDoneCandidate` in `src/executor.js`. Invoke it inside `runTodo` when the driver returns `action.action === 'done'`, before the existing terminal branch accepts the verdict. The function runs two checks in order; the first one that fires causes a rejection.

### Check 1: History guard (deterministic, no LLM call)

Walk `history` from the end backwards and find the most recent entry whose `action?.action` is **not** `done` (skipping over earlier rejected-`done` entries so we don't double-flag them). If that entry has an `error` field — meaning the action threw, was rejected for missing ref, failed JSON parsing, or hit any other error path the executor records — reject `done` and set:

```
lastError = "Your previous action did not succeed: <err>. Resolve the failure or fail with a reason."
```

If there is no such entry yet, or the most recent non-`done` entry has no error, the guard passes and check 2 runs.

This catches the "driver hit a block and gave up" pattern without an LLM call.

### Check 2: Verifier gate (one LLM call per attempted `done`)

If the history guard does not fire, call the existing `verify()` from `src/verifier.js` with the current state:

```
verify(goal, { action: 'done', summary, reason }, history, url, snapshot, judgeModel, apiKey)
```

Inputs are exactly what the verifier already takes at end-of-run — no new prompt, no new model. If the verifier returns `outcome: 'fail'`, set:

```
lastError = "Verifier rejected done: <evidence>. Continue working or fail with a reason."
```

If the verifier returns `outcome: 'pass'`, accept `done` and break out of the loop normally.

If the verifier call itself throws after its internal retry, treat it as inconclusive: accept `done`, emit a warning naming the verifier failure, and rely on the end-of-run verifier path.

### Rejection accounting

- Maintain a `doneRejections` counter scoped to the current `runTodo` invocation.
- Increment on each rejection (history-guard or verifier-gate).
- When `doneRejections >= 2` and the driver attempts another `done`, **skip the gate entirely** for that attempt: accept `done`, emit a cap-reached warning, and break.
- The cap is shared across both checks. After two rejections of any kind, the third `done` passes through.

### Token accounting

The verifier-gate call's `usage` object is added to the existing `tokens` totals on the run. This keeps cost/token reporting accurate without introducing a new field.

### History entry on rejection

Each rejection appends an entry to `history` so subsequent driver turns see it in the "Recent actions" block:

```js
{ turn: turns, atMs: Date.now() - t0, action, url, error: doneProblem }
```

The same entry is delivered through `onTurn?.()` so reporters see rejections live.

### Warnings emitted to `warnings[]`

The run result's `warnings` array gains entries for every gate event:

- History-guard rejection: `done-gate: rejected by history guard at turn N — previous action errored: <err>`
- Verifier-gate rejection: `done-gate: verifier rejected done at turn N — <evidence>`
- Verifier-gate inconclusive: `done-gate: verifier call failed at turn N (<error>) — accepting done`
- Cap reached: `done-gate: cap reached (2 rejections) at turn N — accepting done; end-of-run verifier is authoritative`

Warnings are visible in the standard run output without parsing `history`.

## Code shape

In `runTodo`, the `done`/`fail` branch becomes:

```js
if (action.action === 'done') {
  if (doneRejections < 2) {
    const doneProblem = await validateDoneCandidate({
      goal, url, snapshot, action, history, judgeModel, apiKey, tokens, warnings, turns,
    });
    if (doneProblem) {
      doneRejections++;
      lastError = doneProblem;
      const rejEntry = { turn: turns, atMs: Date.now() - t0, action, url, error: doneProblem };
      if (usage) rejEntry.tokens = stepTokens(usage);
      history.push(rejEntry);
      onTurn?.(rejEntry);
      continue;
    }
  } else {
    warnings.push(`done-gate: cap reached (2 rejections) at turn ${turns} — accepting done; end-of-run verifier is authoritative`);
  }
}

if (action.action === 'done' || action.action === 'fail') {
  // existing terminal branch unchanged
}
```

`validateDoneCandidate` itself is a small function in the same module that runs the history guard, then the verifier gate, then returns a `lastError` string or `null`. It mutates `tokens` and `warnings` directly (consistent with how the surrounding loop already accumulates them).

## Acceptance criteria

- A driver `done` immediately after a tool error is rejected by the history guard, the rejection is recorded in `history` and `warnings`, and the loop continues.
- A driver `done` while the verifier judges the goal incomplete is rejected, the verifier's `evidence` is fed back as `lastError`, the rejection is recorded in `history` and `warnings`, and the loop continues.
- After two rejections within a single todo, the next `done` attempt is accepted, a cap-reached warning is emitted, and the run terminates normally.
- A valid `done` (verifier `pass`) terminates the loop with no extra warnings.
- Verifier-gate token usage is included in `tokens` totals.
- The end-of-run verifier still runs on the accepted verdict and remains the source of truth for `outcome`.
- `fail` action path is unchanged.
- No phrase lists, regex patterns, or site-specific heuristics are introduced.

## Out of scope

- Changes to the verifier prompt itself.
- Changes to the stuck-detection mechanism from task 02 (it operates upstream and remains independent).
- Changes to result-file schema beyond additions to existing `warnings[]` and `history[]` arrays.
