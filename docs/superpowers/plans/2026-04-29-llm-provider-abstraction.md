# LLM Provider Abstraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `provider` config key so QAgent can route the driver and verifier LLM calls through any pi-ai-supported provider (Anthropic, OpenAI, Google, OpenRouter, Mistral, Ollama, …) instead of the hardcoded OpenRouter path.

**Architecture:** A new `src/providers.js` module owns a static map of supported providers (top 4 with env-var + help-URL metadata) and a `resolveApiKey()` helper. `src/cli.js` adds a `--provider` flag, resolves it through the standard precedence chain (default `openrouter`), passes the provider to `getModel(provider, modelId)`, and uses `resolveApiKey()` instead of the inline 5-line key chain. `src/config.js` and `src/config-cmd.js` get one new key (`provider`). All other modules (`executor.js`, `verifier.js`, `tools.js`, …) are untouched — the pi-ai `Model` object stays opaque past the cli.js seam.

**Tech Stack:** Node.js ESM, pi-ai (`@mariozechner/pi-ai`) for provider/model lookup, Playwright (untouched), no test framework.

**Note on testing:** This project has no automated test suite (`npm test` not configured). The user has stated they will manually smoke-test against real API keys. Verification gates in this plan use `node --check` for syntax and `node src/cli.js --help` (and `config --help`) for visible-text checks. Per-task code-level review is on the implementation engineer; behavioral validation is on the user post-merge.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/providers.js` | **create** | `PROVIDERS` map (4 entries), `resolveApiKey()`, `providerHelpUrl()` |
| `src/config.js` | modify | Add `provider: { type: 'string' }` to `KNOWN_KEYS` |
| `src/cli.js` | modify | `--provider` flag, provider resolution, `resolveApiKey()` call, `getModel(provider, …)`, HELP text |
| `src/config-cmd.js` | modify | `provider` env-var entry, descriptions, drop "OpenRouter" wording from `model`/`apiKey` |
| `README.md` | modify | "OpenRouter Setup" → provider-agnostic instructions |
| `docs/cli-approach.md` | modify | Drop OpenRouter-specific phrasings, mark provider abstraction as resolved |
| `docs/project-goal.md` | modify | "OpenRouter only" line |
| `docs/project-architecture.md` | modify | pi-ai dependency description |
| `docs/pi-agent-usage.md` | modify | Section title and inline examples |

---

## Task 1: Create `src/providers.js`

**Files:**
- Create: `src/providers.js`

- [ ] **Step 1: Write the new module**

Create `src/providers.js` with:

```js
import { ConfigError } from './config.js';

export const PROVIDERS = {
  openrouter: { keyEnv: 'OPENROUTER_API_KEY', keyUrl: 'https://openrouter.ai/keys' },
  anthropic:  { keyEnv: 'ANTHROPIC_API_KEY',  keyUrl: 'https://console.anthropic.com/settings/keys' },
  openai:     { keyEnv: 'OPENAI_API_KEY',     keyUrl: 'https://platform.openai.com/api-keys' },
  google:     { keyEnv: 'GEMINI_API_KEY',     keyUrl: 'https://aistudio.google.com/apikey' },
};

export function providerHelpUrl(provider) {
  return PROVIDERS[provider]?.keyUrl ?? null;
}

export function resolveApiKey({ provider, flags, env, project, user }) {
  if (flags.apiKey) return { apiKey: flags.apiKey, source: 'flag' };
  if (env.QAGENT_API_KEY) return { apiKey: env.QAGENT_API_KEY, source: 'env QAGENT_API_KEY' };

  const providerEnv = PROVIDERS[provider]?.keyEnv;
  if (providerEnv && env[providerEnv]) {
    return { apiKey: env[providerEnv], source: `env ${providerEnv}` };
  }

  if (project.apiKey) return { apiKey: project.apiKey, source: 'project config' };
  if (user.apiKey) return { apiKey: user.apiKey, source: 'user config' };

  throw new ConfigError(missingKeyMessage(provider));
}

