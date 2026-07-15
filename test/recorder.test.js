import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPayload, record } from '../src/recorder.js';

test('records locale in trace payloads', () => {
  const payload = buildPayload('goal', 'driver', 'verifier', {
    outcome: 'pass',
    llmVerdict: null,
    evidence: 'ok',
    humanEvidence: 'Looks good.',
    finalUrl: 'https://example.test',
    turns: 0,
    elapsedMs: 0,
    tokens: null,
    verifierTokens: null,
    verifierMode: 'checks',
    failureKind: null,
    goalContract: { fullGoal: 'goal', verificationGoal: 'binding goal', source: 'acceptance' },
    browserEvidence: { pageStates: [{ id: 'page-1', final: true }] },
    excludedItems: [{ id: 'instruction-1', kind: 'instruction' }],
    history: [{
      turn: 1,
      action: { action: 'click', ref: 'e1' },
      target: 'button "Submit"',
      locator: { playwright: 'page.getByRole("button", { name: "Submit", exact: true })', css: '#submit', frameUrl: null },
      observation: { addedRefs: ['e2'], removedRefs: ['f1e3'] },
      recoveredVia: 'overlay',
    }],
    warnings: [],
    checks: [
      { claim: 'claim one', verdict: 'yes', evidence: 'seen' },
    ],
  }, 'de-DE');

  assert.equal(payload.locale, 'de-DE');
  assert.equal(payload.verifierMode, 'checks');
  assert.equal(payload.goalContract.source, 'acceptance');
  assert.equal(payload.browserEvidence.pageStates[0].id, 'page-1');
  assert.equal(payload.excludedItems[0].kind, 'instruction');
  assert.equal(payload.evidence, 'ok');
  assert.equal(payload.humanEvidence, 'Looks good.');
  assert.deepEqual(payload.checks, [
    { claim: 'claim one', verdict: 'yes', evidence: 'seen' },
  ]);
  assert.equal(payload.steps[0].recoveredVia, 'overlay');
  assert.equal(payload.steps[0].action.ref, undefined);
  assert.equal(payload.steps[0].target, 'button "Submit"');
  assert.equal(payload.steps[0].locator.css, '#submit');
  assert.equal(payload.steps[0].observation.addedElementsCount, 1);
  assert.equal(payload.steps[0].observation.removedElementsCount, 1);
  assert.equal(payload.steps[0].observation.addedRefs, undefined);
});

test('trace recording persists the supplied frozen failure evidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qagent-trace-'));
  const result = {
    outcome: 'fail',
    evidence: 'failed claim',
    humanEvidence: 'Failed required claim.',
    finalUrl: 'https://example.test',
    finalSnapshot: '- heading "Frozen"',
    failureScreenshot: Buffer.from('frozen screenshot'),
    turns: 1,
    elapsedMs: 1,
    history: [],
    warnings: [],
  };

  try {
    const filepath = await record('goal', 'driver', 'verifier', result, dir);
    assert.ok(JSON.parse(await readFile(filepath, 'utf8')));
    const screenshot = (await readdir(dir)).find(name => name.endsWith('.screenshot.png'));
    assert.equal(await readFile(join(dir, screenshot), 'utf8'), 'frozen screenshot');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
