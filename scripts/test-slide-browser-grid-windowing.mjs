// Tests for the Slide Browser's windowing layout (src/renderer/src/components/slide-browser/gridWindowing.ts):
// results → lines (headings, card rows, the open expansion) → offsets → the visible range, the
// measured-height cache across a resize, and the scroll target for the focused card. Imports the REAL
// module (Node strips erasable TypeScript natively).
import { strict as assert } from 'node:assert'
import {
  COL_GAP, GROUP_GAP, ROW_GAP, SECTION_GAP, anchorFor, anchorShift, buildGridLines, createMeasureCache, estimateBody,
  layoutLines, lineHeight, lineOfPositions, recordMeasure, scrollTargetFor, visibleRange
} from '../src/renderer/src/components/slide-browser/gridWindowing.ts'

let checks = 0
const check = (name, fn) => { fn(); checks++; console.log(`  ✓ ${name}`) }
const card = (slug, i) => ({ row: { talkSlug: slug, slide_id: `${slug}-${i}`, order: i }, kind: 'single' })
const group = (slug, section, n) => ({ talkSlug: slug, talkTitle: slug.toUpperCase(), section, units: n, cards: Array.from({ length: n }, (_v, i) => card(slug, i)) })
const grouped = (groups, cols, expandedPos = -1) => buildGridLines({
  mode: 'grouped', groups, groupTotals: new Map(), cols, expandedPos,
  groupKey: (g) => `${g.talkSlug}\n${g.section}`, secName: (_k, f) => f.toUpperCase()
})
const fixed = (h) => () => h

check('grouped: a heading per group, then rows of `cols` cards; positions run on across groups', () => {
  const lines = grouped([group('a', 'intro', 5), group('b', '', 3)], 3)
  assert.deepEqual(lines.map((l) => l.kind), ['group-head', 'row', 'row', 'group-head', 'row'])
  assert.deepEqual(lines.filter((l) => l.kind === 'row').map((l) => [l.base, l.cards.length]), [[0, 3], [3, 2], [5, 3]])
  assert.equal(lines[0].sectionLabel, 'INTRO', 'the section label comes from secName')
  assert.equal(lines[3].sectionLabel, '', 'no section, no label')
  assert.equal(lines[0].countLabel, '5 shown')
})

check('grouped: rows are spaced by the row gap; a group ends with the group gap', () => {
  const lines = grouped([group('a', 's', 7)], 4)
  const rows = lines.filter((l) => l.kind === 'row')
  assert.deepEqual(rows.map((l) => l.after), [ROW_GAP[4], GROUP_GAP])
  assert.equal(lines[0].after, 0, 'a heading carries its own margin inside its line')
})

check('the expansion line follows the row holding the expanded card', () => {
  const lines = grouped([group('a', 's', 7)], 3, 4) // position 4 is in the second row (3..5)
  assert.deepEqual(lines.map((l) => l.kind), ['group-head', 'row', 'row', 'expansion', 'row'])
  const exp = lines[3]
  assert.equal(exp.pos, 4)
  assert.equal(exp.anchorIndex, 1, 'the caret points at the second card of its row')
  assert.equal(lines[2].after, ROW_GAP[3], 'gap between the row and its expansion')
  const last = grouped([group('a', 's', 5)], 3, 4) // expanded card in the LAST row
  assert.deepEqual(last.map((l) => l.kind), ['group-head', 'row', 'row', 'expansion'])
  assert.equal(last[3].after, GROUP_GAP, 'an expansion under the last row ends the group')
})

check('outline: talk heading, § headings for named sections only, ordinals, a zero line for an empty talk', () => {
  const plan = [
    { slug: 'a', title: 'A', total: 3, chunks: [{ section: '', label: '', cards: [card('a', 0)] }, { section: 'one', label: 'One', cards: [card('a', 1), card('a', 2)] }] },
    { slug: 'b', title: 'B', total: 0, chunks: [] }
  ]
  const lines = buildGridLines({ mode: 'outline', plan, cols: 2, expandedPos: -1 })
  assert.deepEqual(lines.map((l) => l.kind), ['talk-head', 'row', 'sec-head', 'row', 'talk-head', 'zero'])
  assert.ok(lines.filter((l) => l.kind === 'row').every((l) => l.ordinals), 'outline rows show position badges')
  assert.equal(lines[1].after, SECTION_GAP, 'a section chunk ends with its own margin')
  assert.equal(lines[3].after, GROUP_GAP, 'the last chunk margin collapses into the talk group margin')
  assert.equal(lines[5].after, GROUP_GAP)
  assert.equal(lines[3].base, 1)
})

