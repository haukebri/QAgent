import { Agent } from '@earendil-works/pi-agent-core';
import { streamWithRequestAuth } from './llm-auth.js';
import { extractJsonObject } from './json.js';

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
  '- Preserve each conditional requirement as an implication: evaluate its trigger before requiring its consequence. An untriggered branch is satisfied, an observed trigger requires proof of the consequence, and indeterminate required evidence fails.\n' +
  '- Treat the evidence sources separately: recorded browser actions prove interactions, the driver final response proves only what that response says, and the final snapshot proves visible page state. A visible element is not evidence that it was clicked, and an action with an error is not evidence of a successful interaction.\n' +
  '- Page state may contain stale leftovers from earlier attempts in the same session (toast/notification text, alert regions, URL fragments pointing at error anchors). Weight evidence by structural prominence: text in the main content tree outranks text in notification, alert, or live-region containers. When success and failure signals are both present, treat the disappearance or replacement of the interactive UI (form gone, search box replaced by results, etc.) as the decisive signal — alert text can persist from earlier attempts even after the action ultimately succeeded.\n' +
  '- If the goal asks a question, the evidence sentence must contain the answer, or explicitly state the answer is not present.';

const DECOMPOSE_PROMPT =
  'You are a QA verifier. Given the binding browser test goal, extract source-grounded items.\n\n' +
  'Respond with a single JSON object and nothing else (no markdown fences, no commentary):\n' +
  '  { "items": [{ "id": "claim-1", "text": "<normalized claim>", "sourceQuote": "<exact quote from goal>", "kind": "assertion" | "instruction", "comparison": "semantic" | "exact" }] }\n\n' +
  'Rules:\n' +
  '- Use one claim per distinct requirement: navigation happened, an element was visible, a URL was reached, or an action had an effect.\n' +
  '- Prefer roughly one claim per user-stated step or sentence.\n' +
  '- If one step says an element is visible/clickable and that click redirects, opens a popup, or changes the page, keep that interaction and effect together as one claim.\n' +
  '- For form-fill steps that list multiple named fields or options, split each named field/option into its own claim.\n' +
  '- Split a step only when it contains independent requirements that can be checked separately.\n' +
  '- Keep each conditional requirement as one implication containing both its trigger and consequence: "if X appears, do Y" must not become an unconditional claim that Y occurred.\n' +
  '- Conditional or iterative steps ("if errors occur", "retry until", "eventual") must become outcome claims that direct success also satisfies. Example: "Check for form errors, correct them, resubmit until the result page appears" -> "the result page was eventually reached; if validation errors occurred along the way, they were corrected" — NOT "the form was submitted repeatedly".\n' +
  '- Do not create separate claims requiring retries, repeated submissions, or error correction unless the goal requires them even when the success state is reached immediately.\n' +
  '- For until-success recovery clauses, never include "repeatedly", "again", or "resubmit" in the claim unless repetition is required even after the success state is reached.\n' +
  '- A claim must be verifiable in principle from a browser session transcript.\n' +
  "- Copy the user's wording closely.\n" +
  '- sourceQuote must be copied exactly and contiguously from the goal; never alter a name, value, polarity, or requirement.\n' +
  '- Use kind "assertion" for anything that must be true for success. Use "instruction" only for execution guidance that does not define success.\n' +
  '- Use comparison "exact" only when the source explicitly requires exact/literal/word-for-word copy or an exact URL; otherwise use "semantic".\n' +
  "- Do not invent requirements that are not in the goal.\n" +
  '- Short goals may yield just 1-2 claims.';

