import { readFileSync } from "node:fs";

export function loadSkillsDescription(skillsPath: string | undefined): string | null {
  if (!skillsPath) {
    return null;
  }

  try {
    return readFileSync(skillsPath, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid QAgent skills description at ${skillsPath}: ${detail}`);
  }
}

export function formatSkillsDescriptionForPrompt(description: string | null): string {
  if (!description || description.trim().length === 0) {
    return "None provided.";
  }

  return description.trim();
}
