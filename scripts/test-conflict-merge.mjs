// Compare and merge a conflict copy (several-vaults ticket 10; src/main/conflict-merge.mjs header).
// Seam: the merge function (kept version + ticked slides of the other → outline text), plus the
// comparison and the Git-marker split it is fed from.
import assert from 'node:assert/strict'

import { compareVersions, listSlides, mergeConflict, splitGitConflict } from '../src/main/conflict-merge.mjs'
import { listSlideBlocks } from '../compiler/scripts/lib/12-outline-edit.mjs'
import { mintId } from '../compiler/scripts/lib/13-slide-ledger.mjs'
import { resolveSlideId } from '../compiler/scripts/lib/slide-id.mjs'

let passed = 0
const test = (name, fn) => { fn(); passed += 1; console.log(`ok  ${name}`) }
const deps = { listSlideBlocks, mintId }
// A fixed sequence for the minter, so re-stamped ids are known.
const seq = (...ids) => { const vals = ids.map((id) => parseInt(id, 36) / 36 ** 5 + 1e-12); let i = 0; return () => vals[i++ % vals.length] }
const merge = (kept, other, pull, rng) => mergeConflict({ kept, other, pull }, { ...deps, ...(rng ? { rng } : {}) })

const MINE = [
  '---', 'title: AI and assessment workshop', '---', '',
  '## Why assessment breaks first {id=aaaaa}', '- Text was scarce', '',
  '## The rubric problem {id=bbbbb}', '- 14 of 20 rubrics', '',
  '## Redesign, not detection {id=ccccc}', '- Detectors guess', '',
  '## Close {id=ddddd}', '- One change', ''
].join('\n')
const AIR = [
  '---', 'title: AI and assessment workshop', '---', '',
  '## Why assessment breaks first {id=aaaaa}', '- Text was scarce', '',
  '## The rubric problem {id=bbbbb}', '- 14 of 20 rubrics; none named process', '',
  '## Redesign the task, not the detector {id=ccccc}', '- Detectors guess', '',
  '## Close {id=ddddd}', '- One change', '',
  '## Added on the Air {id=eeeee}', '- New', ''
].join('\n')

/** The merge only inserts: taking the inserted text out gives `kept` back, byte for byte. */
function assertOnlyInserted(kept, text, inserted) {
  const at = text.indexOf(inserted)
  assert.ok(at >= 0, 'the inserted text is in the result')
  assert.equal(text.slice(0, at) + text.slice(at + inserted.length), kept)
}

test('compare: slides matched by id; the differing and the absent ones are marked', () => {
  const c = compareVersions(MINE, AIR, deps)
  assert.deepEqual(c.a.map((s) => [s.title, s.match, s.differs]), [
    ['Why assessment breaks first', 0, false], ['The rubric problem', 1, true],
    ['Redesign, not detection', 2, true], ['Close', 3, false]
  ])
  assert.deepEqual(c.b.map((s) => [s.match, s.differs]), [[0, false], [1, true], [2, true], [3, false], [-1, true]])
  assert.equal(c.headDiffers, false)
})

test('compare: without ids, slides are matched by heading', () => {
  const a = '## One\nx\n\n## Two\ny\n'
  const b = '## Two\ny changed\n\n## One\nx\n'
  const c = compareVersions(a, b, deps)
  assert.deepEqual(c.b.map((s) => [s.title, s.match, s.differs]), [['Two', 1, true], ['One', 0, false]])
})

test('merge: nothing ticked keeps the kept version exactly', () => {
  assert.equal(merge(MINE, AIR, []).text, MINE)
})

test('merge: a pulled slide goes straight after its counterpart; its colliding id is re-stamped through the minter', () => {
  const r = merge(MINE, AIR, [1], seq('zzzzz'))
  const expected = MINE.replace('- 14 of 20 rubrics\n\n', '- 14 of 20 rubrics\n\n## The rubric problem {id=zzzzz}\n- 14 of 20 rubrics; none named process\n\n')
  assert.equal(r.text, expected)
  assert.deepEqual(r.restamped, [{ from: 'bbbbb', to: 'zzzzz' }])
  assert.deepEqual(r.added, [{ from: 1, after: 1, id: 'zzzzz' }])
  assertOnlyInserted(MINE, r.text, '## The rubric problem {id=zzzzz}\n- 14 of 20 rubrics; none named process\n\n')
})

test('merge: a slide with no counterpart goes at the end, and keeps its own id (no collision)', () => {
  const r = merge(MINE, AIR, [4])
  assert.equal(r.text, MINE + '\n## Added on the Air {id=eeeee}\n- New\n')
  assert.deepEqual(r.restamped, [])
})

