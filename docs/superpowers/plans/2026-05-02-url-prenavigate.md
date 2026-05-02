# Required `--url` + Pre-Navigate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `--url` a required input, pre-navigate before the loop runs, parse basic-auth credentials out of the URL, and remove `navigate` from the LLM-visible action surface.

**Architecture:** Inline pre-navigate in `cli.js` between `launchPage()` and `runTodo()`. URL resolution chain mirrors every other config knob (`flags > env > project > user`). Creds in URL are parsed via `new URL(...)`, threaded into Playwright's `httpCredentials`, and stripped before navigation. The `navigate()` function in `tools.js` stays — `cli.js` reuses it. The executor's first turn already shows the LLM the page state (via `buildInitialPrompt`), so no message-flow restructure is needed.

**Tech Stack:** Node 20+, Playwright 1.59, ES modules. No test framework — verification is via `node` one-liners and live `qagent` runs.

**Spec:** `docs/superpowers/specs/2026-05-02-url-prenavigate-design.md`.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/config.js` | Modify (add one line) | Register `url` as a known config key |
| `src/cli.js` | Modify | Add `--url` flag, URL/creds resolution, pre-navigate, drop BASIC_AUTH env vars, update HELP |
| `src/executor.js` | Modify | Drop `navigate` from system prompt, dispatch, shorthand, imports |
| `docs/project-architecture.md` | Modify (one line) | Reflect `navigate()` as a setup primitive |
| `README.md` | Modify | Update example, ndjson schema, options/env list, recognized keys |

No new files.

---

## Task 1: Register `url` as a known config key

**Files:**
- Modify: `src/config.js:10-22`

- [ ] **Step 1: Add `url` to `KNOWN_KEYS`**

In `src/config.js`, change the `KNOWN_KEYS` block (lines 10-22) from:

```js
const KNOWN_KEYS = {
  model: { type: 'string' },
  verifierModel: { type: 'string' },
  provider: { type: 'string' },
  apiKey: { type: 'string' },
  maxTurns: { type: 'number' },
  testTimeout: { type: 'seconds' },
  networkTimeout: { type: 'seconds' },
  actionTimeout: { type: 'seconds' },
  reporter: { type: 'array' },
  outputDir: { type: 'string' },
  headed: { type: 'boolean' },
};
```

to:

```js
const KNOWN_KEYS = {
  model: { type: 'string' },
  verifierModel: { type: 'string' },
  provider: { type: 'string' },
  apiKey: { type: 'string' },
  url: { type: 'string' },
  maxTurns: { type: 'number' },
  testTimeout: { type: 'seconds' },
  networkTimeout: { type: 'seconds' },
  actionTimeout: { type: 'seconds' },
  reporter: { type: 'array' },
  outputDir: { type: 'string' },
  headed: { type: 'boolean' },
};
```

- [ ] **Step 2: Verify `config set url` works and emits valid JSON**

Run:

```bash
cd /Users/haukebrinkmann/Projects/QAgent
node src/cli.js config set --project url https://example.com
cat qagent.config.json
```

Expected `qagent.config.json` contains both `maxTurns` and `url`:

```json
{
  "maxTurns": 100,
  "url": "https://example.com"
}
```

Also run:

```bash
node src/cli.js config list
```

Expected output includes a row for `url` showing `https://example.com` from project config.

- [ ] **Step 3: Revert the test write to `qagent.config.json`**

Restore `qagent.config.json` to its prior state (only `maxTurns: 100`) so the upcoming Task 2 verifications exercise the missing-URL error path:

```bash
cat > qagent.config.json <<'EOF'
{
  "maxTurns": 100
}
EOF
```

- [ ] **Step 4: Commit**

```bash
git add src/config.js
git commit -m "config: accept \"url\" as a known config key"
```

---

## Task 2: Add `--url`, parse creds, pre-navigate, drop BASIC_AUTH env vars

**Files:**
- Modify: `src/cli.js` (multiple sections — see steps for exact lines)

This task lands the full migration: `--url` becomes required, creds-in-URL is the only basic-auth path, `BASIC_AUTH_USER`/`BASIC_AUTH_PASS` env vars are removed, pre-navigate runs after `launchPage()`, and `url` joins the reporter `ctx`.

- [ ] **Step 1: Add `navigate` to `cli.js` imports**

In `src/cli.js`, the import block at lines 2-11 ends with:

```js
import { runTodo } from './executor.js';
import { resolveApiKey } from './providers.js';
import { KNOWN_REPORTERS, selectReporters } from './reporters.js';
```

Add a new line so it becomes:

