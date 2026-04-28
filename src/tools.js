// All timeouts here are caller-supplied (ms). The CLI parses --action-timeout
// and --network-timeout (in seconds) and threads them through executor.js.
//
// Action timeout (~2s) doubles as our blocked-click detector — Playwright's
// own actionability check (visible, stable, receives events, enabled) is short
// enough that an overlay-blocked element fails fast instead of burning turns,
// long enough to let transient states (animations, fade-outs) settle.
//
// Network timeout (~30s) bounds page.goto(). We use waitUntil: 'load' (not
// 'networkidle' — Playwright discourages it; chatty real-world pages with
// analytics/polling rarely settle). page.goto() throws are *fatal*:
// executor.js escalates to fatalError, ending the run with outcome 'error'
// and exit code 3 (review-followups.md #8).

// Brief soft-fail networkidle wait lets SPA route transitions settle before we
// snapshot. 2s cap is intentional: on chatty pages networkidle never fires; on
// quiet pages it lands in <1s. Beyond that we snapshot anyway and let the LLM
// iterate. Internal-only — not user-tunable.
export async function observe(page) {
  try {
    await page.waitForLoadState('networkidle', { timeout: 2000 });
  } catch {}
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

// waitUntil: 'load' (not 'networkidle' — Playwright discourages it; chatty
// pages with analytics/polling rarely settle). 'load' fires when the doc and
// its sub-resources are loaded; observe() then does a brief networkidle wait
// before snapshotting, which absorbs SPA hydration. Any throw here (timeout,
// DNS, SSL, bad URL) is fatal — executor.js routes it to fatalError, ending
// the run with outcome 'error' and exit code 3 (review-followups.md #8).
export async function navigate(page, url, networkTimeoutMs) {
  await page.goto(url, { waitUntil: 'load', timeout: networkTimeoutMs });
}
