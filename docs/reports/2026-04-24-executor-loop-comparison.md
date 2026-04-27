# Executor loop: tool-driven vs advisor-driven

Date: 2026-04-24
Status: decided — advisor-driven (Option B) selected

## Context

QAgent's executor takes a goal + a Playwright `page` and drives the browser toward the goal via an LLM. Before picking a single implementation, we wanted empirical data on two fundamentally different control-flow designs, because the choice affects cost, robustness, and model-range — all of which matter for this project (natural-language tests, model-agnostic via OpenRouter, "small local models eventually").

## The two approaches

**Option A — tool-driven (`src/executor-tools.js`, now removed).**
The LLM drives. `navigate`, `click`, `fill`, `done`, and `fail` are registered as pi-agent `AgentTool`s. pi-agent owns the loop: the model emits a tool call, pi-agent runs our tool, feeds the result back into the conversation, asks the model again. Loop ends when the model calls `done`/`fail` (which return `terminate: true`) or when we hit the turn cap via a `turn_end` subscriber.

**Option B — advisor-driven (`src/executor-plan.js`).**
We drive. Each turn is explicit: `observe(page)` → ask the LLM for a single-turn JSON action → dispatch via `tools.js` → repeat. A single pi-agent `Agent` is reused across turns with `agent.reset()` between calls. State that the LLM needs between turns is folded back into the prompt as a small ring buffer ("recent actions").

## What we did

Both implementations were built against the same `observer.js` and `tools.js`. Three test cases of increasing difficulty:

1. **Simple click-through.** Navigate to `example.com`, click the "More information..." link, land on iana.org.
2. **Login + extraction.** Navigate to a real app behind basic auth, log in via form, go to `/admin`, report the number of projects.
3. **Unachievable verification.** Same login flow, but verify a claim that is known to be false on the target app ("I can see a list of users" — the admin page only shows counts). Correct outcome: both should report FAIL, not fabricate a success.

Models tested on the hardest case (unachievable):

- **qwen 3.6** (strong): one run each
- **qwen 3.5 flash** (mid-tier): three runs each, repeated post-fix
- **gemma-4-26b-a4b-it** (cheap): five runs of A, four runs of B

## Findings

### Reliability

| Test | A correct verdict | B correct verdict |
|---|---|---|
| Simple click-through | 1/1 | 1/1 |
| Login + extraction | 1/1 | 1/1 |
| Unachievable (qwen 3.6) | 1/1 | 1/1 |
| Unachievable (qwen 3.5 flash, pre-fix) | 3/3 | 1/3 (2 false PASS) |
| Unachievable (qwen 3.5 flash, post-fix) | 3/3 (run 1 fabricated reason) | 3/3 |
| Unachievable (gemma-4-26b) | **0/5** (never terminates) | 4/4 |

Two distinct failure modes surfaced:

- **A on Gemma: never calls the terminal tool.** The model navigates, logs in, reaches admin, then keeps emitting non-terminal tool calls or just stops. It's capable of acting but not of *stopping* via a tool. Tool calling support varies by model in ways that only show up under pressure.
- **B on qwen 3.5 flash (pre-fix): false PASS on transitions.** Without conversation memory, the LLM saw a "Signing in..." disabled-button page and confabulated a success summary without recognizing that it had just clicked submit and the page was mid-transition. Fixed by adding a 5-action ring buffer to the prompt and a `wait` action.

### Cost

One run each on qwen 3.5 flash, unachievable goal:

| | A | B | Ratio |
|---|---|---|---|
| Turns | 17 | 10 | — |
| Wall clock | 49.2 s | 31.1 s | B ~1.6× faster |
| Input tokens | 122,916 | 21,482 | **A ~5.7× more** |
| Output tokens | 1,268 | 193 | A ~6.6× more |
| Cost (USD) | $0.0083 | $0.0014 | **A ~6× pricier** |

The token gap is the sleeper finding. A re-sends the full conversation every turn, so context (and cost) grows roughly linearly with turn count. B's per-turn context is system prompt + goal + current snapshot + last 5 actions — approximately constant regardless of test length. The ratio would widen on longer tests.