```js
import { runTodo } from './executor.js';
import { navigate } from './tools.js';
import { resolveApiKey } from './providers.js';
import { KNOWN_REPORTERS, selectReporters } from './reporters.js';
```

- [ ] **Step 2: Add `--url` to `VALUE_FLAGS`**

In `src/cli.js`, change the `VALUE_FLAGS` block (lines 40-51) from:

```js
const VALUE_FLAGS = {
  '--model': 'model',
  '--verifier-model': 'verifierModel',
  '--provider': 'provider',
  '--api-key': 'apiKey',
  '--max-turns': 'maxTurns',
  '--test-timeout': 'testTimeout',
  '--network-timeout': 'networkTimeout',
  '--action-timeout': 'actionTimeout',
  '--reporter': 'reporter',
  '--output-dir': 'outputDir',
};
```

to (add `--url` as the first entry — chosen because the help text lists it first):

```js
const VALUE_FLAGS = {
  '--url': 'url',
  '--model': 'model',
  '--verifier-model': 'verifierModel',
  '--provider': 'provider',
  '--api-key': 'apiKey',
  '--max-turns': 'maxTurns',
  '--test-timeout': 'testTimeout',
  '--network-timeout': 'networkTimeout',
  '--action-timeout': 'actionTimeout',
  '--reporter': 'reporter',
  '--output-dir': 'outputDir',
};
```

- [ ] **Step 3: Add URL resolution and creds parsing in `main()`**

In `src/cli.js`, after the model resolution block (around line 134, immediately after the `if (!modelId) throw new ConfigError(...)` line), and before the `resolveApiKey` call, insert:

```js
  const rawUrl =
    flags.url ??
    process.env.QAGENT_URL ??
    project.url ??
    user.url;
  if (!rawUrl) {
    throw new ConfigError('no url. Pass --url, set QAGENT_URL, or set "url" in qagent.config.json / ~/.config/qagent/config.json.');
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch (err) {
    throw new ConfigError(`invalid url: ${err.message}`);
  }
  const httpCredentials = parsedUrl.username
    ? {
        username: decodeURIComponent(parsedUrl.username),
        password: decodeURIComponent(parsedUrl.password),
      }
    : undefined;
  parsedUrl.username = '';
  parsedUrl.password = '';
  const startUrl = parsedUrl.toString();
```

The exact insertion point: between

```js
  if (!modelId) throw new ConfigError('no model. Pass --model, set QAGENT_MODEL, or set "model" in qagent.config.json / ~/.config/qagent/config.json.');
```

and

```js
  const { apiKey } = resolveApiKey({
```

This places URL resolution alongside the other "fail-fast config" checks.

- [ ] **Step 4: Delete the old `BASIC_AUTH_USER`/`BASIC_AUTH_PASS` env-var block**

In `src/cli.js`, delete the existing `httpCredentials` block (currently around lines 171-174):

```js
  const httpCredentials =
    process.env.BASIC_AUTH_USER && process.env.BASIC_AUTH_PASS
      ? { username: process.env.BASIC_AUTH_USER, password: process.env.BASIC_AUTH_PASS }
      : undefined;
```

The variable `httpCredentials` already exists from Step 3 (declared at the top of `main()`), so it's still in scope where `launchPage` consumes it.

- [ ] **Step 5: Add `url` to the reporter `ctx`**

In `src/cli.js`, change the `ctx` declaration (currently around line 177) from:

```js
  const ctx = { goal, modelId, verifierModelId };
```

to:

```js
  const ctx = { goal, modelId, verifierModelId, url: startUrl };
```

- [ ] **Step 6: Wire the pre-navigate call between `launchPage` and `runTodo`**

In `src/cli.js`, change the run-execution try/finally block (currently lines 184-201) from:

```js
  const tRun = Date.now();
  let browser;
  let page;
  let result;
  try {
    ({ browser, page } = await launchPage({ httpCredentials, headed }));
    try {
      result = await runTodo(
        page, goal, model, apiKey, maxTurns, verifierModel, onTurn,
        testTimeoutSec * 1000, networkTimeoutSec * 1000, actionTimeoutSec * 1000,
      );
    } catch (err) {
      result = buildErrorResult(err, page, tRun);
    }
  } catch (err) {
    result = buildErrorResult(err, page, tRun);
  } finally {
    await browser?.close();
  }
```

to:

