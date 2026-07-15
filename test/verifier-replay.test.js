import assert from 'node:assert/strict';
import test from 'node:test';
import { corpus, summarize } from '../scripts/verifier-replay.js';

test('frozen verifier replay contains six outcome-labeled browser artifacts', () => {
  assert.equal(corpus.length, 6);
  assert.ok(corpus.every(fixture => ['pass', 'fail'].includes(fixture.expectedOutcome)));
  assert.equal(corpus.filter(fixture => fixture.expectedOutcome === 'pass').length, 3);
  assert.equal(corpus.filter(fixture => fixture.expectedOutcome === 'fail').length, 3);
  assert.ok(corpus.some(fixture => fixture.history.some(step => step.observation?.addedText)));
});

test('summary reports only outcome confusion, errors, tokens, cost, and latency', () => {
  const summary = summarize([
    { expectedOutcome: 'pass', outcome: 'pass', tokens: { totalTokens: 2, cost: 0.1 }, latencyMs: 3 },
    { expectedOutcome: 'fail', outcome: 'fail', tokens: { totalTokens: 4, cost: 0.2 }, latencyMs: 5 },
    { expectedOutcome: 'fail', outcome: 'pass', tokens: { totalTokens: 6, cost: 0.3 }, latencyMs: 7 },
    { expectedOutcome: 'pass', outcome: 'fail', tokens: { totalTokens: 8, cost: 0.4 }, latencyMs: 11 },
    { expectedOutcome: 'pass', outcome: 'error', tokens: { totalTokens: 10, cost: 0.5 }, latencyMs: 13 },
  ]);
  assert.deepEqual(summary, {
    correctPass: 1, correctFail: 1, falsePass: 1, falseFail: 1, verifierErrors: 1, verifierCalls: 0,
    tokens: 30, cost: 1.5, latencyMs: 39,
  });
});
