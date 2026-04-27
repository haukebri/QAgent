#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getModel } from '@mariozechner/pi-ai';
import { launchPage } from './browser.js';
import { ConfigError, loadConfig } from './config.js';
import { runConfigCommand } from './config-cmd.js';
import { runTodo } from './executor.js';
import { KNOWN_REPORTERS, selectReporters } from './reporters.js';

const HELP = `Usage:
  qagent [options] "<goal>"             Run a goal
  qagent config <subcommand> [args]     Manage user/project config (try: qagent config --help)

Options:
  --model <id>           LLM model (or env QAGENT_MODEL)
  --verifier-model <id>  Verifier model (defaults to --model)
  --api-key <key>        OpenRouter key (or env QAGENT_API_KEY / OPENROUTER_API_KEY)
  --max-turns <n>        Turn cap (default 50)
  --reporter <list>      Comma-separated: list,json,ndjson,trace (default list)
  --output-dir <path>    Where trace files land (default results/, used with trace)
  --headed               Show browser window
  --version, -v          Print version
  --help, -h             Print this help

Environment:
  QAGENT_API_KEY, OPENROUTER_API_KEY, QAGENT_MODEL
  BASIC_AUTH_USER, BASIC_AUTH_PASS  (per-page httpCredentials)

Exit: 0 pass | 1 fail | 2 config error | 3 runtime error`;

const VALUE_FLAGS = {
  '--model': 'model',
  '--verifier-model': 'verifierModel',
  '--api-key': 'apiKey',
  '--max-turns': 'maxTurns',
  '--reporter': 'reporter',
  '--output-dir': 'outputDir',
};

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { flags.help = true; continue; }
    if (a === '--version' || a === '-v') { flags.version = true; continue; }
    if (a === '--headed') { flags.headed = true; continue; }
    const eq = a.indexOf('=');
    const name = eq === -1 ? a : a.slice(0, eq);
    if (VALUE_FLAGS[name]) {
      const key = VALUE_FLAGS[name];
      const v = eq === -1 ? argv[++i] : a.slice(eq + 1);
      if (v === undefined) throw new ConfigError(`flag ${name} requires a value`);
      if (key === 'maxTurns') {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) throw new ConfigError(`--max-turns must be a positive number, got "${v}"`);
        flags[key] = n;
      } else if (key === 'reporter') {
        const names = v.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
        for (const n of names) {
          if (!KNOWN_REPORTERS.includes(n)) {
            throw new ConfigError(`unknown reporter: ${n}. Valid: ${KNOWN_REPORTERS.join(', ')}`);
          }
        }
        flags[key] = names;
      } else {
        flags[key] = v;
      }
      continue;
    }
    if (a.startsWith('-')) {
      process.stderr.write(`qagent: unknown flag ${a} (ignored)\n`);
      continue;
    }
    positional.push(a);
  }
  return { flags, positional };
}

function readVersion() {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(resolve(here, '..', 'package.json'), 'utf8'));
  return pkg.version;
}

async function main() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs[0] === 'config') {
    return runConfigCommand({ argv: rawArgs.slice(1), cwd: process.cwd(), env: process.env });
  }
  const { flags, positional } = parseArgs(rawArgs);

  if (flags.help) { process.stdout.write(HELP + '\n'); return 0; }
  if (flags.version) { process.stdout.write(readVersion() + '\n'); return 0; }

  if (positional.length === 0) {
    process.stderr.write(`qagent: missing goal.\n${HELP}\n`);
    return 2;
  }
  if (positional.length > 1) {
    throw new ConfigError(`expected one goal, got ${positional.length} (did you forget to quote?)`);
  }
  const goal = positional[0];

  const { user, project } = loadConfig({ cwd: process.cwd() });

  const modelId = flags.model ?? process.env.QAGENT_MODEL ?? project.model ?? user.model;
  if (!modelId) throw new ConfigError('no model. Pass --model, set QAGENT_MODEL, or set "model" in qagent.config.json / ~/.config/qagent/config.json.');

  const apiKey =
    flags.apiKey ??
    process.env.QAGENT_API_KEY ??
    process.env.OPENROUTER_API_KEY ??
    project.apiKey ??
    user.apiKey;
  if (!apiKey) {
    throw new ConfigError(
      'no API key found.\nPass --api-key, set QAGENT_API_KEY / OPENROUTER_API_KEY, or set "apiKey" in qagent.config.json / ~/.config/qagent/config.json.\nSee https://openrouter.ai/keys',
    );
  }

  const verifierModelId =
    flags.verifierModel ?? project.verifierModel ?? user.verifierModel ?? modelId;
  const maxTurns = flags.maxTurns ?? project.maxTurns ?? user.maxTurns ?? 50;
  const reporterNames = flags.reporter ?? project.reporter ?? user.reporter ?? ['list'];
  for (const n of reporterNames) {
    if (!KNOWN_REPORTERS.includes(n)) {
      throw new ConfigError(`unknown reporter "${n}" in config. Valid: ${KNOWN_REPORTERS.join(', ')}`);
    }
  }
  const outputDir = flags.outputDir ?? project.outputDir ?? user.outputDir ?? 'results';
  const headed = flags.headed ?? project.headed ?? user.headed ?? false;

  const model = getModel('openrouter', modelId);
  if (!model) throw new ConfigError(`unknown model: ${modelId}`);
  const verifierModel = getModel('openrouter', verifierModelId);
  if (!verifierModel) throw new ConfigError(`unknown verifier model: ${verifierModelId}`);

  const httpCredentials =
    process.env.BASIC_AUTH_USER && process.env.BASIC_AUTH_PASS
      ? { username: process.env.BASIC_AUTH_USER, password: process.env.BASIC_AUTH_PASS }
      : undefined;

  const reporters = selectReporters(reporterNames, { outputDir });
  const ctx = { goal, modelId, verifierModelId };
  for (const r of reporters) await r.onStart?.(ctx);
  const onTurn = reporters.some((r) => r.onTurn)
    ? (h) => { for (const r of reporters) r.onTurn?.(h); }
    : null;

  const { browser, page } = await launchPage({ httpCredentials, headed });
  try {
    let result;
    try {
      result = await runTodo(page, goal, model, apiKey, maxTurns, verifierModel, onTurn);
    } catch (err) {
      result = {
        outcome: 'error',
        evidence: `runner crashed: ${err.message.split('\n')[0]}`,
        llmVerdict: null,
        turns: 0,
        elapsedMs: 0,
        tokens: { input: 0, output: 0, totalTokens: 0, cost: 0 },
        verifierTokens: null,
        finalUrl: page.url(),
        history: [],
        warnings: [],
      };
    }

    for (const r of reporters) {
      await r.onEnd?.(result, ctx);
    }

    if (result.outcome === 'pass') return 0;
    if (result.outcome === 'fail') return 1;
    return 3;
  } finally {
    await browser.close();
  }
}

try {
  process.exit(await main());
} catch (err) {
  if (err instanceof ConfigError) {
    process.stderr.write(`qagent: ${err.message}\n`);
    process.exit(2);
  }
  process.stderr.write(`qagent: ${err.message}\n`);
  process.exit(3);
}
