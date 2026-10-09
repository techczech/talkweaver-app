// test:image-steps — "Step through images" (0.38 ticket 03, ADR-0034)
//
//   1. The deciding module (compiler/assets/runtime/image-steps.js): which images are stops, and
//      every Next / Back decision, with no browser. The same source is inlined in the deck.
//   2. The compile step: `data-image-steps` is stamped by slide token → talk frontmatter → off, and
//      the two tokens raise no warning.
// The stepping in a real presenter + projector pair is scripts/image-steps-dom.test.mjs.
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  imageStepStops, imageStepRest, imageStepForward, imageStepBackward, imageStepsRuntimeSource
} from '../compiler/assets/runtime/image-steps.js'
import { resolveImageSteps } from '../compiler/scripts/lib/image-steps.mjs'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

// ── 1. The deciding module ────────────────────────────────────────────────────
const still = { kind: 'image' }
const gridCell = {}                       // image-grid cells carry no kind
const video = { kind: 'video' }
const qr = { isQr: true }
const fullBleed = { kind: 'image', fullBleed: true }

assert.deepEqual(imageStepStops(false, [still, still]), [], 'setting off: no sequence')
assert.deepEqual(imageStepStops(true, []), [], 'no images: no sequence')
assert.deepEqual(imageStepStops(true, [still, still, still, still]), [0, 1, 2, 3], 'four images: four stops')
assert.deepEqual(imageStepStops(true, [still, video, gridCell, qr]), [0, 2], 'videos and QR codes are never stops; grid cells are')
assert.deepEqual(imageStepStops(true, [video, qr]), [], 'only a video and a QR code: no sequence')
assert.deepEqual(imageStepStops(true, [still]), [0], 'one image that does not fill the slide is stepped')
assert.deepEqual(imageStepStops(true, [fullBleed]), [], 'one image that already fills the slide is not stepped')
assert.deepEqual(imageStepStops(true, [video, fullBleed]), [], 'a full-bleed image stays unstepped beside a video')
assert.deepEqual(imageStepStops(true, [fullBleed, still]), [0, 1], 'full-bleed only exempts a lone image')

const BEFORE = { open: false, index: 0 }
/** Press Next (or Back) until the sequence hands over; returns every state passed through. */
function walk(step, stops, from, stepsRemaining = 0) {
  const seen = []
  let lightbox = from
  for (let presses = 0; presses < 20; presses += 1) {
    const next = step({ stops, lightbox, stepsRemaining })
    if (!next) return { seen, last: lightbox }
    seen.push(next)
    lightbox = next
  }
  throw new Error('the sequence never handed over')
}

const four = imageStepStops(true, [still, still, still, still])
const AFTER_FOUR = { open: false, index: 4 }
assert.deepEqual(imageStepRest(four, 'before'), BEFORE)
assert.deepEqual(imageStepRest(four, 'after'), AFTER_FOUR)
assert.deepEqual(imageStepRest([], 'after'), BEFORE, 'no stops: both rests are the plain closed lightbox')
assert.deepEqual(walk(imageStepForward, four, BEFORE).seen, [
  { open: true, index: 0 }, { open: true, index: 1 }, { open: true, index: 2 }, { open: true, index: 3 }, AFTER_FOUR
], 'Next: all → 1 → 2 → 3 → 4 → all again, then the next slide')
assert.equal(imageStepForward({ stops: four, lightbox: AFTER_FOUR, stepsRemaining: 0 }), null, 'from "all again" Next leaves the slide')
assert.deepEqual(walk(imageStepBackward, four, AFTER_FOUR).seen, [
  { open: true, index: 3 }, { open: true, index: 2 }, { open: true, index: 1 }, { open: true, index: 0 }, BEFORE
], 'Back: all again → 4 → 3 → 2 → 1 → all, then the previous slide')
assert.equal(imageStepBackward({ stops: four, lightbox: BEFORE }), null, 'from "all" Back leaves the slide')
// Back reverses Next from any point.
for (const from of [BEFORE, { open: true, index: 0 }, { open: true, index: 2 }, { open: true, index: 3 }]) {
  const forward = imageStepForward({ stops: four, lightbox: from, stepsRemaining: 0 })
  assert.deepEqual(imageStepBackward({ stops: four, lightbox: forward }), from, `Back undoes Next from ${JSON.stringify(from)}`)
}

// The slide's own reveal steps run first.
assert.equal(imageStepForward({ stops: four, lightbox: BEFORE, stepsRemaining: 2 }), null, 'reveal steps left: the sequence waits')
assert.deepEqual(imageStepForward({ stops: four, lightbox: BEFORE, stepsRemaining: 0 }), { open: true, index: 0 }, 'reveal steps spent: the first image')

// Esc or Z during the sequence closes the zoom and leaves the slide at "as laid out again": the
// runtime publishes imageStepRest(stops, 'after'), so the next Next moves on and Back re-opens
// the last image.
const dismissed = imageStepRest(four, 'after')
assert.equal(imageStepForward({ stops: four, lightbox: dismissed, stepsRemaining: 0 }), null, 'after Esc, Next moves on')
assert.deepEqual(imageStepBackward({ stops: four, lightbox: dismissed }), { open: true, index: 3 }, 'after Esc, Back returns to the last image')

// One image: as placed → zoomed → as placed → next.
const one = imageStepStops(true, [still])
assert.deepEqual(walk(imageStepForward, one, BEFORE).seen, [{ open: true, index: 0 }, { open: false, index: 1 }])
assert.deepEqual(walk(imageStepBackward, one, { open: false, index: 1 }).seen, [{ open: true, index: 0 }, BEFORE])