```js
  const tRun = Date.now();
  let browser;
  let page;
  let result;
  try {
    ({ browser, page } = await launchPage({ httpCredentials, headed }));
    try {
      await navigate(page, startUrl, networkTimeoutSec * 1000);
    } catch (err) {
      result = buildErrorResult(err, page, tRun, 'pre-navigate failed');
    }
    if (!result) {
      try {
        result = await runTodo(
          page, goal, model, apiKey, maxTurns, verifierModel, onTurn,
          testTimeoutSec * 1000, networkTimeoutSec * 1000, actionTimeoutSec * 1000,
        );
      } catch (err) {
        result = buildErrorResult(err, page, tRun);
      }
    }
  } catch (err) {
    result = buildErrorResult(err, page, tRun);
  } finally {
    await browser?.close();
  }
```

The pre-navigate gets its own try with a distinct evidence prefix; if it throws, `runTodo` is skipped but the reporters still run via the existing `onEnd` block below the finally.

- [ ] **Step 7: Parameterize `buildErrorResult` with a prefix**

In `src/cli.js`, change `buildErrorResult` (currently lines 212-225) from:

```js
function buildErrorResult(err, page, startedAt) {
  return {
    outcome: 'error',
    evidence: `runner crashed: ${err.message.split('\n')[0]}`,
    llmVerdict: null,
    turns: 0,
    elapsedMs: Date.now() - startedAt,
    tokens: { input: 0, output: 0, totalTokens: 0, cost: 0 },
    verifierTokens: null,
    finalUrl: page?.url?.() ?? 'about:blank',
    history: [],
    warnings: [],
  };
}
```

to:

```js
function buildErrorResult(err, page, startedAt, prefix = 'runner crashed') {
  return {
    outcome: 'error',
    evidence: `${prefix}: ${err.message.split('\n')[0]}`,
    llmVerdict: null,
    turns: 0,
    elapsedMs: Date.now() - startedAt,
    tokens: { input: 0, output: 0, totalTokens: 0, cost: 0 },
    verifierTokens: null,
    finalUrl: page?.url?.() ?? 'about:blank',
    history: [],
    warnings: [],
  };
}
```

- [ ] **Step 8: Update the `HELP` constant**

In `src/cli.js`, change the `HELP` constant (currently lines 13-38) from:

```js
const HELP = `Usage:
  qagent [options] "<goal>"             Run a goal
  qagent config <subcommand> [args]     Manage user/project config (try: qagent config --help)

Options:
  --model <id>           LLM model (or env QAGENT_MODEL)
  --verifier-model <id>  Verifier model (defaults to --model)
  --provider <name>      LLM provider (default openrouter; or env QAGENT_PROVIDER)
  --api-key <key>        Provider API key (or env QAGENT_API_KEY / provider-specific env)
  --max-turns <n>        Turn cap (default 50)
  --test-timeout <s>     Wall-clock loop budget in seconds; verifier still runs after (default 300)
  --network-timeout <s>  Per page.goto, in seconds (default 30)
  --action-timeout <s>   Per click/fill in seconds; doubles as blocked-element detector (default 2)
  --reporter <list>      Comma-separated: list,json,ndjson,trace (default list)
  --output-dir <path>    Where trace files land (default results/, used with trace)
  --headed               Show browser window
  --version, -v          Print version
  --help, -h             Print this help

Environment:
  QAGENT_PROVIDER, QAGENT_API_KEY, QAGENT_MODEL
  ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY  (per-provider fallbacks)
  QAGENT_TEST_TIMEOUT, QAGENT_NETWORK_TIMEOUT, QAGENT_ACTION_TIMEOUT  (seconds)
  BASIC_AUTH_USER, BASIC_AUTH_PASS  (per-page httpCredentials)

Exit: 0 pass | 1 fail | 2 config error | 3 runtime error`;
```

to:

```js
const HELP = `Usage:
  qagent --url <url> [options] "<goal>"  Run a goal against a URL
  qagent config <subcommand> [args]      Manage user/project config (try: qagent config --help)

Options:
  --url <url>            Start URL (required). Embed basic auth as https://user:pass@host/path
                         (creds are stripped before navigation and used as Playwright httpCredentials).
                         Or set via QAGENT_URL / config "url".
  --model <id>           LLM model (or env QAGENT_MODEL)
  --verifier-model <id>  Verifier model (defaults to --model)
  --provider <name>      LLM provider (default openrouter; or env QAGENT_PROVIDER)
  --api-key <key>        Provider API key (or env QAGENT_API_KEY / provider-specific env)
  --max-turns <n>        Turn cap (default 50)
  --test-timeout <s>     Wall-clock loop budget in seconds; verifier still runs after (default 300)
  --network-timeout <s>  Per page.goto, in seconds (default 30)
  --action-timeout <s>   Per click/fill in seconds; doubles as blocked-element detector (default 2)
  --reporter <list>      Comma-separated: list,json,ndjson,trace (default list)
  --output-dir <path>    Where trace files land (default results/, used with trace)
  --headed               Show browser window
  --version, -v          Print version
  --help, -h             Print this help

