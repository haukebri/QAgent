import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPayload } from '../src/recorder.js';

test('records locale in trace payloads', () => {
  const payload = buildPayload('goal', 'driver', 'verifier', {
    outcome: 'pass',
    llmVerdict: null,
    evidence: 'ok',
    humanEvidence: 'Looks good.',
    finalUrl: 'https://example.test',
    turns: 0,
    elapsedMs: 0,
    tokens: null,
    verifierTokens: null,
    verifierMode: 'checks',
    history: [{
      turn: 1,
      action: { action: 'click', ref: 'e1' },
      target: 'button "Submit"',
      locator: { playwright: 'page.getByRole("button", { name: "Submit", exact: true })', css: '#submit', frameUrl: null },
      observation: { addedRefs: ['e2'], removedRefs: ['f1e3'] },
      recoveredVia: 'overlay',
    }],
    warnings: [],
    checks: [
      { claim: 'claim one', verdict: 'yes', evidence: 'seen' },
    ],
  }, 'de-DE');

  assert.equal(payload.locale, 'de-DE');
  assert.equal(payload.verifierMode, 'checks');
  assert.equal(payload.evidence, 'ok');
  assert.equal(payload.humanEvidence, 'Looks good.');
  assert.deepEqual(payload.checks, [
    { claim: 'claim one', verdict: 'yes', evidence: 'seen' },
  ]);
  assert.equal(payload.steps[0].recoveredVia, 'overlay');
  assert.equal(payload.steps[0].action.ref, undefined);
  assert.equal(payload.steps[0].target, 'button "Submit"');
  assert.equal(payload.steps[0].locator.css, '#submit');
  assert.equal(payload.steps[0].observation.addedElementsCount, 1);
  assert.equal(payload.steps[0].observation.removedElementsCount, 1);
  assert.equal(payload.steps[0].observation.addedRefs, undefined);
});
