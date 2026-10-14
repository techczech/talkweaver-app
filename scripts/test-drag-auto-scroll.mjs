// The edge auto-scroll speed function shared by the Slides organizer, the slide grid and the Talks
// list (src/renderer/src/lib/dragAutoScroll.ts): pointer position + container rect → scroll delta
// per frame. The loop that applies it is exercised in a browser by scripts/test-slide-drag-dom.mjs.
import { strict as assert } from 'node:assert'
import {
  DRAG_SCROLL_EDGE_ZONE as ZONE,
  DRAG_SCROLL_MAX_SPEED as MAX,
  DRAG_SCROLL_MIN_SPEED as MIN,
  DRAG_SCROLL_OUTSIDE_SLACK as SLACK,
  edgeScrollDelta
} from '../src/renderer/src/lib/dragAutoScroll.ts'

const rect = { top: 100, bottom: 700, left: 0, right: 240 }
const at = (y, x = 120) => edgeScrollDelta({ x, y }, rect)

// Zero outside the zones.
for (const y of [rect.top + ZONE, rect.top + ZONE + 1, 400, rect.bottom - ZONE - 1, rect.bottom - ZONE]) {
  assert.equal(at(y), 0, `no scroll at y=${y} (middle of the list)`)
}
console.log('PASS zero between the two edge zones, boundaries included')

// Direction, and faster the closer to the edge.
const depths = [1, 8, 20, 40, ZONE - 1, ZONE]
let previous = 0
for (const d of depths) {
  const down = at(rect.bottom - ZONE + d)
  assert(down > previous, `bottom zone: deeper is faster (depth ${d}: ${down} > ${previous})`)
  previous = down
}
assert(at(rect.top + 10) < 0, 'top zone scrolls up')
assert(at(rect.bottom - 10) > 0, 'bottom zone scrolls down')
console.log('PASS top scrolls up, bottom scrolls down, speed grows with depth into the zone')

// Clamped: never below MIN inside a zone, never above MAX, MAX at the edge and past it.
assert(at(rect.bottom - ZONE + 0.01) >= MIN, 'just inside the zone already moves at the minimum speed')
assert.equal(at(rect.bottom), MAX, 'the edge is the top speed')
assert.equal(at(rect.top), -MAX)
for (const past of [1, 30, SLACK]) {
  assert.equal(at(rect.bottom + past), MAX, `${past}px below the list still scrolls at the top speed`)
  assert.equal(at(rect.top - past), -MAX, `${past}px above the list still scrolls at the top speed`)
}
assert.equal(at(rect.bottom + SLACK + 1), 0, 'far below the list: nothing scrolls')
assert.equal(at(rect.top - SLACK - 1), 0, 'far above the list: nothing scrolls')
assert.equal(at(rect.bottom - 5, rect.right + SLACK + 1), 0, 'far to the side of the list: nothing scrolls')
assert.equal(at(rect.bottom - 5, rect.left - SLACK - 1), 0)
assert.equal(at(rect.bottom - 5, rect.right + SLACK), at(rect.bottom - 5), 'a little to the side still scrolls')
for (let y = rect.top - 200; y <= rect.bottom + 200; y += 0.5) {
  assert(Math.abs(at(y)) <= MAX, `|delta| ≤ MAX at y=${y}`)
}
console.log(`PASS clamped to ${MIN}..${MAX} px per frame; scrolls up to ${SLACK}px outside the list, not beyond`)

// Symmetrical: the two zones mirror each other.
for (let d = -SLACK; d <= 300; d += 0.5) {
  assert.equal(at(rect.top + d), -at(rect.bottom - d) || 0, `mirror at distance ${d}`)
}
console.log('PASS symmetrical top and bottom')

// The curve itself: quadratic from MIN to MAX.
assert.equal(at(rect.bottom - ZONE / 2), MIN + (MAX - MIN) * 0.25, 'half way into the zone = MIN + a quarter of the range')

// A short list keeps a still middle: the zone is capped at a third of the height.
const short = { top: 0, bottom: 90, left: 0, right: 100 }
assert.equal(edgeScrollDelta({ x: 50, y: 45 }, short), 0, 'middle of a 90px list does not scroll')
assert(edgeScrollDelta({ x: 50, y: 20 }, short) < 0)
assert(edgeScrollDelta({ x: 50, y: 70 }, short) > 0)
assert.equal(edgeScrollDelta({ x: 50, y: 10 }, { top: 0, bottom: 0, left: 0, right: 100 }), 0, 'a list with no height never scrolls')
console.log('PASS short lists keep a still middle; a zero-height list never scrolls')

