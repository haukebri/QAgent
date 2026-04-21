import { spawn } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { buildPrompt } from "./prompt.js";
import { readResult } from "./result.js";

export interface RunResult {
  status: "pass" | "fail" | "blocked";
  summary: string;
  exitCode: number;
}

function toSlug(goal: string): string {
  return goal
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 30);
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

export async function runGoal(opts: {
  url: string;
  goal: string;
  maxSteps?: number;
  timeout?: number;
}): Promise<RunResult> {
  const runDir = path.resolve(`.qagent/runs/${timestamp()}-${toSlug(opts.goal)}`);
  mkdirSync(runDir, { recursive: true });

  const resultPath = path.resolve(runDir, "result.json");
  const screenshotDir = path.resolve(runDir);

  const prompt = buildPrompt({
    url: opts.url,
    goal: opts.goal,
    resultPath,
    screenshotDir,
    maxSteps: opts.maxSteps ?? 40,
  });

  const timeout = opts.timeout ?? 180_000;

  const exitCode = await new Promise<number | null>((resolve) => {
    const child = spawn(
      "claude",
      ["-p", prompt, "--strict-mcp-config", "--no-chrome", "--allowedTools", "Bash(agent-browser:*)", "Read", "Write"],
      { stdio: "inherit" },
    );

    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, timeout);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  if (exitCode !== 0) {
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
