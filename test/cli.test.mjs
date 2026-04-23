import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const cliPath = path.join(repoRoot, "dist", "cli.js");

async function makeTempDir(t) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "qagent-cli-test-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  return tempDir;
}

async function createClaudeStub(tempDir) {
  const binDir = path.join(tempDir, "bin");
  const helperPath = path.join(binDir, "claude-helper.mjs");
  await mkdir(binDir, { recursive: true });

  await writeFile(
    helperPath,
    `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

function resolveMode() {
  const sequence = process.env.QAGENT_CLAUDE_MODE_SEQUENCE ?? "";
  if (!sequence) {
    return process.env.QAGENT_CLAUDE_MODE ?? "pass";
  }

  const statePath = process.env.QAGENT_CLAUDE_MODE_STATE_PATH;
  if (!statePath) {
    throw new Error("QAGENT_CLAUDE_MODE_STATE_PATH is required when QAGENT_CLAUDE_MODE_SEQUENCE is set.");
  }

  const modes = sequence
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const currentIndex = (() => {
    try {
      return Number.parseInt(readFileSync(statePath, "utf8"), 10) || 0;
    } catch {
      return 0;
    }
  })();
  const mode = modes[Math.min(currentIndex, modes.length - 1)] ?? "pass";
  writeFileSync(statePath, String(currentIndex + 1));
  return mode;
}

if (process.argv.includes("--version")) {
  process.stdout.write("claude 0.0.0-test\\n");
  process.exit(0);
}

const promptIndex = process.argv.indexOf("-p");
const prompt = promptIndex >= 0 ? process.argv[promptIndex + 1] ?? "" : "";
const mode = resolveMode();
const stdoutText = process.env.QAGENT_CLAUDE_STDOUT ?? "";
const stderrText = process.env.QAGENT_CLAUDE_STDERR ?? "";
const capturePromptPath = process.env.QAGENT_CAPTURE_PROMPT ?? "";
const captureArgsPath = process.env.QAGENT_CAPTURE_CLAUDE_ARGS ?? "";
const captureEnvPath = process.env.QAGENT_CAPTURE_CLAUDE_ENV ?? "";
const captureCwdPath = process.env.QAGENT_CAPTURE_CLAUDE_CWD ?? "";
const delayMs = Number.parseInt(process.env.QAGENT_CLAUDE_DELAY_MS ?? "0", 10);

if (stdoutText) {
  process.stdout.write(stdoutText);
}

if (stderrText) {
  process.stderr.write(stderrText);
}

if (capturePromptPath) {
  writeFileSync(capturePromptPath, prompt);
}

if (captureArgsPath) {
  writeFileSync(captureArgsPath, JSON.stringify(process.argv.slice(2), null, 2));
}

if (captureEnvPath) {
  writeFileSync(captureEnvPath, JSON.stringify(process.env, null, 2));
}

if (captureCwdPath) {
  writeFileSync(captureCwdPath, process.cwd());
}

if (Number.isFinite(delayMs) && delayMs > 0) {
  await delay(delayMs);
}

if (mode === "crash") {
  process.exit(Number.parseInt(process.env.QAGENT_CLAUDE_EXIT_CODE ?? "17", 10));
}

if (mode === "no-result") {
  process.exit(0);
}

const match = prompt.match(/WHEN DONE, WRITE A RESULT FILE TO:\\s*(.+)/);
if (!match) {
  console.error("Missing result path in prompt");
  process.exit(9);
}

const resultPath = match[1].trim();
mkdirSync(path.dirname(resultPath), { recursive: true });
writeFileSync(
  resultPath,
  JSON.stringify({
    status: process.env.QAGENT_RESULT_STATUS ?? "pass",
    summary: process.env.QAGENT_RESULT_SUMMARY ?? "Stubbed pass",
    stepsTaken: 1,
    evidence: [],
  }),
);
`,
    "utf8",
  );

  const unixWrapper = path.join(binDir, "claude");
  await writeFile(
    unixWrapper,
    `#!/bin/sh
exec node "${helperPath}" "$@"
`,
    "utf8",
  );
  await chmod(unixWrapper, 0o755);

  const windowsWrapper = path.join(binDir, "claude.cmd");
  await writeFile(
    windowsWrapper,
    `@echo off
node "${helperPath}" %*
`,
    "utf8",
  );

  return binDir;
}