function missingKeyMessage(provider) {
  const entry = PROVIDERS[provider];
  if (entry) {
    return [
      `no API key found for provider '${provider}'.`,
      `Pass --api-key, set QAGENT_API_KEY or ${entry.keyEnv}, or set "apiKey" in qagent.config.json / ~/.config/qagent/config.json.`,
      `See ${entry.keyUrl}`,
    ].join('\n');
  }
  return [
    `no API key found for provider '${provider}'.`,
    `Pass --api-key, set QAGENT_API_KEY, or set "apiKey" in qagent.config.json / ~/.config/qagent/config.json.`,
  ].join('\n');
}
```

- [ ] **Step 2: Syntax-check the file**

Run: `node --check src/providers.js`
Expected: exits 0 with no output.

- [ ] **Step 3: Commit**

```bash
git add src/providers.js
git commit -m "add providers module with PROVIDERS map and resolveApiKey"
```

---

## Task 2: Add `provider` key to `src/config.js`

**Files:**
- Modify: `src/config.js:10-21` (the `KNOWN_KEYS` map)

- [ ] **Step 1: Insert `provider` row in `KNOWN_KEYS`**

In `src/config.js`, locate:

```js
const KNOWN_KEYS = {
  model: { type: 'string' },
  verifierModel: { type: 'string' },
  apiKey: { type: 'string' },
  maxTurns: { type: 'number' },
  ...
};
```

Insert one new line after `verifierModel`:

```js
const KNOWN_KEYS = {
  model: { type: 'string' },
  verifierModel: { type: 'string' },
  provider: { type: 'string' },
  apiKey: { type: 'string' },
  maxTurns: { type: 'number' },
  ...
};
```

`KEY_LIST` and `KEY_TYPES` derive from `KNOWN_KEYS` automatically — no other changes.

- [ ] **Step 2: Syntax-check**

Run: `node --check src/config.js`
Expected: exits 0.

- [ ] **Step 3: Verify config list still renders**

Run: `node src/cli.js config list`
Expected: prints all keys (now including `provider`) followed by user/project paths. `provider` row should show `(unset)` and source `unset` (description is added in Task 4).

- [ ] **Step 4: Commit**

```bash
git add src/config.js
git commit -m "add provider to config KNOWN_KEYS"
```

---

## Task 3: Wire `--provider` flag and `getModel(provider, …)` in cli.js

**Files:**
- Modify: `src/cli.js:5` (imports), `src/cli.js:37-47` (VALUE_FLAGS), `src/cli.js:120-162` (resolution + getModel)

- [ ] **Step 1: Add `--provider` to `VALUE_FLAGS`**

In `src/cli.js`, locate the `VALUE_FLAGS` const (around line 37-47):

```js
const VALUE_FLAGS = {
  '--model': 'model',
  '--verifier-model': 'verifierModel',
  '--api-key': 'apiKey',
  ...
};
```

Insert a `--provider` entry after `--verifier-model`:

```js
const VALUE_FLAGS = {
  '--model': 'model',
  '--verifier-model': 'verifierModel',
  '--provider': 'provider',
  '--api-key': 'apiKey',
  ...
};
```

- [ ] **Step 2: Resolve `provider` in `main()`**

In `src/cli.js`, locate the model resolution block (around line 120-122):

```js
const { user, project } = loadConfig({ cwd: process.cwd() });

const modelId = flags.model ?? process.env.QAGENT_MODEL ?? project.model ?? user.model;
if (!modelId) throw new ConfigError('no model. Pass --model, set QAGENT_MODEL, or set "model" in qagent.config.json / ~/.config/qagent/config.json.');
```

Insert provider resolution **before** the modelId line so the missing-key error in later steps can use it:

```js
const { user, project } = loadConfig({ cwd: process.cwd() });

const provider =
  flags.provider ??
  process.env.QAGENT_PROVIDER ??
  project.provider ??
  user.provider ??
  'openrouter';

