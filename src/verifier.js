import { Agent } from '@earendil-works/pi-agent-core';
import { streamWithRequestAuth } from './llm-auth.js';

const SINGLE_JUDGE_PROMPT =
  'You are a QA verifier. Given a goal, the action trajectory an AI driver took, and the final page state, decide whether the goal was actually achieved.\n\n' +
  'Respond with a single JSON object and nothing else (no markdown fences, no commentary):\n' +
  '  { "outcome": "pass" | "fail",\n' +
  '    "evidence": "<one sentence citing concrete text/URL/elements from the final snapshot or history that justifies the outcome>" }\n\n' +
  'Rules:\n' +
  '- Base the decision on evidence actually present in the inputs below. Do not infer facts that are not visible.\n' +
  "- The driver's own verdict is one signal but not authoritative — if the trajectory shows repeated errors on the same ref or no meaningful progress, that is evidence of failure regardless of what the driver said.\n" +
  "- If the goal contains an explicit step list (for example a 'Steps:' section, numbered list, or bullet list), treat every listed step as a required assertion, not as guidance. Walk the action trajectory in order and verify each step from concrete action JSON, target descriptions, URLs, observation summaries, and the final snapshot.\n" +
  '- For explicit step lists, a correct final state is not enough. If a required step was skipped, bypassed, performed on the wrong target, reached by another path, or its claimed redirect/URL change did not happen as described, return fail and name the violated step in evidence.\n' +
  '- For explicit step lists, visibility and count assertions must be proven by the trajectory or final snapshot. If an exact count, visible section, popup, URL redirect, or similar assertion is not shown in the recorded observations/snapshot, return fail and include "step could not be verified from the trajectory" in the evidence.\n' +
  "- Do not treat the driver's action reasons, done summary, or self-reported success as proof of a listed step unless the recorded target, URL, or observation data corroborates it.\n" +
  '- If the goal does not contain an explicit step list, keep the normal behavior: judge whether the final page state satisfies the goal.\n' +
  '- Page state may contain stale leftovers from earlier attempts in the same session (toast/notification text, alert regions, URL fragments pointing at error anchors). Weight evidence by structural prominence: text in the main content tree outranks text in notification, alert, or live-region containers. When success and failure signals are both present, treat the disappearance or replacement of the interactive UI (form gone, search box replaced by results, etc.) as the decisive signal — alert text can persist from earlier attempts even after the action ultimately succeeded.\n' +
  '- If the goal asks a question, the evidence sentence must contain the answer, or explicitly state the answer is not present.';

const DECOMPOSE_PROMPT =
  'You are a QA verifier. Given a free-text browser test goal, extract individually checkable claims.\n\n' +
  'Respond with a single JSON object and nothing else (no markdown fences, no commentary):\n' +
  '  { "claims": ["<claim>", "..."] }\n\n' +
  'Rules:\n' +
  '- Use one claim per distinct requirement: navigation happened, an element was visible, a URL was reached, or an action had an effect.\n' +
  '- Prefer roughly one claim per user-stated step or sentence.\n' +
  '- If one step says an element is visible/clickable and that click redirects, opens a popup, or changes the page, keep that interaction and effect together as one claim.\n' +
  '- Split a step only when it contains independent requirements that can be checked separately.\n' +
  '- A claim must be verifiable in principle from a browser session transcript.\n' +
  "- Copy the user's wording closely.\n" +
  "- Do not invent requirements that are not in the goal.\n" +
  '- Short goals may yield just 1-2 claims.';

const CHECK_PROMPT =
  'You are a QA verifier. Given a browser run transcript and one claim, decide whether the transcript verifies that claim.\n\n' +
  'Respond with a single JSON object and nothing else (no markdown fences, no commentary):\n' +
  '  { "verdict": "yes" | "no" | "unknown",\n' +
  '    "evidence": "<one sentence citing concrete actions, targets, URLs, observations, or final snapshot text>" }\n\n' +
  'Rules:\n' +
  '- Answer "yes" only when concrete transcript evidence proves the claim.\n' +
  '- Never answer "yes" without pointing to concrete evidence from the transcript.\n' +
  '- Answer "no" when the transcript contradicts the claim, skips a required action, uses a different required path, reaches the wrong URL, or shows the required effect did not happen.\n' +
  '- When a claim names a required route or source context such as a teaser, section, popup, button, or link, verify that route/context itself. Reaching the same final product, URL, or page by search results or a different page is "no".\n' +
  '- A claim about clicking a teaser is not satisfied by clicking a matching product link from search results.\n' +
  '- For exact count claims, count only the named item type. Do not count CTA, navigation, category, or "show all" links as offers/products. If the transcript is ambiguous, answer "unknown" rather than "no".\n' +
  '- Answer "unknown" when the transcript does not contain enough information to verify the claim.\n' +
  '- If in doubt, answer "unknown".\n' +
  "- The driver's action reasons, done summary, or self-reported success are not proof unless action targets, URLs, observations, or final snapshot corroborate them.";

