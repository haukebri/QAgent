# QAgent

### The verification agent for your coding agent.

QAgent is a verification layer for Claude Code, Codex, and other agentic dev loops. Hand it one product-level goal, it drives the browser, and returns a clean pass/fail with the evidence your coding agent can actually use.

[![npm version](https://img.shields.io/npm/v/@qagent/cli.svg)](https://www.npmjs.com/package/@qagent/cli)
[![license](https://img.shields.io/npm/l/@qagent/cli.svg)](LICENSE)

![QAgent driving a real browser via Playwright while a separate verifier LLM judges the final observable outcome](docs/demo/demo-gif.gif)

> **Status:** pre-1.0, experimental. One inline goal per invocation; multi-goal specs and orchestration are not yet built. `--max-turns` (default 50) is the main spending cap.

---

## Why not just have the coding agent drive Playwright?

You can. It works. It also burns context, slows the loop, and the verification gets flakier the longer the run gets.

- **Context bloat.** Every browser turn, DOM dump, and selector retry lands in your coding agent's context. By the time it's done verifying, it's worse at building.
- **Weaker focus.** The agent is now juggling two jobs — write the feature and QA it. Neither gets your full model.
- **Flakier verification.** Long agentic runs drift. By turn 30, the agent is guessing selectors, retrying flaky steps, and reporting "looks ok" when it isn't.

QAgent runs the browser turns in a separate loop. Your coding agent gets back a short, structured verdict — not a 40-turn transcript.

---

## Structured feedback, not just a green check.

![QAgent run ending in a green PASS verdict — saucedemo login flow, 5 turns, 34.5s, $0.0007](docs/demo/product-shoot-pass.png)

![QAgent run ending in a red FAIL verdict — saucedemo login flow, step 3 failed, 3 turns, 15.2s, $0.0003](docs/demo/product-shoot-fail.png)

Every run returns the goal, steps, final URL, and a decisive evidence sentence. A
separate verifier LLM judges the overall observable outcome in one call, so the
agent that drove the browser is not grading its own work.

---

## What QAgent is — and isn't.

**QAgent is for**

- Fast goal-based verification during agentic dev
- One-shot "does this feature work right now" checks
- Feeding structured results back into Claude Code / Codex
- Keeping the coding agent's context focused on building

**QAgent is not**

- A Playwright replacement
- A regression suite
- A CI gate on every commit
- A place to write durable, deterministic test specs

Keep Playwright for the long-lived regression coverage. Use QAgent for the inner loop, while you're still building.

---

## Built for devs in an agentic loop.

You use Claude Code, Codex, Cursor, or a similar agent. You ship a change every few minutes. You don't want to babysit Playwright inside the coding run, and you want a fast, honest answer to "does the thing I just built actually work?" — that's the loop QAgent is built for.

---

## Quick Start

You — or your coding agent — install once, then call `qagent` per verification.

Requirements:

- Node.js 22.19.0 or newer.
- An API key for an LLM provider (OpenRouter is the default; Anthropic, OpenAI, and Google are also supported with built-in env-var fallbacks).
- A Playwright Chromium browser install, or a reachable system Chrome.

```bash
npm install -g @qagent/cli
npx playwright install chromium

qagent config set apiKey sk-or-...
qagent config set model qwen/qwen3.5-flash-02-23
qagent --url https://example.com "Verify that the page heading exists"
```

Output:

```
▶ Verify that the page heading exists

    1  done      "The page heading 'Example Domain' exists."  2.4s

✓ PASS — The final snapshot confirms the presence of the heading 'Example Domain'.
1 turn · 2.4s · $0.00005
```

---

## Browser Install

QAgent does not download browsers during `npm install`. Install Chromium once on each machine or CI image:

```bash
npx playwright install chromium
```

On Linux CI images that are missing browser system libraries, run:

```bash
npx playwright install-deps chromium
npx playwright install chromium
```

If a run fails with a Playwright message like "Executable doesn't exist" or asks you to run `playwright install`, install Chromium with the commands above and retry. If your machine already has Google Chrome installed, QAgent tries that first and falls back to Playwright's bundled Chromium.

---

## Provider Setup

QAgent picks the LLM provider via the `provider` config key (default `openrouter`). The same provider is used for the driver and verifier models. Pi-ai supports many providers; QAgent ships per-provider env-var fallbacks for the four most common.

Model IDs are provider-local. OpenRouter IDs often include a slash, while direct Anthropic IDs look like `claude-sonnet-4-5`.

1. Pick your provider and grab an API key:

   - **OpenRouter** (default) — [openrouter.ai/keys](https://openrouter.ai/keys)
   - **Anthropic** — [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)
   - **OpenAI** — [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
   - **Google (Gemini)** — [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
   - Other pi-ai providers (Mistral, Groq, xAI, Cerebras, Ollama, …) work too — pass the key via `--api-key`, `QAGENT_API_KEY`, or the `apiKey` config.

2. Store the provider, model, and key once:

   ```bash
   qagent config set provider anthropic
   qagent config set model claude-sonnet-4-5
   qagent config set apiKey sk-ant-...
   ```

3. Optionally use a different verifier model:

   ```bash
   qagent config set verifierModel claude-haiku-4-5
   ```

For CI, prefer env vars over config files. The provider-specific env vars are picked up automatically:

```bash
QAGENT_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-... QAGENT_MODEL=claude-sonnet-4-5 qagent --url <url> "<goal>"
```

`QAGENT_API_KEY` is the provider-agnostic env var and works for any provider. If QAgent says `unknown model "<id>" for provider "<name>"`, check that the provider name and model ID are both valid for the installed `pi-ai` package.

---

## Model Recommendations

The driver model picks browser actions; the verifier judges the final state. The driver does the heavy lifting and is the more sensitive of the two.

These are observed minimums on real-world targets — pages with grouped fields, checkbox arrays, dropdowns, and validation that re-renders on submit. Trivial pages (single heading, single form field) work with anything.

| Provider | Model | Status | Est. cost for ~12 step run | Notes |
|---|---|---|---|---|
| OpenRouter | `google/gemma-4-26b-a4b-it` | ✅ recommended | ~$0.008 | 5/5 = 100% on a multi-required-field form (~50s wall time). Cheapest passing option observed. Handles grouped fields and checkbox arrays cleanly. |
| OpenRouter | `qwen/qwen3.5-flash-02-23` | ✅ recommended | ~$0.018 | 4/5 = 80% on the same form (~45s wall time). The measured failure was a cookie/privacy overlay; `v0.8.0` added automatic recovery for click-blocking overlays. Driver occasionally emits a `fail` verdict on a successfully submitted page; the verifier overrides correctly. |
| OpenAI | `gpt-4.1-mini` | ✅ recommended | ~$0.05 | 5/5 = 100% on a multi-required-field form (~30s wall time). Slightly faster wall time than gemma but ~6× the cost. |
| OpenAI | `gpt-4.1-nano` | ❌ not viable | $0.02–$0.06 (wasted, runs loop until `--max-turns`) | Misses required checkboxes and confuses grouped fields (e.g. `First` vs `Last` name) regardless of prompt. ~0% success on multi-field forms. As verifier it also false-negatives on pages where a success message and a stale validation banner co-exist. |

Cost notes:
- Costs above are observed on a Gravity Forms multi-required-field test page; expect variation by snapshot size and turn count. Each turn sends one complete current accessibility snapshot to the driver and scrubs older snapshots, so denser pages cost more per turn.
- The verifier runs once at the end. Provider, JSON, or schema errors get one retry.
- `--max-turns` (default 50) is the hard cap on driver spend; reduce it to bound worst-case cost on flaky models or pages.

Rule of thumb: if the page has more than ~3 required fields, more than one input type, or any group/checkbox-array pattern, do not use a `nano`-class model for the driver.

---

## How to Write Good Tests

QAgent runs one natural-language goal at a time. Give it the journey, any
inputs that matter, and the visible result that decides whether the test passed.

```bash
qagent --url https://example.com/calculator '
Complete the calculator for a 35-year-old woman who weighs 70 kg and wants
body recomposition. Pass when the results show "Body recomposition" and a
maintenance calorie target of 2,100 kcal.'
```

A useful formula is:

> **Do this** with **these important inputs**. Pass when **this observable result** appears.

### Good test goals

- **Smoke test:** `Complete the signup form with valid details. Pass when "Check your inbox" is visible.`
- **Functional test:** `Add "Sauce Labs Backpack" to the cart. Pass when the cart shows "Sauce Labs Backpack" with quantity 1.`
- **Copy test:** `Open the pricing page. Pass only if the main heading is exactly "Simple pricing".`
- **Route test:** `Sign in with valid credentials. Pass when the URL ends in /dashboard and "Welcome back" is visible.`

### Keep goals easy to verify

- Name literal success text, expected values, products, or URLs instead of saying “the result page appears.”
- Include every input whose value affects the expected result.
- Use exact wording only when copy matters; otherwise allow harmless wording changes.
- Mention intermediate steps or transient dialogs only when seeing them is part of the test.
- Use separate QAgent runs for independent outcomes. Keep Playwright for durable, deterministic regression suites.

For complex forms, list the required fields and values. If a control is
ambiguous, name its type—for example, `Services Needed is a checkbox group`.
Use `--locale de-DE` when the goal quotes localized labels or messages.

---

## Use Cases

| I want to... | Run |
|---|---|
| Run one goal locally | `qagent --url <url> "<goal>"` |
| Stream events to an AI agent | `qagent --url <url> "<goal>" --reporter=ndjson` |
| Save a JSON trace file | `qagent --url <url> "<goal>" --reporter=trace` |
| Save screenshot evidence | `qagent --url <url> "<goal>" --evidence-dir ./evidence` |
| Test a localized site | `qagent --url <url> --locale de-DE "<goal>"` |
| Watch the browser | `qagent --url <url> "<goal>" --headed` |

---

## Reporters

| Name | Output |
|---|---|
| `list` (default) | Live human-readable progress with ✓/✗, color, per-turn timing, and verifier evidence |
| `ndjson` | One JSON event per turn streamed to stdout, ending with a `done` envelope |
| `json` | Single JSON object dumped at the end |
| `trace` | Writes `results/<YYYY-MM-DDTHH-MM>H<HASH>.json` (path overridable with `--output-dir`); confirmation goes to **stderr** so machine-readable reporters keep stdout clean |

Compose with a comma: `--reporter=list,trace`. Default is `list`.

Screenshot evidence is separate from reporters: pass `--evidence-dir <path>` to write viewport JPEGs (`step-03.jpg`, `final.jpg`) no matter which reporter is enabled. Step screenshots show the page before that step's action is executed; `final.jpg` shows the final page state.

---

## Configuration

QAgent reads from `~/.config/qagent/config.json` (user, XDG-style) and `./qagent.config.json` (project; only the file in your current working directory, no walk-up).

**Resolution order** (highest first): CLI flag → env var → project config → user config → built-in default.

```bash
qagent config set apiKey sk-or-...
qagent config set --project provider anthropic
qagent config set --project model claude-sonnet-4-5
qagent config list                # show effective values + their sources
qagent config --help              # all keys, types, defaults, valid values
```

Recognized keys: `model`, `verifierModel`, `provider`, `apiKey`, `url`, `locale`, `maxTurns`, `testTimeout`, `networkTimeout`, `actionTimeout`, `reporter`, `outputDir`, `headed`.

---

## How your coding agent calls it.

One CLI call. The verdict comes back as a short structured envelope the next agent turn can paste in and act on. Built so a parent agent (Claude Code, Codex, CI scripts) can run goals and consume results structurally.

**Stable exit codes:**

| Code | Meaning |
|---|---|
| 0 | Goal passed |
| 1 | Goal failed (verifier said `fail`) |
| 2 | Config or setup error (missing key, bad flag, unknown reporter) |
| 3 | Runtime error (browser crash, network) |

**`ndjson` event schema** — `qagent --url <url> "<goal>" --reporter=ndjson` emits one JSON object per line on stdout. Two event types: `turn` (one per LLM-driven action during the run) and `done` (a single final envelope, always last).

```jsonc
// turn event — fields:
{
  "event": "turn",                 // string, always "turn"
  "turn": 1,                       // number, sequential, starts at 1
  "atMs": 1594,                    // number, ms since run start (cumulative)
  "action": {                      // object, the action emitted by the driver LLM
    "action": "click",             // string, one of: click | fill | selectOption | pressKey | type | goBack | wait | done | fail
    "value": "...",                // string | string[] (fill | selectOption | type)
    "key": "Enter",                // string (pressKey)
    "ms": 1500,                    // number (wait — requested duration)
    "summary": "...",              // string (done — driver's natural-language verdict)
    "reason": "..."                // string (fail — driver's natural-language reason)
  },
  "target": "button \"Sign in\" in form \"Login\"", // string, semantic human description
  "locator": {                     // object, optional — reusable locator metadata
    "playwright": "page.getByRole(\"button\", { name: \"Sign in\", exact: true })",
    "css": "#sign-in",             // string | null — only when a stable candidate is unique
    "frameUrl": null               // string | null — set when the locator is frame-relative
  },
  "url": "https://.../page",       // string, page URL after the action
  "ms": 180,                       // number, browser-action duration; absent for ref-miss errors
  "screenshot": "step-01.jpg",     // string, optional — relative to --evidence-dir
  "error": "selected element is no longer present" // string, present only when the action errored
}

// done event — always the last line on stdout, regardless of outcome:
{
  "event": "done",                 // string, always "done"
  "goal": "...",                   // string, the input goal verbatim
  "outcome": "pass",               // string, one of: pass | fail | error (matches exit code 0 | 1 | 3)
  "evidence": "...",               // string, compact verifier/debug rationale (always present)
  "turns": 2,                      // number, total LLM turns executed
  "elapsedMs": 4933,               // number, total wall time
  "driverCost": 0.0001,            // number, USD — driver (executor) LLM only
  "verifierCost": 0.00003,         // number, USD — verifier LLM only (0 if verifier didn't run)
  "totalCost": 0.00013,            // number, USD — driverCost + verifierCost
  "driverTokens": 1424,            // number, driver total tokens (input + output, incl. cache)
  "verifierTokens": 320,           // number, verifier total tokens (0 if verifier didn't run)
  "totalTokens": 1744,             // number, driverTokens + verifierTokens
  "finalUrl": "https://...",       // string
  "finalScreenshot": "final.jpg",  // string, optional — relative to --evidence-dir
  "warnings": []                   // string[], usually empty
}
```

A done event is emitted even on fail and error. Use outcome for automation and
evidence for the verifier's rationale.

Accessibility refs are an internal driver protocol and are not exposed in turn
events, returned history, JSON, or trace steps. Use `target` for reports and
`locator.playwright` or `locator.css` when converting a run into a maintained
Playwright test.

Pipe-friendly recipes:

```bash
qagent --url <url> "<goal>" --reporter=ndjson | jq -c .                 # consume the full event stream
qagent --url <url> "<goal>" --reporter=ndjson | tail -1 | jq -r .outcome  # just pass / fail / error
qagent --url <url> "<goal>" --reporter=ndjson,trace                     # stream + persist trace file
qagent --url <url> "<goal>" --reporter=list --evidence-dir ./evidence   # save screenshots without NDJSON
```

Stderr stays clean — only the trace reporter writes its path confirmation there, so piping stdout into `jq` always works.

### CI tips

- **Pass the API key via env var** (`QAGENT_API_KEY`, or the provider-specific fallback for the four most common providers — `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`). Avoid `--api-key <key>` on argv (visible in `ps` and most CI job logs) and avoid `qagent config set apiKey ...` in CI scripts (writes to `~/.config/qagent/config.json` on the runner — leaks across cached or shared workers).
- **Tune the wall-clock budget.** `--test-timeout` caps the loop in seconds (default 300 = 5 min); the verifier still runs against whatever state the loop left behind, so the run terminates with a real verdict instead of hanging. Wrap with `timeout(1)` only as a belt-and-braces backstop:

  ```bash
  qagent --url <url> "<goal>" --test-timeout=600 --reporter=ndjson
  timeout 11m qagent --url <url> "<goal>" --test-timeout=600 --reporter=ndjson   # hard kill if even the verifier hangs
  ```

- **Browsers don't auto-install.** Run `npx playwright install chromium` once per runner image. On minimal Linux images, run `npx playwright install-deps chromium` first.

---

## Release Benchmarks

The deterministic local benchmark exercises browser completion separately from
verifier agreement:

```bash
npm run benchmark:local -- 5
```

Use npm run benchmark:model -- 5 for the configured driver model. Run npm run
benchmark:verifier for the six frozen outcome-labeled browser artifacts.

The v0.11.0 live release set is Reply, Vorwerk, and one representative
calculator journey, each repeated three times. Report browser completion
separately from final-verdict agreement. AIDA is excluded until popup/new-page
adoption is supported.


## CLI Reference

```
qagent --url <url> [options] "<goal>"
qagent config <subcommand> [args]
qagent --help | --version

Run options:
  --url <url>             Start URL (required); embed basic auth as https://user:pass@host
  --model <id>            LLM model
  --verifier-model <id>   Verifier model (defaults to --model)
  --provider <name>       LLM provider (default openrouter)
  --api-key <key>         Provider API key
  --locale <tag>          Browser locale, e.g. de-DE
  --max-turns <n>         Turn cap (default 50)
  --test-timeout <s>      Wall-clock loop budget in seconds; verifier still runs after (default 300)
  --network-timeout <s>   Per page.goto, in seconds (default 30)
  --action-timeout <s>    Per click/fill in seconds; doubles as blocked-element detector (default 2)
  --reporter <list>       Comma-separated: list,json,ndjson,trace (default list)
  --output-dir <path>     Where trace files land (default results/)
  --evidence-dir <path>   Save per-step and final viewport JPEG screenshots
  --headed                Show the browser window

Config subcommands:
  qagent config set [--project] <key> <value>
  qagent config list
  qagent config --help

Environment:
  QAGENT_URL, QAGENT_PROVIDER, QAGENT_API_KEY, QAGENT_MODEL, QAGENT_LOCALE
  ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY  (per-provider fallbacks)
  QAGENT_TEST_TIMEOUT, QAGENT_NETWORK_TIMEOUT, QAGENT_ACTION_TIMEOUT  (seconds)

Resolution: flag > env > project > user > built-in default
Exit codes: 0 pass | 1 fail | 2 config error | 3 runtime error
```

---

## Issues

Bug reports and feature requests welcome on [GitHub Issues](https://github.com/haukebri/QAgent/issues).

---

## License

[MIT](LICENSE).
