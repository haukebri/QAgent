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
const delayMs = Number.parseInt(process.env.QAGENT_CLAUDE_DELAY_MS ?? "0", 10);

if (stdoutText) {
  process.stdout.write(stdoutText);
}

if (stderrText) {
  process.stderr.write(stderrText);
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

  const result = await runCli({
    cwd: tempDir,
    args: ["--url", "https://example.com", "--goal", "Check the homepage loads"],
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      QAGENT_CLAUDE_STDOUT: "stub stdout\n",
      QAGENT_CLAUDE_STDERR: "stub stderr\n",
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
});

test("a second run with the same goal gets a fresh directory instead of reusing stale artifacts", async (t) => {
  const tempDir = await makeTempDir(t);
  const binDir = await createClaudeStub(tempDir);
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

  const result = await runCli({
    cwd: tempDir,
    args: ["--url", "https://example.com", "--goal", "Goal"],
    env: {
      ...process.env,
      PATH: "/usr/bin:/bin",
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

  const result = await runCli({
    cwd: tempDir,
    args: ["--url", "https://example.com", "--goal", "Goal", "--timeout", "50"],
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      QAGENT_CLAUDE_DELAY_MS: "2000",
    },
  });

  assert.equal(result.code, 1);
  assert.match(result.stdout, /Run hit the wall-clock timeout after 50ms/);
  assert.doesNotMatch(result.stdout, /Claude Code crashed/);

  const [runDir] = await getRunDirs(tempDir);
  const logText = await readFile(path.join(tempDir, ".qagent", "runs", runDir, "claude-session.log"), "utf8");
  assert.match(logText, /Timeout reached after 50ms; stopping Claude/);
});

for (const scenario of [
  {
    name: "rejects a non-numeric --max-steps value",
    args: ["--url", "https://example.com", "--goal", "Goal", "--max-steps", "abc"],
    errorText: "Error: --max-steps must be a positive integer.",
  },
  {
    name: "rejects a non-positive --max-steps value",
    args: ["--url", "https://example.com", "--goal", "Goal", "--max-steps", "0"],
    errorText: "Error: --max-steps must be a positive integer.",
  },
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