async function createCodexStub(tempDir) {
  const binDir = path.join(tempDir, "bin");
  const helperPath = path.join(binDir, "codex-helper.mjs");
  await mkdir(binDir, { recursive: true });

  await writeFile(
    helperPath,
    `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

function resolveMode() {
  const sequence = process.env.QAGENT_CODEX_MODE_SEQUENCE ?? "";
  if (!sequence) {
    return process.env.QAGENT_CODEX_MODE ?? "pass";
  }

  const statePath = process.env.QAGENT_CODEX_MODE_STATE_PATH;
  if (!statePath) {
    throw new Error("QAGENT_CODEX_MODE_STATE_PATH is required when QAGENT_CODEX_MODE_SEQUENCE is set.");
  }

  const modes = sequence
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const currentIndex = (() => {
    try {
      return Number.parseInt(readFileSync(statePath, "utf8"), 10) || 0;
    } catch {
      return 0;
    }
  })();
  const mode = modes[Math.min(currentIndex, modes.length - 1)] ?? "pass";
  writeFileSync(statePath, String(currentIndex + 1));
  return mode;
}

if (process.argv.includes("--version")) {
  process.stdout.write("codex 0.0.0-test\\n");
  process.exit(0);
}

const prompt = process.argv[2] === "exec" ? readFileSync(0, "utf8") : "";
const mode = resolveMode();
const stdoutText = process.env.QAGENT_CODEX_STDOUT ?? "";
const stderrText = process.env.QAGENT_CODEX_STDERR ?? "";
const capturePromptPath = process.env.QAGENT_CAPTURE_PROMPT ?? "";
const captureArgsPath = process.env.QAGENT_CAPTURE_CODEX_ARGS ?? "";
const captureEnvPath = process.env.QAGENT_CAPTURE_CODEX_ENV ?? "";
const captureCwdPath = process.env.QAGENT_CAPTURE_CODEX_CWD ?? "";
const delayMs = Number.parseInt(process.env.QAGENT_CODEX_DELAY_MS ?? "0", 10);

if (stdoutText) {
  process.stdout.write(stdoutText);
}

if (stderrText) {
  process.stderr.write(stderrText);
}

if (capturePromptPath) {
  writeFileSync(capturePromptPath, prompt);
}

if (captureArgsPath) {
  writeFileSync(captureArgsPath, JSON.stringify(process.argv.slice(2), null, 2));
}

if (captureEnvPath) {
  writeFileSync(captureEnvPath, JSON.stringify(process.env, null, 2));
}

if (captureCwdPath) {
  writeFileSync(captureCwdPath, process.cwd());
}

if (Number.isFinite(delayMs) && delayMs > 0) {
  await delay(delayMs);
}

if (mode === "crash") {
  process.exit(Number.parseInt(process.env.QAGENT_CODEX_EXIT_CODE ?? "17", 10));
}

if (mode === "no-result") {
  process.exit(0);
}

const match = prompt.match(/WHEN DONE, WRITE A RESULT FILE TO:\\s*(.+)/);
const resultPath = process.env.RESULT_PATH ?? match?.[1]?.trim() ?? "";
if (!resultPath) {
  console.error("Missing result path in prompt");
  process.exit(9);
}

mkdirSync(path.dirname(resultPath), { recursive: true });
writeFileSync(
  resultPath,
  JSON.stringify({
    status: process.env.QAGENT_RESULT_STATUS ?? "pass",
    summary: process.env.QAGENT_RESULT_SUMMARY ?? "Stubbed pass",
    stepsTaken: 1,
    evidence: [],
  }),
);
`,
    "utf8",
  );

  const unixWrapper = path.join(binDir, "codex");
  await writeFile(
    unixWrapper,
    `#!/bin/sh
exec node "${helperPath}" "$@"
`,
    "utf8",
  );
  await chmod(unixWrapper, 0o755);

  const windowsWrapper = path.join(binDir, "codex.cmd");
  await writeFile(
    windowsWrapper,
    `@echo off
node "${helperPath}" %*
`,
    "utf8",
  );

  return binDir;
}

async function createAgentBrowserStub(tempDir) {
  const binDir = path.join(tempDir, "bin");
  await mkdir(binDir, { recursive: true });

  const unixWrapper = path.join(binDir, "agent-browser");
  await writeFile(
    unixWrapper,
    `#!/bin/sh
if [ -n "$QAGENT_AGENT_BROWSER_LOG_PATH" ]; then
  printf '%s\\n' "$*" >> "$QAGENT_AGENT_BROWSER_LOG_PATH"
fi

cmd=""
for arg in "$@"; do
  case "$arg" in
    open|close|set|session|snapshot)
      cmd="$arg"
      break
      ;;
  esac
done

if [ "$QAGENT_AGENT_BROWSER_MODE" = "fail" ]; then
  echo "\${QAGENT_AGENT_BROWSER_STDERR:-agent-browser failed}" >&2
  exit "\${QAGENT_AGENT_BROWSER_EXIT_CODE:-23}"
fi

if [ "$QAGENT_AGENT_BROWSER_MODE" = "fail-open" ] && [ "$cmd" = "open" ]; then
  echo "\${QAGENT_AGENT_BROWSER_STDERR:-agent-browser failed}" >&2
  exit "\${QAGENT_AGENT_BROWSER_EXIT_CODE:-23}"
fi
exit 0
`,
    "utf8",
  );
  await chmod(unixWrapper, 0o755);

  const windowsWrapper = path.join(binDir, "agent-browser.cmd");
  await writeFile(
    windowsWrapper,
    `@echo off
if not "%QAGENT_AGENT_BROWSER_LOG_PATH%"=="" (
  echo %*>>"%QAGENT_AGENT_BROWSER_LOG_PATH%"
)

set cmd=
for %%A in (%*) do (
  if "%%A"=="open" set cmd=open
  if "%%A"=="close" set cmd=close
  if "%%A"=="set" set cmd=set
  if "%%A"=="session" set cmd=session
  if "%%A"=="snapshot" set cmd=snapshot
)

if "%QAGENT_AGENT_BROWSER_MODE%"=="fail" (
  1>&2 echo %QAGENT_AGENT_BROWSER_STDERR%
  if "%QAGENT_AGENT_BROWSER_EXIT_CODE%"=="" exit /b 23
  exit /b %QAGENT_AGENT_BROWSER_EXIT_CODE%
)
if "%QAGENT_AGENT_BROWSER_MODE%"=="fail-open" if "%cmd%"=="open" (
  1>&2 echo %QAGENT_AGENT_BROWSER_STDERR%
  if "%QAGENT_AGENT_BROWSER_EXIT_CODE%"=="" exit /b 23
  exit /b %QAGENT_AGENT_BROWSER_EXIT_CODE%
)
exit /b 0
`,
    "utf8",
  );

  return binDir;
}

