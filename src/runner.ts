import os from "node:os";
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { closeBrowserSession, startBrowserSession } from "./browser-session.js";
import type { Goal } from "./goals.js";
import { buildPrompt } from "./prompt.js";
import { readResult } from "./result.js";
import { buildSubprocessEnv, getCodexShellEnvironmentIncludeOnly } from "./subprocess-env.js";
import { formatVendorName, getVendorSessionLogFileName, type Vendor } from "./vendor.js";

export interface RunResult {
  status: "pass" | "fail" | "blocked";
  summary: string;
  exitCode: number;
}

function toSlug(goal: string): string {
  const slug = goal
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 30);
  return slug || "goal";
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function createRunDir(goal: string): string {
  const runsRoot = path.resolve(".qagent/runs");
  mkdirSync(runsRoot, { recursive: true });
  return mkdtempSync(path.join(runsRoot, `${timestamp()}-${toSlug(goal)}-`));
}

function formatLaunchError(vendor: Vendor, error: NodeJS.ErrnoException): string {
  const vendorName = formatVendorName(vendor);
  if (error.code === "ENOENT") {
    return `${vendorName} CLI was not found in PATH`;
  }

  return `Failed to launch ${vendorName}: ${error.message}`;
}

function writeLogLine(write: (chunk: string) => void, message: string): void {
  write(`[QAgent] ${message}\n`);
}

function getVendorSessionConfig(opts: {
  vendor: Vendor;
  prompt: string;
  sessionName: string;
  runDir: string;
  executionDir: string;
  browserSocketDir: string;
  resultPath: string;
  screenshotDir: string;
}): {
  bin: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  label: string;
  stdin?: string;
  streamOutput: boolean;
} {
  if (opts.vendor === "codex") {
    return {
      bin: "codex",
      args: [
        "exec",
        "--disable",
        "plugins",
        "--skip-git-repo-check",
        "--sandbox",
        "workspace-write",
        "--add-dir",
        opts.runDir,
        "--add-dir",
        opts.browserSocketDir,
        "--ephemeral",
        "-c",
        `shell_environment_policy.include_only=${JSON.stringify(getCodexShellEnvironmentIncludeOnly())}`,
        "--color",
        "never",
        "-o",
        path.join(opts.runDir, "codex-last-message.txt"),
        "-",
      ],
      cwd: opts.executionDir,
      env: buildSubprocessEnv("codex", {
        AGENT_BROWSER_SESSION: opts.sessionName,
        AGENT_BROWSER_SOCKET_DIR: opts.browserSocketDir,
        RESULT_PATH: opts.resultPath,
        SCREENSHOT_DIR: opts.screenshotDir,
      }),
      label: "Codex",
      stdin: opts.prompt,
      streamOutput: false,
    };
  }

  return {
    bin: "claude",
    args: [
      "-p",
      opts.prompt,
      "--bare",
      "--no-session-persistence",
      "--strict-mcp-config",
      "--no-chrome",
      "--tools",
      "Bash",
      "Write",
      "--allowedTools",
      "Bash(agent-browser:*)",
      "Write",
      "--add-dir",
      opts.runDir,
      "--add-dir",
      opts.browserSocketDir,
    ],
    cwd: opts.executionDir,
    env: buildSubprocessEnv("claude", {
      AGENT_BROWSER_SESSION: opts.sessionName,
      AGENT_BROWSER_SOCKET_DIR: opts.browserSocketDir,
    }),
    label: "Claude",
    streamOutput: true,
  };
}

function getCrashSummary(vendor: Vendor): string {
  return vendor === "claude" ? "Claude Code crashed" : "Codex session crashed";
}

async function runVendorSession(opts: {
  vendor: Vendor;
  prompt: string;
  timeout: number;
  logPath: string;
  sessionName: string;
  runDir: string;
  executionDir: string;
  browserSocketDir: string;
  resultPath: string;
  screenshotDir: string;
}): Promise<
  | { kind: "completed"; code: number | null; signal: NodeJS.Signals | null }
  | { kind: "timeout" }
  | { kind: "launch-error"; error: NodeJS.ErrnoException }
