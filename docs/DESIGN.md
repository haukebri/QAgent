# QAgent — Design

A CLI that runs prose-written end-to-end goals against a live web app using Claude Code or Codex plus `agent-browser`, produces screenshot evidence, and returns a pass, fail, or blocked verdict.

QAgent is intentionally narrow: it is a test runner wrapper around a coding-agent CLI, not a broader automation platform and not a Playwright generator.

---

## 1. Why This Exists

AI writes a lot of product code now, but the real question is still simple: does the thing actually work?

Traditional E2E tools are powerful, but they make you write detailed test code before you can even try a flow. AI browser tools are fast to explore with, but often weak on repeatability, output structure, and project ergonomics.

QAgent sits between those:

- you write the goal in plain language
- QAgent runs it against a real URL
- it records evidence and a machine-readable verdict
- it exits like a normal CLI tool for local use or CI

The core product bet is that many UI checks are easier to describe in prose than to encode up front.

---

## 2. Current Scope

### In Scope

- CLI run command via `qagent`
- `qagent doctor`
- `qagent skill install`, `qagent skill uninstall`, and `qagent skill path`
- `qagent skills get core`
- repository-native skill install via `npx skills add <repo> --skill qagent`
- one-off runs with `--goal`
- multi-goal runs via `goals.json`
- optional parallel execution with `--parallel`
- vendor selection via `--vendor claude|codex` (Claude default)
- fresh browser session per goal
- deterministic browser startup before the model begins
- HTTP basic auth support
- in-app login credentials passed to the model
- optional project skills description passed to the model
- screenshot evidence in per-run artifact directories
- `result.json` per goal
- CLI summary output and stable exit codes

### Explicitly Out of Scope

- Playwright generation or code export
- `qagent init`
- prompt-template editing or prompt file overrides
- HTML report generation
- watch mode
- shared browser/session state between goals

If Playwright generation returns later, it should live in a separate tool that depends on QAgent rather than inside this CLI.

---

## 3. Architecture

```text
qagent CLI (Node/TypeScript)
  ├─ loads qagent.config.json
  ├─ resolves goals + credentials + optional skills description
  ├─ for each goal:
  │    ├─ mkdir .qagent/runs/<timestamp>-<goal>-<unique>/
  │    ├─ start agent-browser session
  │    ├─ apply HTTP basic auth (if configured)
  │    ├─ open the target URL before the agent starts
  │    ├─ render built-in prompt with goal context
  │    ├─ spawn: selected vendor CLI with the built-in prompt
  │    ├─ the agent drives the already-open browser and writes result.json
  │    ├─ parent reads result.json and classifies the result
  │    └─ parent writes a vendor-specific session log for debugging
  └─ print summary, exit 0 / 1 / 2 / 3
```

### Why Browser Sessions Start Before The Agent

- basic auth is deterministic instead of left to the model
- unreachable URLs fail before spending AI time
- the agent starts from a real loaded page
- this is a better fit for CI-style CLI behavior

---

## 4. CLI Surface

```bash
qagent                                  # run all goals from config
qagent --goal "..." --url "..."         # one-off run
qagent --goals goals.json               # explicit goals file
qagent --vendor codex                   # run with Codex instead of Claude
qagent --parallel                       # opt into parallel multi-goal runs
qagent --headed                         # visible browser window
qagent doctor                           # verify local dependencies
qagent skill install                    # install the bundled Claude Code skill
qagent skill uninstall                  # remove the installed Claude Code skill
qagent skill path                       # print the resolved Claude skill path
qagent skills get core                  # print the runtime assistant workflow text
qagent --version
```

### Run Flags

| Flag | Default | Purpose |
| :--- | :--- | :--- |
| `--url <url>` | from config `baseUrl` | Target URL |
| `--goal "<text>"` | — | One-off goal text |
| `--goals <path>` | config `goalsFile` | Path to goals file |
| `--config <path>` | `./qagent.config.json` | Config file |
| `--credentials <path>` | config `credentialsFile` | Credentials file |
| `--skills <path>` | config `skillsFile` | Skills-description file |
| `--vendor <vendor>` | `claude` | Agent vendor (`claude` or `codex`) |
| `--timeout <ms>` | `180000` | Wall-clock limit per goal |
| `--parallel` | false | Run multi-goal suites in parallel |
| `--headed` | false | Run Chrome visibly for debugging |

### Exit Codes

- `0` — all goals passed
- `1` — at least one goal failed or was blocked
- `2` — setup error (invalid config, missing files, missing dependency, browser pre-start failure)
- `3` — selected vendor session crashed

Suite mode preserves infrastructure exit codes. If one goal hits a setup error or vendor crash, the suite exit code reflects that.

---

## 5. Config File: `qagent.config.json`

```json
{
  "vendor": "claude",
  "baseUrl": "https://staging.example.com",
  "goalsFile": "goals.json",
  "credentialsFile": ".qagent/test-credentials.json",
  "skillsFile": "skills.md",
  "timeoutMs": 180000
}
```

Current config fields:

- `vendor`
- `baseUrl`
- `goalsFile`
- `credentialsFile`
- `skillsFile`
- `timeoutMs`

