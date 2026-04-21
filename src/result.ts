import { readFileSync } from "node:fs";
import { z } from "zod";

export const ResultSchema = z.object({
  status: z.enum(["pass", "fail", "blocked"]),
  summary: z.string(),
  failureReason: z.string().nullable().optional(),
  stepsTaken: z.number(),
  evidence: z.array(z.string()),
});

export type Result = z.infer<typeof ResultSchema>;

export function readResult(filePath: string): Result {
  const raw = readFileSync(filePath, "utf-8");
  return ResultSchema.parse(JSON.parse(raw));
}
