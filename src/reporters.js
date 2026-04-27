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

const isTTY = !!process.stdout.isTTY;
const c = isTTY
  ? {
      dim: '\x1b[2m',
      red: '\x1b[31m',
      green: '\x1b[32m',
      yellow: '\x1b[33m',
      cyan: '\x1b[36m',
      reset: '\x1b[0m',
    }
  : { dim: '', red: '', green: '', yellow: '', cyan: '', reset: '' };

function fmtMs(ms) {
  if (ms == null) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function describeAction(a, target) {
  const tgt = target ? `"${target}"` : '';
  switch (a.action) {
    case 'navigate': return a.url ?? '';
    case 'click': return tgt;
    case 'fill': return tgt ? `${tgt} = ${JSON.stringify(a.value ?? '')}` : `= ${JSON.stringify(a.value ?? '')}`;
    case 'wait': return `${a.ms ?? 1000}ms`;
    case 'done': return a.summary ? `"${a.summary}"` : '';
    case 'fail': return a.reason ? `"${a.reason}"` : '';
    default: return JSON.stringify(a);
  }
}

function listReporter() {
  let lastUrl = null;
  let lastAtMs = 0;
  return {
    onStart(ctx) {
      process.stdout.write(`${c.cyan}▶${c.reset} ${ctx.goal}\n\n`);
    },
    onTurn(h) {
      const a = h.action ?? {};
      const verb = (a.action ?? '?').padEnd(8);
      const num = String(h.turn).padStart(2);
      const indicator = h.error ? `${c.red}✗${c.reset}  ` : '   ';
      const body = describeAction(a, h.target);
      const turnMs = h.atMs != null ? h.atMs - lastAtMs : null;
      const showDur = a.action !== 'wait' && turnMs != null;
      const dur = showDur ? `  ${c.dim}${fmtMs(turnMs)}${c.reset}` : '';
      process.stdout.write(`${indicator}${num}  ${verb}  ${body}${dur}\n`);
      if (h.error) {
        process.stdout.write(`       ${c.red}— ${h.error}${c.reset}\n`);
      } else if (
        a.action !== 'navigate' &&
        a.action !== 'done' &&
        a.action !== 'fail' &&
        h.url &&
        h.url !== lastUrl
      ) {
        process.stdout.write(`       ${c.cyan}→${c.reset} ${h.url}\n`);
      }
      if (h.url) lastUrl = h.url;
      if (h.atMs != null) lastAtMs = h.atMs;
    },
    onEnd(result) {
      for (const w of result.warnings ?? []) {
        process.stdout.write(`${c.yellow}WARNING${c.reset}: ${w}\n`);
      }
      const elapsedS = (result.elapsedMs / 1000).toFixed(1);
      const totalCost = (result.tokens?.cost ?? 0) + (result.verifierTokens?.cost ?? 0);
      const tag =
        result.outcome === 'pass'
          ? `${c.green}✓ PASS${c.reset}`
          : result.outcome === 'fail'
            ? `${c.red}✗ FAIL${c.reset}`
            : `${c.red}✗ ERROR${c.reset}`;
      process.stdout.write(`\n${tag} — ${result.evidence}\n`);
      process.stdout.write(`${c.dim}${result.turns} turns · ${elapsedS}s · $${totalCost.toFixed(4)}${c.reset}\n`);
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
      const driverCost = result.tokens?.cost ?? 0;
      const verifierCost = result.verifierTokens?.cost ?? 0;
      const driverTokens = result.tokens?.totalTokens ?? 0;
      const verifierTokens = result.verifierTokens?.totalTokens ?? 0;
      const envelope = {
        event: 'done',
        goal: ctx.goal,
        outcome: result.outcome,
        evidence: result.evidence,
        turns: result.turns,
        elapsedMs: result.elapsedMs,
        driverCost,
        verifierCost,
        totalCost: driverCost + verifierCost,
        driverTokens,
        verifierTokens,
        totalTokens: driverTokens + verifierTokens,
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
