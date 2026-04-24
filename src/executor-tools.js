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
  'Navigate to https://req-eng-frontend.haukebrinkmann.com/ and log in using ' +
  'email "haukebr@gmail.com" and password "test123". After logging in, go to the ' +
  'admin page and report how many projects currently exist. ' +
  'Call done with a summary that states the count.';
const MAX_TURNS = 20;

const browser = await chromium.launch();
const context = await browser.newContext({
  httpCredentials: { username: 'req', password: 'req' },
});
const page = await context.newPage();

let finalSummary = null;

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
  description:
    'Signal the goal has been achieved. Provide a summary that answers any question ' +
    'the goal asked for (e.g. counts, values extracted from the page).',
  parameters: Type.Object({ summary: Type.String() }),
  execute: async (_id, { summary }) => {
    finalSummary = summary;
    return { content: [{ type: 'text', text: `Done: ${summary}` }], terminate: true };
  },
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
  console.log(`final url: ${page.url()}`);
  console.log(`turns: ${turns}`);
  console.log(`summary: ${finalSummary ?? '(no summary — done not called)'}`);
} finally {
  await browser.close();
}
