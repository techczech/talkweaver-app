// =============================================================================
// test:timeline-look — ADR-0028 decision 3 (slide design, 2026-09-25; round-2 timeline B)
//
// What must hold, for the horizontal and the rail timeline:
//   1. Stop labels (Today, Soon, a date on the rail) are set in the deck sans, weight >= 700, in the
//      case the author typed (no text-transform; the rendered text equals the source), and at
//      >= 1.2x the entry size.
//   2. One visible line, and every stop's dot has its centre on that line: horizontal — the track's
//      top border is the only line and each dot's vertical centre sits on it; rail — no border and
//      no bar on the rail itself (the doubled line); the line runs as segments from each stop's dot
//      to the next one's, all on one x, and each dot's horizontal centre sits on it. No second
//      marker (head or entry dots) is drawn.
//   3. Entries sit on the body size (--fs-body; ADR-0033 §8 amends ADR-0028 §3, the timeline left the
//      dense step): one size for every entry, the same size in both layouts.
//   5. The track keeps at least the top regime's own gap under the title bar (2.4cqw, stage.css @order
//      1368) — the auto margins give more when the band has room — so the stop line does not sit on the title rule.
//   4. More space between stops: the horizontal column inset is >= 1.4em; on the rail each stop's
//      date sits BESIDE its text on one row, the texts share one left edge, and consecutive stops
//      are >= .6em apart.
//
// Compiles a real deck (prepareSource → model.fullHtml) and reads computed styles in Chromium at
// 1600×900 and 1280×720 (ADR-0030: both show the one 1280×720 canvas, so rects are read in canvas
// px — relative to the stage, divided by its scale). Slides are shown by class, not through the
// runtime, so no whole-slide fit zoom mixes zoomed rects with unzoomed computed lengths. Then each
// property the ADR changed is put back one at a time (MUTANTS) and must fail its own check.
// =============================================================================

import { strict as assert } from 'node:assert'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

// The two specimen slides of the design round (fc5mb, 4k84m), as authored.
const HORIZONTAL_LABELS = ['Today', 'Soon', 'Long term']
const RAIL_LABELS = ['30 Nov 2022', '7 Dec 2022', '2023-2024', 'Sept 2025', '2026']
const dir = mkdtempSync(join(tmpdir(), 'tw-timeline-look-'))
const source = [
  '---', 'title: Timeline look probe', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '',
  '## Timelines', '',
  '### How do you take this forward?', '{id=tl-horizontal} {timeline}{timeline=horizontal}', '',
  '- Today', '  - Menu of options', '  - Learn that',
  '- Soon', '  - Choose what is relevant (if anything)', '  - Learn how', '  - Allocate time',
  '- Long term', '  - Reflect', '  - Practice', '  - Learn to', '',
  '### ChatGPT Timeline', '{id=tl-rail}', '', '{timeline}', '',
  '- 30 Nov 2022', '  - ChatGPT is released',
  '- 7 Dec 2022', '  - 1 million people have used ChatGPT',
  '- 2023-2024', '  - 100s of millions people use ChatGPT to code, write, translate, learn and ... cheat',
  '- Sept 2025', '  - 1 billion people use ChatGPT every week',
  '- 2026 - **AI agents happen**', ''
].join('\n')
const path = join(dir, 'timeline-look.md')
writeFileSync(path, source, 'utf8')
const model = await prepareSource(path, source, 'Timeline look probe', statSync(path))
const htmlPath = join(dir, 'timeline-look.html')
writeFileSync(htmlPath, model.fullHtml, 'utf8')

const close = (a, b, tolerance = 0.5) => Math.abs(a - b) <= tolerance

