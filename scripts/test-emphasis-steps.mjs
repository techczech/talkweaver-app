// test:emphasis-steps — "Emphasis appears on Next" (0.38 ticket 02)
//
//   1. The deciding module (compiler/assets/runtime/emphasis-steps.js): the order and count of a
//      slide's steps and each unit's state at a step, with no browser. The same source is inlined
//      in the deck and in the handout / venue page.
//   2. What the venue screen is sent, and that it reads back to the same step.
//   3. The compile step: which spans are marked, that the title and structural tags are not, that
//      text is unchanged, and that a slide without the option compiles exactly as before.
// The stepping in a real presenter + projector pair and on the venue page is
// scripts/emphasis-steps-dom.test.mjs.
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  EMPH_STEP_SELECTOR, emphasisStepMax, emphasisStepStates, emphasisWireFocus, emphasisFromWire, emphasisStepsRuntimeSource
} from '../compiler/assets/runtime/emphasis-steps.js'
import { markEmphasisSteps, resolveEmphasisSteps } from '../compiler/scripts/lib/emphasis-steps.mjs'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'
import { renderInline } from '../compiler/scripts/lib/00-inline-render.mjs'

// ── 1. Order, count and states ────────────────────────────────────────────────
const block = { kind: 'block', parent: null }
const emph = (parent = null) => ({ kind: 'emphasis', parent })
/** Every state from step 0 to the last step. */
const walk = (units, mode) => Array.from({ length: emphasisStepMax(units, mode) + 1 }, (_, step) => emphasisStepStates(units, mode, step))

// (a) No mode: only the emphasis spans are steps, in page order; blocks are not stepped.
const paragraph = [block, emph(0), emph(0), block, emph(3)]
assert.equal(emphasisStepMax(paragraph, null), 3, 'no mode: one step per emphasis span')
assert.deepEqual(walk(paragraph, null), [
  [null, 'off', 'off', null, 'off'],
  [null, 'on', 'off', null, 'off'],
  [null, 'on', 'on', null, 'off'],
  [null, 'on', 'on', null, 'on']
], 'no mode: spans turn on one per step in page order; blocks carry no state')
assert.deepEqual(emphasisStepStates(paragraph, null, 99), [null, 'on', 'on', null, 'on'], 'a step past the end reads as the last step')
assert.deepEqual(emphasisStepStates(paragraph, null, -3), [null, 'off', 'off', null, 'off'], 'a step before the start reads as step 0')
assert.equal(emphasisStepMax([emph(), emph()], null), 2, 'spans outside any block unit are steps too')

// (b) Reveal: a block appears, its spans turn on one by one, then the next block.
const list = [block, emph(0), block, emph(2), emph(2)]
assert.equal(emphasisStepMax(list, 'reveal'), 6, 'reveal: every unit is a step, plus the closing step for two or more blocks')
assert.deepEqual(walk(list, 'reveal'), [
  ['hidden', 'off', 'hidden', 'off', 'off'],
  ['current', 'off', 'hidden', 'off', 'off'],
  ['current', 'on', 'hidden', 'off', 'off'],
  ['soft', 'on', 'current', 'off', 'off'],
  ['soft', 'on', 'current', 'on', 'off'],
  ['soft', 'on', 'current', 'on', 'on'],
  ['full', 'on', 'full', 'on', 'on']
], 'reveal: item, its emphasis, next item, its emphasis; the item stays current while its spans turn on')
const single = [block, emph(0), emph(0)]
assert.equal(emphasisStepMax(single, 'reveal'), 3, 'one block: no closing step (it would look the same)')
assert.deepEqual(emphasisStepStates(single, 'reveal', 3), ['full', 'on', 'on'])
assert.deepEqual(emphasisStepStates(single, 'reveal', 1), ['current', 'off', 'off'])
// A {group} list is one block unit followed by its spans in order.
const group = [block, emph(0), emph(0), emph(0)]
assert.deepEqual(walk(group, 'reveal').map((states) => states.slice(1).filter((value) => value === 'on').length), [0, 0, 1, 2, 3],
  'a grouped list appears as one unit, then its emphasis follows span by span')
