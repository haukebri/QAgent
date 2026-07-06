import { launchPage } from './browser.js';
import { ConfigError } from './config.js';
import { createEvidenceRecorder } from './evidence.js';
import { runTodo } from './executor.js';
import { navigate } from './tools.js';

export async function runQAgent({
  url,
  goal,
  model,
  resolveRequestAuth,
  verifierModel = model,
  maxTurns = 50,
  headed = false,
  testTimeoutMs = 300_000,
  networkTimeoutMs = 30_000,
  actionTimeoutMs = 2_000,
  evidenceDir = null,
  onStart = null,
  onTurn = null,
} = {}) {
  if (!goal) throw new ConfigError('goal is required');
  if (!url) throw new ConfigError('url is required');
  if (!model) throw new ConfigError('model is required');
  if (typeof resolveRequestAuth !== 'function') {
    throw new ConfigError('resolveRequestAuth is required');
  }

  const { startUrl, httpCredentials } = parseStartUrl(url);
  const evidence = createEvidenceRecorder(evidenceDir, { maxTurns });
  await onStart?.({ url: startUrl });
  const tRun = Date.now();
  let browser;
  let page;
  let result;

  try {
    ({ browser, page } = await launchPage({ httpCredentials, headed }));
    try {
      await navigate(page, startUrl, networkTimeoutMs);
    } catch (err) {
      result = await buildErrorResult(err, page, tRun, evidence, 'pre-navigate failed');
    }
    if (!result) {
      try {
        result = await runTodo(
          page, goal, model, resolveRequestAuth, maxTurns, verifierModel, onTurn,
          testTimeoutMs, actionTimeoutMs, evidence,
        );
      } catch (err) {
        result = await buildErrorResult(err, page, tRun, evidence);
      }
    }
  } catch (err) {
    result = await buildErrorResult(err, page, tRun, evidence);
  } finally {
    await browser?.close();
  }

  return result;
}

function parseStartUrl(rawUrl) {
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

  return {
    startUrl: parsedUrl.toString(),
    httpCredentials,
  };
}

async function buildErrorResult(err, page, startedAt, evidence, prefix = 'runner crashed') {
  const finalScreenshot = await evidence?.captureFinal(page);
  return {
    outcome: 'error',
    evidence: `${prefix}: ${err.message.split('\n')[0]}`,
    llmVerdict: null,
    turns: 0,
    elapsedMs: Date.now() - startedAt,
    tokens: { input: 0, output: 0, totalTokens: 0, cost: 0 },
    verifierTokens: null,
    finalUrl: page?.url?.() ?? 'about:blank',
    ...(finalScreenshot ? { finalScreenshot } : {}),
    history: [],
    warnings: [],
  };
}
