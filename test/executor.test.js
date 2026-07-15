import assert from 'node:assert/strict';
import test from 'node:test';
import { fauxAssistantMessage, registerFauxProvider } from '@earendil-works/pi-ai';
import { chromium } from 'playwright';
import { backRecoveryError, driverWaitMs, runTodo, scrubOldSnapshots, toPublicStep } from '../src/executor.js';

test('public steps replace ephemeral accessibility refs with target metadata', () => {
  const step = toPublicStep({
    turn: 1,
    action: { action: 'click', ref: 'f1e23', reason: 'Click ref f1e23' },
    target: 'button "Submit"',
    locator: { playwright: 'page.getByRole("button", { name: "Submit", exact: true })', css: '#submit', frameUrl: null },
    error: 'ref f1e23 is not present',
    observation: { addedRefs: ['e1'], removedRefs: ['e3'], addedText: ['Done'] },
  });
  assert.deepEqual(step.action, { action: 'click', reason: 'Click selected element' });
  assert.equal(step.error, 'selected element is not present');
  assert.deepEqual(step.observation, { addedText: ['Done'], addedElementsCount: 1, removedElementsCount: 1 });
  assert.doesNotMatch(JSON.stringify(step), /\b(?:f\d+)?e\d+\b/);
});

test('older driver snapshots are scrubbed while the latest stays complete', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '<<SNAPSHOT_BEGIN>>\n- textbox "Old" [ref=e1]\n<<SNAPSHOT_END>>' }] },
    { role: 'assistant', content: [{ type: 'text', text: '{"action":"wait"}' }] },
    { role: 'user', content: [{ type: 'text', text: '<<SNAPSHOT_BEGIN>>\n- textbox "Current" [ref=e2]\n<<SNAPSHOT_END>>' }] },
  ];
  const scrubbed = scrubOldSnapshots(messages);
  assert.doesNotMatch(scrubbed[0].content[0].text, /Old/);
  assert.match(scrubbed[2].content[0].text, /Current/);
});

test('back recovery and waits retain their runtime bounds', () => {
  assert.match(backRecoveryError('Do not use browser back', 2), /explicitly forbids/);
  assert.match(backRecoveryError('Reach settings', 0), /no reversible/);
  assert.equal(backRecoveryError('Reach settings', 1), null);
  assert.equal(driverWaitMs(undefined), 1000);
  assert.equal(driverWaitMs(10_000), 10_000);
  assert.throws(() => driverWaitMs(10_001), /wait rejected/);
});

test('driver and verifier receive the same single goal and verifier decides the final state', async () => {
  const faux = registerFauxProvider();
  const goal = 'Persona: enter 99.\nAcceptance:\n- Ready is visible.';
  faux.setResponses([
    context => {
      const text = JSON.stringify(context);
      assert.match(text, /Goal:\\nPersona: enter 99/);
      assert.doesNotMatch(text, /Binding verification goal/);
      return fauxAssistantMessage('{"action":"fail","reason":"unsure"}');
    },
    context => {
      const text = JSON.stringify(context);
      assert.match(text, /Goal:\\nPersona: enter 99/);
      assert.match(text, /Acceptance:\\n- Ready is visible/);
      return fauxAssistantMessage('{"outcome":"pass","evidence":"The frozen page shows Ready."}');
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
    assert.equal(result.llmVerdict.action, 'fail');
    assert.equal(result.evidence, 'The frozen page shows Ready.');
    assert.equal('goalContract' in result, false);
  } finally {
    faux.unregister();
  }
});

test('successful unchanged wrapper click is trusted and the driver continues', async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const faux = registerFauxProvider();
  await page.setContent(`
    <label style="cursor:pointer"><input type="radio" name="sex" value="female" hidden>Female</label>
    <input aria-label="Age">
  `);
  faux.setResponses([
    context => {
      const text = context.messages.flatMap(message => message.content ?? []).map(part => part.text ?? '').join('\n');
      const ref = text.match(/generic \[ref=(e\d+)\] \[cursor=pointer\]: Female/)?.[1];
      return fauxAssistantMessage(JSON.stringify({ action: 'click', ref }));
    },
    context => {
      const text = context.messages.flatMap(message => message.content ?? []).map(part => part.text ?? '').join('\n');
      assert.match(text, /Click succeeded.*continue instead of repeating/);
      const ref = text.match(/textbox "Age" \[ref=(e\d+)\]/)?.[1];
      return fauxAssistantMessage(JSON.stringify({ action: 'fill', ref, value: '35' }));
    },
    fauxAssistantMessage('{"outcome":"pass","evidence":"The wrapper click succeeded and the next field was filled."}'),
  ]);
  try {
    const result = await runTodo(page, 'Select Female, then enter age 35.', faux.getModel(), async () => ({}), 2, faux.getModel());
    const clicks = result.history.filter(step => step.action?.action === 'click');
    assert.equal(clicks.length, 1);
    assert.equal(clicks[0].success, true);
    assert.equal(await page.getByLabel('Age').inputValue(), '35');

    const repeatClick = context => {
      const text = context.messages.flatMap(message => message.content ?? []).map(part => part.text ?? '').join('\n');
      const ref = text.match(/generic \[ref=(e\d+)\] \[cursor=pointer\]: Female/)?.[1];
      return fauxAssistantMessage(JSON.stringify({ action: 'click', ref }));
    };
    faux.setResponses([
      repeatClick, repeatClick, repeatClick, repeatClick, repeatClick,
      fauxAssistantMessage('{"outcome":"fail","evidence":"The driver repeated an ineffective action and did not complete the goal."}'),
    ]);
    const stuck = await runTodo(page, 'Select Female and finish.', faux.getModel(), async () => ({}), 5, faux.getModel());
    assert.match(stuck.history.at(-1)?.error ?? JSON.stringify(stuck.history), /stuck termination/);
  } finally {
    faux.unregister();
    await browser.close();
  }
});
