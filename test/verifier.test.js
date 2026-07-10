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
  faux.setResponses([
    fauxAssistantMessage('{"claims":["the final snapshot shows Done"]}'),
    fauxAssistantMessage('{"verdict":"yes","evidence":"The final snapshot contains Done."}'),
  ]);

  try {
    const result = await verify('confirm done', { action: 'done' }, [], 'https://example.test', 'Done', faux.getModel(), async () => ({}));

    assert.equal(result.outcome, 'pass');
    assert.equal(result.verifierMode, 'checks');
    assert.deepEqual(result.checks, [
      { claim: 'the final snapshot shows Done', verdict: 'yes', evidence: 'The final snapshot contains Done.' },
    ]);
  } finally {
    faux.unregister();
  }
});
