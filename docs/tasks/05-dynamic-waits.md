# Task 05: Add Evidence-Based Dynamic Wait Tools

## Problem

Several failures happened after a click or submit where the page needed time, route changes, or specific content to appear. The current tools only expose generic `wait` and `observe` does a short best-effort `networkidle` wait.

This is weak for SPAs and real-world sites:

- Ryanair sometimes reached a `/trip/flights/select?...` URL but the snapshot still showed the search form or disabled controls.
- Gravity Forms submissions could leave stale notification text and validation state visible.
- AIDA step transitions sometimes needed waiting for the next form/step content rather than arbitrary sleeps.

The driver can ask for `wait`, but it cannot wait for a specific URL, selector, text, enabled button, or disappearance of loading/disabled state.

## Goal

Add dynamic wait actions that let the driver wait for observable evidence instead of sleeping blindly.

## Scope

Add one or more new actions to the executor schema and tools:

```json
{"action": "waitForText", "text": "Thank you for your project inquiry", "ms": 10000}
{"action": "waitForUrl", "value": "/trip/flights/select", "ms": 10000}
{"action": "waitForEnabled", "ref": "e184", "ms": 5000}
{"action": "waitForGone", "text": "Loading", "ms": 10000}
```

Keep the MVP small. The highest-value first step is likely:

- `waitForText`
- `waitForUrl`

Then add `waitForEnabled` if needed for disabled buttons such as Ryanair Search.

## Non-Goals

- Do not replace normal `wait`.
- Do not add complex selector languages yet.
- Do not make site-specific wait tools.
- Do not wait indefinitely; all dynamic waits need bounded timeouts.

## Suggested Implementation

Update:

- `SYSTEM_PROMPT` in `src/executor.js` to document the new action(s).
- `REF_ACTIONS` only if the wait action uses `ref`.
- Action dispatch in `runTodo`.
- `src/tools.js` with bounded Playwright waits.
- Report formatting in `src/reporters.js` if needed.

Possible tool implementations:

```js
export async function waitForText(page, text, timeoutMs) {
  await page.getByText(text, { exact: false }).first().waitFor({ timeout: timeoutMs });
}
```

```js
export async function waitForUrl(page, value, timeoutMs) {
  await page.waitForURL(url => String(url).includes(value), { timeout: timeoutMs });
}
```

For `waitForEnabled`, resolve `aria-ref=${ref}` and wait until the element is enabled.

## Acceptance Criteria

- The driver can call `waitForText` and the run waits until matching text appears or times out.
- The driver can call `waitForUrl` and the run waits until the URL contains the expected value or times out.
- Timeout errors are reported back to the model clearly.
- Generic sleeps still work unchanged.
- Dynamic wait actions appear clearly in list/JSON/trace output.
- Ryanair-style runs can wait for the results route/content instead of immediately declaring success or failure.

## Example Failure This Prevents

In Ryanair runs, the driver often clicked Search and then either called `done` too early or failed because prices were not visible yet. A bounded wait such as:

```json
{"action": "waitForUrl", "value": "/trip/flights/select", "ms": 10000}
```

followed by:

```json
{"action": "waitForText", "text": "€", "ms": 10000}
```

would give the page a concrete chance to render flight cards before verification.
