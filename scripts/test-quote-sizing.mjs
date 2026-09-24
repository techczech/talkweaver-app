// =============================================================================
// Quote sizing — ADR-0023 §9 (Composition Ticket 20)
//
// The contract this guards, on the real sampler deck rendered in Chromium:
//   1. every quote-only panel has ONE width (±1px); every panel that fits at base has ONE computed
//      type size at a viewport;
//   2. a quote that does not fit is split at compile time: the 887-character fixture yields ≥2
//      slides with ids `<id>--2`, `<id>--3`, …, same nav title, role content after the first;
//   3. the cite renders on the LAST part only; every earlier part carries the "n / N" mark;
//   4. no part overflows the fit box at 1600×900 or 1280×720, the runtime never steps or widens
//      ("stepped"/"wide" no longer exist), and whole-slide zoom is 1;
//   5. T20b: a quote overflowing the measured capacity by ≤ 15% stays ONE slide — the 226-character
//      single sentence is one part and may render `data-quote-fit="fallback"` (type ≥ 31px, never
//      more than the soft-overflow step below base); no non-final part is shorter than 40% of the
//      cite-less capacity (the McCarthy 1955 one-sentence quote does not split);
//   6. the panel is vertically balanced above the fixed chrome band;
//   7. the image-quote keeps the constant type (≥31px) and emits quote-too-long when it cannot fit;
//   8. mutation: with the splitter silenced (TW_REINSTATE_QUOTE_DEFECT=1) this gate FAILS, and with
//      the minimum-part rule silenced (TW_REINSTATE_QUOTE_MIN_PART_DEFECT=1) it FAILS too.
// =============================================================================
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { buildLayoutSampler } from './build-layout-sampler.mjs'
import { partSizeRatio, QUOTE_MIN_PART_RATIO, QUOTE_SOFT_OVERFLOW_RATIO, splitQuoteParagraphs } from '../compiler/scripts/lib/quote-layout.mjs'

const QUOTE_IDS = ['quote-width-100', 'quote-width-220', 'quote-width-330', 'quote-width-600', 'quote-width-900']
const IMAGE_QUOTE_IDS = ['image-quote-width-short', 'image-quote-width-long']
const VIEWPORTS = [
  { width: 1600, height: 900 },
  { width: 1280, height: 720 }
]
const isMutant = process.env.TW_REINSTATE_QUOTE_DEFECT === '1' || process.env.TW_REINSTATE_QUOTE_MIN_PART_DEFECT === '1'

const { model, html, outPath } = await buildLayoutSampler()

// --- compile-time contract ---------------------------------------------------------------------
const partsOf = (baseId) => model.slides.filter((slide) => slide.id === baseId || slide.id.startsWith(`${baseId}--`))
for (const id of [...QUOTE_IDS, ...IMAGE_QUOTE_IDS]) {
  assert(html.includes(`data-id="${id}"`), `${id}: sampler fixture compiles`)
}
const longestParts = partsOf('quote-width-900')
assert(longestParts.length >= 2, `quote-width-900 splits into continuation slides (got ${longestParts.length})`)
assert.equal(longestParts[1].id, 'quote-width-900--2', 'continuation ids use the `--N` separator')
longestParts.forEach((slide, index) => {
  assert.equal(slide.id, index === 0 ? 'quote-width-900' : `quote-width-900--${index + 1}`, 'continuation ids are sequential')
  assert.equal(slide.navTitle, longestParts[0].navTitle, 'continuation slides keep the nav title')
  assert.equal(slide.layout, 'quote', 'continuation slides are quote slides')
  if (index > 0) assert.equal(slide.role, 'content', 'continuation slides take the content role')
  const block = slide.blocks[0]
  assert.equal(block.quotePart.index, index + 1)
  assert.equal(block.quotePart.count, longestParts.length)
  const isLast = index === longestParts.length - 1
  assert.equal(Boolean(block.cite), isLast, `${slide.id}: cite on the last part only`)
})
const joined = longestParts.map((slide) => slide.blocks[0].paragraphs.join(' ')).join(' ')
const source = readFileSync(new URL('../docs/layout-sampler-outline.md', import.meta.url), 'utf8')
const authored = source.match(/\{id=quote-width-900\}\n\n> ([^\n]+)/)[1]
assert.equal(joined, authored, 'the parts concatenate back to the authored quotation, nothing lost or duplicated')
assert(
  !(model.warnings ?? []).some((warning) => warning.startsWith('quote-too-long:quote-width')),
  'no split quote-only fixture warns quote-too-long'
)