Environment:
  QAGENT_URL, QAGENT_PROVIDER, QAGENT_API_KEY, QAGENT_MODEL
  ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY  (per-provider fallbacks)
  QAGENT_TEST_TIMEOUT, QAGENT_NETWORK_TIMEOUT, QAGENT_ACTION_TIMEOUT  (seconds)

Exit: 0 pass | 1 fail | 2 config error | 3 runtime error`;
```

- [ ] **Step 9: Verify URL parsing logic in isolation**

```bash
cd /Users/haukebrinkmann/Projects/QAgent
node -e "
const u = new URL('https://user:p%40ss@example.com/path?q=1#h');
const httpCredentials = u.username
  ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) }
  : undefined;
u.username = '';
u.password = '';
console.log(JSON.stringify({ httpCredentials, startUrl: u.toString() }));
"
```

Expected output (single line):

```json
{"httpCredentials":{"username":"user","password":"p@ss"},"startUrl":"https://example.com/path?q=1#h"}
```

This confirms percent-encoded creds are decoded and the cleaned URL preserves path/query/fragment.

- [ ] **Step 10: Verify `--help` shows the new flag and dropped env vars**

```bash
node src/cli.js --help
```

Expected: output includes `--url <url>` line, includes `QAGENT_URL` in `Environment:`, no longer mentions `BASIC_AUTH_USER` or `BASIC_AUTH_PASS`.

- [ ] **Step 11: Verify missing URL exits 2**

```bash
node src/cli.js "verify the heading"; echo "exit=$?"
```

Expected: stderr line beginning with `qagent: no url. Pass --url, set QAGENT_URL, ...`, exit code `2`.

- [ ] **Step 12: Verify malformed URL exits 2**

```bash
node src/cli.js --url "not-a-url" "verify the heading"; echo "exit=$?"
```

Expected: stderr line beginning with `qagent: invalid url:`, exit code `2`.

- [ ] **Step 13: Verify pre-navigate failure exits 3 with the new evidence prefix**

This requires a model + API key. If they're configured (via env or `qagent config list`), run:

```bash
node src/cli.js --url https://does-not-resolve.invalid "irrelevant" --max-turns=1 --reporter=ndjson 2>&1 | tail -3; echo "exit=$?"
```

Expected: the final `done` event has `"outcome":"error"` and an `"evidence"` value beginning with `pre-navigate failed:`, exit code `3`. If a model isn't configured locally, skip this step and rely on Step 11/12 plus the live run in Step 14.

- [ ] **Step 14: Live run end-to-end**

If a model is configured, run the README's quick-start example with the new flag:

```bash
node src/cli.js --url https://example.com "Verify that the page heading exists" --max-turns=3
```

Expected: turn 1 is *not* a `navigate` action (because the page is already loaded). The run reaches `done` (or, if the LLM is conservative, exits via the turn cap with a verifier verdict) and exits 0 or 1, never 3. If the LLM still emits `navigate`, that's expected at this stage — Task 3 removes the option.

- [ ] **Step 15: Commit**

```bash
git add src/cli.js
git commit -m "cli: require --url, parse basic auth from URL, pre-navigate before loop

Drops BASIC_AUTH_USER/BASIC_AUTH_PASS env-var support — creds embedded
in the URL (https://user:pass@host/) are the only auth path. Pre-navigate
runs between launchPage() and runTodo() with a 'pre-navigate failed:'
evidence prefix on failure."
```

---

## Task 3: Drop `navigate` from the LLM action surface in `executor.js`

**Files:**
- Modify: `src/executor.js` (multiple sections)

The `navigate()` function in `tools.js` stays — `cli.js` still uses it for the pre-navigate. Only the LLM-visible action surface shrinks.

- [ ] **Step 1: Drop `navigate` from the `tools.js` import**

In `src/executor.js:3`, change:

```js
import { observe, click, fill, navigate, selectOption, pressKey, type } from './tools.js';
```

to:

```js
import { observe, click, fill, selectOption, pressKey, type } from './tools.js';
```

- [ ] **Step 2: Drop `navigate` from the schema line in `SYSTEM_PROMPT`**

In `src/executor.js:19`, change:

```js
  '  { "action": "navigate" | "click" | "fill" | "selectOption" | "pressKey" | "type" | "wait" | "done" | "fail",\n' +
```

to:

```js
  '  { "action": "click" | "fill" | "selectOption" | "pressKey" | "type" | "wait" | "done" | "fail",\n' +
```

- [ ] **Step 3: Drop `"url"?: string` from the schema parameters line**

In `src/executor.js:20`, change:

