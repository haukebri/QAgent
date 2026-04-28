// All timeouts here are caller-supplied (ms). The CLI parses --action-timeout
// and --network-timeout (in seconds) and threads them through executor.js.
//
// Action timeout (~2s) doubles as our blocked-click detector — Playwright's
// own actionability check (visible, stable, receives events, enabled) is short
// enough that an overlay-blocked element fails fast instead of burning turns,
// long enough to let transient states (animations, fade-outs) settle.
//
// Network timeout (~30s) covers both page.goto() and post-action networkidle
// waits. The post-action networkidle wait is caught inline in observe() below
// (soft-fail — pages with constant background traffic still get snapshotted).
// page.goto() throws are *fatal*: executor.js escalates to fatalError, ending
// the run with outcome 'error' and exit code 3 (review-followups.md #8).

// waitForLoadState('networkidle') is deliberate — it lets SPA route transitions
// settle before we snapshot, so the LLM sees the post-nav page, not the pre-nav one.
// Do NOT downgrade to 'domcontentloaded'. The bounded timeout + try/catch prevent
// pages with constant background traffic (analytics, polling) from hanging forever.
export async function observe(page, networkTimeoutMs) {
  try {
    await page.waitForLoadState('networkidle', { timeout: networkTimeoutMs });
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

export async function click(page, ref, actionTimeoutMs) {
  const locator = page.locator(`aria-ref=${ref}`);
  await actOrDescribe(locator, 'click', () => locator.click({ timeout: actionTimeoutMs }));
}

export async function fill(page, ref, value, actionTimeoutMs) {
  const locator = page.locator(`aria-ref=${ref}`);
  await actOrDescribe(locator, 'fill', () => locator.fill(value, { timeout: actionTimeoutMs }));
}

// waitUntil: 'networkidle' is deliberate — it catches SPA route transitions where
// the URL changes but no full page load fires. Do NOT downgrade to 'domcontentloaded'.
// The explicit timeout bounds the wait so pages with constant background traffic
// (google.com, ads, analytics) don't hang. Any throw here (timeout, DNS, SSL,
// bad URL) is fatal — executor.js routes it to fatalError, ending the run with
// outcome 'error' and exit code 3 (review-followups.md #8).
export async function navigate(page, url, networkTimeoutMs) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: networkTimeoutMs });
}