function runCli({ args, cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function getInstalledSkillPath(claudeConfigDir) {
  return path.join(claudeConfigDir, "skills", "qagent", "SKILL.md");
}

function getBundledSkillPath() {
  return path.join(repoRoot, "skills", "qagent", "SKILL.md");
}

function getBundledSkillCorePath() {
  return path.join(repoRoot, "skills", "qagent", "core.md");
}

async function getRunDirs(tempDir) {
  const runsRoot = path.join(tempDir, ".qagent", "runs");
  const entries = await readdir(runsRoot, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

test("one-off run succeeds and writes result plus session log", async (t) => {
  const tempDir = await makeTempDir(t);
  const binDir = await createClaudeStub(tempDir);
  await createAgentBrowserStub(tempDir);

  const result = await runCli({
    cwd: tempDir,
    args: ["--url", "https://example.com", "--goal", "Check the homepage loads"],
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      QAGENT_CLAUDE_STDOUT: "stub stdout\n",
      QAGENT_CLAUDE_STDERR: "stub stderr\n",
      QAGENT_AGENT_BROWSER_LOG_PATH: path.join(tempDir, "agent-browser.log"),
    },
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /stub stdout/);
  assert.match(result.stdout, /\[QAgent\] PASS: Stubbed pass/);
  assert.match(result.stderr, /stub stderr/);

  const [runDir] = await getRunDirs(tempDir);
  assert.ok(runDir, "expected one run directory to be created");

  const runsRoot = path.join(tempDir, ".qagent", "runs");
  const writtenResult = JSON.parse(await readFile(path.join(runsRoot, runDir, "result.json"), "utf8"));
  assert.equal(writtenResult.status, "pass");
  assert.equal(writtenResult.summary, "Stubbed pass");

  const logText = await readFile(path.join(runsRoot, runDir, "claude-session.log"), "utf8");
  assert.match(logText, /stub stdout/);
  assert.match(logText, /stub stderr/);

  const sessionName = result.stdout.match(/Browser ready \(session: ([^)]+)\)/)?.[1];
  assert.ok(sessionName, "expected browser session name in stdout");

  const browserLog = await readFile(path.join(tempDir, "agent-browser.log"), "utf8");
  assert.match(browserLog, new RegExp(`--session ${sessionName} open https://example\\.com`));
  assert.match(browserLog, new RegExp(`--session ${sessionName} close`));
});

test("one-off run succeeds with --vendor codex and writes result plus session log", async (t) => {
  const tempDir = await makeTempDir(t);
  const binDir = await createCodexStub(tempDir);
  await createAgentBrowserStub(tempDir);

  const result = await runCli({
    cwd: tempDir,
    args: ["--vendor", "codex", "--url", "https://example.com", "--goal", "Check the homepage loads"],
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      QAGENT_CODEX_STDOUT: "stub codex stdout\n",
      QAGENT_CODEX_STDERR: "stub codex stderr\n",
      QAGENT_AGENT_BROWSER_LOG_PATH: path.join(tempDir, "agent-browser.log"),
    },
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /\[QAgent\] PASS: Stubbed pass/);
  assert.doesNotMatch(result.stdout, /stub codex stdout/);
  assert.doesNotMatch(result.stderr, /stub codex stderr/);

  const [runDir] = await getRunDirs(tempDir);
  assert.ok(runDir, "expected one run directory to be created");

  const runsRoot = path.join(tempDir, ".qagent", "runs");
  const writtenResult = JSON.parse(await readFile(path.join(runsRoot, runDir, "result.json"), "utf8"));
  assert.equal(writtenResult.status, "pass");
  assert.equal(writtenResult.summary, "Stubbed pass");

  const logText = await readFile(path.join(runsRoot, runDir, "codex-session.log"), "utf8");
  assert.match(logText, /stub codex stdout/);
  assert.match(logText, /stub codex stderr/);

  const sessionName = result.stdout.match(/Browser ready \(session: ([^)]+)\)/)?.[1];
  assert.ok(sessionName, "expected browser session name in stdout");

  const browserLog = await readFile(path.join(tempDir, "agent-browser.log"), "utf8");
  assert.match(browserLog, new RegExp(`--session ${sessionName} open https://example\\.com`));
  assert.match(browserLog, new RegExp(`--session ${sessionName} close`));
});

test("codex runs in a workspace-write sandbox with an isolated cwd and filtered environment", async (t) => {
  const tempDir = await makeTempDir(t);
  const binDir = await createCodexStub(tempDir);
  await createAgentBrowserStub(tempDir);
  const capturedArgsPath = path.join(tempDir, "codex-args.json");
  const capturedEnvPath = path.join(tempDir, "codex-env.json");
  const capturedCwdPath = path.join(tempDir, "codex-cwd.txt");

  const result = await runCli({
    cwd: tempDir,
    args: ["--vendor", "codex", "--url", "https://example.com", "--goal", "Check the homepage loads"],
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      OPENAI_API_KEY: "test-openai-key",
      QAGENT_CAPTURE_CODEX_ARGS: capturedArgsPath,
      QAGENT_CAPTURE_CODEX_ENV: capturedEnvPath,
      QAGENT_CAPTURE_CODEX_CWD: capturedCwdPath,
      SHOULD_NOT_LEAK: "super-secret",
    },
  });

  assert.equal(result.code, 0);

  const args = JSON.parse(await readFile(capturedArgsPath, "utf8"));
  assert.ok(args.includes("--sandbox"));
  assert.ok(args.includes("workspace-write"));
  assert.ok(args.includes("--ephemeral"));
  assert.ok(args.includes("--add-dir"));
  assert.ok(args.includes("-c"));
  assert.ok(args.some((arg) => arg.includes("shell_environment_policy.include_only")));
  assert.ok(args.some((arg) => arg.includes("AGENT_BROWSER_SOCKET_DIR")));
  assert.doesNotMatch(args.join(" "), /danger-full-access/);

  const childEnv = JSON.parse(await readFile(capturedEnvPath, "utf8"));
  assert.equal(childEnv.RESULT_PATH.endsWith("result.json"), true);
  assert.equal(childEnv.OPENAI_API_KEY, "test-openai-key");
  assert.equal(childEnv.SHOULD_NOT_LEAK, undefined);

  const childCwd = (await readFile(capturedCwdPath, "utf8")).trim();
  assert.notEqual(childCwd, tempDir);
  assert.doesNotMatch(childCwd, new RegExp(`${tempDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
});

test("claude runs from an isolated cwd and only adds explicit artifact directories", async (t) => {
  const tempDir = await makeTempDir(t);
  const binDir = await createClaudeStub(tempDir);
  await createAgentBrowserStub(tempDir);
  const capturedArgsPath = path.join(tempDir, "claude-args.json");
  const capturedEnvPath = path.join(tempDir, "claude-env.json");
  const capturedCwdPath = path.join(tempDir, "claude-cwd.txt");

  const result = await runCli({
    cwd: tempDir,
    args: ["--url", "https://example.com", "--goal", "Check the homepage loads"],
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      ANTHROPIC_API_KEY: "test-anthropic-key",
      QAGENT_CAPTURE_CLAUDE_ARGS: capturedArgsPath,
      QAGENT_CAPTURE_CLAUDE_ENV: capturedEnvPath,
      QAGENT_CAPTURE_CLAUDE_CWD: capturedCwdPath,
      SHOULD_NOT_LEAK: "super-secret",
    },
  });

  assert.equal(result.code, 0);

  const args = JSON.parse(await readFile(capturedArgsPath, "utf8"));
  assert.ok(args.includes("--bare"));
  assert.ok(args.includes("--tools"));
  assert.ok(args.includes("--add-dir"));
  assert.ok(args.includes("--allowedTools"));

  const childEnv = JSON.parse(await readFile(capturedEnvPath, "utf8"));
  assert.equal(childEnv.ANTHROPIC_API_KEY, "test-anthropic-key");
  assert.equal(childEnv.SHOULD_NOT_LEAK, undefined);

  const childCwd = (await readFile(capturedCwdPath, "utf8")).trim();
  assert.notEqual(childCwd, tempDir);
  assert.doesNotMatch(childCwd, new RegExp(`${tempDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
});

test("one-off run can load baseUrl and defaults from qagent.config.json in the project root", async (t) => {
  const tempDir = await makeTempDir(t);
  const binDir = await createClaudeStub(tempDir);
  await createAgentBrowserStub(tempDir);
  const capturedPromptPath = path.join(tempDir, "captured-prompt.txt");

  await mkdir(path.join(tempDir, ".qagent"), { recursive: true });
  await writeFile(
    path.join(tempDir, "qagent.config.json"),
    JSON.stringify({
      baseUrl: "https://config.example.com",
      credentialsFile: ".qagent/test-credentials.json",
      timeoutMs: 9876,
    }),
    "utf8",
  );
  await writeFile(
    path.join(tempDir, ".qagent", "test-credentials.json"),
    JSON.stringify({
      basicAuth: {
        username: "staging",
        password: "secret-basic",
      },
      users: [
        {
          label: "default",
          email: "user@example.com",
          password: "secret-user",
        },
      ],
    }),
    "utf8",
  );

  const result = await runCli({
    cwd: tempDir,
    args: ["--goal", "I can see the dashboard"],
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      QAGENT_CAPTURE_PROMPT: capturedPromptPath,
    },
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /\[QAgent\] PASS: Stubbed pass/);

  const promptText = await readFile(capturedPromptPath, "utf8");
  assert.match(promptText, /TARGET URL: https:\/\/config\.example\.com/);
  assert.match(promptText, /TEST CREDENTIALS \(use as needed\):/);
  assert.match(promptText, /"email": "user@example\.com"/);
  assert.doesNotMatch(promptText, /secret-basic/);
});

test("one-off run can load vendor from qagent.config.json", async (t) => {
  const tempDir = await makeTempDir(t);
  const binDir = await createCodexStub(tempDir);
  await createAgentBrowserStub(tempDir);
  const capturedPromptPath = path.join(tempDir, "captured-prompt.txt");

  await writeFile(
    path.join(tempDir, "qagent.config.json"),
    JSON.stringify({
      vendor: "codex",
      baseUrl: "https://config.example.com",
    }),
    "utf8",
  );

  const result = await runCli({
    cwd: tempDir,
    args: ["--goal", "I can see the dashboard"],
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      QAGENT_CAPTURE_PROMPT: capturedPromptPath,
    },
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /\[QAgent\] PASS: Stubbed pass/);

  const promptText = await readFile(capturedPromptPath, "utf8");
  assert.match(promptText, /TARGET URL: https:\/\/config\.example\.com/);
  assert.match(promptText, /You are an end-to-end browser tester/);
  assert.match(promptText, /RESULT_PATH/);
  assert.doesNotMatch(promptText, /You are QAgent/);
  assert.doesNotMatch(promptText, /\.qagent\//);
});

test("skills description from config is included in the prompt", async (t) => {
  const tempDir = await makeTempDir(t);
  const binDir = await createClaudeStub(tempDir);
  await createAgentBrowserStub(tempDir);
  const capturedPromptPath = path.join(tempDir, "skills-prompt.txt");

  await writeFile(
    path.join(tempDir, "qagent.config.json"),
    JSON.stringify({
      baseUrl: "https://config.example.com",
      skillsFile: "skills.md",
    }),
    "utf8",
  );
  await writeFile(
    path.join(tempDir, "skills.md"),
    `- This is a B2B dashboard app.
- The main post-login landing page is called "Overview".
- "Workspace" means the currently selected customer account.
`,
    "utf8",
  );

  const result = await runCli({
    cwd: tempDir,
    args: ["--goal", "I can see the dashboard overview"],
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      QAGENT_CAPTURE_PROMPT: capturedPromptPath,
    },
  });

  assert.equal(result.code, 0);

  const promptText = await readFile(capturedPromptPath, "utf8");
  assert.match(promptText, /SKILLS DESCRIPTION:/);
  assert.match(promptText, /This is a B2B dashboard app/);
  assert.match(promptText, /"Workspace" means the currently selected customer account/);
});

test("one-off run can load config from an explicit --config path", async (t) => {
  const tempDir = await makeTempDir(t);
  const binDir = await createClaudeStub(tempDir);
  await createAgentBrowserStub(tempDir);
  const customConfigPath = path.join(tempDir, "fixtures", "custom.qagent.json");
  const capturedPromptPath = path.join(tempDir, "explicit-config-prompt.txt");

  await mkdir(path.dirname(customConfigPath), { recursive: true });
  await writeFile(
    customConfigPath,
    JSON.stringify({
      baseUrl: "https://explicit.example.com",
    }),
    "utf8",
  );

  const result = await runCli({
    cwd: tempDir,
    args: ["--config", customConfigPath, "--goal", "I can log in"],
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      QAGENT_CAPTURE_PROMPT: capturedPromptPath,
    },
  });

  assert.equal(result.code, 0);

  const promptText = await readFile(capturedPromptPath, "utf8");
  assert.match(promptText, /TARGET URL: https:\/\/explicit\.example\.com/);
});

test("explicit --credentials overrides credentialsFile from config", async (t) => {
  const tempDir = await makeTempDir(t);
  const binDir = await createClaudeStub(tempDir);
  await createAgentBrowserStub(tempDir);
  const capturedPromptPath = path.join(tempDir, "override-credentials-prompt.txt");

  await mkdir(path.join(tempDir, ".qagent"), { recursive: true });
  await writeFile(
    path.join(tempDir, "qagent.config.json"),
    JSON.stringify({
      baseUrl: "https://config.example.com",
      credentialsFile: ".qagent/default-credentials.json",
    }),
    "utf8",
  );
  await writeFile(
    path.join(tempDir, ".qagent", "default-credentials.json"),
    JSON.stringify({
      users: [
        {
          label: "default",
          email: "default@example.com",
          password: "default-password",
        },
      ],
    }),
    "utf8",
  );
  await writeFile(
    path.join(tempDir, ".qagent", "override-credentials.json"),
    JSON.stringify({
      users: [
        {
          label: "admin",
          username: "admin-user",
          password: "override-password",
        },
      ],
    }),
    "utf8",
  );

  const result = await runCli({
    cwd: tempDir,
    args: ["--goal", "I can log in", "--credentials", ".qagent/override-credentials.json"],
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      QAGENT_CAPTURE_PROMPT: capturedPromptPath,
    },
  });

  assert.equal(result.code, 0);

  const promptText = await readFile(capturedPromptPath, "utf8");
  assert.match(promptText, /"username": "admin-user"/);
  assert.doesNotMatch(promptText, /default@example\.com/);
});

test("credentials support env var interpolation when explicitly allowlisted", async (t) => {
  const tempDir = await makeTempDir(t);
  const binDir = await createClaudeStub(tempDir);
  await createAgentBrowserStub(tempDir);
  const capturedPromptPath = path.join(tempDir, "env-credentials-prompt.txt");

  await mkdir(path.join(tempDir, ".qagent"), { recursive: true });
  await writeFile(
    path.join(tempDir, "qagent.config.json"),
    JSON.stringify({
      baseUrl: "https://config.example.com",
      credentialsFile: ".qagent/test-credentials.json",
    }),
    "utf8",
  );
  await writeFile(
    path.join(tempDir, ".qagent", "test-credentials.json"),
    JSON.stringify({
      basicAuth: {
        username: "staging",
        password: "${BASIC_AUTH_PASSWORD}",
      },
      users: [
        {
          label: "default",
          email: "user@example.com",
          password: "${TEST_USER_PASSWORD}",
        },
      ],
    }),
    "utf8",
  );

  const result = await runCli({
    cwd: tempDir,
    args: ["--goal", "I can log in", "--allow-credential-env", "BASIC_AUTH_PASSWORD,TEST_USER_PASSWORD"],
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      QAGENT_CAPTURE_PROMPT: capturedPromptPath,
      BASIC_AUTH_PASSWORD: "interpolated-basic-password",
      TEST_USER_PASSWORD: "interpolated-user-password",
    },
  });

  assert.equal(result.code, 0);

  const promptText = await readFile(capturedPromptPath, "utf8");
  assert.match(promptText, /interpolated-user-password/);
  assert.doesNotMatch(promptText, /interpolated-basic-password/);
});

test("credentials interpolation rejects env vars unless they are explicitly allowlisted", async (t) => {
  const tempDir = await makeTempDir(t);

  await mkdir(path.join(tempDir, ".qagent"), { recursive: true });
  await writeFile(
    path.join(tempDir, "qagent.config.json"),
    JSON.stringify({
      baseUrl: "https://config.example.com",
      credentialsFile: ".qagent/test-credentials.json",
    }),
    "utf8",
  );
  await writeFile(
    path.join(tempDir, ".qagent", "test-credentials.json"),
    JSON.stringify({
      users: [
        {
          label: "default",
          email: "user@example.com",
          password: "${TEST_USER_PASSWORD}",
        },
      ],
    }),
    "utf8",
  );

  const result = await runCli({
    cwd: tempDir,
    args: ["--goal", "I can log in"],
    env: {
      ...process.env,
      PATH: "/usr/bin:/bin",
      TEST_USER_PASSWORD: "interpolated-user-password",
    },
  });

  assert.equal(result.code, 2);
  assert.match(result.stderr, /allow-credential-env/);
  assert.equal(result.stdout, "");
});

test("a second run with the same goal gets a fresh directory instead of reusing stale artifacts", async (t) => {
  const tempDir = await makeTempDir(t);
  const binDir = await createClaudeStub(tempDir);
  await createAgentBrowserStub(tempDir);
  const envBase = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
  };

  const firstRun = await runCli({
    cwd: tempDir,
    args: ["--url", "https://example.com", "--goal", "Same goal"],
    env: envBase,
  });
  assert.equal(firstRun.code, 0);

  const secondRun = await runCli({
    cwd: tempDir,
    args: ["--url", "https://example.com", "--goal", "Same goal"],
    env: {
      ...envBase,
      QAGENT_CLAUDE_MODE: "no-result",
    },
  });

  assert.equal(secondRun.code, 1);
  assert.match(secondRun.stdout, /Agent did not produce a valid result file/);

  const runDirs = await getRunDirs(tempDir);
  assert.equal(runDirs.length, 2);
  assert.notEqual(runDirs[0], runDirs[1]);
});

