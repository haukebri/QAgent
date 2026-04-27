import { existsSync } from 'node:fs';
import { ConfigError, KEY_LIST, configPath, loadConfig, setConfigValue } from './config.js';

const HELP = `Usage:
  qagent config set [--project] <key> <value>   Write a config value
  qagent config list                            Print effective config + sources

Keys: ${KEY_LIST.join(', ')}

Default scope is the user config (~/.config/qagent/config.json).
Use --project to target ./qagent.config.json instead.`;

const ENV_LOOKUP = {
  model: ['QAGENT_MODEL'],
  verifierModel: [],
  apiKey: ['QAGENT_API_KEY', 'OPENROUTER_API_KEY'],
  maxTurns: [],
};

const DEFAULTS = {
  maxTurns: 50,
};

function redactApiKey(value) {
  if (typeof value !== 'string') return '***';
  if (value.length <= 12) return '***';
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function display(key, value) {
  if (value === undefined) return '(unset)';
  return key === 'apiKey' ? redactApiKey(value) : String(value);
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
