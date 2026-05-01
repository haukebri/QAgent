import { createHash } from 'node:crypto';
import { sliceSections } from './snapshot-compress.js';
import { observe } from './tools.js';

// Stable hash of an ariaSnapshot YAML string. Strips refs (Playwright re-numbers
// them deterministically; identical DOM produces identical numbers, but
// stripping makes the predicate robust to incidental renumbering caused by
// unrelated DOM tweaks). Collapses all whitespace runs. Keeps state attributes
// like [expanded], [selected], [checked] so flips count as change.
export function fingerprint(snapshot) {
  if (snapshot == null) return null;
  const normalized = snapshot
    .replace(/\[ref=e\d+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha1').update(normalized).digest('hex');
}

const QUOTED_NAME_RE = /^\s*-\s*\w+\s+"([^"]+)"/gm;
const REF_RE = /\[ref=(e\d+)\]/g;
const HEADING_RE = /^\s*-\s*heading\s+"([^"]+)"/m;

function extractQuotedNames(snapshot) {
  const out = new Set();
  if (!snapshot) return out;
  for (const m of snapshot.matchAll(QUOTED_NAME_RE)) out.add(m[1]);
  return out;
}

function extractRefs(snapshot) {
  const out = new Set();
  if (!snapshot) return out;
  for (const m of snapshot.matchAll(REF_RE)) out.add(m[1]);
  return out;
}

function setDifference(a, b) {
  const out = [];
  for (const v of a) if (!b.has(v)) out.push(v);
  return out;
}

