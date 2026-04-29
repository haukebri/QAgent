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

- Let the user pick **any pi-ai-supported provider** for both the driver LLM and the verifier LLM.
- Provider selectable through the same precedence chain we already use elsewhere: **flag > env > project config > user config > default**, to stay consistent with the existing config story (`docs/cli-approach.md` §3).
- **Provider-aware help and error messages** — when the user is on Anthropic, the "missing API key" error should point them at Anthropic's console, not OpenRouter's.
- **Per-provider env-var fallbacks** (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, etc.) so users with existing provider-specific env vars don't have to rename them.

---

## Open questions

1. **Default provider** — keep `openrouter` for backward compatibility, or refuse-to-run (consistent with how `model` and `apiKey` already behave when unset)?
2. **Separate verifier provider** — ship in v1, or defer until a real cross-provider use case appears (e.g., cheap driver, premium verifier)?
3. **Per-provider env-var fallbacks** — ship the full set (~8 providers) or only the top four (openrouter, anthropic, openai, google) and grow on demand?
4. **Legacy `OPENROUTER_API_KEY` env var** — keep working forever to protect existing setups, or deprecate after one release once `QAGENT_API_KEY` + `provider` is the documented path?

---

## Out of scope

Auto-detecting the provider from the model-ID prefix (fragile; pi-ai doesn't enforce a naming convention). Cross-provider model fallback or retry. OAuth-based providers (GitHub Copilot, Gemini CLI, Antigravity) — these need a credentials story beyond a single API-key string and warrant their own design.