test("missing claude returns a setup error instead of crashing the process", async (t) => {
  const tempDir = await makeTempDir(t);
  const binDir = await createAgentBrowserStub(tempDir);

  const result = await runCli({
    cwd: tempDir,
    args: ["--url", "https://example.com", "--goal", "Goal"],
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}/usr/bin:/bin`,
    },
  });

  assert.equal(result.code, 2);
  assert.match(result.stdout, /Claude Code CLI was not found in PATH/);
  assert.equal(result.stderr, "");

  const [runDir] = await getRunDirs(tempDir);
  const logText = await readFile(path.join(tempDir, ".qagent", "runs", runDir, "claude-session.log"), "utf8");
  assert.match(logText, /Claude Code CLI was not found in PATH/);
});

test("missing codex returns a setup error instead of crashing the process", async (t) => {
  const tempDir = await makeTempDir(t);
  const binDir = await createAgentBrowserStub(tempDir);

  const result = await runCli({
    cwd: tempDir,
    args: ["--vendor", "codex", "--url", "https://example.com", "--goal", "Goal"],
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}/usr/bin:/bin`,
    },
  });

  assert.equal(result.code, 2);
  assert.match(result.stdout, /Codex CLI was not found in PATH/);
  assert.equal(result.stderr, "");

  const [runDir] = await getRunDirs(tempDir);
  const logText = await readFile(path.join(tempDir, ".qagent", "runs", runDir, "codex-session.log"), "utf8");
  assert.match(logText, /Codex CLI was not found in PATH/);
});

