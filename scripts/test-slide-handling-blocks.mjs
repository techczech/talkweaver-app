// Slide handling ticket 1a: moveBlocks, the one multi-block move (src/shared/slide-handling/blocks.ts). Table tests.
// Every applied case also asserts conservation: the sorted lines before == the sorted lines after.
import { strict as assert } from 'node:assert'
import {
  copyBlocks, cutBlocks, refHolds, isSoundCut, isSoundMove, minimalChange, moveBlocks, refAt, stepPlace, MOVE_CAPTURE, MOVE_INTO_ITSELF, MOVE_UNSAFE, MOVE_NOTHING, MOVE_PLACE_GONE, MOVE_STALE, CUT_TITLE
} from '../src/shared/slide-handling/blocks.ts'
import { pasteSlides } from '../src/shared/slide-handling/slide-block-ops.ts'

let cases = 0
const J = (...lines) => lines.join('\n')
const lineOf = (text, heading) => {
  const i = text.split('\n').indexOf(heading)
  assert(i >= 0, `fixture has ${JSON.stringify(heading)}`)
  return i + 1
}
const ref = (text, heading) => ({ line: lineOf(text, heading), headingText: heading })
const place = (kind, text, heading) => ({ kind, line: lineOf(text, heading), title: heading.replace(/^#+\s*/, '').replace(/\{[^}]*\}/g, '').trim() })
const headings = (text) => text.split('\n').filter((l) => /^#{1,6}\s/.test(l))
const sorted = (t) => t.split('\n').sort().join('\n')
const applied = (before, result, label) => {
  assert(!('refused' in result), `${label}: applied (${result.refused})`)
  assert.equal(sorted(result.text), sorted(before), `${label}: same lines`)
  const { from, to, insert } = result.changes
  assert.equal(before.slice(0, from) + insert + before.slice(to), result.text, `${label}: the change gives the text`)
  cases += 1
  return result
}
const refused = (before, result, reason, label) => {
  assert('refused' in result, `${label}: refused`)
  if (reason) assert.equal(result.refused, reason, label)
  cases += 1
}

const TALK = J(
  '# Talk', '',
  '## One', '',
  '### A {id=a}', 'body A', '',
  '### B', 'body B', '',
  '#### B1', 'deep B1', '',
  '## Two', '',
  '### C', 'body C', '',
  '### D', 'body D', '',
  '## Three', '',
  '### E', 'body E', ''
)

// ── non-contiguous move: A and C after E, talk order kept ──
{
  const r = applied(TALK, moveBlocks(TALK, [ref(TALK, '### C'), ref(TALK, '### A {id=a}')], place('after', TALK, '### E')), 'non-contiguous')
  assert.deepEqual(headings(r.text), ['# Talk', '## One', '### B', '#### B1', '## Two', '### D', '## Three', '### E', '### A {id=a}', '### C'])
  assert.deepEqual(r.movedRanges.map((m) => r.text.split('\n')[m.line - 1]), ['### A {id=a}', '### C'], 'moved ranges in talk order')
  for (const m of r.movedRanges) assert(m.endLine > m.line)
}

// ── a slide with its children moves whole; before a card ──
{
  const r = applied(TALK, moveBlocks(TALK, [ref(TALK, '### B')], place('before', TALK, '### D')), 'subtree before')
  assert.deepEqual(headings(r.text), ['# Talk', '## One', '### A {id=a}', '## Two', '### C', '### B', '#### B1', '### D', '## Three', '### E'])
}

// ── section move: section Three with its slides to before section One ──
{
  const r = applied(TALK, moveBlocks(TALK, [ref(TALK, '## Three')], place('before', TALK, '## One')), 'section move')
  assert.deepEqual(headings(r.text), ['# Talk', '## Three', '### E', '## One', '### A {id=a}', '### B', '#### B1', '## Two', '### C', '### D'])
}

// ── nested ref collapse: section Two and its own slide D selected → the section moves once ──
{
  const r = applied(TALK, moveBlocks(TALK, [ref(TALK, '### D'), ref(TALK, '## Two')], place('after', TALK, '## Three')), 'nested collapse')
  assert.deepEqual(headings(r.text), ['# Talk', '## One', '### A {id=a}', '### B', '#### B1', '## Three', '### E', '## Two', '### C', '### D'])
  assert.equal(r.movedRanges.length, 1, 'one moved block')
}

// ── into own subtree: refused, text unchanged ──
refused(TALK, moveBlocks(TALK, [ref(TALK, '## Two')], place('after', TALK, '### C')), MOVE_INTO_ITSELF, 'into own subtree')
refused(TALK, moveBlocks(TALK, [ref(TALK, '## Two')], place('endOfSection', TALK, '## Two')), MOVE_INTO_ITSELF, 'into itself')
refused(TALK, moveBlocks(TALK, [ref(TALK, '### B')], place('before', TALK, '#### B1')), MOVE_INTO_ITSELF, 'before own child')

// ── stale heading: the line no longer holds that heading → refused ──
refused(TALK, moveBlocks(TALK, [{ line: lineOf(TALK, '### C'), headingText: '### Something else' }], place('after', TALK, '### E')), MOVE_STALE, 'stale heading')
refused(TALK, moveBlocks(TALK, [{ line: lineOf(TALK, '### C') + 1, headingText: '### C' }], place('after', TALK, '### E')), MOVE_STALE, 'line moved')
refused(TALK, moveBlocks(TALK, [{ line: 999, headingText: '### C' }], place('after', TALK, '### E')), MOVE_STALE, 'line out of range')
// An id stamped on the heading since the drag started is the same heading.
applied(TALK, moveBlocks(TALK, [{ line: lineOf(TALK, '### A {id=a}'), headingText: '### A' }], place('after', TALK, '### B')), 'id stamped since')

// ── place gone ──
refused(TALK, moveBlocks(TALK, [ref(TALK, '### A {id=a}')], { kind: 'after', line: 3, title: 'Nowhere' }), MOVE_PLACE_GONE, 'place gone')

// ── already there → refused, nothing changed ──
refused(TALK, moveBlocks(TALK, [ref(TALK, '### A {id=a}')], place('before', TALK, '### B')), MOVE_NOTHING, 'already there')

// ── end of section, start of talk ──
{
  const r = applied(TALK, moveBlocks(TALK, [ref(TALK, '### A {id=a}')], place('endOfSection', TALK, '## Two')), 'end of section')
  assert.deepEqual(headings(r.text), ['# Talk', '## One', '### B', '#### B1', '## Two', '### C', '### D', '### A {id=a}', '## Three', '### E'])
  // Fix round 1 (F2): this case used [## Two, ### E], which put E under section Two (a capture); now refused below.
  const s = applied(TALK, moveBlocks(TALK, [ref(TALK, '## Two'), ref(TALK, '## Three')], { kind: 'start' }), 'start of talk')
  assert.deepEqual(headings(s.text), ['# Talk', '## Two', '### C', '### D', '## Three', '### E', '## One', '### A {id=a}', '### B', '#### B1'])
  refused(TALK, moveBlocks(TALK, [ref(TALK, '## Two'), ref(TALK, '### E')], { kind: 'start' }), MOVE_CAPTURE, 'start of talk, section + later slide: E would join the section')
}

// ── last line without a trailing newline: no glued lines, same lines ──
{
  const t = J('# Talk', '', '### A', 'body A', '', '### B', 'body B', '', '### C', 'body C')
  const r = applied(t, moveBlocks(t, [ref(t, '### C')], place('before', t, '### A')), 'last block, no final newline')
  assert.deepEqual(headings(r.text), ['# Talk', '### C', '### A', '### B'])
  assert(!r.text.includes('body B### '), 'nothing glued')
  assert(r.text.split('\n').every((l, i, all) => !/^#{1,6}\s/.test(l) || i === 0 || all[i - 1].trim() === ''), 'every heading after a blank line')
  const back = applied(t, moveBlocks(t, [ref(t, '### A')], place('after', t, '### C')), 'to the end, no final newline')
  assert.deepEqual(headings(back.text), ['# Talk', '### B', '### C', '### A'])
  assert(!back.text.endsWith('\n'), 'the file still ends without a newline')
}

// ── a fenced `### not a heading` never counts ──
{
  const t = J('# Talk', '', '### A', '```md', '### fenced', '```', '', '### B', 'body', '')
  const r = applied(t, moveBlocks(t, [ref(t, '### B')], place('before', t, '### A')), 'fence travels with its slide')
  assert.deepEqual(r.text.split('\n').slice(2, 4), ['### B', 'body'])
  refused(t, moveBlocks(t, [{ line: lineOf(t, '### fenced'), headingText: '### fenced' }], place('after', t, '### B')), MOVE_STALE, 'a fenced line is not a heading')
}

// ── conservation over every pair of blocks and every place kind ──
{
  const heads = headings(TALK).filter((h) => !h.startsWith('# '))
  let tried = 0
  for (const a of heads) for (const b of heads) for (const kind of ['before', 'after', 'endOfSection']) {
    const r = moveBlocks(TALK, [ref(TALK, a), ref(TALK, b)], place(kind, TALK, b === a ? '## Three' : b))
    tried += 1
    if (!('refused' in r)) assert.equal(sorted(r.text), sorted(TALK), `conservation ${a} ${kind} ${b}`)
  }
  assert(tried > 50)
  cases += 1
}

// ── stepPlace / refAt / minimalChange ──
{
  assert.deepEqual(stepPlace(TALK, lineOf(TALK, '### C'), 'up'), place('before', TALK, '### B'))
  assert.deepEqual(stepPlace(TALK, lineOf(TALK, '### C'), 'down'), place('after', TALK, '### D'))
  assert.deepEqual(stepPlace(TALK, lineOf(TALK, '## One'), 'down'), place('after', TALK, '## Two'))
  assert.equal(stepPlace(TALK, lineOf(TALK, '## One'), 'up'), null)
  assert.deepEqual(refAt(TALK, lineOf(TALK, '### C')), { line: lineOf(TALK, '### C'), headingText: '### C' })
  assert.equal(refAt(TALK, 2), null)
  assert.deepEqual(minimalChange('abcXdef', 'abcYYdef'), { from: 3, to: 4, insert: 'YY' })
  cases += 1
}

// ── cutBlocks / copyBlocks (ticket 1b): several blocks, one change, talk order, nothing lost ──
{
  const T = J('# T', '', '## One', '', '### A', 'a', '', '### B', 'b', '', '## Two', '', '### C', 'c', '', '### D', 'd', '')
  const nonBlank = (t) => t.split('\n').filter((l) => l.trim()).sort().join('\n')
  // non-contiguous: A and D, selected out of order; the clip is in talk order
  const cut = cutBlocks(T, [ref(T, '### D'), ref(T, '### A')])
  assert(!('refused' in cut))
  assert.equal(cut.count, 2)
  assert.equal(cut.clip, J('### A', 'a', '', '### D', 'd', ''))
  assert(!cut.text.includes('### A') && !cut.text.includes('### D') && cut.text.includes('### B') && cut.text.includes('### C'))
  assert.equal(nonBlank(cut.text + '\n' + cut.clip), nonBlank(T))
  assert.equal(T.slice(0, cut.changes.from) + cut.changes.insert + T.slice(cut.changes.to), cut.text)
  cases += 1
  // a section and its own child selected: the section once
  const nested = cutBlocks(T, [ref(T, '## One'), ref(T, '### A')])
  assert(!('refused' in nested) && nested.count === 1 && nested.clip.startsWith('## One') && nested.clip.includes('### B') && !nested.text.includes('One'))
  cases += 1
  // the clip pastes back whole: cut everything under Two then compare with copyBlocks of the same refs
  const copy = copyBlocks(T, [ref(T, '### A'), ref(T, '### D')])
  assert(!('refused' in copy) && copy.clip === cut.clip && copy.count === 2)
  cases += 1
  // refusals: stale ref, the talk's title; nothing applied
  refused(T, cutBlocks(T, [{ line: lineOf(T, '### A'), headingText: '### Z' }]), MOVE_STALE, 'cut stale')
  refused(T, cutBlocks(T, [ref(T, '# T')]), CUT_TITLE, 'cut title')
  refused(T, cutBlocks(T, []), MOVE_NOTHING, 'cut nothing')
  assert('refused' in copyBlocks(T, [{ line: 99, headingText: '### A' }]))
  // the last block of a talk with no final newline
  const NF = J('# T', '', '## One', '', '### A', 'a', '', '### B', 'b')
  const last = cutBlocks(NF, [ref(NF, '### B'), ref(NF, '### A')])
  assert(!('refused' in last) && last.count === 2 && nonBlank(last.text + '\n' + last.clip) === nonBlank(NF))
  cases += 1
}

// ── Fix round 1 ──
// F1: a ref carries the heading the CARD shows. When the buffer line it points at (an id-less heading's stale line,
// text typed above it since the compile) holds another heading, the move is refused, never applied to that block.
{
  const typed = J('# Talk', '', '## One', '', '### New typed above', 'x', '', '### A', 'body A', '', '### B', 'body B', '')
  const staleLine = 5 // where "### A" was at the compile; the buffer now has "### New typed above" there
  refused(typed, moveBlocks(typed, [{ line: staleLine, headingText: '### A' }], place('after', typed, '### B')), MOVE_STALE, 'F1 card heading not at its line')
  refused(typed, cutBlocks(typed, [{ line: staleLine, headingText: '### A' }]), MOVE_STALE, 'F1 cut: card heading not at its line')
  // A section card whose row carries only its title matches on the title.
  applied(TALK, moveBlocks(TALK, [{ line: lineOf(TALK, '## Three'), headingText: 'Three' }], place('before', TALK, '## One')), 'F1 bare section title')
}
// F3: the heading's level is part of the match.
refused(TALK, moveBlocks(TALK, [{ line: lineOf(TALK, '### C'), headingText: '## C' }], place('after', TALK, '### E')), MOVE_STALE, 'F3 same title, other level')
refused(TALK, cutBlocks(TALK, [{ line: lineOf(TALK, '### C'), headingText: '#### C' }]), MOVE_STALE, 'F3 cut: same title, other level')
// F2: a block never adopts the deeper headings after it.
refused(TALK, moveBlocks(TALK, [ref(TALK, '## Three')], place('after', TALK, '### C')), MOVE_CAPTURE, 'F2 section after a mid-section slide')
refused(TALK, moveBlocks(TALK, [ref(TALK, '## Three')], place('before', TALK, '### D')), MOVE_CAPTURE, 'F2 section before a slide')
refused(TALK, moveBlocks(TALK, [ref(TALK, '### A {id=a}'), ref(TALK, '## Three')], place('after', TALK, '### C')), MOVE_CAPTURE, 'F2 mixed ### + ## group into a section')
refused(TALK, moveBlocks(TALK, [ref(TALK, '### A {id=a}')], place('before', TALK, '#### B1')), MOVE_CAPTURE, 'F2 slide before a deeper slide would adopt it')
{
  const r = applied(TALK, moveBlocks(TALK, [ref(TALK, '## Three')], place('after', TALK, '## One')), 'F2 section between sections')
  assert.deepEqual(headings(r.text), ['# Talk', '## One', '### A {id=a}', '### B', '#### B1', '## Three', '### E', '## Two', '### C', '### D'])
  const m = applied(TALK, moveBlocks(TALK, [ref(TALK, '### A {id=a}'), ref(TALK, '## Three')], place('endOfSection', TALK, '## Two')), 'F2 mixed group at a section end')
  assert.deepEqual(headings(m.text), ['# Talk', '## One', '### B', '#### B1', '## Two', '### C', '### D', '### A {id=a}', '## Three', '### E'])
}
// F7: the soundness check refuses crafted wrong results, and passes the real ones.
{
  const T = J('# T', '', '### A', 'a', '', '### B', 'b', '', '### C', 'c', '', '### D', 'd', '')
  const B = { line: 6, endLine: 9 }
  const good = moveBlocks(T, [ref(T, '### B')], place('after', T, '### C'))
  assert(!('refused' in good))
  assert(isSoundMove(T, good.text, [B], 12 - 1, good.movedRanges.map((r) => r.line)), 'real move is sound')
  // Same lines (sorted equal), but the unmoved A and C swapped: the old conservation check passed this.
  const swapped = J('# T', '', '### C', 'c', '', '### A', 'a', '', '### B', 'b', '', '### D', 'd', '')
  assert.equal(sorted(swapped), sorted(T))
  assert(!isSoundMove(T, swapped, [B], 11, [9]), 'rest out of order refused')
  // The moved block's body split from its heading (lines kept, block not contiguous).
  const split = J('# T', '', '### A', 'a', '', '### C', '### B', 'c', '', 'b', '', '### D', 'd', '')
  assert(!isSoundMove(T, split, [B], 11, [7]), 'moved block not contiguous refused')
  // Right shape but at the wrong place (after D instead of after C).
  const wrongPlace = J('# T', '', '### A', 'a', '', '### C', 'c', '', '### D', 'd', '', '### B', 'b', '')
  assert(!isSoundMove(T, wrongPlace, [B], 11, [12]), 'wrong place refused')
  // Two blocks out of talk order.
  const A = { line: 3, endLine: 6 }
  const twoGood = moveBlocks(T, [ref(T, '### A'), ref(T, '### B')], place('after', T, '### D'))
  assert(!('refused' in twoGood) && isSoundMove(T, twoGood.text, [A, B], 15, twoGood.movedRanges.map((r) => r.line)))
  const twoSwapped = J('# T', '', '### C', 'c', '', '### D', 'd', '', '### B', 'b', '', '### A', 'a', '')
  assert(!isSoundMove(T, twoSwapped, [A, B], 15, [12, 9]), 'blocks out of talk order refused')
  // cut: the rest must keep its order.
  const cut = cutBlocks(T, [ref(T, '### B')])
  assert(!('refused' in cut) && isSoundCut(T, cut.text, [B]))
  assert(!isSoundCut(T, J('# T', '', '### C', 'c', '', '### A', 'a', '', '### D', 'd', ''), [B]), 'cut rest out of order refused')
  assert(!isSoundCut(T, J('# T', '', '### A', 'a', '', '### C', 'c', ''), [B]), 'cut lost a block refused')
  cases += 1
  assert.equal(typeof MOVE_UNSAFE, 'string')
}

// Fix round 2 (R4): a multi-block clip of mixed levels (a section and a slide from another section) pastes whole and
// in talk order, at the end and after a heading; nothing lost, nothing added. (Read as text, the slide that follows
// the section's slides in the clip is under that section after the paste: the clip carries no other structure.)
{
  const T = J('# T', '', '## One', '', '### A', 'a', '', '### B', 'b', '', '## Two', '', '### C', 'c', '', '### D', 'd', '')
  const cut = cutBlocks(T, [ref(T, '### D'), ref(T, '## One')])
  assert(!('refused' in cut) && cut.count === 2)
  assert.equal(cut.clip, J('## One', '', '### A', 'a', '', '### B', 'b', '', '### D', 'd', ''), 'the clip: both blocks whole, talk order, a blank line between')
  const nonBlank = (t) => t.split('\n').filter((l) => l.trim()).sort().join('\n')
  let n = 0
  for (const at of ['end', { after: lineOf(cut.text, '## Two') }, { before: lineOf(cut.text, '## Two') }]) {
    const r = pasteSlides(cut.text, cut.clip, at, () => 'minted' + (n += 1))
    assert(r, `pasted at ${JSON.stringify(at)}`)
    assert(r.text.includes(J('## One', '', '### A', 'a', '', '### B', 'b', '', '### D', 'd')), `whole and in order at ${JSON.stringify(at)}`)
    assert.equal(nonBlank(r.text), nonBlank(T), `the same lines as before the cut at ${JSON.stringify(at)}`)
  }
  cases += 1
}

// Fix round 2 (R1): refHolds, the host's check before a paste after a card: the same rule as moveBlocks' ref check.
assert.equal(refHolds(TALK, ref(TALK, '### C')), true)
assert.equal(refHolds(TALK, { line: lineOf(TALK, '### C'), headingText: '### D' }), false, 'another heading there')
assert.equal(refHolds(TALK, { line: lineOf(TALK, '### C'), headingText: '## C' }), false, 'another level')
assert.equal(refHolds(TALK, { line: lineOf(TALK, '### C') + 1, headingText: '### C' }), false, 'not a heading line')
assert.equal(refHolds(TALK, { line: lineOf(TALK, '## Two'), headingText: 'Two' }), true, 'a bare section title')
cases += 1

console.log(`slide-handling blocks: ${cases} cases passed`)
