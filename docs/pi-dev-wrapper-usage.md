# Pi-dev Wrapper Usage

This document describes the intended way to use QAgent from a future Pi-dev package before we split that wrapper into its own repository.

The key idea: Pi-dev owns model selection and authentication. QAgent owns the browser loop. The wrapper should connect those two pieces directly.

## Target shape

Do not add `provider=pi`. In QAgent, `provider` means the actual model provider, such as `anthropic`, `openai`, `github-copilot`, `openrouter`, or a custom provider known to Pi.

Do not use QAgent's standalone API-key config from the Pi-dev package. The standalone CLI path is still for npm users and CI:

```bash
qagent --provider anthropic --model claude-sonnet-4-5 --api-key sk-ant-... --url <url> "<goal>"
```

The Pi-dev wrapper should instead call QAgent's public runner and pass:

- `model`: `ctx.model` by default, or `ctx.modelRegistry.find(provider, modelId)` when the user explicitly overrides it.
- `resolveRequestAuth(model)`: a small adapter around `ctx.modelRegistry.getApiKeyAndHeaders(model)` that returns `{ apiKey, headers }`.
- `goal`, `url`, `maxTurns`, timeouts, and reporter behavior from the wrapper input.

That keeps Pi-dev credentials in Pi-dev and keeps QAgent simple.

## Wrapper contract

The wrapper should expose one Pi-dev command/tool, roughly:

```js
{
  name: "qagent.run",
  description: "Run a natural-language browser QA check against a URL.",
  input: {
    url: "https://example.com",
    goal: "Click Continue and verify the page says Pi wrapper success.",
    provider: "anthropic",        // optional
    modelId: "claude-sonnet-4-5", // optional
    verifierModelId: null,        // optional, same provider for now
    maxTurns: 50,
    headed: false,
    testTimeoutMs: 300000,
    networkTimeoutMs: 30000,
    actionTimeoutMs: 2000
  }
}
```

Return a compact result object:

```js
{
  outcome: "pass",
  evidence: "The final page says Pi wrapper success.",
  turns: 3,
  elapsedMs: 8123,
  cost: 0.0012,
  url: "http://127.0.0.1:4173/"
}
```

Do not include API keys, auth headers, raw model registry responses, or full snapshots in the normal Pi-dev response. Trace-style details can be optional later.

## Adapter sketch

This is the shape the future wrapper repo should use. Exact Pi package registration code can change, but the QAgent side should stay close to this.

```js
import { runQAgent } from "@qagent/cli/src/runner.js";

export async function runQAgentWithPi(ctx, input) {
  const {
    goal,
    url,
    provider,
    modelId,
    verifierModelId,
    maxTurns = 50,
    headed = false,
    testTimeoutMs = 300000,
    networkTimeoutMs = 30000,
    actionTimeoutMs = 2000,
  } = input;

  if (!goal) throw new Error("goal is required");
  if (!url) throw new Error("url is required");

  if (modelId && !provider) {
    throw new Error("provider is required when modelId is set");
  }

  const model = modelId
    ? ctx.modelRegistry.find(provider, modelId)
    : ctx.model;
  if (!model) throw new Error(`unknown model override: ${provider}/${modelId}`);

  const verifierProvider = provider ?? model.provider;
  const verifierModel = verifierModelId
    ? ctx.modelRegistry.find(verifierProvider, verifierModelId)
    : model;
  if (!verifierModel) throw new Error(`unknown verifier model: ${verifierModelId}`);

  const resolveRequestAuth = async (requestedModel) => {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(requestedModel);
    if (!auth.ok) throw new Error(auth.error ?? "Pi-dev could not resolve model auth");
    return { apiKey: auth.apiKey, headers: auth.headers };
  };

  const turns = [];
  const onTurn = (turn) => turns.push(turn);

  const result = await runQAgent({
    url,
    goal,
    model,
    resolveRequestAuth,
    verifierModel,
    maxTurns,
    headed,
    testTimeoutMs,
    networkTimeoutMs,
    actionTimeoutMs,
    onTurn,
  });

  return {
    outcome: result.outcome,
    evidence: result.evidence,
    turns: result.turns,
    elapsedMs: result.elapsedMs,
    cost: (result.tokens?.cost ?? 0) + (result.verifierTokens?.cost ?? 0),
    url: result.finalUrl,
    turnLog: turns.map((t) => ({
      turn: t.turn,
      action: t.action,
      target: t.target,
      error: t.error,
      url: t.url,
    })),
  };
}
```

