// Replica test for normalizeTriggerLines. The function below MUST match
// src/renderer/src/extensions/outliner.ts verbatim; if that changes, update here.
import { strict as assert } from "node:assert";

// ---- BEGIN MUST-MATCH (copies of fencedLineFlags + normalizeTriggerLines from outliner.ts) ----
const TRIGGER_LINE_RE = /^\s*(\{[^}]*\}\s*)+$/;
const TRAILING_BRACES_RE = /\s*(\{[^}]*\}(?:\s*\{[^}]*\})*)\s*$/;

// Per-line fence + HTML-comment mask — mirrors 12-outline-edit.mjs structuralHeadings.
function fencedLineFlags(lines) {
  const flags = new Array(lines.length).fill(false);
  let inFence = false;
  let fenceMark = '';
  let inComment = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const t = line.trim();
    const visibleAtStart = !inComment;
    if (!inFence) {
      let pos = 0;
      for (;;) {
        if (inComment) {
          const close = line.indexOf('-->', pos);
          if (close === -1) break;
          inComment = false;
          pos = close + 3;
        } else {
          const open = line.indexOf('<!--', pos);
          if (open === -1) break;
          inComment = true;
          pos = open + 4;
        }
      }
    }
    if (!visibleAtStart) { flags[i] = true; continue; }
    if (inFence) {
      flags[i] = true;
      const close = t.match(/^(`{3,})\s*$/);
      if (close && close[1].length >= fenceMark.length) { inFence = false; fenceMark = ''; }
      continue;
    }
    const open = t.match(/^(`{3,})/);
    if (open) { inFence = true; fenceMark = open[1]; flags[i] = true; }
  }
  return flags;
}

function normalizeTriggerLines(text) {
  const lines = text.split('\n');
  const fenced = fencedLineFlags(lines);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const isSlideHeading = !fenced[i] && /^#{2,6} /.test(line);
    if (!isSlideHeading) { out.push(line); i += 1; continue; }
    const m = line.match(TRAILING_BRACES_RE);
    if (!m) { out.push(line); i += 1; continue; }
    const cleanTitle = line.slice(0, line.length - m[0].length);
    const movedGroups = m[1];
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === '') j += 1;
    const existingTrigger =
      j < lines.length && !fenced[j] && lines[j].trim() !== '' && TRIGGER_LINE_RE.test(lines[j]);
    if (existingTrigger) {
      out.push(cleanTitle);
      out.push(movedGroups + lines[j].trim());
      i = j + 1;
    } else {
      out.push(cleanTitle);
      out.push(movedGroups);
      i += 1;
    }
  }
  return out.join('\n');
}
// ---- END MUST-MATCH ----

let n = 0;
const ok = (m) => { n++; console.log("  ok " + m); };

// 1. Trailing single group is moved below the heading.
assert.equal(
  normalizeTriggerLines('### My title {statement}'),
  '### My title\n{statement}'
);
ok("trailing single group → moved below heading");

// 2. Multiple trailing groups are all moved.
assert.equal(
  normalizeTriggerLines('### My title {statement}{title=side}'),
  '### My title\n{statement}{title=side}'
);
ok("multiple trailing groups → all moved below heading");

// 3. Merge with an existing trigger-only line (prepend title groups).
assert.equal(
  normalizeTriggerLines('### My title {statement}{title=side}\n{existing}'),
  '### My title\n{statement}{title=side}{existing}'
);
ok("merge: title groups prepended to existing trigger line");

// 4. Heading with no trailing braces is unchanged.
assert.equal(
  normalizeTriggerLines('### Clean title'),
  '### Clean title'
);
ok("no trailing braces → heading unchanged");

// 5. The deck title (#) is left alone; every slide heading (##–######) is normalized.
assert.equal(
  normalizeTriggerLines('# Title {group}\n## Section {title=side}\n#### Sub {statement}'),
  '# Title {group}\n## Section\n{title=side}\n#### Sub\n{statement}'
);
ok("deck title untouched; ## and #### slide headings normalized");

// 6. Idempotency — running twice gives the same result.
const once = normalizeTriggerLines('### My title {statement}{title=side}');
const twice = normalizeTriggerLines(once);
assert.equal(once, twice);
ok("idempotent: running twice produces identical output");

// 7. Idempotency with merge case.
const mergeOnce = normalizeTriggerLines('### My title {statement}\n{existing}');
const mergeTwice = normalizeTriggerLines(mergeOnce);
assert.equal(mergeOnce, mergeTwice);
ok("idempotent (merge): running twice produces identical output");

// 8. Other lines (blank, bullets, plain text) are preserved exactly.
const mixed = [
  '# Deck title',
  '',
  '## Section',
  '',
  '### Slide one {statement}',
  'Bullet content',
  '',
  '### Slide two',
  '{cards}',
  'More content',
].join('\n');
const normalized = normalizeTriggerLines(mixed);
const expected = [
  '# Deck title',
  '',
  '## Section',
  '',
  '### Slide one',
  '{statement}',
  'Bullet content',
  '',
  '### Slide two',
  '{cards}',
  'More content',
].join('\n');
assert.equal(normalized, expected);
ok("surrounding content preserved; only h3 trailing groups moved");

// 9. Fenced heading-shaped lines are never touched: a `### x {y}` inside a ``` fence is code —
//    its brace groups stay put, and a fenced `{…}` line is never a merge target.
const fencedDoc = [
  '### Real slide {statement}',
  '```',
  '### fake heading {group}',
  '{fenced-trigger}',
  '```',
].join('\n');
assert.equal(
  normalizeTriggerLines(fencedDoc),
  [
    '### Real slide',
    '{statement}',
    '```',
    '### fake heading {group}',
    '{fenced-trigger}',
    '```',
  ].join('\n')
);
ok("fenced heading-like lines untouched; fenced {…} never a merge target");

// 10. Blank-separated legal form: a clean heading + BLANK + {…} trigger line is LEFT AS-IS (the
//     migrate tool produces this shape; it is legal and must never be re-arranged in a churn loop).
assert.equal(
  normalizeTriggerLines('### Clean title\n\n{image-claim} {id=musc1}\n\n- body'),
  '### Clean title\n\n{image-claim} {id=musc1}\n\n- body'
);
ok("blank-separated trigger line under a clean heading is left untouched (legal form)");

// 11. Merge across blanks: braces on the heading merge INTO the blank-separated existing trigger
//     line and the line moves DIRECTLY below the heading — never a duplicate trigger line above it.
assert.equal(
  normalizeTriggerLines('### My title {statement}\n\n{id=musc1}\n\n- body'),
  '### My title\n{statement}{id=musc1}\n\n- body'
);
ok("merge across blanks: no duplicate trigger line, merged line sits directly below heading");

// 12. Idempotency of the blank-separated merge case.
const blankMergeOnce = normalizeTriggerLines('### My title {statement}\n\n{id=musc1}\n\n- body');
assert.equal(normalizeTriggerLines(blankMergeOnce), blankMergeOnce);
ok("idempotent (blank-separated merge): running twice produces identical output");

console.log(`\nnormalize-trigger-lines: all ${n} checks passed`);
