# QAgent

End-to-end tests from prose goals. Drives [Claude Code](https://www.anthropic.com/claude-code) and [`agent-browser`](https://github.com/vercel-labs/agent-browser), records screenshot evidence, and can promote passing runs to repeatable Playwright tests.

**Status: pre-alpha.** See [`docs/DESIGN.md`](./docs/DESIGN.md) — the design doc is the source of truth while the walking skeleton is being built.

## What it is

You write the goal in English:

```json
{
  "name": "change-username",
  "goal": "I can login as the default user, go to my account profile and change my username. When I reload that page, I see the new name."
}
```

QAgent spawns a headless Claude Code session, drives Chrome via `agent-browser`, takes screenshots along the way, and writes a `result.json` with a `pass | fail | blocked` verdict. Passing runs can emit a Playwright spec you can pin in CI.

## Install (coming soon)

```bash
npm install -g @qagent/cli
qagent init
```

## Requirements

- Node.js ≥ 20
- [Claude Code CLI](https://docs.claude.com/claude-code) in PATH, logged in
- [`agent-browser`](https://www.npmjs.com/package/agent-browser) in PATH
- Chrome (installed via `agent-browser install`)

## Quick start (preview)

```bash
qagent init                                         # scaffold config, Playwright, example goal
vim .qagent/test-credentials.json                   # add staging creds
vim tests/e2e/goals.json                            # write goals
qagent run                                          # run all goals
qagent run --goal "I can submit the contact form" --url https://staging.example.com
qagent run --record                                 # also emit Playwright specs per passing goal
```

## License

MIT — see [LICENSE](./LICENSE).
