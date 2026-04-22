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
    `import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const promptIndex = process.argv.indexOf("-p");
const prompt = promptIndex >= 0 ? process.argv[promptIndex + 1] ?? "" : "";
const mode = process.env.QAGENT_CLAUDE_MODE ?? "pass";
const stdoutText = process.env.QAGENT_CLAUDE_STDOUT ?? "";
const stderrText = process.env.QAGENT_CLAUDE_STDERR ?? "";
const capturePromptPath = process.env.QAGENT_CAPTURE_PROMPT ?? "";
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
  assert.match(promptText, /"username": "staging"/);
  assert.match(promptText, /"email": "user@example\.com"/);
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

test("credentials support env var interpolation", async (t) => {
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
    args: ["--goal", "I can log in"],
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
  assert.match(promptText, /interpolated-basic-password/);
  assert.match(promptText, /interpolated-user-password/);
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

test("doctor succeeds when dependencies are present and agent-browser can launch a browser session", async (t) => {
  const tempDir = await makeTempDir(t);
  const claudeBinDir = await createClaudeStub(tempDir);
  await createAgentBrowserStub(tempDir);

  const result = await runCli({
    cwd: tempDir,
    args: ["doctor"],
    env: {
      ...process.env,
      PATH: `${claudeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /OK\s+Node\.js/);
  assert.match(result.stdout, /OK\s+Claude Code/);
  assert.match(result.stdout, /OK\s+agent-browser/);
  assert.match(result.stdout, /OK\s+Browser launch/);
});

test("doctor fails when agent-browser cannot launch the browser", async (t) => {
  const tempDir = await makeTempDir(t);
  const claudeBinDir = await createClaudeStub(tempDir);
  await createAgentBrowserStub(tempDir);

  const result = await runCli({
    cwd: tempDir,
    args: ["doctor"],
    env: {
      ...process.env,
      PATH: `${claudeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
      QAGENT_AGENT_BROWSER_MODE: "fail-open",
      QAGENT_AGENT_BROWSER_STDERR: "browser binary missing",
    },
  });

  assert.equal(result.code, 1);
  assert.match(result.stdout, /MISSING\s+Browser launch/);
  assert.match(result.stdout, /agent-browser install/);
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
