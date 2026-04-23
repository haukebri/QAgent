#!/usr/bin/env node
import path from "node:path";
import { cac } from "cac";
import { loadConfig, resolveConfigPath } from "./config.js";
import { formatCredentialsForPrompt, loadCredentials } from "./credentials.js";
import { formatSkillsDescriptionForPrompt, loadSkillsDescription } from "./skills.js";
import type { SuiteResult } from "./runner.js";
import { assertHttpUrl } from "./url.js";
import { parseVendorOption, type Vendor } from "./vendor.js";

const cli = cac("qagent");

function findPreparseNumericOptionError(argv: string[]): string | null {
  const rules = new Map([
    ["--timeout", "Error: --timeout must be a positive integer."],
    ["--retries", "Error: --retries must be a non-negative integer."],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token || !rules.has(token)) {
      continue;
    }

    const value = argv[index + 1];
    if (value && /^-\d+$/.test(value)) {
      return rules.get(token) ?? null;
    }
  }

  return null;
}

function parseIntegerOption(value: unknown, opts?: { allowZero?: boolean }): number | null | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }

  const normalized = typeof value === "string" ? value.trim() : String(value);
  if (!/^\d+$/.test(normalized)) {
    return null;
  }

  const parsed = Number.parseInt(normalized, 10);
  const minimum = opts?.allowZero ? 0 : 1;
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    return null;
  }

  return parsed;
}

function parseAllowedCredentialEnvOption(value: unknown): Set<string> | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  const rawValues = Array.isArray(value) ? value : [value];
  const names: string[] = [];

  for (const rawValue of rawValues) {
    if (typeof rawValue !== "string") {
      return null;
    }

    for (const token of rawValue.split(",")) {
      const trimmed = token.trim();
      if (!trimmed) {
        return null;
      }
      names.push(trimmed);
    }
  }

  return new Set(names);
}

function resolveVendorOption(optionValue: unknown, configVendor?: Vendor): Vendor {
  const parsed = parseVendorOption(optionValue);
  if (parsed === null) {
    console.error("Error: --vendor must be one of: claude, codex.");
    process.exit(2);
  }

  return parsed ?? configVendor ?? "claude";
}

function printSkillCommandHelp(subcommand?: "install" | "path" | "uninstall"): void {
  if (subcommand === "install") {
    console.log(`Usage:
  $ qagent skill install [--force] [--dry-run]

Install the QAgent Claude Code skill into the user's Claude config directory.

Options:
  --force    Overwrite the destination file if it already exists
  --dry-run  Print what would happen without touching the filesystem
  -h, --help Display this message`);
    return;
  }

  if (subcommand === "uninstall") {
    console.log(`Usage:
  $ qagent skill uninstall

Remove the installed QAgent skill.

Options:
  -h, --help Display this message`);
    return;
  }

  if (subcommand === "path") {
    console.log(`Usage:
  $ qagent skill path

Print the resolved install path without installing anything.

Options:
  -h, --help Display this message`);
    return;
  }

  console.log(`Usage:
  $ qagent skill install [--force] [--dry-run]
  $ qagent skill uninstall
  $ qagent skill path`);
}

function printSkillsCommandHelp(topic?: "get core"): void {
  if (topic === "get core") {
    console.log(`Usage:
  $ qagent skills get core

Print the runtime QAgent assistant workflow content.

Options:
  -h, --help Display this message`);
    return;
  }

  console.log(`Usage:
  $ qagent skills get core`);
}

