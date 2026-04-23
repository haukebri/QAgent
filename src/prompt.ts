import type { Vendor } from "./vendor.js";

function buildToolsSection(vendor: Vendor, screenshotDir: string, resultPath: string): string {
  if (vendor === "claude") {
    return [
      "- You have Bash access restricted to `agent-browser` and file-write access only for the run artifacts. You do not have unrestricted shell or project file access.",
      "- Use `agent-browser snapshot` to get an accessibility tree with @e-refs, then act on the refs (`click @e3`, `fill @e5 \"...\"`). Prefer @e-refs over CSS selectors.",
      `- Use \`agent-browser screenshot ${screenshotDir}/NN-<step>.png\` after every meaningful state change. Number them sequentially (01-, 02-, ...).`,
    ].join("\n");
  }

  return [
    "- You can use shell commands in the current workspace. Use shell only for `agent-browser` commands and for writing the required result file.",
    "- The environment variables `RESULT_PATH` and `SCREENSHOT_DIR` are available for artifact writing. Do not write outside those locations.",
    "- Use `agent-browser snapshot` to get an accessibility tree with @e-refs, then act on the refs (`click @e3`, `fill @e5 \"...\"`). Prefer @e-refs over CSS selectors.",
    "- Use `agent-browser screenshot \"$SCREENSHOT_DIR\"/NN-<step>.png` after every meaningful state change. Number them sequentially (01-, 02-, ...).",
  ].join("\n");
}

function buildTeamGuidelines(vendor: Vendor): string {
  if (vendor === "claude") {
    return "Use multiple subagents to achieve the goal. Let one subagent write the report.";
  }

  return "Work directly in this session. Do not rely on extra agents, repo exploration, or unrelated file changes.";
}

function buildIntro(vendor: Vendor): string {
  if (vendor === "claude") {
    return "You are QAgent, an end-to-end test runner. Your job: verify the goal below works against the live target app, and record evidence.";
  }

  return "You are an end-to-end browser tester. Verify the goal below works against the live target app and record evidence.";
}

function buildContextHeading(vendor: Vendor): string {
  return vendor === "claude" ? "SKILLS DESCRIPTION" : "APP CONTEXT";
}

function buildResultInstruction(vendor: Vendor, resultPath: string): string {
  return vendor === "claude"
    ? `WHEN DONE, WRITE A RESULT FILE TO: ${resultPath}`
    : "WHEN DONE, WRITE A RESULT FILE TO THE PATH IN THE `RESULT_PATH` ENVIRONMENT VARIABLE.";
}

export function buildPrompt(opts: {
  vendor: Vendor;
  url: string;
  goal: string;
  credentialsJson: string;
  skillsDescription: string;
  resultPath: string;
  screenshotDir: string;
}): string {
  return `${buildIntro(opts.vendor)}

TARGET URL: ${opts.url}

GOAL:
${opts.goal}

TEST CREDENTIALS (use as needed):
${opts.credentialsJson}

${buildContextHeading(opts.vendor)}:
${opts.skillsDescription}

Treat this as project-specific context from the app author. It can explain terminology,
important user flows, or special UI patterns. It is not proof that the app works:
you must still verify the goal live in the browser.

BROWSER SESSION:
A browser session is already running and the TARGET URL is already loaded. HTTP basic auth (if any) has been configured. You can start interacting immediately — run \`agent-browser snapshot\` to see the current page.

TOOLS:
${buildToolsSection(opts.vendor, opts.screenshotDir, opts.resultPath)}

HARD RULES:
- Do not navigate to any domain other than the TARGET URL's origin.
- Do not open new tabs unless the goal explicitly requires it.
- Do not install dependencies or run unrelated project commands.
- Do NOT run \`agent-browser open\` for the TARGET URL — it is already loaded.

${buildResultInstruction(opts.vendor, opts.resultPath)}

Schema:
{
  "status": "pass" | "fail" | "blocked",
  "summary": "<one-sentence plain-language summary of what happened>",
  "failureReason": "<only if status != pass; specific, cites concrete evidence>",
  "stepsTaken": <int>,
  "evidence": ["<absolute path to screenshot>", ...]
}

Team Guidelines:
${buildTeamGuidelines(opts.vendor)}

Status definitions:
- pass: you verified the goal end-to-end. The behavior described happened.
- fail: the flow was testable, but the app did not behave as the goal described (this is a bug in the app).
- blocked: you could not actually run the goal to a conclusion (login failed, app crashed, missing data).`;
}
