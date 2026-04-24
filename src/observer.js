export async function observe(page) {
  await page.waitForLoadState('domcontentloaded');
  return await page.locator('body').ariaSnapshot({ mode: 'ai' });
}