// Pure diff between two ariaSnapshot YAML strings. Returns the structured
// observation fields (excluding settle stats — those come from observeWithSettle).
export function diffSnapshots(prev, next, prevUrl, nextUrl) {
  const fingerprintBefore = fingerprint(prev);
  const fingerprintAfter = fingerprint(next);
  const urlChanged = prevUrl !== nextUrl;
  const snapshotChanged = fingerprintBefore !== fingerprintAfter;
  const deltaChars = (next?.length ?? 0) - (prev?.length ?? 0);

  const prevNames = extractQuotedNames(prev);
  const nextNames = extractQuotedNames(next);
  const addedText = setDifference(nextNames, prevNames);
  const removedText = setDifference(prevNames, nextNames);

  const prevRefs = extractRefs(prev);
  const nextRefs = extractRefs(next);
  const addedRefs = setDifference(nextRefs, prevRefs);
  const removedRefs = setDifference(prevRefs, nextRefs);

  const prevSections = prev ? sliceSections(prev) : [];
  const nextSections = next ? sliceSections(next) : [];
  const prevByRef = new Map();
  for (const s of prevSections) if (s.ref) prevByRef.set(s.ref, s);
  const changedSections = [];
  for (const s of nextSections) {
    if (!s.ref) continue;
    const prevS = prevByRef.get(s.ref);
    if (!prevS) continue;
    if (prevS.sha1 === s.sha1) continue;
    changedSections.push({
      role: s.role,
      ref: s.ref,
      deltaChars: s.text.length - prevS.text.length,
    });
  }

  let summaryTier;
  if (!urlChanged && !snapshotChanged) {
    summaryTier = 'unchanged';
  } else if (
    addedText.length > 8 ||
    removedText.length > 8 ||
    (nextSections.length > 0 && changedSections.length / nextSections.length > 0.5)
  ) {
    summaryTier = 'large';
  } else {
    summaryTier = 'small';
  }

  return {
    fingerprintBefore,
    fingerprintAfter,
    urlChanged,
    snapshotChanged,
    deltaChars,
    changedSections,
    addedText,
    removedText,
    addedRefs,
    removedRefs,
    summaryTier,
  };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function safeObserve(page) {
  try {
    return { snapshot: await observe(page), url: page.url(), ok: true };
  } catch (err) {
    return { snapshot: null, url: null, ok: false, err };
  }
}

// Repeatedly observe until URL+normalized snapshot are stable for `stableSamples`
// consecutive samples, or `maxSettleMs` elapses. Returns the latest sample plus
// the structured diff against `previousSnapshot` / `previousUrl`.
//
// Never throws: a Playwright failure inside the loop returns settled=false with
// whatever sample we last successfully captured.
export async function observeWithSettle(page, prev, opts = {}) {
  const pollMs = opts.pollMs ?? 150;
  const stableSamples = opts.stableSamples ?? 2;
  const maxSettleMs = opts.maxSettleMs ?? 3000;
  // requireChange (terminal-settle opt-in): a sample only counts toward the
  // stability streak when its visible state has departed from the baseline.
  // "Departed" means a different URL, or at least one quoted accessible name
  // added/removed relative to previousSnapshot. Pure structural deltas that
  // produce no text-set change (button [disabled] toggle, focus shift) still
  // hold the streak at 0 — the loop keeps polling until the page has actually
  // moved off the LLM-seen state, or maxSettleMs elapses.
  const requireChange = opts.requireChange ?? false;
  const previousSnapshot = prev?.previousSnapshot ?? null;
  const previousUrl = prev?.previousUrl ?? null;
  const prevFp = previousSnapshot ? fingerprint(previousSnapshot) : null;
  const prevTexts = previousSnapshot ? extractQuotedNames(previousSnapshot) : null;
  const isDeparted = (sample) => {
    if (!requireChange || prevFp == null) return true;
    if (sample.url !== previousUrl) return true;
    if (fingerprint(sample.snapshot) === prevFp) return false;
    const sampleTexts = extractQuotedNames(sample.snapshot);
    for (const t of sampleTexts) if (!prevTexts.has(t)) return true;
    for (const t of prevTexts) if (!sampleTexts.has(t)) return true;
    return false;
  };

  const t0 = Date.now();
  let initialUrl = '';
  try { initialUrl = page.url(); } catch {}
  let last = await safeObserve(page);
  let settled = false;
  let matchStreak = last.ok && isDeparted(last) ? 1 : 0;

  while (true) {
    if (matchStreak >= stableSamples) { settled = true; break; }
    if (Date.now() - t0 >= maxSettleMs) break;
    await sleep(pollMs);
    const cur = await safeObserve(page);
    if (!cur.ok) break;
    if (!last.ok) {
      last = cur;
      matchStreak = isDeparted(cur) ? 1 : 0;
      continue;
    }
    if (cur.url === last.url && fingerprint(cur.snapshot) === fingerprint(last.snapshot)) {
      // Inter-sample stable. Grow streak only if departed from baseline;
      // otherwise we're stable on the LLM-seen state — keep polling.
      if (isDeparted(cur)) matchStreak += 1;
    } else {
      last = cur;
      matchStreak = isDeparted(cur) ? 1 : 0;
    }
  }

  const snapshot = last.snapshot ?? '';
  const url = last.url ?? initialUrl;
  const diff = diffSnapshots(previousSnapshot, snapshot, previousUrl, url);
  return {
    snapshot,
    url,
    settled,
    settleMs: Date.now() - t0,
    ...diff,
  };
}

const VERDICT_DEFAULT_POLL_MS = 250;
const VERDICT_DEFAULT_STABLE_SAMPLES = 3;
const VERDICT_DEFAULT_MAX_SETTLE_MS = 10000;

// Extended assertion-style settle for terminal verification. Wraps
// observeWithSettle with a longer poll, more stable samples, and a wider
// budget — and crucially opts in to requireChange so the gate waits for the
// page to actually depart from the LLM-seen state before declaring stability.
// Without that, a static pre-transition state (form still visible while AJAX
// is in flight) reaches the streak in ~500ms with the wrong snapshot.
export async function observeForVerdict(page, prev, opts = {}) {
  return observeWithSettle(page, prev, {
    pollMs: opts.pollMs ?? VERDICT_DEFAULT_POLL_MS,
    stableSamples: opts.stableSamples ?? VERDICT_DEFAULT_STABLE_SAMPLES,
    maxSettleMs: opts.maxSettleMs ?? VERDICT_DEFAULT_MAX_SETTLE_MS,
    requireChange: opts.requireChange ?? true,
  });
}

const HISTORY_TEXT_CAP = 20;
const HISTORY_REF_CAP = 50;
const PROMPT_TEXT_CAP = 5;
const PROMPT_TEXT_TRUNC = 80;

const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// Strip the heavy fields (raw snapshot, url, fingerprints, full changedSections)
// and apply per-list caps so a single step's observation can't blow up the
// result JSON.
export function compactObservation(obs) {
  if (!obs) return null;
  return {
    settled: obs.settled,
    settleMs: obs.settleMs,
    urlChanged: obs.urlChanged,
    snapshotChanged: obs.snapshotChanged,
    deltaChars: obs.deltaChars,
    summaryTier: obs.summaryTier,
    addedText: obs.addedText.slice(0, HISTORY_TEXT_CAP),
    removedText: obs.removedText.slice(0, HISTORY_TEXT_CAP),
    addedRefs: obs.addedRefs.slice(0, HISTORY_REF_CAP),
    removedRefs: obs.removedRefs.slice(0, HISTORY_REF_CAP),
    changedSectionsCount: obs.changedSections.length,
  };
}

function pickNewHeading(addedText, snapshot) {
  if (snapshot) {
    const m = snapshot.match(HEADING_RE);
    if (m && addedText.includes(m[1])) return m[1];
  }
  if (addedText.length > 0) return addedText[0];
  return null;
}

// One-line action descriptor for the prompt block.
// Examples:
//   "click button 'Submit Inquiry'"
//   "fill textbox 'Email' with \"hauke@…\""
//   "navigate https://example.com"
//   "wait 1500ms"
//   "pressKey Enter"
function describeAction(action, target) {
  switch (action.action) {
    case 'navigate':
      return `navigate ${action.url}`;
    case 'wait':
      return `wait ${action.ms ?? 1000}ms`;
    case 'click':
      return target ? `click ${target}` : `click ref ${action.ref}`;
    case 'fill': {
      const v = typeof action.value === 'string' ? truncate(action.value, 40) : action.value;
      return target ? `fill ${target} with ${JSON.stringify(v)}` : `fill ref ${action.ref}`;
    }
    case 'selectOption':
      return target ? `select ${JSON.stringify(action.value)} in ${target}` : `selectOption ref ${action.ref}`;
    case 'pressKey':
      return action.ref ? `pressKey ${action.key} on ${target ?? `ref ${action.ref}`}` : `pressKey ${action.key}`;
    case 'type': {
      const v = typeof action.value === 'string' ? truncate(action.value, 40) : action.value;
      return target ? `type ${JSON.stringify(v)} into ${target}` : `type ref ${action.ref}`;
    }
    default:
      return action.action;
  }
}

// Format the "Previous action result" block. `entry` is the executor history
// entry for the action whose effects `observation` describes. `snapshot` is
// the post-action snapshot (used to look up a heading line for the large
// tier). `nextUrl` is the post-action URL. Returns a string (no trailing
// newline) or null when no block should be emitted.
export function formatPreviousActionResult(entry, observation, snapshot, nextUrl) {
  if (!entry || !observation) return null;
  const desc = describeAction(entry.action, entry.target);
  const ms = entry.ms ?? 0;

  const lines = [];

  // Wait gets a minimal block — no settle stats line.
  if (entry.action.action === 'wait') {
    lines.push(`Previous action: ${desc}.`);
    appendChangeLines(lines, observation, snapshot, nextUrl);
    return lines.join('\n');
  }

  // Header line. Includes ERROR if the action threw, plus settle status.
  if (entry.error) {
    lines.push(`Previous action: ${desc} — ERROR: ${entry.error}`);
    if (observation.urlChanged || observation.snapshotChanged) {
      lines.push('But the page did change while the action was running:');
    }
  } else {
    const settleNote = observation.settled
      ? `settled in ${observation.settleMs}ms`
      : `did NOT settle within ${observation.settleMs}ms — page still mutating`;
    lines.push(`Previous action: ${desc} (${ms}ms; ${settleNote}).`);
  }

  appendChangeLines(lines, observation, snapshot, nextUrl);
  return lines.join('\n');
}

function appendChangeLines(lines, obs, snapshot, nextUrl) {
  const urlPart = obs.urlChanged
    ? `URL changed → ${truncate(urlPath(nextUrl), 80)}`
    : 'URL unchanged';

  if (obs.summaryTier === 'unchanged') {
    lines.push(`${urlPart}. Page unchanged — action produced no visible state change.`);
    return;
  }

  if (obs.summaryTier === 'small') {
    const sectionPart =
      obs.changedSections.length > 0
        ? `, ${obs.changedSections.length} section${obs.changedSections.length === 1 ? '' : 's'}`
        : '';
    const deltaPart = obs.deltaChars >= 0 ? `+${obs.deltaChars}` : `${obs.deltaChars}`;
    lines.push(`${urlPart}. Page changed (${deltaPart} chars${sectionPart}).`);
    if (obs.addedText.length > 0) {
      lines.push(
        'Added: ' +
          obs.addedText
            .slice(0, PROMPT_TEXT_CAP)
            .map(s => `"${truncate(s, PROMPT_TEXT_TRUNC)}"`)
            .join(', '),
      );
    }
    if (obs.removedText.length > 0) {
      lines.push(
        'Removed: ' +
          obs.removedText
            .slice(0, PROMPT_TEXT_CAP)
            .map(s => `"${truncate(s, PROMPT_TEXT_TRUNC)}"`)
            .join(', '),
      );
    }
    return;
  }

  // tier === 'large'
  lines.push(`${urlPart}. Page largely replaced.`);
  const heading = pickNewHeading(obs.addedText, snapshot);
  lines.push(heading ? `New heading: "${truncate(heading, 80)}"` : '(no new heading)');
  lines.push(
    `+${obs.addedRefs.length} refs, -${obs.removedRefs.length} refs across ${obs.changedSections.length} section${obs.changedSections.length === 1 ? '' : 's'}.`,
  );
}

function urlPath(u) {
  if (!u) return '(unknown)';
  try { return new URL(u).pathname || '/'; } catch { return u; }
}
