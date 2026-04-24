// Temporary runner for src/executor.js. Delete when runner.js / cli.js land.
// Usage: node --env-file=.env src/demo.js "<goal>"
//   optional env: BASIC_AUTH_USER, BASIC_AUTH_PASS (enables httpCredentials)
//   optional env: VERIFIER_MODEL (defaults to LLM_MODEL)
import { getModel } from '@mariozechner/pi-ai';
import { launchPage } from './browser.js';
import { runTodo } from './executor.js';
import { record } from './recorder.js';

const modelId = process.env.LLM_MODEL;
const apiKey = process.env.LLM_API_KEY;
const verifierModelId = process.env.VERIFIER_MODEL ?? modelId;
if (!modelId || !apiKey) throw new Error('LLM_MODEL / LLM_API_KEY missing (use --env-file=.env)');
const model = getModel('openrouter', modelId);
if (!model) throw new Error(`unknown model: ${modelId}`);
const verifierModel = getModel('openrouter', verifierModelId);
if (!verifierModel) throw new Error(`unknown verifier model: ${verifierModelId}`);

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
    result = await runTodo(page, goal, model, apiKey, 20, verifierModel);
  } catch (err) {
    result = {
      outcome: 'error',
      evidence: `runner crashed: ${err.message.split('\n')[0]}`,
      llmVerdict: null,
      turns: 0,
      elapsedMs: 0,
      tokens: { input: 0, output: 0, totalTokens: 0, cost: 0 },
      verifierTokens: null,
      finalUrl: page.url(),
      finalSnapshot: '',
      history: [],
      warnings: [],
    };
  }

  for (const h of result.history) {
    const target = h.target ? ` [${h.target}]` : '';
    const url = h.url ? ` @ ${h.url}` : '';
    const extra = h.error ? ` -> error: ${h.error}` : '';
    console.log(`turn ${h.turn}: ${JSON.stringify(h.action)}${target}${url}${extra}`);
  }

  const elapsedS = (result.elapsedMs / 1000).toFixed(1);
  const perTurn = result.turns ? (result.elapsedMs / result.turns / 1000).toFixed(1) : '-';
  console.log(`\nfinal url: ${result.finalUrl}`);
  console.log(`turns: ${result.turns} | elapsed: ${elapsedS}s | avg/turn: ${perTurn}s`);
  const t = result.tokens;
  console.log(`tokens: ${t.totalTokens} (in=${t.input}, out=${t.output}) | cost: $${t.cost.toFixed(4)}`);
  if (result.verifierTokens) {
    const v = result.verifierTokens;
    console.log(`verifier: ${v.totalTokens} (in=${v.input}, out=${v.output}) | cost: $${v.cost.toFixed(4)}`);
  }
  if (result.llmVerdict) {
    const lv = result.llmVerdict;
    const extra = lv.summary ?? lv.reason ?? '';
    console.log(`driver verdict: ${lv.action}${extra ? ` — ${extra}` : ''}`);
  }
  if (result.outcome === 'pass') console.log(`PASS: ${result.evidence}`);
  else if (result.outcome === 'fail') console.log(`FAIL: ${result.evidence}`);
  else console.log(`ERROR: ${result.evidence}`);
  for (const w of result.warnings) console.log(`⚠  WARNING: ${w}`);

  const traceFile = await record(goal, modelId, verifierModelId, result);
  console.log(`trace: ${traceFile}`);
} finally {
  await browser.close();
}
