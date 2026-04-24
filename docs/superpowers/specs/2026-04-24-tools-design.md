# tools.js — design

Date: 2026-04-24
Status: approved, ready for implementation

## Purpose

The browser actions the LLM picks from. Each is a thin wrapper around a Playwright call, resolving refs from the most recent `observe()` snapshot via `aria-ref=${ref}`.

## API

```js
click(page, ref)           // Promise<void>
fill(page, ref, value)     // Promise<void>
navigate(page, url)        // Promise<void>
```

Three exports. No dispatcher, no registry, no helpers.

## Implementation

```js
export async function click(page, ref) {
  await page.locator(`aria-ref=${ref}`).click();
}

export async function fill(page, ref, value) {
  await page.locator(`aria-ref=${ref}`).fill(value);
}

export async function navigate(page, url) {
  await page.goto(url, { waitUntil: 'networkidle' });
}
```

## Design notes

- **Errors throw.** Playwright's messages (`"locator.click: Timeout 30000ms exceeded ..."`) are already specific. `executor.js` decides whether to catch or not.
- **Return void.** State updates are observed via the next `observe()` call — no "result" object.
- **Signature asymmetry is deliberate.** `click` and `fill` take a ref (element-level); `navigate` takes a URL (page-level). Forcing a uniform `(page, ref, args)` shape would add a dummy parameter.
- **`networkidle` on navigate** matches `src/observe.js`, so the page is settled before the next observation.
- **No timeout customization.** Playwright's 30s default stays. If the loop feels slow, executor tunes it — not tools.js.

## Out of scope

- `press`, `waitForURL`, `hover`, `check`, `select` — add when the LLM actually needs them.
- Ref validation (matching against the current snapshot) — that's the loop's invariant, not tools.js's.
- Tests. Verification is end-to-end: observe → pick a ref → act → re-observe.

## Success criterion

End-to-end sanity run:

1. `navigate` to example.com, `observe`, extract the "Learn more" link's ref, `click`, confirm `page.url()` points at iana.org.
2. `navigate` to `https://httpbin.org/forms/post`, `observe`, extract the "Customer name" textbox ref, `fill` with a test value, re-observe, confirm the value appears in the new snapshot.
