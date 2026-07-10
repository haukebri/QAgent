import assert from 'node:assert/strict';
import test from 'node:test';
import { goBack } from '../src/tools.js';

test('goBack waits for page load', async () => {
  const calls = [];
  const page = {
    url: () => 'https://example.test/one',
    locator: () => ({ ariaSnapshot: async () => '- text "one"' }),
    goBack: async (options) => {
      calls.push(options);
      return {};
    },
  };

  assert.equal(await goBack(page), null);
  assert.deepEqual(calls, [{ waitUntil: 'load' }]);
});

test('goBack reports no browser history', async () => {
  const page = {
    url: () => 'https://example.test/one',
    locator: () => ({ ariaSnapshot: async () => '- text "one"' }),
    goBack: async () => null,
  };

  await assert.rejects(() => goBack(page), /goBack had no effect/);
});

test('goBack accepts same-document history moves', async () => {
  let url = 'https://example.test/two';
  const page = {
    url: () => url,
    locator: () => ({ ariaSnapshot: async () => '- text "one"' }),
    goBack: async () => {
      url = 'https://example.test/one';
      return null;
    },
  };

  await assert.doesNotReject(() => goBack(page));
});
