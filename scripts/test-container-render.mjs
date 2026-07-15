// Verifies the pure container-mode state core (ADR-0007, Task 6) of the presenter runtime.
// Like scripts/test-beats-preview.mjs, this extracts the helper source VERBATIM from the
// presenter template between the CONTAINER_HELPERS markers and evaluates it headlessly — the
// tested code IS the shipped code, single source of truth.
//
// Contract under test:
//   • gridChildIdsFromBeats: the section's ordered direct children = the LAST grid-return's
//     accumulated completed[] (grid-zoom); [] when there is no grid-return (grid-linear).
//   • contentsChildIdsFromBeats: the ordered direct children of a contents section, from the
//     child beats' container context (index-ordered).
//   • containerRenderPlan: for a grid beat → {done[],next,items[{done,next}]}; for a contents
//     beat → {items[{done,current}], currentIndex, variant}. Pure function of (beat, beats,
//     beatIndex, childIds).
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const templatePath = join(here, '..', 'compiler', 'assets', 'templates', 'presenter-popup-single-html.html')
const templateHtml = readFileSync(templatePath, 'utf8')

const START = '// === CONTAINER_HELPERS_START'
const END = '// === CONTAINER_HELPERS_END'
const startIdx = templateHtml.indexOf(START)
const endIdx = templateHtml.indexOf(END)
if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) {
  console.error('FAIL: CONTAINER_HELPERS_START/END markers not found in presenter template')
  process.exit(1)
}
const helperSource = templateHtml.slice(startIdx, endIdx)
const { gridChildIdsFromBeats, contentsChildIdsFromBeats, lastBeatIndexForSlide, containerRenderPlan } = new Function(
  `${helperSource}\nreturn { gridChildIdsFromBeats, contentsChildIdsFromBeats, lastBeatIndexForSlide, containerRenderPlan };`
)()

const { sequence } = await import(
  pathToFileURL(join(here, '..', 'compiler', 'scripts', 'lib', '15-sequencer.mjs')).href
)
const n = (id, attrs, ...children) => ({ id, attrs, children })

let fail = 0
const ck = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); fail++ } }
const eq = (actual, expected, msg) => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) { console.error(`FAIL: ${msg} — expected ${e}, got ${a}`); fail++ }
}

// === GRID (grid-zoom) ========================================================================
// beats: grid:s1, slide:a, grid-return([a]), slide:b, grid-return([a,b]), slide:c, grid-return([a,b,c])
const gridZoom = sequence(n('root', {}, n('s1', { 'grid-zoom': true }, n('a', {}), n('b', {}), n('c', {}))))
eq(gridChildIdsFromBeats(gridZoom, 's1'), ['a', 'b', 'c'], 'gridChildIdsFromBeats: last grid-return completed = ordered children')
eq(gridChildIdsFromBeats(gridZoom, 'nope'), [], 'gridChildIdsFromBeats: unknown section → []')

const gridIds = gridChildIdsFromBeats(gridZoom, 's1')
// Initial grid beat (index 0): nothing done, first child is next.
{
  const plan = containerRenderPlan(gridZoom[0], gridZoom, 0, gridIds)
  eq(plan.mode, 'grid', 'grid beat → mode grid')
  eq(plan.done, [], 'grid beat: nothing done')
  eq(plan.next, 'a', 'grid beat: next = first child')
  eq(plan.items.map((it) => `${it.id}:${it.done ? 'd' : '-'}${it.next ? 'n' : '-'}`),
    ['a:-n', 'b:--', 'c:--'], 'grid beat items: a is next, none done')
}
// First grid-return (index 2, completed [a]): a done, b next.
{
  ck(gridZoom[2].kind === 'grid-return', 'fixture: [2] is grid-return')
  const plan = containerRenderPlan(gridZoom[2], gridZoom, 2, gridIds)
  eq(plan.done, ['a'], 'grid-return[2]: a done')
  eq(plan.next, 'b', 'grid-return[2]: b next')
  eq(plan.items.map((it) => `${it.id}:${it.done ? 'd' : '-'}${it.next ? 'n' : '-'}`),
    ['a:d-', 'b:-n', 'c:--'], 'grid-return[2] items: a done, b next')
}
// Final grid-return (index 6, completed [a,b,c]): all done, no next.
{
  const plan = containerRenderPlan(gridZoom[6], gridZoom, 6, gridIds)
  eq(plan.done, ['a', 'b', 'c'], 'final grid-return: all done')
  eq(plan.next, null, 'final grid-return: next = null')
  ck(plan.items.every((it) => it.done && !it.next), 'final grid-return: every card done, none next')
}

