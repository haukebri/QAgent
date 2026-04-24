# a11y exploration script — design

Date: 2026-04-24
Status: approved, ready for implementation plan

## Purpose

Answer one question before designing `observer.js`: what does Playwright's `ariaSnapshot()` actually look like on real pages?

This is a throwaway exploration script, not part of the final architecture. It exists only to give us real output to look at before committing to a format for `observer.js`.

## Context

The project architecture (`docs/project-architecture.md`) lists this as build-order step 1: "open a page with playwright, dump the a11y tree." Step 2 is `observer.js`, which turns the tree into a compact text snapshot with numbered refs for the LLM. We cannot sensibly design step 2 without first seeing what the raw a11y data looks like on real pages.

Playwright offers two a11y APIs:
- `page.accessibility.snapshot()` — deeply nested JSON object.
- `page.locator('body').ariaSnapshot()` — compact YAML-like text.

We use `ariaSnapshot()` because it is closer to what an LLM will actually read and it is what `observer.js` is likely to build on.

## Behavior

Invocation:

```
node src/observe.js <url>
```

Steps:
1. Launch Chromium headless via Playwright.
2. Open a page and navigate to `<url>`, waiting for network to be idle.
3. Call `page.locator('body').ariaSnapshot()`.
4. Print the returned YAML tree to stdout.
5. Close the browser.
6. Exit 0 on success, 1 on failure (missing URL arg, navigation error, etc.).

On error: print the error message to stderr, then exit 1.

## Shape

One file, approximately 25 lines:

```
src/
  observe.js
```

- ES module (project is `"type": "module"`).
- Single top-level async IIFE. No exports.
- URL read from `process.argv[2]`.
- No CLI flag parsing, no options.

No changes to `package.json`; `playwright` is already a dependency.

## Out of scope

- `observer.js`, numbered refs, or any compacting of the tree.
- Headed mode, custom timeouts, alternate wait strategies.
- Tests. This is exploration — the point is to eyeball output.
- Multiple URLs in one run, output-to-file, or any other ergonomics.

## Success criterion

Running the script against at least two different sites (e.g. `https://example.com` and `https://news.ycombinator.com`) produces readable YAML a11y output and gives us enough signal to form an opinion on what `observer.js` should produce.
