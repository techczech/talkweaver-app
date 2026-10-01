// =============================================================================
// test:timeline-stop-limit — slide design ticket 08 (ADR-0028 §3 follow-through)
//
// Since ADR-0028 §3 the horizontal timeline's entries sit on the body size with a 1.4em column
// inset. The compile-time rule that caps the stops per slide (timeline-layout.mjs) must follow
// those tokens, so every stop's line still holds the rule's minimum measure (11 characters).
//
// What must hold:
//   1. The stop-limit function (compile time): the tokens the module assumes are the ones the
//      stylesheets set (--fs-body, the type floor, the column inset, no track gap); the horizontal
//      cap recomputed from them independently equals the module's cap at 1600×900 and 1280×720;
//      the per-slide limit is the tighter of the two; at that limit the measure is >= 11
//      characters on both stages and one stop more drops it under 11 on the tighter one; five
//      stops cut 3 + 2 and eight 3 + 3 + 2; the pre-ticket derivation (floor-size text, 1em inset)
//      would allow six, and the limit is not that.
//   2. Rendered (headless Chromium, the compiled sampler, 1600×900 and 1280×720): on every
//      horizontal timeline slide the track width, entry size, inset and gap are what the module
//      computed; no slide carries more stops than the limit; every entry's line box holds >= 11
//      average characters.
//   3. The rendered lines of every entry are printed; a line under 11 characters that is not its
//      paragraph's last line is listed as SHORT (reported, not asserted — word wrap can leave a
//      short line in any measure; see the ticket 08 report).
//   4. Mutant: widen the column inset in the page only; check 2 must fail on it.
// =============================================================================
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { buildLayoutSampler } from './build-layout-sampler.mjs'
import {
  HORIZONTAL_STOPS_PER_SLIDE, HORIZONTAL_TRACK_TOKENS, TIMELINE_REFERENCE_VIEWPORTS, TIMELINE_STOPS_PER_SLIDE,
  TIMELINE_TEXT_METRICS, timelineContinuationParts, timelineGeometricCap, timelineHorizontalMeasure,
  timelineStageGeometry, timelineStopsPerSlide
} from '../compiler/scripts/lib/timeline-layout.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const styles = join(repo, 'compiler/assets/styles')
const css = (file) => readFileSync(join(styles, file), 'utf8')
const { minCharsPerLine: MIN, glyphWidthEm: GLYPH } = TIMELINE_TEXT_METRICS

// --- 1. the stop-limit function -------------------------------------------------------------------
const bodyCqw = Number(css('skin/base.css').match(/--fs-body:\s*max\(var\(--type-floor\),\s*([\d.]+)cqw\)/)?.[1])
const floorCqw = Number(css('stage.css').match(/--type-floor:\s*([\d.]+)cqw/)?.[1])
const skin = css('skin/timeline.css')
const trackRule = skin.match(/\.timeline\.timeline-horizontal \{([^}]*)\}/)?.[1] ?? ''
const groupRule = skin.match(/\.timeline\.timeline-horizontal \.tl-group \{([^}]*)\}/)?.[1] ?? ''
const insetEm = Number(groupRule.match(/padding:\s*0 ([\d.]+)em 0 0/)?.[1])
assert.equal(HORIZONTAL_TRACK_TOKENS.entryBodyCqw, bodyCqw, `entry size: the module assumes --fs-body ${HORIZONTAL_TRACK_TOKENS.entryBodyCqw}cqw, skin/base.css sets ${bodyCqw}cqw`)
assert.match(trackRule, /font-size:\s*var\(--fs-body\)/, 'the horizontal track sets its type on the body size')
assert.match(skin, /\.timeline\.timeline-horizontal \.tl-entries li \{[^}]*font-size:\s*max\(var\(--type-floor\), 1em\)/, 'each entry takes the track size (at or above the floor)')
assert.equal(HORIZONTAL_TRACK_TOKENS.textInsetEm, insetEm, `column inset: the module assumes ${HORIZONTAL_TRACK_TOKENS.textInsetEm}em, skin/timeline.css sets ${insetEm}em`)
assert.equal(HORIZONTAL_TRACK_TOKENS.columnGapPx, 0, 'the module assumes no column gap on the track')
assert.doesNotMatch(trackRule, /(^|[\s;])(column-)?gap\s*:/, 'the horizontal track sets no column gap')

