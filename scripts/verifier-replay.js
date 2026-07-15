#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { getModel } from '@earendil-works/pi-ai';
import { loadConfig } from '../src/config.js';
import { resolveApiKey } from '../src/providers.js';
import { verify } from '../src/verifier.js';

export const corpus = [
  {
    id: 'calculator-complete', expectedOutcome: 'pass',
    goal: 'Submit the calculator and show Your starting point with maintenance 1434 kcal.',
    history: [{ action: { action: 'click' }, target: 'button "Calculate my strategy"', success: true, url: 'https://coachbrigi.com/strategy-and-calorie-quiz/' }],
    finalUrl: 'https://coachbrigi.com/strategy-and-calorie-quiz/',
    finalSnapshot: '- heading "YOUR STARTING POINT"\n- text "Maintenance 1434 kcal"\n- text "Your target 1434 kcal maintenance"',
  },
  {
    id: 'calculator-stuck', expectedOutcome: 'fail',
    goal: 'Submit the calculator and show a result.',
    history: [{ action: { action: 'click' }, target: 'generic "Female" in section "YOUR BODY METRICS"', success: true, url: 'https://coachbrigi.com/strategy-and-calorie-quiz/' }],
    finalUrl: 'https://coachbrigi.com/strategy-and-calorie-quiz/', finalSnapshot: '- heading "YOUR BODY METRICS"\n- text "BIOLOGICAL SEX"\n- button "Continue"',
  },
  {
    id: 'vorwerk-cart-complete', expectedOutcome: 'pass',
    goal: 'Add Kobold VR7 Saugroboter & RB7 Servicestation to the cart and leave no blocking cookie dialog.',
    history: [{ action: { action: 'click' }, target: 'button "Zur Kasse"', success: true, url: 'https://www.vorwerk.com/de/de/s/shop/cart' }],
    finalUrl: 'https://www.vorwerk.com/de/de/s/shop/cart', finalSnapshot: '- heading "Warenkorb"\n- text "Kobold VR7 Saugroboter & RB7 Servicestation"\n- text "Menge 1"',
  },
  {
    id: 'wrong-product-route', expectedOutcome: 'fail',
    goal: 'Open PB440 from the homepage teaser and add it to the cart.',
    history: [{ action: { action: 'click' }, target: 'link "VM7" in search results', success: true, url: 'https://www.vorwerk.com/de/de/s/shop/vm7' }],
    finalUrl: 'https://www.vorwerk.com/de/de/s/shop/cart', finalSnapshot: '- heading "Warenkorb"\n- text "Kobold VM7"\n- text "Menge 1"',
  },
  {
    id: 'transient-confirmation', expectedOutcome: 'pass',
    goal: 'Add the VR7 product and observe the cart confirmation dialog.',
    history: [{ action: { action: 'click' }, target: 'button "In den Warenkorb"', success: true, url: 'https://www.vorwerk.com/de/de/s/shop/kobold-vr7-saugroboter-rb7-servicestation-de', observation: { addedText: ['Weiter einkaufen', 'Zur Kasse'] } }],
    finalUrl: 'https://www.vorwerk.com/de/de/s/shop/cart', finalSnapshot: '- heading "Warenkorb"\n- text "Kobold VR7 Saugroboter & RB7 Servicestation"',
  },
  {
    id: 'unsubmitted-form', expectedOutcome: 'fail',
    goal: 'Submit the calculator and show Your starting point.', history: [],
    finalUrl: 'https://coachbrigi.com/strategy-and-calorie-quiz/', finalSnapshot: '- heading "YOUR BODY METRICS"\n- button "Continue"',
  },
];

export function summarize(results) {
  return {
    correctPass: results.filter(result => result.expectedOutcome === 'pass' && result.outcome === 'pass').length,
    correctFail: results.filter(result => result.expectedOutcome === 'fail' && result.outcome === 'fail').length,
    falsePass: results.filter(result => result.expectedOutcome === 'fail' && result.outcome === 'pass').length,
    falseFail: results.filter(result => result.expectedOutcome === 'pass' && result.outcome === 'fail').length,
    verifierErrors: results.filter(result => result.outcome === 'error').length,
    verifierCalls: results.reduce((total, result) => total + (result.tokens?.calls ?? 0), 0),
    tokens: results.reduce((total, result) => total + (result.tokens?.totalTokens ?? 0), 0),
    cost: results.reduce((total, result) => total + (result.tokens?.cost ?? 0), 0),
    latencyMs: results.reduce((total, result) => total + result.latencyMs, 0),
  };
}

async function main() {
  const { user, project } = loadConfig();
  const provider = process.env.QAGENT_PROVIDER ?? project.provider ?? user.provider ?? 'openrouter';
  const modelId = process.env.QAGENT_VERIFIER_MODEL ?? project.verifierModel ?? user.verifierModel ??
    process.env.QAGENT_MODEL ?? project.model ?? user.model;
  if (!modelId) throw new Error('no verifier model; set QAGENT_VERIFIER_MODEL or configure verifierModel');
  const model = getModel(provider, modelId);
  if (!model) throw new Error(`unknown verifier model "${modelId}" for provider "${provider}"`);
  const { apiKey } = resolveApiKey({ provider, flags: {}, env: process.env, project, user });
  const results = [];
  for (const fixture of corpus) {
    const started = Date.now();
    try {
      const result = await verify(
        fixture.goal, { action: 'done' }, fixture.history, fixture.finalUrl, fixture.finalSnapshot,
        model, async () => ({ apiKey }),
      );
      results.push({ ...fixture, ...result, latencyMs: Date.now() - started });
    } catch (error) {
      results.push({ ...fixture, outcome: 'error', error: error.message, tokens: error.tokens, latencyMs: Date.now() - started });
    }
  }
  const summary = summarize(results);
  process.stdout.write(`${JSON.stringify({ provider, model: modelId, corpus: '2026-07-15-v2', summary }, null, 2)}\n`);
  if (summary.falsePass || summary.falseFail || summary.verifierErrors) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
