import assert from 'node:assert/strict';
import test from 'node:test';
import { fauxAssistantMessage, registerFauxProvider } from '@earendil-works/pi-ai';
import { aggregateChecks, formatHumanEvidence, verify } from '../src/verifier.js';

const grounded = (sourceQuote, comparison = 'semantic', extra = {}) => fauxAssistantMessage(JSON.stringify({
  items: [{ id: 'claim-1', text: sourceQuote, sourceQuote, kind: 'assertion', comparison, ...extra }],
}));
const cited = (verdict, evidence, id = 'page-final') => fauxAssistantMessage(JSON.stringify({
  supportingEvidenceIds: verdict === 'yes' ? [id] : [],
  contradictingEvidenceIds: verdict === 'no' ? [id] : [],
  evidence,
}));
const uncited = evidence => cited('unknown', evidence);

test('fails on the first denied claim', () => {
  const checks = [
    { claim: 'claim one', verdict: 'yes', evidence: 'seen in turn 1' },
    { claim: 'claim two', verdict: 'no', evidence: 'turn 2 used a different path' },
    { claim: 'claim three', verdict: 'unknown', evidence: 'not present' },
  ];

  const result = aggregateChecks(checks);

  assert.equal(result.outcome, 'fail');
  assert.equal(result.evidence, 'failed claim: claim two; turn 2 used a different path');
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(checks.map(c => c.claim), ['claim one', 'claim two', 'claim three']);
});

test('fails when a required claim is unverified', () => {
  const result = aggregateChecks([
    { claim: 'claim one', verdict: 'yes', evidence: 'seen in turn 1' },
    { claim: 'claim two', verdict: 'unknown', evidence: 'not recorded' },
  ]);

  assert.equal(result.outcome, 'fail');
  assert.equal(result.evidence, 'unverified claim: claim two; not recorded');
  assert.deepEqual(result.warnings, ['unverified claim: claim two']);
});

test('falls back to single-call verification with mode and warning when decomposition is not JSON', async () => {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage('I would split this into claims.'),
    fauxAssistantMessage('Still not JSON.'),
    context => {
      const text = JSON.stringify(context);
      assert.match(text, /conditional requirement.*trigger.*consequence/);
      assert.match(text, /evidence sources separately.*visible element is not evidence that it was clicked/);
      return fauxAssistantMessage('{"outcome":"pass","evidence":"The final snapshot shows Done."}');
    },
  ]);

  try {
    const result = await verify('confirm done', { action: 'done' }, [], 'https://example.test', 'Done', faux.getModel(), async () => ({}));

    assert.equal(result.outcome, 'pass');
    assert.equal(result.verifierMode, 'single');
    assert.deepEqual(result.checks, []);
    assert.match(result.warnings[0], /^verifier: claim decomposition failed, fell back to single-call verification: no JSON in verifier decomposition:/);
  } finally {
    faux.unregister();
  }
});

test('records checks mode when claim-based verification completes', async () => {
  const faux = registerFauxProvider();
  let checkContext = '';
  faux.setResponses([
    grounded('confirm done'),
    context => {
      checkContext = JSON.stringify(context);
      return cited('yes', 'The final snapshot contains Done.');
    },
  ]);

  try {
    const history = [{
      action: { action: 'click', ref: 'e23', reason: 'Click ref e23' },
      target: 'button "Done"',
      locator: { playwright: 'page.getByRole("button", { name: "Done", exact: true })', css: '#done', frameUrl: null },
      error: 'ref e23 was briefly covered',
    }];
    const result = await verify('confirm done', { action: 'done' }, history, 'https://example.test', 'Done', faux.getModel(), async () => ({}));

    assert.equal(result.outcome, 'pass');
    assert.equal(result.verifierMode, 'checks');
    assert.equal(result.evidence, 'verified all 1 claims');
    assert.equal(result.humanEvidence, 'All 1 required claims were verified.');
    assert.equal(result.checks[0].claim, 'confirm done');
    assert.equal(result.checks[0].verdict, 'yes');
    assert.deepEqual(result.checks[0].supportingEvidenceIds, ['page-final']);
    assert.match(checkContext, /button.*Done/);
    assert.match(checkContext, /getByRole/);
    assert.doesNotMatch(checkContext, /\be23\b/);
  } finally {
    faux.unregister();
  }
});

test('claim checks receive the final response with explicit evidence boundaries', async () => {
  const faux = registerFauxProvider();
  faux.setResponses([
    grounded('In the final response, quote the visible advisory'),
    context => {
      const text = JSON.stringify(context);
      assert.match(text, /driver-final.*reviewed by a professional/);
      assert.match(text, /page-final.*reviewed by a professional/);
      assert.match(text, /final response is direct evidence only for claims about what the final response says/);
      return cited('yes', 'The final response quotes the advisory shown in the final snapshot.');
    },
  ]);

  try {
    const result = await verify(
      'In the final response, quote the visible advisory',
      { action: 'done', summary: 'Advisory: These calculations have not been reviewed by a professional.' },
      [],
      'https://example.test/results',
      '- text "These calculations have not been reviewed by a professional."',
      faux.getModel(),
      async () => ({}),
    );
    assert.equal(result.outcome, 'pass');
  } finally {
    faux.unregister();
  }
});

