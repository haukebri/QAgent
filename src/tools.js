// Short actionability timeout — Playwright's own check (visible, stable,
// receives events, enabled) doubles as our blocked-click detector. 1.5s is
// enough to let transient states (animations, fade-outs) settle without
// burning turns when an overlay genuinely won't move.
const ACTION_TIMEOUT_MS = 1500;
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

// When an action fails, name the element that was on top at the target's
// centre so the LLM can pattern-match the blocker (#usercentrics-root,
// #onetrust-banner-sdk, newsletter modals, ad overlays, …) and react
// accordingly. Pierces shadow DOM so buttons inside consent banners are
// traced back to their recognizable host in the main document.
async function describeBlocker(locator) {
  try {
    return await locator.evaluate(el => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      if (cx < 0 || cy < 0 || cx >= window.innerWidth || cy >= window.innerHeight) return null;

      let top = document.elementFromPoint(cx, cy);
      while (top && top.shadowRoot) {
        const inner = top.shadowRoot.elementFromPoint(cx, cy);
        if (!inner || inner === top) break;
        top = inner;
      }
      if (!top) return null;

      for (let node = top; node; ) {
        if (node === el) return null;
        if (node.parentNode) node = node.parentNode;
        else if (node instanceof ShadowRoot) node = node.host;
        else break;
      }

      let report = top;
      while (true) {
        const rootNode = report.getRootNode();
        if (rootNode === document || !rootNode.host) break;
        report = rootNode.host;
      }
      const id = report.id ? `#${report.id}` : '';
      const cls =
        typeof report.className === 'string' && report.className.trim()
          ? '.' + report.className.trim().split(/\s+/)[0]
          : '';
      return `${report.tagName.toLowerCase()}${id}${cls}`;
    });
  } catch {
    return null;
  }
}

async function actOrDescribe(locator, verb, action) {
  try {
    await action();
  } catch (err) {
    const blocker = await describeBlocker(locator);
    if (blocker) throw new Error(`${verb} blocked by overlay: ${blocker}`);
    throw err;
  }
}

export async function click(page, ref) {
  const locator = page.locator(`aria-ref=${ref}`);
  await actOrDescribe(locator, 'click', () => locator.click({ timeout: ACTION_TIMEOUT_MS }));
}

export async function fill(page, ref, value) {
  const locator = page.locator(`aria-ref=${ref}`);
  await actOrDescribe(locator, 'fill', () => locator.fill(value, { timeout: ACTION_TIMEOUT_MS }));
}

// waitUntil: 'networkidle' is deliberate — it catches SPA route transitions where
// the URL changes but no full page load fires. Do NOT downgrade to 'domcontentloaded'.
// The explicit timeout bounds the wait so pages with constant background traffic
// (google.com, ads, analytics) fail fast instead of hanging; executor catches that.
export async function navigate(page, url) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: NAVIGATE_TIMEOUT_MS });
}
