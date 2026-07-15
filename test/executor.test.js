import assert from 'node:assert/strict';
import test from 'node:test';
import { fauxAssistantMessage, registerFauxProvider } from '@earendil-works/pi-ai';
import { chromium } from 'playwright';
import { backRecoveryError, driverWaitMs, runTodo, scrubOldSnapshots, toPublicStep } from '../src/executor.js';

const grounded = (sourceQuote, comparison = 'semantic') => fauxAssistantMessage(JSON.stringify({
  items: [{ id: 'claim-1', text: sourceQuote, sourceQuote, kind: 'assertion', comparison }],
}));
const citedPage = (verdict, evidence) => context => {
  const ids = [...JSON.stringify(context).matchAll(/\\?"id\\?":\s*\\?"(page-[^\\"]+)/g)].map(match => match[1]);
  const id = ids.at(-1);
  return fauxAssistantMessage(JSON.stringify({
    supportingEvidenceIds: verdict === 'yes' ? [id] : [],
    contradictingEvidenceIds: verdict === 'no' ? [id] : [],
    evidence,
  }));
};
const unknownCitation = evidence => fauxAssistantMessage(JSON.stringify({ supportingEvidenceIds: [], contradictingEvidenceIds: [], evidence }));

test('public steps replace ephemeral accessibility refs with target metadata', () => {
  const step = toPublicStep({
    turn: 1,
    action: { action: 'click', ref: 'f1e23', reason: 'Click ref f1e23' },
    target: 'button "Submit"',
    locator: { playwright: 'page.getByRole("button", { name: "Submit", exact: true })', css: '#submit', frameUrl: null },
    error: 'ref f1e23 is not present',
    observation: { addedRefs: ['e1', 'f1e2'], removedRefs: ['e3'], addedText: ['Done'] },
  });

  assert.deepEqual(step.action, { action: 'click', reason: 'Click selected element' });
  assert.equal(step.error, 'selected element is not present');
  assert.equal(step.target, 'button "Submit"');
  assert.equal(step.locator.css, '#submit');
  assert.deepEqual(step.observation, { addedText: ['Done'], addedElementsCount: 2, removedElementsCount: 1 });
  assert.doesNotMatch(JSON.stringify(step), /\b(?:f\d+)?e\d+\b/);
});

test('older driver snapshots are scrubbed while the latest stays complete', () => {
  const oldSnapshot = '- form "Profile" [ref=e1]:\n  - textbox "Name" [ref=e2]';
  const currentSnapshot = '- form "Profile" [ref=e1]:\n  - textbox "Name" [ref=e2]\n  - radio "Same" [ref=e3]';
  const messages = [
    { role: 'user', content: [{ type: 'text', text: `<<SNAPSHOT_BEGIN>>\n${oldSnapshot}\n<<SNAPSHOT_END>>` }] },
    { role: 'assistant', content: [{ type: 'text', text: '{"action":"click","ref":"e3"}' }] },
    { role: 'user', content: [{ type: 'text', text: `<<SNAPSHOT_BEGIN>>\n${currentSnapshot}\n<<SNAPSHOT_END>>` }] },
  ];

  const scrubbed = scrubOldSnapshots(messages);
  assert.doesNotMatch(scrubbed[0].content[0].text, /textbox "Name"/);
  assert.match(scrubbed[2].content[0].text, /textbox "Name" \[ref=e2\]/);
  assert.match(scrubbed[2].content[0].text, /radio "Same" \[ref=e3\]/);
  assert.doesNotMatch(scrubbed[2].content[0].text, /unchanged since/);
});

test('back recovery respects goal constraints and observed navigation', () => {
  assert.match(backRecoveryError('Do not use browser back during this test', 2), /goal explicitly forbids/);
  assert.match(backRecoveryError('Reach the settings page', 0), /no reversible in-run navigation/);
  assert.equal(backRecoveryError('Reach the settings page', 1), null);
});

test('driver waits are bounded', () => {
  assert.equal(driverWaitMs(undefined), 1000);
  assert.equal(driverWaitMs(10_000), 10_000);
  assert.throws(() => driverWaitMs(10_001), /wait rejected/);
  assert.throws(() => driverWaitMs(Number.NaN), /wait rejected/);
});