const CHECK_PROMPT =
  'You are a QA verifier. Given relevant browser evidence and one source-grounded claim, cite evidence for and against it.\n\n' +
  'Respond with a single JSON object and nothing else (no markdown fences, no commentary):\n' +
  '  { "supportingEvidenceIds": ["<real evidence id>"], "contradictingEvidenceIds": ["<real evidence id>"],\n' +
  '    "evidence": "<one sentence explaining the citations>" }\n\n' +
  'Rules:\n' +
  '- Cite only IDs present in the supplied relevant evidence. Never invent an action or page-state ID.\n' +
  '- Supporting IDs contain concrete evidence FOR the claim.\n' +
  '- Contradicting IDs contain concrete evidence AGAINST the claim. Absence of mention is not contradiction.\n' +
  '- For form-field claims, concrete evidence AGAINST means the same field has a conflicting value or a validation error remains for that field. Another field\'s name/value, "not a field named", or "no field labeled" is not evidence against the claim.\n' +
  '- Return both ID arrays empty when the evidence neither confirms nor contradicts the claim.\n' +
  '- Treat the transcript sections as separate evidence sources. Recorded browser actions are the only evidence that a click, fill, navigation, or other interaction occurred. A visible element is not evidence that it was clicked. An action entry containing an error is not evidence of a successful interaction.\n' +
  '- The driver final response is direct evidence only for claims about what the final response says or quotes. For those claims, inspect the complete final response; use the final snapshot to corroborate that quoted page content was actually visible. Do not use the final response as proof of browser actions or page state.\n' +
  '- For a conditional claim, evaluate its trigger first. Cite support when evidence shows the trigger did not occur or the consequence occurred. Cite contradiction only when the trigger occurred and the consequence was skipped or contradicted; otherwise leave both arrays empty.\n' +
  '- If your explanation would say "does not show", "no mention of", "unclear", or similar, leave both arrays empty.\n' +
  '- Cite contradiction only when evidence shows a different required path, wrong URL, conflicting value, or missing required effect.\n' +
  '- When a claim names a required route or source context such as a teaser, section, popup, button, or link, verify that route/context itself. Reaching the same final product, URL, or page by search results or a different page is "no".\n' +
  '- A claim about clicking a teaser is not satisfied by clicking a matching product link from search results.\n' +
  '- For exact count claims, count only the named item type. Do not count CTA, navigation, category, or "show all" links as offers/products. Leave both arrays empty when ambiguous.\n' +
  '- For exact count claims, "no" requires a concrete extra or missing named item in the same named section and same observation. Possible hidden/available items or missing confirmation of exactness are "unknown".\n' +
  '- A "show all" CTA, possible hidden items, or lack of an explicit total is not evidence against an exact visible count.\n' +
  '- For exact visible counts in a named section, judge the observation where that section is shown. Later products on another page, after a redirect, or after "show more" are not evidence against the earlier section count.\n' +
  '- For exact visible counts in a named section, ignore products, categories, or offers outside that named section, even when they are elsewhere on the same page or in a larger surrounding page section.\n' +
  '- If an exact count claim has two matching items but uncertainty about page or section context, leave both arrays empty.\n' +
  '- For form-field claims, inspect all fill/select/click actions. A successful submit/result page is evidence that mandatory fields were accepted, and another field\'s label/value is not a contradiction. A clicked checkbox/radio option can satisfy a requested option even when the surrounding field label is absent. Label mismatch or missing proof that an option was first is "unknown" unless the transcript shows a conflicting value for that same field.\n' +
  '- For transient states such as a popup, dialog, toast, overlay, or loading indicator, any observation in the trajectory can satisfy the claim, even if the final snapshot no longer shows it. addedText with dialog buttons is evidence FOR the transient state; for example, after "In den Warenkorb", addedText ["Weiter einkaufen", "Zur Kasse"] evidences a cart popup/overlay. Judging only the final snapshot is wrong for these claims.\n' +
  '- Leave both arrays empty when the evidence is insufficient.\n' +
  '- If in doubt, cite nothing.\n' +
  "- The driver's action reasons, done summary, or self-reported success are not proof unless action targets, URLs, observations, or final snapshot corroborate them.";

