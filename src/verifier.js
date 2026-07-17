import { Agent } from '@earendil-works/pi-agent-core';
import { streamWithRequestAuth } from './llm-auth.js';
import { extractJsonObject } from './json.js';

const SYSTEM_PROMPT =
  'You are an independent QA verifier. Judge whether one browser run achieved the observable outcome requested by the goal.\n\n' +
  'Respond with one JSON object and nothing else:\n' +
  '{ "outcome": "pass" | "fail", "evidence": "<one short sentence grounded in the supplied browser facts>" }\n\n' +
  'Rules:\n' +
  '- Judge the overall outcome, not a checklist of intermediate actions.\n' +
  '- Pass only when the supplied browser facts positively establish the complete requested outcome. Absence of a forbidden state does not prove required presence.\n' +
  '- The frozen final URL and snapshot are authoritative for the end state.\n' +
  '- Use successful and failed action history when the goal explicitly requires a route or interaction, or when a relevant state was transient.\n' +
  '- The driver terminal response is context, not proof; pass a correct visible result despite driver failure and fail an incorrect result despite driver success.\n' +
  '- Do not infer facts absent from the supplied browser facts.\n' +
  '- Evidence must state the decisive visible URL, text, element, action, or missing result.';

export async function verify(goal, verdict, history, finalUrl, finalSnapshot, model, resolveRequestAuth) {
  const actions = history.filter(entry => entry.action && !['done', 'fail'].includes(entry.action.action));
  const prompt =
    `Goal:\n${goal}\n\n` +
    `Frozen final URL:\n${finalUrl}\n\n` +
    `Frozen final snapshot:\n${finalSnapshot ?? ''}\n\n` +
    `Browser action history:\n${formatHistory(actions)}\n\n` +
    `Driver terminal response (non-authoritative):\n${JSON.stringify(sanitizeVerdict(verdict))}\n\n` +
    'Your JSON:';

  try {
    const result = await callWithRetry(() => callJudge({ prompt, model, resolveRequestAuth }));
    return { ...result, failureKind: result.outcome === 'fail' ? 'assertion' : null };
  } catch (err) {
    err.failureKind = 'verifier';
    err.message = `verifier failed after retry: ${err.message}`;
    throw err;
  }
}

function formatHistory(history) {
  if (!history.length) return '(none)';
  return history.map((entry, index) => JSON.stringify({
    step: index + 1,
    action: stripDriverText(entry.action),
    target: entry.target ?? null,
    url: entry.url ?? null,
    observation: stripObservationRefs(entry.observation),
    success: entry.success ?? !entry.error,
    error: entry.error ? sanitizeRefs(entry.error) : null,
  })).join('\n');
}

function stripDriverText(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) return action;
  const { reason, summary, ref, ...rest } = action;
  return rest;
}

function sanitizeVerdict(verdict) {
  if (!verdict || typeof verdict !== 'object') return verdict;
  return {
    ...verdict,
    ...(verdict.summary ? { summary: sanitizeRefs(verdict.summary) } : {}),
    ...(verdict.reason ? { reason: sanitizeRefs(verdict.reason) } : {}),
  };
}

function stripObservationRefs(observation) {
  if (!observation) return null;
  const { id, addedRefs, removedRefs, ...rest } = observation;
  return rest;
}

function sanitizeRefs(value) {
  return String(value).replace(/\b(?:ref\s+)?(?:f\d+)?e\d+\b/giu, 'selected element');
}

async function callJudge({ prompt, model, resolveRequestAuth }) {
  const agent = new Agent({
    initialState: { systemPrompt: SYSTEM_PROMPT, model },
    streamFn: streamWithRequestAuth(resolveRequestAuth),
  });

  try {
    await agent.prompt(prompt);
  } catch (err) {
    const last = [...agent.state.messages].reverse().find(message => message.role === 'assistant');
    throw errorWithTokens(err.message ?? 'provider call failed', tokensFromUsage(last?.usage));
  }

  const last = [...agent.state.messages].reverse().find(message => message.role === 'assistant');
  const tokens = tokensFromUsage(last?.usage);
  if (!last) throw errorWithTokens('no assistant message returned by verifier LLM', tokens);
  const errorMessage = last.errorMessage ?? agent.state.errorMessage;
  if (last.stopReason === 'error' || errorMessage) {
    throw errorWithTokens(errorMessage ?? 'provider returned an error stop reason', tokens);
  }
  const text = (last.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('');
  const json = extractJsonObject(text);
  if (!json) throw errorWithTokens(`no JSON in verifier response: ${text.slice(0, 200)}`, tokens);

  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw errorWithTokens(`${err.message}; raw: ${json.slice(0, 200)}`, tokens);
  }
  if (!['pass', 'fail'].includes(parsed.outcome)) throw errorWithTokens(`invalid outcome: ${parsed.outcome}`, tokens);
  if (typeof parsed.evidence !== 'string' || !parsed.evidence.trim()) throw errorWithTokens('missing evidence', tokens);
  return { outcome: parsed.outcome, evidence: parsed.evidence.trim(), tokens };
}

async function callWithRetry(fn) {
  const tokens = emptyTokens();
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await fn();
      addTokens(tokens, result.tokens);
      return { ...result, tokens };
    } catch (err) {
      addTokens(tokens, err.tokens);
      lastError = err;
    }
  }
  throw errorWithTokens(lastError?.message ?? 'unknown verifier error', tokens);
}

function emptyTokens() {
  return { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
}

function tokensFromUsage(usage) {
  return {
    calls: 1,
    input: usage?.input ?? 0,
    output: usage?.output ?? 0,
    cacheRead: usage?.cacheRead ?? 0,
    cacheWrite: usage?.cacheWrite ?? 0,
    totalTokens: usage?.totalTokens ?? 0,
    cost: typeof usage?.cost === 'number' ? usage.cost : usage?.cost?.total ?? 0,
  };
}

function addTokens(total, next) {
  if (!next) return;
  for (const key of Object.keys(total)) total[key] += next[key] ?? 0;
}

function errorWithTokens(message, tokens) {
  return Object.assign(new Error(message), { tokens });
}