// A span never shows inside a block that has not appeared, even in a list that puts it first.
assert.deepEqual(emphasisStepStates([emph(1), block], 'reveal', 1), ['off', 'hidden'], 'emphasis in a block that is not shown stays off')

// (c) Focus: the same order; blocks wait blurred instead of hidden.
assert.equal(emphasisStepMax(list, 'focus'), 6)
assert.deepEqual(walk(list, 'focus')[0], ['fuzzy', 'off', 'fuzzy', 'off', 'off'])
assert.deepEqual(walk(list, 'focus')[2], ['current', 'on', 'fuzzy', 'off', 'off'], 'focus: the spans of the unit in focus step before focus moves on')
assert.deepEqual(walk(list, 'focus')[3], ['soft', 'on', 'current', 'off', 'off'])
assert.deepEqual(walk(list, 'focus')[6], ['full', 'on', 'full', 'on', 'on'])

// With no emphasis in the list the counts and states are the modes' own, unchanged.
const legacyMax = (count) => (count <= 1 ? count : count + 1)
const legacyState = (kind, step, count, i) => {
  if (step >= legacyMax(count) && step >= count) return 'full'
  if (step <= 0) return kind === 'focus' ? 'fuzzy' : 'hidden'
  if (i === step - 1) return 'current'
  if (i < step - 1) return 'soft'
  return kind === 'focus' ? 'fuzzy' : 'hidden'
}
for (const kind of ['reveal', 'focus']) {
  for (let count = 0; count <= 5; count += 1) {
    const units = Array.from({ length: count }, () => block)
    assert.equal(emphasisStepMax(units, kind), legacyMax(count), `${kind}, ${count} blocks: the same last step as before`)
    for (let step = 0; step <= legacyMax(count); step += 1) {
      assert.deepEqual(emphasisStepStates(units, kind, step), units.map((_, i) => legacyState(kind, step, count, i)), `${kind}, ${count} blocks, step ${step}: the same states as before`)
    }
  }
}
assert.equal(emphasisStepMax(undefined, 'reveal'), 0)
assert.deepEqual(emphasisStepStates(undefined, null, 2), [])

// ── 2. What the venue screen is sent ──────────────────────────────────────────
// It takes { kind: 'reveal' | 'focus', step } only. A mode's own steps go as they are; emphasis
// steps with no mode on go as kind 'reveal' PAST the reveal order's last step.
for (const units of [paragraph, list, single, group, [emph(), emph()]]) {
  for (const mode of [null, 'reveal', 'focus']) {
    for (let step = 0; step <= emphasisStepMax(units, mode); step += 1) {
      const wire = emphasisWireFocus(units, mode, step)
      assert(wire.kind === 'reveal' || wire.kind === 'focus', 'the wire kind is one the protocol accepts')
      assert(Number.isInteger(wire.step) && wire.step >= 0, 'the wire step is a non-negative integer')
      assert.deepEqual(emphasisFromWire(units, wire), { mode, step }, `mode ${mode} step ${step} survives the wire`)
    }
  }
}
assert.deepEqual(emphasisWireFocus(list, null, 0), { kind: 'reveal', step: 7 }, 'no mode, step 0: one past the reveal order (6) plus one')
assert.deepEqual(emphasisWireFocus(list, 'reveal', 99), { kind: 'reveal', step: 6 }, 'a mode step is clamped, so it can never read as an emphasis-only step')
assert.equal(emphasisFromWire(list, null), null, 'no mode sent: nothing to step (the page shows all emphasis)')
assert.deepEqual(emphasisFromWire(list, { kind: 'reveal', step: 999 }), { mode: null, step: 3 }, 'a far step reads as all emphasis on')

// The runtime source carries every function, and nothing that would break the share page's
// String.raw template.
const source = emphasisStepsRuntimeSource()
for (const name of ['emphasisStepMax', 'emphasisStepStates', 'emphasisWireFocus', 'emphasisFromWire', 'emphasisStepElements', 'emphasisStepUnits', 'paintEmphasisStates', 'stampEmphasisPlainWeight']) {
  assert.match(source, new RegExp(`function ${name}\\(`), `${name} is in the runtime source`)
}
assert.match(source, /const EMPH_STEP_SELECTOR = "\[data-emph-step\]";/)
assert.equal(EMPH_STEP_SELECTOR, '[data-emph-step]')
assert.doesNotMatch(source, /\bexport\b|\bimport\b/, 'the runtime source is plain script')
const evaluated = new Function(`${source}\nreturn { emphasisStepMax, emphasisStepStates, emphasisFromWire };`)()
assert.equal(evaluated.emphasisStepMax(list, 'reveal'), 6, 'the inlined source computes the same count')
assert.deepEqual(evaluated.emphasisStepStates(list, 'reveal', 3), emphasisStepStates(list, 'reveal', 3))

