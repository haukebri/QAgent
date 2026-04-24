const ACTION_TIMEOUT_MS = 10000;
const NAVIGATE_TIMEOUT_MS = 15000;

export async function click(page, ref) {
  await page.locator(`aria-ref=${ref}`).click({ timeout: ACTION_TIMEOUT_MS });
}

export async function fill(page, ref, value) {
  await page.locator(`aria-ref=${ref}`).fill(value, { timeout: ACTION_TIMEOUT_MS });
}

// waitUntil: 'networkidle' is deliberate — it catches SPA route transitions where
// the URL changes but no full page load fires. Do NOT downgrade to 'domcontentloaded'.
// The explicit timeout bounds the wait so pages with constant background traffic
// (google.com, ads, analytics) fail fast instead of hanging; executor catches that.
export async function navigate(page, url) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: NAVIGATE_TIMEOUT_MS });
}