export async function verify(goal, verdict, history, finalUrl, finalSnapshot, model, resolveRequestAuth, browserEvidence = null) {
  const args = { goal, verdict, history, finalUrl, finalSnapshot, model, resolveRequestAuth, browserEvidence };
  const tokens = emptyTokens();

  try {
    const decomposed = await callWithRetry(() => callDecompose(args));
    addTokens(tokens, decomposed.tokens);
    const evidenceRecords = buildEvidenceRecords({ verdict, history, finalUrl, finalSnapshot, browserEvidence });
    const checks = [];

    for (const item of decomposed.items.filter(item => item.kind === 'assertion')) {
      const relevant = relevantEvidence(item, evidenceRecords);
      const deterministic = deterministicCheck(item, relevant);
      const checked = deterministic ?? await callWithRetry(() => callCheck({ item, relevant, model, resolveRequestAuth }));
      addTokens(tokens, checked.tokens);
      checks.push({
        claim: item.sourceQuote,
        verdict: verdictFromEvidence(checked),
        evidence: checked.evidence,
        source: item,
        supportingEvidenceIds: checked.supportingEvidenceIds,
        contradictingEvidenceIds: checked.contradictingEvidenceIds,
      });
    }

    const aggregate = aggregateChecks(checks);
    const warnings = [...(aggregate.warnings ?? [])];
    return {
      ...aggregate, warnings, humanEvidence: formatHumanEvidence(checks), checks,
      excludedItems: decomposed.items.filter(item => item.kind === 'instruction'),
      verifierMode: 'checks', tokens,
    };
  } catch (err) {
    addTokens(tokens, err.tokens);
    if (err.protocol) {
      err.verifierMode = 'checks';
      err.failureKind = 'verifier';
      throw err;
    }
    const warning = 'verifier: claim decomposition failed, fell back to single-call verification' +
      (err?.message ? `: ${err.message.split('\n')[0]}` : '');
    try {
      const fallback = await callSingleJudgeWithRetry(args);
      addTokens(tokens, fallback.tokens);
      return {
        ...fallback,
        humanEvidence: fallback.evidence,
        checks: [],
        verifierMode: 'single',
        failureKind: fallback.outcome === 'fail' ? 'assertion' : null,
        warnings: [...(fallback.warnings ?? []), warning],
        tokens,
      };
    } catch (fallbackErr) {
      fallbackErr.verifierMode = 'single';
      fallbackErr.warnings = [...(fallbackErr.warnings ?? []), warning];
      throw fallbackErr;
    }
  }
}

export function aggregateChecks(checks) {
  const failed = checks.find(c => c.verdict === 'no');
  if (failed) {
    return {
      outcome: 'fail',
      evidence: `failed claim: ${failed.claim}; ${failed.evidence}`,
      failureKind: 'assertion',
      warnings: [],
    };
  }

  const unknowns = checks.filter(c => c.verdict === 'unknown');
  if (unknowns.length) {
    const unverified = unknowns[0];
    return {
      outcome: 'fail',
      evidence: `unverified claim: ${unverified.claim}; ${unverified.evidence}`,
      failureKind: 'unverified',
      warnings: unknowns.map(c => `unverified claim: ${c.claim}`),
    };
  }
  return {
    outcome: 'pass',
    evidence: `verified all ${checks.length} claims`,
    failureKind: null,
    warnings: [],
  };
}

export function formatHumanEvidence(checks) {
  const denied = checks.find(c => c.verdict === 'no');
  if (denied) return `Failed required claim: ${denied.claim}. ${denied.evidence}`;
  const unknown = checks.find(c => c.verdict === 'unknown');
  if (unknown) return `Could not verify required claim: ${unknown.claim}. ${unknown.evidence}`;
  return `All ${checks.length} required claims were verified.`;
}

