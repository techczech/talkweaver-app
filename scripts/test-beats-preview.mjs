// Verifies the pure beat-navigation helpers of the presenter runtime (heading-is-slide model,
// Task 5). Unlike test-selector-logic.mjs (which duplicates its functions), this extracts the
// helper source VERBATIM from the presenter template between the BEAT_HELPERS markers and
// evaluates it headlessly — the tested code IS the shipped code, single source of truth.
//
// Invariants under test (the Task 5 contract):
//   • advanceTarget: for EVERY beat index i, slideStepsRemaining === 0 → { kind:'beat', index:i+1 };
//     slideStepsRemaining > 0 → { kind:'step' }. Reveal/focus steps are the ONLY intra-beat state.
//   • nextPaneBeat: the Next pane's source is ALWAYS beats[i+1] — a pure structural fact of the
//     beat index, with no steps parameter at all (so no step state can ever change what it shows);
//     null past the last beat.
//   • beatLabel: 'card 2/3 — <section title>' for carousel-context beats, 'back to grid —
//     <section title>' for grid-return (section id IS beat.slideId), 'next slide' otherwise,
//     'end of talk' past the last beat.
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const templatePath = join(here, '..', 'compiler', 'assets', 'templates', 'presenter-popup-single-html.html')
const templateHtml = readFileSync(templatePath, 'utf8')

const START = '// === BEAT_HELPERS_START'
const END = '// === BEAT_HELPERS_END'
const startIdx = templateHtml.indexOf(START)
const endIdx = templateHtml.indexOf(END)
if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) {
  console.error('FAIL: BEAT_HELPERS_START/END markers not found in presenter template')
  process.exit(1)
}
const helperSource = templateHtml.slice(startIdx, endIdx)
const { advanceTarget, beatLabel, nextPaneBeat, retreatTarget, intraBeatStepsRemaining, carouselChildBeatIndex, slideIdForRuntimeBeat, revealForRuntimeBeat, previewTargetForBeat, beatIndexForHash, hashIdForBeat } = new Function(
  `${helperSource}\nreturn { advanceTarget, beatLabel, nextPaneBeat, retreatTarget, intraBeatStepsRemaining, carouselChildBeatIndex: typeof carouselChildBeatIndex === 'function' ? carouselChildBeatIndex : null, slideIdForRuntimeBeat: typeof slideIdForRuntimeBeat === 'function' ? slideIdForRuntimeBeat : null, revealForRuntimeBeat: typeof revealForRuntimeBeat === 'function' ? revealForRuntimeBeat : null, previewTargetForBeat: typeof previewTargetForBeat === 'function' ? previewTargetForBeat : null, beatIndexForHash: typeof beatIndexForHash === 'function' ? beatIndexForHash : null, hashIdForBeat: typeof hashIdForBeat === 'function' ? hashIdForBeat : null };`
)()

// Beat fixtures come from the REAL sequencer over the Task 2 fixture shapes, so the tested beat
// lists are exactly what a compiled deck carries (grid / grid-return / carousel context included).
const { sequence } = await import(
  pathToFileURL(join(here, '..', 'compiler', 'scripts', 'lib', '15-sequencer.mjs')).href
)
const { adaptMarkdownOutlineV2 } = await import(
  pathToFileURL(join(here, '..', 'compiler', 'scripts', 'lib', '08-source-adapters.mjs')).href
)
const n = (id, attrs, ...children) => ({ id, attrs, children })

const fixtures = {
  linear: sequence(n('root', {}, n('s1', {}, n('a', {}), n('b', {})), n('c', {}))),
  carousel: sequence(n('root', {}, n('s1', { carousel: true }, n('a', {}), n('b', {}), n('c', {})), n('after', {}))),
  gridLinear: sequence(n('root', {}, n('s1', { 'grid-linear': true }, n('a', {}), n('b', {})), n('after', {}))),
  gridZoom: sequence(n('root', {}, n('s1', { 'grid-zoom': true }, n('a', {}), n('b', {})), n('after', {}))),
}

let fail = 0
const ck = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); fail++ } }
const eq = (actual, expected, msg) => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) { console.error(`FAIL: ${msg} — expected ${e}, got ${a}`); fail++ }
}

