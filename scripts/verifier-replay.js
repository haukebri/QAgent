#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { getModel } from '@earendil-works/pi-ai';
import { loadConfig } from '../src/config.js';
import { resolveApiKey } from '../src/providers.js';
import { createGoalContract } from '../src/goal-contract.js';
import { verify } from '../src/verifier.js';

export const corpus = [
  {
    id: 'acceptance-scope-expansion', failureClass: 'acceptance-scope expansion',
    goal: 'Persona: enter 99 as a planning example. Only the Acceptance section is binding.\nAcceptance:\n- The result says Ready.',
    browserTruth: 'pass', evidenceTruth: 'yes',
    verdict: { action: 'done', summary: 'Ready is visible.' }, history: [],
    finalUrl: 'https://fixture.test/result', finalSnapshot: '- status "Ready"',
  },
  {
    id: 'altered-claim', failureClass: 'altered or invented claims',
    goal: 'Verify the selected plan is Standard.', browserTruth: 'pass', evidenceTruth: 'yes',
    verdict: { action: 'done' },
    history: [{ action: { action: 'selectOption', value: 'Standard' }, target: 'combobox "Plan"', url: 'https://fixture.test/form', nativeState: { before: { selected: ['Basic'] }, after: { selected: ['Standard'], value: 'Standard' } } }],
    finalUrl: 'https://fixture.test/form', finalSnapshot: '- combobox "Plan": Standard',
  },
  {
    id: 'separate-form-groups', failureClass: 'separate form groups treated as overwrites',
    goal: 'Select Same in both Work pattern and Travel pattern.', browserTruth: 'pass', evidenceTruth: 'yes',
    verdict: { action: 'done' }, history: [
      { action: { action: 'click' }, target: 'radio "Same" in fieldset "Work pattern"', url: 'https://fixture.test/form', nativeState: { before: { name: 'work', checked: false }, after: { name: 'work', value: 'same', checked: true } } },
      { action: { action: 'click' }, target: 'radio "Same" in fieldset "Travel pattern"', url: 'https://fixture.test/form', nativeState: { before: { name: 'travel', checked: false }, after: { name: 'travel', value: 'same', checked: true } } },
    ],
    finalUrl: 'https://fixture.test/form', finalSnapshot: '- group "Work pattern"\n  - radio "Same" [checked]\n- group "Travel pattern"\n  - radio "Same" [checked]',
  },
  {
    id: 'visible-control-not-clicked', failureClass: 'visible controls treated as clicks',
    goal: 'Show the result without clicking Book a call.', browserTruth: 'pass', evidenceTruth: 'yes',
    verdict: { action: 'done' }, history: [],
    finalUrl: 'https://fixture.test/result', finalSnapshot: '- heading "Result"\n- button "Book a call"',
  },
  {
    id: 'conditional-polarity', failureClass: 'conditional-polarity errors',
    goal: 'If a warning appears, dismiss it. Verify Complete is visible.', browserTruth: 'pass', evidenceTruth: 'yes',
    verdict: { action: 'done' }, history: [],
    finalUrl: 'https://fixture.test/result', finalSnapshot: '- heading "Complete"\n- text "No warning was shown"',
  },
  {
    id: 'exact-copy-mismatch', failureClass: 'exact-copy checks',
    goal: 'Verify the exact visible copy is "Total: 10.00 EUR".', browserTruth: 'fail', evidenceTruth: 'no',
    verdict: { action: 'done' }, history: [],
    finalUrl: 'https://fixture.test/result', finalSnapshot: '- text "Total: 10,00 EUR"',
  },
  {
    id: 'missing-transient-text', failureClass: 'missing transient text',
    goal: 'Verify the transient warning "Check your entry" appeared.', browserTruth: 'pass', evidenceTruth: 'yes',
    verdict: { action: 'done' }, history: [{
      action: { action: 'click' }, target: 'button "Check"', url: 'https://fixture.test/result',
      observation: { visibleTextAdded: ['Check your entry'] },
    }],
    finalUrl: 'https://fixture.test/result', finalSnapshot: '- heading "Complete"',
  },
  {
    id: 'insufficient-evidence', failureClass: 'insufficient evidence',
    goal: 'Verify the order was submitted.', browserTruth: 'pass', evidenceTruth: 'unknown',
    verdict: { action: 'done', summary: 'Submitted.' }, history: [],
    finalUrl: 'https://fixture.test/form', finalSnapshot: '- button "Submit order"',
  },
];

export function summarize(results) {
  const expectedOutcome = result => result.evidenceTruth === 'yes' ? 'pass' : 'fail';
  const decompositionError = result => result.warnings?.some(warning => warning.includes('claim decomposition failed')) ||
    (result.outcome === 'error' && /decomposition|source quote|grounded item|no assertions/iu.test(result.error ?? ''));
  const unknownCases = results.filter(result => result.evidenceTruth === 'unknown').length;
  const correctUnknowns = results.filter(result => result.evidenceTruth === 'unknown' && result.checks?.some(check => check.verdict === 'unknown')).length;
  return {
    cases: results.length,
    browserTruthPasses: results.filter(result => result.browserTruth === 'pass').length,
    evidenceCoverage: `${results.filter(result => result.evidenceTruth !== 'unknown').length}/${results.length}`,
    correctVerdicts: results.filter(result => result.outcome === expectedOutcome(result)).length,
    falsePasses: results.filter(result => result.outcome === 'pass' && expectedOutcome(result) === 'fail').length,
    falseFailures: results.filter(result => result.outcome === 'fail' && expectedOutcome(result) === 'pass').length,
    correctUnknowns,
    unknownAccuracy: `${correctUnknowns}/${unknownCases}`,
    decompositionErrors: results.filter(decompositionError).length,
    verifierErrors: results.filter(result => result.outcome === 'error' && !decompositionError(result)).length,
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
      const contract = createGoalContract(fixture.goal);
      const history = fixture.history.map((entry, index) => ({
        evidenceId: `action-${index + 1}`, success: !entry.error,
        beforeObservationId: `page-${index + 1}`, afterObservationId: `page-${index + 2}`,
        ...entry,
      }));
      const browserEvidence = fixture.browserEvidence ?? { pageStates: [{
        id: `page-${history.length + 1}`, final: true, url: fixture.finalUrl,
        visibleText: fixture.finalSnapshot.replace(/^\s*-\s*\w+\s+"?|".*$/gm, '').trim(),
      }] };
      const result = await verify(
        contract.verificationGoal, fixture.verdict, history, fixture.finalUrl, fixture.finalSnapshot,
        model, async () => ({ apiKey }), browserEvidence,
      );
      results.push({ ...fixture, goalContract: contract, ...result, latencyMs: Date.now() - started });
    } catch (error) {
      results.push({ ...fixture, outcome: 'error', error: error.message, checks: [], warnings: error.warnings ?? [], tokens: error.tokens, latencyMs: Date.now() - started });
    }
  }
  process.stdout.write(`${JSON.stringify({ provider, model: modelId, corpus: '2026-07-15-v1', results, summary: summarize(results) }, null, 2)}\n`);
  if (summarize(results).verifierErrors || summarize(results).decompositionErrors) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
