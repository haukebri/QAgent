# Pi-dev CLI Prep

## Research Summary

Pi packages should not invent a second credential store. Pi already resolves both API-key and OAuth/subscription auth through `AuthStorage` and `ModelRegistry`, backed by `~/.pi/agent/auth.json`, environment variables, and `models.json`.

For a QAgent package, Pi is best treated as an auth/model runtime, not as an LLM provider. The provider remains the actual model provider (`anthropic`, `openai`, `openai-codex`, `github-copilot`, `openrouter`, custom providers, etc.). The Pi integration should pass a request-auth resolver into QAgent instead of passing a single static API key.

## What Other Packages Do

- `@juicesharp/rpiv-advisor` lets the user pick from `ctx.modelRegistry.getAvailable()`, stores a `provider:model` key, resolves auth with `ctx.modelRegistry.getApiKeyAndHeaders(model)`, then calls `completeSimple(..., { apiKey, headers })`.
- `pi-agent-suite`'s `ask-llm` and `consult-advisor` use the current `ctx.model` by default, support explicit `provider/model` overrides via `ctx.modelRegistry.find(...)`, resolve auth with `getApiKeyAndHeaders`, then call `completeSimple`.
- `pi-agent-suite`'s `convene-council` starts child `pi` RPC processes for full subagent sessions, inheriting the Pi environment. That is useful for independent coding agents, but heavier than QAgent needs.
- `pi-agent-browser-native` registers a Pi tool around an upstream browser CLI. It keeps browser session ownership in the extension and forwards provider-related environment where the upstream CLI needs it.

## Recommended QAgent Shape

1. Keep the standalone CLI path API-key based for npm users.
2. Keep `--provider` meaning the model provider; do not overload it with `pi`.
3. Add a Pi extension/package wrapper later that calls QAgent internals directly and supplies:
   - `model`: `ctx.model` by default, or `ctx.modelRegistry.find(provider, modelId)` for overrides.
   - `resolveRequestAuth(model)`: call `ctx.modelRegistry.getApiKeyAndHeaders(model)`, throw or surface the error when `ok` is false, and return `{ apiKey, headers }` when it succeeds.
4. If a CLI flag is needed for a spawned command, prefer `--auth-source pi` or `--auth pi` over `--provider pi`.
5. For the eventual Pi package, list Pi core packages as peer dependencies with `"*"` and use the current `@earendil-works/*` namespace; package docs say Pi bundles those core packages for extensions.

## Prep Done Here

The driver and verifier now accept a request-auth resolver via `src/llm-auth.js`. The standalone CLI still resolves one API key exactly as before, but internally the LLM call path can now carry both `apiKey` and `headers`, which matches the successful result of Pi's `getApiKeyAndHeaders()` contract.

See `docs/pi-dev-wrapper-usage.md` for the proposed wrapper contract and manual smoke-test plan.
