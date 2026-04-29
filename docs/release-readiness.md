# QAgent release readiness

Updated: 2026-04-29

This note is the current source of truth for the next npm release. Multi-goal
specs, planner orchestration, and batch execution remain intentionally out of
scope. The release target is the single-goal CLI:

```bash
qagent "<goal>"
```

## Decisions applied

- The npm package is `@qagent/cli`; the binary remains `qagent`.
- Verification is LLM-only: a driver LLM acts, and a verifier LLM judges the
  final state. No pure-code verifier promise remains.
- `--print` / `-p` is not part of the current CLI surface and should not appear
  in docs.
- Browser timezone follows the host machine's local timezone. There is no
  timezone option for now.
- Browser installation and recovery are documented in the README.
- OpenRouter is the only supported LLM provider and has a short setup guide in
  the README.
- `npm test` is currently a no-op success.
- The npm package uses a `files` allowlist so docs/internal guide files are not
  published.
- Node.js 20+ is declared in package metadata.
- Config validation is considered good enough for now; do not add extra
  hand-holding before this release.
- JSON/trace evidence is intentionally unchanged for this release.

## Remaining release blockers

### 1. Verify browser/setup errors still emit reporter output

The CLI now routes browser launch and setup failures through reporter `onEnd`.
Before publishing, verify the behavior manually or with a small test:

- `--reporter=ndjson` should still print a final `{"event":"done", ...}` line
  with `outcome: "error"`.
- Exit code should be 3 for runtime/setup failures after reporter startup.
- Human `list` output should show an error summary instead of a stack trace.

### 2. Run the final package checks

Run:

```bash
npm test
npm audit --omit=dev
npm pack --dry-run

tmp_prefix=$(mktemp -d)
npm install -g . --prefix "$tmp_prefix"
"$tmp_prefix/bin/qagent" --version
"$tmp_prefix/bin/qagent" --help
```

Expected:

- `npm test` exits 0.
- `npm audit --omit=dev` reports no vulnerabilities.
- `npm pack --dry-run` reports `@qagent/cli`.
- The tarball excludes `docs/`, `AGENTS.md`, `CLAUDE.md`, `src/demo.js`, and
  `src/observe.js`.
- The installed binary prints the expected version and help text.

### 3. Run one real browser/LLM smoke

With a real OpenRouter key configured:

```bash
qagent "Open https://example.com and verify that the page heading exists" \
  --reporter=ndjson \
  --max-turns=5 \
  --test-timeout=30
```

Expected:

- Exit code 0.
- Final NDJSON line has `"event":"done"` and `"outcome":"pass"`.
- `finalUrl` is `https://example.com/`.
- No trace file is written unless the `trace` reporter is selected.

### 4. Publish the scoped package correctly

Because this is a scoped public npm package, publish with public access:

```bash
npm publish --access public
```

## Intentional non-blockers

- No multi-goal/spec runner.
- No pure-code verifier.
- No `--print` / `-p`.
- No timezone override.
- No stricter hand-edited config validation.
- No JSON/trace evidence change.
- No bundled browser download during npm install.

## Follow-up ideas

These are useful, but they should not block this release:

- Add a real test suite around CLI parsing, config precedence, reporters, and
  snapshot compression.
- Add npm keywords and a `prepublishOnly` guard.
- Add an action safety boundary for CI, such as an origin allowlist.
- Add scroll support.
- Add snapshot/token/cost budgets.
- Detect no-progress loops earlier.
- Add deterministic trace output paths for AI agents.
- Clarify whether QAgent will ever expose a programmatic API, or stay CLI-only.

