import assert from 'node:assert/strict';
import test from 'node:test';
import { fauxAssistantMessage, registerFauxProvider } from '@earendil-works/pi-ai';
import { aggregateChecks, verify } from '../src/verifier.js';

test('fails on the first denied claim', () => {
  const checks = [
    { claim: 'claim one', verdict: 'yes', evidence: 'seen in turn 1' },
    { claim: 'claim two', verdict: 'no', evidence: 'turn 2 used a different path' },
    { claim: 'claim three', verdict: 'unknown', evidence: 'not present' },
  ];

  const result = aggregateChecks(checks);

  assert.equal(result.outcome, 'fail');
  assert.equal(result.evidence, 'failed claim: claim two; turn 2 used a different path');
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(checks.map(c => c.claim), ['claim one', 'claim two', 'claim three']);
});

test('passes with unknown claims as warnings', () => {
  const result = aggregateChecks([
    { claim: 'claim one', verdict: 'yes', evidence: 'seen in turn 1' },
    { claim: 'claim two', verdict: 'unknown', evidence: 'not recorded' },
  ]);

  assert.equal(result.outcome, 'pass');
  assert.equal(result.evidence, 'verified 1 of 2 claims; 1 unverified');
  assert.deepEqual(result.warnings, ['unverified claim: claim two']);
});

test('falls back to single-call verification with mode and warning when decomposition is not JSON', async () => {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage('I would split this into claims.'),
    fauxAssistantMessage('Still not JSON.'),
    fauxAssistantMessage('{"outcome":"pass","evidence":"The final snapshot shows Done."}'),
  ]);

  try {
    const result = await verify('confirm done', { action: 'done' }, [], 'https://example.test', 'Done', faux.getModel(), async () => ({}));

    assert.equal(result.outcome, 'pass');
    assert.equal(result.verifierMode, 'single');
    assert.deepEqual(result.checks, []);
    assert.match(result.warnings[0], /^verifier: claim decomposition failed, fell back to single-call verification: no JSON in verifier decomposition:/);
  } finally {
    faux.unregister();
  }
});

test('records checks mode when claim-based verification completes', async () => {
  const faux = registerFauxProvider();
  let checkContext = '';
  faux.setResponses([
    fauxAssistantMessage('{"claims":["the final snapshot shows Done"]}'),
    context => {
      checkContext = JSON.stringify(context);
      return fauxAssistantMessage('{"verdict":"yes","evidence":"The final snapshot contains Done."}');
    },
    fauxAssistantMessage('{"humanEvidence":"The run passed because the final page shows Done."}'),
  ]);

  try {
    const history = [{
      action: { action: 'click', ref: 'e23', reason: 'Click ref e23' },
      target: 'button "Done"',
      locator: { playwright: 'page.getByRole("button", { name: "Done", exact: true })', css: '#done', frameUrl: null },
      error: 'ref e23 was briefly covered',
    }];
    const result = await verify('confirm done', { action: 'done' }, history, 'https://example.test', 'Done', faux.getModel(), async () => ({}));

    assert.equal(result.outcome, 'pass');
    assert.equal(result.verifierMode, 'checks');
    assert.equal(result.evidence, 'verified all 1 claims');
    assert.equal(result.humanEvidence, 'The run passed because the final page shows Done.');
    assert.deepEqual(result.checks, [
      { claim: 'the final snapshot shows Done', verdict: 'yes', evidence: 'The final snapshot contains Done.' },
    ]);
    assert.match(checkContext, /button \\"Done\\"/);
    assert.match(checkContext, /getByRole/);
    assert.doesNotMatch(checkContext, /\be23\b/);
  } finally {
    faux.unregister();
  }
});

test('keeps aggregate evidence when human summary fails', async () => {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage('{"claims":["the final snapshot shows Done"]}'),
    fauxAssistantMessage('{"verdict":"yes","evidence":"The final snapshot contains Done."}'),
    fauxAssistantMessage('not JSON'),
    fauxAssistantMessage('still not JSON'),
  ]);

  try {
    const result = await verify('confirm done', { action: 'done' }, [], 'https://example.test', 'Done', faux.getModel(), async () => ({}));

    assert.equal(result.outcome, 'pass');
    assert.equal(result.evidence, 'verified all 1 claims');
    assert.equal(result.humanEvidence, 'verified all 1 claims');
    assert.match(result.warnings[0], /^verifier human summary unavailable: no JSON in verifier human summary:/);
    assert.deepEqual(result.checks, [
      { claim: 'the final snapshot shows Done', verdict: 'yes', evidence: 'The final snapshot contains Done.' },
    ]);
  } finally {
    faux.unregister();
  }
});