function buildActionsBlock(history, { includeDriverText = true } = {}) {
  const actionsBlock = history.length
    ? history.map((h, i) => {
        const actionStr = JSON.stringify(includeDriverText ? stripRef(h.action) : stripDriverText(h.action));
        const lines = [`  ${i + 1}. action: ${actionStr}`];
        if (h.evidenceId) lines.push(`     evidenceId: ${h.evidenceId}`);
        if (typeof h.success === 'boolean') lines.push(`     success: ${h.success}`);
        if (h.beforeObservationId) lines.push(`     beforeObservationId: ${h.beforeObservationId}`);
        if (h.afterObservationId) lines.push(`     afterObservationId: ${h.afterObservationId}`);
        if (h.target) lines.push(`     target: ${h.target}`);
        if (h.locator) lines.push(`     locator: ${JSON.stringify(h.locator)}`);
        if (h.nativeState) lines.push(`     nativeState: ${JSON.stringify(h.nativeState)}`);
        if (h.url) lines.push(`     resultUrl: ${h.url}`);
        if (h.error) lines.push(`     error: ${sanitizeRefs(h.error)}`);
        if (h.observation) lines.push(`     resultObservation: ${JSON.stringify(stripObservationRefs(h.observation))}`);
        return lines.join('\n');
      }).join('\n')
    : '  (none)';
  return actionsBlock;
}

function stripDriverText(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) return action;
  const { reason, summary, ref, ...rest } = action;
  return rest;
}

function stripRef(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) return action;
  const { ref, ...rest } = action;
  if (rest.reason) rest.reason = sanitizeRefs(rest.reason);
  if (rest.summary) rest.summary = sanitizeRefs(rest.summary);
  return rest;
}

function stripObservationRefs(observation) {
  const { addedRefs, removedRefs, ...rest } = observation;
  return rest;
}

function sanitizeRefs(value) {
  return String(value).replace(/\b(?:ref\s+)?(?:f\d+)?e\d+\b/giu, 'selected element');
}

function buildTranscript({ verdict, history, finalUrl, finalSnapshot, browserEvidence }) {
  return (
    `Final URL: ${finalUrl}\n\n` +
    `Recorded browser actions (authoritative for interactions):\n${buildActionsBlock(history, { includeDriverText: false })}\n\n` +
    `Structured page-state evidence:\n${JSON.stringify(browserEvidence?.pageStates ?? [])}\n\n` +
    `Driver final response (authoritative only for what this response says):\n${JSON.stringify(stripRef(verdict))}\n\n` +
    `Final snapshot (authoritative for visible page state, not interactions):\n${finalSnapshot ?? ''}`
  );
}

function buildEvidenceRecords({ verdict, history, finalUrl, finalSnapshot, browserEvidence }) {
  const actions = history.filter(entry => entry.action && !['done', 'fail'].includes(entry.action.action)).map((entry, index) => ({
    id: entry.evidenceId ?? `action-${index + 1}`,
    type: 'action',
    action: stripDriverText(entry.action),
    target: entry.target ?? null,
    locator: entry.locator ?? null,
    success: entry.success ?? !entry.error,
    error: entry.error ? sanitizeRefs(entry.error) : null,
    url: entry.url ?? null,
    nativeState: entry.nativeState ?? null,
    observation: entry.observation ? stripObservationRefs(entry.observation) : null,
  }));
  const suppliedStates = browserEvidence?.pageStates ?? [];
  const pageStates = suppliedStates.map(state => ({
    ...state, type: 'page-state', ...(state.final ? { snapshot: finalSnapshot } : {}),
  }));
  if (!pageStates.some(state => state.final)) {
    pageStates.push({ id: 'page-final', type: 'page-state', final: true, url: finalUrl, snapshot: finalSnapshot, visibleText: '' });
  }
  return [
    { id: 'trajectory', type: 'trajectory', actionIds: actions.map(action => action.id), complete: true },
    { id: 'driver-final', type: 'driver-final', response: stripRef(verdict) },
    ...actions,
    ...pageStates,
  ];
}

