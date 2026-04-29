# qa harness goal

A test runner where you write tests in natural language and an LLM drives the browser.

## what it does

You write: "User can sign up with email and password, then log in."

Harness opens a browser, figures out the steps, runs them, checks the result. Pass or fail, plus a trace for debugging.

## how

Script drives the browser. A driver LLM picks the next action. A separate verifier LLM judges the final browser state.

## what we do not build

- playwright code generation
- SaaS product
- wrapper around claude code, codex, or other vendor harnesses

## constraints

- minimal code
- open source
- runs local or in CI
- small local models eventually. start with a big one, dumb it down later.
- Multiple LLM providers supported via pi-ai (default `openrouter`; Anthropic, OpenAI, Google have per-provider env-var fallbacks). See `docs/providers.md`.

## why

- manual tests do not scale
- playwright tests break on UI changes
- existing AI QA tools lock you into hosted services and frontier models