check('beside: one heading line, then the results two across', () => {
  const cards = Array.from({ length: 5 }, (_v, i) => card('x', i))
  const lines = buildGridLines({ mode: 'beside', cards, cols: 2, expandedPos: -1 })
  assert.deepEqual(lines.map((l) => l.kind), ['beside-head', 'row', 'row', 'row'])
  assert.ok(lines.slice(1).every((l) => l.cols === 2))
})

check('layout: offsets are the running sum of heights; total is the sum', () => {
  const lines = grouped([group('a', 's', 6)], 3)
  const layout = layoutLines(lines, (l) => (l.kind === 'row' ? 100 : 40))
  assert.deepEqual(layout.offsets, [0, 40, 140])
  assert.equal(layout.total, 240)
})

check('visible range: lines overlapping the window, end exclusive', () => {
  const lines = grouped(Array.from({ length: 50 }, (_v, i) => group(`t${i}`, 's', 6)), 3) // 150 lines
  const layout = layoutLines(lines, fixed(100))
  assert.deepEqual(visibleRange(layout, 0, 250), { start: 0, end: 3 })
  assert.deepEqual(visibleRange(layout, 1000, 1300), { start: 10, end: 13 })
  assert.deepEqual(visibleRange(layout, 1050, 1051), { start: 10, end: 11 }, 'a point inside one line')
  assert.deepEqual(visibleRange(layout, 100000, 100800), { start: 149, end: 150 }, 'past the end clamps to the last line')
  assert.deepEqual(visibleRange(layoutLines([], fixed(1)), 0, 100), { start: 0, end: 0 })
})

check('5,000 cards in 700 groups: one screen plus a screen each side mounts a few dozen cards', () => {
  const groups = Array.from({ length: 700 }, (_v, i) => group(`t${i}`, `s${i}`, i % 3 === 0 ? 10 : 7))
  const lines = grouped(groups, 3)
  const total = lines.reduce((n, l) => n + (l.kind === 'row' ? l.cards.length : 0), 0)
  assert.ok(total >= 5000, `corpus ${total}`)
  const cache = createMeasureCache(1200)
  const layout = layoutLines(lines, (l) => lineHeight(l, cache, 1200))
  for (const top of [0, layout.total / 2, layout.total - 800]) {
    const r = visibleRange(layout, top - 800, top + 1600)
    const cards = lines.slice(r.start, r.end).reduce((n, l) => n + (l.kind === 'row' ? l.cards.length : 0), 0)
    assert.ok(cards > 0 && cards < 300, `${cards} cards mounted at ${Math.round(top)}`)
  }
})

check('heights: estimate from the content width until measured; one measured row calibrates every row', () => {
  const lines = grouped([group('a', 's', 9)], 3)
  const [head, r1, r2, r3] = lines
  const cache = createMeasureCache(900)
  const w = 900
  const card = (w - COL_GAP[3] * 2) / 3
  assert.equal(estimateBody(r1, w), Math.round(10 + (card - 10) * 9 / 16 + 48))
  assert.equal(lineHeight(r2, cache, w), estimateBody(r2, w) + r2.after)
  assert.equal(recordMeasure(cache, r1, w, 250 + r1.after), true)
  assert.equal(lineHeight(r1, cache, w), 250 + r1.after)
  assert.equal(lineHeight(r3, cache, w), 250 + r3.after, 'an unmeasured row takes the measured row body, plus its own gap')
  assert.equal(lineHeight(head, cache, w), estimateBody(head, w), 'headings calibrate separately')
  assert.equal(recordMeasure(cache, r1, w, 250 + r1.after), false, 'an unchanged measurement is no change')
})

check('resize: a new width drops the measurements; estimates follow the new width', () => {
  const lines = grouped([group('a', 's', 6)], 3)
  const r = lines[1]
  const cache = createMeasureCache(900)
  recordMeasure(cache, r, 900, 300)
  assert.equal(lineHeight(r, cache, 600), estimateBody(r, 600) + r.after, 'measured at 900, laid out at 600: estimate')
  assert.ok(estimateBody(r, 600) < estimateBody(r, 900), 'narrower box, shorter prints')
  recordMeasure(cache, r, 600, 200)
  assert.equal(cache.width, 600)
  assert.equal(lineHeight(r, cache, 600), 200)
})

