# QAgent release readiness

Date: 2026-04-28
Updated: 2026-04-29 with product decisions.

This note merges two release-readiness reviews for the next npm package version
after `0.4.0`. The combined review covered project-manager, architecture,
AI-user, AI-agent reliability, and manual-QA perspectives.

Multi-goal specs, planner orchestration, and batch execution are intentionally
out of scope for this release. The reviewed release target is the single-goal
CLI:

```bash
qagent "<goal>"
```

## Current status

QAgent is close to a publishable experimental release, but it is not ready to
publish as-is. The biggest remaining work is expectation alignment, strict CLI
behavior, and release hardening, not a new product surface.

Positive signals:

- `npm pack --dry-run` succeeds and produces a tarball.
- A temp global install from the local repo works; `qagent --version` prints
  the package version.
- `npm audit --omit=dev` reports no vulnerabilities.
- `node --check src/*.js` passes.
- A real `example.com` smoke run passed with `--reporter=ndjson` in 2 turns.
- Missing model and missing API key errors are clear and exit with code 2.
- Stable exit-code semantics and the NDJSON `done` schema are already useful
  for AI agents.

Negative signals:

- `npm test` still fails with the placeholder "no test specified" script.
- Public docs and package metadata do not fully match the shipped CLI.
- Some runtime and reporter promises are not guaranteed in setup-failure paths.
- The npm artifact is not curated yet.

## Decisions now taken

- **Package name:** publish as `@qagent/cli`; the binary remains `qagent`.
- **Verifier promise:** QAgent uses a driver LLM plus an LLM judge verifier.
  Remove all pure-code-verifier promises.
- **Browser environment:** use the host machine's local timezone by default. Do
  not add a timezone option yet.
- **Browser install failure:** document browser dependencies and recovery steps
  in the README. Do not add a postinstall browser download.
- **LLM provider:** OpenRouter is the only supported provider for now; document
  a short OpenRouter setup guide.
- **Package contents:** add a `files` allowlist or intentionally keep docs and
  utility scripts in the tarball after making them accurate.

## Publish blockers

### 1. Finish package identity alignment

The package should publish as `@qagent/cli`; the binary remains `qagent`.
Before publish, verify `package.json`, `package-lock.json`, README badges,
install commands, and `npm pack --dry-run` all agree.

### 2. Fix verifier fallback behavior

QAgent's verifier is intentionally an LLM judge. The release must not claim
pure-code verification.

Also fix the fallback path in `src/executor.js`: if the verifier throws, the
runner can currently fall back to the driver verdict and pass a run when the
driver said `done`. For release safety, verifier failure should not silently
turn into a pass.

### 3. Add a real test gate

`npm test` currently exits 1 with "Error: no test specified". Before publishing,
add a minimal test suite or smoke script that can pass in CI.

Minimum useful coverage:

- CLI help/version.
- Missing goal.
- Missing model.
- Missing API key.
- Invalid reporter flag.
- Invalid timeout flag.
- Unknown flag behavior.
- Config set/list with a temp `HOME`.
- Config precedence: flag > env > project > user > default.
- Reporter payload shape for `json` and `ndjson`.
- Trace payload includes outcome and evidence.
- Snapshot compression basics.

The real browser/LLM smoke can remain a manual pre-publish check, but the
package should not ship with a failing `npm test`. A free first step is to make
`npm test` run syntax checks, but that should grow into actual CLI/config tests.

### 4. Guarantee machine-readable error envelopes

The README promises that `--reporter=ndjson` always ends with a `done` envelope,
including `outcome: "error"`. Browser launch currently happens outside the
inner result-building catch path. If Chromium is missing or launch fails, the
process can exit 3 without emitting the final `done` event.

Fix the CLI so setup/runtime failures after reporters start still call reporter
`onEnd` with a structured error result.

### 5. Fail hard on unknown flags

Unknown run/config flags currently warn and continue. For human users this is
surprising; for AI agents and CI it can spend tokens after a typo.

Expected behavior before publish:

- `qagent --headad "<goal>"` exits 2 before browser launch.
- `qagent config list --projct` exits 2 instead of silently ignoring the typo.

### 6. Curate the npm artifact

`npm pack --dry-run` currently includes runtime files plus internal/support
files such as AGENTS, CLAUDE, design docs, `src/demo.js`, `src/observe.js`, and
`.env.template`.

No secret was included, but the artifact should be intentional. Before publish:

- Add a `files` whitelist in `package.json`; or
- Keep docs/utilities in the package and make sure they are accurate.

The second review recommends a narrow tarball containing only runtime `src`
files, `README.md`, `LICENSE`, and package metadata. If docs stay in the
package, make sure they do not advertise missing commands or stale architecture.

### 7. Remove or quarantine legacy demo paths

`src/demo.js` still says to delete it once `runner.js` / `cli.js` land. The CLI
has landed. Either remove `src/demo.js` from the package or clearly mark it as
internal/legacy so users do not copy the old env-var path.

## Documentation work for the next release

- README should show browser dependency installation and recovery steps:
  `npx playwright install chromium`, and on minimal Linux images
  `npx playwright install-deps chromium`.
- README should include a short OpenRouter guide covering API keys, model
  configuration, env vars, and the current OpenRouter-only provider support.
- Docs should not promise pure-code verification.

## Should fix before publish

### Declare Node support and publish hygiene

Direct dependencies require Node >=20, but the root package has no `engines`
field. Add:

```json
{
  "engines": {
    "node": ">=20"
  }
}
```

Also add:

