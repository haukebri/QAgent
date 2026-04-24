import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function record(goal, modelId, result, outDir = 'results') {
  const timestamp = new Date().toISOString();
  const safeStamp = timestamp.replace(/[:.]/g, '-');
  const dir = resolve(outDir);
  await mkdir(dir, { recursive: true });
  const filepath = resolve(dir, `${safeStamp}.json`);
  const payload = {
    timestamp,
    goal,
    model: modelId,
    outcome: result.outcome,
    summary: result.summary,
    reason: result.reason,
    finalUrl: result.finalUrl,
    stats: {
      turns: result.turns,
      elapsedMs: result.elapsedMs,
      tokens: result.tokens,
    },
    steps: result.history,
    warnings: result.warnings,
  };
  await writeFile(filepath, JSON.stringify(payload, null, 2), 'utf8');
  return filepath;
}
