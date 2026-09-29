// One writer for talk files (spec 2026-09-27, D1): the minimal-change dispatch every buffer-first
// mutation of an open talk uses (src/renderer/src/lib/minimalChange.ts → Editor registerReplaceDoc).
// A programmatic rewrite goes into the CodeMirror buffer as ONE replacement of the differing span
// only, so text outside that span — and a caret on it — is untouched, and the rewrite is one
// ordinary undoable step (its inverse restores the old text exactly).
import assert from 'node:assert/strict'
import { applyMinimalChange, minimalChange } from '../src/renderer/src/lib/minimalChange.ts'
import { stampHandoutUrl } from '../src/shared/handout-stamp.ts'

const apply = (doc, ch) => doc.slice(0, ch.from) + ch.insert + doc.slice(ch.to)
const inverse = (doc, ch) => ({ from: ch.from, to: ch.from + ch.insert.length, insert: doc.slice(ch.from, ch.to) })
// Where a caret lands through the change, as CodeMirror maps a selection: unchanged before it,
// shifted after it, and — if it was INSIDE the replaced span — dropped to the span's start.
const mapPos = (ch, pos) => pos <= ch.from ? pos : pos >= ch.to ? pos + ch.insert.length - (ch.to - ch.from) : ch.from

const OUTLINE = [
  '---', 'title: Minimal Talk', '---', '', '# Minimal Talk', '',
  '## Opening {id=aa11}', '', '- one point', '',
  '## Middle {id=bb22}', '', 'Some text the person is typing in.', '',
  '## Last {id=ee55}', '', '- end', '',
].join('\n')

// 1. Nothing to change → no change at all (no dispatch, no history entry, no autosave).
assert.equal(applyMinimalChange(OUTLINE, OUTLINE), null)
assert.deepEqual(minimalChange('same', 'same'), { from: 4, to: 4, insert: '' })

// 2. Every change reproduces `next` exactly and inverts back to `doc` (one undoable step).
const cases = [
  ['', 'new'], ['old', ''], ['abc', 'abXc'], ['abXc', 'abc'], ['aaa', 'aa'], ['aa', 'aaa'],
  ['hello world', 'hello brave world'], ['x\r\ny\r\n', 'x\r\nz\r\ny\r\n'], ['ab', 'ba'],
  [OUTLINE, OUTLINE.replace('- one point', '- one point\n- two points')],
  [OUTLINE, OUTLINE.replace('## Last {id=ee55}', '## Last {id=ee55} {layout=cards}')],
]
let seed = 7
const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n }
for (let i = 0; i < 300; i += 1) {
  const cut = rand(OUTLINE.length), len = rand(12)
  cases.push([OUTLINE, OUTLINE.slice(0, cut) + 'ab\n'.slice(0, rand(4)) + OUTLINE.slice(cut + len)])
}
for (const [doc, next] of cases) {
  const ch = applyMinimalChange(doc, next)
  if (doc === next) { assert.equal(ch, null); continue }
  assert.equal(apply(doc, ch), next, `change reproduces next for ${JSON.stringify([doc.slice(0, 20), next.slice(0, 20)])}`)
  assert.equal(apply(next, inverse(doc, ch)), doc, 'the inverse restores the old text (undo)')
  // Minimal: the kept prefix and suffix cannot grow (the first and last replaced chars differ).
  if (ch.from < ch.to && ch.insert.length > 0) {
    assert.notEqual(doc[ch.from], ch.insert[0], 'prefix is maximal')
    assert.notEqual(doc[ch.to - 1], ch.insert[ch.insert.length - 1], 'suffix is maximal')
  }
}

// 3. The handout stamp touches the frontmatter only: a caret in the body keeps its text, and the
//    body bytes are never part of the replaced span (a whole-document replace would reset both).
{
  const next = stampHandoutUrl(OUTLINE, 'https://talks.example/minimal')
  const ch = applyMinimalChange(OUTLINE, next)
  const bodyStart = OUTLINE.indexOf('# Minimal Talk')
  assert.ok(ch.to <= bodyStart, `the change ends inside the frontmatter (to=${ch.to}, body at ${bodyStart})`)
  const caret = OUTLINE.indexOf('typing in.') // the person's caret, mid-sentence
  const mapped = mapPos(ch, caret)
  assert.equal(next.slice(mapped, mapped + 10), 'typing in.', 'the caret stays on the text it was on')
  assert.equal(applyMinimalChange(next, stampHandoutUrl(next, 'https://talks.example/minimal')), null, 'stamping again changes nothing')
}

// 4. A tag token on one slide: text before and after that slide's line is outside the change.
{
  const next = OUTLINE.replace('## Middle {id=bb22}', '## Middle {id=bb22} {tags=demo}')
  const ch = applyMinimalChange(OUTLINE, next)
  assert.equal(ch.from, OUTLINE.indexOf('{id=bb22}') + '{id=bb22}'.length)
  assert.equal(ch.to, ch.from, 'a pure insertion')
  assert.equal(ch.insert, ' {tags=demo}')
  const caretAfter = OUTLINE.indexOf('- end')
  assert.equal(next.slice(mapPos(ch, caretAfter)).startsWith('- end'), true, 'a caret below the tag keeps its text')
}

// 5. A slide reorder replaces only the span between the first and last differing characters:
//    the frontmatter and everything above the moved slides stay outside the change.
{
  const i = OUTLINE.indexOf('## Last'), j = OUTLINE.indexOf('## Opening')
  const next = OUTLINE.slice(0, j) + OUTLINE.slice(i) + OUTLINE.slice(j, i)
  const ch = applyMinimalChange(OUTLINE, next)
  assert.equal(apply(OUTLINE, ch), next)
  assert.ok(ch.from >= j, 'nothing above the first moved slide is replaced')
}

console.log('minimal change: no-op, exact + invertible changes (fuzzed), frontmatter stamp keeps the body caret, tag insertion, reorder span passed')