async function maybeRunBuiltinMetaCommand(argv: string[]): Promise<boolean> {
  if (argv[0] !== "skill") {
    if (argv[0] !== "skills") {
      return false;
    }

    const subcommand = argv[1];
    const topic = argv[2];
    const tail = argv.slice(3);

    if (!subcommand || subcommand === "--help" || subcommand === "-h") {
      printSkillsCommandHelp();
      process.exit(0);
    }

    if (subcommand !== "get") {
      console.error(`Error: Unknown skills subcommand \`${subcommand}\`.`);
      printSkillsCommandHelp();
      process.exit(2);
    }

    if (!topic || topic === "--help" || topic === "-h") {
      printSkillsCommandHelp();
      process.exit(0);
    }

    if (topic !== "core") {
      console.error(`Error: Unknown skills topic \`${topic}\`.`);
      printSkillsCommandHelp();
      process.exit(2);
    }

    if (tail.includes("--help") || tail.includes("-h")) {
      printSkillsCommandHelp("get core");
      process.exit(0);
    }

    if (tail.length > 0) {
      console.error("Error: `qagent skills get core` does not take additional arguments.");
      process.exit(2);
    }

    try {
      const { readBundledSkillCore } = await import("./skill-install.js");
      const content = readBundledSkillCore();
      process.stdout.write(content);
      if (!content.endsWith("\n")) {
        process.stdout.write("\n");
      }
      process.exit(0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const exitCode = typeof error === "object" && error !== null && "exitCode" in error ? Number(error.exitCode) : 2;
      console.error(`Error: ${message}`);
      process.exit(Number.isInteger(exitCode) ? exitCode : 2);
    }
  }

  const subcommand = argv[1];
  const tail = argv.slice(2);

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printSkillCommandHelp();
    process.exit(0);
  }

  if (subcommand === "install") {
    if (tail.includes("--help") || tail.includes("-h")) {
      printSkillCommandHelp("install");
      process.exit(0);
    }

    let force = false;
    let dryRun = false;

    for (const token of tail) {
      if (token === "--force") {
        force = true;
        continue;
      }

      if (token === "--dry-run") {
        dryRun = true;
        continue;
      }

      console.error(`Error: Unknown option or argument for \`qagent skill install\`: ${token}`);
      process.exit(2);
    }

    try {
      const { installSkill } = await import("./skill-install.js");
      const result = installSkill({ force, dryRun });
      console.log(result.message);
      process.exit(result.exitCode);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const exitCode = typeof error === "object" && error !== null && "exitCode" in error ? Number(error.exitCode) : 2;
      console.error(`Error: ${message}`);
      process.exit(Number.isInteger(exitCode) ? exitCode : 2);
    }
  }

  if (subcommand === "uninstall") {
    if (tail.includes("--help") || tail.includes("-h")) {
      printSkillCommandHelp("uninstall");
      process.exit(0);
    }

    if (tail.length > 0) {
      console.error(`Error: \`qagent skill uninstall\` does not take additional arguments.`);
      process.exit(2);
    }

    const { uninstallSkill } = await import("./skill-install.js");
    const result = uninstallSkill();
    console.log(result.message);
    process.exit(result.exitCode);
  }

  if (subcommand === "path") {
    if (tail.includes("--help") || tail.includes("-h")) {
      printSkillCommandHelp("path");
      process.exit(0);
    }

    if (tail.length > 0) {
      console.error(`Error: \`qagent skill path\` does not take additional arguments.`);
      process.exit(2);
    }

    const { resolveSkillPaths } = await import("./skill-install.js");
    console.log(resolveSkillPaths().destinationPath);
    process.exit(0);
  }

  console.error(`Error: Unknown skill subcommand \`${subcommand}\`.`);
  printSkillCommandHelp();
  process.exit(2);
}

function printSummaryTable(suite: SuiteResult): void {
  console.log("\n" + "=".repeat(70));
  console.log(" QAgent Summary");
  console.log("=".repeat(70));

  const statusIcon = (s: string) => (s === "pass" ? "PASS   " : s === "fail" ? "FAIL   " : "BLOCKED");

  for (const r of suite.results) {
    console.log(` ${statusIcon(r.status)}  ${r.name}`);
    console.log(`          ${r.summary}`);
  }

  console.log("-".repeat(70));
  console.log(` ${suite.passed} passed, ${suite.failed} failed, ${suite.blocked} blocked (${suite.results.length} total)`);
  console.log("=".repeat(70));
}

