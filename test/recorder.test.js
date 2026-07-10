import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPayload } from '../src/recorder.js';

test('records locale in trace payloads', () => {
  const payload = buildPayload('goal', 'driver', 'verifier', {
    outcome: 'pass',
    llmVerdict: null,
    evidence: 'ok',
    finalUrl: 'https://example.test',
    turns: 0,
    elapsedMs: 0,
    tokens: null,
    verifierTokens: null,
    history: [],
    warnings: [],
  }, 'de-DE');

  assert.equal(payload.locale, 'de-DE');
});