// T20b: soft overflow stays one slide; no tiny non-final parts.
assert.equal(partsOf('quote-width-220').length, 1, 'the 226-character single-sentence quote stays one slide (soft overflow ≤ 15%)')
for (const base of QUOTE_IDS) {
  const parts = partsOf(base)
  parts.slice(0, -1).forEach((slide) => {
    const ratio = partSizeRatio(slide.blocks[0].paragraphs)
    assert(ratio >= QUOTE_MIN_PART_RATIO, `${slide.id}: non-final part is ${(ratio * 100).toFixed(0)}% of capacity, below the ${QUOTE_MIN_PART_RATIO * 100}% minimum`)
  })
}
assert.equal(partsOf('quote-width-330').length, 2, 'the 326-character quote splits in two')
const MCCARTHY = 'The study is to proceed on the basis of the conjecture that **every aspect of learning or any other feature of intelligence** can in principle be so precisely described that a **machine can be made to simulate it**.'
assert.equal(splitQuoteParagraphs([MCCARTHY], { hasCite: true }).length, 1, 'McCarthy 1955 (one sentence, two bold spans) stays one slide')

const quoteCss = readFileSync(new URL('../compiler/assets/styles/layouts/quote.css', import.meta.url), 'utf8')
const mediaCss = readFileSync(new URL('../compiler/assets/styles/layouts/media.css', import.meta.url), 'utf8')
assert.doesNotMatch(quoteCss, /--quote-panel-width/, 'quote-only CSS carries no width ramp variable')
assert.doesNotMatch(mediaCss, /--quote-panel-width/, 'image-quote CSS carries no width ramp variable')
assert.doesNotMatch(html, /data-quote-panel-cqw/, 'the deck carries no per-quote panel width')

// --- rendered contract -------------------------------------------------------------------------
const quoteSlideIds = model.slides
  .filter((slide) => slide.layout === 'quote' && slide.blocks.length === 1 && slide.blocks[0].type === 'quote')
  .filter((slide) => QUOTE_IDS.some((id) => slide.id === id || slide.id.startsWith(`${id}--`)))
  .map((slide) => slide.id)

