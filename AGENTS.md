# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project

QAgent — a CLI that runs prose-written E2E goals against a web app using Codex + `agent-browser`, records screenshot evidence, and optionally promotes passing runs to Playwright tests. Pre-alpha; `docs/DESIGN.md` is the source of truth.

## Commands

```bash
npm run build        # tsc → dist/
npm run dev          # tsx src/cli.ts (run CLI without building)
npm run typecheck    # tsc --noEmit
```

No test framework is set up yet.

## Tech Stack

- **Runtime:** Node.js ≥ 20, ESM (`"type": "module"`)
- **Language:** TypeScript (strict, `noUncheckedIndexedAccess`), target ES2022, module NodeNext
- **CLI framework:** cac
- **Validation:** zod (for config/goals/credentials schemas)
- **Build:** plain `tsc` → `dist/`
- **Dev runner:** tsx

## Architecture

The CLI (`src/cli.ts` → `dist/cli.js`) exposes two main commands:

1. **`qagent init`** — scaffolds config (`qagent.config.json`), goals file, prompt template, credentials placeholder, and installs Playwright if missing.
2. **`qagent run`** — for each goal sequentially: renders a prompt template with goal context, spawns `Codex -p "<prompt>" --allowed-tools "Bash(agent-browser:*) Read Write"`, then reads the resulting `result.json` for pass/fail/blocked verdict. Optionally generates Playwright specs on pass (`--record`).

Key design decisions:
- QAgent is a **wrapper**, not a runtime — it spawns Codex as a subprocess.
- Each goal runs in a **fresh browser context** with no shared state.
- The prompt template at `.qagent/prompt.md` is user-editable; substitution uses `{{url}}`, `{{goal}}`, `{{resultPath}}`, etc.
- Exit codes: 0 = all pass, 1 = fail/blocked, 2 = setup error, 3 = Codex crash.

## Key Files

- `docs/DESIGN.md` — full design doc (architecture, CLI surface, config schemas, prompt template, build plan). **Read this first** for any implementation work.
- `docs/milestones/` — milestone planning docs
- `docs/tasks/` — task tracking docs
