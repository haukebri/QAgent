import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchPage } from '../src/browser.js';
import { observeForVerdict } from '../src/observe-settle.js';

const FIX_DIR = resolve('scripts/verdict-gate-fixtures');
const fileUrl = (name) => pathToFileURL(resolve(FIX_DIR, name)).href;

const failures = [];
const record = (name, ok, detail) => {
  const status = ok ? 'PASS' : 'FAIL';
  console.log(`${status} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures.push(name);
};

async function withPage(fn) {
  const { browser, page } = await launchPage();
  try { return await fn(page); } finally { await browser.close(); }
}

// ---------------- observeForVerdict scenarios ----------------

async function testDelayedSuccess() {
  await withPage(async (page) => {
    await page.goto(fileUrl('delayed-success.html'), { waitUntil: 'load' });
    const before = await page.locator('body').ariaSnapshot({ mode: 'ai' });
    const beforeUrl = page.url();
    // Click without waiting — the success element appears ~2.5s later.
    await page.locator('#submit-btn').click({ timeout: 1000 });
    const t0 = Date.now();
    const r = await observeForVerdict(page, { previousSnapshot: before, previousUrl: beforeUrl });
    const elapsed = Date.now() - t0;
    const sawSuccess = r.addedText.some(t => /Order Confirmed/i.test(t));
    record(
      'delayed-success: gate waits for success element',
      r.settled && sawSuccess && elapsed >= 2000 && elapsed <= 9000,
      `settled=${r.settled} settleMs=${r.settleMs} elapsed=${elapsed} added=${JSON.stringify(r.addedText.slice(0,3))}`,
    );
  });
}

async function testInstantStable() {
  await withPage(async (page) => {
    await page.goto(fileUrl('instant-stable.html'), { waitUntil: 'load' });
    const t0 = Date.now();
    const r = await observeForVerdict(page, { previousSnapshot: null, previousUrl: null });
    const elapsed = Date.now() - t0;
    record(
      'instant-stable: gate exits quickly on a stable page',
      r.settled && elapsed < 2000,
      `settled=${r.settled} settleMs=${r.settleMs} elapsed=${elapsed}`,
    );
  });
}

async function testInfiniteSpinner() {
  await withPage(async (page) => {
    await page.goto(fileUrl('infinite-spinner.html'), { waitUntil: 'load' });
    // Override maxSettleMs to keep the test fast — the signal we want is
    // "loop terminates with settled=false on a chatty page", which a 1500ms
    // budget proves just as well as 10000ms.
    const t0 = Date.now();
    const r = await observeForVerdict(
      page,
      { previousSnapshot: null, previousUrl: null },
      { maxSettleMs: 1500 },
    );
    const elapsed = Date.now() - t0;
    record(
      'infinite-spinner: gate hits maxSettleMs and returns settled=false',
      !r.settled && elapsed >= 1500 && elapsed < 4000,
      `settled=${r.settled} settleMs=${r.settleMs} elapsed=${elapsed}`,
    );
  });
}

async function testNoPriorAction() {
  await withPage(async (page) => {
    await page.goto(fileUrl('no-prior-action.html'), { waitUntil: 'load' });
    // The prev==null path: we pass previousSnapshot/previousUrl as null.
    const r = await observeForVerdict(page, { previousSnapshot: null, previousUrl: null });
    const heading = r.addedText.find(t => /Project Status/i.test(t)) ?? null;
    record(
      'no-prior-action: gate handles prev==null without throwing',
      r.settled && r.snapshot.length > 0 && heading != null,
      `settled=${r.settled} snapshotLen=${r.snapshot.length} heading=${JSON.stringify(heading)}`,
    );
  });
}

// ---------------- findBlockingPriorError scenarios ----------------
// The helper is internal to executor.js. We re-implement it inline here to
// document and lock its contract. If the helper changes, update both
// definitions in lockstep.

function findBlockingPriorError({ history, warnings, turns }) {
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry.action?.action === 'done') continue;
    if (entry.ms == null) continue;
    if (entry.error) {
      const obs = entry.observation;
      const meaningfulChange =
        obs && (obs.urlChanged || obs.snapshotChanged || (obs.addedText && obs.addedText.length > 0));
      if (meaningfulChange) return null;
      warnings.push(`rejected at turn ${turns}: ${entry.error}`);
      return `Your previous action did not succeed: ${entry.error}. Resolve the failure or fail with a reason.`;
    }
    break;
  }
  return null;
}

function testGuardAdmitsErrorWithMeaningfulChange() {
  const history = [{
    turn: 13,
    action: { action: 'click', ref: 'e379' },
    target: "button 'Submit Inquiry'",
    ms: 2050,
    url: 'https://example.com/form',
    error: 'locator.click: Timeout 2000ms exceeded',
    observation: {
      settled: true, settleMs: 200,
      urlChanged: false, snapshotChanged: true,
      summaryTier: 'large',
      addedText: [], removedText: ['Agency Project Inquiry', 'Name (Required)'],
      addedRefs: [], removedRefs: ['e379', 'e261'],
      changedSectionsCount: 5,
    },
  }];
  const warnings = [];
  const result = findBlockingPriorError({ history, warnings, turns: 14 });
  record(
    'guard admits done after stale-ref click that replaced the page',
    result === null && warnings.length === 0,
    `result=${result === null ? 'null' : 'string'} warnings=${warnings.length}`,
  );
}

function testGuardRejectsErrorWithNoChange() {
  const history = [{
    turn: 5,
    action: { action: 'click', ref: 'e10' },
    target: "button 'Save'",
    ms: 2050,
    url: 'https://example.com/x',
    error: 'locator.click: Timeout 2000ms exceeded',
    observation: {
      settled: true, settleMs: 200,
      urlChanged: false, snapshotChanged: false,
      summaryTier: 'unchanged',
      addedText: [], removedText: [],
      addedRefs: [], removedRefs: [],
      changedSectionsCount: 0,
    },
  }];
  const warnings = [];
  const result = findBlockingPriorError({ history, warnings, turns: 6 });
  record(
    'guard rejects done after errored click with no observable change',
    typeof result === 'string' && warnings.length === 1,
    `result=${typeof result} warnings=${warnings.length}`,
  );
}

function testGuardSkipsParseError() {
  // performed action 1: success, no error, observation present
  // entry 2: parse-error (no ms, no action.action, has error)
  // The guard should walk past the parse-error and admit done based on entry 1.
  const history = [
    {
      turn: 1,
      action: { action: 'click', ref: 'e1' },
      ms: 100,
      url: 'https://x/',
      observation: {
        settled: true, settleMs: 100,
        urlChanged: false, snapshotChanged: true,
        summaryTier: 'small',
        addedText: ['ok'], removedText: [],
        addedRefs: [], removedRefs: [],
        changedSectionsCount: 1,
      },
    },
    { turn: 2, error: 'your previous response was not valid JSON', url: 'https://x/' },
  ];
  const warnings = [];
  const result = findBlockingPriorError({ history, warnings, turns: 3 });
  record(
    'guard skips parse-error entries (no ms) and admits done',
    result === null && warnings.length === 0,
    `result=${result === null ? 'null' : 'string'}`,
  );
}

function testGuardSkipsRefMiss() {
  // entry 1: click ref-miss (action set, error set, no ms, no observation)
  // The guard should keep walking; no earlier performed action means admit.
  const history = [
    { turn: 1, action: { action: 'click', ref: 'e999' }, error: 'ref e999 is not present', url: 'https://x/' },
  ];
  const warnings = [];
  const result = findBlockingPriorError({ history, warnings, turns: 2 });
  record(
    'guard skips ref-miss entries (no ms) and admits done',
    result === null && warnings.length === 0,
    `result=${result === null ? 'null' : 'string'}`,
  );
}

// ---------------- runner ----------------

const all = [
  testDelayedSuccess,
  testInstantStable,
  testInfiniteSpinner,
  testNoPriorAction,
  testGuardAdmitsErrorWithMeaningfulChange,
  testGuardRejectsErrorWithNoChange,
  testGuardSkipsParseError,
  testGuardSkipsRefMiss,
];

for (const fn of all) {
  try { await fn(); }
  catch (err) {
    record(fn.name, false, `threw: ${err.message?.split('\n')[0]}`);
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nAll verdict-gate scenarios passed.');
