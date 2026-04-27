# QAgent CLI Approach

## Context

This project is being renamed from **QA-Runner** to **QAgent**. There is an existing `qagent` npm package and repository — this codebase will replace both.

QAgent today runs end-to-end via `src/demo.js`: a goal string is passed as a positional arg, env vars carry the API key and model, and a JSON trace is written under `results/`. That's enough to validate the loop, but it isn't a CLI: there's no `bin` entry, no flag parsing, no config layering, and nothing that another agent (Claude Code, CI) can wrap cleanly.

This document proposes the CLI surface — what to build, what to copy from `pi-mono` / `agent-browser` / `playwright`, and what to leave out. **Specs, planner, and runner orchestration are explicitly out of scope** for this round; the CLI accepts a single goal string and runs it through the existing executor.

---

## Status (2026-04-27)

Built incrementally. Milestones 1 and 2 shipped; rest pending.

- **Milestone 1 — Bare binary** [done] (commit `8a358ed`). `qagent "<goal>"` runs the executor end-to-end with `--model` / `--verifier-model` / `--api-key` / `--max-turns` / `--headed` (no-op for now) / `--version` / `--help` flags. Reads `QAGENT_MODEL`, `QAGENT_API_KEY`, `OPENROUTER_API_KEY` from env. Exit codes 0/1/2/3. **No trace file by default** (behavior change from `demo.js`). Unknown flags warn but don't crash. `bin: { qagent: "src/cli.js" }` in `package.json`.
- **Milestone 2 — Config layering** [done]. `src/config.js` reads `~/.config/qagent/config.json` (user, XDG-style) and `./qagent.config.json` (project, cwd-only, no walk-up). Precedence per §3: flag > env > project > user. Hand-edited JSON; missing files = empty; malformed JSON = exit 2 with file path. Unknown keys silently ignored. Recognized keys: `model`, `verifierModel`, `apiKey`, `maxTurns`.
- **Milestone 3 — `config` subcommand** [done]. `qagent config set [--project] <key> <value>` writes user config (default) or project config; only user config gets `0o600`. `qagent config list` prints all known keys with their effective value and source (env/project/user/default/unset) plus the file paths. `apiKey` is redacted in list output (`sk-or-...wxyz` form). Strict on writes (unknown key → exit 2; `maxTurns` must be a positive integer); lenient on reads. `qagent config --help` shows usage. Implementation lives in `src/config-cmd.js`; data-layer ops (load, write, path resolution) in `src/config.js`.
- **Milestone 4 — Reporter system + `--headed` + config integration** [done]. Composable `--reporter=list,json,ndjson,trace` (default `list`); flag value replaces default rather than merging. `list` keeps the human progress + summary output unchanged; `json` dumps the full trace payload to stdout at end; `ndjson` streams `{event:"turn",...}` per executed turn followed by a `{event:"done",goal,outcome,turns,elapsedMs,cost,...}` envelope; `trace` writes to `results/<iso>.json` (or `--output-dir <path>`) and reports the path on **stderr** so machine-readable reporters keep stdout clean. `--headed` is now wired through `launchPage` (`headless: !headed`). Three new config keys land in the layer: `reporter` (array), `outputDir` (string), `headed` (boolean) — set via `qagent config set` with type coercion (`'true'/'1'` and `'false'/'0'` for booleans, comma-separated for the array). New module `src/reporters.js`; `src/recorder.js` factored to expose `buildPayload()`; `runTodo` gained an optional `onTurn` 7th param (no-op default keeps `demo.js` compatible).
- **Milestone 5 — Agent ergonomics** [pending]. `--print` / `-p` to suppress live progress; the `done` envelope event already shipped in M4's ndjson reporter.
- **`demo.js`** still in tree and works unchanged (`LLM_MODEL` / `LLM_API_KEY` env via `--env-file=.env`). Removal deferred until user signal.

---

## What we learned from the references

### pi-mono (the gold standard for LLM-agent CLIs)

- **Single binary, mode-based**: positional arg is the work itself; modes (`--print`, `--mode json`, `--mode text`, `--mode rpc`) cover human and machine consumption from one entry point.
- **API key layering**: `auth.json` (file-locked, `0o600`) → provider config → env vars → `--api-key`.
- **Unknown flags don't crash** — captured for extensions.

### agent-browser

- **JSON config + JSON Schema**: `~/.agent-browser/config.json` (user) overlaid by `./agent-browser.json` (project), CLI flags win.
- Designed for upstream orchestration; doesn't own the agentic loop.

### Playwright

- **Composable reporters**: `--reporter=list,json,html`. Multiple reporters in one run.
- Code-driven config (`playwright.config.ts`), discovered in cwd. Implicit exit codes (0 / 1).
- No built-in credential handling — auth is the test's job.

---

## Design decisions

### 1. Project & binary name DONE

