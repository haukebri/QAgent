import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export class ConfigError extends Error {}

const USER_CONFIG_PATH = resolve(homedir(), '.config', 'qagent', 'config.json');
const PROJECT_CONFIG_NAME = 'qagent.config.json';

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

export function loadConfig({ cwd } = {}) {
  const projectPath = resolve(cwd ?? process.cwd(), PROJECT_CONFIG_NAME);
  const user = readJson(USER_CONFIG_PATH);
  const project = readJson(projectPath);
  return { user, project };
}
