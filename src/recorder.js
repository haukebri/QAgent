import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export function buildPayload(goal, modelId, verifierModelId, result) {
  return {
    timestamp: new Date().toISOString(),
    goal,
    model: modelId,
    verifierModel: verifierModelId,
    outcome: result.outcome,
    evidence: result.evidence,
    llmVerdict: result.llmVerdict,
    finalUrl: result.finalUrl,
    stats: {
      turns: result.turns,
      elapsedMs: result.elapsedMs,
      tokens: result.tokens,
      verifierTokens: result.verifierTokens,
    },
    steps: result.history,
    warnings: result.warnings,
    snapshotStats: result.snapshotStats,
  };
}

export async function record(goal, modelId, verifierModelId, result, outDir = 'results') {
  const payload = buildPayload(goal, modelId, verifierModelId, result);
  const dir = resolve(outDir);
  await mkdir(dir, { recursive: true });
  const filepath = resolve(dir, `${payload.timestamp.replace(/[:.]/g, '-')}.json`);
  await writeFile(filepath, JSON.stringify(payload, null, 2), 'utf8');
  return filepath;
}