const independentCap = ({ width }) => {
  const entry = Math.max((floorCqw / 100) * width, (bodyCqw / 100) * width)
  const column = Math.min(1180, width - 2 * 0.056 * width)
  return Math.floor(column / (MIN * GLYPH * entry + insetEm * entry))
}
const caps = {}
for (const viewport of TIMELINE_REFERENCE_VIEWPORTS) {
  const cap = timelineGeometricCap('horizontal', viewport)
  caps[viewport.width] = cap
  assert.equal(cap, independentCap(viewport), `${viewport.width}px: the cap follows the stylesheet tokens (${cap})`)
  assert(timelineHorizontalMeasure(cap, viewport) >= MIN, `${viewport.width}px: at ${cap} stops a line holds ${timelineHorizontalMeasure(cap, viewport).toFixed(2)} >= ${MIN} characters`)
  assert(timelineHorizontalMeasure(cap + 1, viewport) < MIN, `${viewport.width}px: ${cap + 1} stops would drop the measure under ${MIN} characters`)
}
const limit = Math.min(...Object.values(caps))
assert.equal(HORIZONTAL_STOPS_PER_SLIDE, limit, `the per-slide limit is the tighter stage's cap (${limit})`)
assert.equal(TIMELINE_STOPS_PER_SLIDE.horizontal, limit, 'the mode table carries the derived limit')
assert.equal(timelineStopsPerSlide('horizontal'), limit, 'the stop-limit function returns the derived limit')
for (const viewport of TIMELINE_REFERENCE_VIEWPORTS) {
  assert(timelineHorizontalMeasure(limit, viewport) >= MIN, `${viewport.width}px: at the limit a line holds >= ${MIN} characters`)
}
// The derivation before ticket 08: floor-size text, a 1em inset.
const staleCap = Math.min(...TIMELINE_REFERENCE_VIEWPORTS.map(({ width }) => {
  const floor = (floorCqw / 100) * width
  return Math.floor(Math.min(1180, width - 2 * 0.056 * width) / (MIN * GLYPH * floor + floor))
}))
assert.equal(staleCap, 6, 'the pre-ticket derivation allowed six stops')
assert.notEqual(limit, staleCap, 'the limit no longer assumes floor-size text and a 1em inset')
const stopsOf = (n) => Array.from({ length: n }, (_, i) => ({ date: String(2019 + i), text: `Stop ${i + 1}`, details: [] }))
const partsOf = (n) => timelineContinuationParts([{ type: 'timeline', mode: 'horizontal', stops: stopsOf(n) }], (stops) => ({ stops }))
assert.equal(partsOf(limit), null, `${limit} horizontal stops stay on one slide`)
assert.deepEqual(partsOf(5).map((part) => part.stops.length), [3, 2], 'five horizontal stops cut 3 + 2')
assert.deepEqual(partsOf(8).map((part) => part.stops.length), [3, 3, 2], 'eight horizontal stops cut 3 + 3 + 2')
console.log(`PASS stop limit: horizontal cap ${caps[1600]} at 1600×900, ${caps[1280]} at 1280×720 → ${limit} per slide (was ${staleCap})`)

// --- 2–4. rendered ------------------------------------------------------------------------------
const { model, outPath } = await buildLayoutSampler(mkdtempSync(join(tmpdir(), 'tw-timeline-stop-limit-')))
const horizontalIds = model.slides
  .filter((slide) => slide.blocks?.length === 1 && slide.blocks[0].type === 'timeline' && slide.blocks[0].mode === 'horizontal')
  .map((slide) => slide.id)
assert(horizontalIds.length >= 4, `the sampler carries its horizontal timelines (${horizontalIds.join(', ')})`)

