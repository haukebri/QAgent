# pi-agent usage

Version: `@earendil-works/pi-agent-core@0.78.0` + `@earendil-works/pi-ai@0.78.0`.

Companion to `docs/playwright-usage.md`. This covers how QAgent uses pi-agent / pi-ai for model lookup and LLM calls.

## the key insight

QAgent owns the browser loop. `executor.js` observes the page, asks the driver LLM for one JSON action, runs the local Playwright tool itself, then repeats until done, stuck, or turn cap. `verifier.js` makes a separate one-shot LLM judgment over the final URL, final snapshot, and action history.

`pi-agent-core` is used as the stateful LLM conversation primitive, not as the browser tool-execution loop. We do not register Playwright tools with `Agent`; QAgent keeps browser mutation, settling, stuck detection, and trace payloads in its own modules.

## install

```bash
npm install @earendil-works/pi-agent-core@0.78.0 @earendil-works/pi-ai@0.78.0
```

Pin to exact `0.78.0` (no caret) in `package.json`. Both packages are ESM and currently require Node >=22.19.0. `pi-ai` bundles every provider SDK, so install is heavier than a single-provider SDK but keeps provider switching simple.

## request auth

QAgent resolves standalone CLI credentials once, then passes request auth through a `streamFn` wrapper. Today that auth is `{ apiKey }`; the shape is intentionally `{ apiKey, headers }` so a future Pi package can forward Pi-managed request auth without teaching the executor about Pi.

The provider is selected at the call site through `getModel(provider, modelId)`. See `src/providers.js` for QAgent's standalone resolution map and per-provider env-var fallbacks.

```js
import { Agent } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai";
import { streamWithRequestAuth } from "../src/llm-auth.js";

const provider = "anthropic";
const model = getModel(provider, "claude-sonnet-4-5");
const resolveRequestAuth = async () => ({ apiKey: process.env.QAGENT_API_KEY });

const agent = new Agent({
  initialState: { systemPrompt, model },
  streamFn: streamWithRequestAuth(resolveRequestAuth),
});
```

For a Pi extension/package wrapper, unwrap `ctx.modelRegistry.getApiKeyAndHeaders(model)` before returning request auth:

```js
async function resolveRequestAuth(model) {
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);
  return { apiKey: auth.apiKey, headers: auth.headers };
}
```

## getting a model

`getModel(provider, modelId)` is synchronous and takes no options. It returns a `Model` object from the static registry, or `undefined` on typo.

```js
import { getModel } from "@earendil-works/pi-ai";

const provider = "anthropic";
const model = getModel(provider, "claude-sonnet-4-5");
if (!model) throw new Error(`unknown model "${modelId}" for provider "${provider}"`);
```

Model IDs are provider-local. OpenRouter IDs often include a slash; direct Anthropic IDs look like `claude-sonnet-4-5`.

## driver agent shape

The driver uses a fresh `Agent` per todo. It keeps message state across turns for that todo, but QAgent decides when to observe, execute, retry, or stop.

```js
const agent = new Agent({
  initialState: { systemPrompt: SYSTEM_PROMPT, model },
  sessionId: randomUUID(),
  transformContext: async (messages) => scrubOldSnapshots(messages, scrubState.baselineTurn),
  streamFn: streamWithRequestAuth(resolveRequestAuth),
});
```

The driver prompt requires a single JSON object. After `agent.prompt(...)`, read the newest assistant message, concatenate its text parts, parse JSON, and let `executor.js` perform the Playwright action locally.

## verifier agent shape

The verifier uses separate `Agent` calls with the verifier model when configured:
one call decomposes the goal into claims, one call per claim checks the frozen
transcript, and a final prose-only call writes `humanEvidence`. The aggregated
claim checks decide `{ outcome: "pass" | "fail", evidence }`; `humanEvidence` is
for people and must not change the outcome. If claim decomposition fails, QAgent
falls back to the older single-call verifier.

```js
const agent = new Agent({
  initialState: { systemPrompt: VERIFIER_PROMPT, model },
  streamFn: streamWithRequestAuth(resolveRequestAuth),
});

await agent.prompt(
  `Goal: ${goal}\n\n` +
  `Driver verdict: ${JSON.stringify(verdict)}\n\n` +
  `Final URL: ${finalUrl}\n\n` +
  `Actions taken:\n${actionsBlock}\n\n` +
  `Final snapshot:\n${finalSnapshot}\n\n` +
  `Your JSON:`
);
```

## what we do not use

- pi-agent tool registration / `execute` hooks. Browser actions stay in `src/tools.js` and are called by `executor.js`.
- pi-agent event tracing. QAgent records turns through the executor and reporter pipeline.
- `steer()` / `followUp()`. The loop is controlled by QAgent.
- `thinkingLevel` above the package defaults for now.
- Pi-managed OAuth / subscription credentials in the standalone CLI. The CLI still uses QAgent's API-key config/env flow; the future Pi package should resolve auth through Pi's model registry.
