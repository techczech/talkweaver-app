// =============================================================================
// test:slide-foundations — the shared slide-design foundations of ADR-0039 (0.41 ticket 01)
//
// What must hold:
//   1. Extra hues: beside its section accent a slide carries the next two hues of the deck palette's
//      section cycle (cobalt → emerald, vermilion; emerald → vermilion, cobalt; vermilion → cobalt,
//      emerald; green palette forest → vermilion, cobalt). The compiler stamps them per slide
//      (--sec-hue-2/3 and tints) and the skin exposes them as --hue-1/2/3 and --hue-N-tint.
//   2. Subtle box: .subtle-box draws a 2px (at 1920) outline mixed 34% accent into white over a 5%
//      accent fill, in the section accent, the second or third hue, or neutral grey.
//   3. Both are documented in the header of skin/slide-foundations.css.
// (The content band and the section-kicker rule are covered by test:title-regime §7 and §4b.)
//
// Compiles real decks (prepareSource → model.fullHtml) and reads computed styles in Chromium.
// =============================================================================

import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { SECTION_ACCENTS, SECTION_ACCENTS_GREEN, accentForDeckColour, extraHuesForAccent } from '../compiler/scripts/lib/02-triggers-layout.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = mkdtempSync(join(tmpdir(), 'tw-slide-foundations-'))
const HEX = Object.fromEntries([...SECTION_ACCENTS, ...SECTION_ACCENTS_GREEN].map((entry) => [entry.name === 'emerald' && entry.accent === '#15803d' ? 'green-emerald' : entry.name, entry]))

// -----------------------------------------------------------------------------
// 1a. The pure rule: the next two entries of the cycle; an off-cycle accent takes the first two others.
// -----------------------------------------------------------------------------
const names = (pair) => pair.map((entry) => entry.accent)
assert.deepEqual(names(extraHuesForAccent(HEX.cobalt, '')), [HEX.emerald.accent, HEX.vermilion.accent], 'cobalt → emerald, vermilion')
assert.deepEqual(names(extraHuesForAccent(HEX.emerald, '')), [HEX.vermilion.accent, HEX.cobalt.accent], 'emerald → vermilion, cobalt')
assert.deepEqual(names(extraHuesForAccent(HEX.vermilion, '')), [HEX.cobalt.accent, HEX.emerald.accent], 'vermilion → cobalt, emerald')
assert.deepEqual(names(extraHuesForAccent(HEX.forest, 'green')), [HEX.vermilion.accent, HEX.cobalt.accent], 'green palette: forest → vermilion, cobalt')
assert.deepEqual(names(extraHuesForAccent(HEX['green-emerald'], 'green')), [HEX.forest.accent, HEX.vermilion.accent], 'green palette wraps: emerald → forest, vermilion')
const offCycle = accentForDeckColour('forest', '')
assert.deepEqual(names(extraHuesForAccent(offCycle, '')), [HEX.cobalt.accent, HEX.emerald.accent], 'a forest deck colour in the default palette takes cobalt, emerald')
for (const entry of [...SECTION_ACCENTS, ...SECTION_ACCENTS_GREEN]) {
  for (const palette of ['', 'green']) {
    const pair = extraHuesForAccent(entry, palette)
    assert(pair.every((hue) => hue && hue.accent !== entry.accent), `${entry.name} (${palette || 'default'}): the extra hues differ from the accent`)
    assert.notEqual(pair[0].accent, pair[1].accent, `${entry.name} (${palette || 'default'}): the second and third hue differ`)
  }
}
console.log('PASS: extra hues follow the deck palette cycle after the section accent')

