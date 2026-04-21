import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

// ---------- Config (qagent.config.json) ----------

export const ConfigSchema = z.object({
  baseUrl: z.string().url().optional(),
  goalsFile: z.string().default("tests/e2e/goals.json"),
  credentialsFile: z.string().default(".qagent/test-credentials.json"),
  outputDir: z.string().default(".qagent/runs"),
  playwrightGeneratedDir: z.string().default("tests/e2e/playwright/generated"),
  promptTemplate: z.string().default(".qagent/prompt.md"),
  allowedTools: z.string().default("Bash(agent-browser:*) Read Write"),
  browser: z
    .object({
      headless: z.boolean().default(true),
      viewport: z
        .object({
          width: z.number().int().positive().default(1280),
          height: z.number().int().positive().default(720),
        })
        .default({ width: 1280, height: 720 }),
    })
    .default({ headless: true, viewport: { width: 1280, height: 720 } }),
  record: z.boolean().default(false),
  maxSteps: z.number().int().positive().default(40),
  timeoutMs: z.number().int().positive().default(180_000),
});
export type Config = z.infer<typeof ConfigSchema>;

// ---------- Goals (goals.json) ----------

export const GoalSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "Goal name must be kebab-case"),
  goal: z.string().min(1),
});
export const GoalsSchema = z.array(GoalSchema).min(1, "At least one goal required");
export type Goal = z.infer<typeof GoalSchema>;

// ---------- Credentials (test-credentials.json) ----------

export const CredentialsSchema = z.object({
  basicAuth: z
    .object({
      username: z.string(),
      password: z.string(),
    })
    .optional(),
  users: z
    .array(
      z.object({
        label: z.string().min(1),
        email: z.string().optional(),
        username: z.string().optional(),
        password: z.string(),
      }),
    )
    .default([]),
});
export type Credentials = z.infer<typeof CredentialsSchema>;

// ---------- Loaders ----------

export async function loadConfig(path = "qagent.config.json"): Promise<Config> {
  const absPath = resolve(path);
  if (!existsSync(absPath)) {
    // No file — return schema defaults so `run` still works with --goal + --url.
    return ConfigSchema.parse({});
  }
  const raw = await readFile(absPath, "utf-8");
  const parsed = JSON.parse(raw);
  return ConfigSchema.parse(parsed);
}

export async function loadGoals(path: string): Promise<Goal[]> {
  const absPath = resolve(path);
  if (!existsSync(absPath)) {
    throw new Error(`Goals file not found: ${absPath}`);
  }
  const raw = await readFile(absPath, "utf-8");
  const parsed = JSON.parse(raw);
  return GoalsSchema.parse(parsed);
}

export async function loadCredentials(path: string): Promise<Credentials> {
  const absPath = resolve(path);
  if (!existsSync(absPath)) {
    // Credentials are optional — a goal may not need them.
    return CredentialsSchema.parse({});
  }
  const raw = await readFile(absPath, "utf-8");
  const parsed = interpolateEnv(JSON.parse(raw));
  return CredentialsSchema.parse(parsed);
}

/** Recursively replace `${ENV_VAR}` inside strings with process.env values. */
function interpolateEnv<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_match, key: string) => {
      return process.env[key] ?? "";
    }) as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => interpolateEnv(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = interpolateEnv(v);
    }
    return out as T;
  }
  return value;
}
