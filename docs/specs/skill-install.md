# Spec: `qagent skill` subcommand

## Goal

Ship the Claude Code skill file (`skill/SKILL.md`) as part of the npm package, and give users a one-command way to activate it in their local Claude Code installation.

Today the skill lives at `skill/SKILL.md` in the repo. A user who installs `@qagent/cli` globally has the file inside their `node_modules`, but Claude Code won't pick it up unless it's copied to `~/.claude/skills/qagent/SKILL.md`. The new subcommand does that copy.

## User story

```
npm install -g @qagent/cli
qagent skill install
# → ~/.claude/skills/qagent/SKILL.md now exists
# → new Claude Code sessions auto-trigger on "verify login flow", etc.
```

One command, no manual file copying, no asking the user to know where Claude's config directory lives.

## Command surface

Add a new top-level command group `skill` with three subcommands:

```
qagent skill install [--force] [--dry-run]
qagent skill uninstall
qagent skill path
```

Help text:

- `qagent skill install` — Install the QAgent Claude Code skill into the user's Claude config directory.
- `qagent skill uninstall` — Remove the installed QAgent skill.
- `qagent skill path` — Print the resolved install path without installing anything.

Flags on `install`:

- `--force` — overwrite the destination file even if it already exists.
- `--dry-run` — print what would happen; do not touch the filesystem.

## Resolving the destination path

The install target is `<claude-config-dir>/skills/qagent/SKILL.md`.

Resolve `<claude-config-dir>` in this order:

1. If the `CLAUDE_CONFIG_DIR` environment variable is set and non-empty, use that.
2. Otherwise, use `path.join(os.homedir(), ".claude")`.

This mirrors how Claude Code itself resolves its config directory, so users with custom setups Just Work.

Do not hardcode `/Users/...` or `$HOME/.claude` as strings. Always compute via `os.homedir()` and `path.join` so the command is correct on macOS, Linux, and Windows.

## Resolving the source path (bundled SKILL.md)

The SKILL.md must be found relative to the installed package, not relative to `process.cwd()`.

Use `fileURLToPath(import.meta.url)` to get the path of the running `dist/cli.js`, then resolve `../../skill/SKILL.md` from there (or whatever relative path points at the bundled file after the build output lands in `dist/`).

**Bundling requirement:** add `"skill"` to the `files` array in `package.json` so the `skill/` directory is included in the published tarball. Confirm with `npm pack` and inspect the `.tgz`.

If the source file can't be found, exit with code 2 and a clear error — this indicates a packaging bug, not a user error.

## Behavior: `qagent skill install`

1. Resolve source path. If missing, error and exit 2.
2. Resolve destination path.
3. If destination exists:
   - Without `--force`: print a message like `Skill already installed at <path>. Re-run with --force to overwrite.` and exit 0. This is not an error — the skill is already there.
   - With `--force`: proceed to overwrite.
4. Create the destination directory recursively (`fs.mkdirSync(dir, { recursive: true })`).
5. Copy the file (`fs.copyFileSync(src, dest)`).
6. Print a confirmation: `Installed QAgent skill to <dest>. Restart or start a new Claude Code session to pick it up.`
7. Exit 0.

`--dry-run` mode: run steps 1–3 (resolution and existence checks), print what *would* happen, do not write anything, exit 0.

## Behavior: `qagent skill uninstall`

1. Resolve destination path.
2. If it doesn't exist, print `Skill not installed.` and exit 0. Not an error.
3. Delete the file.
4. Best-effort remove the now-empty `skills/qagent/` directory (`fs.rmdirSync`, ignore `ENOTEMPTY`).
5. Print `Removed <dest>.` and exit 0.

Do **not** remove `~/.claude/skills/` itself, even if empty — that directory belongs to Claude Code.

## Behavior: `qagent skill path`

1. Resolve the destination path.
2. Print it to stdout as a single line, no decoration.
3. Exit 0.

Useful for shell scripting (`cat "$(qagent skill path)"`) and for users who want to manually inspect or diff.

## Doctor integration

Extend `qagent doctor` to report skill installation status as a non-fatal check:

- If installed and byte-identical to the bundled source: `Skill installed (up to date)`.
- If installed but differs from the bundled source: `Skill installed (out of date — run: qagent skill install --force)`.
- If not installed: `Skill not installed (run: qagent skill install)`.

None of these should change doctor's exit code on their own — they're informational. Doctor stays focused on "can QAgent actually run" (Node, claude, agent-browser, browser startup).

## CLI integration notes

Register under the existing `cac` CLI in `src/cli.ts`:

```
cli.command("skill install", "...").option("--force", "...").option("--dry-run", "...").action(...)
cli.command("skill uninstall", "...").action(...)
cli.command("skill path", "...").action(...)
```

Put the implementation in a new `src/skill-install.ts` module that exports `installSkill`, `uninstallSkill`, `resolveSkillPaths`, etc. The CLI file should stay thin — just argument parsing and dispatch.

## Testing

Add process-level tests in `test/cli.test.mjs` (or a new `test/skill.test.mjs`):

1. `qagent skill path` prints a path ending in `skills/qagent/SKILL.md`.
2. `qagent skill install` into a temp `CLAUDE_CONFIG_DIR` creates the file and exits 0.
3. Second install without `--force` is a no-op and exits 0.
4. Install with `--force` overwrites.
5. `--dry-run` does not create the file.
6. `uninstall` removes the file and empty `qagent/` directory, leaves `skills/` alone.
7. `uninstall` when nothing is installed exits 0 with a friendly message.

All tests should set `CLAUDE_CONFIG_DIR` to a temp directory so they don't touch the real `~/.claude/`.

## Docs

Update `README.md`:

- Add a "Claude Code skill" section after the install instructions.
- Show the two-line flow: `npm install -g @qagent/cli` then `qagent skill install`.
- Briefly explain what the skill does (auto-triggers in Claude Code sessions on prose like "verify the login flow").
- Mention `qagent skill uninstall` and `qagent skill path` for completeness.

Update `docs/DESIGN.md`:

- Add a short subsection noting that QAgent ships a Claude Code skill as a secondary distribution surface, installable via `qagent skill install`.

## Release

- Bump to `0.2.0` (new user-facing feature, not a bugfix).
- Update `cli.version(...)` in `src/cli.ts`.
- Tag and publish: `npm version 0.2.0 && npm publish`.

## Non-goals

- Do **not** auto-install the skill on `postinstall`. It's intrusive and surprising. Keep it explicit.
- Do **not** attempt to detect and update already-installed older versions automatically. The doctor report is enough; the user runs `install --force` when they want to update.
- Do **not** ship a Claude Code plugin manifest (`plugin.json` / `.claude-plugin/`) as part of this spec. That's a separate, larger effort — spec it independently if/when there's demand.
- Do **not** support remote skill sources (URLs, git refs). The bundled file is the only source.
