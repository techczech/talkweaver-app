// "Play as a step" (0.38 ticket 05) without a browser: the file as a third kind of unit in the one
// flat step order (compiler/assets/runtime/emphasis-steps.js), which file plays at step n, the wire
// form the venue screen is sent, the listing of a slide's units from its markup, and the compile
// step ({play-on-next} on a file, {nostep}, {autoplay}, an image or an embed, the share markup).
// Playback itself (runtime/media-steps.js) is driven in a real browser by media-steps-dom.test.mjs.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MEDIA_STEP_SELECTOR, stepUnitIsBlock, emphasisStepMax, emphasisStepStates, mediaStepStates, mediaStepPlaying, mediaStepDone, mediaStepQuiet,
  emphasisWireFocus, emphasisFromWire, emphasisStepElements, emphasisStepUnits, mediaStepFiles, emphasisStepsRuntimeSource
} from '../compiler/assets/runtime/emphasis-steps.js'
import { mediaStepsRuntimeSource } from '../compiler/assets/runtime/media-steps.js'
import { resolvePlayOnNext, hasMediaSteps } from '../compiler/scripts/lib/media-steps.mjs'
import { lexMarkdownBlocks } from '../compiler/scripts/lib/03-markdown-lexer.mjs'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { stripAudioElements } from '../compiler/scripts/lib/09-output-builders.mjs'
import { warningDefinition } from '../compiler/scripts/lib/warning-registry.mjs'

const block = { kind: 'block', parent: null }
const file = { kind: 'media', parent: null }          // a file that is its own block
const emph = (parent) => ({ kind: 'emphasis', parent })
const second = (parent) => ({ kind: 'media', parent }) // a second file inside a block

// ── 1. The order and the count ────────────────────────────────────────────────
// No mode: the files (and the emphasis spans) are the slide's only steps, in page order.
{
  const units = [block, file, block, file]
  assert.equal(emphasisStepMax(units, null), 2, 'two files, no mode: two steps')
  assert.deepEqual(mediaStepStates(units, null, 0), [null, 'waiting', null, 'waiting'], 'arrival: nothing has played')
  assert.deepEqual(mediaStepStates(units, null, 1), [null, 'playing', null, 'waiting'], 'the first Next starts the first file')
  assert.deepEqual(mediaStepStates(units, null, 2), [null, 'played', null, 'playing'], 'the next stops it and starts the second')
  assert.deepEqual(mediaStepStates(units, null, 3), [null, 'played', null, 'played'], 'a step past the last is the slide finished: nothing plays')
  assert.deepEqual(emphasisStepStates(units, null, 1), [null, null, null, null], 'with no mode nothing is hidden, a file included')
  assert.equal(mediaStepPlaying(units, null, 0), -1)
  assert.equal(mediaStepPlaying(units, null, 1), 1)
  assert.equal(mediaStepPlaying(units, null, 2), 3)
}
// A slide with one file and nothing else: one step, then the next slide.
assert.equal(emphasisStepMax([file], null), 1)
assert.equal(emphasisStepMax([block, block], null), 0, 'a slide with no file and no emphasis has no step of its own')

// With {emphasis-steps}: files and emphasis spans interleave in page order.
{
  const units = [block, emph(0), file, block, emph(3)]
  assert.equal(emphasisStepMax(units, null), 3)
  assert.deepEqual(emphasisStepStates(units, null, 1), [null, 'on', null, null, 'off'])
  assert.deepEqual(mediaStepStates(units, null, 1), [null, null, 'waiting', null, null], 'the emphasis before the file comes first')
  assert.deepEqual(mediaStepStates(units, null, 2), [null, null, 'playing', null, null])
  assert.deepEqual(emphasisStepStates(units, null, 2), [null, 'on', null, null, 'off'], 'the file takes a step of its own: the next span is still off')
  assert.deepEqual(mediaStepStates(units, null, 3), [null, null, 'played', null, null])
  assert.deepEqual(emphasisStepStates(units, null, 3), [null, 'on', null, null, 'on'])
}

