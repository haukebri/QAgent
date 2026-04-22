import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { closeBrowserSession, startBrowserSession } from "./browser-session.js";
import type { Goal } from "./goals.js";
import { buildPrompt } from "./prompt.js";
import { readResult } from "./result.js";

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

function formatLaunchError(error: NodeJS.ErrnoException): string {
  if (error.code === "ENOENT") {
    return "Claude Code CLI was not found in PATH";
  }

  return `Failed to launch Claude Code: ${error.message}`;
}

function writeLogLine(write: (chunk: string) => void, message: string): void {
  write(`[QAgent] ${message}\n`);
}

async function runClaudeSession(opts: {
  prompt: string;
  timeout: number;
  logPath: string;
  sessionName: string;
}): Promise<
  | { kind: "completed"; code: number | null; signal: NodeJS.Signals | null }
  | { kind: "timeout" }
  | { kind: "launch-error"; error: NodeJS.ErrnoException }
> {
  const logStream = createWriteStream(opts.logPath, { flags: "a" });
  logStream.on("error", (error) => {
    process.stderr.write(`[QAgent] Failed to write claude-session.log: ${error.message}\n`);
  });

  const writeLog = (chunk: string | Buffer) => {
    if (logStream.writableEnded || logStream.destroyed) {
      return;
    }

    logStream.write(chunk);
  };

  try {
    const result = await new Promise<
      | { kind: "completed"; code: number | null; signal: NodeJS.Signals | null }
      | { kind: "timeout" }
      | { kind: "launch-error"; error: NodeJS.ErrnoException }
    >((resolve) => {
      const child = spawn(
        "claude",
        ["-p", opts.prompt, "--strict-mcp-config", "--no-chrome", "--allowedTools", "Bash(agent-browser:*)", "Read", "Write"],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, AGENT_BROWSER_SESSION: opts.sessionName },
        },
      );

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
        process.stdout.write(chunk);
        writeLog(chunk);
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        process.stderr.write(chunk);
        writeLog(chunk);
      });

      child.on("error", (error) => {
        if (settled) {
          return;
        }

        writeLogLine(writeLog, formatLaunchError(error));
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
          writeLogLine(writeLog, `Claude exited unexpectedly with code ${code ?? "null"}${signal ? ` (signal ${signal})` : ""}.`);
        }

        finish({ kind: "completed", code, signal });
      });

      timeoutTimer = setTimeout(() => {
        timedOut = true;
        writeLogLine(writeLog, `Timeout reached after ${opts.timeout}ms; stopping Claude.`);
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
  url: string;
  goal: string;
  credentialsJson?: string;
  skillsDescription?: string;
  basicAuth?: { username: string; password: string };
  timeout?: number;
  headed?: boolean;
}): Promise<RunResult> {
  const runDir = createRunDir(opts.goal);

  const resultPath = path.resolve(runDir, "result.json");
  const screenshotDir = path.resolve(runDir);
  const logPath = path.resolve(runDir, "claude-session.log");

  // Pre-start agent-browser session: set credentials + verify URL is reachable
  let browserSession;
  try {
    console.log("[QAgent] Starting browser session...");
    browserSession = startBrowserSession({
      url: opts.url,
      basicAuth: opts.basicAuth,
      headed: opts.headed,
    });
    console.log(`[QAgent] Browser ready (session: ${browserSession.sessionName})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "blocked", summary: `Browser pre-start failed: ${message}`, exitCode: 2 };
  }

  const prompt = buildPrompt({
    url: opts.url,
    goal: opts.goal,
    credentialsJson: opts.credentialsJson ?? "None provided.",
    skillsDescription: opts.skillsDescription ?? "None provided.",
    resultPath,
    screenshotDir,
  });

  const timeout = opts.timeout ?? 180_000;

  try {
    const session = await runClaudeSession({
      prompt,
      timeout,
      logPath,
      sessionName: browserSession.sessionName,
    });

    if (session.kind === "launch-error") {
      return { status: "blocked", summary: formatLaunchError(session.error), exitCode: 2 };
    }

    if (session.kind === "timeout") {
      return {
        status: "blocked",
        summary: `Run hit the wall-clock timeout after ${timeout}ms`,
        exitCode: 1,
      };
    }

    if (session.code !== 0) {
      return { status: "blocked", summary: "Claude Code crashed", exitCode: 3 };
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

async function runGoalEntry(
  goalDef: Goal,
  index: number,
  total: number,
  opts: {
    url: string;
    credentialsJson?: string;
    skillsDescription?: string;
    basicAuth?: { username: string; password: string };
    timeout?: number;
    headed?: boolean;
  },
): Promise<GoalResult> {
  console.log(`\n[QAgent] Goal ${index + 1}/${total}: ${goalDef.name}`);
  console.log(`[QAgent] "${goalDef.goal}"\n`);

  const result = await runGoal({
    url: opts.url,
    goal: goalDef.goal,
    credentialsJson: opts.credentialsJson,
    skillsDescription: opts.skillsDescription,
    basicAuth: opts.basicAuth,
    timeout: opts.timeout,
    headed: opts.headed,
  });

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
  url: string;
  goals: Goal[];
  credentialsJson?: string;
  skillsDescription?: string;
  basicAuth?: { username: string; password: string };
  timeout?: number;
  parallel?: boolean;
  headed?: boolean;
}): Promise<SuiteResult> {
  const shared = {
    url: opts.url,
    credentialsJson: opts.credentialsJson,
    skillsDescription: opts.skillsDescription,
    basicAuth: opts.basicAuth,
    timeout: opts.timeout,
    headed: opts.headed,
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
