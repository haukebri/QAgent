# QAgent

**Write test goals in plain English. QAgent verifies them against your live app.**

QAgent drives [Claude Code](https://www.anthropic.com/claude-code) with [`agent-browser`](https://github.com/vercel-labs/agent-browser), records screenshot evidence, and returns a pass, fail, or blocked verdict for each goal.

This tool is intentionally focused: **no Playwright generation in this repo**. If code generation comes back later, it should live in a separate tool built on top of QAgent.

> Status: pre-alpha. Design doc: [`docs/DESIGN.md`](./docs/DESIGN.md)

## Quick Start

```bash
# 1. Install the CLI
npm install -g @qagent/cli

# 2. Create your project-local files
cat > qagent.config.json <<'EOF'
{
  "baseUrl": "https://staging.example.com",
  "goalsFile": "goals.json",
  "credentialsFile": ".qagent/test-credentials.json",
  "skillsFile": "skills.md",
  "timeoutMs": 180000
}
EOF

cat > goals.json <<'EOF'
[
  {
    "name": "login-dashboard",
    "goal": "I can login as the default user and see the dashboard overview."
  }
]
EOF

mkdir -p .qagent
cat > .qagent/test-credentials.json <<'EOF'
{
  "users": [
    {
      "label": "default",
      "email": "test@example.com",
      "password": "${TEST_USER_PASSWORD}"
    }
  ]
}
EOF

cat > skills.md <<'EOF'
- This is a B2B dashboard app.
- The main post-login landing page is called "Overview".
- "Workspace" means the currently selected customer account.
EOF

# 3. Verify dependencies
qagent doctor

# 4. Run all configured goals
qagent
```

## Usage

```bash
# Run all goals from config
qagent

# Run a single goal
qagent --goal "I can login and see the dashboard" --url https://staging.example.com

# Run goals from a specific file
qagent --goals tests/e2e/goals.json --url https://staging.example.com

# Run goals in parallel
qagent --goals goals.json --parallel

# Provide a custom skills description
qagent --skills skills.md

# Open a visible browser window for debugging
qagent --headed

# Check local dependencies
qagent doctor
```

### Options

| Flag | Default | Description |
|:-----|:--------|:------------|
| `--url <url>` | from config `baseUrl` | Target URL |
| `--goal <text>` | — | Single goal (mutually exclusive with `--goals`) |
| `--goals <path>` | from config `goalsFile` | Path to goals.json |
| `--config <path>` | `./qagent.config.json` | Config file |
| `--credentials <path>` | from config `credentialsFile` | Credentials file |
| `--skills <path>` | from config `skillsFile` | Skills description file |
| `--timeout <ms>` | `180000` | Wall-clock limit per goal |
| `--parallel` | `false` | Run goals concurrently |
| `--headed` | `false` | Run Chrome in a visible window |

### Exit Codes

| Code | Meaning |
|:-----|:--------|
| `0` | All goals passed |
| `1` | At least one goal failed or was blocked |
| `2` | Setup error (missing dep, invalid config, invalid files) |
| `3` | Claude Code session crashed |

## Project Files

### `qagent.config.json`

```json
{
  "baseUrl": "https://staging.example.com",
  "goalsFile": "goals.json",
  "credentialsFile": ".qagent/test-credentials.json",
  "skillsFile": "skills.md",
  "timeoutMs": 180000
}
```

### `goals.json`

```json
[
  {
    "name": "login-flow",
    "goal": "I can login with the default user and see the dashboard overview."
  },
  {
    "name": "change-username",
    "goal": "I can login, go to my profile, change my username, and see the new name after reload."
  }
]
```

Goals are prose. No DSL, no selectors, no code assertions. The goal text is the success criteria.

### `.qagent/test-credentials.json`

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
    }
  ]
}
```

- Environment-variable interpolation via `${VAR_NAME}`
- `basicAuth` is applied before the page opens
- The AI can still use the user credentials for in-app login flows

### `skills.md`

This is optional, but especially useful for vibe-coded apps and custom internal tools. It gives QAgent the product context a human teammate would normally know already.

Good things to put there:

- Product terminology: what “workspace”, “project”, or “overview” means
- Important workflows: what users usually do first after login
- UI quirks: drawers, command menus, multi-step forms, unusual navigation
- Expected roles: admin vs default user, staging-only behavior, seeded data assumptions

Important: this file is context, not truth. QAgent still has to verify everything live in the browser.

## How It Works

```text
qagent CLI
  ├─ loads config + goals + credentials + optional skills description
  ├─ for each goal:
  │    ├─ starts a fresh agent-browser session
  │    ├─ applies basic auth if configured
  │    ├─ opens the target URL before Claude starts
  │    ├─ spawns: claude -p "<prompt>" --allowedTools "Bash(agent-browser:*) Read Write"
  │    ├─ Claude drives the browser, takes screenshots, writes result.json
  │    └─ parent reads result.json and classifies the result
  └─ prints a summary table and exits 0 / 1 / 2 / 3
```

Why pre-start the browser session:

- Basic auth is deterministic instead of left to the model
- Broken URLs fail before spending AI time
- Claude starts from a real loaded page, which improves consistency

Why keep `--parallel`:

- It is a major speed win for multi-goal smoke runs
- The user can opt in only when they want it
- Each goal still runs in an isolated browser session

## Requirements

- **Node.js** >= 20
- **[Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)** in `PATH`, logged in
- **[agent-browser](https://www.npmjs.com/package/agent-browser)** in `PATH`
- **Chrome** installed for `agent-browser` via `agent-browser install`

`qagent doctor` currently checks the local CLI dependencies. If first-run browser startup still fails, run `agent-browser install`.

## Output

Each goal creates a run directory under `.qagent/runs/`:

```text
.qagent/runs/20260422-1430-login-flow-a1b2c3/
  ├── 01-landing.png
  ├── 02-login-form.png
  ├── 03-dashboard.png
  ├── result.json
  └── claude-session.log
```

## License

MIT — see [LICENSE](./LICENSE).
