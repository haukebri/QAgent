import assert from 'node:assert/strict';
import test from 'node:test';
import { fauxAssistantMessage, registerFauxProvider } from '@earendil-works/pi-ai';
import { verify } from '../src/verifier.js';

async function withVerifier(responses, fn) {
  const faux = registerFauxProvider();
  faux.setResponses(responses);
  try { return await fn(faux); } finally { faux.unregister(); }
}

test('makes one call and returns only the outcome judgment', async () => {
  let calls = 0;
  await withVerifier([context => {
    calls++;
    const text = JSON.stringify(context);
    assert.match(text, /Goal:\\nDone is visible/);
    assert.match(text, /Frozen final snapshot:\\n- heading \\"Done/);
    assert.doesNotMatch(text, /claim|binding goal|evidenceId/iu);
    return fauxAssistantMessage('{"outcome":"pass","evidence":"The final page shows Done."}');
  }], async faux => {
    const result = await verify('Done is visible', { action: 'done' }, [], 'https://example.test', '- heading "Done"', faux.getModel(), async () => ({}));
    assert.equal(calls, 1);
    assert.deepEqual(Object.keys(result).sort(), ['evidence', 'failureKind', 'outcome', 'tokens']);
    assert.equal(result.outcome, 'pass');
  });
});

test('the frozen state overrides the driver terminal response', async () => {
  for (const [driver, snapshot, judged] of [
    [{ action: 'fail', reason: 'unsure' }, '- heading "Complete"', 'pass'],
    [{ action: 'done', summary: 'complete' }, '- button "Submit"', 'fail'],
  ]) {
    await withVerifier([fauxAssistantMessage(`{"outcome":"${judged}","evidence":"Decisive final state."}`)], async faux => {
      const result = await verify('Submit the form', driver, [], 'https://example.test', snapshot, faux.getModel(), async () => ({}));
      assert.equal(result.outcome, judged);
    });
  }
});

test('explicit route and transient outcomes are available in compact history', async () => {
  await withVerifier([context => {
    const text = JSON.stringify(context);
    assert.match(text, /Add to cart/);
    assert.match(text, /Cart opened/);
    return fauxAssistantMessage('{"outcome":"pass","evidence":"The successful cart action recorded the transient confirmation."}');
  }], async faux => {
    const history = [{
      action: { action: 'click', ref: 'e2', reason: 'route detail' }, target: 'button "Add to cart"',
      url: 'https://example.test/cart', success: true, observation: { visibleTextAdded: ['Cart opened'], addedRefs: ['e3'] },
    }];
    const result = await verify('Add via the product button and observe confirmation', { action: 'done' }, history, 'https://example.test/cart', '- heading "Cart"', faux.getModel(), async () => ({}));
    assert.equal(result.outcome, 'pass');
  });
});

test('retries malformed output once and preserves token totals', async () => {
  await withVerifier([
    fauxAssistantMessage('not json', { usage: { input: 2, output: 1, totalTokens: 3 } }),
    fauxAssistantMessage('prefix {"outcome":"pass","evidence":"Ready is visible."} suffix', { usage: { input: 4, output: 2, totalTokens: 6 } }),
  ], async faux => {
    const result = await verify('Ready', { action: 'done' }, [], 'https://example.test', 'Ready', faux.getModel(), async () => ({}));
    assert.equal(result.outcome, 'pass');
    assert.ok(result.tokens.totalTokens > 0);
  });
});

test('two invalid responses are a verifier error', async () => {
  await withVerifier([fauxAssistantMessage('no'), fauxAssistantMessage('{"outcome":"maybe","evidence":"x"}')], async faux => {
    await assert.rejects(
      () => verify('Ready', { action: 'done' }, [], 'https://example.test', 'Ready', faux.getModel(), async () => ({})),
      error => error.failureKind === 'verifier' && /failed after retry/.test(error.message),
    );
  });
});