// Shown by class, not through the runtime, so no whole-slide fit zoom mixes into the rects.
const probe = (page, slideId) => page.evaluate((id) => {
  const slides = [...document.querySelectorAll('.stage > .slide')]
  const slide = slides.find((node) => node.dataset.id === id)
  if (!slide) return null
  slides.forEach((node) => node.classList.toggle('active', node === slide))
  const track = slide.querySelector('.timeline.timeline-horizontal')
  const ts = getComputedStyle(track)
  // ADR-0030: the stage is the 1280×720 canvas scaled to the window; widths are read in canvas px.
  const stage = slide.parentElement
  const k = stage.getBoundingClientRect().width / stage.offsetWidth
  const groups = [...track.querySelectorAll(':scope > .tl-group')]
  const lineTexts = (li) => {
    const walker = document.createTreeWalker(li, NodeFilter.SHOW_TEXT)
    const lines = []
    while (walker.nextNode()) {
      const node = walker.currentNode
      for (let i = 0; i < node.length; i += 1) {
        const range = document.createRange()
        range.setStart(node, i)
        range.setEnd(node, i + 1)
        const box = range.getClientRects()[0]
        if (!box) continue
        const last = lines[lines.length - 1]
        if (last && Math.abs(last.top - box.top) < 4) last.text += node.data[i]
        else lines.push({ top: box.top, text: node.data[i] })
      }
    }
    return lines.map((line) => line.text.trim()).filter(Boolean)
  }
  return {
    canvasWidth: stage.offsetWidth,
    trackWidth: track.getBoundingClientRect().width / k,
    columnGap: ts.columnGap,
    stops: groups.length,
    groups: groups.map((group) => ({
      inset: parseFloat(getComputedStyle(group).paddingRight),
      entries: [...group.querySelectorAll('.tl-entries li')].map((li) => ({
        font: parseFloat(getComputedStyle(li).fontSize),
        width: li.getBoundingClientRect().width / k,
        lines: lineTexts(li)
      }))
    }))
  }
}, slideId)

const checkStage = async (page, viewport, label, report) => {
  for (const id of horizontalIds) {
    const m = await probe(page, id)
    assert(m, `${label} ${id}: the horizontal track renders`)
    // ADR-0030: every window renders the 1280×720 canvas, so the rendered track is compared with
    // the module's geometry for the canvas the window shows, not for a stage as wide as the window.
    const g = timelineStageGeometry({ width: m.canvasWidth, height: m.canvasWidth * 9 / 16 })
    assert(m.stops <= limit, `${label} ${id}: ${m.stops} stops <= the limit of ${limit}`)
    assert(Math.abs(m.trackWidth - g.contentWidthPx) <= 1, `${label} ${id}: track ${m.trackWidth.toFixed(1)}px = the module's content column ${g.contentWidthPx.toFixed(1)}px`)
    assert(m.columnGap === 'normal' || parseFloat(m.columnGap) === g.gapPx, `${label} ${id}: column gap ${m.columnGap} = ${g.gapPx}px`)
    for (const [index, group] of m.groups.entries()) {
      assert(Math.abs(group.inset - g.insetPx) <= 0.5, `${label} ${id} stop ${index + 1}: inset ${group.inset.toFixed(1)}px = the module's ${g.insetPx.toFixed(1)}px`)
      for (const entry of group.entries) {
        assert(Math.abs(entry.font - g.entryPx) <= 0.5, `${label} ${id} stop ${index + 1}: entry ${entry.font.toFixed(1)}px = the module's ${g.entryPx.toFixed(1)}px`)
        const measure = entry.width / (GLYPH * entry.font)
        assert(measure >= MIN, `${label} ${id} stop ${index + 1}: the entry line holds ${measure.toFixed(2)} >= ${MIN} characters`)
        report?.(id, index, entry, measure)
      }
    }
  }
}

const browser = await chromium.launch({ headless: true })
try {
  for (const viewport of TIMELINE_REFERENCE_VIEWPORTS) {
    const page = await browser.newPage({ viewport })
    await page.goto(pathToFileURL(outPath).href, { waitUntil: 'load' })
    await page.evaluate(() => document.fonts?.ready)
    const rows = []
    const short = []
    await checkStage(page, viewport, `${viewport.width}×${viewport.height}`, (id, index, entry, measure) => {
      rows.push(`${id}#${index + 1} ${measure.toFixed(1)}ch ${JSON.stringify(entry.lines)}`)
      entry.lines.slice(0, -1).forEach((line) => { if (line.length < MIN) short.push(`${id}#${index + 1} "${line}"`) })
    })
    console.log(`PASS ${viewport.width}×${viewport.height}: ${horizontalIds.length} horizontal slides, every stop's line holds >= ${MIN} characters`)
    for (const row of rows) console.log(`  ${row}`)
    console.log(`  SHORT non-last lines (< ${MIN} characters, reported): ${short.length ? short.join(', ') : 'none'}`)

    // 4. mutant: a wider inset than the module assumes must fail check 2.
    await page.addStyleTag({ content: '.timeline.timeline-horizontal .tl-group { padding-right: 2.4em !important; }' })
    await assert.rejects(checkStage(page, viewport, 'mutant "inset 2.4em"'), /inset/, 'a widened inset fails its own check')
    console.log(`PASS mutant at ${viewport.width}×${viewport.height}: a 2.4em inset fails the inset check`)
    await page.close()
  }
} finally {
  await browser.close()
}
console.log('timeline stop limit: PASS')