test('a premature driver done is decided by the verifier without another driver-model judgment', async () => {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage('{"action":"done","summary":"Everything is complete."}'),
    grounded('successfully send the form'),
    unknownCitation('No submission result is visible.'),
  ]);

  const snapshot = '- main [ref=e1]:\n  - button "Submit" [ref=e2]\n';
  const page = {
    url: () => 'https://example.test/form',
    screenshot: async () => Buffer.from(''),
    locator: () => ({ ariaSnapshot: async () => snapshot }),
  };

  try {
    const result = await runTodo(
      page,
      'successfully send the form',
      faux.getModel(),
      async () => ({}),
      2,
      faux.getModel(),
      null,
      30_000,
    );

    assert.equal(result.outcome, 'fail');
    assert.equal(result.llmVerdict.action, 'done');
    assert.equal(result.checks[0].verdict, 'unknown');
    assert.equal(result.tokens.totalTokens, result.history[0].tokens.totalTokens);
  } finally {
    faux.unregister();
  }
});

test('an explicit wait uses post-delay settle sampling', async () => {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage('{"action":"wait","ms":1}'),
    grounded('Ready is visible'),
    citedPage('yes', 'The final snapshot shows Ready.'),
  ]);
  const before = '- status "Pending" [ref=e1]';
  const after = '- status "Ready" [ref=e1]';
  const snapshots = [before, before, after, after];
  let calls = 0;
  const page = {
    url: () => 'https://example.test',
    waitForTimeout: async () => {},
    screenshot: async () => Buffer.from(''),
    locator: () => ({ ariaSnapshot: async () => snapshots[Math.min(calls++, snapshots.length - 1)] }),
  };
  try {
    const result = await runTodo(page, 'Wait until Ready is visible', faux.getModel(), async () => ({}), 1, faux.getModel());
    assert.equal(result.history[0].observation.settleReason, 'changed');
    assert.match(result.finalSnapshot, /Ready/);
  } finally {
    faux.unregister();
  }
});

test('terminal settling does not erase the preceding action observation', async () => {
  const faux = registerFauxProvider();
  const events = [];
  faux.setResponses([
    fauxAssistantMessage('{"action":"click","ref":"e2"}'),
    fauxAssistantMessage('{"action":"done","summary":"Complete is visible."}'),
    grounded('Complete'),
    citedPage('yes', 'The final snapshot shows Complete.'),
  ]);
  const before = '- main [ref=e1]:\n  - button "Save" [ref=e2]';
  const after = '- main [ref=e1]:\n  - heading "Complete" [ref=e3]';
  let changed = false;
  const page = {
    url: () => 'https://example.test',
    screenshot: async () => Buffer.from(''),
    locator: selector => selector === 'body'
      ? { ariaSnapshot: async () => changed ? after : before }
      : { evaluate: async () => { throw new Error('no DOM'); }, click: async () => { changed = true; } },
  };
  try {
    const result = await runTodo(
      page, 'Click Save and verify Complete.', faux.getModel(), async () => ({}),
      3, faux.getModel(), event => events.push(event),
    );
    assert.equal(result.history[0].observation.settleReason, 'changed');
    assert.deepEqual(result.history[0].observation.addedText, ['Complete']);
    assert.equal(result.history[1].observation.terminal, true);
    assert.equal(events[1].observation.terminal, true);
  } finally {
    faux.unregister();
  }
});

