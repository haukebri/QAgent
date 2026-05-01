import { createHash } from 'node:crypto';
import { sliceSections } from './snapshot-compress.js';

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
