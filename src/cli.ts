#!/usr/bin/env node
import { cac } from "cac";

const cli = cac("qagent");

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

    const { runGoal } = await import("./runner.js");
    const result = await runGoal({
      url: options.url as string,
      goal: options.goal as string,
      maxSteps: Number(options.maxSteps),
      timeout: Number(options.timeout),
    });

    console.log(`\n[QAgent] ${result.status.toUpperCase()}: ${result.summary}`);
    process.exit(result.exitCode);
  });

cli.help();
cli.version("0.0.0");
cli.parse();