test("timeout is classified as blocked instead of a Claude crash", async (t) => {
  const tempDir = await makeTempDir(t);
  const binDir = await createClaudeStub(tempDir);
  await createAgentBrowserStub(tempDir);

  const result = await runCli({
    cwd: tempDir,
    args: ["--url", "https://example.com", "--goal", "Goal", "--timeout", "50"],
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      QAGENT_CLAUDE_DELAY_MS: "2000",
      QAGENT_AGENT_BROWSER_LOG_PATH: path.join(tempDir, "agent-browser.log"),
    },
  });

  assert.equal(result.code, 1);
  assert.match(result.stdout, /Run hit the wall-clock timeout after 50ms/);
  assert.doesNotMatch(result.stdout, /Claude Code crashed/);

  const [runDir] = await getRunDirs(tempDir);
  const logText = await readFile(path.join(tempDir, ".qagent", "runs", runDir, "claude-session.log"), "utf8");
  assert.match(logText, /Timeout reached after 50ms; stopping Claude/);

  const sessionName = result.stdout.match(/Browser ready \(session: ([^)]+)\)/)?.[1];
  assert.ok(sessionName, "expected browser session name in stdout");

  const browserLog = await readFile(path.join(tempDir, "agent-browser.log"), "utf8");
  assert.match(browserLog, new RegExp(`--session ${sessionName} close`));
});