> {
  const logStream = createWriteStream(opts.logPath, { flags: "a" });
  logStream.on("error", (error) => {
    process.stderr.write(`[QAgent] Failed to write ${path.basename(opts.logPath)}: ${error.message}\n`);
  });

  const writeLog = (chunk: string | Buffer) => {
    if (logStream.writableEnded || logStream.destroyed) {
      return;
    }

    logStream.write(chunk);
  };

  try {
    const sessionConfig = getVendorSessionConfig(opts);
    const result = await new Promise<
      | { kind: "completed"; code: number | null; signal: NodeJS.Signals | null }
      | { kind: "timeout" }
      | { kind: "launch-error"; error: NodeJS.ErrnoException }
    >((resolve) => {
      const child = spawn(sessionConfig.bin, sessionConfig.args, {
        cwd: sessionConfig.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: sessionConfig.env,
      });

      let timedOut = false;
      let settled = false;
      let forceKillTimer: NodeJS.Timeout | undefined;
      let timeoutTimer: NodeJS.Timeout | undefined;

      const finish = (
        value:
          | { kind: "completed"; code: number | null; signal: NodeJS.Signals | null }
          | { kind: "timeout" }
          | { kind: "launch-error"; error: NodeJS.ErrnoException },
      ) => {
        if (settled) {
          return;
        }

        settled = true;
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
        }
        if (forceKillTimer) {
          clearTimeout(forceKillTimer);
        }
        resolve(value);
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        if (sessionConfig.streamOutput) {
          process.stdout.write(chunk);
        }
        writeLog(chunk);
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        if (sessionConfig.streamOutput) {
          process.stderr.write(chunk);
        }
        writeLog(chunk);
      });

      if (child.stdin) {
        child.stdin.end(sessionConfig.stdin ?? "");
      }

      child.on("error", (error) => {
        if (settled) {
          return;
        }

        writeLogLine(writeLog, formatLaunchError(opts.vendor, error));
        finish({ kind: "launch-error", error });
      });

      child.on("close", (code, signal) => {
        if (settled) {
          return;
        }

        if (timedOut) {
          finish({ kind: "timeout" });
          return;
        }

        if (code !== 0) {
          writeLogLine(
            writeLog,
            `${sessionConfig.label} exited unexpectedly with code ${code ?? "null"}${signal ? ` (signal ${signal})` : ""}.`,
          );
        }

        finish({ kind: "completed", code, signal });
      });

      timeoutTimer = setTimeout(() => {
        timedOut = true;
        writeLogLine(writeLog, `Timeout reached after ${opts.timeout}ms; stopping ${sessionConfig.label}.`);
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(() => {
          child.kill("SIGKILL");
        }, 5_000);
      }, opts.timeout);
    });

    return result;
  } finally {
    await new Promise<void>((resolve) => {
      logStream.end(() => resolve());
    });
  }
}

export async function runGoal(opts: {
  vendor?: Vendor;
  url: string;
  goal: string;
  credentialsJson?: string;
  skillsDescription?: string;
  basicAuth?: { username: string; password: string };
  timeout?: number;
  headed?: boolean;
}): Promise<RunResult> {
  const vendor = opts.vendor ?? "claude";
  const runDir = createRunDir(opts.goal);

  const resultPath = path.resolve(runDir, "result.json");
  const screenshotDir = path.resolve(runDir);
  const logPath = path.resolve(runDir, getVendorSessionLogFileName(vendor));
  const browserSocketDir = mkdtempSync(path.join(os.tmpdir(), "qagent-ab-"));
  const executionDir = mkdtempSync(path.join(os.tmpdir(), "qagent-exec-"));

  // Pre-start agent-browser session: set credentials + verify URL is reachable
  let browserSession;
  try {
    console.log("[QAgent] Starting browser session...");
    browserSession = startBrowserSession({
      url: opts.url,
      basicAuth: opts.basicAuth,
      headed: opts.headed,
      socketDir: browserSocketDir,
    });
    console.log(`[QAgent] Browser ready (session: ${browserSession.sessionName})`);
    console.log("[QAgent] Starting testing. This might take a minute or two...");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "blocked", summary: `Browser pre-start failed: ${message}`, exitCode: 2 };
  }

  const prompt = buildPrompt({
    vendor,
    url: opts.url,
    goal: opts.goal,
    credentialsJson: opts.credentialsJson ?? "None provided.",
    skillsDescription: opts.skillsDescription ?? "None provided.",
    resultPath,
    screenshotDir,
  });

  const timeout = opts.timeout ?? 180_000;

  try {
    const session = await runVendorSession({
      vendor,
      prompt,
      timeout,
      logPath,
      sessionName: browserSession.sessionName,
      runDir,
      executionDir,
      browserSocketDir: browserSession.socketDir,
      resultPath,
      screenshotDir,
    });

    if (session.kind === "launch-error") {
      return { status: "blocked", summary: formatLaunchError(vendor, session.error), exitCode: 2 };
    }

    if (session.kind === "timeout") {
      return {
        status: "blocked",
        summary: `Run hit the wall-clock timeout after ${timeout}ms`,
        exitCode: 1,
      };
    }

    if (session.code !== 0) {
      return { status: "blocked", summary: getCrashSummary(vendor), exitCode: 3 };
    }

    if (!existsSync(resultPath)) {
      return { status: "blocked", summary: "Agent did not produce a valid result file", exitCode: 1 };
    }

    let result;
    try {
      result = readResult(resultPath);
    } catch {
      return { status: "blocked", summary: "Agent did not produce a valid result file", exitCode: 1 };
    }

    return {
      status: result.status,
      summary: result.summary,
      exitCode: result.status === "pass" ? 0 : 1,
    };
  } finally {
    closeBrowserSession(browserSession);
    if (executionDir !== runDir) {
      rmSync(executionDir, { recursive: true, force: true });
    }
  }
}