Important details:

- The wrapper calls `runQAgent()` directly. It should not spawn `qagent` if the goal is to use Pi-dev authentication, because the CLI resolves auth from QAgent config/env.
- The wrapper should not import `browser.js`, `tools.js`, `executor.js`, `verifier.js`, or `reporters.js`; QAgent owns browser launch, pre-navigation, execution, verification, cleanup, and runtime error shaping.
- `resolveRequestAuth` is called by both driver and verifier LLM calls.
- The wrapper should pass the actual `Model` object to QAgent, not a provider string.
- If Pi returns an auth failure, fail early with a clear message. Do not fall back to `QAGENT_API_KEY`; that would hide broken Pi integration.
- Basic auth embedded in the URL is stripped by `runQAgent()` before navigation and passed as Playwright `httpCredentials`, matching the CLI behavior.

## Manual test plan

Run these checks before creating the separate Pi-dev package repo.

### 1. Baseline standalone CLI

This proves the existing npm/CLI path still works and did not regress while adding the auth seam.

```bash
node --version
npm install
npx playwright install chromium

QAGENT_PROVIDER=anthropic \
ANTHROPIC_API_KEY=sk-ant-... \
QAGENT_MODEL=claude-sonnet-4-5 \
node src/cli.js --url https://example.com --reporter=ndjson \
  "Verify the page says Example Domain."
```

Expected:

- Exit code `0`.
- Final NDJSON event has `"event":"done"` and `"outcome":"pass"`.
- No Pi-dev auth is involved in this test.

### 2. Local wrapper smoke test

From the QAgent repo root, run a one-off stdin script that imports QAgent internals and uses a fake Pi context. The fake context should expose the same two things the real Pi wrapper will use:

```bash
QAGENT_PROVIDER=anthropic \
QAGENT_MODEL=claude-sonnet-4-5 \
ANTHROPIC_API_KEY=sk-ant-... \
node --input-type=module <<'JS'
import http from "node:http";
import { getModel } from "@earendil-works/pi-ai";
import { runQAgent } from "./src/runner.js";

const provider = process.env.QAGENT_PROVIDER ?? "anthropic";
const modelId = process.env.QAGENT_MODEL ?? "claude-sonnet-4-5";
const model = getModel(provider, modelId);
if (!model) throw new Error(`unknown model ${provider}/${modelId}`);

const ctx = {
  model,
  modelRegistry: {
    find: (p, id) => getModel(p, id),
    getApiKeyAndHeaders: async () => {
      const apiKey = process.env.QAGENT_API_KEY ?? process.env.ANTHROPIC_API_KEY;
      return apiKey
        ? { ok: true, apiKey, headers: undefined }
        : { ok: false, error: "missing fake Pi auth API key" };
    },
  },
};

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html>
    <title>QAgent Pi wrapper smoke</title>
    <h1>QAgent Pi wrapper smoke</h1>
    <button onclick="document.querySelector('main').textContent='Pi wrapper success'">Continue</button>
    <main>Waiting</main>`);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

const resolveRequestAuth = async (requestedModel) => {
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(requestedModel);
  if (!auth.ok) throw new Error(auth.error);
  return { apiKey: auth.apiKey, headers: auth.headers };
};

