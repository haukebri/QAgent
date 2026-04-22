# AGENTS.md

This file provides guidance to Codex when working with code in this repository.

## Project

QAgent is a CLI for prose-driven end-to-end QA against live web apps. It uses Codex plus `agent-browser`, records screenshot evidence, and returns pass, fail, or blocked verdicts. There is **no Playwright generation in this tool**.

`docs/DESIGN.md` is the source of truth for the current product direction.

## Commands

```bash
npm run build        # tsc -> dist/
npm run dev          # tsx src/cli.ts
npm run test         # build + node:test suite
npm run typecheck    # tsc --noEmit
```

## Tech Stack

- Runtime: Node.js >= 20, ESM (`"type": "module"`)
- Language: TypeScript (strict, `noUncheckedIndexedAccess`)
- CLI framework: cac
- Validation: zod
- Tests: Node's built-in test runner
- Build: plain `tsc` -> `dist/`
- Dev runner: tsx

## Architecture

The CLI (`src/cli.ts` -> `dist/cli.js`) currently exposes:

1. `qagent` as the default run command
2. `qagent doctor` to verify local dependencies

Run flow:

1. Load `qagent.config.json`
2. Resolve goals, credentials, and optional skills-description files
3. For each goal, start a fresh `agent-browser` session before spawning Codex
4. Apply HTTP basic auth if configured, then open the target URL
5. Spawn Codex with a built-in prompt and restricted `agent-browser` access
6. Read `result.json` and classify the goal as `pass`, `fail`, or `blocked`

Important design decisions:

- QAgent is a wrapper, not its own runtime
- Browser sessions are pre-started outside the prompt
- Each goal runs in an isolated browser session
- Parallel execution is supported via `--parallel`
- Exit codes: `0` all passed, `1` app/test failures or blocked runs, `2` setup errors, `3` Codex crash

## Key Files

- `docs/DESIGN.md` — current product design
- `src/cli.ts` — CLI entrypoint
- `src/runner.ts` — goal/suite orchestration
- `src/browser-session.ts` — deterministic browser startup
- `src/config.ts` — config loading
- `src/credentials.ts` — credential loading + env interpolation
- `src/skills.ts` — optional skills-description loading
- `src/goals.ts` — goals-file validation
- `src/prompt.ts` — built-in prompt
- `test/cli.test.mjs` — process-level regression tests
