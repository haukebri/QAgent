import assert from 'node:assert/strict';
import test from 'node:test';
import { corpus, summarize } from '../scripts/verifier-replay.js';

test('frozen verifier replay covers every observed failure class and scores errors separately', () => {
  assert.equal(new Set(corpus.map(fixture => fixture.failureClass)).size, 8);
  assert.ok(corpus.every(fixture => ['pass', 'fail'].includes(fixture.browserTruth)));
  assert.ok(corpus.every(fixture => ['yes', 'no', 'unknown'].includes(fixture.evidenceTruth)));

  const summary = summarize([
    { browserTruth: 'pass', evidenceTruth: 'yes', outcome: 'fail', checks: [{ verdict: 'no' }], warnings: [], tokens: { totalTokens: 2, cost: 0.1 }, latencyMs: 3 },
    { browserTruth: 'pass', evidenceTruth: 'unknown', outcome: 'pass', checks: [], warnings: ['verifier: claim decomposition failed'], tokens: { totalTokens: 4, cost: 0.2 }, latencyMs: 5 },
    { browserTruth: 'fail', evidenceTruth: 'no', outcome: 'error', checks: [], warnings: [], tokens: { totalTokens: 6, cost: 0.3 }, latencyMs: 7 },
    { browserTruth: 'pass', evidenceTruth: 'unknown', outcome: 'fail', checks: [{ verdict: 'unknown' }], warnings: [], tokens: { totalTokens: 8, cost: 0.4 }, latencyMs: 11 },
  ]);
  assert.deepEqual(summary, {
    cases: 4, browserTruthPasses: 3, evidenceCoverage: '2/4', correctVerdicts: 1,
    falsePasses: 1, falseFailures: 1, correctUnknowns: 1, unknownAccuracy: '1/2', decompositionErrors: 1,
    verifierErrors: 1, tokens: 20, cost: 1, latencyMs: 26,
  });
});
