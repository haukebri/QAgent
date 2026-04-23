import { readFileSync } from "node:fs";
import { z } from "zod";

const BasicAuthSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const UserCredentialsSchema = z
  .object({
    label: z.string().min(1),
    email: z.string().min(1).optional(),
    username: z.string().min(1).optional(),
    password: z.string().min(1),
  })
  .superRefine((value, ctx) => {
    if (!value.email && !value.username) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Each user must include either an email or username.",
      });
    }
  });

const CredentialsSchema = z.object({
  basicAuth: BasicAuthSchema.optional(),
  users: z.array(UserCredentialsSchema).optional(),
});

export type QAgentCredentials = z.infer<typeof CredentialsSchema>;

function interpolateEnvString(value: string, filePath: string, allowedEnvNames: ReadonlySet<string>): string {
  return value.replaceAll(/\$\{([^}]+)\}/g, (_match, name: string) => {
    if (!allowedEnvNames.has(name)) {
      throw new Error(
        `Environment variable ${name} is not allowed in ${filePath}. Pass --allow-credential-env ${name} to permit it.`,
      );
    }

    const resolved = process.env[name];
    if (resolved === undefined) {
      throw new Error(`Environment variable ${name} is not set (needed by ${filePath}).`);
    }

    return resolved;
  });
}

function interpolateEnv(value: unknown, filePath: string, allowedEnvNames: ReadonlySet<string>): unknown {
  if (typeof value === "string") {
    return interpolateEnvString(value, filePath, allowedEnvNames);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => interpolateEnv(entry, filePath, allowedEnvNames));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, interpolateEnv(entry, filePath, allowedEnvNames)]),
    );
  }

  return value;
}

export function loadCredentials(
  credentialsPath: string | undefined,
  opts?: { allowedEnvNames?: ReadonlySet<string> },
): QAgentCredentials | null {
  if (!credentialsPath) {
    return null;
  }

  try {
    const raw = readFileSync(credentialsPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const interpolated = interpolateEnv(parsed, credentialsPath, opts?.allowedEnvNames ?? new Set());
    return CredentialsSchema.parse(interpolated);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid QAgent credentials at ${credentialsPath}: ${detail}`);
  }
}

export function formatCredentialsForPrompt(credentials: QAgentCredentials | null): string {
  if (!credentials) {
    return "None provided.";
  }

  if (!credentials.users || credentials.users.length === 0) {
    return "None provided.";
  }

  return JSON.stringify({ users: credentials.users }, null, 2);
}
