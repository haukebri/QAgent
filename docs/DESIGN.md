# QAgent — Design v0.1

A CLI that runs prose-written end-to-end goals against your web app using Claude Code, produces screenshot evidence, and optionally promotes passing runs to repeatable Playwright tests.

Not an AI tool. A test runner that happens to drive Claude Code.

---

## 1. Why this exists

AI writes a lot of the code now. Tests are the forcing function for whether AI-written code actually works. Existing E2E tooling (Playwright, Cypress) requires you to spell flows out in code before you can run them — slow, brittle, expensive on every UI refactor. Existing AI-in-browser tools (browser-use, Stagehand) are great for exploration but produce non-deterministic runs with no CI story and no artifacts your stakeholders can read.

QAgent sits in the gap: you write the goal in English (or German), QAgent verifies it against a live URL, and records evidence a developer and a stakeholder can both read. Passing runs can be pinned as Playwright tests, so the deterministic ones live on in CI.

The correctness signal is crisp: either the page shows what the goal says, or it doesn't. AI works well where correctness is crisp.

---

## 2. v1 scope

**In:**
- CLI: `qagent init`, `qagent run`.
- One-off run: `--url --goal "..."`.
- Multi-goal via `goals.json`.
- Goals as prose (natural-language, no DSL).
- Sequential execution; fresh browser context per goal.
- Test credentials (basic auth + login credentials) injected into the prompt.
- Screenshots per step, saved to a per-run output directory.
- `result.json` per goal; summary on stdout; exit code 0/1.
- `--record`: generate a Playwright `.spec.ts` per passing goal into the Playwright dir.
- Overridable prompt template.

**Not in v1 (explicit — keep them out):**
- `qagent login` / state-saving command. Auth happens inside each run via credentials.
- Documentation-as-source-of-truth mode.
- BUILD-documentation mode (separate product later).
- Parallel execution.
- HTML report across a run (raw artifacts are enough for v1).
- Watch mode.
- Multi-provider support (Claude Code only).

---

## 3. Architecture

```
qagent CLI (Node/TypeScript)
  ├─ loads qagent.config.json + goals.json + test-credentials.json
  ├─ for each goal (sequential):
  │    ├─ mkdir .qagent/runs/<timestamp>-<goal>/
  │    ├─ render prompt from .qagent/prompt.md + goal context
  │    ├─ spawn: claude -p "<prompt>" --allowed-tools "Bash(agent-browser:*) Read Write"
  │    ├─ [Claude drives agent-browser, takes screenshots, writes result.json + optional .spec.ts]
  │    ├─ parent reads result.json, collects artifacts
  │    └─ if pass + --record: validate generated .spec.ts and move to tests/e2e/playwright/generated/
  └─ print summary, exit 0 (all pass) or 1 (any fail/blocked)
```

**User must have installed:**
- Node.js ≥ 20
- Claude Code CLI (`claude` in PATH, logged in)
- `agent-browser` (Rust CLI from Vercel Labs, installed via npm/brew/cargo)
- Chrome (downloaded via `agent-browser install`)

**Installed by `qagent init`:**
- `@qagent/cli` (this package)
- Playwright (via `npm init playwright@latest` if not present)

---

## 4. CLI surface

```
qagent init                              # scaffold a project
qagent run                               # run all goals from config
qagent run --goal "..." --url "..."      # one-off
qagent run --goals tests/e2e/goals.json  # explicit goals file
qagent run ... --record                  # emit Playwright spec per pass
qagent doctor                            # verify deps (claude, agent-browser, chrome)
qagent --version
```

**Flags for `run`:**

| Flag | Default | Purpose |
| :--- | :--- | :--- |
| `--url <url>` | from config `baseUrl` | Target URL (required if not in config) |
| `--goal "<text>"` | — | One-off goal text (mutually exclusive with `--goals`) |
| `--goals <path>` | config `goalsFile` | Path to goals.json |
| `--config <path>` | `./qagent.config.json` | Config file |
| `--credentials <path>` | config `credentialsFile` | Test-credentials file |
| `--output <dir>` | `.qagent/runs` | Per-run output root |
| `--record` | false | Emit Playwright spec on pass |
| `--headed` | false | Run Chrome headed (debug) |
| `--keep-artifacts` | false | Keep run dir even on pass |
| `--max-steps <n>` | 40 | Step budget per goal (passed to prompt) |
| `--timeout <ms>` | 180000 | Wall-clock limit per goal |

