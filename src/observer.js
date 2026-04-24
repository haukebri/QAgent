export async function observe(page) {
  await page.waitForLoadState('networkidle');
  return await page.locator('body').ariaSnapshot({ mode: 'ai' });
}
