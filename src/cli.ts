#!/usr/bin/env node
import path from "node:path";
import { cac } from "cac";
import { loadConfig, resolveConfigPath } from "./config.js";
import { formatCredentialsForPrompt, loadCredentials } from "./credentials.js";
import { formatSkillsDescriptionForPrompt, loadSkillsDescription } from "./skills.js";
import type { SuiteResult } from "./runner.js";

const cli = cac("qagent");

function findPreparseNumericOptionError(argv: string[]): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token !== "--timeout") {
      continue;
    }

    const value = argv[index + 1];
    if (value && /^-\d+$/.test(value)) {
      return `Error: ${token} must be a positive integer.`;
    }
  }

  return null;
}

function parsePositiveIntegerOption(value: unknown): number | null | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }

  const normalized = typeof value === "string" ? value.trim() : String(value);
  if (!/^\d+$/.test(normalized)) {
    return null;
  }

  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
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
cli.command("doctor", "Check that all dependencies are installed").action(async () => {
  const { runDoctor } = await import("./doctor.js");
  const ok = runDoctor();
  process.exit(ok ? 0 : 1);
});

// ── run (default) ─────────────────────────────────────────────────────
cli
  .command("[...args]", "Run QAgent against a target URL")
  .option("--config <path>", "Path to qagent config file")
  .option("--credentials <path>", "Path to qagent credentials file")
  .option("--skills <path>", "Path to a skills description file")
  .option("--url <url>", "Target URL")
  .option("--goal <goal>", "Single goal text")
  .option("--goals <path>", "Path to goals.json file")
  .option("--timeout <ms>", "Wall-clock limit in ms per goal")
  .option("--parallel", "Run goals in parallel (only with --goals)")
  .option("--headed", "Run Chrome in headed mode (visible browser window)")
  .option("--retries <n>", "Retry blocked goals up to N times (default: 0)")
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

    const url = typeof options.url === "string" ? options.url : config?.baseUrl;
    if (!url) {
      console.error("Error: --url is required unless baseUrl is set in qagent.config.json.");
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
      credentials = loadCredentials(credentialsPath);
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

    const timeoutOption = parsePositiveIntegerOption(options.timeout);
    if (timeoutOption === null) {
      console.error("Error: --timeout must be a positive integer.");
      process.exit(2);
    }
    const timeout = timeoutOption ?? config?.timeoutMs ?? 180_000;

    const retriesOption = parsePositiveIntegerOption(options.retries);
    if (retriesOption === null) {
      console.error("Error: --retries must be a positive integer.");
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
        url,
        goals,
        credentialsJson,
        skillsDescription: formattedSkillsDescription,
        basicAuth: credentials?.basicAuth,
        timeout,
        parallel: options.parallel === true,
        headed: options.headed === true,
      });

      printSummaryTable(suite);
      process.exit(suite.exitCode);
    }

    // Single-goal mode
    const { runGoal } = await import("./runner.js");
    const result = await runGoal({
      url,
      goal: options.goal as string,
      credentialsJson,
      skillsDescription: formattedSkillsDescription,
      basicAuth: credentials?.basicAuth,
      timeout,
      headed: options.headed === true,
    });

    console.log(`\n[QAgent] ${result.status.toUpperCase()}: ${result.summary}`);
    process.exit(result.exitCode);
  });

cli.help();
cli.version("0.0.0");

const preparseError = findPreparseNumericOptionError(process.argv.slice(2));
if (preparseError) {
  console.error(preparseError);
  process.exit(2);
}

cli.parse();
