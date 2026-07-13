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

export async function inspectTarget(page, ref, snapshot) {
  if (!ref) return { target: 'element', locator: { playwright: null, css: null, frameUrl: null } };
  const locator = page.locator(`aria-ref=${ref}`);
  const semantic = semanticTarget(snapshot, ref);
  try {
    const dom = await locator.evaluate(el => {
      const clean = (value, max = 120) => (value || '').replace(/\s+/g, ' ').trim().slice(0, max);
      const attr = name => clean(el.getAttribute(name));
      const labels = el.labels ? [...el.labels].map(label => clean(label.innerText)).filter(Boolean) : [];
      const inputText = ['button', 'submit', 'reset'].includes(el.type) ? clean(el.value) : '';
      const fallbackName = labels[0] || attr('aria-label') || attr('title') || attr('placeholder') ||
        attr('alt') || clean(el.innerText) || inputText;

      let context = null;
      for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
        if (!node.matches('dialog, [role="dialog"], fieldset, form, section, article, [role="region"], [role="group"]')) continue;
        const labelledBy = node.getAttribute('aria-labelledby');
        const labelledText = labelledBy
          ? labelledBy.split(/\s+/).map(id => document.getElementById(id)?.textContent).filter(Boolean).join(' ')
          : '';
        const heading = node.matches('fieldset')
          ? node.querySelector(':scope > legend')
          : node.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"]');
        const name = clean(node.getAttribute('aria-label') || labelledText || heading?.textContent)
          .replace(/(\S)\(/g, '$1 (');
        if (name && name !== fallbackName) {
          const role = node.getAttribute('role') || node.localName;
          context = { role, name };
          break;
        }
      }

      const quote = value => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
      const candidates = [];
      for (const name of ['data-testid', 'data-test', 'data-qa']) {
        const value = el.getAttribute(name);
        if (value) candidates.push(`[${name}=${quote(value)}]`);
      }
      if (el.id) candidates.push(`#${CSS.escape(el.id)}`);
      for (const name of ['name', 'aria-label', 'placeholder']) {
        const value = el.getAttribute(name);
        if (value) candidates.push(`${el.localName}[${name}=${quote(value)}]`);
      }
      if (el.localName === 'a' && el.getAttribute('href')) {
        candidates.push(`a[href=${quote(el.getAttribute('href'))}]`);
      }

      return {
        tag: el.localName,
        type: attr('type') || null,
        fallbackName,
        labels,
        testId: attr('data-testid') || null,
        context,
        css: candidates.find(candidate => {
          try { return document.querySelectorAll(candidate).length === 1; } catch { return false; }
        }) || null,
        frameUrl: window === window.top ? null : location.href,
      };
    });

    const role = semantic?.role || inferRole(dom.tag, dom.type);
    const name = semantic?.name || dom.fallbackName || null;
    const base = name
      ? `${role} ${JSON.stringify(name)}`
      : role !== 'generic' ? role : dom.type ? `${dom.tag}[type=${JSON.stringify(dom.type)}]` : dom.tag;
    const target = dom.context
      ? `${base} in ${dom.context.role} ${JSON.stringify(dom.context.name)}`
      : base;

    let scope = page;
    let prefix = 'page';
    if (dom.frameUrl) {
      const frames = page.frames().filter(frame => frame !== page.mainFrame() && frame.url() === dom.frameUrl);
      scope = frames.length === 1 ? frames[0] : null;
      prefix = 'frame';
    }

    let playwright = null;
    if (scope && name && role !== 'generic') {
      try {
        const candidate = scope.getByRole(role, { name, exact: true });
        if (await candidate.count() === 1) {
          playwright = `${prefix}.getByRole(${JSON.stringify(role)}, { name: ${JSON.stringify(name)}, exact: true })`;
        }
      } catch {}
    }
    if (!playwright && scope && dom.labels[0]) {
      const label = dom.labels[0];
      try {
        if (await scope.getByLabel(label, { exact: true }).count() === 1) {
          playwright = `${prefix}.getByLabel(${JSON.stringify(label)}, { exact: true })`;
        }
      } catch {}
    }
    if (!playwright && scope && dom.testId) {
      try {
        if (await scope.getByTestId(dom.testId).count() === 1) {
          playwright = `${prefix}.getByTestId(${JSON.stringify(dom.testId)})`;
        }
      } catch {}
    }

    return {
      target,
      locator: { playwright, css: dom.css, frameUrl: dom.frameUrl },
    };
  } catch {
    const target = semantic?.name
      ? `${semantic.role} ${JSON.stringify(semantic.name)}`
      : semantic?.role || 'element';
    return { target, locator: { playwright: null, css: null, frameUrl: null } };
  }
}

function semanticTarget(snapshot, ref) {
  const line = snapshot?.split('\n').find(candidate => candidate.includes(`[ref=${ref}]`));
  if (!line) return null;
  const match = line.match(/^\s*-\s*([\w-]+)(?:\s+"((?:\\.|[^"])*)")?/);
  if (!match) return null;
  let name = match[2] || null;
  if (name) {
    try { name = JSON.parse(`"${name}"`); } catch {}
  }
  return { role: match[1], name };
}