// Reveal: a file is its own block. The step that shows it starts it; the next one stops it.
{
  const units = [block, file, block]
  assert.equal(emphasisStepMax(units, 'reveal'), 4, 'three blocks and the closing step, exactly as three plain blocks count')
  assert.deepEqual(emphasisStepStates(units, 'reveal', 1), ['current', 'hidden', 'hidden'])
  assert.deepEqual(mediaStepStates(units, 'reveal', 1), [null, 'waiting', null], 'hidden and not started')
  assert.deepEqual(emphasisStepStates(units, 'reveal', 2), ['soft', 'current', 'hidden'], 'the file appears…')
  assert.deepEqual(mediaStepStates(units, 'reveal', 2), [null, 'playing', null], '…and that same step starts it')
  assert.deepEqual(mediaStepStates(units, 'reveal', 3), [null, 'played', null], 'the next block stops it')
  assert.deepEqual(emphasisStepStates(units, 'reveal', 4), ['full', 'full', 'full'])
  assert.deepEqual(mediaStepStates(units, 'reveal', 4), [null, 'played', null])
  assert.deepEqual(emphasisStepStates(units, 'focus', 0), ['fuzzy', 'fuzzy', 'fuzzy'], 'focus dims a waiting file like any block')
  assert.deepEqual(mediaStepStates(units, 'focus', 2), [null, 'playing', null])
  // The same list with a plain block in the file's place counts and paints the same.
  const plain = [block, block, block]
  for (let step = 0; step <= 4; step += 1) {
    assert.deepEqual(emphasisStepStates(units, 'reveal', step), emphasisStepStates(plain, 'reveal', step), `step ${step}: a file steps as a block does`)
  }
}
// A file as the last of the blocks is still playing at the last block step; the closing step stops it.
assert.deepEqual(mediaStepStates([block, file], 'reveal', 2), [null, 'playing'])
assert.deepEqual(mediaStepStates([block, file], 'reveal', 3), [null, 'played'])
// The only block: there is no closing step, so the file plays until Next leaves the slide.
assert.equal(emphasisStepMax([file], 'reveal'), 1)
assert.deepEqual(mediaStepStates([file], 'reveal', 1), ['playing'])
// A second file inside one block is a step of its own after the block, and is never hidden by itself.
{
  const units = [file, second(0), block]
  assert.equal(stepUnitIsBlock(units[0]), true)
  assert.equal(stepUnitIsBlock(units[1]), false)
  assert.equal(emphasisStepMax(units, 'reveal'), 4, 'two blocks, the second file, the closing step')
  assert.deepEqual(emphasisStepStates(units, 'reveal', 2), ['current', null, 'hidden'])
  assert.deepEqual(mediaStepStates(units, 'reveal', 1), ['playing', 'waiting', null])
  assert.deepEqual(mediaStepStates(units, 'reveal', 2), ['played', 'playing', null])
  assert.equal(emphasisStepMax(units, null), 2)
}
// At most one file plays at any step, in every mode.
for (const mode of [null, 'reveal', 'focus']) {
  const units = [block, emph(0), file, second(2), block, file, emph(5)]
  for (let step = 0; step <= emphasisStepMax(units, mode); step += 1) {
    const states = mediaStepStates(units, mode, step)
    assert(states.filter((state) => state === 'playing').length <= 1, `mode ${mode} step ${step}: one file at most`)
    const playing = states.indexOf('playing')
    states.forEach((state, i) => {
      if (state == null) return
      if (playing >= 0) assert.equal(state, i < playing ? 'played' : i === playing ? 'playing' : 'waiting', `mode ${mode} step ${step}: files before the playing one are played, files after it wait`)
    })
  }
}

