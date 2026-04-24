import { createHash } from 'node:crypto';

// Slice an ariaSnapshot YAML string into top-level sections.
//
// Playwright emits indented YAML where landmarks (`- banner`, `- main`,
// `- contentinfo`, …) or a single wrapping `- generic [ref=e1]:` sit at the
// lowest indent, and their contents nest below. We cut at the lowest indent
// level that has ≥2 `- ` siblings — this skips a single wrapping root when
// present and otherwise slices at the outermost level directly.
//
// Returns [{role, ref, startLine, endLine, text, sha1}]. `ref` is null when
// the section header has no [ref=eN] marker.
export function sliceSections(yaml) {
  const lines = yaml.split('\n');
  const dashes = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)-\s/);
    if (m) dashes.push({ idx: i, indent: m[1].length });
  }
  if (dashes.length === 0) return [];

  const countByIndent = new Map();
  for (const d of dashes) countByIndent.set(d.indent, (countByIndent.get(d.indent) ?? 0) + 1);
  const indents = [...countByIndent.keys()].sort((a, b) => a - b);
  let sliceIndent = indents[0];
  for (const ind of indents) {
    if (countByIndent.get(ind) >= 2) { sliceIndent = ind; break; }
  }

  const starts = dashes.filter(d => d.indent === sliceIndent).map(d => d.idx);
  const sections = [];
  if (starts[0] > 0) {
    const text = lines.slice(0, starts[0]).join('\n');
    sections.push({
      role: 'prelude',
      ref: null,
      startLine: 0,
      endLine: starts[0] - 1,
      text,
      sha1: createHash('sha1').update(text).digest('hex'),
    });
  }
  for (let s = 0; s < starts.length; s++) {
    const startLine = starts[s];
    const endLine = (s + 1 < starts.length ? starts[s + 1] - 1 : lines.length - 1);
    const text = lines.slice(startLine, endLine + 1).join('\n');
    const header = lines[startLine];
    const roleMatch = header.match(/^\s*-\s*([A-Za-z][\w-]*)/);
    const refMatch = header.match(/\[ref=(e\d+)\]/);
    sections.push({
      role: roleMatch ? roleMatch[1] : 'unknown',
      ref: refMatch ? refMatch[1] : null,
      startLine,
      endLine,
      text,
      sha1: createHash('sha1').update(text).digest('hex'),
    });
  }
  return sections;
}

// Compress `currentYaml` against a pinned baseline snapshot. Replaces
// byte-identical sections (matched by ref AND sha1) with a one-line comment
// marker, keeping the header verbatim so refs stay resolvable by locator.
//
// Only sections with a non-null ref and size >= 150 bytes are elided — smaller
// sections cost less than a marker line would.
//
// Byte-identity is the safety gate: if bytes match, Playwright's
// deterministic DOM-traversal numbering guarantees the refs inside the
// section are the same numbers as in the baseline, so the LLM can look them
// up in the anchor message.
export function compressAgainstBaseline(currentYaml, baselineYaml, baselineTurn, opts = {}) {
  const minElideBytes = opts.minElideBytes ?? 150;
  const current = sliceSections(currentYaml);
  const baselineByRef = new Map();
  for (const b of sliceSections(baselineYaml)) {
    if (b.ref != null) baselineByRef.set(b.ref, b.sha1);
  }

  const elidedRefs = [];
  const parts = [];
  for (const s of current) {
    const canElide = s.ref != null
      && s.text.length >= minElideBytes
      && baselineByRef.get(s.ref) === s.sha1;
    if (canElide) {
      const headerLine = s.text.split('\n', 1)[0];
      const headerIndent = headerLine.match(/^(\s*)/)[1];
      parts.push(`${headerLine}\n${headerIndent}  # unchanged since turn ${baselineTurn}`);
      elidedRefs.push(s.ref);
    } else {
      parts.push(s.text);
    }
  }
  let text = parts.join('\n');
  if (currentYaml.endsWith('\n') && !text.endsWith('\n')) text += '\n';

  return {
    text,
    stats: {
      origBytes: currentYaml.length,
      compressedBytes: text.length,
      elidedSections: elidedRefs.length,
      elidedRefs,
      totalSections: current.length,
    },
  };
}
