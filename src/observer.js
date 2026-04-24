// waitForLoadState('networkidle') is deliberate — it lets SPA route transitions
// settle before we snapshot, so the LLM sees the post-nav page, not the pre-nav one.
// Do NOT downgrade to 'domcontentloaded'. The bounded timeout + try/catch prevent
// pages with constant background traffic (analytics, polling) from hanging forever.
export async function observe(page) {
  try {
    await page.waitForLoadState('networkidle', { timeout: 5000 });
  } catch {
    // networkidle never settled (ads, analytics, long-poll) — snapshot anyway
  }
  return await page.locator('body').ariaSnapshot({ mode: 'ai' });
}
