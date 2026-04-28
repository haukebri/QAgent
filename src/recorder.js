import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

const roundCost = (n) => Math.round((n ?? 0) * 1000) / 1000;
const toSec = (ms) => Math.round((ms ?? 0) / 100) / 10;

function transformTokens(t) {
  if (!t) return t;
  return { ...t, cost: roundCost(t.cost) };
}

function transformStep(s) {
  const out = { ...s };
  if ('atMs' in out) {
    out.atSec = toSec(out.atMs);
    delete out.atMs;
  }
  if ('ms' in out) {
    out.durationSec = toSec(out.ms);
    delete out.ms;
  }
  if (out.tokens) out.tokens = transformTokens(out.tokens);
  return out;
}

export function buildPayload(goal, modelId, verifierModelId, result) {
  return {
    timestamp: new Date().toISOString(),
    goal,
    model: modelId,
    verifierModel: verifierModelId,
    outcome: result.outcome,
    reasoning: result.llmVerdict?.summary ?? null,
    llmVerdict: { reason: result.llmVerdict?.reason ?? null },
    finalUrl: result.finalUrl,
    stats: {
      turns: result.turns,
      elapsedSec: toSec(result.elapsedMs),
      tokens: transformTokens(result.tokens),
      verifierTokens: transformTokens(result.verifierTokens),
    },
    steps: (result.history ?? []).map(transformStep),
    warnings: result.warnings,
  };
}

export async function record(goal, modelId, verifierModelId, result, outDir = 'results') {
  const payload = buildPayload(goal, modelId, verifierModelId, result);
  const dir = resolve(outDir);
  await mkdir(dir, { recursive: true });
  const hash = randomBytes(2).toString('hex').toUpperCase();
  const stem = `${payload.timestamp.slice(0, 16).replace(':', '-')}H${hash}`;
  const filepath = resolve(dir, `${stem}.json`);
  await writeFile(filepath, JSON.stringify(payload, null, 2), 'utf8');
  if (result.outcome !== 'pass') {
    if (result.finalSnapshot) {
      await writeFile(resolve(dir, `${stem}.snapshot.yaml`), result.finalSnapshot, 'utf8');
    }
    if (result.failureScreenshot) {
      await writeFile(resolve(dir, `${stem}.screenshot.png`), result.failureScreenshot);
    }
  }
  return filepath;
}