Config is validated on load. CLI flags override config values.

---

## 6. Goals File: `goals.json`

```json
[
  {
    "name": "login-dashboard",
    "goal": "I can login as the default user and see the dashboard overview."
  },
  {
    "name": "change-username",
    "goal": "I can login, open my profile, change my username, and still see the new name after reload."
  }
]
```

Rules:

- `name` must be unique and kebab-case
- `goal` is plain prose, not a DSL
- order matters in sequential mode
- each goal starts from a fresh browser session

Default expectation: `goals.json` in the project root. Users can point elsewhere through config or `--goals`.

---

## 7. Credentials File: `.qagent/test-credentials.json`

Gitignored. Plain JSON. Rendered into the prompt for each goal.

```json
{
  "basicAuth": {
    "username": "staging",
    "password": "${BASIC_AUTH_PASSWORD}"
  },
  "users": [
    {
      "label": "default",
      "email": "test@example.com",
      "password": "${TEST_USER_PASSWORD}"
    },
    {
      "label": "admin",
      "email": "admin@example.com",
      "password": "${ADMIN_PASSWORD}"
    }
  ]
}
```

Notes:

- env-var interpolation is supported
- `basicAuth` is applied before page load
- user credentials are still passed into the selected agent for in-app login steps

---

## 8. Skills Description File: `skills.md`

Optional, but highly valuable for vibe-coded products and internal tools.

This file gives QAgent the app context that a human teammate might otherwise know from memory:

- product vocabulary
- role expectations
- common workflows
- seeded-data assumptions
- UI quirks or non-obvious navigation

Example:

```md
- This is a B2B dashboard app.
- The main post-login landing page is called "Overview".
- "Workspace" means the currently selected customer account.
- Most user actions happen from the left sidebar and top command menu.
```

Important rule: this file is **context, not proof**. QAgent must still verify behavior live in the browser.

---

## 9. Prompt Contract

The prompt is currently built into the CLI, not read from a user-editable template file.

It includes:

- target URL
- goal text
- test credentials
- optional skills description
- run artifact paths
- instructions for using `agent-browser`
- a note that the browser session is already started

The prompt should keep steering focused on:

- using `agent-browser snapshot` and ref-based actions
- taking screenshots after meaningful state changes
- writing a valid `result.json`
- treating project context as helpful guidance, not as evidence

---

## 10. Result Contract: `result.json`

Written by the selected agent during the run. Read by the parent CLI.

```json
{
  "status": "pass",
  "summary": "User logged in and reached the dashboard overview.",
  "failureReason": null,
  "stepsTaken": 7,
  "evidence": [
    ".qagent/runs/20260422-1430-login-dashboard-ab12cd/01-login.png",
    ".qagent/runs/20260422-1430-login-dashboard-ab12cd/02-dashboard.png"
  ]
}
```

Parent behavior on missing or malformed `result.json`:

- classify as `blocked`
- summary becomes `Agent did not produce a valid result file`
- never silently convert to `pass`

---

## 11. Directory Layout

```text
project-root/
├── qagent.config.json
├── goals.json
├── skills.md                        # optional, usually committed
└── .qagent/
    ├── test-credentials.json        # gitignored
    └── runs/
        └── 20260422-1430-login-dashboard-ab12cd/
            ├── 01-login.png
            ├── 02-dashboard.png
            ├── result.json
            └── claude-session.log      # or codex-session.log
```

---

## 12. `qagent doctor`

`qagent doctor` should be the quick “is my machine ready?” command.

Current checks:

- Node.js version
- selected vendor CLI in `PATH`
- `agent-browser` in `PATH`
- a real headless `agent-browser open about:blank` launch
- for Claude, bundled skill install status

This command should stay lightweight and fast.

If the browser-launch check fails, the likely next step is `agent-browser install`.

---

## 13. Claude Code Skill Distribution

QAgent also ships a Claude Code skill as a secondary distribution surface.

- the repo-native skill lives at `skills/qagent/SKILL.md`
- the runtime workflow content lives at `skills/qagent/core.md`
- `qagent skill install` copies the stub into the user's Claude config directory
- `qagent skills get core` prints the current workflow content from the installed CLI
- `npx skills add <repo> --skill qagent` can install the same skill directly from the Git repository
- `.claude-plugin/marketplace.json` advertises the skill to Claude-compatible tooling
- installation is explicit, never automatic on package install
- the stub keeps the install stable while the runtime content stays aligned with the installed QAgent version
- the skill helps new Claude Code sessions route prose QA requests toward QAgent

---

## 14. Non-Goals

Keep these out unless the product direction changes:

- Playwright generation
- scaffolding via `qagent init`
- arbitrary shell/network tooling for the model
- multi-provider orchestration
- shared goal state
- hosted/cloud execution

---

## 15. Open Questions

- Should `doctor` also verify Chrome availability more directly?
- Should skills descriptions stay as a free-form text file, or later become structured?
- Should we add retry policy for `blocked` runs?
- Do we want a user-editable prompt file later, or keep prompt design internal?
- If a separate Playwright tool exists later, what artifact contract should it consume from QAgent?