const probeTimeline = (page, id) => page.evaluate((slideId) => {
  const slides = [...document.querySelectorAll('.stage > .slide')]
  const slide = slides.find((node) => node.dataset.id === slideId)
  if (!slide) return null
  slides.forEach((node) => node.classList.toggle('active', node === slide))
  const tl = slide.querySelector('.timeline')
  const px = (value) => parseFloat(value) || 0
  // Canvas px (ADR-0030): a painted rect relative to the stage, divided by the stage's scale.
  const stageEl = slide.parentElement
  const sr = stageEl.getBoundingClientRect()
  const k = sr.width / stageEl.offsetWidth
  const canvasRect = (el) => { const r = el.getBoundingClientRect(); return { left: (r.left - sr.left) / k, top: (r.top - sr.top) / k, right: (r.right - sr.left) / k, bottom: (r.bottom - sr.top) / k, width: r.width / k, height: r.height / k } }
  const rect = (el) => canvasRect(el)
  // A token's resolved value inside this slide: a hidden probe element takes it as its style.
  const resolve = (prop, value) => {
    const el = document.createElement('span')
    el.style.cssText = `position:absolute;visibility:hidden;${prop}:${value}`
    tl.append(el)
    const out = getComputedStyle(el).getPropertyValue(prop)
    el.remove()
    return out
  }
  const drawn = (el, pseudo) => {
    const s = getComputedStyle(el, pseudo)
    return s.display !== 'none' && s.content !== 'none' && s.content !== 'normal' && s.visibility !== 'hidden' && px(s.width) > 0 && px(s.height) > 0
  }
  // An absolutely positioned pseudo-element's box, from its computed offsets against the
  // origin element's padding box, plus a translateX from its transform.
  const pseudoBox = (el, pseudo) => {
    const s = getComputedStyle(el, pseudo)
    const r = canvasRect(el)
    const originLeft = r.left + px(getComputedStyle(el).borderLeftWidth)
    const originTop = r.top + px(getComputedStyle(el).borderTopWidth)
    const matrix = s.transform && s.transform !== 'none' ? new DOMMatrixReadOnly(s.transform) : null
    const left = originLeft + px(s.left) + (matrix ? matrix.m41 : 0)
    const top = originTop + px(s.top) + (matrix ? matrix.m42 : 0)
    const width = px(s.width)
    const height = px(s.height)
    return { left, top, width, height, cx: left + width / 2, cy: top + height / 2 }
  }
  const tlStyle = getComputedStyle(tl)
  const tlRect = rect(tl)
  const groups = [...tl.querySelectorAll(':scope > .tl-group')]
  const entries = [...tl.querySelectorAll('.tl-entries > li')]
  return {
    mode: tl.dataset.timelineMode,
    bodySize: px(resolve('font-size', 'var(--fs-body)')),
    headGap: (() => { const h = slide.querySelector('.slide-head'); return h ? tlRect.top - rect(h).bottom : null })(),
    stageWidth: stageEl.offsetWidth,
    sansFamily: resolve('font-family', 'var(--sans)'),
    tl: {
      rect: tlRect,
      borderTop: px(tlStyle.borderTopWidth),
      borderLeft: px(tlStyle.borderLeftWidth),
      fontSize: px(tlStyle.fontSize),
      before: drawn(tl, '::before') ? pseudoBox(tl, '::before') : null
    },
    entryListBorders: [...tl.querySelectorAll('.tl-entries')].map((ol) => px(getComputedStyle(ol).borderTopWidth) + px(getComputedStyle(ol).borderLeftWidth)),
    groupBorders: groups.map((g) => px(getComputedStyle(g).borderTopWidth) + px(getComputedStyle(g).borderLeftWidth)),
    extraMarkers: [...tl.querySelectorAll('.tl-group-head, .tl-entries > li')].filter((el) => drawn(el, '::before')).length,
    groups: groups.map((g) => {
      const head = g.querySelector(':scope > .tl-group-head')
      const hs = getComputedStyle(head)
      const texts = [...g.querySelectorAll('.tl-entries > li')]
      return {
        rect: rect(g),
        paddingRight: px(getComputedStyle(g).paddingRight),
        dot: drawn(g, '::before') ? pseudoBox(g, '::before') : null,
        segment: drawn(g, '::after') ? pseudoBox(g, '::after') : null,
        head: {
          text: head.textContent.trim(),
          rendered: head.innerText.trim(),
          family: hs.fontFamily,
          weight: Number(hs.fontWeight),
          transform: hs.textTransform,
          size: px(hs.fontSize),
          rect: rect(head)
        },
        firstText: rect(texts[0]),
        lastText: rect(texts[texts.length - 1])
      }
    }),
    entrySizes: entries.map((li) => px(getComputedStyle(li).fontSize))
  }
}, id)