**Exit codes:**

- `0` — all goals passed
- `1` — at least one goal failed or was blocked
- `2` — setup error (missing dep, invalid config)
- `3` — Claude Code session crashed (non-zero exit from `claude` itself)

---

## 5. Config file: `qagent.config.json`

```json
{
  "baseUrl": "https://staging.example.com",
  "goalsFile": "tests/e2e/goals.json",
  "credentialsFile": ".qagent/test-credentials.json",
  "outputDir": ".qagent/runs",
  "playwrightGeneratedDir": "tests/e2e/playwright/generated",
  "promptTemplate": ".qagent/prompt.md",
  "allowedTools": "Bash(agent-browser:*) Read Write",
  "browser": {
    "headless": true,
    "viewport": { "width": 1280, "height": 720 }
  },
  "record": false,
  "maxSteps": 40,
  "timeoutMs": 180000
}
```

All fields overridable via CLI flags. Config is validated on load (zod or similar).

---

## 6. Goals file: `goals.json`

```json
[
  {
    "name": "signup-new-user",
    "goal": "I can register a new user account, verify my email, and land on the welcome page."
  },
  {
    "name": "change-username",
    "goal": "I can login as the default user, go to my account profile and change my username to something random. When I reload that page, I see the new name."
  }
]
```

Rules:
- `name`: kebab-case, unique within file. Used as directory name, spec filename, and result key.
- `goal`: prose. No DSL, no assertions field. The goal text contains the success criteria implicitly (the AI is instructed to verify them).
- Order matters — goals run sequentially in file order.
- No shared state between goals. Each goal starts fresh.

---

## 7. Test credentials: `test-credentials.json`

Gitignored. Plain JSON, loaded and rendered into the prompt per goal.

```json
{
  "basicAuth": {
    "username": "staging",
    "password": "correct-horse-battery-staple"
  },
  "users": [
    { "label": "default", "email": "test@example.com", "password": "test1234" },
    { "label": "admin",   "email": "admin@example.com", "password": "admin1234" }
  ]
}
```

Env var interpolation supported (`"${STAGING_PASSWORD}"`). Goals reference users by label ("login as the default user", "login as admin") — the AI picks the right row.

---

## 8. Prompt template (default)

Stored at `.qagent/prompt.md`, rendered per goal with mustache-like substitution. Users can edit freely; `qagent init` re-creates it only if missing.

```
You are QAgent, an end-to-end test runner. Your job: verify the goal below
works against the live target app, and record evidence.

TARGET URL: {{url}}

GOAL:
{{goal}}

TEST CREDENTIALS (use as needed):
{{credentialsJson}}

TOOLS:
- You have Bash access restricted to `agent-browser`. You do not have
  unrestricted shell access.
- Use `agent-browser snapshot` to get an accessibility tree with @e-refs,
  then act on the refs (`click @e3`, `fill @e5 "..."`). Prefer @e-refs over
  CSS selectors.
- Use `agent-browser screenshot {{screenshotDir}}/NN-<step>.png` after every
  meaningful state change. Number them sequentially (01-, 02-, ...).

HARD RULES:
- Maximum {{maxSteps}} browser actions. If you cannot verify the goal within
  that budget, stop and record status=blocked.
- Do not navigate to any domain other than the TARGET URL's origin.
- Do not open new tabs unless the goal explicitly requires it.

WHEN DONE, WRITE A RESULT FILE TO: {{resultPath}}

Schema:
{
  "status": "pass" | "fail" | "blocked",
  "summary": "<one-sentence plain-language summary of what happened>",
  "failureReason": "<only if status != pass; specific, cites concrete evidence>",
  "stepsTaken": <int>,
  "evidence": ["<absolute path to screenshot>", ...]
}

Status definitions:
- pass: you verified the goal end-to-end. The behavior described happened.
- fail: the flow was testable, but the app did not behave as the goal described (this is a bug in the app).
- blocked: you could not actually run the goal to a conclusion (login failed, app crashed, step budget exhausted, missing data).

{{#record}}
ADDITIONALLY, IF status=pass: write a Playwright test at:
{{specPath}}

Requirements for the spec:
- Use @playwright/test syntax.
- Reproduce the path you took. Use accessible roles and text where possible
  (e.g. `page.getByRole('button', { name: 'Submit' })`), fall back to CSS
  only when necessary.
- Include an auth step at the top that logs in using the same credentials
  you used, rather than relying on storageState.
- One `test('...', async ({ page }) => { ... })` per spec.
- Keep it readable — a human should be able to maintain this file.
{{/record}}
```

