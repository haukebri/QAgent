import { chromium } from 'playwright';

// Single source of truth for bot-detection defaults (see
// docs/project-architecture.md "bot-detection escalation"). If a site still
// blocks after this baseline, escalate here: patchright swap, residential
// proxy via chromium.launch({ proxy }), or a CAPTCHA solver.
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export async function launchPage({ httpCredentials, headed = false } = {}) {
  const args = ['--disable-blink-features=AutomationControlled'];
  const headless = !headed;
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', args, headless });
  } catch {
    browser = await chromium.launch({ args, headless });
  }
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    locale: 'en-US',
    timezoneId: 'Europe/Berlin',
    viewport: { width: 1366, height: 820 },
    ...(httpCredentials ? { httpCredentials } : {}),
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  });
  const page = await context.newPage();
  return { browser, page };
}