test('visible or unsuccessfully clicked CTAs are not evidence of successful CTA interaction', async () => {
  for (const history of [
    [{ action: { action: 'click', ref: 'e1' }, target: 'button "Calculate"' }],
    [{ action: { action: 'click', ref: 'e2' }, target: 'button "Book a call"', error: 'click target is hidden' }],
  ]) {
    const faux = registerFauxProvider();
    faux.setResponses([
      grounded('Do not click any result-page CTA'),
      context => {
        const text = JSON.stringify(context);
        assert.match(text, /A visible element is not evidence that it was clicked/);
        assert.match(text, /action entry containing an error is not evidence of a successful interaction/);
        return cited('yes', 'No successful recorded action clicked a result-page CTA.', 'trajectory');
      },
    ]);
    try {
      const result = await verify(
        'Do not click any result-page CTA',
        { action: 'done', summary: 'Results are visible.' },
        history,
        'https://example.test/results',
        '- button "Get my personal review"\n- button "Book a call"',
        faux.getModel(),
        async () => ({}),
      );
      assert.equal(result.outcome, 'pass');
    } finally {
      faux.unregister();
    }
  }
});

test('driver failure remains non-authoritative when every claim is proven', async () => {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(`${grounded('Done is visible').content[0].text} commentary {"ignored":true}`),
    fauxAssistantMessage(`\`\`\`json\n${cited('yes', 'The final snapshot shows Done.').content[0].text}\n\`\`\` trailing text`),
  ]);
  try {
    const result = await verify(
      'Done is visible',
      { action: 'fail', reason: 'driver was unsure' },
      [],
      'https://example.test',
      '- heading "Done"',
      faux.getModel(),
      async () => ({}),
    );
    assert.equal(result.outcome, 'pass');
    assert.equal(result.verifierMode, 'checks');
  } finally {
    faux.unregister();
  }
});

test('named group evidence is not treated as proof for a sibling group', async () => {
  const faux = registerFauxProvider();
  faux.setResponses([
    grounded('Same was selected in Travel pattern'),
    uncited('The action was in Work pattern, not Travel pattern.'),
  ]);
  try {
    const history = [{
      action: { action: 'click', ref: 'e2' },
      target: 'radio "Same" in fieldset "Work pattern"',
      url: 'https://example.test',
    }];
    const result = await verify(
      'Same was selected in Travel pattern',
      { action: 'done' },
      history,
      'https://example.test',
      '- radiogroup "Travel pattern"',
      faux.getModel(),
      async () => ({}),
    );
    assert.equal(result.outcome, 'fail');
    assert.equal(result.checks[0].verdict, 'unknown');
    assert.deepEqual(result.checks[0].supportingEvidenceIds, []);
  } finally {
    faux.unregister();
  }
});

test('a substituted exact item cannot pass verification', async () => {
  const faux = registerFauxProvider();
  faux.setResponses([
    grounded('Add the exact PB440 product'),
    cited('no', 'The action selected VM7 instead of PB440.', 'action-1'),
  ]);
  try {
    const result = await verify(
      'Add the exact PB440 product',
      { action: 'done', summary: 'A similar product was added.' },
      [{ action: { action: 'click', ref: 'e2' }, target: 'button "VM7"' }],
      'https://example.test/products',
      '- heading "Cart"\n  - text "VM7"',
      faux.getModel(),
      async () => ({}),
    );
    assert.equal(result.outcome, 'fail');
    assert.equal(result.checks[0].verdict, 'no');
    assert.match(result.humanEvidence, /PB440.*VM7/);
  } finally {
    faux.unregister();
  }
});

test('formats human evidence deterministically without another model call', async () => {
  const faux = registerFauxProvider();
  faux.setResponses([
    grounded('confirm done'),
    cited('yes', 'The final snapshot contains Done.'),
  ]);

  try {
    const result = await verify('confirm done', { action: 'done' }, [], 'https://example.test', 'Done', faux.getModel(), async () => ({}));

    assert.equal(result.outcome, 'pass');
    assert.equal(result.evidence, 'verified all 1 claims');
    assert.equal(result.humanEvidence, 'All 1 required claims were verified.');
    assert.deepEqual(result.warnings, []);
    assert.equal(result.checks[0].claim, 'confirm done');
    assert.equal(result.checks[0].verdict, 'yes');
  } finally {
    faux.unregister();
  }
});

