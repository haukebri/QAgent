# Required `--url` + pre-navigate, drop `navigate` from the LLM toolset

Date: 2026-05-02

## Motivation

QAgent today lets the LLM pick its own first navigation. The system prompt
nudges it about basic-auth-in-URL syntax, and `BASIC_AUTH_USER` /
`BASIC_AUTH_PASS` env vars feed `httpCredentials` on the browser context.
Two costs of that shape:

1. The LLM occasionally fumbles the first step (forgets the basic-auth
   prefix, picks a stale or wrong URL, burns a turn on a redirect it could
   have skipped).
2. The system prompt carries a `navigate` action and a basic-auth-URL
   paragraph that exist solely for that first step. Once the page is
   loaded, the LLM rarely needs `navigate` again — and when it does
   reach for it, that's usually a recovery move ("get me back to the
   start") that hides a real failure rather than surfacing it.

The fix: require a `--url` (with the same resolution chain as every other
config knob), pre-navigate before the loop, and drop `navigate` from the
LLM action surface entirely. The LLM still navigates — but only as a side
effect of clicks, which is what a real user does.

## Scope

**In scope.**
- New required input `url`, resolved via `--url` flag → `QAGENT_URL` env →
  `project.url` → `user.url`.
- Inline pre-navigate in `cli.js` between `launchPage()` and `runTodo()`.
- Basic-auth credentials parsed out of the URL (`https://user:pass@host/...`)
  and threaded into Playwright's `httpCredentials`. URL is stripped of
  credentials before navigation.
- Remove `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` env-var handling.
- Remove `navigate` from the LLM action set: schema, examples, dispatch,
  shorthand, imports, and the basic-auth-URL prompt paragraph. The
  `navigate()` function in `tools.js` stays — `cli.js` reuses it.
- Reporter context (`ctx` in `cli.js`) gains a `url` field.
- Doc update: `docs/project-architecture.md` reflects the split between
  `navigate()` as a setup primitive and the LLM-visible action surface.

**Out of scope** (explicitly deferred — not building hooks for them now).
- Form login / OAuth / saved storage state. A future "setup phase" feature
  may need a real module; this spec deliberately doesn't build the layer
  for it.
- LLM-extracted URLs (parsing the goal text to derive a target). Goal text
  stays the user's intent; `--url` stays the user's input.
- Dedicated `--basic-auth-user` / `--basic-auth-pass` flags. Creds in URL
  is the only path; the user owns the choice of how to inject them.
- Multi-target / multi-step setup orchestration.
- Pre-navigate settle gating beyond Playwright's `waitUntil: 'load'`.
  If turn-1 settle pain shows up empirically, address then.

## Architecture

The pre-navigate is ~10 lines and lives inline in `cli.js`. No new module.
A `setup.js` would be ceremony for one call site; introduce it later if a
second concrete need arrives.

```
cli.js:
  parse args
  resolve config (model, provider, ..., url)   ← --url joins the chain
  parse url, extract httpCredentials, strip creds
  launchPage({ httpCredentials, headed })
  await navigate(page, startUrl, networkTimeoutMs)   ← NEW
  runTodo(page, goal, ...)                            ← unchanged signature
  browser.close()
```

`runTodo()`'s signature stays the same. The executor's first turn runs
`observe(page)` and now sees a real loaded page instead of `about:blank`.

## URL resolution and credentials parsing

### Resolution chain

`--url` joins `VALUE_FLAGS` with key `url`. Resolved by:

```
flags.url  >  process.env.QAGENT_URL  >  project.url  >  user.url
```

If unresolved → `ConfigError("no url. Pass --url, set QAGENT_URL, or set \"url\" in qagent.config.json / ~/.config/qagent/config.json.")` → caught
at `cli.js:250` → **exit 2**. Same shape as the existing `no model` error.

`config.js` validates `url` as an optional string in both project and user
config (consistent with existing string fields).

### Parsing and credentials extraction

```js
let parsed;
try {
  parsed = new URL(rawUrl);
} catch (err) {
  throw new ConfigError(`invalid url: ${err.message}`);
}
const httpCredentials = parsed.username
  ? {
      username: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
    }
  : undefined;
parsed.username = '';
parsed.password = '';
const startUrl = parsed.toString();
```

This block replaces the env-var read at `cli.js:171-174` entirely.
`BASIC_AUTH_USER` / `BASIC_AUTH_PASS` come out of `cli.js`'s `Environment:`
help text too.

### Edge cases

- **Username only, no password** (`https://token@host/`): allowed.
  `decodeURIComponent("")` is `""`, so `httpCredentials = { username: "token", password: "" }`. Token-as-Basic-user APIs work.
- **Query and fragment**: `URL.toString()` after stripping creds preserves
  both. No special handling.
- **Creds-in-config footgun**: storing a URL with embedded creds in
  `qagent.config.json` is risky if the file is committed. Add a one-line
  note to the help text — runtime validation would be invasive.

## Executor changes

### System prompt (`executor.js:16-59`)

- Drop `"navigate"` from the action union in `Schema:`.
- Drop `"url"?: string` from the schema.
- Drop `{"action": "navigate", "url": "https://example.com"}` from
  `Examples:`.
- Drop the basic-auth-URL paragraph: `"If the website requires basic auth, include the username and password in the URL as ..."`.

No new wording added. The LLM's view becomes "the page is what it is; act
on it." Hallucinating a `navigate` action is unlikely once it's not
mentioned anywhere; the existing `unknown action: <name>` fall-through at
`executor.js:350` is a sufficient safety net.

### Action set and dispatch

