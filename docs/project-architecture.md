# QAgent architecture

QAgent runs one natural-language browser goal and asks an independent verifier
for one final outcome judgment.

## Modules

### CLI and runner

The CLI resolves configuration, provider, model, authentication, and reporters.
runQAgent validates the goal and URL, launches the browser, pre-navigates, runs
the executor, and closes the browser. Setup and browser failures become stable
error outcomes with failure kind execution.

### Browser and tools

The browser module owns Chromium lifecycle and headed/headless defaults. The
tools module exposes the local Playwright action set: observe, click, fill,
selectOption, pressKey, type, goBack, and setup-only navigate. Accessibility
refs stay inside the driver protocol; public steps use semantic targets and
optional reusable locator metadata.

### Executor

The executor settles and observes the page, sends the goal and current browser
context to the driver, performs one returned JSON action, and records compact
history. History keeps the action, target, URL, observation, success, and error.
It also keeps action screenshots, recovery details, timing, and token/cost data.

Repeated ineffective actions remain bounded. A successful click is reported as
successful even when URL and accessibility snapshot are unchanged, so the
driver can continue instead of retrying a wrapper-backed control.

Every exit uses one final settle-and-freeze boundary. The final URL, snapshot,
and failure screenshot are captured before verification.

### Verifier

The verifier receives the same goal as the driver, the frozen final URL and
snapshot, compact successful and failed action history, and the driver's
terminal response as non-authoritative context. It makes one normal-path LLM
call returning a pass or fail outcome and one evidence sentence.

Verification is outcome-first. History matters when the goal explicitly
requires a route or interaction, or when a requested confirmation was
transient. Provider, JSON, and schema failures are retried once; two invalid
responses produce an error outcome with failure kind verifier.

### Supporting modules

- observe-settle.js: page stability, compact diffs, and previous-action text.
- json.js: robust extraction of the first complete JSON object.
- llm-auth.js and providers.js: model authentication and provider metadata.
- evidence.js: optional per-step and final screenshots.
- reporters.js and recorder.js: list, JSON, NDJSON, and trace output.

## Data flow

    CLI goal + URL
      -> config/provider/auth resolution
      -> browser launch + pre-navigation
      -> executor: settle -> driver action -> local Playwright action
      -> final settle and frozen browser state
      -> one independent verifier judgment
      -> result/reporters

Public results contain the goal, outcome, evidence, final URL, steps, optional
screenshot, statistics, warnings, and technical failure information. QAgent
does not expose claim decomposition, goal contracts, evidence IDs, citations,
or per-claim verdicts.

Independent checkpoints should be separate QAgent runs. Durable workflow
assertions belong in Playwright.

## Code rules

- Functions first; avoid domain classes.
- Keep modules flat until a file genuinely outgrows its role.
- Use ES modules and explicit function arguments.
- Keep browser actions local; LLMs choose and judge but never execute tools.
