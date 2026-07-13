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

test('click accepts cookies and retries an overlay-blocked target', async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <button id="target" style="position:absolute;left:20px;top:20px;width:120px;height:40px">Target</button>
      <div id="overlay" class="modal" style="position:fixed;inset:0;background:white">
        <button onclick="window.choice='reject';overlay.remove()">Reject all</button>
        <button onclick="window.choice='accept';overlay.remove()">Accept all</button>
      </div>
      <script>target.onclick = () => window.clicked = true</script>
    `);
    const snapshot = await page.locator('body').ariaSnapshot({ mode: 'ai' });
    const ref = snapshot.match(/button "Target" \[ref=(e\d+)\]/)?.[1];
    assert.ok(ref);

    assert.equal(await click(page, ref, 100), 'overlay');
    assert.equal(await page.evaluate(() => window.choice), 'accept');
    assert.equal(await page.evaluate(() => window.clicked), true);
  } finally {
    await browser.close();
  }
});

test('click dismisses an overlay button inside an iframe', async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <button id="target" style="position:absolute;left:20px;top:20px;width:120px;height:40px">Target</button>
      <iframe style="position:fixed;inset:0;width:100%;height:100%;border:0"></iframe>
      <script>target.onclick = () => window.clicked = true</script>
    `);
    await page.frames()[1].setContent(`
      <button onclick="parent.choice='accept';parent.document.querySelector('iframe').remove()">Accept all</button>
    `);
    const snapshot = await page.locator('body').ariaSnapshot({ mode: 'ai' });
    const ref = snapshot.match(/button "Target" \[ref=(e\d+)\]/)?.[1];
    assert.ok(ref);

    assert.equal(await click(page, ref, 100), 'overlay');
    assert.equal(await page.evaluate(() => window.choice), 'accept');
    assert.equal(await page.evaluate(() => window.clicked), true);
  } finally {
    await browser.close();
  }
});

test('click uses Escape when an overlay has no known dismissal button', async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <button id="target" style="position:absolute;left:20px;top:20px;width:120px;height:40px">Target</button>
      <div id="overlay" style="position:fixed;inset:0;background:white">Modal</div>
      <script>
        target.onclick = () => window.clicked = true;
        document.addEventListener('keydown', event => {
          if (event.key === 'Escape') overlay.remove();
        });
      </script>
    `);
    const snapshot = await page.locator('body').ariaSnapshot({ mode: 'ai' });
    const ref = snapshot.match(/button "Target" \[ref=(e\d+)\]/)?.[1];
    assert.ok(ref);

    assert.equal(await click(page, ref, 100), 'overlay');
    assert.equal(await page.evaluate(() => window.clicked), true);
  } finally {
    await browser.close();
  }
});

test('click preserves the overlay diagnostic when cleanup fails', async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <button style="position:absolute;left:20px;top:20px;width:120px;height:40px">Target</button>
      <div id="overlay" class="modal" style="position:fixed;inset:0;background:white">
        <h2>Kabinen</h2>
        <button>Details</button>
      </div>
    `);
    const snapshot = await page.locator('body').ariaSnapshot({ mode: 'ai' });
    const ref = snapshot.match(/button "Target" \[ref=(e\d+)\]/)?.[1];
    assert.ok(ref);

    await assert.rejects(
      () => click(page, ref, 100),
      /click blocked by overlay "Kabinen Details" \(buttons: "Details"\) \[div#overlay\.modal\]\. Interact with the overlay first/,
    );
  } finally {
    await browser.close();
  }
});