async function checkStage(page, key, log = console.log) {
  const horizontal = await probeTimeline(page, 'tl-horizontal')
  const rail = await probeTimeline(page, 'tl-rail')
  assert.equal(horizontal?.mode, 'horizontal', `${key}: the horizontal fixture renders a horizontal timeline`)
  assert.equal(rail?.mode, 'rail', `${key}: the rail fixture renders a rail timeline`)
  assert.deepEqual(horizontal.groups.map((g) => g.head.text), HORIZONTAL_LABELS, `${key}: horizontal stop labels as authored`)
  assert.deepEqual(rail.groups.map((g) => g.head.text), RAIL_LABELS, `${key}: rail stop labels as authored`)

  for (const tl of [horizontal, rail]) {
    const name = `${key} ${tl.mode}`
    // 3. Entries on the body size, one size throughout.
    assert(tl.entrySizes.length > 0, `${name}: entries render`)
    for (const size of tl.entrySizes) assert(close(size, tl.bodySize, 0.05), `${name}: every entry sits on the body size (${size}px vs --fs-body ${tl.bodySize}px)`)
    // 1. Labels: sans, bold, as typed, >= 1.2x the entries.
    for (const g of tl.groups) {
      const label = `${name} "${g.head.text}"`
      assert.equal(g.head.family, tl.sansFamily, `${label}: label in the deck sans (got ${g.head.family})`)
      assert(g.head.weight >= 700, `${label}: label weight >= 700 (got ${g.head.weight})`)
      assert.equal(g.head.transform, 'none', `${label}: no text-transform on the label (got ${g.head.transform})`)
      assert.equal(g.head.rendered, g.head.text, `${label}: the label renders in the case the author typed (got "${g.head.rendered}")`)
      assert(g.head.size >= 1.2 * tl.bodySize - 0.05, `${label}: label ${g.head.size}px is >= 1.2x the entry ${tl.bodySize}px`)
    }
    // 5. Air between the title rule and the track (horizontal and rail alike).
    assert(tl.headGap >= 0.024 * tl.stageWidth - 0.5, `${name}: ${tl.headGap}px between the title bar and the track is >= 2.4cqw`)
    // 2. No second marker beside the stop's dot.
    assert.equal(tl.extraMarkers, 0, `${name}: no head or entry dots beside the stop dots`)
    assert(tl.entryListBorders.every((w) => w === 0), `${name}: the entry lists draw no line of their own`)
    assert(tl.groupBorders.every((w) => w === 0), `${name}: the groups draw no line of their own`)
    assert(tl.groups.every((g) => g.dot), `${name}: every stop carries a dot`)
  }

  // 2. Horizontal: the track's top border is the one line; every dot's centre is on it.
  assert(horizontal.tl.borderTop > 0, `${key} horizontal: the track line is drawn`)
  assert.equal(horizontal.tl.before, null, `${key} horizontal: no second line (::before)`)
  assert(horizontal.groups.every((g) => !g.segment), `${key} horizontal: no line segments on the stops`)
  const trackY = horizontal.tl.rect.top + horizontal.tl.borderTop / 2
  for (const g of horizontal.groups) {
    assert(close(g.dot.cy, trackY), `${key} horizontal "${g.head.text}": dot centre y ${g.dot.cy} is on the line (${trackY})`)
    assert(close(g.dot.left, g.rect.left), `${key} horizontal "${g.head.text}": dot starts its column`)
  }
  // 4. Horizontal: wider inset between stop columns.
  for (const g of horizontal.groups) assert(g.paddingRight >= 1.4 * horizontal.tl.fontSize - 0.05, `${key} horizontal "${g.head.text}": column inset ${g.paddingRight}px >= 1.4em`)
  log(`PASS ${key} horizontal: bold sans labels as typed at ${(horizontal.groups[0].head.size / horizontal.bodySize).toFixed(2)}x, entries on the body size (${horizontal.bodySize}px), one line with every dot centred on it`)

  // 2. Rail: no border or bar on the rail; one line of dot-to-dot segments; every dot on it.
  assert.equal(rail.tl.borderLeft, 0, `${key} rail: no border on the rail (the doubled line)`)
  assert.equal(rail.tl.before, null, `${key} rail: no bar on the rail beside the stop segments`)
  const lineX = rail.groups[0].segment?.cx
  assert(Number.isFinite(lineX), `${key} rail: the line is drawn from the first stop`)
  for (const [i, g] of rail.groups.entries()) {
    assert(close(g.dot.cx, lineX), `${key} rail "${g.head.text}": dot centre x ${g.dot.cx} is on the line (${lineX})`)
    assert(g.dot.cy > g.head.rect.top && g.dot.cy < g.head.rect.bottom, `${key} rail "${g.head.text}": dot level with its label`)
    const next = rail.groups[i + 1]
    if (!next) {
      assert.equal(g.segment, null, `${key} rail "${g.head.text}": the line ends at the last dot`)
      continue
    }
    assert(g.segment && g.segment.width > 0 && g.segment.width <= 3, `${key} rail "${g.head.text}": a hairline segment leads to the next stop`)
    assert(close(g.segment.cx, lineX), `${key} rail "${g.head.text}": the segment is on the one line (x ${g.segment.cx} vs ${lineX})`)
    assert(close(g.segment.top, g.dot.top + g.dot.height), `${key} rail "${g.head.text}": the segment starts at this dot (${g.segment.top} vs ${g.dot.top + g.dot.height})`)
    assert(close(g.segment.top + g.segment.height, next.dot.top), `${key} rail "${g.head.text}": the segment ends at the next dot (${g.segment.top + g.segment.height} vs ${next.dot.top})`)
  }
  // 4. Rail: date beside its text on one row; texts share one left edge; stops spaced.
  const textLeft = rail.groups[0].firstText.left
  for (const [i, g] of rail.groups.entries()) {
    assert(g.head.rect.right <= g.firstText.left, `${key} rail "${g.head.text}": the date sits left of its text`)
    assert(g.firstText.top < g.head.rect.bottom && g.firstText.bottom > g.head.rect.top, `${key} rail "${g.head.text}": the date and its text share a row`)
    assert(close(g.firstText.left, textLeft), `${key} rail "${g.head.text}": the texts share one left edge`)
    if (i > 0) {
      const prev = rail.groups[i - 1]
      const gap = Math.min(g.head.rect.top, g.firstText.top) - Math.max(prev.head.rect.bottom, prev.lastText.bottom)
      assert(gap >= 0.6 * rail.tl.fontSize - 0.5, `${key} rail "${g.head.text}": >= .6em between stops (got ${gap.toFixed(1)}px)`)
    }
  }
  log(`PASS ${key} rail: bold sans dates beside their text at ${(rail.groups[0].head.size / rail.bodySize).toFixed(2)}x, entries on the body size, one line with every dot centred on it`)
}