Users override this by editing `.qagent/prompt.md`. We log a warning if the user's template is missing any of the required substitution markers (`{{url}}`, `{{goal}}`, `{{resultPath}}`).

---

## 9. Result contract: `result.json`

Written by Claude inside the agent session; read by the parent CLI.

```json
{
  "status": "pass",
  "summary": "User logged in, changed username from 'hauke' to 'hauke42', and the new name persisted after reload.",
  "failureReason": null,
  "stepsTaken": 14,
  "evidence": [
    ".qagent/runs/20260421-1043-change-username/01-login.png",
    ".qagent/runs/20260421-1043-change-username/02-profile.png",
    ".qagent/runs/20260421-1043-change-username/03-username-form.png",
    ".qagent/runs/20260421-1043-change-username/04-saved.png",
    ".qagent/runs/20260421-1043-change-username/05-reloaded.png"
  ]
}
```

Parent-CLI behavior on missing / malformed `result.json`: treat as `blocked` with `failureReason: "agent did not produce a valid result file"`. Never silently convert to `pass`.

---

## 10. Directory layout after `qagent init`

```
project-root/
├── package.json                        # qagent + playwright + agent-browser added
├── qagent.config.json                  # config
├── tests/
│   └── e2e/
│       ├── goals.json                  # example + user goals
│       └── playwright/                 # Playwright's own install (standard layout)
│           ├── playwright.config.ts
│           ├── tests/                  # hand-written Playwright tests
│           └── generated/              # QAgent writes here with --record
│               └── change-username.spec.ts
└── .qagent/                            # gitignored
    ├── prompt.md                       # default prompt template, user-overridable
    ├── test-credentials.json           # gitignored
    └── runs/
        └── 20260421-1043-change-username/
            ├── 01-login.png
            ├── 02-profile.png
            ├── ...
            ├── result.json
            └── claude-session.log      # full stdout/stderr of the claude call
```

---

## 11. `qagent init` behavior (step by step)

