# qa harness architecture

AI-driven QA testing. Browser is driven by script. LLM is the decider.

## modules

Each module is one file, one or two exported functions. No classes.

### browser.js

Browser lifecycle. Exports `launchPage({ httpCredentials })` which opens
chromium (Chrome channel with chromium fallback), applies the stealth
defaults (UA, locale, local timezone, viewport, webdriver/languages init script),
and returns `{ browser, page }`. Single source of truth for the
bot-detection escalation ladder below.

### tools.js

Browser surface. Read + write functions that take a playwright page:
`observe(page)` returns the ai-mode ariaSnapshot YAML (refs baked in as
`[ref=eN]`); `click`, `fill`, `navigate` resolve refs via
`page.locator('aria-ref=${ref}')`.

### verifier.js

End-state judge. Single LLM call over (goal, driver verdict, action history,
final URL, final snapshot); returns `{ outcome: 'pass'|'fail', evidence }`.
Source of truth for the run's outcome. Does not call playwright — the executor
freezes state and passes it in.

### planner.js

Goal to ordered todos. One LLM call with JSON output.
Each todo has a verifiable end-state.

### executor.js

The loop. For one todo: observe, LLM picks action, run action, verify.
Exits on done, stuck, or turn cap.

### recorder.js

Append JSON lines to a trace file.

### runner.js

Top level. Load spec, run planner, iterate todos through executor.

### cli.js

Parse argv, call runner.

## dependencies

- `playwright`: browser driver. Used only in browser.js and tools.js.
- `pi-ai`: OpenRouter model lookup. Used by the CLI/demo.
- `pi-agent-core`: driver and verifier LLM calls. Used by executor.js and verifier.js.

## data flow

```
spec -> runner -> planner returns todos
for each todo:
  executor loop: observe -> LLM decide -> tool -> verifier
  recorder captures every step
runner aggregates results
```

## build order

1. `observe.js`: open a page with playwright, dump the a11y tree
2. `tools.js`: observe (wraps `ariaSnapshot({ mode: 'ai' })`), click, fill, navigate
3. `browser.js`: chromium launch + stealth defaults, shared by observe.js and demo.js
4. `executor.js`: hardcoded todo, full loop working end to end
5. `recorder.js`: trace output
6. `planner.js`: goal to todos
7. `runner.js` and `cli.js`: wire it up
8. eval harness against a reference app

## rules

- No classes.
- No folders until a module outgrows a file.
- No TypeScript until something breaks without it.
- No config objects. Function arguments only.
- Under 200 lines for the MVP.
- If a module needs more than two exports, split or simplify.

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

Network navigation uses `waitUntil: 'networkidle'` with a bounded timeout
so SPA route transitions are caught, but heavy sites (ads, analytics,
polling) can't hang the run forever. Navigate timeouts are non-fatal
inside the executor loop; any other exception becomes `outcome: 'error'`
so every run produces a result file.
