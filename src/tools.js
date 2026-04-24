export async function click(page, ref) {
  await page.locator(`aria-ref=${ref}`).click();
}

export async function fill(page, ref, value) {
  await page.locator(`aria-ref=${ref}`).fill(value);
}

export async function navigate(page, url) {
  await page.goto(url, { waitUntil: 'networkidle' });
}
