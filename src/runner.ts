import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";
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
        { stdio: ["ignore", "pipe", "pipe"] },
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
  maxSteps?: number;
  timeout?: number;
}): Promise<RunResult> {
  const runDir = createRunDir(opts.goal);

  const resultPath = path.resolve(runDir, "result.json");
  const screenshotDir = path.resolve(runDir);
  const logPath = path.resolve(runDir, "claude-session.log");

  const prompt = buildPrompt({
    url: opts.url,
    goal: opts.goal,
    resultPath,
    screenshotDir,
    maxSteps: opts.maxSteps ?? 40,
  });

  const timeout = opts.timeout ?? 180_000;

  const session = await runClaudeSession({ prompt, timeout, logPath });

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
}
