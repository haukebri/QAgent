// Temporary runner for src/executor.js. Delete when runner.js / cli.js land.
// Usage: node --env-file=.env src/demo.js "<goal>"
//   optional env: BASIC_AUTH_USER, BASIC_AUTH_PASS (enables httpCredentials)
import { getModel } from '@mariozechner/pi-ai';
import { launchPage } from './browser.js';
import { runTodo } from './executor.js';
import { record } from './recorder.js';

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

const { browser, page } = await launchPage({ httpCredentials });
try {
  let result;
  try {
    result = await runTodo(page, goal, model, apiKey);
  } catch (err) {
    result = {
      outcome: 'error',
      summary: null,
      reason: `runner crashed: ${err.message.split('\n')[0]}`,
      turns: 0,
      elapsedMs: 0,
      tokens: { input: 0, output: 0, totalTokens: 0, cost: 0 },
      finalUrl: page.url(),
      history: [],
      warnings: [],
    };
  }

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
  else if (result.outcome === 'error') console.log(`ERROR: ${result.reason}`);
  else console.log(`STUCK: hit turn cap`);
  for (const w of result.warnings) console.log(`⚠  WARNING: ${w}`);

  const traceFile = await record(goal, modelId, result);
  console.log(`trace: ${traceFile}`);
} finally {
  await browser.close();
}