test('human evidence names denied and unknown required claims', () => {
  assert.equal(formatHumanEvidence([
    { claim: 'use PB440', verdict: 'no', evidence: 'VM7 was used instead.' },
  ]), 'Failed required claim: use PB440. VM7 was used instead.');
  assert.equal(formatHumanEvidence([
    { claim: 'cart total is 10', verdict: 'unknown', evidence: 'No total was recorded.' },
  ]), 'Could not verify required claim: cart total is 10. No total was recorded.');
});

test('conditional requirements preserve implication outcomes', async () => {
  const cases = [
    ['if a cookie dialog appears, dismiss it', 'yes', 'No cookie dialog was offered.'],
    ['if a cookie dialog appears, dismiss it', 'yes', 'The dialog appeared and the Accept button was clicked.'],
    ['if a cookie dialog appears, dismiss it', 'no', 'The dialog appeared and remained open.'],
    ['if an optional choice is offered, select Standard', 'yes', 'The final form shows that no optional choice was offered.'],
    ['if validation fails, correct the fields and resubmit', 'yes', 'The first submission succeeded without a validation error.'],
    ['if a warning appears, acknowledge it', 'unknown', 'The transcript does not establish whether a warning appeared.'],
  ];

  for (const [index, [claim, verdict, evidence]] of cases.entries()) {
    const faux = registerFauxProvider();
    faux.setResponses([
      index === 0
        ? context => {
            assert.match(JSON.stringify(context), /one implication.*trigger.*consequence/);
            return grounded(claim);
          }
        : grounded(claim),
      index === 0
        ? context => {
            assert.match(JSON.stringify(context), /evaluate its trigger first.*trigger did not occur/);
            return verdict === 'unknown' ? uncited(evidence) : cited(verdict, evidence);
          }
        : verdict === 'unknown' ? uncited(evidence) : cited(verdict, evidence),
    ]);
    try {
      const result = await verify(claim, { action: 'done' }, [], 'https://example.test', 'Final state', faux.getModel(), async () => ({}));
      assert.equal(result.checks[0].claim, claim);
      assert.equal(result.checks[0].verdict, verdict);
      assert.equal(result.outcome, verdict === 'yes' ? 'pass' : 'fail');
    } finally {
      faux.unregister();
    }
  }
});

test('rejects invented source quotes without falling back', async () => {
  const faux = registerFauxProvider();
  faux.setResponses([grounded('invented requirement'), grounded('invented requirement')]);
  try {
    await assert.rejects(
      () => verify('Ready is visible', { action: 'done' }, [], 'https://example.test', 'Ready', faux.getModel(), async () => ({})),
      error => error.failureKind === 'verifier' && /source quote is not present/.test(error.message),
    );
  } finally {
    faux.unregister();
  }
});

test('rejects nonexistent evidence IDs after retry', async () => {
  const faux = registerFauxProvider();
  const invalid = cited('yes', 'Invented citation.', 'action-404');
  faux.setResponses([grounded('Ready is visible'), invalid, invalid]);
  try {
    await assert.rejects(
      () => verify('Ready is visible', { action: 'done' }, [], 'https://example.test', 'Ready', faux.getModel(), async () => ({})),
      error => error.failureKind === 'verifier' && /nonexistent or irrelevant evidence/.test(error.message),
    );
  } finally {
    faux.unregister();
  }
});

test('resolves explicit exact copy locally', async () => {
  const faux = registerFauxProvider();
  faux.setResponses([grounded('The exact copy is "Total: 10.00 EUR".', 'exact')]);
  try {
    const result = await verify(
      'The exact copy is "Total: 10.00 EUR".', { action: 'done' }, [], 'https://example.test',
      '- text "Total: 10,00 EUR"', faux.getModel(), async () => ({}),
    );
    assert.equal(result.outcome, 'fail');
    assert.equal(result.failureKind, 'assertion');
    assert.deepEqual(result.checks[0].contradictingEvidenceIds, ['page-final']);
  } finally {
    faux.unregister();
  }
});

test('derives verdict from citations rather than prose', async () => {
  const faux = registerFauxProvider();
  faux.setResponses([
    grounded('Ready is visible'),
    cited('yes', 'The explanation incorrectly says Ready is absent.'),
  ]);
  try {
    const result = await verify('Ready is visible', { action: 'done' }, [], 'https://example.test', 'Ready', faux.getModel(), async () => ({}));
    assert.equal(result.checks[0].verdict, 'yes');
    assert.equal(result.outcome, 'pass');
  } finally {
    faux.unregister();
  }
});

test('visible controls cannot prove an unrecorded click', async () => {
  const faux = registerFauxProvider();
  faux.setResponses([grounded('Click Book a call')]);
  try {
    const result = await verify(
      'Click Book a call', { action: 'done' }, [], 'https://example.test', '- button "Book a call"', faux.getModel(), async () => ({}),
    );
    assert.equal(result.checks[0].verdict, 'unknown');
    assert.equal(result.failureKind, 'unverified');
  } finally {
    faux.unregister();
  }
});