const modelId = flags.model ?? process.env.QAGENT_MODEL ?? project.model ?? user.model;
if (!modelId) throw new ConfigError('no model. Pass --model, set QAGENT_MODEL, or set "model" in qagent.config.json / ~/.config/qagent/config.json.');
```

- [ ] **Step 3: Replace both `getModel` calls with the resolved provider**

Locate (around lines 159-162):

```js
const model = getModel('openrouter', modelId);
if (!model) throw new ConfigError(`unknown model: ${modelId}`);
const verifierModel = getModel('openrouter', verifierModelId);
if (!verifierModel) throw new ConfigError(`unknown verifier model: ${verifierModelId}`);
```

Replace with:

```js
const model = getModel(provider, modelId);
if (!model) throw new ConfigError(`unknown model "${modelId}" for provider "${provider}"`);
const verifierModel = getModel(provider, verifierModelId);
if (!verifierModel) throw new ConfigError(`unknown verifier model "${verifierModelId}" for provider "${provider}"`);
```

- [ ] **Step 4: Syntax-check**

Run: `node --check src/cli.js`
Expected: exits 0.

- [ ] **Step 5: Smoke-render `--help`**

Run: `node src/cli.js --help`
Expected: prints the existing help text without crashing. (HELP text update is Task 5; this just confirms parsing still works.)

- [ ] **Step 6: Smoke-test default-provider behavior**

Run with a missing model to exit early before any LLM call: `node src/cli.js`
Expected: stderr says `qagent: missing goal.` and prints help. Exits 2.

- [ ] **Step 7: Commit**

```bash
git add src/cli.js
git commit -m "add --provider flag and pass it to getModel"
```

---

## Task 4: Replace inline API-key chain with `resolveApiKey()`

**Files:**
- Modify: `src/cli.js:7` (imports), `src/cli.js:125-135` (key chain)

- [ ] **Step 1: Import `resolveApiKey`**

Add to the import block at the top of `src/cli.js`:

```js
import { resolveApiKey } from './providers.js';
```

Place it next to the existing `./config.js` and `./config-cmd.js` imports for grouping.

- [ ] **Step 2: Replace the inline key resolution**

Locate (around lines 125-135):

```js
const apiKey =
  flags.apiKey ??
  process.env.QAGENT_API_KEY ??
  process.env.OPENROUTER_API_KEY ??
  project.apiKey ??
  user.apiKey;
if (!apiKey) {
  throw new ConfigError(
    'no API key found.\nPass --api-key, set QAGENT_API_KEY / OPENROUTER_API_KEY, or set "apiKey" in qagent.config.json / ~/.config/qagent/config.json.\nSee https://openrouter.ai/keys',
  );
}
```

Replace with:

```js
const { apiKey } = resolveApiKey({
  provider,
  flags,
  env: process.env,
  project,
  user,
});
```

`resolveApiKey()` throws `ConfigError` with a provider-aware message when no key resolves, so the explicit `if (!apiKey)` block is gone.

- [ ] **Step 3: Syntax-check**

Run: `node --check src/cli.js`
Expected: exits 0.

- [ ] **Step 4: Smoke-test the missing-key error for an unset provider**

Run with a goal but no provider config so the default `openrouter` kicks in, and clear all keys: `env -i HOME=$HOME PATH=$PATH node src/cli.js --model some-model "test goal"`
Expected: stderr error message names provider `openrouter` and references `OPENROUTER_API_KEY` plus `https://openrouter.ai/keys`. Exits 2.

- [ ] **Step 5: Smoke-test the missing-key error for Anthropic**

Run: `env -i HOME=$HOME PATH=$PATH node src/cli.js --provider anthropic --model some-model "test goal"`
Expected: stderr error names provider `anthropic`, references `ANTHROPIC_API_KEY`, links to `https://console.anthropic.com/settings/keys`. Exits 2.

- [ ] **Step 6: Smoke-test the missing-key error for a non-top-4 provider**

Run: `env -i HOME=$HOME PATH=$PATH node src/cli.js --provider mistral --model some-model "test goal"`
Expected: stderr error names provider `mistral`, references only `QAGENT_API_KEY` (no provider-specific env var, no URL). Exits 2.

- [ ] **Step 7: Commit**

```bash
git add src/cli.js
git commit -m "use resolveApiKey for provider-aware key resolution"
```

---

## Task 5: Update HELP text in cli.js

**Files:**
- Modify: `src/cli.js:12-35` (`HELP` constant)

- [ ] **Step 1: Update the HELP block**

Locate the `HELP` const (lines 12-35). Replace these lines:

```
  --model <id>           LLM model (or env QAGENT_MODEL)
  --verifier-model <id>  Verifier model (defaults to --model)
  --api-key <key>        OpenRouter key (or env QAGENT_API_KEY / OPENROUTER_API_KEY)
```

With:

```
  --model <id>           LLM model (or env QAGENT_MODEL)
  --verifier-model <id>  Verifier model (defaults to --model)
  --provider <name>      LLM provider (default openrouter; or env QAGENT_PROVIDER)
  --api-key <key>        Provider API key (or env QAGENT_API_KEY / provider-specific env)
```

