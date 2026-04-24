# observer.js — design

Date: 2026-04-24
Status: approved, ready for implementation

Supersedes an earlier version of this file that assumed `page.accessibility.snapshot()`. That API is removed in Playwright 1.59.

## Purpose

Hand the current page state to the LLM as text. Nothing more.

## API

```js
observe(page) → Promise<string>
```

Returns the YAML string produced by `page.locator('body').ariaSnapshot({ mode: 'ai' })`. No wrapper object. No refs map.

## Implementation

One line:

```js
export async function observe(page) {
  return await page.locator('body').ariaSnapshot({ mode: 'ai' });
}
```

## Why so small

Playwright 1.59's ai-mode does the work we originally planned to write. See `docs/playwright-usage.md`:

- filters layout/generic noise (no role lists for us to maintain)
- assigns per-snapshot refs inline as `[ref=e2]`, `[ref=e3]`, ...
- resolves those refs via an `aria-ref=eN` selector — `tools.js` does `page.locator('aria-ref=${ref}').click()`

There is nothing left for observer to do beyond calling the API.

## Consequences

- Refs are session-local. A replay does not reuse old refs — it re-snapshots at each step and re-resolves by name.
- No state between `observe()` calls.
- No tests. Verification is visual: the returned YAML is human-readable.

## Out of scope

- Filtering, reindenting, renumbering — Playwright handles all of it.
- Replay-stable refs — impossible by design (page mutates between sessions).
- Any wrapper types, options, or flags.

## Success criterion

`observe(page)` returns the expected ai-mode YAML with `[ref=eN]` annotations for:

- `https://example.com`
- `https://news.ycombinator.com`
- one form-heavy page (`https://httpbin.org/forms/post` or similar)

And `page.locator('aria-ref=eN').isVisible()` resolves one of the refs from the snapshot.
