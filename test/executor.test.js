import assert from 'node:assert/strict';
import test from 'node:test';
import { fauxAssistantMessage, registerFauxProvider } from '@earendil-works/pi-ai';
import { checkDoneContradiction, runTodo } from '../src/executor.js';

test('done contradiction check includes latest addedText and rejects contradicted summary', async () => {
  const faux = registerFauxProvider();
  let seenContext = '';
  faux.setResponses([
    (context) => {
      seenContext = JSON.stringify(context);
      return fauxAssistantMessage(
        '{"contradicted":true,"reason":"The final observation shows \\"There was a problem with your submission.\\""}',
      );
    },
  ]);

  try {
    const result = await checkDoneContradiction({
      goal: 'successfully send the form',
      summary: 'The form was submitted successfully.',
      finalUrl: 'https://www.gravityforms.com/form-templates/project-inquiry-form/',
      observation: {
        mostRecentBeforeDone: {
          addedText: ['There was a problem with your submission. Please review the fields below.'],
        },
        terminalAfterDone: null,
      },
      model: faux.getModel(),
      resolveRequestAuth: async () => ({}),
    });

    assert.match(seenContext, /There was a problem with your submission/);
    assert.match(seenContext, /does the final observation contradict the driver's success summary/);
    assert.match(result.problem, /There was a problem with your submission/);
  } finally {
    faux.unregister();
  }
});

test('done contradiction check allows non-contradicted summaries', async () => {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage('{"contradicted":false,"reason":"No contradiction."}'),
  ]);

  try {
    const result = await checkDoneContradiction({
      goal: 'confirm the success page',
      summary: 'The success page is visible.',
      finalUrl: 'https://example.test/success',
      observation: {
        mostRecentBeforeDone: { addedText: ['Thanks for contacting us'] },
        terminalAfterDone: null,
      },
      model: faux.getModel(),
      resolveRequestAuth: async () => ({}),
    });

    assert.equal(result.problem, null);
  } finally {
    faux.unregister();
  }
});

test('executor rejects done when latest observation contradicts success summary', async () => {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage('{"action":"wait","ms":1}'),
    fauxAssistantMessage('{"action":"done","summary":"The form was submitted successfully. No error messages were visible."}'),
    fauxAssistantMessage(
      '{"contradicted":true,"reason":"The final observation shows \\"There was a problem with your submission.\\""}',
    ),
    fauxAssistantMessage('{"claims":["the form was submitted successfully"]}'),
    fauxAssistantMessage(
      '{"verdict":"no","evidence":"The done gate rejected the summary because the observation showed There was a problem with your submission."}',
    ),
  ]);

  const beforeSubmit = `- main [ref=e1]:
  - button "Submit Inquiry" [ref=e2]
`;
  const withSubmissionError = `- main [ref=e1]:
  - text "There was a problem with your submission. Please review the fields below." [ref=e3]
`;
  const withFieldError = `- main [ref=e1]:
  - text "There was a problem with your submission. Please review the fields below." [ref=e3]
  - text "Name: This field is required." [ref=e4]
`;
  const snapshots = [beforeSubmit, withSubmissionError, withFieldError, withFieldError, withFieldError];
  let observes = 0;
  const page = {
    url: () => 'https://example.test/form',
    waitForTimeout: async () => {},
    screenshot: async () => Buffer.from(''),
    locator: () => ({
      ariaSnapshot: async () => snapshots[Math.min(observes++, snapshots.length - 1)],
    }),
  };

  try {
    const result = await runTodo(
      page,
      'successfully send the form',
      faux.getModel(),
      async () => ({}),
      5,
      faux.getModel(),
      null,
      30_000,
    );

    assert.equal(result.outcome, 'fail');
    assert.equal(result.llmVerdict.action, 'fail');
    assert.match(result.llmVerdict.reason, /There was a problem with your submission/);
    assert.match(result.history.at(-1).error, /done-gate rejected/);
  } finally {
    faux.unregister();
  }
});