- `executor.js:343` — remove the `if (action.action === 'navigate') await navigate(...)` branch. Subsequent `else if` chain is unchanged. The
  `else throw new Error('unknown action: ${action.action}')` at line 350
  remains as the catch-all.
- `executor.js:3` — drop `navigate` from the `tools.js` import.
- `executor.js:553` — drop `'navigate'` from `SHORTHAND_KEYS`.
- `executor.js:593-598` — remove the `if (verb === 'navigate')` shorthand
  case.
- `REF_ACTIONS` (`executor.js:11`) does not include `navigate` today —
  no change.

### Turn-1 flow

No structural change required. The conversation flow is already:

1. `Agent` is constructed with `initialState: { systemPrompt, model }`
   (`executor.js:76-81`) — system message is set.
2. Loop's turn 1 runs `observe(page)` (`executor.js:130`), now against a
   real loaded page.
3. `askNextAction` calls `agent.prompt(buildInitialPrompt({ goal, url, snapshot, baselineTurn }))`.
4. `buildInitialPrompt` produces:
   ```
   Baseline anchor (turn 1).

   Goal: <goal>
   Current URL: <real url>
   <<SNAPSHOT_BEGIN>>
   <real snapshot>
   <<SNAPSHOT_END>>
   Next action (JSON only):
   ```

That message is the first user turn after the system prompt — exactly
"page directly after system message". The page being meaningful from
turn 1 is the only behavioral change.

### Pre-navigate settle behavior

Pre-navigate calls `navigate(page, startUrl, networkTimeoutMs)`, which is
`page.goto(url, { waitUntil: 'load', timeout: networkTimeoutMs })`. We
trust this same primitive that the previous LLM-driven navigate used. If
the page is mid-hydration when turn-1 `observe()` fires, the LLM has
`wait` available. No additional settle layer is added at the pre-navigate
step.

## Failure handling

Three distinct failure modes, each with a stable exit code.

| Failure | Where it happens | Exit code | Path |
|---|---|---|---|
| URL not provided | Config resolution | 2 | `ConfigError` → caught at `cli.js:250` |
| URL malformed | `new URL(rawUrl)` throws | 2 | wrapped as `ConfigError("invalid url: ...")` |
| Pre-navigate throws | `await navigate(page, ...)` after launch | 3 | explicit catch builds error result |

### Pre-navigate-specific catch

The pre-navigate `navigate()` call is wrapped in its own `try`, distinct
from `runTodo()`'s `try`. On throw, build a result directly with a clear
prefix and skip `runTodo`. Reporters still run via the existing `for (const r of reporters) await r.onEnd?.(...)` block.

```js
try {
  ({ browser, page } = await launchPage({ httpCredentials, headed }));
  try {
    await navigate(page, startUrl, networkTimeoutMs);
  } catch (err) {
    result = buildPreNavigateErrorResult(err, page, tRun);
  }
  if (!result) {
    try {
      result = await runTodo(...);
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

`buildPreNavigateErrorResult` mirrors `buildErrorResult` but sets
`evidence: "pre-navigate failed: <one-line message>"`. ~6 extra lines.
Exit code resolves to 3 via the existing `outcome === 'error'` branch.

`page.goto` failure modes the user will see surfaced verbatim in the
evidence string: `net::ERR_NAME_NOT_RESOLVED`, `net::ERR_CERT_*`,
`Timeout 30000ms exceeded`, `net::ERR_INVALID_AUTH_CREDENTIALS`, etc.

## Reporter context

`ctx` constructed at `cli.js:177` becomes:

```js
const ctx = { goal, modelId, verifierModelId, url: startUrl };
```

Reporters that write trace files or summaries gain a stable identifier for
the run. No reporter is required to consume it; existing reporters that
don't read `ctx.url` are unaffected.

## Documentation updates

- `docs/project-architecture.md` line 21: "`click`, `fill`, `navigate`"
  → reflect that `navigate()` is a setup primitive used by `cli.js`, not
  an LLM-visible action. One sentence.
- `cli.js` `HELP` constant: add `--url <url>` entry, drop the
  `BASIC_AUTH_USER`/`BASIC_AUTH_PASS` line from `Environment:`, add
  `QAGENT_URL` to the env-var list. Add a brief note about creds-in-URL.
- `README.md` (if it documents env vars or invocation): update for both
  the new flag and the removed env vars.

## Acknowledged breaking changes

- **Runs without `--url` (or env / config equivalent) now exit 2.** Any
  existing scripts that relied on the LLM picking a URL must specify one.
- **`BASIC_AUTH_USER` / `BASIC_AUTH_PASS` are no longer read.** Users with
  basic auth must embed creds in the URL (`--url https://user:pass@host/`).

Both are explicit user decisions, captured here for visibility.

## Test impact

- Existing fixtures in `verdict-gate` and elsewhere drive the loop directly
  and don't go through `cli.js` for their navigate; they keep working.
- Any test that invokes the CLI without a URL must be updated to pass one.
- A new test case is worth adding for each failure path (URL missing,
  URL malformed, pre-navigate timeout). These are the new error edges.

## Self-review notes

Re-read on 2026-05-02:

- No "TBD" / "TODO" placeholders.
- Architecture, action-set changes, and turn-1 flow are consistent: the
  shrunken action set and the pre-navigate change reinforce each other,
  no contradictions.
- Scope is single-implementation-plan sized: ~one full pass through
  `cli.js`, ~one focused pass through `executor.js`, plus help-text and
  doc updates. No decomposition needed.
- Ambiguity check: every decision point that came up during brainstorming
  (URL required vs optional, source precedence, creds UX, navigate
  fallthrough vs explicit guard, settle-from-cold) is either pinned to a
  specific choice or explicitly deferred.