// A mutant is today's look (before ADR-0028 §3) put back one property at a time; each must fail its
// own check. Injected on top of the compiled deck at the 1280×720 stage.
const MUTANTS = [
  { name: 'mono uppercase labels', css: '.timeline .tl-group-head { font-family: var(--mono) !important; text-transform: uppercase !important; font-weight: 500 !important; font-size: .62em !important; }', expect: /deck sans|weight >= 700|text-transform|case the author typed|>= 1\.2x/ },
  { name: 'entries back on the dense step', css: '.timeline .tl-entries > li { font-size: .8em !important; }', expect: /body size/ },
  { name: 'title rule pressed on the track', css: '.slide[data-title-layout="top"] > .slide-content.layout-timeline > .slide-head { margin-bottom: 0 !important; } .slide[data-title-layout="top"] > .slide-content.layout-timeline > .timeline { margin-top: 0 !important; }', expect: /between the title bar and the track/ },
  { name: 'doubled rail line', css: '.timeline.timeline-rail { border-left: 2px solid var(--hairline) !important; }', expect: /doubled line/ },
  { name: 'rail dot off the line', css: '.timeline.timeline-rail .tl-group::before { left: -8px !important; }', expect: /is on the line/ },
  { name: 'horizontal dot off the line', css: '.timeline.timeline-horizontal .tl-group::before { top: calc(-1.5em - 9px) !important; }', expect: /is on the line/ },
  { name: 'rail date above its text', css: '.timeline.timeline-rail .tl-group { display: block !important; }', expect: /left of its text|share a row/ },
  { name: 'narrow horizontal inset', css: '.timeline.timeline-horizontal .tl-group { padding-right: 1em !important; }', expect: />= 1\.4em/ }
]

const browser = await chromium.launch({ headless: true })
try {
  for (const viewport of [{ width: 1600, height: 900 }, { width: 1280, height: 720 }]) {
    const page = await browser.newPage({ viewport })
    await page.goto(`file://${htmlPath}`, { waitUntil: 'load' })
    await page.evaluate(() => document.fonts?.ready)
    await checkStage(page, `${viewport.width}x${viewport.height}`)
    await page.close()
  }
  for (const mutant of MUTANTS) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
    await page.goto(`file://${htmlPath}`, { waitUntil: 'load' })
    await page.evaluate(() => document.fonts?.ready)
    await page.addStyleTag({ content: mutant.css })
    await assert.rejects(checkStage(page, `mutant "${mutant.name}"`, () => {}), mutant.expect, `mutant "${mutant.name}" must fail its own check`)
    await page.close()
  }
  console.log(`PASS mutants: ${MUTANTS.length} reverted properties each fail their own check`)
} finally {
  await browser.close()
}
console.log('timeline look (ADR-0028 §3): all checks passed')
