import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatCredentialsForPrompt } from "../dist/credentials.js";
import { buildPrompt } from "../dist/prompt.js";
import { formatSkillsDescriptionForPrompt } from "../dist/skills.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(__dirname, "fixtures", "prompts");

const realisticCredentials = {
  basicAuth: {
    username: "staging",
    password: "should-not-appear",
  },
  users: [
    {
      label: "default",
      email: "qa@example.com",
      password: "hunter2",
    },
    {
      label: "finance-admin",
      username: "fin-admin",
      password: "correct-horse-battery-staple",
    },
  ],
};

const realisticSkillsDescription = `
- This is a B2B billing dashboard.
- The main post-login landing page is called "Overview".
- Invoices live under Settings > Billing.
- "Workspace" means the currently selected customer account.
`;

function buildRealisticPrompt(vendor) {
  return buildPrompt({
    vendor,
    url: "https://staging.example.com/app",
    goal: "I can sign in as the finance admin, open Billing, and download the April invoice PDF.",
    credentialsJson: formatCredentialsForPrompt(realisticCredentials),
    skillsDescription: formatSkillsDescriptionForPrompt(realisticSkillsDescription),
    resultPath: "/tmp/qagent/runs/20260423-1015-billing-download-ab12cd/result.json",
    screenshotDir: "/tmp/qagent/runs/20260423-1015-billing-download-ab12cd",
  });
}

async function readFixture(name) {
  return (await readFile(path.join(fixtureDir, name), "utf8")).trimEnd();
}

test("claude prompt matches the realistic golden example", async () => {
  const expected = await readFixture("claude.txt");
  const actual = buildRealisticPrompt("claude");
  assert.equal(actual.trimEnd(), expected.trimEnd());
});

test("codex prompt matches the realistic golden example", async () => {
  const expected = await readFixture("codex.txt");
  const actual = buildRealisticPrompt("codex");
  assert.equal(actual.trimEnd(), expected.trimEnd());
});
