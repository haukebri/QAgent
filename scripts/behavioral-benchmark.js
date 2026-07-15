#!/usr/bin/env node
import { createServer } from 'node:http';
import { fauxAssistantMessage, getModel, registerFauxProvider } from '@earendil-works/pi-ai';
import { loadConfig } from '../src/config.js';
import { resolveApiKey } from '../src/providers.js';
import { runQAgent } from '../src/runner.js';

const live = process.argv.includes('--live');
const runs = Number.parseInt(process.argv.find(arg => /^\d+$/.test(arg)) ?? '1', 10);
if (!Number.isInteger(runs) || runs < 1) throw new Error('runs must be a positive integer');
const { user, project } = loadConfig();
const provider = process.env.QAGENT_PROVIDER ?? project.provider ?? user.provider ?? 'openrouter';
const modelId = process.env.QAGENT_MODEL ?? project.model ?? user.model ?? 'google/gemma-4-26b-a4b-it';
const liveModel = live ? getModel(provider, modelId) : null;
const liveApiKey = live ? resolveApiKey({ provider, flags: {}, env: process.env, project, user }).apiKey : null;
if (live && !liveModel) throw new Error(`unknown benchmark model "${modelId}" for provider "${provider}"`);

const pages = {
  '/wizard': `<!doctype html><h1>Step one</h1><button onclick="setTimeout(() => document.body.innerHTML='<h1>Step two complete</h1>', 700)">Continue</button>`,
  '/groups': `<!doctype html>
    <fieldset><legend>Work pattern</legend><label><input type="radio" name="work"> Same</label></fieldset>
    <fieldset><legend>Travel pattern</legend><label><input type="radio" name="travel"> Same</label></fieldset>
    <button onclick="document.body.insertAdjacentHTML('beforeend','<h1>Groups complete</h1>')">Save</button>`,
  '/navigation': `<!doctype html><h1>Navigation start</h1><a href="/wrong">Wrong route</a><a href="/finish">Finish</a>`,
  '/wrong': '<!doctype html><h1>Wrong route</h1>',
  '/finish': '<!doctype html><h1>Navigation complete</h1>',
  '/products': '<!doctype html><h1>Products</h1><button>Similar VM7</button>',
};

