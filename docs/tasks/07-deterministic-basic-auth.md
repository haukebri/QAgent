# Task 07: Deterministic Basic Auth From Goal URL

Source: post-MVP run review of `req-eng-frontend` goal — 6 of 9 navigates failed with `net::ERR_INVALID_AUTH_CREDENTIALS` because the LLM put basic-auth credentials in the URL and Chrome inconsistently honored them.

## Problem

The QAgent system prompt currently instructs the LLM to embed basic-auth credentials in the URL when a site requires them:

> If the website requires basic auth, include the username and password in the URL as `https://username:password@example.com`.

Chrome treats credentials in URLs inconsistently — `https://user:pass@host/` works some of the time and fails with `net::ERR_INVALID_AUTH_CREDENTIALS` other times, depending on origin policy state, prior session cookies, and Chromium version. In the post-MVP runs against `req-eng-frontend.haukebrinkmann.com`, 6 of 9 attempts failed at the navigate step with that error. Three attempts that did get through used the same URL pattern and succeeded by chance.

The runner already supports `httpCredentials` via `launchPage({ httpCredentials })` (see `src/browser.js`); it just isn't routed from goal-text URLs. Letting the LLM decide whether/how to encode credentials is both flaky and unnecessary — `httpCredentials` is the deterministic path.

## Goal

Move basic-auth handling out of the LLM. When the goal text contains a URL with embedded credentials, parse them deterministically before launching the browser, set `httpCredentials`, and feed the LLM a credential-free URL.

## Scope

### Pre-launch credential extraction

In `src/cli.js` (or `src/runner.js` if one exists), before `launchPage`:

- Scan the goal string for URL-with-credentials patterns: `/https?:\/\/([^:/]+):([^@]+)@/g`.
- If found:
  - Parse the first match into `{ username, password }`.
  - Build `httpCredentials = { username, password }` and pass to `launchPage`.
  - Rewrite the goal string in-place so every occurrence of `https?://user:pass@host/...` becomes `https?://host/...`. The LLM never sees the credentials.
- If multiple URLs with different credentials appear, take the first set and warn (rare; stay simple).
- Existing `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` environment variables continue to take precedence over goal-text credentials.

### System prompt cleanup

In `src/executor.js`'s `SYSTEM_PROMPT`, remove the line:

> If the website requires basic auth, include the username and password in the URL as `https://username:password@example.com`.

The LLM no longer needs to know about basic auth — by the time it sees the goal, credentials are already wired into the browser context.

### Help text

`src/cli.js` `--help` and `docs/project-architecture.md` should document that goal-text URLs with embedded credentials are honored; `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` envs still work for cases where the goal doesn't include credentials.

## Non-Goals

- No interactive credential prompt.
- No support for Bearer / OAuth / cookie-based auth in this task — those need separate design.
- No support for multiple distinct credentials in one goal.

## Acceptance Criteria

- A goal like `Visit https://user:pass@example.com/foo and ...` causes the runner to launch the browser with `httpCredentials = { username: 'user', password: 'pass' }`, navigate to `https://example.com/foo`, and feed the LLM the same credential-free URL.
- The `req-eng-frontend.haukebrinkmann.com` goal that currently fails ~67% of runs with `ERR_INVALID_AUTH_CREDENTIALS` succeeds deterministically (modulo unrelated LLM judgment).
- The system prompt no longer mentions URL-embedded basic auth.
- `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` env vars still work and override goal-text credentials.
- Goals without embedded credentials are unaffected.