// ── doctor ────────────────────────────────────────────────────────────
cli
  .command("doctor", "Check that all dependencies are installed")
  .option("--config <path>", "Path to qagent config file")
  .option("--vendor <vendor>", "Agent vendor to check (claude or codex)")
  .action(async (options: Record<string, unknown>) => {
    const configPath = typeof options.config === "string" ? options.config : undefined;
    let config;
    try {
      config = loadConfig(configPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      process.exit(2);
    }

    const vendor = resolveVendorOption(options.vendor, config?.vendor);

    const { runDoctor } = await import("./doctor.js");
    const ok = runDoctor({ vendor });
    process.exit(ok ? 0 : 1);
  });

// ── skill ─────────────────────────────────────────────────────────────
cli.command("skill install", "Install the QAgent Claude Code skill into the user's Claude config directory");
cli.command("skill uninstall", "Remove the installed QAgent skill");
cli.command("skill path", "Print the resolved install path without installing anything");
cli.command("skills get core", "Print the runtime QAgent assistant workflow content");

// ── run (default) ─────────────────────────────────────────────────────
cli
  .command("[...args]", "Run QAgent against a target URL")
  .option("--config <path>", "Path to qagent config file")
  .option("--credentials <path>", "Path to qagent credentials file")
  .option("--skills <path>", "Path to a skills description file")
  .option("--vendor <vendor>", "Agent vendor to run (claude or codex)")
  .option("--url <url>", "Target URL")
  .option("--goal <goal>", "Single goal text")
  .option("--goals <path>", "Path to goals.json file")
  .option("--timeout <ms>", "Wall-clock limit in ms per goal")
  .option("--parallel", "Run goals in parallel (only with --goals)")
  .option("--headed", "Run Chrome in headed mode (visible browser window)")
  .option("--retries <n>", "Retry blocked goals up to N times (default: 0)")
  .option("--allow-credential-env <names>", "Comma-separated env var names allowed in credentials templates")
  .action(async (args: string[], options: Record<string, unknown>) => {
    const configPath = typeof options.config === "string" ? options.config : undefined;
    const resolvedConfigPath = resolveConfigPath(configPath);
    let config;
    try {
      config = loadConfig(configPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      process.exit(2);
    }

    const vendor = resolveVendorOption(options.vendor, config?.vendor);

    if (options.goal && options.goals) {
      console.error("Error: --goal and --goals are mutually exclusive.");
      process.exit(2);
    }

    // Resolve goals file: --goals flag > config goalsFile > require --goal
    const goalsPath =
      typeof options.goals === "string"
        ? options.goals
        : !options.goal && config?.goalsFile
          ? path.resolve(path.dirname(resolvedConfigPath), config.goalsFile)
          : undefined;

    if (!options.goal && !goalsPath) {
      console.error("Error: --goal or --goals is required (or set goalsFile in qagent.config.json).");
      process.exit(2);
    }

    let url: string | undefined;
    try {
      url =
        typeof options.url === "string"
          ? assertHttpUrl(options.url, "--url")
          : config?.baseUrl;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      process.exit(2);
    }
    if (!url) {
      console.error("Error: --url is required unless baseUrl is set in qagent.config.json.");
      process.exit(2);
    }

    const allowedCredentialEnvNames = parseAllowedCredentialEnvOption(options.allowCredentialEnv);
    if (allowedCredentialEnvNames === null) {
      console.error("Error: --allow-credential-env must be a comma-separated list of environment variable names.");
      process.exit(2);
    }

    const credentialsPath =
      typeof options.credentials === "string"
        ? path.resolve(options.credentials)
        : config?.credentialsFile
          ? path.resolve(path.dirname(resolvedConfigPath), config.credentialsFile)
          : undefined;

    let credentials;
    try {
      credentials = loadCredentials(credentialsPath, { allowedEnvNames: allowedCredentialEnvNames });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      process.exit(2);
    }
    const credentialsJson = formatCredentialsForPrompt(credentials);

    const skillsPath =
      typeof options.skills === "string"
        ? path.resolve(options.skills)
        : config?.skillsFile
          ? path.resolve(path.dirname(resolvedConfigPath), config.skillsFile)
          : undefined;

    let skillsDescription;
    try {
      skillsDescription = loadSkillsDescription(skillsPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      process.exit(2);
    }
    const formattedSkillsDescription = formatSkillsDescriptionForPrompt(skillsDescription);

    const timeoutOption = parseIntegerOption(options.timeout);
    if (timeoutOption === null) {
      console.error("Error: --timeout must be a positive integer.");
      process.exit(2);
    }
    const timeout = timeoutOption ?? config?.timeoutMs ?? 180_000;

    const retriesOption = parseIntegerOption(options.retries, { allowZero: true });
    if (retriesOption === null) {
      console.error("Error: --retries must be a non-negative integer.");
      process.exit(2);
    }
    const retries = retriesOption ?? 0;

    // Multi-goal mode
    if (goalsPath) {
      const { loadGoals } = await import("./goals.js");
      let goals;
      try {
        goals = loadGoals(goalsPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(2);
      }

      console.log(`[QAgent] Running ${goals.length} goal(s) against ${url}\n`);

      const { runSuite } = await import("./runner.js");
      const suite = await runSuite({
        vendor,
        url,
        goals,
        credentialsJson,
        skillsDescription: formattedSkillsDescription,
        basicAuth: credentials?.basicAuth,
        timeout,
        parallel: options.parallel === true,
        headed: options.headed === true,
        retries,
      });

      printSummaryTable(suite);
      process.exit(suite.exitCode);
    }

    // Single-goal mode
    const { runGoal } = await import("./runner.js");
    const result = await (async () => {
      let attempt = 0;

      while (true) {
        const nextResult = await runGoal({
          vendor,
          url,
          goal: options.goal as string,
          credentialsJson,
          skillsDescription: formattedSkillsDescription,
          basicAuth: credentials?.basicAuth,
          timeout,
          headed: options.headed === true,
        });

        if (nextResult.status !== "blocked" || attempt >= retries) {
          return nextResult;
        }

        attempt += 1;
        console.log(`[QAgent] Retrying blocked run (attempt ${attempt + 1}/${retries + 1})...`);
      }
    })();

    console.log(`\n[QAgent] ${result.status.toUpperCase()}: ${result.summary}`);
    process.exit(result.exitCode);
  });

cli.help();
cli.version("0.2.0");

const preparseError = findPreparseNumericOptionError(process.argv.slice(2));
if (preparseError) {
  console.error(preparseError);
  process.exit(2);
}

await maybeRunBuiltinMetaCommand(process.argv.slice(2));
cli.parse();