// ── 1b. A file starts only on Next ────────────────────────────────────────────
// Entered backwards, a slide lands finished: one step past the last where the last is a file's own.
{
  assert.equal(mediaStepDone([block, file], null), 2, 'the last step plays the file: land one past it')
  assert.deepEqual(mediaStepStates([block, file], null, mediaStepDone([block, file], null)), [null, 'played'])
  assert.deepEqual(emphasisStepStates([block, emph(0), file], null, 3), [null, 'on', null], 'and all emphasis is on there')
  assert.equal(mediaStepDone([block, file, emph(0)], null), 2, 'the last step is emphasis: the last step itself is already quiet')
  assert.equal(mediaStepDone([block, emph(0)], null), 1, 'a slide without a file lands where it always did')
  assert.equal(mediaStepDone([block, file, block], 'reveal'), 4, 'Reveal with a closing step: the closing step, where nothing plays')
  assert.equal(mediaStepDone([file], 'reveal'), 2, 'Reveal with the file as the only block: one past it')
  assert.deepEqual(emphasisStepStates([file], 'reveal', 2), ['full'], 'shown in full there')
  assert.deepEqual(mediaStepStates([file], 'reveal', 2), ['played'])
  for (const mode of [null, 'reveal', 'focus']) {
    for (const units of [[file], [block, file], [file, second(0)], [block, emph(0), file, block, file], [block, file, block]]) {
      assert.equal(mediaStepPlaying(units, mode, mediaStepDone(units, mode)), -1, 'nothing ever plays where a backwards arrival lands')
    }
  }
}
// Back inside a slide never lands on a step at which a file plays.
{
  const units = [block, emph(0), file, file, emph(0)]   // no mode: span, file, file, span
  assert.equal(mediaStepQuiet(units, null, 4), 4)
  assert.equal(mediaStepQuiet(units, null, 3), 1, 'both file steps are passed over, down to the span before them')
  assert.equal(mediaStepQuiet(units, null, 2), 1)
  assert.equal(mediaStepQuiet(units, null, 1), 1)
  assert.equal(mediaStepQuiet([file], null, 1), 0, 'down to the slide as it arrived')
  assert.equal(mediaStepQuiet([block, file, block], 'reveal', 2), 1, 'Reveal: the file is hidden again rather than started')
  assert.equal(mediaStepQuiet([block, block], 'reveal', 2), 2, 'a slide without a file: Back lands on every step')
  for (let step = 0; step <= 6; step += 1) assert.equal(mediaStepPlaying(units, 'reveal', mediaStepQuiet(units, 'reveal', step)), -1)
}

// ── 2. The wire: the same {kind, step} the venue screen already receives ──────
{
  const units = [block, file, block, emph(2)]
  for (const mode of [null, 'reveal', 'focus']) {
    for (let step = 0; step <= emphasisStepMax(units, mode); step += 1) {
      const wire = emphasisWireFocus(units, mode, step)
      assert.deepEqual(Object.keys(wire).sort(), ['kind', 'step'], 'no new field')
      assert(wire.kind === 'reveal' || wire.kind === 'focus')
      assert(Number.isInteger(wire.step) && wire.step >= 0)
      const back = emphasisFromWire(units, wire)
      assert.deepEqual(back, { mode, step }, `mode ${mode} step ${step} survives the wire`)
      assert.deepEqual(mediaStepStates(units, back.mode, back.step), mediaStepStates(units, mode, step), 'the venue reads the same file state')
    }
  }
  assert.deepEqual(emphasisWireFocus(units, null, 1), { kind: 'reveal', step: 7 }, 'no mode: past the reveal order (5), plus one, plus the step')
  assert.deepEqual(emphasisWireFocus([file], null, 1), { kind: 'reveal', step: 3 })
  assert.deepEqual(emphasisFromWire([file], { kind: 'reveal', step: 3 }), { mode: null, step: 1 })
  // Finished after a backwards arrival: one past the no-mode range, in every mode, and the venue
  // reads every file as played from it.
  for (const mode of [null, 'reveal', 'focus']) {
    for (const list of [[file], [block, file], [block, emph(0), file]]) {
      const done = mediaStepDone(list, mode)
      if (done === emphasisStepMax(list, mode)) continue
      const wire = emphasisWireFocus(list, mode, done)
      assert.deepEqual(wire, { kind: 'reveal', step: emphasisStepMax(list, 'reveal') + 1 + emphasisStepMax(list, null) + 1 })
      const back = emphasisFromWire(list, wire)
      assert.equal(back.mode, null)
      assert.equal(mediaStepPlaying(list, back.mode, back.step), -1, 'the venue plays nothing')
      assert.deepEqual(mediaStepStates(list, back.mode, back.step).filter(Boolean), ['played'])
      assert(emphasisStepStates(list, back.mode, back.step).every((state) => state == null || state === 'on'), 'and shows everything')
      assert.notDeepEqual(wire, emphasisWireFocus(list, mode, emphasisStepMax(list, mode)), 'it is not the playing step')
    }
  }
  assert.deepEqual(emphasisWireFocus([block, emph(0)], null, 99), { kind: 'reveal', step: 4 }, 'a slide without a file clamps a far step as before (reveal order 2, + 1, + its one span)')
}

