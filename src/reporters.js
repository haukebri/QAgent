import { buildPayload, record } from './recorder.js';

export const KNOWN_REPORTERS = ['list', 'json', 'ndjson', 'trace'];

export function selectReporters(names, { outputDir } = {}) {
  return names.map((n) => makeReporter(n, { outputDir }));
}

function makeReporter(name, { outputDir }) {
  if (name === 'list') return listReporter();
  if (name === 'json') return jsonReporter();
  if (name === 'ndjson') return ndjsonReporter();
  if (name === 'trace') return traceReporter(outputDir);
  throw new Error(`unreachable: unknown reporter "${name}"`);
}

function listReporter() {
  return {
    onEnd(result) {
      for (const h of result.history ?? []) {
        const target = h.target ? ` [${h.target}]` : '';
        const url = h.url ? ` @ ${h.url}` : '';
        const extra = h.error ? ` -> error: ${h.error}` : '';
        process.stdout.write(`turn ${h.turn}: ${JSON.stringify(h.action)}${target}${url}${extra}\n`);
      }
      const elapsedS = (result.elapsedMs / 1000).toFixed(1);
      const perTurn = result.turns ? (result.elapsedMs / result.turns / 1000).toFixed(1) : '-';
      process.stdout.write(`\nfinal url: ${result.finalUrl}\n`);
      process.stdout.write(`turns: ${result.turns} | elapsed: ${elapsedS}s | avg/turn: ${perTurn}s\n`);
      const t = result.tokens;
      process.stdout.write(`tokens: ${t.totalTokens} (in=${t.input}, out=${t.output}) | cost: $${t.cost.toFixed(4)}\n`);
      if (result.verifierTokens) {
        const v = result.verifierTokens;
        process.stdout.write(`verifier: ${v.totalTokens} (in=${v.input}, out=${v.output}) | cost: $${v.cost.toFixed(4)}\n`);
      }
      if (result.llmVerdict) {
        const lv = result.llmVerdict;
        const extra = lv.summary ?? lv.reason ?? '';
        process.stdout.write(`driver verdict: ${lv.action}${extra ? ` — ${extra}` : ''}\n`);
      }
      const status = result.outcome === 'pass' ? 'PASS' : result.outcome === 'fail' ? 'FAIL' : 'ERROR';
      process.stdout.write(`${status}: ${result.evidence}\n`);
      for (const w of result.warnings ?? []) process.stdout.write(`WARNING: ${w}\n`);
    },
  };
}

function jsonReporter() {
  return {
    onEnd(result, ctx) {
      const payload = buildPayload(ctx.goal, ctx.modelId, ctx.verifierModelId, result);
      process.stdout.write(JSON.stringify(payload) + '\n');
    },
  };
}

function ndjsonReporter() {
  return {
    onTurn(h) {
      process.stdout.write(JSON.stringify({ event: 'turn', ...h }) + '\n');
    },
    onEnd(result, ctx) {
      const envelope = {
        event: 'done',
        goal: ctx.goal,
        outcome: result.outcome,
        evidence: result.evidence,
        turns: result.turns,
        elapsedMs: result.elapsedMs,
        cost: result.tokens?.cost ?? 0,
        totalTokens: result.tokens?.totalTokens ?? 0,
        finalUrl: result.finalUrl,
        warnings: result.warnings ?? [],
      };
      process.stdout.write(JSON.stringify(envelope) + '\n');
    },
  };
}

function traceReporter(outputDir) {
  return {
    async onEnd(result, ctx) {
      const path = await record(ctx.goal, ctx.modelId, ctx.verifierModelId, result, outputDir);
      process.stderr.write(`trace: ${path}\n`);
    },
  };
}