test("skill path prints the resolved install path", async (t) => {
  const tempDir = await makeTempDir(t);
  const claudeConfigDir = path.join(tempDir, "claude-config");

  const result = await runCli({
    cwd: tempDir,
    args: ["skill", "path"],
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
      PATH: "/usr/bin:/bin",
    },
  });

  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.trim(), getInstalledSkillPath(claudeConfigDir));
});

test("skill install copies the bundled skill into CLAUDE_CONFIG_DIR", async (t) => {
  const tempDir = await makeTempDir(t);
  const claudeConfigDir = path.join(tempDir, "claude-config");
  const installedSkillPath = getInstalledSkillPath(claudeConfigDir);

  const result = await runCli({
    cwd: tempDir,
    args: ["skill", "install"],
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
      PATH: "/usr/bin:/bin",
    },
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Installed QAgent skill to/);

  const installedSkill = await readFile(installedSkillPath, "utf8");
  const bundledSkill = await readFile(getBundledSkillPath(), "utf8");
  assert.equal(installedSkill, bundledSkill);
  assert.match(installedSkill, /qagent skills get core/);
  assert.doesNotMatch(installedSkill, /qagent run/);
});

test("second skill install without --force is a no-op", async (t) => {
  const tempDir = await makeTempDir(t);
  const claudeConfigDir = path.join(tempDir, "claude-config");
  const installedSkillPath = getInstalledSkillPath(claudeConfigDir);

  await runCli({
    cwd: tempDir,
    args: ["skill", "install"],
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
      PATH: "/usr/bin:/bin",
    },
  });

  const result = await runCli({
    cwd: tempDir,
    args: ["skill", "install"],
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
      PATH: "/usr/bin:/bin",
    },
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Skill already installed at/);

  const installedSkill = await readFile(installedSkillPath, "utf8");
  const bundledSkill = await readFile(getBundledSkillPath(), "utf8");
  assert.equal(installedSkill, bundledSkill);
});

test("skill install --force overwrites an existing install", async (t) => {
  const tempDir = await makeTempDir(t);
  const claudeConfigDir = path.join(tempDir, "claude-config");
  const installedSkillPath = getInstalledSkillPath(claudeConfigDir);

  await runCli({
    cwd: tempDir,
    args: ["skill", "install"],
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
      PATH: "/usr/bin:/bin",
    },
  });

  await writeFile(installedSkillPath, "stale skill contents\n", "utf8");

  const result = await runCli({
    cwd: tempDir,
    args: ["skill", "install", "--force"],
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
      PATH: "/usr/bin:/bin",
    },
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Installed QAgent skill to/);

  const installedSkill = await readFile(installedSkillPath, "utf8");
  const bundledSkill = await readFile(getBundledSkillPath(), "utf8");
  assert.equal(installedSkill, bundledSkill);
});

test("skills get core prints the runtime skill workflow content", async (t) => {
  const tempDir = await makeTempDir(t);

  const result = await runCli({
    cwd: tempDir,
    args: ["skills", "get", "core"],
    env: {
      ...process.env,
      PATH: "/usr/bin:/bin",
    },
  });

  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");

  const bundledCore = await readFile(getBundledSkillCorePath(), "utf8");
  assert.equal(result.stdout, bundledCore);
  assert.match(result.stdout, /qagent --url <url> --goal/);
  assert.doesNotMatch(result.stdout, /qagent run/);
});