// grid-linear has no grid-return → beats give no children (caller falls back to data-child-ids).
const gridLinear = sequence(n('root', {}, n('s1', { 'grid-linear': true }, n('a', {}), n('b', {}))))
eq(gridChildIdsFromBeats(gridLinear, 's1'), [], 'grid-linear: no grid-return → [] (DOM fallback used at runtime)')
// With childIds supplied (as the runtime would from data-child-ids), the plan still computes.
{
  const plan = containerRenderPlan(gridLinear[0], gridLinear, 0, ['a', 'b'])
  eq(plan.next, 'a', 'grid-linear with supplied children: first child next')
  eq(plan.done, [], 'grid-linear: nothing done (no returns)')
}

// === CONTENTS ================================================================================
// beats: slide:s1, slide:x(ctx idx0), slide:y(idx1), slide:z(idx2)
const contents = sequence(n('root', {}, n('s1', { contents: true }, n('x', {}), n('y', {}), n('z', {}))))
eq(contentsChildIdsFromBeats(contents, 's1'), ['x', 'y', 'z'], 'contentsChildIdsFromBeats: index-ordered direct children')
const cIds = contentsChildIdsFromBeats(contents, 's1')
// Section-own slide beat (index 0) has no container context → not a container beat.
eq(containerRenderPlan(contents[0], contents, 0, cIds), null, 'contents section-own slide beat → null (rail only on children)')
// On child x (beat index 1, ctx.index 0): x current, nothing done yet.
{
  const plan = containerRenderPlan(contents[1], contents, 1, cIds)
  eq(plan.mode, 'contents', 'contents child → mode contents')
  eq(plan.variant, null, 'contents (bare) → variant null')
  eq(plan.currentIndex, 0, 'contents child x: currentIndex 0')
  eq(plan.items.map((it) => `${it.id}:${it.done ? 'd' : '-'}${it.current ? 'c' : '-'}`),
    ['x:-c', 'y:--', 'z:--'], 'contents at x: x current, none done')
}
// On child z (beat index 3, ctx.index 2): x and y done (last beat behind), z current.
{
  const plan = containerRenderPlan(contents[3], contents, 3, cIds)
  eq(plan.currentIndex, 2, 'contents child z: currentIndex 2')
  eq(plan.items.map((it) => `${it.id}:${it.done ? 'd' : '-'}${it.current ? 'c' : '-'}`),
    ['x:d-', 'y:d-', 'z:-c'], 'contents at z: x,y done, z current')
}

// contents=strip: the plan carries the filmstrip variant.
const strip = sequence(n('root', {}, n('s1', { contents: 'strip' }, n('x', {}), n('y', {}))))
{
  const plan = containerRenderPlan(strip[1], strip, 1, contentsChildIdsFromBeats(strip, 's1'))
  eq(plan.variant, 'strip', 'contents=strip child → variant strip')
}

// lastBeatIndexForSlide sanity
eq(lastBeatIndexForSlide(contents, 'x'), 1, 'lastBeatIndexForSlide: x last at 1')
eq(lastBeatIndexForSlide(gridZoom, 's1'), 6, 'lastBeatIndexForSlide: s1 (grid section) last at final grid-return')

// Non-container beats and null-safety.
eq(containerRenderPlan(null, [], 0, []), null, 'null beat → null')
eq(containerRenderPlan({ kind: 'slide', slideId: 'p' }, [], 0, []), null, 'plain slide beat → null')

// Runtime hook presence.
ck(templateHtml.includes('window.__containerRenderPlanForTest = containerRenderPlan'), 'template exposes __containerRenderPlanForTest')

if (fail) { console.error(`\n${fail} check(s) failed`); process.exit(1) }
console.log('test-container-render: all checks passed')
