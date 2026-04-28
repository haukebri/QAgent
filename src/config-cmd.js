import { existsSync } from 'node:fs';
import { ConfigError, KEY_LIST, KEY_TYPES, configPath, loadConfig, setConfigValue } from './config.js';
import { KNOWN_REPORTERS } from './reporters.js';

const ENV_LOOKUP = {
  model: ['QAGENT_MODEL'],
  verifierModel: [],
  apiKey: ['QAGENT_API_KEY', 'OPENROUTER_API_KEY'],
  maxTurns: [],
  testTimeout: ['QAGENT_TEST_TIMEOUT'],
  networkTimeout: ['QAGENT_NETWORK_TIMEOUT'],
  actionTimeout: ['QAGENT_ACTION_TIMEOUT'],
  reporter: [],
  outputDir: [],
  headed: [],
};

const DEFAULTS = {
  maxTurns: 50,
  testTimeout: 300,
  networkTimeout: 30,
  actionTimeout: 2,
  reporter: ['list'],
  outputDir: 'results',
  headed: false,
};

const KEY_DOCS = {
  model:          'OpenRouter LLM model id (e.g. anthropic/claude-sonnet-4-5)',
  verifierModel:  'Verifier model id; defaults to model when unset',
  apiKey:         'OpenRouter API key (sk-or-...)',
  maxTurns:       'Positive integer turn cap',
  testTimeout:    'Wall-clock loop budget in seconds; verifier still runs after',
  networkTimeout: 'Per page.goto + post-action networkidle wait, in seconds',
  actionTimeout:  'Per click/fill in seconds; doubles as blocked-element detector',
  reporter:       `Comma-separated; values: ${KNOWN_REPORTERS.join(', ')}`,
  outputDir:      'Path where the trace reporter writes files',
  headed:         'Show browser window; accepts true|false or 1|0',
};

const ENV_HINTS = {
  model: 'env QAGENT_MODEL',
  apiKey: 'env QAGENT_API_KEY / OPENROUTER_API_KEY',
  testTimeout: 'env QAGENT_TEST_TIMEOUT',
  networkTimeout: 'env QAGENT_NETWORK_TIMEOUT',
  actionTimeout: 'env QAGENT_ACTION_TIMEOUT',
};

function formatDefault(v) {
  if (v === undefined) return '';
  if (Array.isArray(v)) return v.join(',');
  return String(v);
}

function buildHelp() {
  const rows = KEY_LIST.map((k) => {
    const def = formatDefault(DEFAULTS[k]);
    const defHint = def ? ` (default: ${def})` : '';
    return { key: k, type: KEY_TYPES[k], doc: KEY_DOCS[k] + defHint };
  });
  const keyW = Math.max(...rows.map((r) => r.key.length));
  const typeW = Math.max(...rows.map((r) => r.type.length));
  const lines = rows.map((r) => `  ${r.key.padEnd(keyW)}  ${r.type.padEnd(typeW)}  ${r.doc}`);

  const envRows = KEY_LIST
    .filter((k) => ENV_HINTS[k])
    .map((k) => ({ key: k, env: ENV_HINTS[k].replace(/^env /, '') }));
  const envKeyW = envRows.length ? Math.max(...envRows.map((r) => r.key.length)) : 0;
  const envLines = envRows.map((r) => `  ${r.key.padEnd(envKeyW)}  ${r.env}`);

  return `Usage:
  qagent config set [--project] <key> <value>   Write a config value
  qagent config list                            Print effective config + sources

Keys:
${lines.join('\n')}

Environment overrides:
${envLines.join('\n')}

Resolution: flag > env > project > user > default
Default scope for set/list is the user config (~/.config/qagent/config.json).
Use --project to target ./qagent.config.json instead.`;
}

const HELP = buildHelp();

function redactApiKey(value) {
  if (typeof value !== 'string') return '***';
  if (value.length <= 12) return '***';
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function display(key, value) {
  if (value === undefined) return '(unset)';
  if (key === 'apiKey') return redactApiKey(value);
  if (Array.isArray(value)) return value.join(',');
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function resolveOne(key, env, project, user) {
  for (const v of ENV_LOOKUP[key] ?? []) {
    if (env[v]) return { value: env[v], source: `env(${v})` };
  }
  if (project[key] !== undefined) return { value: project[key], source: 'project' };
  if (user[key] !== undefined) return { value: user[key], source: 'user' };
  if (DEFAULTS[key] !== undefined) return { value: DEFAULTS[key], source: 'default' };
  return { value: undefined, source: 'unset' };
}

export function runConfigCommand({ argv, cwd, env }) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(HELP + '\n');
    return 0;
  }

  const sub = argv[0];
  let scope = 'user';
  const positional = [];
  for (const a of argv.slice(1)) {
    if (a === '--project') scope = 'project';
    else if (a === '--user') scope = 'user';
    else if (a.startsWith('-')) {
      process.stderr.write(`qagent: unknown flag ${a} (ignored)\n`);
    } else {
      positional.push(a);
    }
  }

  if (sub === 'set') {
    if (positional.length !== 2) {
      throw new ConfigError(`config set requires <key> <value>, got ${positional.length} arg(s)`);
    }
    const [key, value] = positional;
    const path = setConfigValue({ scope, key, value, cwd });
    process.stdout.write(`set ${key} in ${path}\n`);
    return 0;
  }

  if (sub === 'list') {
    const { user, project } = loadConfig({ cwd });
    const userPath = configPath('user', cwd);
    const projectPath = configPath('project', cwd);
    const rows = KEY_LIST.map((k) => {
      const { value, source } = resolveOne(k, env, project, user);
      return { key: k, value: display(k, value), source };
    });
    const keyW = Math.max(...rows.map((r) => r.key.length));
    const valW = Math.max(...rows.map((r) => r.value.length));
    for (const r of rows) {
      process.stdout.write(`${r.key.padEnd(keyW)}  ${r.value.padEnd(valW)}  (${r.source})\n`);
    }
    process.stdout.write(`\n`);
    process.stdout.write(`user:    ${userPath}${existsSync(userPath) ? '' : ' (not present)'}\n`);
    process.stdout.write(`project: ${projectPath}${existsSync(projectPath) ? '' : ' (not present)'}\n`);
    return 0;
  }

  throw new ConfigError(`unknown subcommand "${sub}". Use: set, list.`);
}