// ── 3. Listing a slide's units from its markup ────────────────────────────────
// A stand-in for the three DOM calls the listing makes (querySelectorAll, hasAttribute, parentElement).
function el(name, attrs = {}, children = []) {
  const node = {
    name, attrs, children, parentElement: null,
    hasAttribute: (key) => key in attrs,
    querySelectorAll(selector) {
      const out = []
      const walk = (n) => n.children.forEach((child) => {
        const hit = (selector.includes('.block') && child.attrs.block)
          || (selector.includes('[data-emph-step]') && 'data-emph-step' in child.attrs)
          || (selector.includes(MEDIA_STEP_SELECTOR) && 'data-play-on-next' in child.attrs)
        if (hit) out.push(child)
        walk(child)
      })
      walk(node)
      return out
    }
  }
  children.forEach((child) => { child.parentElement = node })
  return node
}
const BLOCK = { block: true }
const FILE = { 'data-play-on-next': '' }
const SPAN = { 'data-emph-step': 'bold' }
{
  // A video figure that is a block unit, a chip in the text flow, a chip inside a list item.
  const figure = el('figure', { ...BLOCK, ...FILE })
  const chip = el('chip', FILE)
  const innerChip = el('chip-in-item', FILE)
  const item = el('li', BLOCK, [el('strong', SPAN), innerChip])
  const para = el('p', BLOCK)
  const slide = el('slide', {}, [para, figure, chip, item])
  const els = emphasisStepElements(slide, '.block', null)
  assert.deepEqual(els.map((e) => e.name), ['p', 'figure', 'chip', 'li', 'strong'], 'the chip inside the item is not listed: the item is its unit')
  const units = emphasisStepUnits(els)
  assert.deepEqual(units.map((u) => u.kind), ['block', 'media', 'media', 'media', 'emphasis'])
  assert.deepEqual(units.map((u) => u.parent), [null, null, null, null, 3])
  assert.deepEqual(mediaStepFiles(els).map((f) => f && f.name), [null, 'figure', 'chip', 'chip-in-item', null], 'each unit names the file it plays')
  assert.equal(emphasisStepMax(units, null), 4, 'three files and one span')
  assert.equal(emphasisStepMax(units, 'reveal'), 6, 'five units and the closing step')
  // Without a block list (a carousel title card) a file is still a step.
  assert.deepEqual(emphasisStepUnits(emphasisStepElements(slide, '', null)).map((u) => u.kind), ['media', 'media', 'emphasis', 'media'])
}
{
  // Two files in one block: the first is the block's own step, the second a step after it.
  const one = el('one', FILE)
  const two = el('two', FILE)
  const cell = el('cell', BLOCK, [one, two])
  const els = emphasisStepElements(el('slide', {}, [cell]), '.block', null)
  assert.deepEqual(els.map((e) => e.name), ['cell', 'two'])
  assert.deepEqual(emphasisStepUnits(els), [{ kind: 'media', parent: null }, { kind: 'media', parent: 0 }])
  assert.deepEqual(mediaStepFiles(els).map((f) => f.name), ['one', 'two'])
}
{
  // A file that is not laid out is not a step.
  const hidden = el('hidden', FILE)
  const shown = el('shown', FILE)
  const els = emphasisStepElements(el('slide', {}, [hidden, shown]), '.block', (e) => e !== hidden)
  assert.deepEqual(els.map((e) => e.name), ['shown'])
}
// A slide without the option lists exactly what it listed before.
{
  const slide = el('slide', {}, [el('p', BLOCK, [el('strong', SPAN)]), el('figure', BLOCK)])
  const els = emphasisStepElements(slide, '.block', null)
  assert.deepEqual(emphasisStepUnits(els), [{ kind: 'block', parent: null }, { kind: 'emphasis', parent: 0 }, { kind: 'block', parent: null }])
  assert.deepEqual(mediaStepFiles(els), [null, null, null])
}

