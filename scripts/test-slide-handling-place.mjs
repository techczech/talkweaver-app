// Slide handling ticket 1a: the one placement rule (src/shared/slide-handling/place.ts). Table tests of the place
// kinds the Scratchpad did not have (before, end of section) and of the names the Scratchpad re-exports.
// The Scratchpad's own cases stay in scripts/test-scratchpad-insert.mjs, unmodified.
import { strict as assert } from 'node:assert'
import { insertionPoint, placeForLine, resolvePlace, settlePlace, PLACE_GONE } from '../src/shared/slide-handling/place.ts'
import * as scratch from '../src/shared/scratchpad-insert.ts'

let cases = 0
const J = (...lines) => lines.join('\n')
const TALK = J(
  '# Talk', '',
  '## One', '',
  '### A', 'body A', '',
  '### B', 'body B', '',
  '## Two', '',
  '### C', 'body C', '',
  '#### C1', 'deep', ''
)
const lineOf = (heading) => TALK.split('\n').indexOf(heading) + 1

// ── the Scratchpad's names are the same functions ──
for (const name of ['insertionPoint', 'placeForLine', 'resolvePlace', 'settlePlace', 'placeRows', 'headingTitle']) {
  assert.equal(typeof scratch[name], 'function', name)
}
assert.equal(scratch.insertionPoint, insertionPoint, 'one insertionPoint')
assert.equal(scratch.PLACE_GONE, PLACE_GONE)
cases += 1

// ── resolvePlace keeps the kind ──
{
  assert.deepEqual(resolvePlace(TALK, { kind: 'before', line: lineOf('### B'), title: 'B' }), { kind: 'before', index: lineOf('### B') - 1 })
  assert.deepEqual(resolvePlace(TALK, { kind: 'endOfSection', line: lineOf('## Two'), title: 'Two' }), { kind: 'endOfSection', index: lineOf('## Two') - 1 })
  // Moved by an edit: found by title, nearest the old line.
  assert.deepEqual(resolvePlace(TALK, { kind: 'before', line: 1, title: 'C' }), { kind: 'before', index: lineOf('### C') - 1 })
  assert.equal(resolvePlace(TALK, { kind: 'endOfSection', line: 3, title: 'Gone' }), null)
  cases += 1
}

// ── insertionPoint: before a heading takes its line and level ──
{
  const p = insertionPoint(TALK, { kind: 'before', line: lineOf('### B'), title: 'B' })
  assert.deepEqual(p, { ok: true, at: lineOf('### B') - 1, offset: TALK.split('\n').slice(0, lineOf('### B') - 1).join('\n').length + 1, level: 3 })
  cases += 1
}

// ── insertionPoint: end of section is after every slide under it, at its children's level ──
{
  const p = insertionPoint(TALK, { kind: 'endOfSection', line: lineOf('## One'), title: 'One' })
  assert(p.ok)
  assert.equal(p.at, lineOf('body B'), 'after body B, before the blank line that ends the section')
  assert.equal(p.level, 3)
  const q = insertionPoint(TALK, { kind: 'endOfSection', line: lineOf('## Two'), title: 'Two' })
  assert(q.ok)
  assert.equal(q.at, lineOf('deep'), 'past the nested slide, at the end of the talk')
  assert.equal(q.level, 3)
  const empty = J('# T', '', '## Lonely', '', '## Next', '')
  const r = insertionPoint(empty, { kind: 'endOfSection', line: 3, title: 'Lonely' })
  assert(r.ok)
  assert.equal(r.at, 3)
  assert.equal(r.level, 3, 'a section with nothing under it takes a level one deeper')
  cases += 1
}

// ── settlePlace keeps the kind of the place it follows ──
{
  const chosen = { kind: 'endOfSection', line: lineOf('## Two'), title: 'Two' }
  const shifted = J('Intro line', TALK)
  const s = settlePlace(shifted, chosen, [])
  assert.deepEqual(s.place, { kind: 'endOfSection', line: lineOf('## Two') + 1, title: 'Two' })
  assert.equal(settlePlace(TALK, chosen, []).place, chosen, 'unchanged: the same object')
  assert.deepEqual(settlePlace(J('# Talk', ''), chosen, []), { place: null, earlier: [] })
  cases += 1
}

// ── placeForLine still names only start and after ──
assert.deepEqual(placeForLine(TALK, lineOf('body B')), { kind: 'after', line: lineOf('### B'), title: 'B' })
assert.deepEqual(placeForLine(TALK, 1), { kind: 'start' })
cases += 1

console.log(`slide-handling place: ${cases} cases passed`)
