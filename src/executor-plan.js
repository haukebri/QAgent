import { chromium } from 'playwright';
import { Agent } from '@mariozechner/pi-agent-core';
import { getModel } from '@mariozechner/pi-ai';
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

const SYSTEM_PROMPT =
  'You plan one browser action at a time toward a goal. Respond with a single JSON object and nothing else (no markdown fences, no commentary).\n\n' +
  'Schema:\n' +
  '  { "action": "navigate" | "click" | "fill" | "done", "url"?: string, "ref"?: string, "value"?: string }\n\n' +
  'Examples:\n' +
  '  {"action": "navigate", "url": "https://example.com"}\n' +
  '  {"action": "click", "ref": "e6"}\n' +
  '  {"action": "fill", "ref": "e40", "value": "playwright"}\n' +
  '  {"action": "done"}\n\n' +
  'Pick "done" when the goal is clearly complete (e.g. the URL or page state matches).';

async function askNextAction({ goal, url, snapshot }) {
  // Fresh agent each turn — the whole point of this variant is bounded context.
  const agent = new Agent({
    initialState: { systemPrompt: SYSTEM_PROMPT, model },
    getApiKey: async () => apiKey,
  });
  await agent.prompt(
    `Goal: ${goal}\n\nCurrent URL: ${url}\n\nCurrent snapshot:\n${snapshot}\n\nNext action (JSON only):`
  );
  const last = [...agent.state.messages].reverse().find(m => m.role === 'assistant');
  const text = last?.content.filter(c => c.type === 'text').map(c => c.text).join('') ?? '';
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`no JSON in LLM response: ${text}`);
  return JSON.parse(match[0]);
}

const browser = await chromium.launch();
const page = await browser.newPage();

try {
  let turns = 0;
  let done = false;
  while (turns < MAX_TURNS && !done) {
    turns++;
    const snapshot = await observe(page);
    const url = page.url();
    const action = await askNextAction({ goal: GOAL, url, snapshot });
    console.log(`turn ${turns}: ${JSON.stringify(action)}`);

    if (action.action === 'done') { done = true; break; }
    if (action.action === 'navigate') await navigate(page, action.url);
    else if (action.action === 'click') await click(page, action.ref);
    else if (action.action === 'fill') await fill(page, action.ref, action.value);
    else throw new Error(`unknown action: ${action.action}`);
  }

  const urlOk = page.url().includes('iana.org');
  console.log(`final url: ${page.url()}`);
  console.log(`turns: ${turns}`);
  console.log(urlOk ? 'PASS' : 'FAIL');
} finally {
  await browser.close();
}