// ── 4. The runtime sources are plain script, safe inside the share page's template ──
for (const source of [emphasisStepsRuntimeSource(), mediaStepsRuntimeSource()]) {
  assert.doesNotMatch(source, /\bexport\b|\bimport\b/, 'plain script')
  assert.doesNotMatch(source, /`|\$\{/, 'no backtick and no ${ : the share page inlines it in a template literal')
}
for (const name of ['stepUnitIsBlock', 'mediaStepStates', 'mediaStepPlaying', 'mediaStepDone', 'mediaStepQuiet', 'mediaStepHolder', 'mediaStepFile', 'mediaStepFiles']) {
  assert.match(emphasisStepsRuntimeSource(), new RegExp(`function ${name}\\(`), `${name} is in the step-order source`)
}
assert.match(emphasisStepsRuntimeSource(), /const MEDIA_STEP_SELECTOR = "\[data-play-on-next\]";/)
const inlined = new Function(`${emphasisStepsRuntimeSource()}\nreturn { mediaStepStates, emphasisStepMax };`)()
assert.deepEqual(inlined.mediaStepStates([block, file, block], 'reveal', 2), [null, 'playing', null], 'the inlined source reads the same step')
assert.match(mediaStepsRuntimeSource(), /function createMediaStepController\(/)
assert.match(mediaStepsRuntimeSource(), /function paintMediaStepMarks\(/)

// ── 5. The compile step ───────────────────────────────────────────────────────
// The lexer: the token is a flag on a video or audio file, and only carried on anything else.
{
  const [video, audio, image, plain, directive, player] = lexMarkdownBlocks([
    '![clip](a.mp4){play-on-next}', '', '![Theme](a.mp3){loop} {Play-On-Next}', '', '![pic](a.png){play-on-next}', '',
    '![clip](a.mp4){loop}', '', '[Video: a.webm]{play-on-next}', '', '[Video: https://youtu.be/dQw4w9WgXcQ] {play-on-next}'
  ])
  assert.deepEqual(video.flags, { playOnNext: true })
  assert.deepEqual(audio.flags, { loop: true, playOnNext: true })
  assert.deepEqual([image.type, image.playOnNext], ['image', true])
  assert.deepEqual(plain.flags, { loop: true }, 'a file without the option is lexed as before')
  assert.deepEqual([directive.type, directive.flags], ['video', { playOnNext: true }])
  assert.deepEqual([player.type, player.playOnNext], ['embed', true])
  const [bare, bareImage] = lexMarkdownBlocks(['[Video: a.webm]', '', '![pic](a.png)'])
  assert.deepEqual(bare, { type: 'video', src: 'a.webm' }, 'a [Video:] line without the token is the block it always was')
  assert.equal('playOnNext' in bareImage, false)
}
// Settling one slide.
{
  const warnings = []
  const warn = (w) => warnings.push(w)
  const blocks = () => [
    { type: 'video', src: 'assets/a.mp4', flags: { playOnNext: true, autoplay: true, loop: true } },
    { type: 'cards', cards: [{ blocks: [{ type: 'audio', src: 'assets/t.mp3', flags: { playOnNext: true } }] }] },
    { type: 'image', src: 'assets/p.png', playOnNext: true },
    { type: 'embed', variant: 'video', src: 'https://www.youtube-nocookie.com/embed/x', playOnNext: true },
    { type: 'video', src: 'assets/b.mp4', flags: { autoplay: true } }
  ]
  const on = blocks()
  resolvePlayOnNext(on, { noStep: false, slideId: 's1' }, warn)
  assert.deepEqual(on[0].flags, { playOnNext: true, loop: true }, '{play-on-next} wins over {autoplay}')
  assert.deepEqual(on[1].cards[0].blocks[0].flags, { playOnNext: true }, 'a file inside a card is settled too')
  assert.equal('playOnNext' in on[2], false)
  assert.equal('playOnNext' in on[3], false)
  assert.deepEqual(on[4].flags, { autoplay: true }, 'a file without the option is untouched')
  assert.deepEqual(warnings, ['play-on-next-autoplay:s1:a.mp4', 'play-on-next-ignored:s1:p.png', 'play-on-next-ignored:s1:an embedded player'])
  resolvePlayOnNext(on, { noStep: false, slideId: 's1' }, warn)
  assert.equal(warnings.length, 3, 'settling twice says nothing new')
  warnings.length = 0
  const off = blocks()
  resolvePlayOnNext(off, { noStep: true, slideId: 's2' }, warn)
  assert.deepEqual(off[0].flags, { autoplay: true, loop: true }, '{nostep}: the file is a file without the option, so its {autoplay} stands')
  assert.deepEqual(off[1].cards[0].blocks[0].flags, {})
  assert.deepEqual(warnings, [], '{nostep} says nothing')
}
for (const code of ['play-on-next-autoplay', 'play-on-next-ignored']) assert(warningDefinition(`${code}:s:x`), `${code} is in the warning registry`)

// A real compile.
const dir = await mkdtemp(join(tmpdir(), 'tw-media-steps-'))
await mkdir(join(dir, 'assets'), { recursive: true })
await writeFile(join(dir, 'assets', 'a.wav'), Buffer.alloc(64))
await writeFile(join(dir, 'assets', 'v.webm'), Buffer.alloc(64))
await writeFile(join(dir, 'assets', 'p.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'))
const compile = async (name, body) => {
  const outline = ['---', 'title: Media steps', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '', ...body].join('\n')
  const path = join(dir, `${name}.md`)
  await writeFile(path, outline, 'utf8')
  return prepareSource(path, outline, null, await stat(path), {}, {})
}
const body = (token, nostep = '') => [
  '### Video', `{id=video} ${nostep}`, '', 'Words.', '', `![clip](assets/v.webm)${token}`, '',
  '### Audio', `{id=audio} ${nostep}`, '', 'Words.', '', `![Theme](assets/a.wav)${token}`, '',
  '### Auto', `{id=auto} ${nostep}`, '', `![clip](assets/v.webm)${token}{autoplay}`, '', `![Theme](assets/a.wav){autoplay}${token}`, ''
]
const section = (html, id) => html.match(new RegExp(`<section class="slide" data-id="${id}"[\\s\\S]*?</section>`))[0]
const on = await compile('on', body('{play-on-next}'))
const off = await compile('off', body(''))
const nostep = await compile('nostep', body('{play-on-next}', '{nostep}'))
const nostepOff = await compile('nostep-off', body('', '{nostep}'))
{
  const video = section(on.fullHtml, 'video')
  assert.match(video, /^<section[^>]* data-media-steps[\s>]/, 'the slide says it has a file step')
  assert.match(video, /<figure class="slide-figure slide-video" data-play-on-next[\s>]/)
  assert.match(video, /<video controls preload="metadata" src=/, 'the video arrives as a manual clip: paused on its first frame')
  assert.equal(hasMediaSteps(video), true)
  const audio = section(on.fullHtml, 'audio')
  assert.match(audio, /^<section[^>]* data-media-steps[\s>]/)
  assert.match(audio, /<div class="slide-audio" data-audio-state="ready" data-play-on-next /)
  const auto = section(on.fullHtml, 'auto')
  assert.doesNotMatch(auto, /<video[^>]* autoplay/, '{play-on-next} wins: the video does not start with the slide')
  assert.doesNotMatch(auto, /data-audio-autoplay/, '…and neither does the chip')
  assert.deepEqual(on.warnings.filter((w) => w.startsWith('play-on-next')), ['play-on-next-autoplay:auto:v.webm', 'play-on-next-autoplay:auto:a.wav'])
  assert.deepEqual(on.warnings.filter((w) => /unknown-trigger|unresolved-trigger/.test(w)), [], 'the token is known')
}
{
  // The option absent: no new attribute anywhere.
  assert.doesNotMatch(off.fullHtml.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ''), /data-play-on-next|data-media-steps|data-media-step|media-step-/)
  assert.deepEqual(off.warnings.filter((w) => w.startsWith('play-on-next')), [])
  assert.equal(hasMediaSteps(section(off.fullHtml, 'video')), false)
  // {nostep}: every slide is byte for byte the slide it is without the option.
  for (const id of ['video', 'audio', 'auto']) assert.equal(section(nostep.fullHtml, id), section(nostepOff.fullHtml, id), `{nostep} ${id}: the file behaves as a file without the option`)
  assert.match(section(nostep.fullHtml, 'auto'), /<video autoplay /, '{nostep}: {autoplay} stands')
  assert.deepEqual(nostep.warnings.filter((w) => w.startsWith('play-on-next')), [])
}
{
  const other = await compile('other', ['### Image', '{id=image}', '', '![pic](assets/p.png){play-on-next}', '', '### Player', '{id=player}', '', '[Video: https://youtu.be/dQw4w9WgXcQ]{play-on-next}', ''])
  assert.deepEqual(other.warnings.filter((w) => w.startsWith('play-on-next')), ['play-on-next-ignored:image:p.png', 'play-on-next-ignored:player:an embedded player'])
  assert.doesNotMatch(other.fullHtml.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ''), /data-play-on-next|data-media-steps/, 'nothing is marked on an image or a player')
  assert.match(section(other.fullHtml, 'player'), /<iframe /, 'the player is still an embed')
}
// The share markup: the venue screen keeps the <audio> of a {play-on-next} chip and no other.
{
  const chip = (attrs) => `<div class="slide-audio" data-audio-state="ready"${attrs} role="group"><span class="slide-audio-title">T</span><audio preload="none" src="data:audio/wav;base64,AAAA"></audio></div>`
  const html = `<p>a</p>${chip(' data-play-on-next')}<p>b</p>${chip('')}${chip(' data-audio-autoplay')}`
  assert.equal((stripAudioElements(html).match(/<audio/g) || []).length, 0, 'a handout or a phone carries no audio')
  const venue = stripAudioElements(html, { keepPlayOnNext: true })
  assert.equal((venue.match(/<audio/g) || []).length, 1)
  assert.match(venue, /data-play-on-next role="group">.*?<audio preload="none"/)
  assert.equal(stripAudioElements(`<p>a</p>${chip('')}`, { keepPlayOnNext: true }), stripAudioElements(`<p>a</p>${chip('')}`), 'a page without the option is the same either way')
}

console.log('PASS media steps: the file as a unit of the flat order (no mode, reveal, focus, with emphasis), one file playing at most, the wire, listing units from markup, the compile step, the share markup')