// A sticky header covers the top of the list: the zone starts where the cover ends.
{
  const cover = { top: 40.5, bottom: 0 }
  const under = (y) => edgeScrollDelta({ x: 120, y }, rect, cover)
  const edge = rect.top + cover.top
  assert.equal(under(edge + ZONE), 0, 'the zone ends 56px under the header')
  assert.equal(under(edge + ZONE + 1), 0)
  assert(under(edge + ZONE - 0.01) <= -MIN && under(edge + ZONE - 0.01) > -MIN - 0.1, 'just inside it: the minimum speed')
  assert.equal(under(edge + ZONE / 2), -(MIN + (MAX - MIN) * 0.25), 'half way: MIN + a quarter of the range, as with no header')
  assert.equal(under(edge), -MAX, 'at the bottom edge of the header: the top speed')
  for (const y of [edge - 1, rect.top + 3, rect.top, rect.top - 30, rect.top - SLACK]) assert.equal(under(y), -MAX, `over the header and above the list (y=${y}): the top speed`)
  assert.equal(under(rect.top - SLACK - 1), 0, 'the slack is still measured from the list\'s own edge')
  for (let d = 0; d <= ZONE; d += 0.5) assert.equal(under(edge + d), at(rect.top + d), `the same curve, moved down by the header (depth ${d})`)
  for (let d = -SLACK; d <= ZONE + 20; d += 0.5) assert.equal(under(rect.bottom - d), at(rect.bottom - d), 'the bottom zone is where it was')
  // A footer does the same from below, and both together.
  const both = { top: 40, bottom: 30 }
  assert.equal(edgeScrollDelta({ x: 120, y: rect.bottom - 30 }, rect, both), MAX, 'at the top edge of a footer: the top speed')
  assert.equal(edgeScrollDelta({ x: 120, y: rect.bottom - 10 }, rect, both), MAX, 'over the footer too')
  assert.equal(edgeScrollDelta({ x: 120, y: rect.bottom - 30 - ZONE }, rect, both), 0)
  assert.equal(edgeScrollDelta({ x: 120, y: rect.top + 40 + ZONE }, rect, both), 0)
  assert.equal(edgeScrollDelta({ x: 120, y: rect.bottom - 30 - ZONE / 2 }, rect, both), -edgeScrollDelta({ x: 120, y: rect.top + 40 + ZONE / 2 }, rect, both), 'the two zones still mirror each other')
  // The cap at a third applies to what is visible.
  const shortCovered = { top: 0, bottom: 130, left: 0, right: 100 }
  assert.equal(edgeScrollDelta({ x: 50, y: 85 }, shortCovered, { top: 40, bottom: 0 }), 0, 'a 90px visible list keeps its still middle under a 40px header')
  assert(edgeScrollDelta({ x: 50, y: 60 }, shortCovered, { top: 40, bottom: 0 }) < 0)
  // Covered from top to bottom: only the list's edges scroll.
  assert.equal(edgeScrollDelta({ x: 50, y: 20 }, { top: 0, bottom: 40, left: 0, right: 100 }, { top: 40, bottom: 0 }), 0)
  assert.equal(edgeScrollDelta({ x: 50, y: -5 }, { top: 0, bottom: 40, left: 0, right: 100 }, { top: 40, bottom: 0 }), -MAX)
  assert.equal(edgeScrollDelta({ x: 120, y: rect.top + 10 }, rect, { top: -5, bottom: -5 }), at(rect.top + 10), 'a negative cover is no cover')
  console.log('PASS a sticky header or footer moves its zone to the visible rows; over it the list scrolls at the top speed')
}

// Traversal time: a 100-slide list at the top speed, 60 frames a second.
const outlinePx = 100 * 33
const seconds = outlinePx / (MAX * 60)
assert(seconds < 3, `a 100-row outline (${outlinePx}px) is crossed in ${seconds.toFixed(1)}s at the edge`)
console.log(`PASS a 100-row outline is crossed in ${seconds.toFixed(1)}s with the pointer at the edge`)
