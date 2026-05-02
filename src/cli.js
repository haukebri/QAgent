#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getModel } from '@mariozechner/pi-ai';
import { launchPage } from './browser.js';
import { ConfigError, loadConfig } from './config.js';
import { runConfigCommand } from './config-cmd.js';
import { runTodo } from './executor.js';
import { navigate } from './tools.js';
import { resolveApiKey } from './providers.js';
import { KNOWN_REPORTERS, selectReporters } from './reporters.js';

const HELP = `Usage:
  qagent --url <url> [options] "<goal>"  Run a goal against a URL
  qagent config <subcommand> [args]      Manage user/project config (try: qagent config --help)

Options:
  --url <url>            Start URL (required). Embed basic auth as https://user:pass@host/path
                         (creds are stripped before navigation and used as Playwright httpCredentials).
                         Or set via QAGENT_URL / config "url". Avoid storing creds-in-URL in
                         qagent.config.json — that file is typically git-tracked.
  --model <id>           LLM model (or env QAGENT_MODEL)
  --verifier-model <id>  Verifier model (defaults to --model)
  --provider <name>      LLM provider (default openrouter; or env QAGENT_PROVIDER)
  --api-key <key>        Provider API key (or env QAGENT_API_KEY / provider-specific env)
  --max-turns <n>        Turn cap (default 50)
  --test-timeout <s>     Wall-clock loop budget in seconds; verifier still runs after (default 300)
  --network-timeout <s>  Per page.goto, in seconds (default 30)
  --action-timeout <s>   Per click/fill in seconds; doubles as blocked-element detector (default 2)
  --reporter <list>      Comma-separated: list,json,ndjson,trace (default list)
  --output-dir <path>    Where trace files land (default results/, used with trace)
  --headed               Show browser window
  --version, -v          Print version
  --help, -h             Print this help

Environment:
  QAGENT_URL, QAGENT_PROVIDER, QAGENT_API_KEY, QAGENT_MODEL
  ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY  (per-provider fallbacks)
  QAGENT_TEST_TIMEOUT, QAGENT_NETWORK_TIMEOUT, QAGENT_ACTION_TIMEOUT  (seconds)

Exit: 0 pass | 1 fail | 2 config error | 3 runtime error`;

const VALUE_FLAGS = {
  '--url': 'url',
  '--model': 'model',
  '--verifier-model': 'verifierModel',
  '--provider': 'provider',
  '--api-key': 'apiKey',
  '--max-turns': 'maxTurns',
  '--test-timeout': 'testTimeout',
  '--network-timeout': 'networkTimeout',
  '--action-timeout': 'actionTimeout',
  '--reporter': 'reporter',
  '--output-dir': 'outputDir',
};