test("skill install --dry-run does not create files", async (t) => {
  const tempDir = await makeTempDir(t);
  const claudeConfigDir = path.join(tempDir, "claude-config");
  const installedSkillPath = getInstalledSkillPath(claudeConfigDir);

  const result = await runCli({
    cwd: tempDir,
    args: ["skill", "install", "--dry-run"],
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
      PATH: "/usr/bin:/bin",
    },
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Would install QAgent skill to/);
  await assert.rejects(readFile(installedSkillPath, "utf8"), { code: "ENOENT" });
});

test("skill uninstall removes the skill file and empty qagent directory", async (t) => {
  const tempDir = await makeTempDir(t);
  const claudeConfigDir = path.join(tempDir, "claude-config");
  const installedSkillPath = getInstalledSkillPath(claudeConfigDir);
  const skillDir = path.dirname(installedSkillPath);
  const skillsDir = path.dirname(skillDir);

  await runCli({
    cwd: tempDir,
    args: ["skill", "install"],
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
      PATH: "/usr/bin:/bin",
    },
  });

  const result = await runCli({
    cwd: tempDir,
    args: ["skill", "uninstall"],
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
      PATH: "/usr/bin:/bin",
    },
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Removed /);
  await assert.rejects(readFile(installedSkillPath, "utf8"), { code: "ENOENT" });
  await assert.rejects(readdir(skillDir), { code: "ENOENT" });
  assert.deepEqual(await readdir(skillsDir), []);
});

test("skill uninstall is friendly when nothing is installed", async (t) => {
  const tempDir = await makeTempDir(t);
  const claudeConfigDir = path.join(tempDir, "claude-config");

  const result = await runCli({
    cwd: tempDir,
    args: ["skill", "uninstall"],
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
      PATH: "/usr/bin:/bin",
    },
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Skill not installed\./);
});