export async function verify(goal, verdict, history, finalUrl, finalSnapshot, model, resolveRequestAuth) {
  const args = { goal, verdict, history, finalUrl, finalSnapshot, model, resolveRequestAuth };
  const tokens = emptyTokens();

  try {
    const decomposed = await callWithRetry(() => callDecompose(args));
    addTokens(tokens, decomposed.tokens);
    const transcript = buildTranscript({ history, finalUrl, finalSnapshot });
    const checks = [];

    for (const claim of decomposed.claims) {
      const checked = await callWithRetry(() => callCheck({ claim, transcript, model, resolveRequestAuth }));
      addTokens(tokens, checked.tokens);
      checks.push({ claim, verdict: checked.verdict, evidence: checked.evidence });
    }

    return { ...aggregateChecks(checks), checks, tokens };
  } catch (err) {
    addTokens(tokens, err.tokens);
    const fallback = await callSingleJudgeWithRetry(args);
    addTokens(tokens, fallback.tokens);
    return { ...fallback, checks: [], warnings: [], tokens };
  }
}

export function aggregateChecks(checks) {
  const failed = checks.find(c => c.verdict === 'no');
  if (failed) {
    return {
      outcome: 'fail',
      evidence: `failed claim: ${failed.claim}; ${failed.evidence}`,
      warnings: [],
    };
  }

  const unknowns = checks.filter(c => c.verdict === 'unknown');
  const verified = checks.length - unknowns.length;
  return {
    outcome: 'pass',
    evidence: unknowns.length
      ? `verified ${verified} of ${checks.length} claims; ${unknowns.length} unverified`
      : `verified all ${checks.length} claims`,
    warnings: unknowns.map(c => `unverified claim: ${c.claim}`),
  };
}

function buildActionsBlock(history, { includeDriverText = true } = {}) {
  const actionsBlock = history.length
    ? history.map((h, i) => {
        const actionStr = JSON.stringify(includeDriverText ? h.action : stripDriverText(h.action));
        const lines = [`  ${i + 1}. action: ${actionStr}`];
        if (h.target) lines.push(`     target: ${h.target}`);
        if (h.url) lines.push(`     resultUrl: ${h.url}`);
        if (h.error) lines.push(`     error: ${h.error}`);
        if (h.observation) lines.push(`     resultObservation: ${JSON.stringify(h.observation)}`);
        return lines.join('\n');
      }).join('\n')
    : '  (none)';
  return actionsBlock;
}

function stripDriverText(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) return action;
  const { reason, summary, ...rest } = action;
  return rest;
}

function buildTranscript({ history, finalUrl, finalSnapshot }) {
  return (
    `Final URL: ${finalUrl}\n\n` +
    `Actions taken:\n${buildActionsBlock(history, { includeDriverText: false })}\n\n` +
    `Final snapshot:\n${finalSnapshot ?? ''}`
  );
}

async function callDecompose({ goal, model, resolveRequestAuth }) {
  const { parsed, tokens } = await callJson({
    systemPrompt: DECOMPOSE_PROMPT,
    prompt: `Goal: ${goal}\n\nYour JSON:`,
    model,
    resolveRequestAuth,
    label: 'verifier decomposition',
  });

  if (!Array.isArray(parsed.claims) || parsed.claims.length === 0) {
    throw errorWithTokens('decomposition returned no claims', tokens);
  }
  const claims = parsed.claims.map(c => {
    if (typeof c !== 'string' || !c.trim()) throw errorWithTokens('invalid claim in decomposition', tokens);
    return c.trim();
  });
  return { claims, tokens };
}