### Assumptions that held up

- "The LLM can drive a browser via aria-refs." ✓ Works across all models tested.
- "Playwright's ai-mode `ariaSnapshot` is enough context for the LLM." ✓ Even dense pages (HN with ~1000 lines) were parseable.
- "Error-feedback to the LLM is sufficient to recover from bad tool calls." ✓ Validated in B; A handled it implicitly via pi-agent's toolResult channel.

### Assumptions that didn't

- "Tool calling is universally reliable across OpenRouter models." **No.** Gemma emitted tool calls but didn't reliably pick terminal tools. Any approach that relies on the model spontaneously stopping via a tool is model-fragile.
- "Conversation memory is strictly better than stateless turns." **No**, not at the cost ratios we observed. Memory helped A avoid some decision errors but tripled+ the token cost.
- "More sophisticated A prompting would fix Gemma." We tried (strengthened 'MUST call done or fail', turn pressure via `steer()`, `thinkingLevel: 'low'`). The fixes regressed qwen 3.5 flash (1/3 correct vs 3/3) and were reverted. This class of fix is load-bearing on specific model behaviors and brittle across a provider matrix.

### Side effects worth keeping

Things discovered while building the experiment and committed as permanent improvements:

- `observer.js`: added `page.waitForLoadState('networkidle')` before snapshot. Caught while building B — SPA route changes leave the old DOM loaded and the new page's body un-attached if you observe too fast.
- `tools.js`: lowered click/fill action timeout from Playwright's 30 s default to 10 s. A wrong ref inside an LLM loop shouldn't cost a third of a minute before the model can reconsider.
- B's executor: 5-action history in the prompt, `wait` action, ref-staleness pre-check (short-circuits a 10 s Playwright timeout when the LLM picks a ref that isn't in the current snapshot), single `Agent` reused via `agent.reset()`. The reuse alone cut per-turn wall clock from ~5.5 s to ~3.0 s.
- Post-run URL-progression warning in both: if `PASS` is declared but `page.url()` never changed from the initial, print a soft warning. Would have flagged the pre-fix false-PASS runs visibly.

## Decision

**Option B** (advisor-driven) is `src/executor-plan.js`. `src/executor-tools.js` is removed from the tree (kept in git history via commit `5ac01bc` and subsequent edits; last meaningful state at commit `ea202c7`, reverted in `24d03d3`).

Primary reasons, in order:

1. **Model-range.** B works on Gemma; A doesn't. The project roadmap explicitly targets cheap/local models. A harness that breaks on the cheapest tier is a harness with an invisible ceiling.
2. **Cost.** ~6× token ratio on a single 10-turn test. Scales poorly for A on longer flows.
3. **Observability.** Every decision is in our code. Retry logic, verifier integration, and recorder hooks land naturally in an explicit loop.
4. **Code size parity.** B at 139 lines vs A at 134 — essentially the same footprint.

## What we kept as reference

- `src/executor-plan.js` — the winning executor, still experiment-shaped (hardcoded GOAL, hardcoded credentials). Next step is refactoring it into `src/executor.js` with a proper API: `runExecutor(page, goal, { maxTurns }) → { outcome, summary?, reason?, turns, elapsedMs, usage }`.
- Git history contains the full A implementation, the three test goals, and all intermediate fixes — any future "what if we revisit tool-driven?" question can start from commit `ea202c7`.

## Open questions for later

- **Prompt prefix caching.** B reuses one Agent now but does not explicitly enable caching. OpenRouter/Anthropic/OpenAI each support this differently via pi-ai. Could cut B's ~21 k input tokens further.
- **Verifier integration.** Architecture calls for a separate `verifier.js` doing pure-code end-state checks. The URL-progression warning is a stop-gap; real verifier logic belongs in its own module and should gate `PASS`/`FAIL` before the executor returns.
- **Stuck detection beyond turn cap.** E.g. "same action twice → probably stuck." Trivially implementable in B's loop.
- **Observer token cost.** Some pages (HN ~1000 lines in ai-mode YAML) are expensive to send. Trimming known noise (cookie banners, footers) could be a separate observer improvement.
