const ACTION_TIMEOUT_MS = 10000;

export async function click(page, ref) {
  await page.locator(`aria-ref=${ref}`).click({ timeout: ACTION_TIMEOUT_MS });
}

export async function fill(page, ref, value) {
  await page.locator(`aria-ref=${ref}`).fill(value, { timeout: ACTION_TIMEOUT_MS });
}

export async function navigate(page, url) {
  await page.goto(url, { waitUntil: 'networkidle' });
}