And replace the `Environment:` block:

```
Environment:
  QAGENT_API_KEY, OPENROUTER_API_KEY, QAGENT_MODEL
  QAGENT_TEST_TIMEOUT, QAGENT_NETWORK_TIMEOUT, QAGENT_ACTION_TIMEOUT  (seconds)
  BASIC_AUTH_USER, BASIC_AUTH_PASS  (per-page httpCredentials)
```

With:

```
Environment:
  QAGENT_PROVIDER, QAGENT_API_KEY, QAGENT_MODEL
  ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY  (per-provider fallbacks)
  QAGENT_TEST_TIMEOUT, QAGENT_NETWORK_TIMEOUT, QAGENT_ACTION_TIMEOUT  (seconds)
  BASIC_AUTH_USER, BASIC_AUTH_PASS  (per-page httpCredentials)
```

- [ ] **Step 2: Syntax-check**

Run: `node --check src/cli.js`
Expected: exits 0.

- [ ] **Step 3: Render help and verify**

Run: `node src/cli.js --help`
Expected: stdout shows the `--provider` option, the new Environment block with provider-specific fallbacks. Visually scan that nothing else regressed.

- [ ] **Step 4: Commit**

```bash
git add src/cli.js
git commit -m "update CLI help text for provider abstraction"
```

---

## Task 6: Update `src/config-cmd.js`

**Files:**
- Modify: `src/config-cmd.js:5-16` (`ENV_LOOKUP`), `src/config-cmd.js:28-39` (`KEY_DOCS`), `src/config-cmd.js:41-47` (`ENV_HINTS`)

- [ ] **Step 1: Update `ENV_LOOKUP`**

Locate (lines 5-16):

```js
const ENV_LOOKUP = {
  model: ['QAGENT_MODEL'],
  verifierModel: [],
  apiKey: ['QAGENT_API_KEY', 'OPENROUTER_API_KEY'],
  maxTurns: [],
  ...
};
```

Update to:

```js
const ENV_LOOKUP = {
  model: ['QAGENT_MODEL'],
  verifierModel: [],
  provider: ['QAGENT_PROVIDER'],
  apiKey: ['QAGENT_API_KEY'],
  maxTurns: [],
  ...
};
```

Two changes: add the `provider` row, and drop `'OPENROUTER_API_KEY'` from `apiKey`. (`OPENROUTER_API_KEY` is no longer in the unconditional fallback chain — it now resolves only when `provider=openrouter` via `src/providers.js`. `config list` shows the canonical `QAGENT_API_KEY` lookup.)

- [ ] **Step 2: Update `KEY_DOCS`**

Locate (lines 28-39) and replace these three rows:

```js
  model:          'OpenRouter LLM model id (e.g. qwen/qwen3.5-flash-02-23)',
  verifierModel:  'Verifier model id; defaults to model when unset',
  apiKey:         'OpenRouter API key (sk-or-...)',
```

With:

```js
  model:          'LLM model id (provider-specific format)',
  verifierModel:  'Verifier model id; defaults to model when unset',
  provider:       'LLM provider (openrouter, anthropic, openai, google, ...)',
  apiKey:         'API key for the configured provider',
```

(Insert `provider` between `verifierModel` and `apiKey`, matching the order in `KNOWN_KEYS`.)

- [ ] **Step 3: Update `ENV_HINTS`**

Locate (lines 41-47):

```js
const ENV_HINTS = {
  model: 'env QAGENT_MODEL',
  apiKey: 'env QAGENT_API_KEY / OPENROUTER_API_KEY',
  testTimeout: 'env QAGENT_TEST_TIMEOUT',
  ...
};
```

Update to:

```js
const ENV_HINTS = {
  model: 'env QAGENT_MODEL',
  provider: 'env QAGENT_PROVIDER',
  apiKey: 'env QAGENT_API_KEY',
  testTimeout: 'env QAGENT_TEST_TIMEOUT',
  ...
};
```

(Add `provider`, drop `OPENROUTER_API_KEY` from the `apiKey` hint.)

- [ ] **Step 4: Syntax-check**

Run: `node --check src/config-cmd.js`
Expected: exits 0.

- [ ] **Step 5: Render `config --help` and verify**

