# QAgent

QAgent is a CLI that runs prose-driven end-to-end browser QA checks against live web apps. It wraps Claude Code plus `agent-browser`, records screenshot evidence, and returns `pass`, `fail`, or `blocked` verdicts for each goal.

Your job when this skill activates: help the user run QAgent, draft goals in the right style, and interpret the results honestly.

## Preflight

Before acting:

1. Check that `qagent` is available (`which qagent` or `qagent --version`). If it is missing, tell the user to run `npm install -g @qagent/cli`.
2. Check whether the current directory has `qagent.config.json`. If yes, prefer project mode. If no, use one-off mode.
3. If anything looks off, run `qagent doctor`. It verifies Node, Claude Code, `agent-browser`, browser startup, and the installed QAgent skill stub.

## Invocation Modes

One-off mode:

```bash
qagent --url <url> --goal "<plain-English goal>"
```

Project mode:

```bash
qagent
```

Explicit goals file:

```bash
qagent --goals <path> --url <url>
```

Use `--parallel` only if the user explicitly asks for parallel execution.

## Writing Goals

Goals must describe user-visible outcomes in plain English. Never selectors, HTTP codes, or implementation details.

Good:

- "I can log in as the default user and see the dashboard overview."
- "I can add a product to the cart and reach the checkout screen."
- "The password reset email link opens a working reset form."

Bad:

- "POST /api/login returns 200"
- "Click the `#submit` button and assert the URL matches /dashboard"

When the user describes a flow, draft a goal in this style before saving or running it.

## Running And Reporting

1. Invoke `qagent`.
2. Stream or capture the output.
3. Each run produces artifacts in `.qagent/runs/<timestamp>/`:
   - `result.json` for the verdict
   - screenshots for evidence
   - `claude-session.log` for the inner session transcript
4. Report each goal's verdict with a short summary and the artifact paths.
5. On `blocked`, inspect `claude-session.log` to diagnose setup issues, auth problems, missing data, or browser failures.
6. On `fail`, summarize what the app did versus what the goal expected, grounded in the captured evidence.

## Exit Codes

- `0`: all goals passed
- `1`: at least one goal failed or was blocked
- `2`: setup error
- `3`: Claude Code session crashed

## Project Context

If the repo has a `skills.md` file, that is QAgent's app-context input. It can describe terminology, seeded data, roles, and UI quirks. QAgent passes it to the inner session automatically.

Treat `skills.md` as context, not proof. QAgent still has to verify behavior live in the browser.

## Hard Constraints

- Never fabricate results. Always run `qagent` and report what it actually returned.
- Never generate Playwright code. QAgent does not produce Playwright output.
- Goals must describe user-visible outcomes, not selectors or implementation details.
- Each goal runs in a fresh browser session. Do not assume shared login state across goals.
- Parallel execution is opt-in only. Never pass `--parallel` unless the user explicitly asks.