```js
  '    "url"?: string, "ref"?: string, "value"?: string | string[], "key"?: string, "ms"?: number, "summary"?: string, "reason"?: string }\n\n' +
```

to:

```js
  '    "ref"?: string, "value"?: string | string[], "key"?: string, "ms"?: number, "summary"?: string, "reason"?: string }\n\n' +
```

- [ ] **Step 4: Delete the `navigate` example line**

In `src/executor.js:22`, delete the entire line:

```js
  '  {"action": "navigate", "url": "https://example.com"}\n' +
```

The lines above and below it remain. After this edit, the `Examples:` block no longer mentions navigate.

- [ ] **Step 5: Delete the basic-auth-URL paragraph**

In `src/executor.js:36`, delete the entire line (and its `\n\n` continuation):

```js
  'If the website requires basic auth, include the username and password in the URL as "https://username:password@example.com".\n\n' +
```

- [ ] **Step 6: Drop the `navigate` dispatch branch in the action loop**

In `src/executor.js`, find the dispatch chain (currently around lines 343-350). It currently reads:

```js
        let recoveredVia = null;
        if (action.action === 'navigate') await navigate(page, action.url, networkTimeoutMs);
        else if (action.action === 'click') recoveredVia = await click(page, action.ref, actionTimeoutMs);
        else if (action.action === 'fill') recoveredVia = await fill(page, action.ref, action.value, actionTimeoutMs);
        else if (action.action === 'selectOption') recoveredVia = await selectOption(page, action.ref, action.value, actionTimeoutMs);
        else if (action.action === 'pressKey') recoveredVia = await pressKey(page, action.ref, action.key, actionTimeoutMs);
        else if (action.action === 'type') recoveredVia = await type(page, action.ref, action.value, actionTimeoutMs);
        else if (action.action === 'wait') await page.waitForTimeout(action.ms ?? 1000);
        else throw new Error(`unknown action: ${action.action}`);
```

Change it to:

```js
        let recoveredVia = null;
        if (action.action === 'click') recoveredVia = await click(page, action.ref, actionTimeoutMs);
        else if (action.action === 'fill') recoveredVia = await fill(page, action.ref, action.value, actionTimeoutMs);
        else if (action.action === 'selectOption') recoveredVia = await selectOption(page, action.ref, action.value, actionTimeoutMs);
        else if (action.action === 'pressKey') recoveredVia = await pressKey(page, action.ref, action.key, actionTimeoutMs);
        else if (action.action === 'type') recoveredVia = await type(page, action.ref, action.value, actionTimeoutMs);
        else if (action.action === 'wait') await page.waitForTimeout(action.ms ?? 1000);
        else throw new Error(`unknown action: ${action.action}`);
```

A hallucinated `navigate` action now falls through to the `unknown action: navigate` throw, gets caught by the try at the same level, becomes `lastError`, and the LLM retries. No special handling needed.

- [ ] **Step 7: Drop the `navigate-throws-fatal` branch in the catch block**

In `src/executor.js`, find the catch block around line 357-366. It currently reads:

```js
      } catch (err) {
        const msg = err.message.split('\n')[0];
        entry.ms = Date.now() - tAction;
        entry.url = page.url();
        entry.error = msg;
        history.push(entry);
        onTurn?.(entry);
        if (action.action === 'navigate') throw err;
        lastError = msg;
      }
```

Change it to:

```js
      } catch (err) {
        const msg = err.message.split('\n')[0];
        entry.ms = Date.now() - tAction;
        entry.url = page.url();
        entry.error = msg;
        history.push(entry);
        onTurn?.(entry);
        lastError = msg;
      }
```

This removed the rule that "navigate failures are fatal." No LLM-driven navigate exists anymore; the pre-navigate failure path lives in `cli.js`.

- [ ] **Step 8: Drop `'navigate'` from `SHORTHAND_KEYS`**

In `src/executor.js:553`, change:

```js
const SHORTHAND_KEYS = ['click', 'fill', 'selectOption', 'type', 'pressKey', 'wait', 'navigate'];
```

to:

```js
const SHORTHAND_KEYS = ['click', 'fill', 'selectOption', 'type', 'pressKey', 'wait'];
```

- [ ] **Step 9: Delete the `navigate` shorthand handling block**

In `src/executor.js`, find the `if (verb === 'navigate')` block in `normalizeActionShape` (currently lines 593-598):

```js
  if (verb === 'navigate') {
    if (typeof value !== 'string') {
      return { error: 'navigate shorthand needs a URL string. Use {"action":"navigate","url":"https://example.com"}.' };
    }
    return { action: { action: 'navigate', url: value, ...rest } };
  }
```