Run: `node src/cli.js config --help`
Expected: `provider` row shown in the Keys block with the new description; `model` and `apiKey` descriptions no longer mention "OpenRouter"; Environment overrides block shows `provider  QAGENT_PROVIDER` and `apiKey  QAGENT_API_KEY` (no `OPENROUTER_API_KEY`).

- [ ] **Step 6: Render `config list` and verify**

Run: `node src/cli.js config list`
Expected: `provider` row appears with source `unset` (or `default openrouter` once a default is wired — currently unset since `DEFAULTS` map doesn't include it; the runtime default in `cli.js` is sufficient and `config list` showing `unset` is fine). `apiKey` row still works.

- [ ] **Step 7: Commit**

```bash
git add src/config-cmd.js
git commit -m "add provider to config-cmd help and drop OpenRouter wording"
```

---

## Task 7: Update doc references

**Files:**
- Modify: `README.md` (multiple sections)
- Modify: `docs/cli-approach.md:22, 145, 203, 220-221, 270`
- Modify: `docs/project-goal.md:27`
- Modify: `docs/project-architecture.md:56`
- Modify: `docs/pi-agent-usage.md:19, 26-31, 56-61`

- [ ] **Step 1: Update `README.md`**

Apply these targeted edits:

a) Line 17 — replace `- An OpenRouter API key.` with:
```
- An API key for an LLM provider (OpenRouter is the default; Anthropic, OpenAI, and Google are also supported with built-in env-var fallbacks).
```

b) Lines 58-87 — replace the entire `## OpenRouter Setup` section with:

```markdown
## Provider Setup

QAgent picks the LLM provider via the `provider` config key (default `openrouter`). The same key is used for the driver and verifier models. Pi-ai supports many providers; QAgent ships per-provider env-var fallbacks for the four most common.

1. Pick your provider and grab an API key:

   - **OpenRouter** (default) — [openrouter.ai/keys](https://openrouter.ai/keys)
   - **Anthropic** — [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)
   - **OpenAI** — [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
   - **Google (Gemini)** — [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
   - Other pi-ai providers (Mistral, Groq, xAI, Cerebras, Ollama, …) work too — pass the key via `--api-key`, `QAGENT_API_KEY`, or the `apiKey` config.

2. Store the provider, model, and key once:

   ```bash
   qagent config set provider anthropic
   qagent config set model anthropic/claude-sonnet-4.5
   qagent config set apiKey sk-ant-...
   ```

3. Optionally use a different verifier model:

   ```bash
   qagent config set verifierModel anthropic/claude-haiku-4.5
   ```

For CI, prefer env vars over config files. The provider-specific env vars are picked up automatically:

```bash
QAGENT_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-... QAGENT_MODEL=anthropic/claude-sonnet-4.5 qagent "<goal>"
```

`QAGENT_API_KEY` is the provider-agnostic env var and works for any provider. If QAgent says `unknown model "<id>" for provider "<name>"`, check that the provider name and model ID are both valid for the installed `pi-ai` package.
```

c) Line 208 (in the "Limitations" or similar section) — change `OpenRouter only for now — select supported OpenRouter model IDs via the `model` config key.` to:
```
Provider abstraction supports any pi-ai provider; the four most common (openrouter, anthropic, openai, google) get per-provider env-var fallbacks and tailored error messages. Other providers work via `QAGENT_API_KEY` or the `apiKey` config.
```

d) Line 220 — change `--api-key <key>         OpenRouter key` to:
```
  --api-key <key>         Provider API key
```

- [ ] **Step 2: Update `docs/cli-approach.md`**

Apply these edits:

a) Line 22 — leave the `demo.js` line alone (separate concern; demo.js still uses OpenRouter env vars). Add no changes.

b) Around line 135-145, the env-var fallback walkthrough mentions `OPENROUTER_API_KEY`. Update the resolution-chain block to:

```
1. `--api-key` flag
2. `QAGENT_API_KEY` env var
3. Provider-specific env var (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`) if `provider` matches
4. Project config `apiKey`
5. User config `apiKey`
```

And the example error line (line 145, `See https://openrouter.ai/keys`) — leave intact in context if it appears inside an OpenRouter-specific example, or reword the example block to be provider-agnostic at the engineer's discretion.

c) Line 203 — change `--api-key <key>           OpenRouter API key (prefer env or user config)` to:
```
  --api-key <key>           Provider API key (prefer env or user config)
```