- Project: **QAgent**
- npm package: `qagent` (overrides the existing one)
- Binary: `qagent`
- Repo: rename to `qagent` when convenient

### 2. Single binary, goal-first, with a `config` subcommand

**Choice:** The runner has one mode — positional arg is the goal text:

```bash
qagent "User can sign up with email"
qagent "User can browse ships on aida.de" --headed
```

No spec files, no directories of specs, no multi-goal batches in v1. Spec format and the planner come later — this CLI is the thin shell over `runTodo()` that today's `demo.js` already is.

A separate `config` subcommand handles read/write of the user and project config files (covered in §3 below). This isn't "modes for running tests" — it's the sibling utility every CLI of this shape ships (`git config`, `npm config`, `gh config`, `pi config`).

### 3. Three-layer config: flags > project > user

**Resolution order** (highest priority first):

1. **CLI flags** — `--model`, `--api-key`, etc.
2. **Env vars** — `QAGENT_API_KEY`, `OPENROUTER_API_KEY`, `QAGENT_MODEL`
3. **Project config** — `./qagent.config.json` in cwd (optional)
4. **User config** — `~/.config/qagent/config.json` (optional, but the typical setup)
5. **Built-in defaults**

The user config is the headline feature: install once, set `model` and `apiKey` once, then run `qagent "<goal>"` in any project without further setup.

#### User config: `~/.config/qagent/config.json`

```json
{
  "model": "anthropic/claude-sonnet-4-5",
  "verifierModel": "anthropic/claude-haiku-4-5",
  "apiKey": "sk-or-..."
}
```

- File-mode `0o600` (set automatically when written via `qagent config`).
- JSON, not JS — declarative, parse-safe, no toolchain.
- Created and edited via the `config` subcommand (see below); hand-editing is fine too.

#### Project config: `./qagent.config.json`

Same schema; cwd-only, no walk-up. Used to pin a specific model for a given project, override turn caps, etc. Almost always omitted.

```json
{
  "model": "anthropic/claude-opus-4-5",
  "maxTurns": 80,
  "reporters": ["list"]
}
```

#### Managing config: the `config` subcommand

Modeled on `git config` / `npm config`. Default scope is the **user** config; pass `--project` to write the project config in cwd.

```bash
qagent config set model anthropic/claude-sonnet-4-5
qagent config set apiKey sk-or-...
qagent config set --project model anthropic/claude-opus-4-5

qagent config get model              # prints effective value + source
qagent config list                   # prints effective config with provenance
qagent config path [--project]       # prints the file path
qagent config edit [--project]       # opens $EDITOR
qagent config unset apiKey
```

Writes use `0o600` for the user config and create the parent directory if missing.

#### Why JSON, not JS

Playwright's `defineConfig` is powerful but pulls in a TS/JS runtime story we don't need. JSON Schema gives us IDE validation for free.

#### Why cwd-only for the project config

Walk-up surprises users (loads config from a parent repo). Strict beats clever.

### 4. API key resolution

**Precedence (highest first):**

1. `--api-key <key>` flag
2. `QAGENT_API_KEY` env var
3. `OPENROUTER_API_KEY` env var
4. Project config `apiKey`
5. User config `apiKey`

**Error UX when nothing is found:**

```
qagent: no API key found.
Run `qagent config set apiKey <key>` or set QAGENT_API_KEY / OPENROUTER_API_KEY.
See https://openrouter.ai/keys
Exit 2.
```

Avoid pi-mono's file-locked `auth.json` for now — overkill for a runner that fires occasionally. Plain JSON in user config is fine; we set `0o600` and document it.

### 5. Reporters: composable, opt-in trace

**Default: `list` only.** No file is written unless the user asks for it.