// --- The advance invariant, for EVERY index of EVERY fixture ---
for (const [name, beats] of Object.entries(fixtures)) {
  for (let i = 0; i < beats.length; i += 1) {
    eq(advanceTarget({ beat: i }, beats, 0), { kind: 'beat', index: i + 1 },
      `${name}[${i}]: steps exhausted → next beat`)
    eq(advanceTarget({ beat: i }, beats, 1), { kind: 'step' },
      `${name}[${i}]: 1 step remaining → step, not beat`)
    eq(advanceTarget({ beat: i }, beats, 3), { kind: 'step' },
      `${name}[${i}]: 3 steps remaining → step, not beat`)
    // Next-pane source is ALWAYS beats[i+1], a pure function of the beat index. nextPaneBeat has
    // NO steps parameter (structurally step-independent), so one assertion covers all step states.
    ck(nextPaneBeat({ beat: i }, beats) === (beats[i + 1] ?? null),
      `${name}[${i}]: next pane source is beats[${i + 1}]`)
  }
}

// --- The retreat invariant (F1): back-symmetry, for EVERY index of EVERY fixture ---
// stepsTaken === 0 → previous beat AT ITS FULL STATE (atEnd — a reveal slide entered backwards
// arrives fully revealed); stepsTaken > 0 → un-step, never a beat change.
for (const [name, beats] of Object.entries(fixtures)) {
  for (let i = 0; i < beats.length; i += 1) {
    eq(retreatTarget({ beat: i }, beats, 0), { kind: 'beat', index: i - 1, atEnd: true },
      `${name}[${i}]: nothing taken → previous beat at its full state`)
    eq(retreatTarget({ beat: i }, beats, 1), { kind: 'step' },
      `${name}[${i}]: 1 step taken → un-step, not beat`)
    eq(retreatTarget({ beat: i }, beats, 4), { kind: 'step' },
      `${name}[${i}]: 4 steps taken → un-step, not beat`)
  }
}

// --- F2: block-content carousel cards are intra-beat steps ---
// A {carousel} over paragraphs is ONE beat whose cards are consumed like reveal steps: a
// 3-card slide takes exactly 3 forward presses (card2, card3, then cross) and is symmetric
// backwards — one click never silently discards authored content. The Next pane stays
// step-blind throughout (ALWAYS beats[i+1]).
{
  const beats = fixtures.linear // any beat list; the block carousel is beat index 1
  const at = 1
  const cardCount = 3
  let cardIndex = 0
  const presses = []
  for (let press = 1; press <= 4; press += 1) {
    const remaining = intraBeatStepsRemaining({ cardCount, cardIndex, modeOn: false, modeTop: 0, modeStep: 0 })
    const decision = advanceTarget({ beat: at }, beats, remaining)
    ck(nextPaneBeat({ beat: at }, beats) === beats[at + 1], `carousel-steps press ${press}: next pane still beats[${at + 1}]`)
    if (decision.kind === 'step') { cardIndex += 1; presses.push(`card${cardIndex + 1}`) }
    else { presses.push(`beat${decision.index}`); break }
  }
  eq(presses, ['card2', 'card3', `beat${at + 1}`], '3-card block carousel: exactly 3 forward presses to cross')
  // backward from the last card: symmetric press count
  cardIndex = cardCount - 1
  const backPresses = []
  for (let press = 1; press <= 4; press += 1) {
    const decision = retreatTarget({ beat: at }, beats, cardIndex)
    if (decision.kind === 'step') { cardIndex -= 1; backPresses.push(`card${cardIndex + 1}`) }
    else { backPresses.push(`beat${decision.index}@end`); break }
  }
  eq(backPresses, ['card2', 'card1', `beat${at - 1}@end`], '3-card block carousel: exactly 3 backward presses, symmetric')
  // mode composition: remaining = mode steps left in the active card + cards still to visit
  eq(intraBeatStepsRemaining({ cardCount: 2, cardIndex: 0, modeOn: true, modeTop: 3, modeStep: 1 }), 3,
    'intraBeatStepsRemaining composes mode steps (2) + remaining cards (1)')
  eq(intraBeatStepsRemaining({ cardCount: 0, cardIndex: 0, modeOn: true, modeTop: 3, modeStep: 3 }), 0,
    'intraBeatStepsRemaining: exhausted mode, no cards → 0')
}

// --- Labels ---
const titles = { s1: 'Ways of Seeing', a: 'Card A', b: 'Card B', c: 'Card C', after: 'After' }
const titleFor = (id) => titles[id] || id

