# QAgent

[![npm version](https://img.shields.io/npm/v/@qagent/cli.svg)](https://www.npmjs.com/package/@qagent/cli)
[![license](https://img.shields.io/npm/l/@qagent/cli.svg)](LICENSE)

AI-driven end-to-end browser test runner. You write a goal in natural language; an LLM picks actions, Playwright drives the browser, and verifiers are pure code.

Runs interactively for humans (live progress, ✓/✗ summary) or streams JSON events for AI agents like Claude Code (`--reporter=ndjson`).

> **Status:** pre-1.0, experimental. One inline goal per invocation; multi-goal specs and orchestration are not yet built. Cost scales with snapshot size and turn count — `--max-turns` (default 50) is currently the only spending knob.

## Quick Start

```bash
npm install -g @qagent/cli
npx playwright install chromium     # one-time browser download (skip if Chrome is already installed)

# your OpenRouter key
qagent config set apiKey sk-or-...
qagent config set model qwen/qwen3.5-flash-02-23
qagent "Open https://example.com and verify that the page heading exists"
```

Output:

```
▶ Open https://example.com and verify that the page heading exists

    1  navigate  https://example.com  2.6s
    2  done      "The page heading 'Example Domain' exists."  2.4s

✓ PASS — The final snapshot confirms the presence of the heading 'Example Domain'.
2 turns · 5.0s · $0.0001
```

## Use Cases

| I want to... | Run |
|---|---|
| Run one goal locally | `qagent "<goal>"` |
| Stream events to an AI agent | `qagent "<goal>" --reporter=ndjson` |
| Save a JSON trace file | `qagent "<goal>" --reporter=trace` |
| Watch the browser | `qagent "<goal>" --headed` |

## Reporters

| Name | Output |
|---|---|
| `list` (default) | Live human-readable progress with ✓/✗, color, per-turn timing |
| `ndjson` | One JSON event per turn streamed to stdout, ending with a `done` envelope |
| `json` | Single JSON object dumped at the end |
| `trace` | Writes `results/<YYYY-MM-DDTHH-MM>H<HASH>.json` (path overridable with `--output-dir`); confirmation goes to **stderr** so machine-readable reporters keep stdout clean |

Compose with a comma: `--reporter=list,trace`. Default is `list`.

## Configuration

QAgent reads from `~/.config/qagent/config.json` (user, XDG-style) and `./qagent.config.json` (project; only the file in your current working directory, no walk-up).

**Resolution order** (highest first): CLI flag → env var → project config → user config → built-in default.

```bash
qagent config set apiKey sk-or-...
qagent config set --project model anthropic/claude-opus-4-5
qagent config list                # show effective values + their sources
qagent config --help              # all keys, types, defaults, valid values
```

Recognized keys: `model`, `verifierModel`, `apiKey`, `maxTurns`, `reporter`, `outputDir`, `headed`.

## For AI Agents

QAgent is built so a parent agent (Claude Code, CI scripts) can run goals and consume results structurally.

**Stable exit codes:**

| Code | Meaning |
|---|---|
| 0 | Goal passed |
| 1 | Goal failed (verifier said `fail`) |
| 2 | Config or setup error (missing key, bad flag, unknown reporter) |
| 3 | Runtime error (browser crash, network) |

**`ndjson` event schema** — `qagent "<goal>" --reporter=ndjson` emits one JSON object per line on stdout. Two event types: `turn` (one per LLM-driven action during the run) and `done` (a single final envelope, always last).

```jsonc
// turn event — fields:
{
  "event": "turn",                 // string, always "turn"
  "turn": 1,                       // number, sequential, starts at 1
  "atMs": 1594,                    // number, ms since run start (cumulative)
  "action": {                      // object, the action emitted by the driver LLM
    "action": "navigate",          // string, one of: navigate | click | fill | wait | done | fail
    "url": "https://...",          // string (navigate)
    "ref": "e6",                   // string (click | fill — snapshot ref)
    "value": "...",                // string (fill)
    "ms": 1500,                    // number (wait — requested duration)
    "summary": "...",              // string (done — driver's natural-language verdict)
    "reason": "..."                // string (fail — driver's natural-language reason)
  },
  "target": "Sign in",             // string, optional — human label resolved from ref (click | fill)
  "url": "https://.../page",       // string, page URL after the action
  "ms": 180,                       // number, browser-action duration; absent for ref-miss errors
  "error": "ref e87 not in snapshot"  // string, present only when the action errored
}

// done event — always the last line on stdout, regardless of outcome:
{
  "event": "done",                 // string, always "done"
  "goal": "...",                   // string, the input goal verbatim
  "outcome": "pass",               // string, one of: pass | fail | error (matches exit code 0 | 1 | 3)
  "evidence": "...",               // string, the verifier's one-sentence rationale (always present)
  "turns": 2,                      // number, total LLM turns executed
  "elapsedMs": 4933,               // number, total wall time
  "driverCost": 0.0001,            // number, USD — driver (executor) LLM only
  "verifierCost": 0.00003,         // number, USD — verifier LLM only (0 if verifier didn't run)
  "totalCost": 0.00013,            // number, USD — driverCost + verifierCost
  "driverTokens": 1424,            // number, driver total tokens (input + output, incl. cache)
  "verifierTokens": 320,           // number, verifier total tokens (0 if verifier didn't run)
  "totalTokens": 1744,             // number, driverTokens + verifierTokens
  "finalUrl": "https://...",       // string
  "warnings": []                   // string[], may include verifier-fallback notices; often empty
}
```

A `done` event is emitted even on `outcome: fail` and `outcome: error` — the envelope shape is stable; only `outcome` and `evidence` differ.

Pipe-friendly recipes:

```bash
qagent "<goal>" --reporter=ndjson | jq -c .                 # consume the full event stream
qagent "<goal>" --reporter=ndjson | tail -1 | jq -r .outcome  # just pass / fail / error
qagent "<goal>" --reporter=ndjson,trace                     # stream + persist trace file
```

Stderr stays clean — only the trace reporter writes its path confirmation there, so piping stdout into `jq` always works.

### CI tips

- **Pass the API key via env var** (`QAGENT_API_KEY` or `OPENROUTER_API_KEY`). Avoid `--api-key sk-or-...` on argv (visible in `ps` and most CI job logs) and avoid `qagent config set apiKey ...` in CI scripts (writes to `~/.config/qagent/config.json` on the runner — leaks across cached or shared workers).
- **Tune the wall-clock budget.** `--test-timeout` caps the loop in seconds (default 300 = 5 min); the verifier still runs against whatever state the loop left behind, so the run terminates with a real verdict instead of hanging. Wrap with `timeout(1)` only as a belt-and-braces backstop:

  ```bash
  qagent "<goal>" --test-timeout=600 --reporter=ndjson
  timeout 11m qagent "<goal>" --test-timeout=600 --reporter=ndjson   # hard kill if even the verifier hangs
  ```

- **Browsers don't auto-install.** `npx playwright install chromium` once per runner image (not needed if a system Chrome is present and reachable).

## Philosophy

- Two-stage: a **driver LLM** picks the next action; a **judge LLM** verifies the end-state. Browser tools (click, fill, navigate) are pure code.
- No spec files yet — one inline goal per invocation.
- No classes, no folders, no TypeScript. Functions and modules.
- OpenRouter only — model-agnostic via the `model` config key.

## CLI Reference

```
qagent [options] "<goal>"
qagent config <subcommand> [args]
qagent --help | --version

Run options:
  --model <id>            LLM model
  --verifier-model <id>   Verifier model (defaults to --model)
  --api-key <key>         OpenRouter key
  --max-turns <n>         Turn cap (default 50)
  --test-timeout <s>      Wall-clock loop budget in seconds; verifier still runs after (default 300)
  --network-timeout <s>   Per page.goto + post-action networkidle wait, in seconds (default 30)
  --action-timeout <s>    Per click/fill in seconds; doubles as blocked-element detector (default 2)
  --reporter <list>       Comma-separated: list,json,ndjson,trace (default list)
  --output-dir <path>     Where trace files land (default results/)
  --headed                Show the browser window

Config subcommands:
  qagent config set [--project] <key> <value>
  qagent config list
  qagent config --help

Environment:
  QAGENT_API_KEY, OPENROUTER_API_KEY, QAGENT_MODEL
  QAGENT_TEST_TIMEOUT, QAGENT_NETWORK_TIMEOUT, QAGENT_ACTION_TIMEOUT  (seconds)
  BASIC_AUTH_USER, BASIC_AUTH_PASS    (per-page httpCredentials)

Resolution: flag > env > project > user > built-in default
Exit codes: 0 pass | 1 fail | 2 config error | 3 runtime error
```

## Issues

Bug reports and feature requests welcome on [GitHub Issues](https://github.com/haukebri/QAgent/issues).

## License

[MIT](LICENSE).
