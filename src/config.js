import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

export class ConfigError extends Error {}

const USER_CONFIG_PATH = resolve(homedir(), '.config', 'qagent', 'config.json');
const PROJECT_CONFIG_NAME = 'qagent.config.json';

const KNOWN_KEYS = {
  model: 'string',
  verifierModel: 'string',
  apiKey: 'string',
  maxTurns: 'number',
};

export const KEY_LIST = Object.keys(KNOWN_KEYS);

function readJson(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new ConfigError(`failed to read ${path}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`${path}: invalid JSON (${err.message})`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError(`${path}: expected a JSON object`);
  }
  return parsed;
}

export function configPath(scope, cwd) {
  return scope === 'project'
    ? resolve(cwd ?? process.cwd(), PROJECT_CONFIG_NAME)
    : USER_CONFIG_PATH;
}

export function loadConfig({ cwd } = {}) {
  const user = readJson(configPath('user', cwd));
  const project = readJson(configPath('project', cwd));
  return { user, project };
}

export function setConfigValue({ scope, key, value, cwd }) {
  if (!(key in KNOWN_KEYS)) {
    throw new ConfigError(`unknown key "${key}". Valid keys: ${KEY_LIST.join(', ')}.`);
  }
  let coerced = value;
  if (KNOWN_KEYS[key] === 'number') {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) {
      throw new ConfigError(`${key} must be a positive integer, got "${value}"`);
    }
    coerced = n;
  }
  const path = configPath(scope, cwd);
  mkdirSync(dirname(path), { recursive: true });
  const existing = readJson(path);
  existing[key] = coerced;
  writeFileSync(path, JSON.stringify(existing, null, 2) + '\n');
  if (scope === 'user') chmodSync(path, 0o600);
  return path;
}
