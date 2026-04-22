import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { getInstalledSkillStatus } from "./skill-install.js";

interface CheckResult {
  name: string;
  message: string;
  status: "info" | "missing" | "ok";
}

interface CommandOutcome {
  ok: boolean;
  stdout: string;
  stderr: string;
  error: NodeJS.ErrnoException | null;
}

function runCommand(bin: string, args: string[], timeout: number): CommandOutcome {
  try {
    const stdout = execFileSync(bin, args, {
      encoding: "utf8",
      timeout,
      stdio: ["ignore", "pipe", "pipe"],
    });

    return {
      ok: true,
      stdout,
      stderr: "",
      error: null,
    };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string | Buffer; stderr?: string | Buffer };
    const stdout = typeof failure.stdout === "string" ? failure.stdout : failure.stdout?.toString("utf8") ?? "";
    const stderr = typeof failure.stderr === "string" ? failure.stderr : failure.stderr?.toString("utf8") ?? "";

    return {
      ok: false,
      stdout,
      stderr,
      error: failure,
    };
  }
}

function which(bin: string): string | null {
  const locator = process.platform === "win32" ? "where" : "which";
  const result = runCommand(locator, [bin], 5_000);
  if (!result.ok) {
    return null;
  }

  return result.stdout.trim().split(/\r?\n/)[0] ?? null;
}

function getVersion(bin: string, flag = "--version"): string | null {
  const result = runCommand(bin, [flag], 10_000);
  if (!result.ok) {
    return null;
  }

  return result.stdout.trim().split(/\r?\n/)[0] ?? null;
}

function summarizeFailureText(outcome: CommandOutcome): string {
  const raw = `${outcome.stderr}\n${outcome.stdout}`.trim();
  if (raw.length === 0) {
    return outcome.error?.message ?? "unknown error";
  }

  return raw.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? raw;
}

function checkAgentBrowserLaunch(): CheckResult {
  const sessionName = `qagent-doctor-${crypto.randomBytes(4).toString("hex")}`;
  const openResult = runCommand("agent-browser", ["--session", sessionName, "open", "about:blank"], 30_000);

  if (!openResult.ok) {
    const detail = summarizeFailureText(openResult);
    return {
      name: "Browser launch",
      status: "missing",
      message: `failed — run \`agent-browser install\` (${detail})`,
    };
  }

  runCommand("agent-browser", ["--session", sessionName, "close"], 10_000);

  return {
    name: "Browser launch",
    status: "ok",
    message: "headless browser session started successfully",
  };
}

function checkClaudeSkill(): CheckResult {
  const status = getInstalledSkillStatus();

  if (status.status === "up-to-date") {
    return {
      name: "Claude skill",
      status: "info",
      message: "Skill installed (up to date)",
    };
  }

  if (status.status === "out-of-date") {
    return {
      name: "Claude skill",
      status: "info",
      message: "Skill installed (out of date — run: qagent skill install --force)",
    };
  }

  if (status.status === "not-installed") {
    return {
      name: "Claude skill",
      status: "info",
      message: "Skill not installed (run: qagent skill install)",
    };
  }

  return {
    name: "Claude skill",
    status: "info",
    message: "Bundled skill missing from package (skill install unavailable)",
  };
}

export function runDoctor(): boolean {
  const checks: CheckResult[] = [];

  const nodeVersion = process.versions.node;
  const nodeMajor = Number.parseInt(nodeVersion.split(".")[0] ?? "0", 10);
  checks.push({
    name: "Node.js",
    status: nodeMajor >= 20 ? "ok" : "missing",
    message: nodeMajor >= 20 ? `v${nodeVersion}` : `v${nodeVersion} (need >= 20)`,
  });

  const claudePath = which("claude");
  if (claudePath) {
    const version = getVersion("claude", "--version");
    checks.push({
      name: "Claude Code",
      status: "ok",
      message: version ?? claudePath,
    });
  } else {
    checks.push({
      name: "Claude Code",
      status: "missing",
      message: "not found — install: https://docs.anthropic.com/en/docs/claude-code",
    });
  }

  const agentBrowserPath = which("agent-browser");
  if (agentBrowserPath) {
    const version = getVersion("agent-browser", "--version");
    checks.push({
      name: "agent-browser",
      status: "ok",
      message: version ?? agentBrowserPath,
    });
    checks.push(checkAgentBrowserLaunch());
  } else {
    checks.push({
      name: "agent-browser",
      status: "missing",
      message: "not found — install: npm install -g agent-browser",
    });
    checks.push({
      name: "Browser launch",
      status: "missing",
      message: "skipped — install agent-browser first",
    });
  }

  checks.push(checkClaudeSkill());

  console.log("\n  QAgent Doctor\n");
  let allOk = true;
  for (const check of checks) {
    const icon = check.status === "ok" ? "OK" : check.status === "missing" ? "MISSING" : "INFO";
    console.log(`  ${icon.padEnd(9)} ${check.name.padEnd(16)} ${check.message}`);
    if (check.status === "missing") {
      allOk = false;
    }
  }

  console.log("");
  if (allOk) {
    console.log("  All dependencies found and browser startup works. You're ready to go!\n");
  } else {
    console.log("  Some dependencies or browser prerequisites are missing. Fix them and run `qagent doctor` again.\n");
  }

  return allOk;
}
