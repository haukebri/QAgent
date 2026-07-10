import { Agent } from '@earendil-works/pi-agent-core';
import { streamWithRequestAuth } from './llm-auth.js';

const SYSTEM_PROMPT =
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

export async function verify(goal, verdict, history, finalUrl, finalSnapshot, model, resolveRequestAuth) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await callJudge({ goal, verdict, history, finalUrl, finalSnapshot, model, resolveRequestAuth });
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`verifier failed after retry: ${lastError?.message?.split('\n')[0] ?? 'unknown'}`);
}

async function callJudge({ goal, verdict, history, finalUrl, finalSnapshot, model, resolveRequestAuth }) {
  const agent = new Agent({
    initialState: { systemPrompt: SYSTEM_PROMPT, model },
    streamFn: streamWithRequestAuth(resolveRequestAuth),
  });

  const actionsBlock = history.length
    ? history.map((h, i) => {
        const actionStr = JSON.stringify(h.action);
        const target = h.target ? ` (${h.target})` : '';
        const url = h.url ? ` @ ${h.url}` : '';
        const err = h.error ? ` [error: ${h.error}]` : '';
        const observation = h.observation ? `\n     observation: ${JSON.stringify(h.observation)}` : '';
        return `  ${i + 1}. ${actionStr}${target}${url}${err}${observation}`;
      }).join('\n')
    : '  (none)';

  await agent.prompt(
    `Goal: ${goal}\n\n` +
    `Driver verdict: ${JSON.stringify(verdict)}\n\n` +
    `Final URL: ${finalUrl}\n\n` +
    `Actions taken:\n${actionsBlock}\n\n` +
    `Final snapshot:\n${finalSnapshot}\n\n` +
    `Your JSON:`
  );

  const last = [...agent.state.messages].reverse().find(m => m.role === 'assistant');
  const usage = last?.usage ?? null;
  if (!last) throw new Error('no assistant message returned by verifier LLM');
  const errorMessage = last?.errorMessage ?? agent.state.errorMessage;
  if (last?.stopReason === 'error' || errorMessage) {
    throw new Error(errorMessage ?? 'provider returned an error stop reason');
  }
  const content = Array.isArray(last?.content) ? last.content : [];
  const text = content.filter(c => c.type === 'text').map(c => c.text).join('');
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`no JSON in verifier response: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(match[0]);
  if (parsed.outcome !== 'pass' && parsed.outcome !== 'fail') {
    throw new Error(`invalid outcome: ${parsed.outcome}`);
  }
  if (typeof parsed.evidence !== 'string' || !parsed.evidence.trim()) {
    throw new Error('missing evidence');
  }
  return {
    outcome: parsed.outcome,
    evidence: parsed.evidence,
    tokens: {
      input: usage?.input ?? 0,
      output: usage?.output ?? 0,
      totalTokens: usage?.totalTokens ?? 0,
      cost: usage?.cost?.total ?? 0,
    },
  };
}
