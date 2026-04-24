import { chromium } from 'playwright';
import { observe } from './observer.js';

const url = process.argv[2];
if (!url) {
  console.error('usage: node src/observe.js <url>');
  process.exit(1);
}

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function launchBrowser() {
  const args = ['--disable-blink-features=AutomationControlled'];
  try {
    return await chromium.launch({ channel: 'chrome', args });
  } catch {
    return await chromium.launch({ args });
  }
}

const browser = await launchBrowser();
try {
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    locale: 'en-US',
    timezoneId: 'Europe/Berlin',
    viewport: { width: 1366, height: 820 },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
  console.log(await observe(page));
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
