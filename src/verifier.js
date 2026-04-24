import { Agent } from '@mariozechner/pi-agent-core';

const SYSTEM_PROMPT =
  'You are a QA verifier. Given a goal, the action trajectory an AI driver took, and the final page state, decide whether the goal was actually achieved.\n\n' +
  'Respond with a single JSON object and nothing else (no markdown fences, no commentary):\n' +
  '  { "outcome": "pass" | "fail",\n' +
  '    "evidence": "<one sentence citing concrete text/URL/elements from the final snapshot or history that justifies the outcome>" }\n\n' +
  'Rules:\n' +
  '- Base the decision on evidence actually present in the inputs below. Do not infer facts that are not visible.\n' +
  "- The driver's own verdict is one signal but not authoritative — if the trajectory shows repeated errors on the same ref or no meaningful progress, that is evidence of failure regardless of what the driver said.\n" +
  '- If the goal asks a question, the evidence sentence must contain the answer, or explicitly state the answer is not present.';

export async function verify(goal, verdict, history, finalUrl, finalSnapshot, model, apiKey) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await callJudge({ goal, verdict, history, finalUrl, finalSnapshot, model, apiKey });
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`verifier failed after retry: ${lastError?.message?.split('\n')[0] ?? 'unknown'}`);
}

async function callJudge({ goal, verdict, history, finalUrl, finalSnapshot, model, apiKey }) {
  const agent = new Agent({
    initialState: { systemPrompt: SYSTEM_PROMPT, model },
    getApiKey: async () => apiKey,
  });

  const actionsBlock = history.length
    ? history.map((h, i) => {
        const actionStr = JSON.stringify(h.action);
        const target = h.target ? ` (${h.target})` : '';
        const url = h.url ? ` @ ${h.url}` : '';
        const err = h.error ? ` [error: ${h.error}]` : '';
        return `  ${i + 1}. ${actionStr}${target}${url}${err}`;
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
  const text = last?.content.filter(c => c.type === 'text').map(c => c.text).join('') ?? '';
  const usage = last?.usage ?? null;
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