test("doctor succeeds when dependencies are present and agent-browser can launch a browser session", async (t) => {
  const tempDir = await makeTempDir(t);
  const claudeBinDir = await createClaudeStub(tempDir);
  await createAgentBrowserStub(tempDir);
  const claudeConfigDir = path.join(tempDir, "claude-config");

  const result = await runCli({
    cwd: tempDir,
    args: ["doctor"],
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
      PATH: `${claudeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /OK\s+Node\.js/);
  assert.match(result.stdout, /OK\s+Claude Code/);
  assert.match(result.stdout, /OK\s+agent-browser/);
  assert.match(result.stdout, /OK\s+Browser launch/);
  assert.match(result.stdout, /INFO\s+Claude skill\s+Skill not installed \(run: qagent skill install\)/);
});

test("doctor succeeds with --vendor codex when dependencies are present", async (t) => {
  const tempDir = await makeTempDir(t);
  const codexBinDir = await createCodexStub(tempDir);
  await createAgentBrowserStub(tempDir);

  const result = await runCli({
    cwd: tempDir,
    args: ["doctor", "--vendor", "codex"],
    env: {
      ...process.env,
      PATH: `${codexBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /OK\s+Node\.js/);
  assert.match(result.stdout, /OK\s+Codex/);
  assert.match(result.stdout, /OK\s+agent-browser/);
  assert.match(result.stdout, /OK\s+Browser launch/);
  assert.doesNotMatch(result.stdout, /Claude skill/);
});

test("doctor fails when agent-browser cannot launch the browser", async (t) => {
  const tempDir = await makeTempDir(t);
  const claudeBinDir = await createClaudeStub(tempDir);
  await createAgentBrowserStub(tempDir);
  const claudeConfigDir = path.join(tempDir, "claude-config");

  const result = await runCli({
    cwd: tempDir,
    args: ["doctor"],
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
      PATH: `${claudeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
      QAGENT_AGENT_BROWSER_MODE: "fail-open",
      QAGENT_AGENT_BROWSER_STDERR: "browser binary missing",
    },
  });

  assert.equal(result.code, 1);
  assert.match(result.stdout, /MISSING\s+Browser launch/);
  assert.match(result.stdout, /agent-browser install/);
});

test("doctor reports an installed skill as up to date", async (t) => {
  const tempDir = await makeTempDir(t);
  const claudeBinDir = await createClaudeStub(tempDir);
  await createAgentBrowserStub(tempDir);
  const claudeConfigDir = path.join(tempDir, "claude-config");

  await runCli({
    cwd: tempDir,
    args: ["skill", "install"],
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
      PATH: "/usr/bin:/bin",
    },
  });

  const result = await runCli({
    cwd: tempDir,
    args: ["doctor"],
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
      PATH: `${claudeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /INFO\s+Claude skill\s+Skill installed \(up to date\)/);
});

test("doctor reports an installed skill as out of date", async (t) => {
  const tempDir = await makeTempDir(t);
  const claudeBinDir = await createClaudeStub(tempDir);
  await createAgentBrowserStub(tempDir);
  const claudeConfigDir = path.join(tempDir, "claude-config");
  const installedSkillPath = getInstalledSkillPath(claudeConfigDir);

  await mkdir(path.dirname(installedSkillPath), { recursive: true });
  await writeFile(installedSkillPath, "older skill contents\n", "utf8");

  const result = await runCli({
    cwd: tempDir,
    args: ["doctor"],
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
      PATH: `${claudeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /INFO\s+Claude skill\s+Skill installed \(out of date — run: qagent skill install --force\)/);
});

test("suite mode preserves Claude crash exit code", async (t) => {
  const tempDir = await makeTempDir(t);
  const binDir = await createClaudeStub(tempDir);
  await createAgentBrowserStub(tempDir);

  await writeFile(
    path.join(tempDir, "goals.json"),
    JSON.stringify([{ name: "login", goal: "I can log in" }]),
    "utf8",
  );

  const result = await runCli({
    cwd: tempDir,
    args: ["--url", "https://example.com", "--goals", "goals.json"],
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      QAGENT_CLAUDE_MODE: "crash",
    },
  });

  assert.equal(result.code, 3);
  assert.match(result.stdout, /Claude Code crashed/);
});

test("suite mode preserves setup error exit code", async (t) => {
  const tempDir = await makeTempDir(t);
  const binDir = await createClaudeStub(tempDir);
  await createAgentBrowserStub(tempDir);

  await writeFile(
    path.join(tempDir, "goals.json"),
    JSON.stringify([{ name: "login", goal: "I can log in" }]),
    "utf8",
  );

  const result = await runCli({
    cwd: tempDir,
    args: ["--url", "https://example.com", "--goals", "goals.json"],
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      QAGENT_AGENT_BROWSER_MODE: "fail",
      QAGENT_AGENT_BROWSER_STDERR: "stub browser failure",
    },
  });

  assert.equal(result.code, 2);
  assert.match(result.stdout, /Browser pre-start failed/);
});

test("invalid qagent.config.json fails fast as a setup error", async (t) => {
  const tempDir = await makeTempDir(t);

  await writeFile(
    path.join(tempDir, "qagent.config.json"),
    JSON.stringify({
      baseUrl: "not-a-url",
    }),
    "utf8",
  );

  const result = await runCli({
    cwd: tempDir,
    args: ["--goal", "Goal"],
    env: {
      ...process.env,
      PATH: "/usr/bin:/bin",
    },
  });

  assert.equal(result.code, 2);
  assert.match(result.stderr, /Invalid QAgent config/);
  assert.equal(result.stdout, "");
});

test("non-http baseUrl in qagent.config.json fails fast as a setup error", async (t) => {
  const tempDir = await makeTempDir(t);

  await writeFile(
    path.join(tempDir, "qagent.config.json"),
    JSON.stringify({
      baseUrl: "file:///etc/passwd",
    }),
    "utf8",
  );

  const result = await runCli({
    cwd: tempDir,
    args: ["--goal", "Goal"],
    env: {
      ...process.env,
      PATH: "/usr/bin:/bin",
    },
  });

  assert.equal(result.code, 2);
  assert.match(result.stderr, /http or https/);
  assert.equal(result.stdout, "");
});

test("non-http --url values are rejected before browser startup", async (t) => {
  const tempDir = await makeTempDir(t);

  const result = await runCli({
    cwd: tempDir,
    args: ["--url", "file:///etc/passwd", "--goal", "Goal"],
    env: {
      ...process.env,
      PATH: "/usr/bin:/bin",
    },
  });

  assert.equal(result.code, 2);
  assert.match(result.stderr, /--url must use http or https/);
  assert.equal(result.stdout, "");
});

test("invalid qagent credentials file fails fast as a setup error", async (t) => {
  const tempDir = await makeTempDir(t);

  await mkdir(path.join(tempDir, ".qagent"), { recursive: true });
  await writeFile(
    path.join(tempDir, "qagent.config.json"),
    JSON.stringify({
      baseUrl: "https://config.example.com",
      credentialsFile: ".qagent/test-credentials.json",
    }),
    "utf8",
  );
  await writeFile(
    path.join(tempDir, ".qagent", "test-credentials.json"),
    JSON.stringify({
      users: [
        {
          label: "broken-user",
          password: "missing-identifier",
        },
      ],
    }),
    "utf8",
  );

  const result = await runCli({
    cwd: tempDir,
    args: ["--goal", "Goal"],
    env: {
      ...process.env,
      PATH: "/usr/bin:/bin",
    },
  });

  assert.equal(result.code, 2);
  assert.match(result.stderr, /Invalid QAgent credentials/);
  assert.equal(result.stdout, "");
});

test("blocked runs are retried up to --retries and can recover", async (t) => {
  const tempDir = await makeTempDir(t);
  const binDir = await createClaudeStub(tempDir);
  await createAgentBrowserStub(tempDir);
  const statePath = path.join(tempDir, "claude-retry-state.txt");

  const result = await runCli({
    cwd: tempDir,
    args: ["--url", "https://example.com", "--goal", "Goal", "--retries", "1"],
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      QAGENT_CLAUDE_MODE_SEQUENCE: "no-result,pass",
      QAGENT_CLAUDE_MODE_STATE_PATH: statePath,
    },
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Retrying blocked run/);
  assert.match(result.stdout, /\[QAgent\] PASS: Stubbed pass/);

  const runDirs = await getRunDirs(tempDir);
  assert.equal(runDirs.length, 2);
});

for (const scenario of [
  {
    name: "rejects a non-numeric --timeout value",
    args: ["--url", "https://example.com", "--goal", "Goal", "--timeout", "abc"],
    errorText: "Error: --timeout must be a positive integer.",
  },
  {
    name: "rejects a negative --timeout value before cac misparses it",
    args: ["--url", "https://example.com", "--goal", "Goal", "--timeout", "-1"],
    errorText: "Error: --timeout must be a positive integer.",
  },
  {
    name: "rejects a negative --retries value before cac misparses it",
    args: ["--url", "https://example.com", "--goal", "Goal", "--retries", "-1"],
    errorText: "Error: --retries must be a non-negative integer.",
  },
]) {
  test(scenario.name, async (t) => {
    const tempDir = await makeTempDir(t);
    const emptyBinDir = path.join(tempDir, "bin");
    await mkdir(emptyBinDir, { recursive: true });

    const result = await runCli({
      cwd: tempDir,
      args: scenario.args,
      env: {
        ...process.env,
        PATH: emptyBinDir,
      },
    });

    assert.equal(result.code, 2);
    assert.match(result.stderr, new RegExp(scenario.errorText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(result.stdout, "");
  });
}

test("--retries 0 is accepted", async (t) => {
  const tempDir = await makeTempDir(t);
  const binDir = await createClaudeStub(tempDir);
  await createAgentBrowserStub(tempDir);

  const result = await runCli({
    cwd: tempDir,
    args: ["--url", "https://example.com", "--goal", "Goal", "--retries", "0"],
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /\[QAgent\] PASS: Stubbed pass/);
});
