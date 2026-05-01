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

// One-shot snapshot. The post-action settle loop in observe-settle.js subsumes
// the previous networkidle wait by polling observe() until URL + normalized
// snapshot are stable, which is a stricter signal than network state.
export async function observe(page) {
  return await page.locator('body').ariaSnapshot({ mode: 'ai' });
}

// Diagnose why a click failed. Returns one of:
//   { kind: 'hidden', detail: '0×0' | 'offscreen' }   — element exists but isn't clickable as designed
//   { kind: 'overlay', detail: 'p.typo' }             — element is visible but obscured by something on top
//   null                                              — neither; let the raw Playwright error surface
// The kinds are distinct because they need different LLM hints: "hidden" means
// the wrapper is the real target (label/card pattern); "overlay" means dismiss
// the modal/banner first.
async function diagnoseClickFailure(locator) {
  try {
    return await locator.evaluate(el => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return { kind: 'hidden', detail: '0×0' };
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      if (cx < 0 || cy < 0 || cx >= window.innerWidth || cy >= window.innerHeight) {
        return { kind: 'hidden', detail: 'offscreen' };
      }

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
      return { kind: 'overlay', detail: `${report.tagName.toLowerCase()}${id}${cls}` };
    });
  } catch {
    return null;
  }
}

// Styled-radio / styled-checkbox pattern: native input is hidden (0×0 or
// pointer-events:none), the visible thing is a wrapper card. When click on
// the input fails, walk up the DOM to the first clickable ancestor and click
// that instead. Priority: <label> → role-based → onclick → cursor:pointer.
// Restricted to radio/checkbox so we don't fire wrong handlers when an
// arbitrary disabled control fails.
async function tryClickClickableAncestor(locator, actionTimeoutMs) {
  try {
    const isFormControl = await locator.evaluate(el => {
      if (el.tagName !== 'INPUT') return false;
      return el.type === 'checkbox' || el.type === 'radio';
    });
    if (!isFormControl) return false;
    const handle = await locator.evaluateHandle(el => {
      let node = el.parentElement;
      while (node && node !== document.body) {
        const r = node.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          const cs = window.getComputedStyle(node);
          if (cs.visibility !== 'hidden' && cs.display !== 'none') {
            const role = node.getAttribute('role');
            if (
              node.tagName === 'LABEL' ||
              role === 'button' || role === 'link' ||
              role === 'radio' || role === 'checkbox' ||
              node.onclick !== null ||
              cs.cursor === 'pointer'
            ) {
              return node;
            }
          }
        }
        node = node.parentElement;
      }
      return null;
    });
    const elementHandle = handle.asElement();
    if (!elementHandle) {
      await handle.dispose();
      return false;
    }
    try {
      await elementHandle.click({ timeout: actionTimeoutMs });
      return true;
    } finally {
      await elementHandle.dispose().catch(() => {});
    }
  } catch {
    return false;
  }
}

async function actOrDescribe(locator, verb, action, actionTimeoutMs) {
  try {
    await action();
    return null;
  } catch (err) {
    if (verb === 'click') {
      const diag = await diagnoseClickFailure(locator);
      if (diag && (diag.kind === 'hidden' || diag.kind === 'overlay')) {
        if (await tryClickClickableAncestor(locator, actionTimeoutMs)) {
          return 'ancestor';
        }
      }
      if (diag?.kind === 'hidden') {
        throw new Error(`click target is hidden (${diag.detail}); no clickable ancestor found`);
      }
      if (diag?.kind === 'overlay') {
        throw new Error(`click blocked by overlay: ${diag.detail}`);
      }
      throw err;
    }
    // Non-click verbs keep the original overlay-only behavior.
    const diag = await diagnoseClickFailure(locator);
    if (diag?.kind === 'overlay') {
      throw new Error(`${verb} blocked by overlay: ${diag.detail}`);
    }
    throw err;
  }
}

export async function click(page, ref, actionTimeoutMs) {
  const locator = page.locator(`aria-ref=${ref}`);
  return await actOrDescribe(locator, 'click', () => locator.click({ timeout: actionTimeoutMs }), actionTimeoutMs);
}

export async function fill(page, ref, value, actionTimeoutMs) {
  const locator = page.locator(`aria-ref=${ref}`);
  return await actOrDescribe(locator, 'fill', () => locator.fill(value, { timeout: actionTimeoutMs }), actionTimeoutMs);
}

export async function selectOption(page, ref, value, actionTimeoutMs) {
  const locator = page.locator(`aria-ref=${ref}`);
  return await actOrDescribe(locator, 'selectOption', () => locator.selectOption(value, { timeout: actionTimeoutMs }), actionTimeoutMs);
}

// Ref-less form sends the keystroke to whatever currently has focus — Playwright
// routes it through the page; modal libraries typically listen at document
// level so Escape closes them even without an explicit target. Ref-less skips
// actOrDescribe because there is no locator to introspect for blocker context;
// the Playwright error from page.keyboard.press surfaces unwrapped to the LLM.
export async function pressKey(page, ref, key, actionTimeoutMs) {
  if (ref) {
    const locator = page.locator(`aria-ref=${ref}`);
    return await actOrDescribe(locator, 'pressKey', () => locator.press(key, { timeout: actionTimeoutMs }), actionTimeoutMs);
  }
  await page.keyboard.press(key);
  return null;
}

// pressSequentially appends — it does NOT clear the existing value. Used as a
// fallback when fill() silently fails on React-controlled / masked inputs,
// where the field is empty anyway, so the missing clear is fine.
export async function type(page, ref, value, actionTimeoutMs) {
  const locator = page.locator(`aria-ref=${ref}`);
  return await actOrDescribe(locator, 'type', () => locator.pressSequentially(value, { timeout: actionTimeoutMs }), actionTimeoutMs);
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