function relevantEvidence(item, records) {
  const words = significantWords(item.sourceQuote);
  const actionClaim = /\b(?:click|select|choose|fill|enter|add|submit|navigate|reach|open)\w*\b/iu.test(item.sourceQuote);
  const pageClaim = /\b(?:visible|show|display|text|copy|url|page|result|warning|dialog|heading)\w*\b/iu.test(item.sourceQuote);
  const selected = records.filter(record => {
    if (record.type === 'trajectory') return actionClaim || /\b(?:do not|don't|never|without)\b/iu.test(item.sourceQuote);
    if (record.type === 'driver-final') return /\bfinal (?:response|answer|summary)\b/iu.test(item.sourceQuote);
    const overlap = words.some(word => JSON.stringify(record).toLocaleLowerCase().includes(word));
    return overlap || (record.type === 'action' && actionClaim) || (record.type === 'page-state' && pageClaim && record.final);
  });
  const final = records.find(record => record.type === 'page-state' && record.final);
  if (final && !selected.includes(final)) selected.push(final);
  return selected;
}

function deterministicCheck(item, relevant) {
  const source = item.sourceQuote;
  const pageStates = relevant.filter(record => record.type === 'page-state');
  const actions = relevant.filter(record => record.type === 'action');
  const finalPage = pageStates.find(record => record.final) ?? pageStates.at(-1);
  const quoted = [...source.matchAll(/["“]([^"”]+)["”]/gu)].map(match => match[1]);
  const exactUrl = source.match(/https?:\/\/[^\s"')]+/u)?.[0]?.replace(/[.,;:]$/u, '');

  if (exactUrl) {
    const support = finalPage?.url === exactUrl ? [finalPage.id] : [];
    const contradiction = support.length ? [] : finalPage ? [finalPage.id] : [];
    return deterministicResult(support, contradiction, `Compared the exact final URL with ${exactUrl}.`);
  }
  if (item.comparison === 'exact' && quoted.length) {
    const literal = quoted.at(-1);
    const match = relevant.find(record => JSON.stringify(record).includes(literal));
    const transient = /\b(?:transient|warning|dialog|toast|appeared)\b/iu.test(source);
    return deterministicResult(
      match ? [match.id] : [],
      !match && finalPage && !transient ? [finalPage.id] : [],
      match ? `Exact copy ${JSON.stringify(literal)} is recorded.` : `Exact copy ${JSON.stringify(literal)} is not present in the cited page state.`,
    );
  }

  const actionWord = source.match(/\b(click|select|choose|fill|enter|add|submit|navigate|reach|open)\w*\b/iu)?.[1]?.toLocaleLowerCase();
  if (!actionWord) return null;
  if (/^\s*if\b/iu.test(source)) return null;
  const negative = /\b(?:do not|don't|never|without)\b/iu.test(source);
  const requested = quoted.at(-1)?.toLocaleLowerCase();
  const sourceWords = significantWords(source);
  const matches = actions.filter(record => {
    const haystack = `${record.action?.action ?? ''} ${record.target ?? ''} ${JSON.stringify(record.nativeState ?? '')}`.toLocaleLowerCase();
    if (requested && haystack.includes(requested)) return true;
    return sourceWords.every(word => haystack.includes(word));
  });
  const stateClaim = /\b(?:select|choose|fill|enter)\w*\b/iu.test(source);
  const stateProves = record => {
    const after = record.nativeState?.after;
    if (!after) return false;
    if (after.checked === true) return true;
    const values = [after.value, after.inputValue, ...(Array.isArray(after.selected) ? after.selected : [])]
      .filter(value => value != null).map(value => String(value).toLocaleLowerCase());
    return values.some(value => requested ? value === requested : source.toLocaleLowerCase().includes(value));
  };
  const successful = matches.filter(record => record.success && (!stateClaim || stateProves(record)));
  if (negative) {
    return deterministicResult(
      successful.length ? [] : ['trajectory'],
      successful.map(record => record.id),
      successful.length ? 'A matching successful action was recorded.' : 'The complete action trajectory contains no matching successful action.',
    );
  }
  if (successful.length) {
    return deterministicResult(successful.map(record => record.id), [], 'Matching structured action evidence records success.');
  }
  if (stateClaim) {
    const proven = actions.filter(record => record.success && stateProves(record));
    const combined = proven.map(record => `${record.target ?? ''} ${JSON.stringify(record.nativeState ?? '')}`).join(' ').toLocaleLowerCase();
    if (proven.length && sourceWords.every(word => combined.includes(word))) {
      return deterministicResult(proven.map(record => record.id), [], 'Combined native control evidence records every requested group and value.');
    }
  }
  if (stateClaim && matches.some(record => record.success && !record.nativeState?.after)) return null;
  if (matches.length) {
    return deterministicResult([], matches.map(record => record.id), 'Matching structured action evidence records only failed actions.');
  }
  if (/\b(?:click|select|choose|fill|enter|navigate|open)\w*\b/iu.test(source)) {
    return deterministicResult([], [], 'The complete structured action evidence contains no matching successful action.');
  }
  return null;
}

function significantWords(value) {
  const stop = new Set(['the', 'and', 'with', 'from', 'that', 'this', 'then', 'into', 'only', 'both', 'must', 'should', 'verify', 'click', 'clicked', 'select', 'selected', 'choose', 'chosen', 'fill', 'filled', 'enter', 'entered', 'add', 'added', 'submit', 'submitted', 'navigate', 'navigated', 'reach', 'reached', 'open', 'opened']);
  const words = (value.toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._-]{2,}/gu) ?? []).map(word => word.replace(/[._-]+$/u, ''));
  return [...new Set(words)].filter(word => !stop.has(word));
}

function deterministicResult(supportingEvidenceIds, contradictingEvidenceIds, evidence) {
  return { supportingEvidenceIds, contradictingEvidenceIds, evidence, tokens: emptyTokens() };
}

function verdictFromEvidence(check) {
  if (check.contradictingEvidenceIds.length) return 'no';
  if (check.supportingEvidenceIds.length) return 'yes';
  return 'unknown';
}

async function callDecompose({ goal, model, resolveRequestAuth }) {
  const { parsed, tokens } = await callJson({
    systemPrompt: DECOMPOSE_PROMPT,
    prompt: `Goal: ${goal}\n\nYour JSON:`,
    model,
    resolveRequestAuth,
    label: 'verifier decomposition',
  });

  if (!Array.isArray(parsed.items) || parsed.items.length === 0) {
    throw errorWithTokens('decomposition returned no items', tokens);
  }
  const ids = new Set();
  const items = parsed.items.map(raw => {
    if (!raw || typeof raw !== 'object') throw protocolErrorWithTokens('invalid decomposition item', tokens);
    const item = {
      id: String(raw.id ?? '').trim(),
      text: String(raw.text ?? '').replace(/\s+/g, ' ').trim(),
      sourceQuote: String(raw.sourceQuote ?? '').trim(),
      kind: raw.kind,
      comparison: raw.comparison,
    };
    if (!item.id || ids.has(item.id) || !item.text || !item.sourceQuote) {
      throw protocolErrorWithTokens('invalid or duplicate grounded item', tokens);
    }
    if (!['assertion', 'instruction'].includes(item.kind) || !['semantic', 'exact'].includes(item.comparison)) {
      throw protocolErrorWithTokens(`invalid grounded item metadata: ${item.id}`, tokens);
    }
    if (!goal.includes(item.sourceQuote)) {
      throw protocolErrorWithTokens(`source quote is not present in binding goal: ${item.id}`, tokens);
    }
    item.text = item.sourceQuote.replace(/\s+/g, ' ').trim();
    ids.add(item.id);
    return item;
  });
  if (!items.some(item => item.kind === 'assertion')) {
    throw protocolErrorWithTokens('decomposition returned no assertions', tokens);
  }
  return { items, tokens };
}

async function callCheck({ item, relevant, model, resolveRequestAuth }) {
  const { parsed, tokens } = await callJson({
    systemPrompt: CHECK_PROMPT,
    prompt:
      `Relevant evidence:\n${JSON.stringify(relevant, null, 2)}\n\n` +
      `Source-grounded claim:\n${JSON.stringify(item)}\n\n` +
      `Your JSON:`,
    model,
    resolveRequestAuth,
    label: 'verifier claim check',
  });

  if (!Array.isArray(parsed.supportingEvidenceIds) || !Array.isArray(parsed.contradictingEvidenceIds)) {
    throw protocolErrorWithTokens('claim check must return both evidence ID arrays', tokens);
  }
  if (typeof parsed.evidence !== 'string' || !parsed.evidence.trim()) {
    throw protocolErrorWithTokens('missing claim evidence', tokens);
  }
  const allowed = new Set(relevant.map(record => record.id));
  const validateIds = ids => ids.map(id => {
    if (typeof id !== 'string' || !allowed.has(id)) {
      throw protocolErrorWithTokens(`claim check cited nonexistent or irrelevant evidence: ${id}`, tokens);
    }
    return id;
  });
  const supportingEvidenceIds = validateIds(parsed.supportingEvidenceIds);
  const contradictingEvidenceIds = validateIds(parsed.contradictingEvidenceIds);
  const explicitActionClaim = /\b(?:click|select|choose|fill|enter|open|navigate)\w*\b/iu.test(item.sourceQuote) &&
    !/\b(?:do not|don't|never|without)\b/iu.test(item.sourceQuote) &&
    !/^\s*if\b/iu.test(item.sourceQuote);
  if (explicitActionClaim && supportingEvidenceIds.length && !relevant.some(record =>
    record.type === 'action' && record.success && supportingEvidenceIds.includes(record.id)
  )) {
    throw protocolErrorWithTokens('successful interaction claim lacks a cited successful action', tokens);
  }
  return {
    supportingEvidenceIds,
    contradictingEvidenceIds,
    evidence: parsed.evidence.trim(), tokens,
  };
}

async function callSingleJudgeWithRetry(args) {
  try {
    return await callWithRetry(() => callSingleJudge(args));
  } catch (err) {
    throw new Error(`verifier failed after retry: ${err?.message?.split('\n')[0] ?? 'unknown'}`);
  }
}

async function callSingleJudge({ goal, verdict, history, finalUrl, finalSnapshot, model, resolveRequestAuth, browserEvidence }) {
  const { parsed, tokens } = await callJson({
    systemPrompt: SINGLE_JUDGE_PROMPT,
    prompt:
      `Goal: ${goal}\n\n` +
      `Driver final response (authoritative only for what this response says):\n${JSON.stringify(stripRef(verdict))}\n\n` +
      `Final URL: ${finalUrl}\n\n` +
      `Recorded browser actions (authoritative for interactions):\n${buildActionsBlock(history, { includeDriverText: false })}\n\n` +
      `Structured page-state evidence:\n${JSON.stringify(browserEvidence?.pageStates ?? [])}\n\n` +
      `Final snapshot (authoritative for visible page state, not interactions):\n${finalSnapshot}\n\n` +
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
  const json = extractJsonObject(text);
  if (!json) throw errorWithTokens(`no JSON in ${label}: ${text.slice(0, 200)}`, tokens);
  try {
    return { parsed: JSON.parse(json), tokens };
  } catch (err) {
    throw errorWithTokens(`${err.message}; raw: ${json.slice(0, 200)}`, tokens);
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
  const error = errorWithTokens(lastError?.message ?? 'unknown', tokens);
  if (lastError?.protocol) error.protocol = true;
  throw error;
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

function protocolErrorWithTokens(message, tokens) {
  const error = errorWithTokens(message, tokens);
  error.protocol = true;
  return error;
}