test('a replaced URL does not authorize browser-back recovery', async () => {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage('{"action":"click","ref":"e2"}'),
    fauxAssistantMessage('{"action":"goBack"}'),
    grounded('do not leave the application'),
    unknownCitation('No safe recovery was shown.'),
  ]);
  const start = '- main [ref=e1]:\n  - link "Replace" [ref=e2]';
  const replaced = '- main [ref=e1]:\n  - heading "Replacement" [ref=e3]';
  let url = 'https://example.test/start';
  let goBackCalls = 0;
  const page = {
    url: () => url,
    evaluate: async () => 1,
    screenshot: async () => Buffer.from(''),
    goBack: async () => {
      goBackCalls++;
      url = 'about:blank';
      return null;
    },
    locator: selector => selector === 'body'
      ? { ariaSnapshot: async () => url.endsWith('/start') ? start : replaced }
      : { evaluate: async () => { throw new Error('no DOM'); }, click: async () => { url = 'https://example.test/replaced'; } },
  };
  try {
    await runTodo(page, 'Open Replacement, but do not leave the application.', faux.getModel(), async () => ({}), 2, faux.getModel());
    assert.equal(goBackCalls, 0);
    assert.notEqual(url, 'about:blank');
  } finally {
    faux.unregister();
  }
});

