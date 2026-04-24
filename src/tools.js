const ACTION_TIMEOUT_MS = 10000;
const NAVIGATE_TIMEOUT_MS = 15000;
const OBSERVE_NETWORKIDLE_TIMEOUT_MS = 5000;

// waitForLoadState('networkidle') is deliberate — it lets SPA route transitions
// settle before we snapshot, so the LLM sees the post-nav page, not the pre-nav one.
// Do NOT downgrade to 'domcontentloaded'. The bounded timeout + try/catch prevent
// pages with constant background traffic (analytics, polling) from hanging forever.
export async function observe(page) {
  try {
    await page.waitForLoadState('networkidle', { timeout: OBSERVE_NETWORKIDLE_TIMEOUT_MS });
  } catch {
    // networkidle never settled (ads, analytics, long-poll) — snapshot anyway
  }
  return await page.locator('body').ariaSnapshot({ mode: 'ai' });
}

// Fast-fail pre-check: without this, a click on an element covered by a cookie
// banner / ad / newsletter modal would wait the full ACTION_TIMEOUT_MS for
// Playwright's actionability poll to give up. Here we scroll the element into
// view and ask `elementFromPoint` at the target's centre. If the topmost
// element at that point isn't the target (or a descendant), the click would
// hit the overlay — we surface that immediately so the executor/LLM can react
// (dismiss the banner, try a different element) instead of burning 10s.
async function describeBlocker(locator) {
  try {
    return await locator.evaluate(el => {
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      if (cx < 0 || cy < 0 || cx >= window.innerWidth || cy >= window.innerHeight) return null;
      const top = document.elementFromPoint(cx, cy);
      if (!top || top === el || el.contains(top)) return null;
      const id = top.id ? `#${top.id}` : '';
      const cls =
        typeof top.className === 'string' && top.className.trim()
          ? '.' + top.className.trim().split(/\s+/)[0]
          : '';
      return `${top.tagName.toLowerCase()}${id}${cls}`;
    });
  } catch {
    // Locator didn't resolve (element removed between observe and act).
    // Fall through; the real action will surface the real error.
    return null;
  }
}

export async function click(page, ref) {
  const locator = page.locator(`aria-ref=${ref}`);
  const blocker = await describeBlocker(locator);
  if (blocker) throw new Error(`click blocked by overlay: ${blocker}`);
  await locator.click({ timeout: ACTION_TIMEOUT_MS });
}

export async function fill(page, ref, value) {
  const locator = page.locator(`aria-ref=${ref}`);
  const blocker = await describeBlocker(locator);
  if (blocker) throw new Error(`fill blocked by overlay: ${blocker}`);
  await locator.fill(value, { timeout: ACTION_TIMEOUT_MS });
}

// waitUntil: 'networkidle' is deliberate — it catches SPA route transitions where
// the URL changes but no full page load fires. Do NOT downgrade to 'domcontentloaded'.
// The explicit timeout bounds the wait so pages with constant background traffic
// (google.com, ads, analytics) fail fast instead of hanging; executor catches that.
export async function navigate(page, url) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: NAVIGATE_TIMEOUT_MS });
}