// -----------------------------------------------------------------------------
// 1b/2. Compiler stamp and computed values.
// -----------------------------------------------------------------------------
async function compile(name, meta, body) {
  const source = ['---', `title: ${name}`, 'auto_title_slide: false', 'auto_thanks_slide: false', ...meta, '---', '', ...body].join('\n')
  const path = join(dir, `${name.replace(/\W+/g, '-')}.md`)
  writeFileSync(path, source, 'utf8')
  const model = await prepareSource(path, source, name, statSync(path))
  const htmlPath = join(dir, `${name.replace(/\W+/g, '-')}.html`)
  writeFileSync(htmlPath, model.fullHtml, 'utf8')
  return { html: model.fullHtml, htmlPath }
}
const threeSections = ['One', 'Two', 'Three'].flatMap((name) => [`## Part ${name}`, '', `### Slide ${name}`, `{id=s-${name.toLowerCase()}}`, '', '- Alpha', '- Beta', ''])
const plainDeck = await compile('Hue probe', [], threeSections)
const greenDeck = await compile('Green hue probe', ['palette: green'], threeSections)

const stampOf = (html, id) => {
  const match = html.match(new RegExp(`<section class="slide" data-id="${id}"[^>]*style="([^"]*)"`))
  assert(match, `${id} carries an inline section stamp`)
  return Object.fromEntries(match[1].split(';').map((part) => part.split(':').map((side) => side.trim())).filter(([key]) => key))
}
const EXPECT = {
  plain: { 's-one': ['cobalt', 'emerald', 'vermilion'], 's-two': ['emerald', 'vermilion', 'cobalt'], 's-three': ['vermilion', 'cobalt', 'emerald'] },
  green: { 's-one': ['forest', 'vermilion', 'cobalt'], 's-two': ['vermilion', 'cobalt', 'green-emerald'], 's-three': ['cobalt', 'green-emerald', 'forest'] }
}
for (const [deckName, deck] of [['plain', plainDeck], ['green', greenDeck]]) {
  for (const [id, [accent, second, third]] of Object.entries(EXPECT[deckName])) {
    const stamp = stampOf(deck.html, id)
    assert.equal(stamp['--sec-accent'], HEX[accent].accent, `${deckName} ${id}: section accent ${accent}`)
    assert.equal(stamp['--sec-hue-2'], HEX[second].accent, `${deckName} ${id}: second hue ${second}`)
    assert.equal(stamp['--sec-hue-2-tint'], HEX[second].tint, `${deckName} ${id}: second tint ${second}`)
    assert.equal(stamp['--sec-hue-3'], HEX[third].accent, `${deckName} ${id}: third hue ${third}`)
    assert.equal(stamp['--sec-hue-3-tint'], HEX[third].tint, `${deckName} ${id}: third tint ${third}`)
  }
}
console.log('PASS: the compiler stamps the second and third hue on every slide')

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
  for (const [deckName, deck] of [['plain', plainDeck], ['green', greenDeck]]) {
    await page.goto(`file://${deck.htmlPath}`, { waitUntil: 'load' })
    for (const [id, [accent, second, third]] of Object.entries(EXPECT[deckName])) {
      const got = await page.evaluate((slideId) => {
        const slides = [...document.querySelectorAll('.stage > .slide')]
        const slide = slides.find((node) => node.dataset.id === slideId)
        slides.forEach((node) => node.classList.toggle('active', node === slide))
        const cs = getComputedStyle(slide)
        const read = (name) => cs.getPropertyValue(name).trim().toLowerCase()
        return { hue1: read('--hue-1'), hue1Tint: read('--hue-1-tint'), hue2: read('--hue-2'), hue2Tint: read('--hue-2-tint'), hue3: read('--hue-3'), hue3Tint: read('--hue-3-tint') }
      }, id)
      assert.deepEqual(got, {
        hue1: HEX[accent].accent, hue1Tint: HEX[accent].tint,
        hue2: HEX[second].accent, hue2Tint: HEX[second].tint,
        hue3: HEX[third].accent, hue3Tint: HEX[third].tint
      }, `${deckName} ${id}: --hue-1/2/3 resolve on the slide`)
    }
  }
  console.log('PASS: --hue-1/2/3 and their tints resolve per section in the browser')

  // Subtle box: injected into a compiled slide (no layout uses it yet); compared with reference boxes
  // whose colours are written out as literal color-mix() values of the expected hexes.
  await page.goto(`file://${plainDeck.htmlPath}`, { waitUntil: 'load' })
  const boxes = await page.evaluate(({ cobalt, emerald, vermilion }) => {
    const slides = [...document.querySelectorAll('.stage > .slide')]
    const slide = slides.find((node) => node.dataset.id === 's-one')
    slides.forEach((node) => node.classList.toggle('active', node === slide))
    const host = slide.querySelector(':scope > .slide-content')
    const make = (className, style = '') => {
      const node = document.createElement('div')
      node.className = className
      node.textContent = 'Box'
      if (style) node.setAttribute('style', style)
      host.appendChild(node)
      return node
    }
    const read = (node) => {
      const cs = getComputedStyle(node)
      return { border: cs.borderTopColor, fill: cs.backgroundColor, style: cs.borderTopStyle, width: parseFloat(cs.borderTopWidth) }
    }
    const reference = (hex, line, fill) => read(make('', `border: 1px solid color-mix(in srgb, ${hex} ${line}%, #fff); background: color-mix(in srgb, ${hex} ${fill}%, #fff)`))
    const neutralReference = read(make('', 'border: 1px solid rgb(16 20 24 / .26); background: color-mix(in srgb, #101418 2.5%, #fff)'))
    const accentBox = make('subtle-box')
    const k = slide.getBoundingClientRect().width / slide.offsetWidth
    return {
      accent: read(accentBox), accentRef: reference(cobalt, 34, 5),
      second: read(make('subtle-box hue-2')), secondRef: reference(emerald, 34, 5),
      third: read(make('subtle-box hue-3')), thirdRef: reference(vermilion, 34, 5),
      neutral: read(make('subtle-box subtle-box-neutral')), neutralRef: neutralReference,
      screenWidth: parseFloat(getComputedStyle(accentBox).borderTopWidth) * k,
      vars: {
        border: getComputedStyle(slide).getPropertyValue('--subtle-box-border').trim(),
        fill: getComputedStyle(slide).getPropertyValue('--subtle-box-fill').trim()
      }
    }
  }, { cobalt: HEX.cobalt.accent, emerald: HEX.emerald.accent, vermilion: HEX.vermilion.accent })
  for (const key of ['accent', 'second', 'third', 'neutral']) {
    assert.equal(boxes[key].style, 'solid', `${key} subtle box: solid outline`)
    assert.equal(boxes[key].border, boxes[`${key}Ref`].border, `${key} subtle box: outline is 34% hue into white (${boxes[key].border})`)
    assert.equal(boxes[key].fill, boxes[`${key}Ref`].fill, `${key} subtle box: fill is the light hue tint (${boxes[key].fill})`)
  }
  assert(Math.abs(boxes.screenWidth - 2) <= 0.5, `subtle box outline is 2px at 1920 (got ${boxes.screenWidth})`)
  assert.match(boxes.vars.border, /color-mix\(in srgb, #0f4bd8 34%, #fff\)/i, '--subtle-box-border carries the section accent mix')
  assert.match(boxes.vars.fill, /color-mix\(in srgb, #0f4bd8 5%, #fff\)/i, '--subtle-box-fill carries the section accent mix')
  console.log('PASS: .subtle-box draws the 34% outline and 5% fill in the accent, the second and third hue, and neutral')
} finally {
  await browser.close()
}

// -----------------------------------------------------------------------------
// 3. The skin documents what it offers.
// -----------------------------------------------------------------------------
const css = readFileSync(join(repo, 'compiler/assets/styles/skin/slide-foundations.css'), 'utf8')
const header = css.slice(0, css.indexOf('*/'))
for (const term of ['CONTENT BAND', '--band-air', '--band-footer', 'SUBTLE BOX', '.subtle-box', '.hue-2', 'subtle-box-neutral', 'EXTRA HUES', '--hue-2', '--hue-3', '--hue-2-tint']) {
  assert(header.includes(term), `the slide-foundations.css header documents ${term}`)
}
console.log('PASS: skin/slide-foundations.css documents the band, the subtle box and the extra hues')
console.log('slide foundations: extra hues, subtle box and their documentation passed')
