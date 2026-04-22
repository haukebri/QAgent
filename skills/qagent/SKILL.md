---
name: qagent
description: Run prose-driven end-to-end browser QA tests with QAgent. Use this skill when the user asks to E2E test, smoke test, QA, or verify a web application flow in a real browser — for example "verify the login flow", "test checkout end-to-end", "QA this feature", "run our goals", "check if signup works", "smoke test the UI", or any request to run browser-based correctness checks against a live web app. Also triggers when the user mentions qagent, qagent.config.json, goals.json, or a .qagent/ directory. Do NOT use for unit tests, API tests, or Playwright test generation.
---

# QAgent

This file is a discovery stub, not the full workflow guide.

Before acting, load the current QAgent assistant instructions from the installed CLI:

```bash
qagent skills get core
```

Why this exists:

- the installed stub stays stable
- the real workflow text comes from the installed QAgent version
- the instructions can evolve without leaving copied skill files stale

If `qagent` is not available on PATH, tell the user to install it with:

```bash
npm install -g @qagent/cli
```
