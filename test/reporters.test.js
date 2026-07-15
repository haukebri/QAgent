import assert from 'node:assert/strict';
import test from 'node:test';
import { selectReporters } from '../src/reporters.js';

test('list reporter prints verifier evidence', async () => {
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
      evidence: 'The final page shows Done.',
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
  assert.match(output, /The final page shows Done\./);
});

test('list reporter prints semantic targets without accessibility refs', () => {
  const [reporter] = selectReporters(['list']);
  const writes = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = chunk => { writes.push(String(chunk)); return true; };

  try {
    reporter.onTurn({
      turn: 1,
      atMs: 100,
      action: { action: 'selectOption', value: 'Premium' },
      target: 'combobox "Tariff" in form "Booking"',
      locator: { playwright: 'page.getByRole("combobox", { name: "Tariff", exact: true })', css: '#tariff', frameUrl: null },
      url: 'https://example.test',
    });
  } finally {
    process.stdout.write = originalWrite;
  }

  const output = writes.join('');
  assert.match(output, /selectOption\s+combobox "Tariff" in form "Booking" = "Premium"/);
  assert.doesNotMatch(output, /\be\d+\b/);
  assert.doesNotMatch(output, /getByRole|#tariff/);
});
