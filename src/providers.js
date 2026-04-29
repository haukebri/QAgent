import { ConfigError } from './config.js';

export const PROVIDERS = {
  openrouter: { keyEnv: 'OPENROUTER_API_KEY', keyUrl: 'https://openrouter.ai/keys' },
  anthropic:  { keyEnv: 'ANTHROPIC_API_KEY',  keyUrl: 'https://console.anthropic.com/settings/keys' },
  openai:     { keyEnv: 'OPENAI_API_KEY',     keyUrl: 'https://platform.openai.com/api-keys' },
  google:     { keyEnv: 'GEMINI_API_KEY',     keyUrl: 'https://aistudio.google.com/apikey' },
};

export function providerHelpUrl(provider) {
  return PROVIDERS[provider]?.keyUrl ?? null;
}

export function resolveApiKey({ provider, flags, env, project, user }) {
  if (flags.apiKey) return { apiKey: flags.apiKey, source: 'flag' };
  if (env.QAGENT_API_KEY) return { apiKey: env.QAGENT_API_KEY, source: 'env QAGENT_API_KEY' };

  const providerEnv = PROVIDERS[provider]?.keyEnv;
  if (providerEnv && env[providerEnv]) {
    return { apiKey: env[providerEnv], source: `env ${providerEnv}` };
  }

  if (project.apiKey) return { apiKey: project.apiKey, source: 'project config' };
  if (user.apiKey) return { apiKey: user.apiKey, source: 'user config' };

  throw new ConfigError(missingKeyMessage(provider));
}

function missingKeyMessage(provider) {
  const entry = PROVIDERS[provider];
  if (entry) {
    return [
      `no API key found for provider '${provider}'.`,
      `Pass --api-key, set QAGENT_API_KEY or ${entry.keyEnv}, or set "apiKey" in qagent.config.json / ~/.config/qagent/config.json.`,
      `See ${entry.keyUrl}`,
    ].join('\n');
  }
  return [
    `no API key found for provider '${provider}'.`,
    `Pass --api-key, set QAGENT_API_KEY, or set "apiKey" in qagent.config.json / ~/.config/qagent/config.json.`,
  ].join('\n');
}
