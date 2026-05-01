import { createHash } from 'node:crypto';

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
