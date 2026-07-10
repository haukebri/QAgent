import assert from 'node:assert/strict';
import test from 'node:test';
import { observeWithSettle } from '../src/observe-settle.js';

test('loading snapshots do not count toward settle streak', async () => {
  const busy = `- main [ref=e1]:
  - text "Loading" [ref=e2]
`;
  const loaded = `- main [ref=e1]:
  - text "Produkt gefunden" [ref=e2]
`;
  const snapshots = [busy, busy, loaded];
  let calls = 0;
  const page = {
    url: () => 'https://example.test',
    locator: (selector) => {
      assert.equal(selector, 'body');
      return {
        ariaSnapshot: async () => snapshots[Math.min(calls++, snapshots.length - 1)],
      };
    },
  };

  const result = await observeWithSettle(page, null, { pollMs: 0, maxSettleMs: 1000 });

  assert.equal(result.settled, true);
  assert.equal(result.snapshot, loaded);
  assert.equal(calls, 4);
});

test('busy settle timeout does not wait a full poll interval', async () => {
  const busy = `- main [ref=e1]:
  - text "Loading" [ref=e2]
`;
  const page = {
    url: () => 'https://example.test',
    locator: () => ({ ariaSnapshot: async () => busy }),
  };

  const t0 = Date.now();
  const result = await observeWithSettle(page, null, { pollMs: 1000, maxSettleMs: 20 });

  assert.equal(result.settled, false);
  assert.ok(Date.now() - t0 < 500);
});

test('transient observation failure during navigation keeps polling', async () => {
  const list = `- main [ref=e1]:
  - link "Product teaser" [ref=e2]
`;
  const product = `- main [ref=e1]:
  - heading "New product page" [ref=e2]
`;
  let calls = 0;
  const page = {
    url: () => calls >= 2 ? 'https://example.test/product' : 'https://example.test/list',
    locator: () => ({
      ariaSnapshot: async () => {
        const call = calls++;
        if (call === 1) throw new Error('execution context destroyed');
        return call >= 2 ? product : list;
      },
    }),
  };

  const result = await observeWithSettle(page, {
    previousSnapshot: list,
    previousUrl: 'https://example.test/list',
  }, { pollMs: 0, maxSettleMs: 1000 });

  assert.equal(result.settled, true);
  assert.equal(result.snapshot, product);
  assert.equal(result.url, 'https://example.test/product');
  assert.deepEqual(result.addedText, ['New product page']);
});