export interface GoalResult {
  name: string;
  goal: string;
  status: "pass" | "fail" | "blocked";
  summary: string;
  exitCode: number;
}

export interface SuiteResult {
  results: GoalResult[];
  passed: number;
  failed: number;
  blocked: number;
  exitCode: number;
}

async function runGoalWithRetries(
  opts: Parameters<typeof runGoal>[0],
  retries: number | undefined,
): Promise<RunResult> {
  const maxRetries = retries ?? 0;
  let attempt = 0;

  while (true) {
    const result = await runGoal(opts);
    if (result.status !== "blocked" || attempt >= maxRetries) {
      return result;
    }

    attempt += 1;
    console.log(`[QAgent] Retrying blocked run (attempt ${attempt + 1}/${maxRetries + 1})...`);
  }
}

async function runGoalEntry(
  goalDef: Goal,
  index: number,
  total: number,
  opts: {
    vendor: Vendor;
    url: string;
    credentialsJson?: string;
    skillsDescription?: string;
    basicAuth?: { username: string; password: string };
    timeout?: number;
    headed?: boolean;
    retries?: number;
  },
): Promise<GoalResult> {
  console.log(`\n[QAgent] Goal ${index + 1}/${total}: ${goalDef.name}`);
  console.log(`[QAgent] "${goalDef.goal}"\n`);

  const result = await runGoalWithRetries({
    vendor: opts.vendor,
    url: opts.url,
    goal: goalDef.goal,
    credentialsJson: opts.credentialsJson,
    skillsDescription: opts.skillsDescription,
    basicAuth: opts.basicAuth,
    timeout: opts.timeout,
    headed: opts.headed,
  }, opts.retries);

  const icon = result.status === "pass" ? "PASS" : result.status === "fail" ? "FAIL" : "BLOCKED";
  console.log(`\n[QAgent] ${icon} (${goalDef.name}): ${result.summary}`);

  return {
    name: goalDef.name,
    goal: goalDef.goal,
    status: result.status,
    summary: result.summary,
    exitCode: result.exitCode,
  };
}

function summarize(results: GoalResult[]): SuiteResult {
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const blocked = results.filter((r) => r.status === "blocked").length;
  const exitCode = results.some((r) => r.exitCode === 3)
    ? 3
    : results.some((r) => r.exitCode === 2)
      ? 2
      : failed > 0 || blocked > 0
        ? 1
        : 0;

  return {
    results,
    passed,
    failed,
    blocked,
    exitCode,
  };
}

export async function runSuite(opts: {
  vendor?: Vendor;
  url: string;
  goals: Goal[];
  credentialsJson?: string;
  skillsDescription?: string;
  basicAuth?: { username: string; password: string };
  timeout?: number;
  parallel?: boolean;
  headed?: boolean;
  retries?: number;
}): Promise<SuiteResult> {
  const vendor = opts.vendor ?? "claude";
  const shared = {
    vendor,
    url: opts.url,
    credentialsJson: opts.credentialsJson,
    skillsDescription: opts.skillsDescription,
    basicAuth: opts.basicAuth,
    timeout: opts.timeout,
    headed: opts.headed,
    retries: opts.retries,
  };

  if (opts.parallel) {
    console.log(`[QAgent] Running ${opts.goals.length} goal(s) in parallel\n`);
    const promises = opts.goals.map((goalDef, i) => runGoalEntry(goalDef, i, opts.goals.length, shared));
    const results = await Promise.all(promises);
    return summarize(results);
  }

  // Sequential (default)
  const results: GoalResult[] = [];
  for (let i = 0; i < opts.goals.length; i++) {
    const result = await runGoalEntry(opts.goals[i]!, i, opts.goals.length, shared);
    results.push(result);
  }
  return summarize(results);
}
