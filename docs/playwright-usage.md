# playwright usage

Version: 1.59.1. Install:
```
npm install playwright
npx playwright install chromium
```

## the key insight

Playwright 1.59 added `ariaSnapshot({ mode: 'ai' })`. It returns a YAML string of the accessibility tree with element refs already baked in as `[ref=e2]`. The refs are resolvable via an `aria-ref=eN` selector.

This replaces what we planned to build ourselves (numbered refs, locator map). Playwright does it. We just pass the refs back when the LLM picks an action.

## what we use

### observer

```js
const snapshot = await page.locator('body').ariaSnapshot({ mode: 'ai' });
```

Returns YAML like:
```yaml
- banner:
  - heading "Example Domain" [ref=e2]
  - link "More info" [ref=e3]
- textbox "Email" [ref=e4]
- button "Sign up" [ref=e5]
```

Properties:
- refs (`e1`, `e2`, ...) are assigned per snapshot call
- does not wait for elements, snapshots what is there now
- includes iframe contents
- refs are valid for the current snapshot only. do not cache across observations.

### tools

Every action takes a ref from the most recent snapshot:

```js
await page.locator(`aria-ref=${ref}`).click();
await page.locator(`aria-ref=${ref}`).fill(value);
await page.locator(`aria-ref=${ref}`).press(key);
```

Page-level actions:
```js
await page.goto(url);
await page.waitForURL(pattern);
```

### verifier

```js
page.url();
await page.getByText(text).isVisible();
await page.getByRole('heading', { name: 'Dashboard' }).isVisible();
```

For stronger anchor points later:
```js
await expect(page.locator('main')).toMatchAriaSnapshot(template);
```

### recorder signals

Cheap to pull, useful for traces:
```js
page.consoleMessages();
page.pageErrors();
page.requests();
```

## what we do not use

- `page.accessibility.snapshot()`: older API, returns a tree object, no refs.
- `@playwright/test`: we use the library, not the test runner.
- Playwright Test Agents (planner/generator/healer): our harness is the agent.
- Playwright MCP: we call the library directly, no MCP layer.

## architectural implication

This changes the observer from "walk the tree and assign refs" to one line:

```js
export async function observe(page) {
  return await page.locator('body').ariaSnapshot({ mode: 'ai' });
}
```

No map, no numbering, no state between calls. The snapshot string goes straight to the LLM. The LLM returns a ref. Tools resolve it via `aria-ref=`. That is the entire loop.