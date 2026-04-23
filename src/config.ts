import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { SUPPORTED_VENDORS } from "./vendor.js";

const ConfigSchema = z.object({
  vendor: z.enum(SUPPORTED_VENDORS).optional(),
  baseUrl: z.string().url().optional(),
  goalsFile: z.string().min(1).optional(),
  credentialsFile: z.string().min(1).optional(),
  skillsFile: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

export type QAgentConfig = z.infer<typeof ConfigSchema>;

export function resolveConfigPath(configPath: string | undefined): string {
  return path.resolve(configPath ?? "qagent.config.json");
}

export function loadConfig(configPath: string | undefined): QAgentConfig | null {
  const resolvedPath = resolveConfigPath(configPath);

  try {
    const raw = readFileSync(resolvedPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return ConfigSchema.parse(parsed);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return null;
    }

    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid QAgent config at ${resolvedPath}: ${detail}`);
  }
}
