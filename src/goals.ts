import { readFileSync } from "node:fs";
import { z } from "zod";

const GoalSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Goal name must be kebab-case (e.g. 'login-flow')"),
  goal: z.string().min(1),
});

const GoalsFileSchema = z.array(GoalSchema).min(1, "Goals file must contain at least one goal");

export type Goal = z.infer<typeof GoalSchema>;

export function loadGoals(goalsPath: string): Goal[] {
  let raw: string;
  try {
    raw = readFileSync(goalsPath, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      throw new Error(`Goals file not found: ${goalsPath}`);
    }
    throw error;
  }

  const parsed = JSON.parse(raw) as unknown;
  const goals = GoalsFileSchema.parse(parsed);

  // Check name uniqueness
  const names = new Set<string>();
  for (const goal of goals) {
    if (names.has(goal.name)) {
      throw new Error(`Duplicate goal name: "${goal.name}"`);
    }
    names.add(goal.name);
  }

  return goals;
}