const browser = await chromium.launch({ headless: true })
try {
  for (const viewport of VIEWPORTS) {
    const page = await browser.newPage({ viewport })
    await page.goto(pathToFileURL(outPath).href, { waitUntil: 'load' })
    await page.evaluate(() => document.fonts?.ready)

    const metrics = []
    for (const id of quoteSlideIds) {
      const metric = await page.evaluate((slideId) => {
        const slides = [...document.querySelectorAll('.stage > .slide')]
        const slide = slides.find((candidate) => candidate.dataset.id === slideId)
        if (!slide) return null
        slides.forEach((candidate) => candidate.classList.toggle('active', candidate === slide))
        window.__autofitForTest?.()
        const panel = slide.querySelector('.layout-quote > blockquote')
        const content = slide.querySelector('.slide-content')
        const panelRect = panel.getBoundingClientRect()
        const stage = slide.parentElement
        const stageRect = stage.getBoundingClientRect()
        const footer = document.querySelector('.footer')
        const footerStyle = getComputedStyle(footer)
        const chromeBandPx = parseFloat(footerStyle.minHeight) + parseFloat(footerStyle.bottom)
        const style = getComputedStyle(panel)
        const slideStyle = getComputedStyle(slide)
        const availableHeight = slide.clientHeight - parseFloat(slideStyle.paddingTop) - parseFloat(slideStyle.paddingBottom)
        const paragraphs = [...panel.querySelectorAll(':scope > p')]
        const textPx = paragraphs.reduce((sum, p) => sum + p.getBoundingClientRect().height, 0)
        const mark = panel.querySelector('.quote-continuation')
        return {
          id: slideId,
          chars: Number(panel.dataset.quoteChars),
          part: panel.dataset.quotePart ? `${panel.dataset.quotePart}/${panel.dataset.quoteParts}` : '1/1',
          fit: panel.dataset.quoteFit || 'base',
          fontPx: parseFloat(style.fontSize),
          renderedLines: Math.round(textPx / parseFloat(style.lineHeight)),
          panelWidthPx: panelRect.width,
          panelHeightPx: panelRect.height,
          stageHeightPx: stageRect.height,
          topAirPx: panelRect.top - stageRect.top,
          bottomAirPx: stageRect.bottom - chromeBandPx - panelRect.bottom,
          contentZoom: Number(getComputedStyle(content).zoom || 1),
          coverage: panelRect.height / availableHeight,
          hasCite: Boolean(panel.querySelector('cite')),
          markText: mark ? mark.textContent : '',
          markInsidePanel: mark ? (() => {
            const r = mark.getBoundingClientRect()
            return r.right <= panelRect.right + 1 && r.bottom <= panelRect.bottom + 1 && r.left >= panelRect.left
          })() : null
        }
      }, id)
      assert(metric, `${id}: rendered quote panel exists`)
      metrics.push(metric)
    }
    console.log(JSON.stringify({ viewport, metrics }))

    const tag = `${viewport.width}x${viewport.height}`
    const widths = metrics.map((metric) => metric.panelWidthPx)
    assert(Math.max(...widths) - Math.min(...widths) <= 1, `${tag}: every quote panel has the same width (±1px): ${widths.join(', ')}`)
    const baseMetrics = metrics.filter((metric) => metric.fit === 'base')
    assert(baseMetrics.length >= metrics.length - 1, `${tag}: at most the soft-overflow fixture needs the fallback: ${metrics.filter((m) => m.fit !== 'base').map((m) => `${m.id}=${m.fit}`).join(', ')}`)
    const fonts = baseMetrics.map((metric) => metric.fontPx)
    assert(Math.max(...fonts) - Math.min(...fonts) < 0.1, `${tag}: every quote panel that fits has the same computed type size: ${fonts.join(', ')}`)
    assert(metrics.every((metric) => metric.fontPx >= 31), `${tag}: quote type never falls below 31px`)
    assert(metrics.every((metric) => metric.fit !== 'stepped' && metric.fit !== 'wide'), `${tag}: the runtime never steps or widens a quote`)
    assert(metrics.every((metric) => metric.fit === 'base' || metric.fit === 'fallback'), `${tag}: no quote part is too long at runtime`)
    for (const metric of metrics.filter((m) => m.fit === 'fallback')) {
      assert.equal(metric.part, '1/1', `${tag} ${metric.id}: only an unsplit soft-overflow quote may use the fallback`)
      assert(metric.fontPx >= fonts[0] * (1 - QUOTE_SOFT_OVERFLOW_RATIO) - 1, `${tag} ${metric.id}: fallback stepped no further than the soft-overflow allowance (${metric.fontPx}px vs base ${fonts[0]}px)`)
    }
    assert(metrics.every((metric) => metric.coverage <= 1.001), `${tag}: no part overflows the fit box: ${metrics.filter((m) => m.coverage > 1.001).map((m) => `${m.id}=${m.coverage.toFixed(3)}`).join(', ')}`)
    assert(metrics.every((metric) => metric.topAirPx >= 0 && metric.bottomAirPx >= 0), `${tag}: every panel sits inside the stage above the chrome band`)
    assert(metrics.every((metric) => metric.bottomAirPx >= metric.topAirPx - 4), `${tag}: every quote is vertically balanced above the fixed chrome band`)
    // 0.9997 at 1280×720 is a pre-existing autofit rounding artefact of the slide's min-height, not a
    // response to an overflowing panel (coverage stays well under 1); anything below 0.999 is a fit.
    assert(metrics.every((metric) => metric.contentZoom >= 0.999), `${tag}: quote slides never need whole-slide zoom`)
    for (const metric of metrics) {
      const [index, count] = metric.part.split('/').map(Number)
      const isLast = index === count
      assert.equal(metric.hasCite, isLast, `${tag} ${metric.id}: cite renders on the last part only`)
      assert.equal(metric.markText, isLast ? '' : `${index} / ${count}`, `${tag} ${metric.id}: continuation mark on every part but the last`)
      if (!isLast) assert(metric.markInsidePanel, `${tag} ${metric.id}: the continuation mark sits inside the panel`)
    }

    const imageMetrics = []
    for (const id of IMAGE_QUOTE_IDS) {
      const metric = await page.evaluate((slideId) => {
        const slides = [...document.querySelectorAll('.stage > .slide')]
        const slide = slides.find((candidate) => candidate.dataset.id === slideId)
        slides.forEach((candidate) => candidate.classList.toggle('active', candidate === slide))
        window.__autofitForTest?.()
        const panel = slide.querySelector('.image-quote blockquote')
        return {
          id: slideId,
          fit: panel.dataset.quoteFit || 'base',
          fontPx: parseFloat(getComputedStyle(panel).fontSize),
          panelWidthPx: panel.offsetWidth
        }
      }, id)
      imageMetrics.push(metric)
      if (metric.fit === 'too-long') {
        assert((model.warnings ?? []).includes(`quote-too-long:${id}`), `${tag}: an image quote that cannot fit at 31px emits quote-too-long`)
      }
    }
    console.log(JSON.stringify({ viewport, imageMetrics }))
    assert(imageMetrics.every((metric) => metric.fontPx >= 31), `${tag}: image-quote type respects the 31px floor`)
    assert.equal(imageMetrics[0].fit, 'base', `${tag}: the short image quote renders at the constant type`)
    assert(imageMetrics.every((metric) => metric.fit !== 'stepped' && metric.fit !== 'wide'), `${tag}: the image quote is never widened or ramp-stepped`)

    await page.close()
  }
} finally {
  await browser.close()
}

// --- mutation: silence the splitter, the gate must fail -----------------------------------------
if (!isMutant) {
  const mutants = [
    { env: 'TW_REINSTATE_QUOTE_DEFECT', label: 'splitter silenced', expect: /splits into continuation slides|overflows|same computed type|too long at runtime/ },
    { env: 'TW_REINSTATE_QUOTE_MIN_PART_DEFECT', label: 'minimum-part rule silenced', expect: /below the 40% minimum/ }
  ]
  for (const mutant of mutants) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, [mutant.env]: '1' },
      encoding: 'utf8'
    })
    assert.notEqual(child.status, 0, `with the ${mutant.label} the gate fails`)
    assert.match(child.stderr, mutant.expect, `mutant (${mutant.label}) fails on its own contract, not elsewhere:\n${child.stderr.slice(-800)}`)
    console.log(`quote sizing mutation (${mutant.label}): FAILS as required`)
  }
}

console.log(isMutant ? 'quote sizing (mutant): PASS — this must not happen' : 'quote sizing: PASS')