- npm keywords for discoverability.
- `prepublishOnly` to run the local release gate.
- A documented stance on exact-pinned `@mariozechner/pi-ai` and
  `@mariozechner/pi-agent-core`. Exact pinning is reasonable for a fast-moving
  0.x dependency, but it should be intentional.

Mention Node 20 in the Quick Start.

### Validate config on read

Values written through `qagent config set` are coerced, but hand-edited JSON is
mostly trusted. Bad project/user config should fail with exit 2 and a clear
message.

Cases to validate:

- `maxTurns` must be a positive integer.
- `testTimeout`, `networkTimeout`, `actionTimeout` must be positive numbers.
- `reporter` must be an array of known reporter names.
- `outputDir` must be a string.
- `headed` must be a boolean.
- `model`, `verifierModel`, and `apiKey` must be strings when present.

Also reject invalid reporter values during `qagent config set reporter ...`.

### Include verifier evidence in JSON and trace output

`list` and `ndjson` expose the final evidence sentence, but the shared
JSON/trace payload omits it. Add `evidence` to the payload generated by
`src/recorder.js`.

For failed runs, consider also adding paths for any sidecar snapshot and
screenshot files.

### Update stale shipped docs

Docs included in the npm tarball still mention planned or missing CLI features,
including:

- `--config`
- `qagent config get`
- `qagent config path`
- `qagent config edit`
- `qagent config unset`
- planner/runner/spec orchestration

Either update these docs to describe current behavior or exclude design docs
from the published package.

### Fix model examples

Use model examples that are valid with the pinned dependency, such as
`qwen/qwen3.5-flash-02-23` or `anthropic/claude-sonnet-4.5`, and document that
available OpenRouter model IDs are limited to the `pi-ai` registry bundled with
the installed package.

### Clarify package API stance

There is no public programmatic API: no `index.js` and no `exports` field. That
is fine for a CLI-only package, but it should be deliberate. If QAgent is
CLI-only for now, avoid accidentally documenting imports from `src/`.

## Track but do not block

These are real follow-up items, but they should not hold the single-goal npm
release once the blockers above are addressed.

- Split `src/cli.js` and `src/executor.js` eventually; both exceed the original
  200-line MVP target.
- Align local architecture rules with reality. Current code has `ConfigError`
  as a class and `config.js` exports more than two things, while AGENTS.md says
  no classes and max two exports per module.
- Add an optional action safety boundary for CI use, such as an origin allowlist
  or destructive-action guard.
- Add a scroll tool. Real-world pages often need scroll; clicking off-screen
  refs from the aria snapshot can be fragile.
- Add snapshot/token/cost budgets. `--max-turns` is currently the only spending
  knob, and large snapshots can stress both driver and verifier.
- Detect no-progress loops earlier instead of spending all `maxTurns`.
- Consider trimming or summarizing very large verifier snapshots before judging.
- Consider configurable user-agent and locale later. Timezone currently follows
  the host machine.
- Consider auto-switching to `ndjson` when stdout is not a TTY, or at least make
  the agent-oriented invocation more prominent.
- Add a deterministic trace output path option, such as `--trace-out`, so agents
  do not need to parse stderr or sort `results/` by mtime.
- Consider screenshots for passing tests, not only failures, if visual audit is
  important.
- Document the role of local `qagent.config.json`. A future `qagent init`
  command could make project setup clearer.

## Manual pre-publish checklist

Run these before publishing:

```bash
npm test
npm audit --omit=dev
npm pack --dry-run

tmp_prefix=$(mktemp -d)
npm install -g . --prefix "$tmp_prefix"
"$tmp_prefix/bin/qagent" --version
"$tmp_prefix/bin/qagent" --help
```

Expected tarball contents should match the chosen package policy. If using a
narrow artifact, it should contain runtime `src` files, `README.md`, `LICENSE`,
package metadata, and little else.

Run config checks in an isolated home:

```bash
tmp_home=$(mktemp -d)
HOME="$tmp_home" qagent config set model qwen/qwen3.5-flash-02-23
HOME="$tmp_home" qagent config list
```

Run one real browser/LLM smoke with a test key:

```bash
qagent "Open https://example.com and verify that the page heading exists" \
  --reporter=ndjson \
  --max-turns=5 \
  --test-timeout=30
```

Expected result:

- Exit code 0.
- Final NDJSON line has `"event":"done"` and `"outcome":"pass"`.
- `finalUrl` is `https://example.com/`.
- No trace file is written unless the `trace` reporter is selected.

Run failure-shape checks:

```bash
qagent
qagent "Open https://example.com" --reporter=nope
qagent "Open https://example.com" --test-timeout=0
qagent "Open https://example.com" --unknown-flag
```

Expected result:

- Exit code 2 for config/setup errors.
- No browser launch or LLM call for invalid CLI/config input.
- Machine-readable reporters keep stdout parseable.

Run browser environment checks after implementing the local timezone behavior:

```bash
qagent "Open a timezone test page and verify the displayed timezone matches this machine"
```

Expected result:

- Timezone-sensitive pages see the host timezone by default.

## Recommended release sequence

1. Verify `@qagent/cli` package identity is aligned across package metadata, README, and npm dry-run output.
2. Fix verifier-failure fallback.
3. Guarantee reporter `done` envelopes for setup/runtime errors.
4. Make CLI and config validation strict.
5. Document browser dependency installation and recovery in README.
6. Verify browser timezone default uses the host machine.
7. Add the minimal passing test gate.
8. Curate package contents and remove/quarantine legacy demo paths.
9. Update README, `.env.template`, and shipped docs.
10. Add Node engines, keywords, and `prepublishOnly`.
11. Re-run pack/install/audit/smoke checks.
12. Publish with a clear pre-1.0 changelog.
