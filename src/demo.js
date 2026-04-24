// Temporary runner for src/executor.js. Delete when runner.js / cli.js land.
// Usage: node --env-file=.env src/demo.js "<goal>"
//   optional env: BASIC_AUTH_USER, BASIC_AUTH_PASS (enables httpCredentials)
import { chromium } from 'playwright';
import { getModel } from '@mariozechner/pi-ai';
import { runTodo } from './executor.js';

const modelId = process.env.LLM_MODEL;
const apiKey = process.env.LLM_API_KEY;
if (!modelId || !apiKey) throw new Error('LLM_MODEL / LLM_API_KEY missing (use --env-file=.env)');
const model = getModel('openrouter', modelId);
if (!model) throw new Error(`unknown model: ${modelId}`);

const goal = process.argv.slice(2).join(' ');
if (!goal) throw new Error('usage: node --env-file=.env src/demo.js "<goal>"');

const httpCredentials =
  process.env.BASIC_AUTH_USER && process.env.BASIC_AUTH_PASS
    ? { username: process.env.BASIC_AUTH_USER, password: process.env.BASIC_AUTH_PASS }
    : undefined;

const browser = await chromium.launch();
try {
  const context = await browser.newContext(httpCredentials ? { httpCredentials } : undefined);
  const page = await context.newPage();
  const result = await runTodo(page, goal, model, apiKey);

  for (const h of result.history) {
    const extra = h.error ? ` -> error: ${h.error}` : '';
    console.log(`turn ${h.turn}: ${JSON.stringify(h.action)}${extra}`);
  }

  const elapsedS = (result.elapsedMs / 1000).toFixed(1);
  const perTurn = result.turns ? (result.elapsedMs / result.turns / 1000).toFixed(1) : '-';
  console.log(`\nfinal url: ${result.finalUrl}`);
  console.log(`turns: ${result.turns} | elapsed: ${elapsedS}s | avg/turn: ${perTurn}s`);
  console.log(`tokens: ${result.tokens.totalTokens} (in=${result.tokens.input}, out=${result.tokens.output}) | cost: $${result.tokens.cost.toFixed(4)}`);
  if (result.outcome === 'pass') console.log(`PASS: ${result.summary}`);
  else if (result.outcome === 'fail') console.log(`FAIL: ${result.reason}`);
  else console.log(`STUCK: hit turn cap`);
  for (const w of result.warnings) console.log(`⚠  WARNING: ${w}`);
} finally {
  await browser.close();
}
