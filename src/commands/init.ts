import type { CAC } from "cac";

/**
 * `qagent init` — scaffolds QAgent into the current Node project.
 *
 * Currently a stub. See DESIGN.md section 11 for the full spec.
 */
export function registerInitCommand(cli: CAC): void {
  cli
    .command("init", "Scaffold QAgent into the current project")
    .action(async () => {
      console.log("qagent init — not yet implemented.");
      console.log("");
      console.log("Planned steps (per DESIGN.md §11):");
      console.log("  1. Verify claude CLI in PATH");
      console.log("  2. Verify agent-browser in PATH (install if missing)");
      console.log("  3. Install Playwright into tests/e2e/playwright/ if missing");
      console.log("  4. Create qagent.config.json with defaults");
      console.log("  5. Create tests/e2e/goals.json with example goal");
      console.log("  6. Create .qagent/prompt.md with default template");
      console.log("  7. Create .qagent/test-credentials.json placeholder");
      console.log("  8. Append .qagent/ entries to .gitignore");
    });
}