1. Verify `claude` in PATH. If missing → exit with install URL.
2. Verify `agent-browser` binary. If missing → `npm install -D agent-browser`, then `agent-browser install`.
3. Verify Chrome for Testing present. If not → `agent-browser install`.
4. Detect Playwright: look for `playwright.config.ts` anywhere under `tests/`. If absent → run `npm init playwright@latest -- tests/e2e/playwright` (non-interactive defaults: TypeScript, default browsers, don't add GitHub Actions).
5. Write `qagent.config.json` with sane defaults (pointing at `tests/e2e/playwright/generated` for specs).
6. Write `tests/e2e/goals.json` with one example goal.
7. Write `.qagent/prompt.md` with the default template.
8. Write `.qagent/test-credentials.json` with placeholder shape.
9. Append `.qagent/` and `tests/e2e/playwright/generated/` to `.gitignore` (user can remove the second line if they want to commit generated specs).
10. Print: next steps (`edit .qagent/test-credentials.json`, `edit tests/e2e/goals.json`, `qagent run`).

---

## 12. Allowed tools passed to Claude Code

```
--allowed-tools "Bash(agent-browser:*) Read Write"
```

Rationale:
- **`Bash(agent-browser:*)`** — Claude can invoke any `agent-browser` subcommand (click, fill, snapshot, screenshot, etc.). Nothing else bashable. No `curl`, no `git`, no arbitrary scripts.
- **`Read`** — needed to re-read the prompt context if required.
- **`Write`** — needed to produce `result.json` and the optional `.spec.ts`.

No web browsing, no network fetch, no MCP servers. Minimum viable surface.

We may need to add `Glob` later if prompts get fancier, but don't grant it yet.

---

## 13. Playwright test generation (with `--record`)

**Flow:**
1. Parent CLI passes `{{record}}=true` and a `{{specPath}}` into the prompt.
2. On pass, Claude writes a `.spec.ts` to `specPath`.
3. Parent CLI validates it by running `npx playwright test <specPath> --list` (no execution, just the AST check). If invalid → log warning, keep the file, do NOT fail the run.
4. Optionally (post-v1.0): run `npx playwright test <specPath>` headless as a smoke test. If it fails, move it to a `generated/.pending/` subdirectory with a note.

**Why not record via agent-browser trace?** Agent-browser's trace is a Chrome DevTools trace (`.trace` file), not a Playwright script. Converting traces to readable Playwright code is its own hard problem. Letting Claude write the spec directly is both simpler and produces better, more readable tests — Claude just walked the flow, it knows what happened.

**Generated spec must:**
- Live in `tests/e2e/playwright/generated/<goal-name>.spec.ts`.
- Include a leading comment: `// Generated by QAgent from goal "<name>" on <timestamp>. Safe to edit.`
- Log in using credentials, not a storageState. (Keeps specs self-contained for v1.)

---

## 14. 30-day build plan

**Week 1 — spike.**
- `qagent init` + `qagent run` skeletons with arg parsing (cac or commander).
- Config/goals/credentials loaders with schema validation.
- Prompt renderer (mustache or simple string substitution).
- Spawn `claude -p` with `--allowed-tools`; capture stdout/stderr to `claude-session.log`.
- Read `result.json`; emit JSON summary.

**Week 2 — shape.**
- Run end-to-end against a real demo app (e.g. a small Next.js app you own or a public staging target).
- Screenshot collection working; per-run directory layout correct.
- Multi-goal sequential run.
- Exit codes verified (0 / 1 / 2 / 3 paths exercised).
- `qagent doctor` subcommand.

**Week 3 — record.**
- `--record` flag → Playwright spec generation.
- Validate generated specs with `playwright test --list`.
- Verify at least 2–3 generated specs actually pass when run via `npx playwright test`.
- Handle credentials inside generated specs cleanly (read from env vars).

**Week 4 — ship.**
- README (English-first), CONTRIBUTING, LICENSE (MIT).
- Demo repo: `qagent-demo` with committed goals.json, `.qagent/prompt.md`, recorded runs, generated specs running green in GitHub Actions.
- Register `@qagent` npm org, publish `@qagent/cli@0.1.0`.
- Announce: English post on X + HN + r/ClaudeAI; German trailer on LinkedIn.

---

## 15. Open questions (deliberately deferred)

- **Flakiness policy.** Auto-retry on `blocked`? Claude-level retries are cheap but confusing in CI. Default: no retry in v1.
- **CI reporter formats.** JUnit XML? HTML report? v1.1.
- **Windows support.** agent-browser and Playwright both support Windows, but untested end-to-end. Mark Mac/Linux only in v1 README.
- **Session cost visibility.** Claude Code reports token usage in its output — parse and print per-goal in v1.1.
- **Goal-level baseURL override.** A goal that tests a different subdomain. Add to goals.json schema when first needed.
- **Documentation-as-source-of-truth mode.** Separate sub-command (`qagent run --docs <path>`). v1.1 candidate.
- **BUILD-documentation mode.** Separate product. Not in this tool.
- **Headless-by-default vs headed.** v1: headless by default, `--headed` for debug.

---

## 16. Explicit non-goals

Write them down so they stay out of v1:

- No proprietary agent runtime; QAgent is a wrapper.
- No multi-provider abstraction.
- No visual regression testing (agent-browser has `diff screenshot`, but that's a separate feature).
- No API testing, no load testing.
- No session state management (v1 expects test credentials; `qagent login` is a v1.1 candidate).
- No hosted / cloud mode.
- No shared state across goals in v1.

---

## 17. License and publication

- License: **MIT**.
- Repo: `github.com/<your-org-or-handle>/qagent` — public from day one.
- npm: `@qagent/cli` (register `@qagent` scope first on npmjs.com).
- Issue template, PR template, code of conduct: standard boilerplate. Keep it light.
- README structure: what it is, 30-second install + run, the prose-goal concept, link to demo repo, link to blog post, contributing.

---

## 18. Success criteria for v1 launch

- Someone other than you can `npm install -g @qagent/cli`, run `qagent init`, edit `goals.json`, `qagent run`, see a test pass with screenshots in under 15 minutes.
- At least one green Playwright spec has been generated from an AI run and runs independently in CI.
- Launch post generates ≥ 50 GitHub stars in the first week (soft signal that the positioning landed).
- At least one person files a substantive issue or PR (hard signal that it's being actually used).

If none of those fire within 30 days of launch: pause, reassess positioning before pushing on features.
