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

test('waits through a delayed departure and returns the stable new state', async () => {
  const oldState = '- main [ref=e1]:\n  - heading "Step one" [ref=e2]\n';
  const newState = '- main [ref=e1]:\n  - heading "Step two" [ref=e2]\n';
  const snapshots = [oldState, oldState, oldState, newState, newState];
  let calls = 0;
  const page = {
    url: () => 'https://example.test/wizard',
    locator: () => ({ ariaSnapshot: async () => snapshots[Math.min(calls++, snapshots.length - 1)] }),
  };

  const result = await observeWithSettle(page, {
    previousSnapshot: oldState,
    previousUrl: 'https://example.test/wizard',
  }, { pollMs: 1, changeGraceMs: 20, maxSettleMs: 100 });

  assert.equal(result.snapshot, newState);
  assert.equal(result.settleReason, 'changed');
});

test('returns bounded no-change and timeout reasons', async () => {
  const unchanged = '- checkbox "Choice" [ref=e1]';
  const staticPage = {
    url: () => 'https://example.test',
    locator: () => ({ ariaSnapshot: async () => unchanged }),
  };
  const noChange = await observeWithSettle(staticPage, {
    previousSnapshot: unchanged,
    previousUrl: 'https://example.test',
  }, { pollMs: 1, changeGraceMs: 3, maxSettleMs: 20 });
  assert.equal(noChange.settleReason, 'no-change');

  let value = 0;
  const movingPage = {
    url: () => 'https://example.test',
    locator: () => ({ ariaSnapshot: async () => `- status "${value++}" [ref=e1]` }),
  };
  const timeout = await observeWithSettle(movingPage, {
    previousSnapshot: '- status "start" [ref=e1]',
    previousUrl: 'https://example.test',
  }, { pollMs: 1, changeGraceMs: 3, maxSettleMs: 10 });
  assert.equal(timeout.settleReason, 'timeout');
  assert.equal(timeout.settled, false);
});
