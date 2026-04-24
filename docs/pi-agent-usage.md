# pi-agent usage

Version: `@mariozechner/pi-agent-core@0.70.0` + `@mariozechner/pi-ai@0.70.0`.

Companion to `docs/playwright-usage.md`. This covers how QA-Runner uses pi-agent / pi-ai for the LLM loop. Every claim below is verified against `pi-mono@0.70.0` source (`packages/agent/src/{agent,agent-loop,types}.ts`, `packages/ai/src/{env-api-keys,models,types,index}.ts`).

## the key insight

pi-agent runs the full `observe → LLM picks tool → execute → feed result back → repeat` loop for us. We hand it a model, a system prompt, and a list of tools. It hands us events and a final transcript. We keep our own turn cap and our own trace; everything else is the library's job.

## install

```bash
npm install @mariozechner/pi-agent-core@0.70.0 @mariozechner/pi-ai@0.70.0
```

Pin to exact `0.70.0` (no caret) in `package.json` — one-maintainer project, weekly releases. No postinstall. Both are ESM, Node >=20. `pi-ai` bundles every provider SDK (Anthropic, OpenAI, Google, Mistral, Bedrock) — install is heavy but transparent.

## env and API keys (OpenRouter)

pi-ai reads `OPENROUTER_API_KEY` from `process.env` — nothing else. Our `.env` uses `LLM_API_KEY` and `LLM_MODEL`, so we do **not** rely on auto-pickup. Cleanest pattern: pass the key via the Agent's `getApiKey` hook, which wins over env.

```js
// run with: node --env-file=.env src/executor.js
const agent = new Agent({
  initialState: { systemPrompt, model: getModel("openrouter", process.env.LLM_MODEL) },
  getApiKey: async (_provider) => process.env.LLM_API_KEY,
});
```

Alternative: `process.env.OPENROUTER_API_KEY = process.env.LLM_API_KEY` at startup and skip `getApiKey`. Alternative env loader: `npm i dotenv` + `import "dotenv/config"` — we prefer `--env-file` (zero deps).

## getting a model

`getModel(provider, modelId)` is **synchronous** and takes no options. Returns a `Model` object from a static registry, or `undefined` on typo.

```js
import { getModel } from "@mariozechner/pi-ai";
const model = getModel("openrouter", "anthropic/claude-sonnet-4.5");
if (!model) throw new Error(`unknown model: ${process.env.LLM_MODEL}`);
```

Gotcha: unknown id → silent `undefined` → cryptic downstream error. Always assert.

## creating an Agent

All `initialState` keys are optional; defaults fill in. Minimum practical set: `systemPrompt`, `model`, `tools`.

```js
import { Agent } from "@mariozechner/pi-agent-core";
import { getModel, Type } from "@mariozechner/pi-ai";

const agent = new Agent({
  initialState: {
    systemPrompt: "Drive the browser to accomplish the goal.",
    model: getModel("openrouter", process.env.LLM_MODEL),
    tools: [clickTool /*, fillTool, navigateTool */],
    // thinkingLevel: "off",   // off | minimal | low | medium | high | xhigh
    // toolExecution: "sequential",  // see gotchas
  },
  getApiKey: async () => process.env.LLM_API_KEY,
});
```

Defaults from source: `thinkingLevel: "off"`, `toolExecution: "parallel"`, `steeringMode/followUpMode: "one-at-a-time"`, `transport: "sse"`.

## defining a tool

`Type` is re-exported from `pi-ai` — no need to install `typebox` separately. `execute` receives `(toolCallId, params, signal, onUpdate)` and must return `{ content, details?, isError?, terminate? }`. Content types are `{type:"text", text}` and `{type:"image", data, mimeType}` — no others.

```js
import { Type } from "@mariozechner/pi-ai";

const clickTool = {
  name: "click",
  description: "Click element by ref (e.g. e5)",
  parameters: Type.Object({ ref: Type.String() }),
  execute: async (_toolCallId, { ref }, signal, _onUpdate) => {
    signal?.throwIfAborted?.();
    await click(page, ref);               // our tools.js
    const snapshot = await observe(page); // our observer.js
    return {
      content: [{ type: "text", text: snapshot }],
      details: { ref, kind: "click" },    // trace-only, not sent to LLM
    };
  },
};
```

- `details` is arbitrary JSON that travels with the `toolResult` but is **not** sent to the LLM. Good place for trace payloads we don't want to burn context on.
- `onUpdate` streams partial progress events to subscribers. UI-only; the LLM never sees partials. Usually ignored.
- Errors: **throw** from `execute()`. pi-agent catches and emits a toolResult with `isError: true`. Returning `isError` yourself does not work.

