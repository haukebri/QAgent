# Task 01: Repair Common Action JSON Shapes

## Problem

Some driver models return valid JSON that does not match QAgent's action schema. For example:

```json
{"click": "e184", "summary": "Click Search"}
```

The executor currently parses this successfully, but `action.action` is missing, so the run records `unknown action: undefined`. In several failed runs, the model repeated the same malformed shape for many turns instead of recovering.

The intended schema is:

```json
{"action": "click", "ref": "e184", "summary": "Click Search"}
```

## Goal

Add a small validation and repair layer after JSON parsing and before action execution in `src/executor.js`.

The executor should normalize safe, common shorthand shapes into the canonical schema, and reject unrepairable shapes with a clear error message that tells the model exactly what to return.

## Scope

Implement repair for these shapes:

```json
{"click": "e184"}
{"fill": "e168", "value": "London"}
{"selectOption": "e20", "value": "Frau"}
{"type": "e15", "value": "Springfi"}
{"pressKey": "Enter"}
{"pressKey": "e15", "key": "Enter"}
{"wait": 1500}
{"navigate": "https://example.com"}
```

Canonical outputs:

```json
{"action": "click", "ref": "e184"}
{"action": "fill", "ref": "e168", "value": "London"}
{"action": "selectOption", "ref": "e20", "value": "Frau"}
{"action": "type", "ref": "e15", "value": "Springfi"}
{"action": "pressKey", "key": "Enter"}
{"action": "pressKey", "ref": "e15", "key": "Enter"}
{"action": "wait", "ms": 1500}
{"action": "navigate", "url": "https://example.com"}
```

Preserve optional fields such as `summary` and `reason` when repairing.

## Non-Goals

- Do not add a new dependency.
- Do not broaden the action vocabulary.
- Do not silently guess ambiguous or unsafe actions.
- Do not change browser tool behavior in `src/tools.js`.

## Suggested Implementation

Add a helper near `extractActionJson` in `src/executor.js`, for example `normalizeActionShape(parsed)`.

The helper should return either:

```js
{ action: normalizedAction }
```

or:

```js
{ error: 'Invalid action shape. Use {"action":"click","ref":"e184"}, not {"click":"e184"}.' }
```

Call it immediately after `JSON.parse(jsonStr)` in `askNextAction`.

If normalization fails, route the message through the existing `parseError` / retry path so the model sees the correction and the run continues.

## Acceptance Criteria

- A model response of `{"click":"e184"}` executes as a click on ref `e184`.
- A model response of `{"fill":"e168","value":"London"}` executes as a fill on ref `e168`.
- A model response of `{"pressKey":"Enter"}` executes as a global key press.
- A model response of `{"wait":1500}` executes as a 1500 ms wait.
- Malformed but valid JSON, such as `{"foo":"bar"}`, does not become `unknown action: undefined`; it produces a clear schema error for the model.
- Existing canonical action JSON still works unchanged.
- Add focused tests for the normalization helper if the repo has a test harness by then; otherwise add a small local verification path or exported helper test once tests are introduced.

## Example Failure This Prevents

In the Ryanair runs, `gpt-5.4-nano` repeatedly produced shapes like:

```json
{"click": "e184", "summary": "Click Search to load available flights and prices."}
```

Those turns never touched the browser because the executor saw no `action` property. This task turns that recoverable formatting error into a valid action, reducing wasted turns and avoiding false failures caused by schema drift.