check('positions map to their row line', () => {
  const lines = grouped([group('a', 's', 4), group('b', 's', 2)], 3)
  const m = lineOfPositions(lines)
  assert.equal(m.get(0), 1); assert.equal(m.get(3), 2); assert.equal(m.get(4), 4); assert.equal(m.get(6), undefined)
})

check('scroll target: nearest edge, heading included going up, top for the first row, null when in view', () => {
  const lines = grouped(Array.from({ length: 20 }, (_v, i) => group(`t${i}`, 's', 3)), 3) // head,row × 20
  const layout = layoutLines(lines, (l) => (l.kind === 'row' ? 200 : 50))
  const listTop = 26
  // Line 9 (row of group 4) starts at 4*250+50 = 1050.
  assert.equal(scrollTargetFor(lines, layout, 9, 1000, 800, listTop), null, 'already in view')
  const below = scrollTargetFor(lines, layout, 9, 0, 800, listTop)
  assert.equal(below, listTop + 1050 + 200 - lines[9].after - 800, 'scrolled down just enough to show its bottom')
  assert.equal(scrollTargetFor(lines, layout, 9, 3000, 800, listTop), listTop + 1000, 'scrolled up to its heading')
  assert.equal(scrollTargetFor(lines, layout, 1, 3000, 800, listTop), 0, 'the first row: back to the very top')
})

check('scroll anchor: a 10 px calibration far above keeps the focused card where it was on screen, and drawn', () => {
  // The review's case: one measured row recalibrates every unmeasured row of its kind, so a 10 px
  // correction moved line 500 by thousands of pixels and the focused card left the drawn range.
  const lines = grouped(Array.from({ length: 600 }, (_v, i) => group(`t${i}`, 's', 3)), 3) // head,row × 600
  const w = 1200
  const cache = createMeasureCache(w)
  const before = layoutLines(lines, (l) => lineHeight(l, cache, w))
  const focusLine = 501 // the row of group 250
  const viewport = 800
  const top = before.offsets[focusLine] - 300 // the focused row 300 px down the viewport
  const anchor = anchorFor(lines, before, top, viewport, focusLine)
  assert.equal(anchor.key, lines[focusLine].key, 'the focused line, in view, is the anchor')
  // The first row is measured 10 px taller than estimated: every unmeasured row follows.
  recordMeasure(cache, lines[1], w, lineHeight(lines[1], cache, w) + 10)
  const after = layoutLines(lines, (l) => lineHeight(l, cache, w))
  const moved = after.offsets[focusLine] - before.offsets[focusLine]
  assert.ok(moved > 2000, `the calibration moved the focused line by ${moved}px`)
  const unanchored = visibleRange(after, top - viewport, top + 2 * viewport)
  assert.ok(focusLine >= unanchored.end, 'without the anchor the focused line falls out of the drawn range')
  const shift = anchorShift(lines, after, anchor)
  assert.equal(shift, moved, 'the scroll follows the anchor line')
  const newTop = top + shift
  assert.equal(after.offsets[focusLine] - newTop, before.offsets[focusLine] - top, 'the focused line stays at the same place on screen')
  const r = visibleRange(after, newTop, newTop + viewport)
  assert.ok(focusLine >= r.start && focusLine < r.end, 'and in view')
})

check('scroll anchor: with the focus off screen, the first line in view holds still; a vanished line holds nothing', () => {
  const lines = grouped(Array.from({ length: 100 }, (_v, i) => group(`t${i}`, 's', 3)), 3)
  const layout = layoutLines(lines, (l) => (l.kind === 'row' ? 200 : 50))
  const a = anchorFor(lines, layout, 1300, 800, 1) // focus on line 1, far above
  assert.equal(a.key, lines[visibleRange(layout, 1300, 1301).start].key)
  const grown = layoutLines(lines, (l) => (l.kind === 'row' ? 210 : 50))
  assert.equal(anchorShift(lines, grown, a), grown.offsets[lines.findIndex((l) => l.key === a.key)] - a.lineTop)
  assert.equal(anchorShift(lines, layout, a), 0, 'an unchanged layout moves nothing (a user scroll is never undone)')
  assert.equal(anchorShift(lines, layout, { key: 'nope', lineTop: 5 }), 0)
  assert.equal(anchorFor([], layoutLines([], fixed(1)), 0, 800, 0), null)
})

console.log(`\nPASS slide browser grid windowing (${checks} checks)`)