test('the initial state settles before turn one and a turn-one fail settles again', async () => {
  const faux = registerFauxProvider();
  const transient = '- status "Loading" [ref=e1]';
  const stable = '- main [ref=e1]:\n  - heading "Exact item unavailable" [ref=e2]';
  const snapshots = [transient, stable, stable];
  let calls = 0;
  faux.setResponses([
    context => {
      assert.match(JSON.stringify(context), /Exact item unavailable/);
      assert.doesNotMatch(JSON.stringify(context), /status \\"Loading/);
      return fauxAssistantMessage('{"action":"fail","reason":"The exact item is unavailable."}');
    },
    grounded('Add the exact item'),
    citedPage('no', 'The stable page says Exact item unavailable.'),
  ]);
  const page = {
    url: () => 'https://example.test/products',
    screenshot: async () => Buffer.from(stable),
    locator: () => ({ ariaSnapshot: async () => snapshots[Math.min(calls++, snapshots.length - 1)] }),
  };

  try {
    const result = await runTodo(page, 'Add the exact item', faux.getModel(), async () => ({}), 2, faux.getModel());
    assert.equal(result.history[0].observation.terminal, true);
    assert.match(result.finalSnapshot, /Exact item unavailable/);
  } finally {
    faux.unregister();
  }
});

test('verifier-time page mutation cannot change frozen failure evidence', async () => {
  const faux = registerFauxProvider();
  let state = 'Frozen state';
  faux.setResponses([
    fauxAssistantMessage('{"action":"done","summary":"Complete."}'),
    () => {
      state = 'Mutated during verification';
      return grounded('Prove the required state');
    },
    unknownCitation('The required state is not proven.'),
  ]);
  const page = {
    url: () => 'https://example.test',
    screenshot: async () => Buffer.from(state),
    locator: () => ({ ariaSnapshot: async () => `- heading "${state}" [ref=e1]` }),
  };

  try {
    const result = await runTodo(page, 'Prove the required state', faux.getModel(), async () => ({}), 1, faux.getModel());
    assert.match(result.finalSnapshot, /Frozen state/);
    assert.equal(result.failureScreenshot.toString(), 'Frozen state');
    assert.equal(state, 'Mutated during verification');
  } finally {
    faux.unregister();
  }
});

test('driver guidance forbids substituting exact named requirements', async () => {
  const faux = registerFauxProvider();
  faux.setResponses([
    context => {
      assert.match(JSON.stringify(context), /Exact named products.*never substitute a similar alternative/);
      assert.match(JSON.stringify(context), /goal explicitly permits alternatives/);
      return fauxAssistantMessage('{"action":"fail","reason":"PB440 is absent; VM7 is not an allowed substitute."}');
    },
    grounded('Add PB440'),
    citedPage('no', 'Only VM7 is visible.'),
  ]);
  const snapshot = '- main [ref=e1]:\n  - button "VM7" [ref=e2]';
  const page = {
    url: () => 'https://example.test/products',
    screenshot: async () => Buffer.from(''),
    locator: () => ({ ariaSnapshot: async () => snapshot }),
  };

  try {
    const result = await runTodo(page, 'Add PB440', faux.getModel(), async () => ({}), 1, faux.getModel());
    assert.equal(result.llmVerdict.action, 'fail');
    assert.equal(result.history.some(step => step.action?.action === 'click'), false);
  } finally {
    faux.unregister();
  }
});

test('driver and verifier fallback share the explicit Acceptance contract', async () => {
  const faux = registerFauxProvider();
  const goal = 'Persona: enter 99.\nOnly the Acceptance section is binding.\nAcceptance:\n- Ready is visible.';
  faux.setResponses([
    context => {
      const text = JSON.stringify(context);
      assert.match(text, /Execution guidance.*Persona: enter 99/);
      assert.match(text, /Binding verification goal \(acceptance\).*Ready is visible/);
      return fauxAssistantMessage('{"action":"done"}');
    },
    context => {
      const text = JSON.stringify(context);
      assert.match(text, /Ready is visible/);
      assert.doesNotMatch(text, /Persona: enter 99/);
      return fauxAssistantMessage('not json');
    },
    fauxAssistantMessage('still not json'),
    context => {
      const text = JSON.stringify(context);
      assert.match(text, /Goal: - Ready is visible/);
      assert.doesNotMatch(text, /Persona: enter 99/);
      return fauxAssistantMessage('{"outcome":"pass","evidence":"Ready is visible."}');
    },
  ]);
  const page = {
    url: () => 'https://example.test',
    screenshot: async () => Buffer.from(''),
    locator: () => ({ ariaSnapshot: async () => '- status "Ready"' }),
  };

  try {
    const result = await runTodo(page, goal, faux.getModel(), async () => ({}), 1, faux.getModel());
    assert.equal(result.outcome, 'pass');
    assert.equal(result.goal, goal);
    assert.equal(result.goalContract.source, 'acceptance');
    assert.equal(result.verifierMode, 'single');
  } finally {
    faux.unregister();
  }
});

test('grouped-form actions retain native state and transient visible text evidence', async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const faux = registerFauxProvider();
  await page.setContent(`
    <fieldset><legend>Work pattern</legend><label><input type="radio" name="work" value="same" checked> Same</label></fieldset>
    <section><h2>Travel pattern</h2><label><input type="radio" name="travel" value="same"> Same</label></section>
    <button onclick="const warning=document.body.appendChild(document.createElement('div')); warning.textContent='Check your entry'; setTimeout(() => warning.remove(), 400)">Check</button>
  `);
  const actionFor = (context, pattern, last = false) => {
    const text = context.messages.flatMap(message => message.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
    const refs = [...text.matchAll(new RegExp(`${pattern}[^\\n]*?\\[ref=(e\\d+)\\]`, 'g'))];
    return fauxAssistantMessage(JSON.stringify({ action: 'click', ref: refs[last ? refs.length - 1 : 0][1] }));
  };
  faux.setResponses([
    context => actionFor(context, 'radio "Same"'),
    context => {
      assert.match(JSON.stringify(context), /Action succeeded; resulting control state.*checked.*true/);
      return actionFor(context, 'radio "Same"', true);
    },
    context => actionFor(context, 'button "Check"'),
    fauxAssistantMessage('{"action":"done"}'),
    grounded('Select Same in both groups and show Check your entry.'),
    citedPage('yes', 'The structured actions and visible-text delta prove both facts.'),
  ]);

  try {
    const result = await runTodo(page, 'Select Same in both groups and show Check your entry.', faux.getModel(), async () => ({}), 4, faux.getModel());
    const radios = result.history.filter(step => step.target?.startsWith('radio "Same"'));
    assert.deepEqual(radios.map(step => step.nativeState.after.name), ['work', 'travel']);
    assert.ok(radios.every(step => step.nativeState.after.checked && step.success));
    assert.match(radios[0].target, /Work pattern/);
    assert.match(radios[1].target, /Travel pattern/);
    assert.deepEqual(radios.map(step => step.evidenceId), ['action-1', 'action-2']);
    assert.ok(radios.every(step => step.beforeObservationId && step.afterObservationId));
    assert.ok(result.history[2].observation.visibleTextAdded.includes('Check your entry'));
    assert.doesNotMatch(result.finalSnapshot, /Check your entry/);
  } finally {
    faux.unregister();
    await browser.close();
  }
});
