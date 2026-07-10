import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { click, goBack } from '../src/tools.js';

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

test('click describes overlay content when target is blocked', async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <button style="position:absolute;left:20px;top:20px;width:120px;height:40px">Target</button>
      <div id="overlay" class="modal" style="position:fixed;inset:0;background:white">
        <h2>Kabinen</h2>
        <button aria-label="Schliessen">x</button>
        <a href="#">Details</a>
      </div>
    `);
    const snapshot = await page.locator('body').ariaSnapshot({ mode: 'ai' });
    const ref = snapshot.match(/button "Target" \[ref=(e\d+)\]/)?.[1];
    assert.ok(ref);

    await assert.rejects(
      () => click(page, ref, 100),
      /click blocked by overlay "Kabinen x Details" \(buttons: "Schliessen", "Details"\) \[div#overlay\.modal\]\. Interact with the overlay first/,
    );
  } finally {
    await browser.close();
  }
});
