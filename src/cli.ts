#!/usr/bin/env node
import { cac } from "cac";

const cli = cac("qagent");

function findPreparseNumericOptionError(argv: string[]): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token !== "--max-steps" && token !== "--timeout") {
      continue;
    }

    const value = argv[index + 1];
    if (value && /^-\d+$/.test(value)) {
      return `Error: ${token} must be a positive integer.`;
    }
  }

  return null;
}

function parsePositiveIntegerOption(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
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

cli
  .command("[...args]", "Run QAgent against a target URL")
  .option("--url <url>", "Target URL")
  .option("--goal <goal>", "Goal text")
  .option("--max-steps <n>", "Max browser actions", { default: 40 })
  .option("--timeout <ms>", "Wall-clock limit in ms", { default: 180_000 })
  .action(async (args: string[], options: Record<string, unknown>) => {
    if (!options.url || !options.goal) {
      console.error("Error: --url and --goal are required.");
      process.exit(2);
    }

    const maxSteps = parsePositiveIntegerOption(options.maxSteps);
    if (maxSteps === null) {
      console.error("Error: --max-steps must be a positive integer.");
      process.exit(2);
    }

    const timeout = parsePositiveIntegerOption(options.timeout);
    if (timeout === null) {
      console.error("Error: --timeout must be a positive integer.");
      process.exit(2);
    }

    const { runGoal } = await import("./runner.js");
    const result = await runGoal({
      url: options.url as string,
      goal: options.goal as string,
      maxSteps,
      timeout,
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
