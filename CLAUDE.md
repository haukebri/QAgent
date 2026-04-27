# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

QAgent is an AI-driven test runner where tests are written in natural language and an LLM drives the browser via Playwright. A driver LLM picks actions and a separate verifier LLM judges whether the goal was achieved.

See `docs/project-goal.md` for goals and `docs/project-architecture.md` for the full architecture spec.

## Commands

```bash
npm install          # install dependencies
npm test             # (not yet configured)
node src/cli.js      # entry point (once built)
```

## Architecture

Data flow: `spec → runner → planner (LLM) → todos → executor loop (observe → LLM decide → tool → verify) → results`

Modules (each is one file, one or two exports, no classes):

| Module | Role | Key dependencies |
|---|---|---|
| observer.js | Page → ai-mode ariaSnapshot YAML string (refs baked in by Playwright) | playwright |
| tools.js | Browser actions (click, fill, navigate) via `(page, ref, args)`; resolves ref with `aria-ref=${ref}` | playwright |
| verifier.js | LLM judge: goal + trajectory + final snapshot → `{outcome, evidence}` | pi-agent-core |
| planner.js | Goal → ordered todos with verifiable end-states (single LLM call, JSON output) | pi-ai |
| executor.js | The loop: observe → LLM pick → act → verify. Exits on done/stuck/turn-cap | pi-ai, pi-agent-core |
| recorder.js | Append JSON lines to a trace file | — |
| runner.js | Top-level orchestrator: load spec, plan, iterate todos through executor | — |
| cli.js | Parse argv, call runner | — |

## Code Rules

- No classes. Functions only.
- No folders until a module outgrows a file.
- No TypeScript until something breaks without it.
- No config objects — function arguments only.
- Under 200 lines for the MVP.
- Simplicity is better than abstraction
- ES modules (`"type": "module"` in package.json).
- LLM calls go through OpenRouter (model-agnostic).
