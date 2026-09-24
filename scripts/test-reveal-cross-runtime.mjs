#!/usr/bin/env node
/**
 * Reveal/focus cross-runtime equivalence — the seam string parity cannot reach.
 *
 * Live reveal/focus addresses a unit by its INTEGER INDEX within each side's own enumeration
 * (worker/protocol.ts SlideFocusState.step). Two things must therefore hold for every slide:
 *
 *   1. the presenter deck and the audience handout must enumerate the SAME units,
 *   2. in the SAME order.
 *
 * `test:mode-selector-parity` proves the two selector STRINGS agree. That is necessary but not
 * sufficient: the two runtimes render the same markup under DIFFERENT stylesheets, and the unit
 * filter (`isVisibleUnit`) rejects anything with a `display: none` ancestor. A rule that hides an
 * element in one output but not the other silently shifts every later index — which is exactly the
 * "each part tests green individually but it fails end to end" symptom on record.
 *
 * This test compiles the real layout sampler (every registered layout), builds the handout from
 * that same compiled HTML the way `live:go` does, and compares the two live DOMs
 * element-for-element.
 */
import { strict as assert } from 'node:assert'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { buildLayoutSampler } from './build-layout-sampler.mjs'
import { presenterSelectors, audienceSelectors } from './lib/mode-selectors.mjs'
import { extractSlides, extractStyles } from '../compiler/scripts/lib/04-html-extraction.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/* ---- build both artefacts from ONE compile, exactly as live:go does ---- */
const { html: deckHtml } = await buildLayoutSampler()
const slides = extractSlides(deckHtml)
const styles = extractStyles(deckHtml)
assert(slides.length > 0, 'sampler compiles to slides')

const handoutHtml = buildShareHtml({
  title: 'Reveal cross-runtime test',
  slides,
  styles,
  includeNotes: false,
  slug: 'reveal-cross-runtime-test',
  license: null,
})

const scratch = await mkdtemp(join(tmpdir(), 'talkweaver-reveal-xrt-'))
const deckPath = join(scratch, 'deck.html')
const handoutPath = join(scratch, 'handout.html')
await writeFile(deckPath, deckHtml)
await writeFile(handoutPath, handoutHtml)

/** Enumerate reveal units per slide, applying the same visibility rule both runtimes use. */
function enumerateUnits(selector) {
  const visible = (el) => {
    if (!el || el.classList.contains('hidden-fragment') || el.closest('.hidden-fragment')) return false
    let node = el
    while (node && !(node.classList && node.classList.contains('slide'))) {
      if (node.nodeType === 1 && getComputedStyle(node).display === 'none') return false
      node = node.parentElement
    }
    return true
  }
  const out = {}
  for (const slide of document.querySelectorAll('.slide[data-id]')) {
    const raw = [...slide.querySelectorAll(selector)]
    const units = raw.filter((el, i) => raw.indexOf(el) === i).filter(visible)
    out[slide.dataset.id] = units.map((el) => {
      const cls = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean).sort().join('.')
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40)
      return `${el.tagName.toLowerCase()}|${cls}|${text}`
    })
  }
  return out
}

const browser = await chromium.launch({ headless: true })
let failures = 0
try {
  // Each runtime is driven by ITS OWN selector — that is the whole point of the comparison.
  const deckSelector = presenterSelectors().join(',')
  const handoutSelector = audienceSelectors().join(',')
  const read = async (path, selector) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
    await page.goto(pathToFileURL(path).href)
    await page.waitForTimeout(400)
    const units = await page.evaluate(enumerateUnits, selector)
    await page.close()
    return units
  }

  const deckUnits = await read(deckPath, deckSelector)
  const handoutUnits = await read(handoutPath, handoutSelector)

  const ids = Object.keys(handoutUnits)
  assert(ids.length > 0, 'handout exposes slides with ids')

  let compared = 0
  let withUnits = 0
  for (const id of ids) {
    const a = deckUnits[id]
    const b = handoutUnits[id]
    if (!a) {
      console.error(`FAIL ${id}: slide present in handout but not in the compiled deck`)
      failures++
      continue
    }
    compared++
    if (b.length) withUnits++

    if (a.length !== b.length) {
      console.error(`FAIL ${id}: deck enumerates ${a.length} reveal units, handout enumerates ${b.length}`)
      if (b.length === 0) console.error('      handout finds NONE — reveal/focus following is a no-op on this layout')
      const onlyDeck = a.filter((x) => !b.includes(x)).slice(0, 3)
      for (const x of onlyDeck) console.error(`      only in deck: ${x}`)
      failures++
      continue
    }
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        console.error(`FAIL ${id}: unit ${i} differs between runtimes — every later index is shifted`)
        console.error(`      deck:    ${a[i]}`)
        console.error(`      handout: ${b[i]}`)
        failures++
        break
      }
    }
  }

  console.log(`compared ${compared} slides (${withUnits} carry reveal units) across both runtimes`)
} finally {
  await browser.close()
}

if (failures) {
  console.error(`\nreveal cross-runtime: ${failures} slide(s) disagree — live reveal following will mis-map on them.`)
  process.exit(1)
}
console.log('reveal cross-runtime: deck and handout enumerate identical units in identical order')