async function callCheck({ claim, transcript, model, resolveRequestAuth }) {
  const { parsed, tokens } = await callJson({
    systemPrompt: CHECK_PROMPT,
    prompt:
      `${transcript}\n\n` +
      `Claim to check:\n${claim}\n\n` +
      `Your JSON:`,
    model,
    resolveRequestAuth,
    label: 'verifier claim check',
  });

  if (!['yes', 'no', 'unknown'].includes(parsed.verdict)) {
    throw errorWithTokens(`invalid claim verdict: ${parsed.verdict}`, tokens);
  }
  if (typeof parsed.evidence !== 'string' || !parsed.evidence.trim()) {
    throw errorWithTokens('missing claim evidence', tokens);
  }
  return { verdict: parsed.verdict, evidence: parsed.evidence.trim(), tokens };
}

async function callSingleJudgeWithRetry(args) {
  try {
    return await callWithRetry(() => callSingleJudge(args));
  } catch (err) {
    throw new Error(`verifier failed after retry: ${err?.message?.split('\n')[0] ?? 'unknown'}`);
  }
}

async function callSingleJudge({ goal, verdict, history, finalUrl, finalSnapshot, model, resolveRequestAuth }) {
  const { parsed, tokens } = await callJson({
    systemPrompt: SINGLE_JUDGE_PROMPT,
    prompt:
      `Goal: ${goal}\n\n` +
      `Driver verdict: ${JSON.stringify(verdict)}\n\n` +
      `Final URL: ${finalUrl}\n\n` +
      `Actions taken:\n${buildActionsBlock(history)}\n\n` +
      `Final snapshot:\n${finalSnapshot}\n\n` +
      `Your JSON:`,
    model,
    resolveRequestAuth,
    label: 'verifier response',
  });

  if (parsed.outcome !== 'pass' && parsed.outcome !== 'fail') {
    throw errorWithTokens(`invalid outcome: ${parsed.outcome}`, tokens);
  }
  if (typeof parsed.evidence !== 'string' || !parsed.evidence.trim()) {
    throw errorWithTokens('missing evidence', tokens);
  }
  return {
    outcome: parsed.outcome,
    evidence: parsed.evidence.trim(),
    warnings: [],
    tokens,
  };
}

async function callJson({ systemPrompt, prompt, model, resolveRequestAuth, label }) {
  const agent = new Agent({
    initialState: { systemPrompt, model },
    streamFn: streamWithRequestAuth(resolveRequestAuth),
  });

  try {
    await agent.prompt(prompt);
  } catch (err) {
    const last = [...agent.state.messages].reverse().find(m => m.role === 'assistant');
    throw errorWithTokens(err.message ?? 'provider call failed', tokensFromUsage(last?.usage));
  }

  const last = [...agent.state.messages].reverse().find(m => m.role === 'assistant');
  const tokens = tokensFromUsage(last?.usage);
  if (!last) throw errorWithTokens('no assistant message returned by verifier LLM', tokens);
  const errorMessage = last?.errorMessage ?? agent.state.errorMessage;
  if (last?.stopReason === 'error' || errorMessage) {
    throw errorWithTokens(errorMessage ?? 'provider returned an error stop reason', tokens);
  }
  const content = Array.isArray(last?.content) ? last.content : [];
  const text = content.filter(c => c.type === 'text').map(c => c.text).join('');
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw errorWithTokens(`no JSON in ${label}: ${text.slice(0, 200)}`, tokens);
  try {
    return { parsed: JSON.parse(match[0]), tokens };
  } catch (err) {
    throw errorWithTokens(`${err.message}; raw: ${match[0].slice(0, 200)}`, tokens);
  }
}

async function callWithRetry(fn) {
  const tokens = emptyTokens();
  let lastError = null;
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
  throw errorWithTokens(lastError?.message ?? 'unknown', tokens);
}

function emptyTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
}

function tokensFromUsage(usage) {
  return {
    input: usage?.input ?? 0,
    output: usage?.output ?? 0,
    cacheRead: usage?.cacheRead ?? 0,
    cacheWrite: usage?.cacheWrite ?? 0,
    totalTokens: usage?.totalTokens ?? 0,
    cost: typeof usage?.cost === 'number' ? usage.cost : usage?.cost?.total ?? 0,
  };
}

function addTokens(total, next) {
  if (!next) return total;
  total.input += next.input ?? 0;
  total.output += next.output ?? 0;
  total.cacheRead += next.cacheRead ?? 0;
  total.cacheWrite += next.cacheWrite ?? 0;
  total.totalTokens += next.totalTokens ?? 0;
  total.cost += next.cost ?? 0;
  return total;
}

function errorWithTokens(message, tokens) {
  const err = new Error(message);
  err.tokens = tokens;
  return err;
}
