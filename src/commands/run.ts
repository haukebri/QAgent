import type { CAC } from "cac";
import { loadConfig, loadCredentials, loadGoals, type Goal } from "../config.js";

interface RunFlags {
  goal?: string;
  goals?: string;
  url?: string;
  config?: string;
  credentials?: string;
  output?: string;
  record?: boolean;
  headed?: boolean;
  keepArtifacts?: boolean;
  maxSteps?: number;
  timeout?: number;
}

/**
 * `qagent run` — executes one or more goals against a URL.
 *
 * Currently a skeleton: loads + validates config/goals/credentials, prints
 * what it would do, exits. Real execution arrives in week 1/2 of the build plan.
 */
export function registerRunCommand(cli: CAC): void {
  cli
    .command("run", "Run one or more goals against a URL")
    .option("--goal <text>", "One-off goal (mutually exclusive with --goals)")
    .option("--goals <path>", "Path to goals.json")
    .option("--url <url>", "Target URL (overrides baseUrl from config)")
    .option("--config <path>", "Path to qagent.config.json", {
      default: "qagent.config.json",
    })
    .option("--credentials <path>", "Path to test-credentials.json")
    .option("--output <dir>", "Per-run output root directory")
    .option("--record", "Emit a Playwright spec per passing goal")
    .option("--headed", "Run Chrome headed (debug mode)")
    .option("--keep-artifacts", "Keep run directory even on pass")
    .option("--max-steps <n>", "Max browser actions per goal")
    .option("--timeout <ms>", "Wall-clock limit per goal in ms")
    .action(async (flags: RunFlags) => {
      // Flag validation
      if (flags.goal && flags.goals) {
        console.error("Error: --goal and --goals are mutually exclusive.");
        process.exit(2);
      }

      // Load config (schema defaults if file missing)
      let config;
      try {
        config = await loadConfig(flags.config);
      } catch (err) {
        console.error(`Error: failed to load config (${flags.config ?? "qagent.config.json"}):`);
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(2);
      }

      // Effective values (CLI flags override config)
      const effective = {
        baseUrl: flags.url ?? config.baseUrl,
        goalsFile: flags.goals ?? config.goalsFile,
        credentialsFile: flags.credentials ?? config.credentialsFile,
        outputDir: flags.output ?? config.outputDir,
        record: flags.record ?? config.record,
        headed: flags.headed ?? !config.browser.headless,
        maxSteps: flags.maxSteps ?? config.maxSteps,
        timeoutMs: flags.timeout ?? config.timeoutMs,
      };

      if (!effective.baseUrl && !flags.url) {
        console.error(
          "Error: no URL. Set baseUrl in qagent.config.json, or pass --url.",
        );
        process.exit(2);
      }

      // Resolve goals
      let goals: Goal[];
      if (flags.goal) {
        goals = [{ name: "cli-one-off", goal: flags.goal }];
      } else {
        try {
          goals = await loadGoals(effective.goalsFile);
        } catch (err) {
          console.error(`Error: failed to load goals (${effective.goalsFile}):`);
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(2);
        }
      }

      // Load credentials (optional)
      let credentials;
      try {
        credentials = await loadCredentials(effective.credentialsFile);
      } catch (err) {
        console.error(
          `Error: failed to load credentials (${effective.credentialsFile}):`,
        );
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(2);
      }

      // Skeleton report
      console.log("qagent run — executor not yet implemented.");
      console.log("");
      console.log("Effective settings:");
      console.log(JSON.stringify(effective, null, 2));
      console.log("");
      console.log(`Goals (${goals.length}):`);
      for (const g of goals) {
        console.log(`  - ${g.name}: ${g.goal}`);
      }
      console.log("");
      console.log(
        `Credentials: ${credentials.users.length} user(s), basicAuth=${credentials.basicAuth ? "yes" : "no"}`,
      );
    });
}
