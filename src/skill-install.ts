import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, rmdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface SkillPaths {
  claudeConfigDir: string;
  corePath: string;
  sourcePath: string;
  destinationPath: string;
}

export interface SkillCommandResult {
  changed: boolean;
  exitCode: number;
  message: string;
}

export type InstalledSkillStatus =
  | { status: "up-to-date"; paths: SkillPaths }
  | { status: "out-of-date"; paths: SkillPaths }
  | { status: "not-installed"; paths: SkillPaths }
  | { status: "source-missing"; paths: SkillPaths };

export class SkillInstallError extends Error {
  exitCode: number;

  constructor(message: string, exitCode = 2) {
    super(message);
    this.name = "SkillInstallError";
    this.exitCode = exitCode;
  }
}

export function resolveClaudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  if (configured) {
    return path.resolve(configured);
  }

  return path.join(os.homedir(), ".claude");
}

export function resolveBundledSkillSourcePath(moduleUrl = import.meta.url): string {
  const modulePath = fileURLToPath(moduleUrl);
  return path.resolve(path.dirname(modulePath), "../skills/qagent/SKILL.md");
}

export function resolveSkillPaths(opts?: {
  env?: NodeJS.ProcessEnv;
  moduleUrl?: string;
}): SkillPaths {
  const claudeConfigDir = resolveClaudeConfigDir(opts?.env);
  return {
    claudeConfigDir,
    corePath: resolveBundledSkillCorePath(opts?.moduleUrl),
    sourcePath: resolveBundledSkillSourcePath(opts?.moduleUrl),
    destinationPath: path.join(claudeConfigDir, "skills", "qagent", "SKILL.md"),
  };
}

export function resolveBundledSkillCorePath(moduleUrl = import.meta.url): string {
  const modulePath = fileURLToPath(moduleUrl);
  return path.resolve(path.dirname(modulePath), "../skills/qagent/core.md");
}

function ensureBundledSkillExists(paths: SkillPaths): void {
  if (existsSync(paths.sourcePath)) {
    return;
  }

  throw new SkillInstallError(
    `Bundled skill file not found at ${paths.sourcePath}. This usually means the package was published without skills/qagent/SKILL.md.`,
  );
}

export function installSkill(opts?: {
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
  force?: boolean;
  moduleUrl?: string;
}): SkillCommandResult {
  const paths = resolveSkillPaths(opts);
  ensureBundledSkillExists(paths);

  const alreadyInstalled = existsSync(paths.destinationPath);
  if (alreadyInstalled && !opts?.force) {
    return {
      changed: false,
      exitCode: 0,
      message: `Skill already installed at ${paths.destinationPath}. Re-run with --force to overwrite.`,
    };
  }

  if (opts?.dryRun) {
    const action = alreadyInstalled ? "Would overwrite" : "Would install";
    return {
      changed: false,
      exitCode: 0,
      message: `${action} QAgent skill to ${paths.destinationPath}.`,
    };
  }

  mkdirSync(path.dirname(paths.destinationPath), { recursive: true });
  copyFileSync(paths.sourcePath, paths.destinationPath);

  return {
    changed: true,
    exitCode: 0,
    message: `Installed QAgent skill to ${paths.destinationPath}. Restart or start a new Claude Code session to pick it up.`,
  };
}

export function uninstallSkill(opts?: {
  env?: NodeJS.ProcessEnv;
  moduleUrl?: string;
}): SkillCommandResult {
  const paths = resolveSkillPaths(opts);
  if (!existsSync(paths.destinationPath)) {
    return {
      changed: false,
      exitCode: 0,
      message: "Skill not installed.",
    };
  }

  rmSync(paths.destinationPath, { force: true });

  try {
    rmdirSync(path.dirname(paths.destinationPath));
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code !== "ENOTEMPTY" && code !== "ENOENT") {
      throw error;
    }
  }

  return {
    changed: true,
    exitCode: 0,
    message: `Removed ${paths.destinationPath}.`,
  };
}

export function getInstalledSkillStatus(opts?: {
  env?: NodeJS.ProcessEnv;
  moduleUrl?: string;
}): InstalledSkillStatus {
  const paths = resolveSkillPaths(opts);
  if (!existsSync(paths.destinationPath)) {
    return {
      status: "not-installed",
      paths,
    };
  }

  if (!existsSync(paths.sourcePath)) {
    return {
      status: "source-missing",
      paths,
    };
  }

  const installed = readFileSync(paths.destinationPath);
  const bundled = readFileSync(paths.sourcePath);

  return {
    status: bundled.equals(installed) ? "up-to-date" : "out-of-date",
    paths,
  };
}

export function readBundledSkillCore(opts?: {
  env?: NodeJS.ProcessEnv;
  moduleUrl?: string;
}): string {
  const paths = resolveSkillPaths(opts);
  if (!existsSync(paths.corePath)) {
    throw new SkillInstallError(
      `Bundled skill content not found at ${paths.corePath}. This usually means the package was published without skills/qagent/core.md.`,
    );
  }

  return readFileSync(paths.corePath, "utf8");
}