const TIMEOUT_FLAGS = new Set(['testTimeout', 'networkTimeout', 'actionTimeout']);

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
      } else if (TIMEOUT_FLAGS.has(key)) {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) throw new ConfigError(`${name} must be a positive number of seconds, got "${v}"`);
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

  const provider =
    flags.provider ??
    process.env.QAGENT_PROVIDER ??
    project.provider ??
    user.provider ??
    'openrouter';

  const modelId = flags.model ?? process.env.QAGENT_MODEL ?? project.model ?? user.model;
  if (!modelId) throw new ConfigError('no model. Pass --model, set QAGENT_MODEL, or set "model" in qagent.config.json / ~/.config/qagent/config.json.');

  const rawUrl =
    flags.url ??
    process.env.QAGENT_URL ??
    project.url ??
    user.url;
  if (!rawUrl) {
    throw new ConfigError('no url. Pass --url, set QAGENT_URL, or set "url" in qagent.config.json / ~/.config/qagent/config.json.');
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch (err) {
    throw new ConfigError(`invalid url: ${err.message}`);
  }
  const httpCredentials = parsedUrl.username
    ? {
        username: decodeURIComponent(parsedUrl.username),
        password: decodeURIComponent(parsedUrl.password),
      }
    : undefined;
  parsedUrl.username = '';
  parsedUrl.password = '';
  const startUrl = parsedUrl.toString();

  const { apiKey } = resolveApiKey({
    provider,
    flags,
    env: process.env,
    project,
    user,
  });

  const verifierModelId =
    flags.verifierModel ?? project.verifierModel ?? user.verifierModel ?? modelId;
  const maxTurns = flags.maxTurns ?? project.maxTurns ?? user.maxTurns ?? 50;

  const testTimeoutSec = resolveTimeout(
    flags.testTimeout, process.env.QAGENT_TEST_TIMEOUT, project.testTimeout, user.testTimeout, 300, 'QAGENT_TEST_TIMEOUT', 'testTimeout',
  );
  const networkTimeoutSec = resolveTimeout(
    flags.networkTimeout, process.env.QAGENT_NETWORK_TIMEOUT, project.networkTimeout, user.networkTimeout, 30, 'QAGENT_NETWORK_TIMEOUT', 'networkTimeout',
  );
  const actionTimeoutSec = resolveTimeout(
    flags.actionTimeout, process.env.QAGENT_ACTION_TIMEOUT, project.actionTimeout, user.actionTimeout, 2, 'QAGENT_ACTION_TIMEOUT', 'actionTimeout',
  );
  const reporterNames = flags.reporter ?? project.reporter ?? user.reporter ?? ['list'];
  for (const n of reporterNames) {
    if (!KNOWN_REPORTERS.includes(n)) {
      throw new ConfigError(`unknown reporter "${n}" in config. Valid: ${KNOWN_REPORTERS.join(', ')}`);
    }
  }
  const outputDir = flags.outputDir ?? project.outputDir ?? user.outputDir ?? 'results';
  const headed = flags.headed ?? project.headed ?? user.headed ?? false;

  const model = getModel(provider, modelId);
  if (!model) throw new ConfigError(`unknown model "${modelId}" for provider "${provider}"`);
  const verifierModel = getModel(provider, verifierModelId);
  if (!verifierModel) throw new ConfigError(`unknown verifier model "${verifierModelId}" for provider "${provider}"`);

  const reporters = selectReporters(reporterNames, { outputDir });
  const ctx = { goal, modelId, verifierModelId, url: startUrl };
  for (const r of reporters) await r.onStart?.(ctx);
  const onTurn = reporters.some((r) => r.onTurn)
    ? (h) => { for (const r of reporters) r.onTurn?.(h); }
    : null;

  const tRun = Date.now();
  let browser;
  let page;
  let result;
  try {
    ({ browser, page } = await launchPage({ httpCredentials, headed }));
    try {
      await navigate(page, startUrl, networkTimeoutSec * 1000);
    } catch (err) {
      result = buildErrorResult(err, page, tRun, 'pre-navigate failed');
    }
    if (!result) {
      try {
        result = await runTodo(
          page, goal, model, apiKey, maxTurns, verifierModel, onTurn,
          testTimeoutSec * 1000, networkTimeoutSec * 1000, actionTimeoutSec * 1000,
        );
      } catch (err) {
        result = buildErrorResult(err, page, tRun);
      }
    }
  } catch (err) {
    result = buildErrorResult(err, page, tRun);
  } finally {
    await browser?.close();
  }

  for (const r of reporters) {
    await r.onEnd?.(result, ctx);
  }

  if (result.outcome === 'pass') return 0;
  if (result.outcome === 'fail') return 1;
  return 3;
}

function buildErrorResult(err, page, startedAt, prefix = 'runner crashed') {
  return {
    outcome: 'error',
    evidence: `${prefix}: ${err.message.split('\n')[0]}`,
    llmVerdict: null,
    turns: 0,
    elapsedMs: Date.now() - startedAt,
    tokens: { input: 0, output: 0, totalTokens: 0, cost: 0 },
    verifierTokens: null,
    finalUrl: page?.url?.() ?? 'about:blank',
    history: [],
    warnings: [],
  };
}

function resolveTimeout(flagVal, envVal, projectVal, userVal, defaultSec, envName, configKey) {
  if (flagVal !== undefined) return flagVal;
  if (envVal !== undefined && envVal !== '') {
    const n = Number(envVal);
    if (!Number.isFinite(n) || n <= 0) {
      throw new ConfigError(`${envName} must be a positive number of seconds, got "${envVal}"`);
    }
    return n;
  }
  for (const [scope, val] of [['project', projectVal], ['user', userVal]]) {
    if (val !== undefined) {
      if (typeof val !== 'number' || !Number.isFinite(val) || val <= 0) {
        throw new ConfigError(`${scope} config "${configKey}" must be a positive number of seconds, got ${JSON.stringify(val)}`);
      }
      return val;
    }
  }
  return defaultSec;
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
