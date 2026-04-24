import { chromium } from 'playwright';

const url = process.argv[2];
if (!url) {
  console.error('usage: node src/observe.js <url>');
  process.exit(1);
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'networkidle' });
  const tree = await page.locator('body').ariaSnapshot();
  console.log(tree);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