// ── 3. The compile step ───────────────────────────────────────────────────────
assert.equal(resolveEmphasisSteps({ 'emphasis-steps': true }), true)
assert.equal(resolveEmphasisSteps({ 'emphasis-steps': true, nostep: true }), false, '{nostep} switches the steps off')
assert.equal(resolveEmphasisSteps({}), false)
assert.equal(resolveEmphasisSteps(undefined), false)

const text = (html) => html.replace(/<[^>]*>/g, '')
const body = `<p class="content-p">${renderInline('A **bold state-of-the-art phrase**, a ==mark==, an ++underline++, a ~~strike~~ and *italic*.')}</p>`
const marked = markEmphasisSteps(body)
assert.equal(marked.count, 4, 'bold, highlight, underline and strike are steps; italic is not')
assert.match(marked.html, /<strong data-emph-step="bold">/)
assert.match(marked.html, /<mark class="ink-marker" data-emph-step="highlight">mark<\/mark>/)
assert.match(marked.html, /<u data-emph-step="underline">underline<\/u>/)
assert.match(marked.html, /<s data-emph-step="strike">strike<\/s>/)
assert.match(marked.html, /<em>italic<\/em>/, 'italic is left as it was')
assert.equal(text(marked.html), text(body), 'no character of text is added, removed or moved')
assert.deepEqual([...marked.html.matchAll(/<span class="es-w" data-w="([^"]*)">([^<]*)<\/span>/g)].map((m) => [m[1], m[2]]),
  [['bold', 'bold'], ['state-', 'state-'], ['of-', 'of-'], ['the-', 'the-'], ['art', 'art'], ['phrase', 'phrase']],
  'each unbreakable piece of a bold run is one word span carrying its own text; a compound still breaks after its hyphens')
assert.doesNotMatch(marked.html.replace(/<strong data-emph-step[\s\S]*?<\/strong>/g, ''), /es-w/, 'only bold words are wrapped')

const nested = markEmphasisSteps(`<p>${renderInline('==a **b _c_** d== and **say "x" & <y>**')}</p>`)
assert.equal(nested.count, 3)
assert.match(nested.html, /<mark class="ink-marker" data-emph-step="highlight">a <strong data-emph-step="bold"><span class="es-w" data-w="b">b<\/span> <em><span class="es-w" data-w="c">c<\/span><\/em><\/strong> d<\/mark>/,
  'bold inside a highlight is its own step after it; words inside nested italic are wrapped too')
assert.match(nested.html, /data-w="&quot;x&quot;"/, 'a quotation mark in a bold word cannot end the attribute')
assert.match(nested.html, /data-w="&amp;"/)

const structural = '<header class="slide-head"><p class="kicker">K</p><h1>A <strong>bold</strong> title</h1></header>'
  + '<div class="contrast-pair"><span>l</span><strong aria-hidden="true">/</strong><span>r</span></div>'
  + '<h1>Big <strong>title</strong></h1><h2 class="tp-title">Poster <strong>title</strong></h2>'
  + '<svg><text><strong>not prose</strong></text></svg><pre><code><strong>code</strong></code></pre>'
assert.deepEqual(markEmphasisSteps(structural), { html: structural, count: 0 }, 'the title, structural tags and non-prose elements are never steps')
const afterTitle = markEmphasisSteps(`${structural}<p><strong>body</strong></p>`)
assert.equal(afterTitle.count, 1, 'marking resumes after the title and the opaque elements')
assert.match(afterTitle.html, /<p><strong data-emph-step="bold"><span class="es-w" data-w="body">body<\/span><\/strong><\/p>$/)
assert.deepEqual(markEmphasisSteps(''), { html: '', count: 0 })

