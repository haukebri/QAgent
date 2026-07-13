import assert from 'node:assert/strict';
import test from 'node:test';
import { selectReporters } from '../src/reporters.js';

test('list reporter prints human evidence when available', async () => {
  const [reporter] = selectReporters(['list']);
  const writes = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };

  try {
    reporter.onEnd({
      outcome: 'pass',
      evidence: 'verified all 1 claims',
      humanEvidence: 'The run passed because the final page shows Done.',
      turns: 1,
      elapsedMs: 1000,
      tokens: null,
      verifierTokens: null,
      warnings: [],
    });
  } finally {
    process.stdout.write = originalWrite;
  }

  const output = writes.join('');
  assert.match(output, /The run passed because the final page shows Done\./);
  assert.doesNotMatch(output, /verified all 1 claims/);
});