Delete it entirely. The blocks above (`pressKey`) and below (`return { error: ... unsupported shorthand ... }`) stay.

- [ ] **Step 10: Verify no LLM-visible `navigate` references remain**

```bash
cd /Users/haukebrinkmann/Projects/QAgent
node -e "
const fs = require('fs');
const src = fs.readFileSync('src/executor.js', 'utf8');
const m = src.match(/const SYSTEM_PROMPT\s*=([\s\S]*?);\s*\n/);
if (!m) { console.error('SYSTEM_PROMPT not found'); process.exit(1); }
if (/navigate/i.test(m[1])) {
  console.error('FAIL: navigate still mentioned in SYSTEM_PROMPT:');
  for (const hit of m[1].match(/.{0,40}navigate.{0,40}/gi) || []) console.error('  ', hit);
  process.exit(1);
}
console.log('OK: SYSTEM_PROMPT clean');
"
```

Expected output: `OK: SYSTEM_PROMPT clean`.

- [ ] **Step 11: Verify executor still imports and parses**

```bash
node -e "import('./src/executor.js').then(m => console.log('exports:', Object.keys(m)));"
```

Expected: prints `exports: [ 'runTodo', 'findBlockingPriorError' ]` (or whatever it currently exports — the key check is no parse / import errors).

- [ ] **Step 12: Verify the action set in shorthand parsing**

```bash
node -e "
const fs = require('fs');
const src = fs.readFileSync('src/executor.js', 'utf8');
const m = src.match(/const SHORTHAND_KEYS\s*=\s*(\[[^\]]+\])/);
if (!m) { console.error('SHORTHAND_KEYS not found'); process.exit(1); }
const list = JSON.parse(m[1].replace(/'/g, '\"'));
if (list.includes('navigate')) { console.error('FAIL: navigate still in SHORTHAND_KEYS'); process.exit(1); }
console.log('OK: SHORTHAND_KEYS =', list);
"
```

Expected: `OK: SHORTHAND_KEYS = [ 'click', 'fill', 'selectOption', 'type', 'pressKey', 'wait' ]`.

- [ ] **Step 13: Live run — confirm turn-1 is not navigate**

If a model is configured:

```bash
node src/cli.js --url https://example.com "Verify that the page heading exists" --max-turns=3 --reporter=ndjson 2>&1 | head -3
```