try {
  const result = await runQAgent({
    url,
    goal: "Click Continue and verify the page says Pi wrapper success.",
    model: ctx.model,
    resolveRequestAuth,
    verifierModel: ctx.model,
    maxTurns: 8,
    testTimeoutMs: 120000,
    networkTimeoutMs: 30000,
    actionTimeoutMs: 2000,
    onTurn: (turn) => console.log(JSON.stringify({ event: "turn", ...turn })),
  });
  console.log(JSON.stringify({ event: "done", outcome: result.outcome, evidence: result.evidence, turns: result.turns }));
  process.exitCode = result.outcome === "pass" ? 0 : 1;
} finally {
  server.close();
}
JS
```

Expected:

- The script exits `0`.
- It prints at least one `turn` event.
- The final line is `{"event":"done","outcome":"pass",...}`.
- If you temporarily change `getApiKeyAndHeaders` to return `{ ok: false, error: "no Pi auth" }`, the run fails with that error instead of silently using QAgent config.

This proves the important seam works even before the real Pi-dev package exists: QAgent can run with a Pi-shaped model and auth resolver.

### 3. Real Pi-dev wrapper test

Once the minimal Pi-dev wrapper command exists, test inside an already authenticated Pi-dev instance:

1. Start a persistent local smoke page in a separate terminal:

   ```bash
   node --input-type=module <<'JS'
   import http from "node:http";

   const server = http.createServer((req, res) => {
     res.writeHead(200, { "content-type": "text/html" });
     res.end(`<!doctype html>
       <title>QAgent Pi wrapper smoke</title>
       <h1>QAgent Pi wrapper smoke</h1>
       <button onclick="document.querySelector('main').textContent='Pi wrapper success'">Continue</button>
       <main>Waiting</main>`);
   });

   server.listen(4173, "127.0.0.1", () => {
     console.log("Smoke page: http://127.0.0.1:4173/");
   });
   await new Promise(() => {});
   JS
   ```

2. Remove standalone QAgent auth from the shell used by Pi-dev:

   ```bash
   unset QAGENT_API_KEY OPENROUTER_API_KEY ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY
   ```

3. Select an authenticated model in Pi-dev.
4. Run the wrapper command against the local smoke page:

   ```json
   {
     "url": "http://127.0.0.1:4173/",
     "goal": "Click Continue and verify the page says Pi wrapper success.",
     "maxTurns": 8
   }
   ```

5. Confirm the wrapper returns `outcome: "pass"` and evidence mentioning `Pi wrapper success`.
6. Confirm the wrapper never asks for `QAGENT_API_KEY` and never writes `~/.config/qagent/config.json`.
7. Confirm no API key or auth header appears in the returned result, Pi-dev logs, or trace output.

### 4. Negative checks

Run these to catch false positives:

- Pick a model in Pi-dev that is not authenticated. Expected: wrapper fails with a clear Pi auth/model-registry error.
- Pass an invalid `provider/modelId` override. Expected: wrapper fails before browser work with an "unknown model" style error.
- Pass a bad URL. Expected: wrapper fails before LLM work.
- Set `QAGENT_API_KEY` to an invalid value while Pi-dev has valid auth. Expected: wrapper still passes, proving it uses Pi auth, not QAgent env auth.
- Run the standalone CLI afterward with `QAGENT_API_KEY` or provider-specific env set. Expected: CLI behavior is unchanged.

## Done criteria for the integration

The Pi-dev integration is ready to move into its own package repo when:

- The wrapper uses `ctx.model` by default and supports optional explicit model lookup through `ctx.modelRegistry.find`.
- All LLM calls receive auth from `ctx.modelRegistry.getApiKeyAndHeaders`.
- The wrapper does not require or read QAgent's standalone API-key config.
- A local action test passes through the wrapper with no QAgent API-key env vars set.
- A missing Pi auth test fails clearly.
- The returned result is compact, useful, and contains no secrets.