// A whole talk: the option marks one slide; every other slide is byte-identical to a compile
// without the option anywhere.
const dir = mkdtempSync(join(tmpdir(), 'tw-emphasis-steps-'))
const compile = async (name, lines) => {
  const outline = ['---', 'title: Emphasis steps', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '', ...lines].join('\n')
  const path = join(dir, `${name}.md`)
  writeFileSync(path, outline, 'utf8')
  const out = await prepareSource(path, outline, null, statSync(path), {}, {})
  return { html: out.fullHtml, warnings: out.warnings ?? [] }
}
const section = (html, id) => html.match(new RegExp(`<section class="slide" data-id="${id}"[\\s\\S]*?</section>`))?.[0] ?? ''
const SLIDE = (token) => ['### A **bold** title', `${token} {id=stepped}`.trim(), '', '- One **two** three', '- Four ==five== ++six++ ~~seven~~', '']
const PLAIN = ['### Plain', '{id=plain}', '', '- One **two** ==three== ++four++ ~~five~~', '', '### Reveal', '{reveal} {id=reveal}', '', '- One **two**', '- Three', '']

const on = await compile('on', [...SLIDE('{emphasis-steps}'), ...PLAIN])
const off = await compile('off', [...SLIDE(''), ...PLAIN])
const nostep = await compile('nostep', [...SLIDE('{emphasis-steps} {nostep}'), ...PLAIN])

assert.deepEqual(on.warnings.filter((w) => /emphasis/.test(String(w))), [], '{emphasis-steps} raises no warning')
const stepped = section(on.html, 'stepped')
assert.match(stepped, /<section class="slide"[^>]* data-emphasis-steps[ >]/, 'the slide is stamped')
assert.equal((stepped.match(/data-emph-step=/g) || []).length, 4, 'bold, highlight, underline and strike in the body are marked')
assert.match(stepped, /<h1>A(?:&nbsp;| )<strong>bold<\/strong> title<\/h1>/, 'emphasis in the title is not marked')
assert.equal(text(stepped), text(section(off.html, 'stepped')), 'the slide reads the same with and without the option')

for (const id of ['plain', 'reveal']) {
  assert.equal(section(on.html, id), section(off.html, id), `slide "${id}" (no option) is byte-identical whether or not another slide has it`)
  assert.doesNotMatch(section(on.html, id), /data-emph|es-w|data-emphasis-steps/)
}
assert.doesNotMatch(off.html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, ''), /data-emph-step|data-emphasis-steps|class="es-w"/,
  'a talk without the option carries no emphasis-step markup at all')
assert.equal(section(off.html, 'stepped'), section(nostep.html, 'stepped').replace(' data-nostep', ''),
  '{nostep} beside the option: the slide is exactly the unmarked slide plus data-nostep')

// A carousel: only the cards are marked. The shared line under them belongs to no card, and the
// runtimes step a carousel inside the card on show, so a mark there would never get a step.
const carousel = await compile('carousel', ['### Cards', '{carousel} {emphasis-steps} {id=cards}', '', 'A shared **source** line with ==a mark==', '',
  '#### First', '', '- One has **a**', '', '#### Second', '', '- Two has ++c++', ''])
const cards = section(carousel.html, 'cards')
assert.match(cards, /<p class="slide-source">A shared <strong>source<\/strong> line with <mark class="ink-marker">a mark<\/mark><\/p>/, 'the shared source line is left unmarked')
assert.equal((cards.match(/data-emph-step=/g) || []).length, 2, 'the cards\' own emphasis is marked')
assert.match(cards, /<section class="slide"[^>]* data-emphasis-steps[ >]/)

for (const html of [on.html, off.html]) {
  assert.doesNotMatch(html, /EMPHASIS_STEPS_RUNTIME/, 'the placeholder is replaced')
  assert(html.includes(source), 'the deck inlines the module source verbatim')
}
const share = buildShareHtml({ title: 'Share', slug: 'share', includeNotes: false, license: null, styles: '', slides: [{ html: stepped, notes: '' }] })
assert(share.includes(source), 'the handout / venue page inlines the same module source')

console.log('PASS emphasis steps: order and count for no mode, reveal and focus; the venue projection; the compile step')
