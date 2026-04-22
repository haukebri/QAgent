import { execFileSync } from "node:child_process";

interface CheckResult {
  name: string;
  ok: boolean;
  message: string;
}

function which(bin: string): string | null {
  try {
    return execFileSync("which", [bin], { encoding: "utf8", timeout: 5_000 }).trim();
  } catch {
    return null;
  }
}

function getVersion(bin: string, flag = "--version"): string | null {
  try {
    return execFileSync(bin, [flag], { encoding: "utf8", timeout: 10_000 }).trim().split("\n")[0] ?? null;
  } catch {
    return null;
  }
}

export function runDoctor(): boolean {
  const checks: CheckResult[] = [];

  // Node.js version
  const nodeVersion = process.versions.node;
  const nodeMajor = Number.parseInt(nodeVersion.split(".")[0] ?? "0", 10);
  checks.push({
    name: "Node.js",
    ok: nodeMajor >= 20,
    message: nodeMajor >= 20 ? `v${nodeVersion}` : `v${nodeVersion} (need >= 20)`,
  });

  // Claude Code CLI
  const claudePath = which("claude");
  if (claudePath) {
    const ver = getVersion("claude", "--version");
    checks.push({ name: "Claude Code", ok: true, message: ver ?? claudePath });
  } else {
    checks.push({ name: "Claude Code", ok: false, message: "not found — install: https://docs.anthropic.com/en/docs/claude-code" });
  }

  // agent-browser
  const abPath = which("agent-browser");
  if (abPath) {
    const ver = getVersion("agent-browser", "--version");
    checks.push({ name: "agent-browser", ok: true, message: ver ?? abPath });
  } else {
    checks.push({ name: "agent-browser", ok: false, message: "not found — install: npm install -g agent-browser" });
  }

  // Print results
  console.log("\n  QAgent Doctor\n");
  let allOk = true;
  for (const check of checks) {
    const icon = check.ok ? "OK" : "MISSING";
    const prefix = check.ok ? "  " : "  ";
    console.log(`${prefix}${icon.padEnd(9)} ${check.name.padEnd(16)} ${check.message}`);
    if (!check.ok) allOk = false;
  }

  console.log("");
  if (allOk) {
    console.log("  All dependencies found. You're ready to go!\n");
  } else {
    console.log("  Some dependencies are missing. Install them and run `qagent doctor` again.\n");
  }

  return allOk;
}
