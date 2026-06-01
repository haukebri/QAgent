# qa harness architecture

AI-driven QA testing. Browser is driven by script. LLM is the decider.

## modules

QAgent is currently a single-goal CLI. There is no spec planner or runner layer
in the shipped package; `cli.js` is the top-level orchestrator.

### cli.js

Entry point for `qagent`. Parses argv, dispatches `qagent config`, layers
flag/env/project/user config, resolves provider/model/API-key values, strips
basic-auth credentials from the start URL, creates reporters, launches the
browser, pre-navigates to the URL, calls `runTodo()`, and maps the result to an
exit code.

### browser.js

Browser lifecycle. Exports `launchPage({ httpCredentials, headed })`, opens
Chrome with bundled Chromium fallback, applies stealth defaults (UA, locale,
local timezone, viewport, webdriver/languages init script), and returns
`{ browser, page }`. Single source of truth for the bot-detection escalation
ladder below.

### tools.js

Browser surface. `observe(page)` returns Playwright's ai-mode ariaSnapshot YAML
with refs baked in as `[ref=eN]`. `click`, `fill`, `selectOption`, `pressKey`,
and `type` resolve refs via `aria-ref=${ref}` and mutate the page. `navigate` is
used by `cli.js` for setup/pre-navigation; it is not exposed as a driver action.

### executor.js

Driver loop for one goal. It observes and settles the page, compresses snapshots
against a baseline, asks the driver LLM for one JSON action through
`pi-agent-core`, executes the local Playwright action, records history, detects
repeated no-progress actions, and exits on `done`, `fail`, stuck, timeout, or
turn cap. The final outcome is still decided by `verifier.js`.

### verifier.js

End-state judge. Single LLM call over goal, driver verdict, action history,
final URL, and final snapshot. Returns `{ outcome: 'pass'|'fail', evidence }`
and retries once on provider/parse failure. Does not call Playwright; the
executor freezes state and passes it in.

### llm-auth.js

Adapts pi-ai streaming to QAgent's auth boundary. The standalone CLI supplies
`{ apiKey }`; a future Pi package can supply `{ apiKey, headers }` from Pi's
model registry.

### providers.js

Standalone CLI provider metadata and API-key resolution. `provider` defaults to
`openrouter`; top-4 provider env vars are recognized after `QAGENT_API_KEY`.

### config.js / config-cmd.js

User/project config loading, coercion, validation, and `qagent config` commands.
User config is `~/.config/qagent/config.json`; project config is
`./qagent.config.json` in the current working directory.

### observe-settle.js / snapshot-compress.js

Page stability, fingerprinting, previous-action diffs, compact observation
payloads, and snapshot compression against a baseline anchor.

### reporters.js / recorder.js

Human list output, JSON, NDJSON, and trace-file output. `recorder.js` builds the
trace payload and writes `results/*.json` for the `trace` reporter.

## dependencies

- `playwright`: browser driver. Used by `browser.js`, `tools.js`, and the
  settle/observe helpers.
- `@earendil-works/pi-ai`: model lookup and streaming across providers. Selected via the `provider` config key (default `openrouter`).
- `@earendil-works/pi-agent-core`: stateful driver and verifier LLM conversations. Browser actions still run through QAgent's executor/tools modules.

## data flow

```
CLI goal + URL
  -> config/provider/API-key resolution
  -> browser launch + pre-navigate
  -> executor loop: observe/settle -> LLM JSON action -> local tool
  -> verifier judges final state
  -> reporters emit list/json/ndjson/trace output
```

## rules

- Functions first; avoid domain classes. Small error subclasses are okay.
- No folders until a module outgrows a file.
- No TypeScript until something breaks without it.
- Prefer explicit function arguments at module boundaries.
- Split or simplify when a file becomes a dumping ground.

## bot-detection escalation

Default launch uses `channel: 'chrome'`, a realistic user-agent, locale, the
host machine's timezone, viewport, and an init script that hides
`navigator.webdriver`.
This is enough for most sites (verified: aida.de Akamai, npmjs.com
Cloudflare, google.com all pass).

If a site still blocks after that, escalate in this order:

1. Drop-in `patchright` in place of `playwright` (~49 stealth patches).
2. Residential proxy via `chromium.launch({ proxy })`.
3. CAPTCHA solver (CapSolver, 2captcha) for Cloudflare Turnstile.

Network navigation uses `waitUntil: 'load'` with a bounded timeout
('networkidle' is discouraged by Playwright — chatty sites with analytics
or polling rarely settle). SPA route hydration and post-action mutation
are absorbed by the settle loop in `observe-settle.js`, which polls
`observe()` until URL + snapshot fingerprint are stable for two consecutive
samples or 3s elapses. Navigate timeouts are fatal inside the executor
loop (outcome `error`, exit code 3); any other exception also becomes
`error` so every run produces a result file.
