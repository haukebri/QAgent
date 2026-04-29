# LLM Provider Abstraction

## Context

QAgent today is wired exclusively to **OpenRouter**, even though the underlying LLM library (pi-ai) already supports 21+ providers through the same API — Anthropic, OpenAI, Google, Groq, xAI, Mistral, Cerebras, Bedrock, and a long tail of others.

The consequences:

- Users who already have an **Anthropic or OpenAI key** have no way to use it without going through OpenRouter (extra hop, extra cost margin, extra account).
- The CLI's help text and error messages reference OpenRouter exclusively, reinforcing the lock-in feel — a user on Anthropic who sees "get a key at openrouter.ai/keys" in an error message is being misdirected.
- Provider-specific environment variables that users already have (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`) are ignored. Only `QAGENT_API_KEY` and `OPENROUTER_API_KEY` are recognized today.

The fix is small in code but has real surface-area decisions in config, env vars, defaults, and error UX — hence this milestone.

---

## Status

[pending]

---

## Goals / Scope

- Let the user pick **any pi-ai-supported provider** through a new `provider` config key.
- Provider selectable through the same precedence chain we already use elsewhere: **flag > env > project config > user config > default**, to stay consistent with the existing config story (`docs/cli-approach.md` §3).
- **Provider-aware help and error messages** — when the user is on Anthropic, the "missing API key" error points them at Anthropic's console, not OpenRouter's.
- **Per-provider env-var fallbacks** for the four most common providers (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`) so users with existing provider-specific env vars don't have to rename them. `QAGENT_API_KEY` remains the canonical, provider-agnostic env var.

### Resolved decisions

| Decision | Choice |
|---|---|
| Default provider | `openrouter` (preserves the current zero-config experience). |
| Driver vs. verifier provider | Single `provider` config, used for both. `verifierModel` still differs from `model` as today. Cross-provider driver/verifier deferred until a real use case appears. |
| Per-provider env-var breadth | Top 4 only: `openrouter`, `anthropic`, `openai`, `google`. `QAGENT_API_KEY` is the leading variable; per-provider names are nice-to-haves. |
| Legacy `OPENROUTER_API_KEY` fallback | Removed. The variable still works when `provider=openrouter` (the default) via the per-provider map, so existing setups are unaffected. No special-case code path. |

---

## Design

### Module boundary

A new file `src/providers.js` owns everything provider-specific. It exports:

```
PROVIDERS                                  // static map; one row per supported provider
resolveApiKey({ provider, flags, env, project, user })
                                           // returns { apiKey, source } or throws ConfigError
providerHelpUrl(provider)                  // string for "go get a key" line; null for non-top-4
```

`PROVIDERS` rows (4 entries):

| key | keyEnv | keyUrl |
|---|---|---|
| `openrouter` | `OPENROUTER_API_KEY` | `https://openrouter.ai/keys` |
| `anthropic` | `ANTHROPIC_API_KEY` | `https://console.anthropic.com/settings/keys` |
| `openai` | `OPENAI_API_KEY` | `https://platform.openai.com/api-keys` |
| `google` | `GEMINI_API_KEY` | `https://aistudio.google.com/apikey` |

The pi-ai `Model` object is constructed only in `cli.js` and passed as an opaque argument from there on. `executor.js`, `verifier.js`, `tools.js`, `observe.js`, `recorder.js`, `browser.js`, `reporters.js` are **untouched**.

### Touched files

- **`src/providers.js`** — new file with the three exports above.
- **`src/cli.js`** —
  - Add `--provider <name>` to `VALUE_FLAGS` (mapped to `provider`).
  - Resolve `provider` with the standard precedence chain (default `openrouter`).
  - Replace the inline 5-step API-key chain with `resolveApiKey(...)`.
  - Replace both `getModel('openrouter', ...)` calls with `getModel(provider, ...)`.
  - When `getModel` returns `undefined`, error reads `unknown model "<id>" for provider "<provider>"` so a typo'd provider surfaces clearly.
  - Update HELP text: add `--provider <name>` line; add `QAGENT_PROVIDER` to the `Environment:` block; drop "OpenRouter" from `--api-key` and `--model` descriptions.