d) Lines 220-221 — change:
```
  QAGENT_API_KEY            Preferred env var
  OPENROUTER_API_KEY        Fallback env var
```
to:
```
  QAGENT_API_KEY            Preferred env var (any provider)
  OPENROUTER_API_KEY        Per-provider fallback when provider=openrouter
  ANTHROPIC_API_KEY         Per-provider fallback when provider=anthropic
  OPENAI_API_KEY            Per-provider fallback when provider=openai
  GEMINI_API_KEY            Per-provider fallback when provider=google
```

e) Line 270 — change `- **Provider abstraction** — OpenRouter only in v1.` to:
```
- **Provider abstraction** [done, v1]. `provider` config key, top-4 env-var fallbacks. See `docs/providers.md`.
```

- [ ] **Step 3: Update `docs/project-goal.md`**

Line 27 — change `- OpenRouter is the only supported model provider for now.` to:
```
- Multiple LLM providers supported via pi-ai (default `openrouter`; Anthropic, OpenAI, Google have per-provider env-var fallbacks). See `docs/providers.md`.
```

- [ ] **Step 4: Update `docs/project-architecture.md`**

Line 56 — change `- `pi-ai`: OpenRouter model lookup. Used by the CLI/demo.` to:
```
- `pi-ai`: model lookup across 21+ providers. Used by the CLI/demo. Selected via the `provider` config key.
```

- [ ] **Step 5: Update `docs/pi-agent-usage.md`**

Apply these edits:

a) Line 19 — change the heading `## env and API keys (OpenRouter)` to:
```
## env and API keys
```

b) Line 21 — change the paragraph describing pi-ai env-var pickup. Replace:
```
pi-ai reads `OPENROUTER_API_KEY` from `process.env` — nothing else. QAgent also supports `QAGENT_API_KEY` and `QAGENT_MODEL`, so we do **not** rely on pi-ai auto-pickup. Cleanest pattern: pass the key via the Agent's `getApiKey` hook, which wins over env.
```
with:
```
QAgent passes the resolved API key via the Agent's `getApiKey` hook (which wins over any env var pi-ai might inspect). The provider is selected at the call site through `getModel(provider, modelId)`. See `src/providers.js` for QAgent's resolution map.
```

c) Lines 26-31 (the example code block showing `getModel("openrouter", ...)` and `OPENROUTER_API_KEY`) — update the example to show provider parameterization:

```js
const provider = "openrouter"; // or "anthropic", "openai", "google", ...
const agent = new Agent({
  initialState: { systemPrompt, model: getModel(provider, process.env.QAGENT_MODEL) },
  getApiKey: async (_provider) => process.env.QAGENT_API_KEY,
});
```

d) Line 56 onward (additional examples that hardcode `getModel("openrouter", ...)`) — same pattern: substitute a `provider` variable.

- [ ] **Step 6: Skim each doc**

Run: `grep -n "OpenRouter\|openrouter" README.md docs/cli-approach.md docs/project-goal.md docs/project-architecture.md docs/pi-agent-usage.md`
Expected: remaining matches are intentional — examples that name `openrouter` as a provider value, the `OPENROUTER_API_KEY` per-provider fallback row, the demo.js note in `cli-approach.md:22`, and any URLs to openrouter.ai inside the OpenRouter section of README. No leftover phrases like "OpenRouter is the only supported provider" or "OpenRouter API key" in generic descriptions.

- [ ] **Step 7: Commit**

```bash
git add README.md docs/cli-approach.md docs/project-goal.md docs/project-architecture.md docs/pi-agent-usage.md
git commit -m "update docs for provider abstraction"
```

---

## Final hand-off

After Task 7 commits, the implementation is feature-complete. Hand back to the user for manual end-to-end smoke tests against real API keys:

1. Default openrouter (existing setup, no config change) — should run identically to today.
2. `qagent config set provider anthropic` + `ANTHROPIC_API_KEY` env var + an Anthropic model ID — should drive a real run via Anthropic.
3. `qagent config set provider openai` + `OPENAI_API_KEY` + an OpenAI model — same.
4. `qagent config set provider mistral` + `QAGENT_API_KEY=<mistral-key>` + a Mistral model — same (relies on QAGENT_API_KEY since mistral isn't in top-4).
5. Bogus provider (`--provider nope`) — should error with `unknown model "<id>" for provider "nope"`.
