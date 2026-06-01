# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

QAgent is an AI-driven test runner where tests are written in natural language and an LLM drives the browser via Playwright. A driver LLM picks actions; a separate verifier LLM judges whether the goal was achieved.

See `docs/project-goal.md` for goals and `docs/project-architecture.md` for the full architecture spec.

## Commands

```bash
npm install          # install dependencies
npm test             # (not yet configured)
node src/cli.js      # CLI entry point
```

## Architecture

Data flow: `CLI goal + URL -> config/provider/auth resolution -> browser launch + pre-navigate -> executor loop (observe -> LLM JSON action -> local Playwright tool) -> verifier -> reporters/results`

Modules:

| Module | Role | Key dependencies |
|---|---|---|
| cli.js | Parse argv, layer config/env/project values, resolve provider/model/auth, launch browser, run reporters | @earendil-works/pi-ai |
| browser.js | Chromium lifecycle, stealth-ish defaults, headed/headless mode, optional HTTP credentials | playwright |
| tools.js | Observe and perform browser actions via Playwright refs; `navigate` is setup-only | playwright |
| executor.js | Driver loop: settle/observe, ask LLM for one JSON action, execute locally, detect stuck/done/fail/timeouts | @earendil-works/pi-agent-core |
| verifier.js | End-state LLM judge: goal + trajectory + final snapshot -> `{outcome, evidence}` | @earendil-works/pi-agent-core |
| llm-auth.js | Wrap `streamSimple` so standalone auth and future Pi auth can both supply `{apiKey, headers}` | @earendil-works/pi-ai |
| providers.js | Standalone CLI provider metadata and API-key resolution | — |
| config.js / config-cmd.js | User/project config loading, validation, and `qagent config` commands | — |
| observe-settle.js / snapshot-compress.js | Page stability, snapshot diffing, and context compression | — |
| reporters.js / recorder.js | Human/JSON/NDJSON/trace output | — |

## Code Rules

- Functions first. Avoid domain classes; small error subclasses are okay when they keep CLI errors explicit.
- No folders until a module outgrows a file.
- No TypeScript until something breaks without it.
- Keep changes simple and local; prefer explicit function arguments at module boundaries.
- Split or simplify when a file becomes a dumping ground.
- ES modules (`"type": "module"` in package.json).
- Driver and verifier LLM calls go through `@earendil-works/pi-ai` / `@earendil-works/pi-agent-core`; OpenRouter is only the default provider.