- **`src/config.js`** — add `provider: { type: 'string' }` to `KNOWN_KEYS`. `KEY_LIST` and `KEY_TYPES` derive automatically.
- **`src/config-cmd.js`** —
  - Add `'QAGENT_PROVIDER'` to the env-var fallback map for `provider`.
  - Add description: `provider: 'LLM provider (openrouter, anthropic, openai, google, ...)'`.
  - Drop "OpenRouter" from `model` and `apiKey` descriptions (e.g. `'LLM model id (provider-specific format)'`, `'API key for the configured provider'`).

### Config schema and precedence

`provider` joins the existing chain:

```
--provider <name>             (flag)
> QAGENT_PROVIDER              (env)
> qagent.config.json           (project)
> ~/.config/qagent/config.json (user)
> 'openrouter'                 (default)
```

Lenient on writes (any string accepted in config), informative error at runtime.

### API key resolution

```
1. flags.apiKey                                                  (--api-key)
2. env.QAGENT_API_KEY
3. PROVIDERS[provider]?.keyEnv → env[that name]                  (top-4 only)
4. project.apiKey
5. user.apiKey
```

Returns the first defined value, plus a `source` label for error context. Throws `ConfigError` if nothing resolves.

Net behavior changes vs. today:

- `OPENROUTER_API_KEY` no longer resolves at step 2; it now resolves at step 3, and only when `provider === 'openrouter'`. For an existing OpenRouter user, behavior is unchanged.
- A user with `provider=anthropic` and `ANTHROPIC_API_KEY` set picks up that key at step 3.
- A user on a non-top-4 provider (mistral, groq, xai, cerebras, ollama, …) skips step 3 entirely; `QAGENT_API_KEY` / `--api-key` / config remains the only path.

### Missing-key error messages

For top-4 providers — names the provider, lists both `QAGENT_API_KEY` and the provider-specific env var, links to the right console:

```
no API key found for provider 'anthropic'.
Pass --api-key, set QAGENT_API_KEY or ANTHROPIC_API_KEY, or set "apiKey" in qagent.config.json / ~/.config/qagent/config.json.
See https://console.anthropic.com/settings/keys
```

For non-top-4 providers — drops the provider-specific env var line and the URL:

```
no API key found for provider 'mistral'.
Pass --api-key, set QAGENT_API_KEY, or set "apiKey" in qagent.config.json / ~/.config/qagent/config.json.
```

### Ollama note

Ollama runs locally and pi-ai accepts any non-empty string as the "key". Setting `QAGENT_API_KEY=ollama` (or any placeholder) plus `provider=ollama` works in v1. No automatic handling — documented but not coded.

---

## Out of scope

- Auto-detecting the provider from the model-ID prefix (fragile; pi-ai doesn't enforce a naming convention).
- Cross-provider model fallback or retry.
- OAuth-based providers (GitHub Copilot, Gemini CLI, Antigravity) — these need a credentials story beyond a single API-key string and warrant their own design.
- Separate `verifierProvider`. The pattern is established (`verifierModel`); add it later if a real cross-provider workflow appears.
- Expanding the per-provider env-var map past the top 4. Add entries on demand.

---

## Doc touches (deferred to implementation)

These references to OpenRouter need updating once the code lands. Listed here so the implementation plan covers them:

- `README.md` — "OpenRouter Setup" section, "An OpenRouter API key" prerequisite, `--api-key` description in the help excerpt, `model` config note.
- `docs/cli-approach.md` — `--api-key` flag description (line 203), `apiKey` env-var help (line 220–221), the example error message (line 145), the "Provider abstraction — OpenRouter only in v1" entry under deferred work (line 270).
- `docs/project-goal.md` — "OpenRouter is the only supported model provider for now" (line 27).
- `docs/project-architecture.md` — pi-ai dependency description (line 56).
- `docs/pi-agent-usage.md` — section title and inline examples (lines 19–61) to reflect provider abstraction.
