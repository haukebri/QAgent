import assert from 'node:assert/strict';
import test from 'node:test';
import { fauxAssistantMessage, registerFauxProvider } from '@earendil-works/pi-ai';
import { backRecoveryError, driverWaitMs, runTodo, scrubOldSnapshots, toPublicStep } from '../src/executor.js';

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
    fauxAssistantMessage('{"claims":["the form was submitted successfully"]}'),
    fauxAssistantMessage('{"verdict":"unknown","evidence":"No submission result is visible."}'),
    fauxAssistantMessage('{"humanEvidence":"The run failed because submission was not verified."}'),
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
    fauxAssistantMessage('{"claims":["Ready became visible"]}'),
    fauxAssistantMessage('{"verdict":"yes","evidence":"The final snapshot shows Ready."}'),
    fauxAssistantMessage('{"humanEvidence":"Ready became visible."}'),
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
  faux.setResponses([
    fauxAssistantMessage('{"action":"click","ref":"e2"}'),
    fauxAssistantMessage('{"action":"done","summary":"Complete is visible."}'),
    fauxAssistantMessage('{"claims":["Complete is visible"]}'),
    fauxAssistantMessage('{"verdict":"yes","evidence":"The final snapshot shows Complete."}'),
    fauxAssistantMessage('{"humanEvidence":"Complete is visible."}'),
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
    const result = await runTodo(page, 'Click Save and verify Complete.', faux.getModel(), async () => ({}), 3, faux.getModel());
    assert.equal(result.history[0].observation.settleReason, 'changed');
    assert.deepEqual(result.history[0].observation.addedText, ['Complete']);
    assert.equal(result.history[1].observation.terminal, true);
  } finally {
    faux.unregister();
  }
});

test('a replaced URL does not authorize browser-back recovery', async () => {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage('{"action":"click","ref":"e2"}'),
    fauxAssistantMessage('{"action":"goBack"}'),
    fauxAssistantMessage('{"claims":["the run stayed out of about:blank"]}'),
    fauxAssistantMessage('{"verdict":"unknown","evidence":"No safe recovery was shown."}'),
    fauxAssistantMessage('{"humanEvidence":"Safe recovery was not verified."}'),
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
