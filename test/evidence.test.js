import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createEvidenceRecorder, stepScreenshotName } from '../src/evidence.js';

test('names step screenshots deterministically', () => {
  assert.equal(stepScreenshotName(3), 'step-03.jpg');
  assert.equal(stepScreenshotName(3, 3), 'step-003.jpg');
});

test('writes step and final screenshots through Playwright', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qagent-evidence-'));
  const calls = [];
  const page = {
    screenshot: async (options) => {
      calls.push(options);
      await writeFile(options.path, 'jpg');
    },
  };

  try {
    const evidence = createEvidenceRecorder(dir, { maxTurns: 100 });
    assert.equal(await evidence.captureStep(page, 3), 'step-003.jpg');
    assert.equal(await evidence.captureFinal(page), 'final.jpg');
    assert.equal(await readFile(join(dir, 'step-003.jpg'), 'utf8'), 'jpg');
    assert.equal(await readFile(join(dir, 'final.jpg'), 'utf8'), 'jpg');
    assert.equal(calls[0].type, 'jpeg');
    assert.equal(calls[0].scale, 'css');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('omits screenshot refs when capture fails', async () => {
  const evidence = createEvidenceRecorder('/nope');
  const page = { screenshot: async () => { throw new Error('no shot'); } };
  assert.equal(await evidence.captureStep(page, 1), null);
  assert.equal(await evidence.captureFinal(page), null);
});

test('executor captures step screenshot before running the action', async () => {
  const src = await readFile(new URL('../src/executor.js', import.meta.url), 'utf8');
  const capture = src.indexOf('await addStepScreenshot(entry, evidenceRecorder, page);');
  const actionStart = src.indexOf('const tAction = Date.now();');
  assert.ok(capture > 0);
  assert.ok(capture < actionStart);
});