## running a prompt

`agent.prompt(text)` returns `Promise<void>` that resolves after the full loop ends (including awaited `agent_end` subscribers). It does not return a result — read `agent.state.messages` afterward.

```js
await agent.prompt(`Goal: ${todo.goal}\n\nInitial page:\n${await observe(page)}`);
const msgs = agent.state.messages;
const lastAssistant = [...msgs].reverse().find(m => m.role === "assistant");
const finalText = lastAssistant?.content.filter(c => c.type === "text").map(c => c.text).join("");
```

Throws if called while already running. One prompt at a time; use `steer()`/`followUp()` to inject mid-run or queue.

## events

For a single turn with one tool call, events fire in this order (from `agent-loop.ts`):

```
agent_start
turn_start
message_start (user)                                    message_end
message_start (assistant)  message_update* (deltas)     message_end
tool_execution_start  tool_execution_update*  tool_execution_end
message_start (toolResult)                              message_end
turn_end               // one LLM call + its tool batch
turn_start ... turn_end  // next turn, LLM reacts to toolResult
agent_end
```

Subscribe:

```js
let turns = 0;
agent.subscribe(async (e) => {
  if (e.type === "turn_end" && ++turns >= 20) agent.abort();
  if (e.type === "tool_execution_start") recorder.log("action", { name: e.toolName, args: e.args });
  if (e.type === "tool_execution_end")   recorder.log("result", { id: e.toolCallId, result: e.result });
  if (e.type === "message_end" && e.message.role === "assistant") recorder.log("assistant", e.message);
});
```

- Turn cap: count `turn_end`.
- Recorder/trace: `tool_execution_start/end` + `message_end` for assistant text + `agent_end` to flush.

## abort and turn cap

Turn cap: count `turn_end` and call `agent.abort()`. External abort (Ctrl-C, timeout): also `agent.abort()` — it flips an internal `AbortController` that your tool's `execute()` receives as `signal`. `prompt()` resolves cleanly after in-flight work drains.

```js
process.on("SIGINT", () => { agent.abort(); });

const killer = setTimeout(() => agent.abort(), 5 * 60_000);
try { await agent.prompt(goal); } finally { clearTimeout(killer); }
```

## Ollama / OpenAI-compatible endpoint

Don't use `getModel()` for local/custom endpoints — build a `Model<"openai-completions">` literal and pass it to `initialState.model`.

```js
const ollama = {
  id: "qwen2.5-coder:32b",
  name: "Qwen 2.5 Coder 32B",
  api: "openai-completions",
  provider: "ollama",
  baseUrl: "http://localhost:11434/v1",
  reasoning: false,
  input: ["text"],
  contextWindow: 32768, maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
};
const agent = new Agent({ initialState: { model: ollama, ... }, getApiKey: async () => "ollama" });
```

## gotchas

- **`getModel()` returns `undefined` on typos** — silent. Always assert.
- **One prompt at a time.** `prompt()` throws if called while running. Use `steer()` mid-run, `followUp()` to queue after done.
- **`systemPrompt` and `messages` are state, not per-prompt.** `prompt()` does not reset them. Call `agent.reset()` between todos or spin up a fresh Agent.
- **Tool errors must throw.** Returning `{ isError: true }` yourself does not flag the loop.
- **`details` is not sent to the LLM.** Only `content` is. Put large trace payloads in `details` so context stays small.
- **Parallel tool execution is the default.** All our tools mutate page state — set `toolExecution: "sequential"` on the Agent (or `executionMode: "sequential"` per tool) to prevent two clicks racing.
- **`terminate: true`** from a tool only ends the loop when **every** tool in that batch returns it. Mixed batches keep going.
- **Message ordering under parallel execution:** `tool_execution_end` fires in completion order, but persisted `toolResult` messages are in assistant source order. Trust `state.messages` for replay, not event order.
- **`prompt()` awaits subscriber promises.** A hanging async subscriber hangs `prompt()`. Keep subscribers fast or fire-and-forget.
- **`thinkingLevel` defaults to `"off"`.** For reasoning models (Claude, GPT-5), bump to `"low"` or `"medium"` or leave quality on the table.
- **Snapshot size matters.** Each tool result goes into the transcript and is re-sent every turn. Our observer YAML can get large — trim or summarize if context blows up.

## what we do not use

- `steer()` / `followUp()` — interactive flows; our loop is one-shot per todo.
- `thinkingLevel` higher than `"low"` for MVP — cost/latency before we see if it helps.
- `onUpdate` partial streaming — no UI yet.
- pi-ai's OAuth / credentials flow — OpenRouter is simple API key.
