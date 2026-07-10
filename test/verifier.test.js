import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateChecks } from '../src/verifier.js';

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