// Carousel: beats = slide:s1, slide:a(ctx 0/3), slide:b(ctx 1/3), slide:c(ctx 2/3), slide:after
eq(beatLabel(fixtures.carousel[1], fixtures.carousel, titleFor), 'card 1/3 — Ways of Seeing', 'carousel card 1 label')
eq(beatLabel(fixtures.carousel[2], fixtures.carousel, titleFor), 'card 2/3 — Ways of Seeing', 'carousel card 2 label')
eq(beatLabel(fixtures.carousel[3], fixtures.carousel, titleFor), 'card 3/3 — Ways of Seeing', 'carousel card 3 label')
eq(beatLabel(fixtures.carousel[4], fixtures.carousel, titleFor), 'next slide', 'slide after carousel label')
ck(typeof carouselChildBeatIndex === 'function', 'carousel child beat resolver is present')
ck(typeof slideIdForRuntimeBeat === 'function', 'runtime beat-to-slide resolver is present')
ck(typeof revealForRuntimeBeat === 'function', 'runtime beat reveal resolver is present')
if (carouselChildBeatIndex && slideIdForRuntimeBeat && revealForRuntimeBeat) {
  eq(carouselChildBeatIndex(fixtures.carousel, 's1', 1), 2, 'subIndex 1 resolves to the second child beat')
  eq(slideIdForRuntimeBeat(fixtures.carousel[2]), 's1', 'carousel child beat maps to folded parent slide id')
  eq(revealForRuntimeBeat(fixtures.carousel[2]), 1, 'second child beat selects gallery reveal 1')
}

// Real compiler fold: canonical child slideIds survive, while preview DOM/reveal resolve through
// the folded parent context.
{
  const model = adaptMarkdownOutlineV2('# Deck\n\n### Parent {carousel}\n\n#### One {id=child}\n\nA\n\n#### Two {id=child}\n\nB', 'Deck')
  const folded = model.beats.filter((beat) => beat.context?.container === 'carousel')
  eq(folded.map((beat) => beat.slideId), ['child', 'child-2'], 'real folded beats keep deduped authored child ids')
  ck(typeof previewTargetForBeat === 'function', 'preview target resolver is present')
  if (previewTargetForBeat) {
    eq(previewTargetForBeat(folded[1], 999), { slideId: folded[1].context.sectionId, reveal: 1 }, 'second folded child preview resolves parent DOM and card 2')
  }
  ck(typeof beatIndexForHash === 'function', 'canonical hash beat resolver is present')
  ck(typeof hashIdForBeat === 'function', 'canonical beat hash publisher is present')
  if (beatIndexForHash && hashIdForBeat) {
    const childHash = hashIdForBeat(folded[1], folded[1].context.sectionId)
    eq(childHash, 'child-2', 'second folded child publishes canonical hash')
    eq(beatIndexForHash(childHash, folded), 1, 'canonical child-2 hash reload resolves second beat')
    const reloaded = folded[beatIndexForHash(childHash, folded)]
    eq({ slideId: slideIdForRuntimeBeat(reloaded), reveal: revealForRuntimeBeat(reloaded) }, { slideId: folded[1].context.sectionId, reveal: 1 }, 'child-2 hash resolves parent DOM index identity and reveal 1')
  }
}

// Grid-zoom: beats = grid:s1, slide:a, grid-return:s1, slide:b, grid-return:s1, slide:after
ck(fixtures.gridZoom[2].kind === 'grid-return', 'gridZoom fixture shape: [2] is grid-return')
eq(beatLabel(fixtures.gridZoom[2], fixtures.gridZoom, titleFor), 'back to grid — Ways of Seeing', 'grid-return label')
eq(beatLabel(fixtures.gridZoom[0], fixtures.gridZoom, titleFor), 'next slide', 'grid beat label (plain, Task 6 owns visuals)')
eq(beatLabel(fixtures.gridZoom[1], fixtures.gridZoom, titleFor), 'next slide', 'grid child label')

// Plain slides + end of talk
eq(beatLabel(fixtures.linear[1], fixtures.linear, titleFor), 'next slide', 'plain slide label')
eq(beatLabel(fixtures.linear[fixtures.linear.length], fixtures.linear, titleFor), 'end of talk', 'past-the-end label (undefined beat)')
eq(beatLabel(null, fixtures.linear, titleFor), 'end of talk', 'null beat label')

// titleFor is optional (runtime always passes it; the default must not throw)
ck(typeof beatLabel(fixtures.linear[0], fixtures.linear) === 'string', 'beatLabel works without titleFor')

// --- Runtime hook presence: the helpers must be exposed for headless harnesses ---
ck(templateHtml.includes('window.__advanceTargetForTest = advanceTarget'), 'template exposes __advanceTargetForTest')
ck(templateHtml.includes('window.__beatLabelForTest = beatLabel'), 'template exposes __beatLabelForTest')
// The old hand-synced preview grammar must be GONE (deleted, not stranded).
ck(!templateHtml.includes('computeNextPreview'), 'computeNextPreview deleted from template')
ck(!templateHtml.includes('stepGalleryMode'), 'stepGalleryMode (carousel arm) deleted from template')

if (fail) { console.error(`\n${fail} check(s) failed`); process.exit(1) }
console.log('test-beats-preview: all checks passed')
