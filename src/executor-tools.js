import { chromium } from 'playwright';
import { Agent } from '@mariozechner/pi-agent-core';
import { getModel, Type } from '@mariozechner/pi-ai';
import { observe } from './observer.js';
import { click, fill, navigate } from './tools.js';

const modelId = process.env.LLM_MODEL;
const apiKey = process.env.LLM_API_KEY;
if (!modelId || !apiKey) throw new Error('LLM_MODEL / LLM_API_KEY missing (use --env-file=.env)');
const model = getModel('openrouter', modelId);
if (!model) throw new Error(`unknown model: ${modelId}`);

const GOAL =
  'Navigate to https://example.com and click the "More information..." link. ' +
  'The task is complete when the URL contains "iana.org".';
const MAX_TURNS = 15;

const browser = await chromium.launch();
const page = await browser.newPage();

const navigateTool = {
  name: 'navigate',
  description: 'Navigate to a URL. Returns the new page snapshot.',
  parameters: Type.Object({ url: Type.String() }),
  execute: async (_id, { url }) => {
    await navigate(page, url);
    return { content: [{ type: 'text', text: await observe(page) }] };
  },
};

const clickTool = {
  name: 'click',
  description: 'Click the element with the given aria ref (e.g. "e5"). Returns the new page snapshot.',
  parameters: Type.Object({ ref: Type.String() }),
  execute: async (_id, { ref }) => {
    await click(page, ref);
    return { content: [{ type: 'text', text: await observe(page) }] };
  },
};

const fillTool = {
  name: 'fill',
  description: 'Fill a textbox/input identified by aria ref. Returns the new page snapshot.',
  parameters: Type.Object({ ref: Type.String(), value: Type.String() }),
  execute: async (_id, { ref, value }) => {
    await fill(page, ref, value);
    return { content: [{ type: 'text', text: await observe(page) }] };
  },
};

const doneTool = {
  name: 'done',
  description: 'Signal that the goal has been achieved. Call this when the task is complete.',
  parameters: Type.Object({}),
  execute: async () => ({
    content: [{ type: 'text', text: 'Done.' }],
    terminate: true,
  }),
};

const agent = new Agent({
  initialState: {
    systemPrompt:
      'You drive a browser to accomplish a goal. Tools: navigate(url), click(ref), fill(ref, value), done(). ' +
      'Each action returns the new page snapshot as YAML with elements tagged [ref=eN]. ' +
      'Use those refs for click and fill. When the goal is achieved, call done.',
    model,
    tools: [navigateTool, clickTool, fillTool, doneTool],
    toolExecution: 'sequential',
  },
  getApiKey: async () => apiKey,
});

let turns = 0;
agent.subscribe(async (e) => {
  if (e.type === 'turn_end') {
    turns++;
    if (turns >= MAX_TURNS) agent.abort();
  }
});

try {
  const initial = await observe(page);
  await agent.prompt(`Goal: ${GOAL}\n\nInitial snapshot:\n${initial}`);
  const urlOk = page.url().includes('iana.org');
  console.log(`final url: ${page.url()}`);
  console.log(`turns: ${turns}`);
  console.log(urlOk ? 'PASS' : 'FAIL');
} finally {
  await browser.close();
}
