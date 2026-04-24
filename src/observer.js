export async function observe(page) {
  return await page.locator('body').ariaSnapshot({ mode: 'ai' });
}