Expected: the first `turn` event has an `"action"` other than `"navigate"` (typically `done` against `https://example.com`'s simple page). If the LLM still attempts navigate, the action will hit the `unknown action: navigate` error path and the next turn will be a retry — that should not happen if the SYSTEM_PROMPT scrub succeeded.

- [ ] **Step 14: Commit**

```bash
git add src/executor.js
git commit -m "executor: drop navigate from LLM action surface

The pre-navigate in cli.js handles the only navigation that ever ran on
turn 1; cross-page transitions still happen as side effects of clicks.
Removes navigate from the system prompt schema/examples, the basic-auth-URL
hint, the dispatch chain, the shorthand parser, and the tools.js import.
A hallucinated navigate now falls through to 'unknown action: navigate'
and the LLM retries on the next turn."
```

---

## Task 4: Update README.md and project-architecture.md

**Files:**
- Modify: `README.md` (multiple sections)
- Modify: `docs/project-architecture.md:21`

- [ ] **Step 1: Update the README quick-start example**

In `README.md`, change the example block (lines 24-27) from:

```bash
qagent config set apiKey sk-or-...
qagent config set model qwen/qwen3.5-flash-02-23
qagent "Open https://example.com and verify that the page heading exists"
```

to:

```bash
qagent config set apiKey sk-or-...
qagent config set model qwen/qwen3.5-flash-02-23
qagent --url https://example.com "Verify that the page heading exists"
```

- [ ] **Step 2: Update the README output example**

In `README.md`, change the output sample (lines 31-39) from:

```
▶ Open https://example.com and verify that the page heading exists

    1  navigate  https://example.com  2.6s
    2  done      "The page heading 'Example Domain' exists."  2.4s

✓ PASS — The final snapshot confirms the presence of the heading 'Example Domain'.
2 turns · 5.0s · $0.0001
```

to:

```
▶ Verify that the page heading exists

    1  done      "The page heading 'Example Domain' exists."  2.4s

✓ PASS — The final snapshot confirms the presence of the heading 'Example Domain'.
1 turn · 2.4s · $0.00005
```

(The exact numbers don't need to be precise — the structural change is that turn 1 is now `done` rather than `navigate`.)

- [ ] **Step 3: Add `url` to the recognized config keys**

In `README.md:125`, change:

```
Recognized keys: `model`, `verifierModel`, `apiKey`, `maxTurns`, `testTimeout`, `networkTimeout`, `actionTimeout`, `reporter`, `outputDir`, `headed`.
```

to:

```
Recognized keys: `model`, `verifierModel`, `apiKey`, `url`, `maxTurns`, `testTimeout`, `networkTimeout`, `actionTimeout`, `reporter`, `outputDir`, `headed`.
```

- [ ] **Step 4: Update the ndjson schema to drop `navigate` from the action union**

In `README.md`, change the relevant lines in the ndjson schema comment block (lines 148-156) from:

```jsonc
  "action": {                      // object, the action emitted by the driver LLM
    "action": "navigate",          // string, one of: navigate | click | fill | wait | done | fail
    "url": "https://...",          // string (navigate)
    "ref": "e6",                   // string (click | fill — snapshot ref)
    "value": "...",                // string (fill)
    "ms": 1500,                    // number (wait — requested duration)
    "summary": "...",              // string (done — driver's natural-language verdict)
    "reason": "..."                // string (fail — driver's natural-language reason)
  },
```

to:

```jsonc
  "action": {                      // object, the action emitted by the driver LLM
    "action": "click",             // string, one of: click | fill | selectOption | pressKey | type | wait | done | fail
    "ref": "e6",                   // string (click | fill | selectOption | type | pressKey — snapshot ref)
    "value": "...",                // string | string[] (fill | selectOption | type)
    "key": "Enter",                // string (pressKey)
    "ms": 1500,                    // number (wait — requested duration)
    "summary": "...",              // string (done — driver's natural-language verdict)
    "reason": "..."                // string (fail — driver's natural-language reason)
  },
```

(This both drops `navigate`/`url` and updates the action union to include the additional verbs that already existed but weren't documented — `selectOption`, `pressKey`, `type`.)

- [ ] **Step 5: Adjust the philosophy paragraph**

In `README.md:208`, change:

```
- Two-stage: a **driver LLM** picks the next action; a **judge LLM** verifies the end-state. Browser tools (click, fill, navigate) are deterministic Playwright calls.
```

to:

```
- Two-stage: a **driver LLM** picks the next action; a **judge LLM** verifies the end-state. Browser tools (click, fill, etc.) are deterministic Playwright calls. The start URL is fixed per run via `--url`; cross-page navigation happens as a side effect of clicks.
```

- [ ] **Step 6: Update the CLI Reference run options block**

In `README.md`, change the run options block (lines 220-230) from:

```
Run options:
  --model <id>            LLM model
  --verifier-model <id>   Verifier model (defaults to --model)
  --api-key <key>         Provider API key
  --max-turns <n>         Turn cap (default 50)
  --test-timeout <s>      Wall-clock loop budget in seconds; verifier still runs after (default 300)
  --network-timeout <s>   Per page.goto + post-action networkidle wait, in seconds (default 30)
  --action-timeout <s>    Per click/fill in seconds; doubles as blocked-element detector (default 2)
  --reporter <list>       Comma-separated: list,json,ndjson,trace (default list)
  --output-dir <path>     Where trace files land (default results/)
  --headed                Show the browser window
```

to:

```
Run options:
  --url <url>             Start URL (required); embed basic auth as https://user:pass@host
  --model <id>            LLM model
  --verifier-model <id>   Verifier model (defaults to --model)
  --api-key <key>         Provider API key
  --max-turns <n>         Turn cap (default 50)
  --test-timeout <s>      Wall-clock loop budget in seconds; verifier still runs after (default 300)
  --network-timeout <s>   Per page.goto + post-action networkidle wait, in seconds (default 30)
  --action-timeout <s>    Per click/fill in seconds; doubles as blocked-element detector (default 2)
  --reporter <list>       Comma-separated: list,json,ndjson,trace (default list)
  --output-dir <path>     Where trace files land (default results/)
  --headed                Show the browser window
```

- [ ] **Step 7: Update the Environment block in CLI Reference**

In `README.md`, change the Environment block (lines 237-241) from:

```
Environment:
  QAGENT_PROVIDER, QAGENT_API_KEY, QAGENT_MODEL
  ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY  (per-provider fallbacks)
  QAGENT_TEST_TIMEOUT, QAGENT_NETWORK_TIMEOUT, QAGENT_ACTION_TIMEOUT  (seconds)
  BASIC_AUTH_USER, BASIC_AUTH_PASS    (per-page httpCredentials)
```

to:

```
Environment:
  QAGENT_URL, QAGENT_PROVIDER, QAGENT_API_KEY, QAGENT_MODEL
  ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY  (per-provider fallbacks)
  QAGENT_TEST_TIMEOUT, QAGENT_NETWORK_TIMEOUT, QAGENT_ACTION_TIMEOUT  (seconds)
```

- [ ] **Step 8: Update `docs/project-architecture.md`**

In `docs/project-architecture.md:21`, change:

```
Browser surface. Read + write functions that take a playwright page:
`observe(page)` returns the ai-mode ariaSnapshot YAML (refs baked in as
`[ref=eN]`); `click`, `fill`, `navigate` resolve refs via
`page.locator('aria-ref=${ref}')`.
```

to:

```
Browser surface. Read + write functions that take a playwright page:
`observe(page)` returns the ai-mode ariaSnapshot YAML (refs baked in as
`[ref=eN]`); `click`, `fill`, `selectOption`, `pressKey`, `type` resolve refs via
`page.locator('aria-ref=${ref}')`. `navigate(page, url)` is used by `cli.js`
for the pre-navigate phase; it is no longer exposed as an LLM action.
```

- [ ] **Step 9: Verify no stale `BASIC_AUTH` or LLM-driven `navigate` references in docs**

```bash
cd /Users/haukebrinkmann/Projects/QAgent
grep -rn "BASIC_AUTH" README.md docs/ src/ 2>/dev/null || echo "no matches"
```

Expected: `no matches`.

```bash
grep -rn '"action": "navigate"' README.md docs/ 2>/dev/null || echo "no matches"
```

Expected: `no matches`.

(The string `navigate` will still appear in `docs/project-architecture.md` referring to the `navigate()` setup primitive, which is correct.)

- [ ] **Step 10: Commit**

```bash
git add README.md docs/project-architecture.md
git commit -m "docs: reflect required --url and removal of navigate as an LLM action

README quick-start and CLI reference updated for --url, QAGENT_URL,
recognized keys list, and the ndjson action union (which now also
documents selectOption/pressKey/type that were previously missing).
project-architecture.md describes navigate() as a setup primitive."
```

---

## Self-Review

**Spec coverage:**
- "Required `--url`, resolved via flag → env → project → user" → Task 2 Step 3.
- "Inline pre-navigate in cli.js" → Task 2 Step 6.
- "Creds parsed out of URL, fed to httpCredentials, stripped before navigate" → Task 2 Step 3 (parsing) + Step 6 (pre-navigate uses cleaned `startUrl`).
- "Remove BASIC_AUTH_USER/PASS env-var handling" → Task 2 Step 4.
- "Remove navigate from LLM action set" — schema, examples, dispatch, shorthand, imports, basic-auth-URL paragraph → Task 3 Steps 1–9.
- "navigate() function in tools.js stays" → no edit to tools.js; Task 2 Step 1 imports it into cli.js.
- "Reporter ctx gains url" → Task 2 Step 5.
- "Doc updates: project-architecture.md and README.md" → Task 4.
- "ConfigError → exit 2 for missing/malformed url" → Task 2 Step 3 (throws), verified in Steps 11–12.
- "Pre-navigate-specific catch with 'pre-navigate failed:' evidence prefix → exit 3" → Task 2 Steps 6 + 7 + verified in Step 13.
- "URL parse handles userinfo with empty password" → Task 2 Step 3 (decodeURIComponent("") returns ""); verified at runtime in Step 9.
- "Trust waitUntil: 'load' from tools.navigate; no extra settle" → Task 2 Step 6 reuses `navigate()` directly (which is `page.goto({ waitUntil: 'load' })`).

**Placeholder scan:** searched for "TBD", "TODO", "implement later", "fill in", "similar to" — none present. Every code block is complete.

**Type consistency:** `httpCredentials`, `startUrl`, `parsedUrl`, `rawUrl` are introduced in Task 2 Step 3 and consumed in the same task (Steps 5, 6, 7). The `prefix` parameter on `buildErrorResult` is introduced in Step 7 and used in Step 6 — order matters within Task 2, so Step 6 is shown wired with `'pre-navigate failed'` already; Step 7 makes that signature legal. The engineer should be aware that mid-task (between Steps 6 and 7) the file does not parse cleanly. Acceptable since Task 2 is committed atomically.

(Two paths to handle this: either reorder Steps 6 and 7, or keep as-is. Reordering makes Step 7 land first, then Step 6 wires it. That's slightly safer for incremental syntax checks. **Note for the executor: do Step 7 before Step 6 if running incremental syntax checks; otherwise the order shown is fine since the commit covers both.**)

**Scope:** four tasks, each producing a clean self-contained commit. Bisect-friendly: after Task 1 the project is unchanged behaviorally; after Task 2 `--url` is required and pre-navigate works; after Task 3 the LLM no longer sees `navigate`; after Task 4 docs are aligned.
