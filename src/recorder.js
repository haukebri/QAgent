import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function record(goal, modelId, verifierModelId, result, outDir = 'results') {
  const timestamp = new Date().toISOString();
  const safeStamp = timestamp.replace(/[:.]/g, '-');
  const dir = resolve(outDir);
  await mkdir(dir, { recursive: true });
  const filepath = resolve(dir, `${safeStamp}.json`);
  const payload = {
    timestamp,
    goal,
    model: modelId,
    verifierModel: verifierModelId,
    outcome: result.outcome,
    evidence: result.evidence,
    llmVerdict: result.llmVerdict,
    finalUrl: result.finalUrl,
    finalSnapshot: result.finalSnapshot,
    stats: {
      turns: result.turns,
      elapsedMs: result.elapsedMs,
      tokens: result.tokens,
      verifierTokens: result.verifierTokens,
    },
    steps: result.history,
    warnings: result.warnings,
  };
  await writeFile(filepath, JSON.stringify(payload, null, 2), 'utf8');
  return filepath;
}
