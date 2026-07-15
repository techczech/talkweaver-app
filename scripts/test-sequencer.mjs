// Verifies the pure sequencer (compiler/scripts/lib/15-sequencer.mjs).
// Same fail-counting convention as scripts/test-tree.mjs.

import { sequence } from '../compiler/scripts/lib/15-sequencer.mjs'

let fail = 0
const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); fail++ } }
const assertEq = (actual, expected, msg) => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) { console.error(`FAIL: ${msg || ''} — expected ${e}, got ${a}`); fail++ }
}

// helper: build a plain node of the shape the sequencer consumes
const n = (id, attrs, ...children) => ({ id, attrs, children })

const seq = (root) => sequence(root).map((b) => `${b.kind}:${b.slideId}`).join(' ')

// linear default
assertEq(seq(n('root', {}, n('s1', {}, n('a', {}), n('b', {})))),
  'slide:s1 slide:a slide:b', 'linear default')

// carousel over leaves — cards are plain slide beats with context
const car = sequence(n('root', {}, n('s1', { carousel: true }, n('a', {}), n('b', {}))))
assertEq(car.map((b) => `${b.kind}:${b.slideId}`).join(' '), 'slide:s1 slide:a slide:b', 'carousel sequence')
assertEq(car[1].context, { container: 'carousel', sectionId: 's1', index: 0, count: 2 }, 'carousel context')

// contents (bare flag): own slide beat then children with contents context, no variant
const contents = sequence(n('root', {}, n('s1', { contents: true }, n('a', {}), n('b', {}))))
assertEq(contents.map((b) => `${b.kind}:${b.slideId}`).join(' '), 'slide:s1 slide:a slide:b', 'contents sequence')
assertEq(contents[1].context, { container: 'contents', sectionId: 's1', index: 0, count: 2 }, 'contents context (no variant)')

// contents=strip: children carry the filmstrip variant through context (ADR-0007)
const strip = sequence(n('root', {}, n('s1', { contents: 'strip' }, n('a', {}), n('b', {}))))
assertEq(strip.map((b) => `${b.kind}:${b.slideId}`).join(' '), 'slide:s1 slide:a slide:b', 'contents=strip sequence')
assertEq(strip[1].context, { container: 'contents', sectionId: 's1', index: 0, count: 2, variant: 'strip' }, 'contents=strip child carries variant:strip')
assertEq(strip[2].context.variant, 'strip', 'contents=strip second child also carries variant')

// grid-linear: grid then straight through
assertEq(seq(n('root', {}, n('s1', { 'grid-linear': true }, n('a', {}), n('b', {})))),
  'grid:s1 slide:a slide:b', 'grid-linear')

// grid-zoom over leaves: return after EVERY child incl. last
assertEq(seq(n('root', {}, n('s1', { 'grid-zoom': true }, n('a', {}), n('b', {})))),
  'grid:s1 slide:a grid-return:s1 slide:b grid-return:s1', 'grid-zoom over leaves')

// grid-zoom over subsections (PowerPoint zoom): whole subtree before the return
assertEq(seq(n('root', {}, n('s1', { 'grid-zoom': true },
    n('sub1', {}, n('a', {}), n('b', {})), n('sub2', {}, n('c', {}))))),
  'grid:s1 slide:sub1 slide:a slide:b grid-return:s1 slide:sub2 slide:c grid-return:s1', 'grid-zoom over subsections')

// nesting: carousel inside grid-zoom
assertEq(seq(n('root', {}, n('s1', { 'grid-zoom': true },
    n('sub1', { carousel: true }, n('a', {}), n('b', {}))))),
  'grid:s1 slide:sub1 slide:a slide:b grid-return:s1', 'carousel inside grid-zoom')

// grid-return completed accumulates
const gz = sequence(n('root', {}, n('s1', { 'grid-zoom': true }, n('a', {}), n('b', {}))))
assertEq(gz[2].context.completed, ['a'], 'grid-return completed after first child')
assertEq(gz[4].context.completed, ['a', 'b'], 'grid-return completed after second child')

// carousel on sections: warning + linear fallback
let warned = []
assertEq(sequence(n('root', {}, n('s1', { carousel: true }, n('sub', {}, n('a', {})))),
    { warn: (w) => warned.push(w) }).map((b) => `${b.kind}:${b.slideId}`).join(' '),
  'slide:s1 slide:sub slide:a', 'carousel-on-sections falls back to linear')
assert(warned.includes('carousel-on-sections:s1'), 'carousel-on-sections warning emitted')

// empty section: just its own slide beat
assertEq(seq(n('root', {}, n('s1', { 'grid-zoom': true }))), 'slide:s1', 'empty grid section degenerates to slide')

if (fail) { console.error(`\n${fail} check(s) failed`); process.exit(1) }
console.log('sequencer: all checks passed')
