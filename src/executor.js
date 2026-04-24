import { Agent } from '@mariozechner/pi-agent-core';
import { getModel } from '@mariozechner/pi-ai';

const modelId = process.env.LLM_MODEL;
const apiKey = process.env.LLM_API_KEY;
if (!modelId) throw new Error('LLM_MODEL not set (use --env-file=.env)');
if (!apiKey) throw new Error('LLM_API_KEY not set (use --env-file=.env)');

const model = getModel('openrouter', modelId);
if (!model) throw new Error(`unknown model: ${modelId}`);

const agent = new Agent({
  initialState: {
    systemPrompt: 'You are a helpful assistant. Be terse.',
    model,
  },
  getApiKey: async () => apiKey,
});

await agent.prompt('Say hello world.');

const last = [...agent.state.messages].reverse().find(m => m.role === 'assistant');
const text = last?.content.filter(c => c.type === 'text').map(c => c.text).join('') ?? '';
console.log(text);
