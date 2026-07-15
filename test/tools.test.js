import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { click, goBack, inspectTarget } from '../src/tools.js';

test('describes targets with semantic and stable locators', async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <form aria-label="Checkout">
        <button id="submit" data-testid="submit-order">Submit order</button>
        <button>Continue</button><button>Continue</button>
        <label>Email <input name="email"></label>
      </form>
    `);
    const snapshot = await page.locator('body').ariaSnapshot({ mode: 'ai' });
    const refFor = name => snapshot.match(new RegExp(`(?:button|textbox) "${name}" \\[ref=(e\\d+)\\]`))?.[1];

    assert.deepEqual(await inspectTarget(page, refFor('Submit order'), snapshot), {
      target: 'button "Submit order" in form "Checkout"',
      locator: {
        playwright: 'page.getByRole("button", { name: "Submit order", exact: true })',
        css: '[data-testid="submit-order"]',
        frameUrl: null,
      },
    });
    assert.deepEqual(await inspectTarget(page, refFor('Email'), snapshot), {
      target: 'textbox "Email" in form "Checkout"',
      locator: {
        playwright: 'page.getByRole("textbox", { name: "Email", exact: true })',
        css: 'input[name="email"]',
        frameUrl: null,
      },
      nativeState: {
        before: { type: 'text', name: 'email', value: '', checked: false, selected: null, disabled: false, inputValue: '' },
        after: null,
      },
    });
    const continueRef = refFor('Continue');
    assert.deepEqual(await inspectTarget(page, continueRef, snapshot), {
      target: 'button "Continue" in form "Checkout"',
      locator: { playwright: null, css: null, frameUrl: null },
    });
    await page.setContent('<iframe></iframe>');
    await page.frames()[1].setContent('<button id="pay">Pay now</button>');
    const frameSnapshot = await page.locator('body').ariaSnapshot({ mode: 'ai' });
    const frameRef = frameSnapshot.match(/button "Pay now" \[ref=((?:f\d+)?e\d+)\]/)?.[1];
    assert.deepEqual(await inspectTarget(page, frameRef, frameSnapshot), {
      target: 'button "Pay now"',
      locator: {
        playwright: 'frame.getByRole("button", { name: "Pay now", exact: true })',
        css: '#pay',
        frameUrl: 'about:blank',
      },
    });
  } finally {
    await browser.close();
  }
});

test('distinguishes repeated labels by their nearest accessible group', async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <fieldset><legend>Work pattern</legend><label><input type="radio" name="work"> Same</label></fieldset>
      <div role="radiogroup" aria-label="Travel pattern"><label><input type="radio" name="travel"> Same</label></div>
      <section><h2>Decorative heading</h2><button>Loose</button></section>
    `);
    const snapshot = await page.locator('body').ariaSnapshot({ mode: 'ai' });
    const refs = [...snapshot.matchAll(/radio "Same" \[ref=(e\d+)\]/g)].map(match => match[1]);
    assert.match((await inspectTarget(page, refs[0], snapshot)).target, /in fieldset "Work pattern"$/);
    assert.match((await inspectTarget(page, refs[1], snapshot)).target, /in radiogroup "Travel pattern"$/);
    const looseRef = snapshot.match(/button "Loose" \[ref=(e\d+)\]/)?.[1];
    assert.equal((await inspectTarget(page, looseRef, snapshot)).target, 'button "Loose" in section "Decorative heading"');
  } finally {
    await browser.close();
  }
});

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