// A video between two images is skipped in both directions, also when Z was opened on it by hand.
const mixed = imageStepStops(true, [still, video, still, qr])
assert.deepEqual(walk(imageStepForward, mixed, BEFORE).seen, [{ open: true, index: 0 }, { open: true, index: 2 }, { open: false, index: 3 }])
assert.deepEqual(imageStepForward({ stops: mixed, lightbox: { open: true, index: 1 }, stepsRemaining: 0 }), { open: true, index: 2 })
assert.deepEqual(imageStepBackward({ stops: mixed, lightbox: { open: true, index: 1 } }), { open: true, index: 0 })
assert.deepEqual(imageStepForward({ stops: mixed, lightbox: { open: true, index: 3 }, stepsRemaining: 0 }), { open: false, index: 3 }, 'from the QR code Next returns to the slide')

// No sequence: the module never answers, so today's grammar is untouched.
for (const lightbox of [BEFORE, { open: true, index: 1 }, { open: false, index: 2 }]) {
  assert.equal(imageStepForward({ stops: [], lightbox, stepsRemaining: 0 }), null)
  assert.equal(imageStepBackward({ stops: [], lightbox }), null)
}

// The deck inlines this exact source; it must stand alone.
const inlined = new Function(`${imageStepsRuntimeSource()}; return { imageStepStops, imageStepRest, imageStepForward, imageStepBackward }`)()
assert.deepEqual(walk(inlined.imageStepForward, inlined.imageStepStops(true, [still, video, still]), BEFORE).seen,
  [{ open: true, index: 0 }, { open: true, index: 2 }, { open: false, index: 3 }], 'the inlined source decides the same')
console.log('PASS image-steps module: stops, Next, Back, reveal first, Esc, one image, full-bleed')

// ── 2. The setting ───────────────────────────────────────────────────────────
assert.equal(resolveImageSteps({}, {}), false, 'off by default')
assert.equal(resolveImageSteps({}, { image_steps: true }), true, 'talk on (boolean)')
assert.equal(resolveImageSteps({}, { image_steps: 'on' }), true, 'talk on (word)')
assert.equal(resolveImageSteps({}, { 'image-steps': 'yes' }), true, 'talk on (alias)')
assert.equal(resolveImageSteps({ 'image-steps': true }, {}), true, '{image-steps} turns it on for one slide')
assert.equal(resolveImageSteps({ 'image-steps': 'off' }, { image_steps: true }), false, '{no-image-steps} beats a talk that has it on')
assert.equal(resolveImageSteps({ 'image-steps': true }, { image_steps: false }), true, '{image-steps} beats a talk that has it off')
assert.equal(resolveImageSteps({}, { image_steps: 'perhaps' }), false, 'an unreadable value keeps the default')

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const outline = (frontmatter) => ['---', 'title: Image steps probe', 'auto_title_slide: false', 'auto_thanks_slide: false', ...frontmatter, '---', '',
  '## Probe', '',
  '### Plain', '{id=plain}', '', `![a](${PNG})`, `![b](${PNG})`, '',
  '### On', '{image-steps} {id=on}', '', `![a](${PNG})`, `![b](${PNG})`, '',
  '### Off', '{no-image-steps} {id=off}', '', `![a](${PNG})`, `![b](${PNG})`, '',
  '### Words only', '{id=words}', '', '- One', '- Two', ''
].join('\n')
const dir = mkdtempSync(join(tmpdir(), 'tw-image-steps-'))
const compile = async (name, frontmatter = []) => {
  const source = outline(frontmatter)
  const path = join(dir, `${name}.md`)
  writeFileSync(path, source, 'utf8')
  const model = await prepareSource(path, source, 'Image steps probe', statSync(path))
  return { html: model.fullHtml, warnings: (model.warnings ?? []).map(String) }
}
const stamped = (html, id) => {
  const tag = html.match(new RegExp(`<section class="slide"[^>]*data-id="${id}"[^>]*>`))?.[0]
  assert(tag, `slide ${id} is in the deck`)
  return /\sdata-image-steps[\s>]/.test(tag)
}
const stamps = (html) => Object.fromEntries(['plain', 'on', 'off', 'words'].map((id) => [id, stamped(html, id)]))

const unset = await compile('unset')
assert.deepEqual(stamps(unset.html), { plain: false, on: true, off: false, words: false }, 'setting absent: only {image-steps} slides step')
assert.deepEqual(unset.warnings.filter((w) => /image-steps|unknown/i.test(w)), [], `the two tokens raise no warning (${unset.warnings})`)
const talkOn = await compile('talk-on', ['image_steps: true'])
assert.deepEqual(stamps(talkOn.html), { plain: true, on: true, off: false, words: true }, 'talk on: every slide but {no-image-steps}')
const talkOff = await compile('talk-off', ['image_steps: false'])
assert.deepEqual(stamps(talkOff.html), { plain: false, on: true, off: false, words: false }, 'talk off: {image-steps} still wins on its slide')
const talkBad = await compile('talk-bad', ['image_steps: perhaps'])
assert.deepEqual(stamps(talkBad.html), stamps(unset.html), 'an unreadable talk value behaves as unset')
assert(talkBad.warnings.some((w) => /deck-flag-unknown:image_steps/.test(w)), 'an unreadable talk value says so')

// The deck carries the decisions exactly once and no placeholder is left behind.
assert.doesNotMatch(unset.html, /IMAGE_STEPS_RUNTIME/, 'the placeholder is replaced')
assert.equal(unset.html.split('function imageStepForward(').length - 1, 1, 'the deck inlines the module once')
console.log('PASS image-steps setting: slide token, talk key, default off, stamps, no warnings')