const server = createServer((req, res) => {
  res.writeHead(pages[req.url] ? 200 : 404, { 'content-type': 'text/html' });
  res.end(pages[req.url] ?? 'not found');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const ref = (context, pattern) => {
  const text = context.messages.flatMap(message => message.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
  const match = text.match(new RegExp(`${pattern}[^\n]*?\\[ref=(e\\d+)\\]`));
  if (!match) throw new Error(`benchmark control not found: ${pattern}`);
  return match[1];
};
const action = fn => context => fauxAssistantMessage(JSON.stringify(fn(context)));
const decomposition = (sourceQuote, comparison = 'semantic') => fauxAssistantMessage(JSON.stringify({
  items: [{ id: 'claim-1', text: sourceQuote, sourceQuote, kind: 'assertion', comparison }],
}));
const citedPage = (support, evidence) => context => {
  const ids = [...JSON.stringify(context).matchAll(/\\?"id\\?":\s*\\?"(page-[^\\"]+)/g)].map(match => match[1]);
  return fauxAssistantMessage(JSON.stringify({
    supportingEvidenceIds: support ? [ids.at(-1)] : [],
    contradictingEvidenceIds: support ? [] : [ids.at(-1)],
    evidence,
  }));
};
const verifyYes = sourceQuote => [decomposition(sourceQuote), citedPage(true, `Concrete browser evidence verifies: ${sourceQuote}`)];

const definitions = [
  {
    name: 'delayed-wizard', path: '/wizard', goal: 'Click Continue and verify Step two complete is visible.',
    responses: [
      action(context => ({ action: 'click', ref: ref(context, 'button \\"Continue\\"') })),
      fauxAssistantMessage('{"action":"done","summary":"Step two complete is visible."}'),
      ...verifyYes('Step two complete is visible.'),
    ],
    complete: result => result.finalSnapshot.includes('Step two complete'),
  },
  {
    name: 'grouped-form', path: '/groups', goal: 'Select Same in Work pattern and Same in Travel pattern, save, and verify Groups complete.',
    responses: [
      action(context => ({ action: 'click', ref: ref(context, 'radio \\"Same\\"') })),
      action(context => {
        const text = context.messages.flatMap(message => message.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
        const refs = [...text.matchAll(/radio "Same"[^\n]*?\[ref=(e\d+)\]/g)].map(match => match[1]);
        return { action: 'click', ref: refs.at(-1) };
      }),
      action(context => ({ action: 'click', ref: ref(context, 'button \\"Save\\"') })),
      fauxAssistantMessage('{"action":"done","summary":"Both named groups were selected and saved."}'),
      ...verifyYes('Groups complete.'),
    ],
    complete: result => result.finalSnapshot.includes('Groups complete') &&
      result.history.filter(step => step.target?.includes('radio "Same" in fieldset')).length === 2,
  },
  {
    name: 'exact-product', path: '/products', expectedOutcome: 'fail',
    goal: 'Add the exact PB440 product. Do not substitute a similar product; fail if PB440 is unavailable.',
    responses: [
      fauxAssistantMessage('{"action":"fail","reason":"PB440 is unavailable; only Similar VM7 is offered."}'),
      decomposition('Add the exact PB440 product.'),
      citedPage(false, 'The page offers only Similar VM7, not PB440.'),
    ],
    complete: () => false,
    satisfied: result => result.llmVerdict?.action === 'fail' &&
      !result.history.some(step => step.action?.action === 'click'),
  },
  {
    name: 'navigation-recovery', path: '/navigation', goal: 'Recover from a wrong route with browser back, then reach Navigation complete.',
    responses: [
      action(context => ({ action: 'click', ref: ref(context, 'link \\"Wrong route\\"') })),
      fauxAssistantMessage('{"action":"goBack"}'),
      action(context => ({ action: 'click', ref: ref(context, 'link \\"Finish\\"') })),
      fauxAssistantMessage('{"action":"done","summary":"Navigation complete is visible."}'),
      ...verifyYes('Navigation complete.'),
    ],
    complete: result => result.finalSnapshot.includes('Navigation complete') &&
      result.history.some(step => step.action?.action === 'goBack' && !step.error),
    forbidden: {
      goal: 'Do not use browser back. Reach Navigation complete from the current page.',
      responses: [
        fauxAssistantMessage('{"action":"goBack"}'),
        action(context => ({ action: 'click', ref: ref(context, 'link \\"Finish\\"') })),
        fauxAssistantMessage('{"action":"done","summary":"Navigation complete is visible without browser back."}'),
        ...verifyYes('Navigation complete'),
      ],
      complete: result => result.finalSnapshot.includes('Navigation complete') && (live
        ? result.history.every(step => step.action?.action !== 'goBack')
        : result.history.some(step => step.action?.action === 'goBack' && /explicitly forbids/.test(step.error))),
    },
  },
];

async function execute(definition, suffix = '') {
  const faux = live ? null : registerFauxProvider();
  faux?.setResponses(definition.responses);
  try {
    const result = await runQAgent({
      url: `${origin}${definition.path ?? '/navigation'}`,
      goal: definition.goal,
      model: liveModel ?? faux.getModel(),
      resolveRequestAuth: async () => live ? { apiKey: liveApiKey } : ({}),
      maxTurns: 8,
      testTimeoutMs: 30_000,
    });
    const completed = definition.complete(result);
    return {
      name: `${definition.name ?? 'navigation-recovery'}${suffix}`,
      completed,
      behaviorSatisfied: definition.satisfied?.(result) ?? completed,
      expectedOutcome: definition.expectedOutcome ?? 'pass',
      outcome: result.outcome,
      turns: result.turns,
      elapsedMs: result.elapsedMs,
      cost: (result.tokens?.cost ?? 0) + (result.verifierTokens?.cost ?? 0),
      technical: result.outcome === 'error' || !['done', 'fail'].includes(result.llmVerdict?.action),
      evidence: result.evidence,
    };
  } finally {
    faux?.unregister();
  }
}

const results = [];
try {
  for (let i = 0; i < runs; i++) {
    for (const definition of definitions) {
      const main = await execute(definition);
      if (definition.forbidden) {
        const forbidden = { ...definition.forbidden, path: definition.path, name: definition.name };
        const sub = await execute(forbidden, '-forbidden');
        main.completed &&= sub.completed;
        main.outcome = main.outcome === 'pass' && sub.outcome === 'pass' ? 'pass' : 'fail';
        main.turns += sub.turns;
        main.elapsedMs += sub.elapsedMs;
        main.cost += sub.cost;
        main.technical ||= sub.technical;
      }
      results.push(main);
    }
  }
} finally {
  await new Promise(resolve => server.close(resolve));
}

const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
const completed = results.filter(result => result.completed).length;
const behaviorSatisfied = results.filter(result => result.behaviorSatisfied).length;
const falsePasses = results.filter(result => result.outcome === 'pass' && (result.expectedOutcome !== 'pass' || !result.completed)).length;
const summary = {
  scenarios: results.length,
  goalCompletionRate: `${completed}/${results.length}`,
  correctVerdicts: results.filter(result => result.behaviorSatisfied && result.outcome === result.expectedOutcome).length,
  falsePasses,
  technicalTerminations: results.filter(result => result.technical).length,
  medianTurns: median(results.map(result => result.turns)),
  medianElapsedMs: median(results.map(result => result.elapsedMs)),
  medianCost: median(results.map(result => result.cost)),
};
process.stdout.write(`${JSON.stringify({ results, summary }, null, 2)}\n`);
if (falsePasses || behaviorSatisfied !== results.length || summary.correctVerdicts !== results.length || summary.technicalTerminations) process.exit(1);