test('merge: several ticks keep the other version’s order; the last counterpart’s run comes before the end run', () => {
  const r = merge(MINE, AIR, [4, 2, 1, 3], seq('qqqqq', 'rrrrr', 'sssss'))
  // slide 3 (Close) is identical but ticked: it is still inserted after its counterpart, re-stamped.
  const lines = r.text.split('\n')
  const titles = lines.filter((l) => l.startsWith('## '))
  assert.deepEqual(titles, [
    '## Why assessment breaks first {id=aaaaa}',
    '## The rubric problem {id=bbbbb}', '## The rubric problem {id=qqqqq}',
    '## Redesign, not detection {id=ccccc}', '## Redesign the task, not the detector {id=rrrrr}',
    '## Close {id=ddddd}', '## Close {id=sssss}',
    '## Added on the Air {id=eeeee}'
  ])
  assert.ok(r.text.startsWith(MINE.slice(0, MINE.indexOf('## The rubric problem'))))
  assert.ok(r.text.endsWith('- One change\n\n## Added on the Air {id=eeeee}\n- New\n'))
  // every id in the result is unique
  const ids = [...r.text.matchAll(/\{id=([a-z0-9]+)\}/g)].map((m) => m[1])
  assert.equal(new Set(ids).size, ids.length)
})

test('merge: a re-stamped id is also kept clear of every id in the other version', () => {
  // The minter first offers eeeee (used in AIR only), then yyyyy.
  const r = merge(MINE, AIR, [1], seq('eeeee', 'yyyyy'))
  assert.deepEqual(r.restamped, [{ from: 'bbbbb', to: 'yyyyy' }])
})

test('merge: the id is re-stamped on the line the shared resolver reads (the Trigger line), nothing else moves', () => {
  const kept = '## A\n{layout=cards} {id=aaaaa}\n- one\n'
  const other = '## A\n{layout=cards} {id=aaaaa}\n- one, edited\n'
  const r = merge(kept, other, [0], seq('fffff'))
  assert.equal(r.text, kept + '\n## A\n{layout=cards} {id=fffff}\n- one, edited\n')
  const lines = r.text.split('\n')
  assert.equal(resolveSlideId(lines, 4).id, 'fffff')
  assert.equal(resolveSlideId(lines, 0).id, 'aaaaa')
})

test('merge: kept version otherwise byte-identical — CRLF, no final newline, children, head untouched', () => {
  const kept = '---\r\ntitle: T\r\n---\r\n\r\n## A {id=aaaaa}\r\n- a\r\n### A child {id=bbbbb}\r\n- c\r\n\r\n## B {id=ccccc}\r\n- b'
  const other = '---\ntitle: T (theirs)\n---\n\n## A {id=aaaaa}\n- a2\n### A child {id=bbbbb}\n- c\n\n## B {id=ccccc}\n- b2'
  const r = merge(kept, other, [0, 2], seq('mmmmm', 'nnnnn'))
  // A is followed by its pulled version before its child; B's goes at the end, no final newline added.
  assert.equal(r.text,
    '---\r\ntitle: T\r\n---\r\n\r\n## A {id=aaaaa}\r\n- a\r\n\r\n## A {id=mmmmm}\n- a2\n### A child {id=bbbbb}\r\n- c\r\n\r\n## B {id=ccccc}\r\n- b\n\r\n## B {id=nnnnn}\n- b2')
  assert.ok(compareVersions(kept, other, deps).headDiffers)
})

test('merge: a slide pulled from a kept-theirs merge — the kept is the other file, the pull comes from Mine', () => {
  const r = merge(AIR, MINE, [2], seq('ttttt'))
  assert.ok(r.text.includes('## Redesign the task, not the detector {id=ccccc}\n- Detectors guess\n\n## Redesign, not detection {id=ttttt}\n- Detectors guess\n\n## Close'))
})

test('git markers: both sides split; lines outside the block go to both; a fenced conflict is text', () => {
  const text = '## A\n- same\n<<<<<<< HEAD\n## B {id=bbbbb}\n- mine\n=======\n## B {id=bbbbb}\n- theirs\n>>>>>>> origin/main\n## C\n```\n<<<<<<< x\n=======\n>>>>>>> y\n```\n'
  const s = splitGitConflict(text)
  assert.equal(s.ours, '## A\n- same\n## B {id=bbbbb}\n- mine\n## C\n```\n<<<<<<< x\n=======\n>>>>>>> y\n```\n')
  assert.equal(s.theirs, '## A\n- same\n## B {id=bbbbb}\n- theirs\n## C\n```\n<<<<<<< x\n=======\n>>>>>>> y\n```\n')
  assert.equal(s.oursLabel, 'HEAD')
  assert.equal(s.theirsLabel, 'origin/main')
  assert.equal(splitGitConflict('## A\n=======\n'), null)
})

test('git markers: a diff3 base section goes to neither side; CRLF endings kept', () => {
  const s = splitGitConflict('x\r\n<<<<<<< ours\r\nA\r\n||||||| base\r\nO\r\n=======\r\nB\r\n>>>>>>> theirs\r\ny\r\n')
  assert.equal(s.ours, 'x\r\nA\r\ny\r\n')
  assert.equal(s.theirs, 'x\r\nB\r\ny\r\n')
})

test('listSlides: head is the text before the first slide; ids through the shared resolver', () => {
  const l = listSlides('---\ntitle: T\n---\n\n## A\n{id=aaaaa}\n- a\n\n\n## B\n', deps)
  assert.equal(l.head, '---\ntitle: T\n---')
  assert.deepEqual(l.slides.map((s) => [s.title, s.id, s.text]), [['A', 'aaaaa', '## A\n{id=aaaaa}\n- a'], ['B', null, '## B']])
})

console.log(`\n${passed} passed`)
