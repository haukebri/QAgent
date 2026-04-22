# QAgent

**Write a test goal in plain English. QAgent runs it against your app and tells you if it actually works.**

QAgent is a CLI for AI-native QA. It uses Claude Code plus `agent-browser`, records screenshots, and returns a simple verdict: `pass`, `fail`, or `blocked`.

This repo is intentionally focused:

- no Playwright generation
- no giant setup wizard
- no custom runtime
- just real browser checks from plain-language goals

Best used from Claude Code, Codex, Cursor, Gemini CLI, or any coding agent that can run shell commands.

## The 30-Second Test

No config. No scaffold. Just run one goal against a live app.

```bash
npm install -g @qagent/cli
qagent doctor
qagent --url https://github.com/haukebri/QAgent --goal "I can see how qagent can be used"
```

That is enough to prove the full loop works without needing a local app first.

## Claude Code Skill

QAgent also ships a Claude Code skill so new Claude sessions can auto-trigger on requests like "verify the login flow" or "smoke test this app."

If you want the ecosystem-native install flow, use the open skills CLI:

```bash
npx skills add haukebri/QAgent --skill qagent -g -a claude-code
```

That installs the skill directly from this repository in the format `skills` expects.

```bash
npm install -g @qagent/cli
qagent skill install
```

That installs a small discovery stub into your Claude config directory without making you hunt for `~/.claude` yourself.
The stub tells the assistant to load the current workflow text from the installed CLI with `qagent skills get core`, which keeps the instructions aligned with the QAgent version you actually have.

For cleanup or inspection:

```bash
qagent skill uninstall
qagent skill path
qagent skills get core
```

## Tell Your AI

The current best UX for tools like this is to tell your coding agent exactly what to do.

### Simple One-Off Check

Tell Claude Code, Codex, or your coding agent:

> Install QAgent, run `qagent doctor`, then test `https://github.com/haukebri/QAgent` with this goal: `I can see how qagent can be used`. Show me whether it passed and where the screenshots were saved.

### Set It Up For This Project

When the one-off run works, tell your agent:

> Set up QAgent for this repo. Create `qagent.config.json`, `goals.json`, `.qagent/test-credentials.json`, and `skills.md`. Use sensible defaults for this project, keep credentials gitignored, and add 2-3 useful smoke-test goals I can run with `qagent`.

### Common Prompts

Just tell your AI:

- `Run QAgent against my local app and tell me exactly what broke.`
- `Add a goal for login and dashboard visibility, then run it.`
- `Use QAgent to verify the onboarding flow after your last changes.`
- `Create a skills.md for this app so future QAgent runs understand our terminology.`
- `Run all QAgent goals in parallel and summarize only the failures.`

## Why People Use It

QAgent is for the moment after vibe coding:

- you changed the app
- it looks right at a glance
- now you want a real browser to prove the flow still works

Why teams like it:

- goals stay in plain English
- it tests the live app, not a mock
- it saves screenshots as evidence
- it works well with coding agents
- it supports both one-off checks and project-local suites
- it can use credentials and app-specific context
- it can run multi-goal suites in parallel when speed matters

## How It Works

```text
You write a goal
    ->
QAgent starts a fresh browser session
    ->
QAgent opens your app before Claude starts
    ->
Claude uses agent-browser to verify the flow
    ->
QAgent reads result.json and saves screenshots
    ->
You get pass / fail / blocked
```

Important details:

- each goal gets a fresh browser session
- HTTP basic auth can be applied before page load
- app login credentials can be passed in
- screenshots and `claude-session.log` are saved per run
- browser startup happens outside the prompt for better reliability

## Project Mode

Once you want more than one ad-hoc test, add project-local files.

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
    "name": "login-dashboard",
    "goal": "I can login as the default user and see the dashboard overview."
  },
  {
    "name": "change-username",
    "goal": "I can login, open my profile, change my username, and still see the new name after reload."
  }
]
```

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

### `skills.md`

This file is optional, but it is especially valuable for vibe-coded apps and internal tools.

Use it to explain product context your AI would not know by default:

- what your product calls key pages or entities
- what `workspace`, `overview`, `project`, or `dashboard` mean
- which user roles exist
- any seeded data assumptions
- weird UI patterns or navigation quirks

Example:

```md
- This is a B2B dashboard app.
- The main post-login landing page is called "Overview".
- "Workspace" means the currently selected customer account.
- Most important user actions happen from the left sidebar.
```

Think of `skills.md` as product context, not truth. QAgent still has to verify behavior live in the browser.

## Usage

```bash
# Run all goals from config
qagent

# Run one goal without config
qagent --url https://github.com/haukebri/QAgent --goal "I can see how qagent can be used"

# Run goals from a specific file
qagent --goals tests/e2e/goals.json --url https://staging.example.com

# Run goals in parallel
qagent --parallel

# Use a custom config
qagent --config path/to/qagent.config.json

# Override credentials or skills
qagent --credentials .qagent/staging-creds.json --skills skills.md

# Open a visible browser window
qagent --headed

# Verify the local machine is ready
qagent doctor

# Install or remove the Claude Code skill
qagent skill install
qagent skill uninstall
qagent skill path

# Print the runtime assistant workflow content
qagent skills get core
```

## CLI Options

| Flag | Default | Description |
| :--- | :--- | :--- |
| `--url <url>` | from config `baseUrl` | Target URL |
| `--goal <text>` | - | Single goal |
| `--goals <path>` | from config `goalsFile` | Path to goals file |
| `--config <path>` | `./qagent.config.json` | Config file |
| `--credentials <path>` | from config `credentialsFile` | Credentials file |
| `--skills <path>` | from config `skillsFile` | Skills description file |
| `--timeout <ms>` | `180000` | Wall-clock limit per goal |
| `--parallel` | `false` | Run suite goals concurrently |
| `--headed` | `false` | Run Chrome visibly for debugging |

## Exit Codes

| Code | Meaning |
| :--- | :--- |
| `0` | All goals passed |
| `1` | At least one goal failed or was blocked |
| `2` | Setup error |
| `3` | Claude Code session crashed |

## Requirements

- Node.js >= 20
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) in `PATH`, logged in
- [`agent-browser`](https://www.npmjs.com/package/agent-browser) in `PATH`
- Chrome installed for `agent-browser` via `agent-browser install`

`qagent doctor` checks Node, `claude`, `agent-browser`, and does a real headless browser startup check.
It also tells you whether the bundled Claude Code skill stub is installed and up to date.

## Output

Each goal creates a run directory under `.qagent/runs/`:

```text
.qagent/runs/20260422-1430-login-dashboard-ab12cd/
  ├── 01-login.png
  ├── 02-dashboard.png
  ├── result.json
  └── claude-session.log
```

## Philosophy

QAgent is not trying to replace your whole testing stack.

It is for the very useful middle ground between:

- "I just changed a bunch of UI with an agent"
- and
- "I need a crisp signal that this flow still works"

The product idea is simple:

- keep the test definition human-readable
- make the browser run real
- keep the verdict crisp
- make it easy for AI agents to use

## License

MIT - see [LICENSE](./LICENSE)