function inferRole(tag, type) {
  if (tag === 'a') return 'link';
  if (tag === 'button' || ['button', 'submit', 'reset'].includes(type)) return 'button';
  if (tag === 'select') return 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'input') {
    if (type === 'checkbox' || type === 'radio') return type;
    return 'textbox';
  }
  return tag;
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
      const clean = (value, max) => (value || '').replace(/\s+/g, ' ').trim().slice(0, max);
      const visibleText = root =>
        root.innerText ||
        [...root.querySelectorAll('button, a, p, h1, h2, h3, h4, h5, h6, li, label, [role="heading"]')]
          .map(node => node.innerText)
          .filter(Boolean)
          .join(' ') ||
        root.textContent;
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
      const controlSelector = 'button, a, [role="button"], [role="link"], [onclick], [tabindex]';
      const hasControls = node => node.querySelector(controlSelector);
      while (!hasControls(report) && report.parentElement && report.parentElement !== document.body) {
        const parentStyle = window.getComputedStyle(report.parentElement);
        if (!hasControls(report.parentElement) && parentStyle.position !== 'fixed' && parentStyle.position !== 'sticky') break;
        report = report.parentElement;
      }
      const id = report.id ? `#${report.id}` : '';
      const cls =
        typeof report.className === 'string' && report.className.trim()
          ? '.' + report.className.trim().split(/\s+/)[0]
          : '';
      const scope = report.shadowRoot || report;
      const controls = [...scope.querySelectorAll(controlSelector)]
        .map(control => clean(
          control.getAttribute('aria-label') ||
          control.getAttribute('title') ||
          control.getAttribute('alt') ||
          control.getAttribute('name') ||
          control.value ||
          control.innerText ||
          control.textContent,
          80,
        ))
        .filter(Boolean)
        .slice(0, 5);
      return {
        kind: 'overlay',
        detail: `${report.tagName.toLowerCase()}${id}${cls}`,
        text: clean(visibleText(scope), 200),
        controls,
      };
    });
  } catch {
    return null;
  }
}

function overlayErrorMessage(diag) {
  if (!diag?.text && !diag?.controls?.length) return `click blocked by overlay: ${diag.detail}`;
  const text = diag.text ? ` "${diag.text}${diag.text.length >= 200 ? '...' : ''}"` : '';
  const buttons = diag.controls?.length ? ` (buttons: ${diag.controls.map((name) => `"${name}"`).join(', ')})` : '';
  return `click blocked by overlay${text}${buttons} [${diag.detail}]. Interact with the overlay first — click one of its buttons or a close control — or pick a different target.`;
}

const OVERLAY_BUTTON_NAMES = [
  /^(?:accept all(?: cookies)?|allow all(?: cookies)?|i agree|agree|alle cookies akzeptieren|alle akzeptieren|aceptar todas las cookies)$/iu,
  /^(?:reject all(?: cookies)?|decline all(?: cookies)?|necessary cookies only|use necessary cookies only|alle ablehnen|nur notwendige cookies|optionale cookies deaktivieren|rechazarlas todas)$/iu,
  /^(?:no,? thanks|not now|close|dismiss|nein danke|schließen|schliessen|cerrar)$/iu,
];

async function tryDismissOverlay(page, actionTimeoutMs) {
  const scopes = [page, ...page.frames().filter(frame => frame !== page.mainFrame())];
  for (const name of OVERLAY_BUTTON_NAMES) {
    for (const scope of scopes) {
      try {
        const buttons = scope.getByRole('button', { name });
        const count = await buttons.count();
        for (let i = 0; i < count; i++) {
          const button = buttons.nth(i);
          if (!await button.isVisible()) continue;
          try {
            await button.click({ timeout: actionTimeoutMs });
            return true;
          } catch {
            // Try another matching control or Escape.
          }
        }
      } catch {
        // Frames can detach while an overlay closes.
      }
    }
  }

  try {
    await page.keyboard.press('Escape');
    return true;
  } catch {
    return false;
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

async function actOrDescribe(locator, verb, action, actionTimeoutMs, recoverOverlay = null) {
  try {
    await action();
    return null;
  } catch (err) {
    if (verb === 'click') {
      const diag = await diagnoseClickFailure(locator);
      if (diag?.kind === 'hidden') {
        if (await tryClickClickableAncestor(locator, actionTimeoutMs)) {
          return 'ancestor';
        }
      }
      if (diag?.kind === 'hidden') {
        throw new Error(`click target is hidden (${diag.detail}); no clickable ancestor found`);
      }
      if (diag?.kind === 'overlay') {
        if (recoverOverlay && await recoverOverlay()) {
          try {
            await action();
            return 'overlay';
          } catch {
            // Preserve the original, more useful overlay diagnostic below.
          }
        }
        throw new Error(overlayErrorMessage(diag));
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
  return await actOrDescribe(
    locator,
    'click',
    () => locator.click({ timeout: actionTimeoutMs }),
    actionTimeoutMs,
    () => tryDismissOverlay(page, actionTimeoutMs),
  );
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

export async function goBack(page) {
  const beforeUrl = page.url();
  const beforeSnapshot = await observe(page).catch(() => null);
  const response = await page.goBack({ waitUntil: 'load' });
  if (response === null && page.url() === beforeUrl) {
    const afterSnapshot = await observe(page).catch(() => null);
    if (afterSnapshot === beforeSnapshot) throw new Error('goBack had no effect');
  }
  return null;
}

// waitUntil: 'load' (not 'networkidle' — Playwright discourages it; chatty
// pages with analytics/polling rarely settle). 'load' fires when the doc and
// its sub-resources are loaded; the executor's post-action settle loop in
// observe-settle.js then polls observe() until URL + snapshot fingerprint
// are stable, which absorbs SPA hydration. Any throw here (timeout, DNS,
// SSL, bad URL) is fatal — executor.js routes it to fatalError, ending
// the run with outcome 'error' and exit code 3 (review-followups.md #8).
export async function navigate(page, url, networkTimeoutMs) {
  await page.goto(url, { waitUntil: 'load', timeout: networkTimeoutMs });
}