| Reporter | Output | Use case |
|---|---|---|
| `list` (default) | Pretty live progress to stdout: `▶ goal → ✓ pass (12 turns, 8.2s, $0.04)` | Human run |
| `json` | Single JSON object to stdout at end (full trace) | Piping to other tools |
| `ndjson` | Newline-delimited JSON events streamed to stdout | **AI agent / live log** |
| `trace` | `results/{iso}.json` written to disk (today's behavior) | When the user explicitly wants a trace file |

Compose with comma: `--reporter=list,trace`, `--reporter=ndjson`.

**On the `--report` question:** No binary `--report` flag. The composable list subsumes it. Critically, **trace is no longer on by default** — running `qagent "<goal>"` in a fresh project must not litter `results/` files. An agent or developer who wants the trace asks for it.

### 6. AI-agent / Claude Code friendliness

- `--reporter=ndjson` → one JSON event per line on stdout. Each line parseable independently. Errors → stderr.
- `--print` / `-p` → suppresses live progress; emits only the final result envelope.
- **Stable exit codes:**
  - `0` — goal passed
  - `1` — goal failed (verifier said `fail`)
  - `2` — config / setup error (missing API key, malformed config, etc.)
  - `3` — runtime error (browser crash, network)
- All config keys overridable as flags (`--model`, `--max-turns`, `--headed`).
- Final NDJSON event is a tiny envelope an agent can grep for:

  ```
  {"event":"done","goal":"...","outcome":"pass","turns":12,"cost":0.04}
  ```

The most common agent integration will be Claude Code running `qagent "<goal>" --reporter=ndjson` and reading stdout turn by turn.

### 7. Multi-project UX

- `npm i -g qagent` → `qagent` available everywhere.
- User runs `qagent config set model <id>` and `qagent config set apiKey <key>` once, then `qagent "<goal>"` works in any project.
- Per-project `qagent.config.json` only when a project genuinely diverges (different model, higher turn cap).
- No global session/state. Each invocation is independent.

---

## Proposed CLI surface (v1)

```
Usage:
  qagent [options] "<goal>"            Run a goal
  qagent config <subcommand> [args]    Manage user/project config
  qagent --version | --help

Run options:
  --model <id>              LLM model
  --verifier-model <id>     Verifier model (defaults to --model)
  --api-key <key>           OpenRouter API key (prefer env or user config)
  --max-turns <n>           Turn cap (default 50)
  --headed                  Show browser window
  --reporter <list>         Comma-separated: list,json,ndjson,trace (default list)
  --output-dir <path>       Where trace file lands (default results/, only used with `trace`)
  --print, -p               Suppress progress; print final result envelope only
  --config <path>           Override default ./qagent.config.json
  --version, -v
  --help, -h

Config subcommands:
  qagent config set <key> <value> [--project]
  qagent config get <key>
  qagent config list
  qagent config path [--project]
  qagent config edit [--project]
  qagent config unset <key> [--project]

Environment:
  QAGENT_API_KEY            Preferred env var
  OPENROUTER_API_KEY        Fallback env var
  QAGENT_MODEL              Default model if no flag/config
  BASIC_AUTH_USER, BASIC_AUTH_PASS  Per-page httpCredentials (existing behavior)

Resolution order: CLI flag > env > project config > user config > built-in default

Exit codes: 0 pass | 1 fail | 2 config error | 3 runtime error
```

---

## Verification (how we validate the CLI end-to-end)

1. **Smoke (existing flow still works):** with user config set, `qagent "Open google.com and verify the search box exists"` → exit 0, list reporter shows ✓, **no trace file written**.
2. **User config:** `~/.config/qagent/config.json` with `model` + `apiKey` → fresh shell, no env vars → `qagent "..."` runs cleanly.
3. **Project override:** drop `qagent.config.json` with a different `model` → that model is used; user config supplies the API key.
4. **Flag override:** `qagent "..." --model X` overrides both configs.
5. **Trace opt-in:** `qagent "..." --reporter=list,trace` → trace JSON appears under `results/`.
6. **NDJSON for agents:** `qagent "..." --reporter=ndjson --print | jq -c .` → stream of events, last is `{"event":"done",...}`.
7. **Missing key UX:** unset env, empty user config → stderr message + exit 2 (not a stack trace).
8. **Cross-project:** run from `~/proj-a` and `~/proj-b` with no per-project config → both use user config defaults.

---

## Open questions

1. **User config path** — `~/.qagent/config.json` (simple dotfile) or XDG `~/.config/qagent/config.json` (Linux-friendly)? Default to the dotfile?
Answer: We do the linux friendly .config approach

2. **`config` subcommand surface in v1** — ship the full set (`set / get / list / path / edit / unset`) from day one, or start with just `set` + `edit` and grow as needed?
Answer: We do set - which sets it, or edits it if its present
Plus list, to print the config

3. **Storing the API key in JSON** — acceptable, or should keys be env-only and the user config hold model preferences only? (Pi-mono stores them; agent-browser does too. KISS says yes, but a security-conscious user might want env-only.)
Answer: We will store them. If users dont want to, they dont have to

4. **Default model** — pick a sensible built-in fallback (e.g. `anthropic/claude-sonnet-4-5`) or refuse to run without explicit configuration?
Answer: For now: refuse to run and point to the config, how to set it

5. **Scope flag naming** — `--project` (with user being implicit default) or symmetric `--user` / `--project` like git's `--global` / `--local`?
Answer: not sure what you mean, do what you think is better

---

## Out of scope (explicitly deferred)

- **Spec files, runner.js, planner.js** — the CLI runs a single inline goal. Spec format and orchestration come later as a separate design.
- **More subcommands** (`qagent show-report`, `qagent replay`, `qagent serve`) — `config` is enough for v1; add others only when a real need appears.
- **HTML reporter** — `ndjson` and opt-in `trace` cover the immediate use cases.
- **Provider abstraction** — OpenRouter only in v1.
- **File-locked auth store** — plain JSON with `0o600` is enough for now.
- **MCP server mode** — could add `qagent serve --mcp` later.
- **Config walk-up / merging multiple project configs** — start strict.
