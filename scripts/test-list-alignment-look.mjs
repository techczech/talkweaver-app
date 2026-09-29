// =============================================================================
// test:list-alignment-look — ADR-0028 decision 4 (slide design, 2026-09-25)
//
// What must hold:
//   1. Rail title: a visible title on the left rail starts at the rail's left inset whatever its
//      length — a one-word title and a three-line title share one left edge.
//   2. Icon rows ({iconlist=list}): the icon is 1.75em, 1.1em from the text, and its vertical
//      centre is within 2px of its item's text-block centre, for one-line and three-line items.
//   3. Icon rows: items are separated by a 2px dotted line in ink at ~22% — between items only
//      (none above the first, none below the last).
//   4. Cards (logolist with children): every card's heading shares one top edge across the row,
//      and the same dotted line separates the sub-items inside each card (between them only).
//
// Compiles a real deck (prepareSource → model.fullHtml) and reads computed styles and rects in
// Chromium at 1600×900 and 1280×720 (ADR-0030: both show the one 1280×720 canvas;
// rects are read in canvas px), after the runtime fit pass.
// =============================================================================

import { strict as assert } from 'node:assert'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

const ROWS = [
  '- **Model capability** can run for longer {icon=lucide:cpu}',
  '- **Speed of developments** some model families had three releases between June and August {icon=lucide:zap}',
  '- **More modalities** voice models wait while you speak {icon=lucide:mic}',
  '- **Cost of AI** from $20 a month {icon=lucide:coins}'
]
const WIDE_ROWS = ['message-square', 'pen-line', 'boxes', 'terminal', 'image', 'puzzle', 'zap'].map((icon) => `- ${icon.replace('-', ' ')} {icon=lucide:${icon}}`)
const dir = mkdtempSync(join(tmpdir(), 'tw-list-alignment-'))
const source = [
  '---', 'title: List alignment probe', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '',
  '## Trends', '',
  // One-word and three-line rail titles over the same icon rows.
  '### Trends', '{iconlist=list} {sidebar} {id=rows-short}', '', ...ROWS, '',
  '### How current model families compare', '{iconlist=list} {sidebar} {id=rows-long}', '', ...ROWS, '',
  // Seven rows compile to the wide variant (.fl-wide), whose row rule has a higher specificity.
  '### Seven rows', '{iconlist=list} {sidebar} {id=rows-wide}', '', ...WIDE_ROWS, '',
  // Cards whose headings differ in length and whose sub-lists differ in count.
  '### Current model families', '{logolist} {sidebar} {id=cards}', '',
  '- OpenAI – GPT 6', '  - Luna', '  - Sol', '  - Astra',
  '- Anthropic – Claude 5', '  - Sonnet', '  - Opus',
  '- Google – Gemini 3', '  - Flash Lite', '  - Flash', '  - Pro', '  - Ultra'
].join('\n')
const path = join(dir, 'list-alignment.md')
writeFileSync(path, source, 'utf8')
const model = await prepareSource(path, source, 'List alignment probe', statSync(path))
const htmlPath = join(dir, 'list-alignment.html')
writeFileSync(htmlPath, model.fullHtml, 'utf8')

const px = (value) => parseFloat(value)
const close = (a, b, tolerance = 0.5) => Math.abs(a - b) <= tolerance
// color-mix(in srgb, ink 22%, transparent) computes to an rgba/color() with alpha 0.22.
const alphaOf = (color) => {
  const m = color.match(/^rgba\(\s*[\d.]+,\s*[\d.]+,\s*[\d.]+,\s*([\d.]+)\s*\)$/) || color.match(/^color\(srgb [\d.]+ [\d.]+ [\d.]+ \/ ([\d.]+)\)$/)
  return m ? parseFloat(m[1]) : color.startsWith('rgb(') ? 1 : NaN
}
const assertDotted = (edge, label) => {
  assert.equal(edge.style, 'dotted', `${label}: separator is dotted (got ${edge.style})`)
  assert(close(px(edge.width), 2, 0.01), `${label}: separator is 2px (got ${edge.width})`)
  const alpha = alphaOf(edge.color)
  assert(alpha >= 0.15 && alpha <= 0.3, `${label}: separator is low-contrast ink (~22%; got ${edge.color})`)
}

const browser = await chromium.launch({ headless: true })
try {
  for (const viewport of [{ width: 1600, height: 900 }, { width: 1280, height: 720 }]) {
    const key = `${viewport.width}x${viewport.height}`
    const page = await browser.newPage({ viewport })
    await page.goto(`file://${htmlPath}`, { waitUntil: 'load' })
    await page.evaluate(() => document.fonts?.ready)
    const probe = (id) => page.evaluate((slideId) => {
      const slides = [...document.querySelectorAll('.stage > .slide')]
      const slide = slides.find((node) => node.dataset.id === slideId)
      if (!slide) return null
      slides.forEach((node) => node.classList.toggle('active', node === slide))
      window.__autofitForTest?.()
      // Canvas px (ADR-0030): the slide lives on the 1280×720 stage, scaled to the window; a painted
      // rect is read relative to the stage and divided by the stage's scale.
      const stageEl = slide.parentElement, sr = stageEl.getBoundingClientRect(), k = sr.width / stageEl.offsetWidth
      const rect = (el) => { const r = el.getBoundingClientRect(); return { left: (r.left - sr.left) / k, right: (r.right - sr.left) / k, top: (r.top - sr.top) / k, bottom: (r.bottom - sr.top) / k, width: r.width / k, height: r.height / k } }
      const edge = (style, side) => ({ style: style.getPropertyValue(`border-${side}-style`), width: style.getPropertyValue(`border-${side}-width`), color: style.getPropertyValue(`border-${side}-color`) })
      // Rendered line count: distinct line boxes among the element's text fragments.
      const lineCount = (el) => {
        const range = document.createRange()
        range.selectNodeContents(el)
        const tops = [...range.getClientRects()].filter((r) => r.width > 0).map((r) => r.bottom)
        return tops.filter((b, i) => tops.findIndex((o) => Math.abs(o - b) < 4) === i).length
      }
      const edges = (el) => { const s = getComputedStyle(el); return { top: edge(s, 'top'), bottom: edge(s, 'bottom') } }
      const content = slide.querySelector(':scope > .slide-content')
      const head = content.querySelector(':scope > .slide-head')
      const h1 = head.querySelector('h1')
      const headStyle = getComputedStyle(head)
      const list = content.querySelector(':scope > .feature-list')
      return {
        titleLayout: slide.dataset.titleLayout,
        listClass: list.className,
        head: { ...rect(head), paddingLeft: parseFloat(headStyle.paddingLeft) },
        h1: { ...rect(h1), lines: lineCount(h1) },
        items: [...list.children].map((li) => {
          const style = getComputedStyle(li)
          const icon = li.querySelector(':scope > .fl-icon')
          const svg = icon?.querySelector('svg')
          const text = li.querySelector(':scope > .fl-text')
          return {
            fontSize: parseFloat(style.fontSize),
            columnGap: style.columnGap,
            edges: edges(li),
            icon: icon && { ...rect(icon), svg: svg && rect(svg) },
            text: { ...rect(text), lines: lineCount(text) },
            subs: [...li.querySelectorAll(':scope > .fl-sublist > li')].map((sub) => ({ ...rect(sub), edges: edges(sub) }))
          }
        })
      }
    }, id)

    // 1. Rail titles: one left edge for a one-word and a three-line title, on the rail inset.
    const short = await probe('rows-short')
    const long = await probe('rows-long')
    for (const [label, slide] of [['one-word', short], ['long', long]]) {
      assert.equal(slide.titleLayout, 'left', `${label} probe slide takes the left rail`)
      assert(close(slide.h1.left, slide.head.left + slide.head.paddingLeft), `${key}: ${label} rail title starts at the rail's left inset (title ${slide.h1.left}, inset ${slide.head.left + slide.head.paddingLeft})`)
    }
    assert.equal(short.h1.lines, 1, `${key}: the short rail title is one line`)
    assert(long.h1.lines >= 3, `${key}: the long rail title wraps to three lines or more (got ${long.h1.lines})`)
    assert(close(short.h1.left, long.h1.left), `${key}: one-word and three-line rail titles share a left edge (${short.h1.left} vs ${long.h1.left})`)
    console.log(`PASS ${key}: rail titles align left (one-word and ${long.h1.lines}-line titles at x=${short.h1.left.toFixed(1)})`)

    // 2. Icon rows: size 1.75em, gap 1.1em, icon centred on its item's text block — for the
    //    regular rows and the wide (7-row) variant.
    const wide = await probe('rows-wide')
    assert.match(short.listClass, /\bfl-iconlist-list\b/, 'the probe rows compile to icon rows')
    assert.doesNotMatch(short.listClass, /\bfl-wide\b/, 'the four-row probe is the regular variant')
    assert.match(wide.listClass, /\bfl-iconlist-list\b/, 'the seven-row probe compiles to icon rows')
    assert.match(wide.listClass, /\bfl-wide\b/, 'the seven-row probe is the wide variant')
    const lineCounts = new Set()
    for (const [variant, slide] of [['rows', short], ['wide rows', wide]]) {
      for (const [i, item] of slide.items.entries()) {
        const label = `${key} ${variant} ${i + 1}`
        const em = item.fontSize
        assert(close(item.icon.width, 1.75 * em) && close(item.icon.height, 1.75 * em), `${label}: icon box is 1.75em (${item.icon.width}×${item.icon.height} for ${em}px)`)
        assert(close(item.icon.svg.width, 1.75 * em) && close(item.icon.svg.height, 1.75 * em), `${label}: icon glyph is 1.75em (${item.icon.svg.width}px for ${em}px)`)
        assert(close(px(item.columnGap), 1.1 * em), `${label}: computed icon-to-text gap is 1.1em (got ${item.columnGap} for ${em}px)`)
        assert(close(item.text.left - item.icon.right, 1.1 * em), `${label}: text starts 1.1em after the icon (got ${item.text.left - item.icon.right}px)`)
        const iconCentre = (item.icon.svg.top + item.icon.svg.bottom) / 2
        const textCentre = (item.text.top + item.text.bottom) / 2
        assert(Math.abs(iconCentre - textCentre) <= 2, `${label}: icon centre ${iconCentre.toFixed(1)} within 2px of text-block centre ${textCentre.toFixed(1)} (${item.text.lines} lines)`)
        if (slide === short) lineCounts.add(item.text.lines)
      }
    }
    assert(lineCounts.has(1), `${key}: the probe has a one-line row (line counts ${[...lineCounts]})`)
    assert([...lineCounts].some((n) => n >= 3), `${key}: the probe has a three-line row (line counts ${[...lineCounts]})`)
    console.log(`PASS ${key}: icon rows — icon 1.75em, gap 1.1em, centred on items of ${[...lineCounts].sort().join(', ')} lines; wide rows too`)

    // 3. Icon rows: dotted, low-contrast separators between items only.
    for (const [variant, slide] of [['rows', short], ['wide rows', wide]]) {
      assert.equal(slide.items[0].edges.top.style, 'none', `${key} ${variant}: no line above the first row (got ${slide.items[0].edges.top.style})`)
      for (const [i, item] of slide.items.entries()) {
        if (i > 0) assertDotted(item.edges.top, `${key} ${variant} ${i + 1} top`)
        assert(item.edges.bottom.style === 'none' || px(item.edges.bottom.width) === 0, `${key} ${variant} ${i + 1}: no rule below (got ${item.edges.bottom.style} ${item.edges.bottom.width})`)
      }
    }
    console.log(`PASS ${key}: icon rows — dotted 2px separators at low contrast between items, none after the last; wide rows too`)

    // 4. Cards: one heading top edge; dotted separators between sub-items.
    const cards = await probe('cards')
    assert.doesNotMatch(cards.listClass, /\bfl-iconlist-list\b/, 'the logolist compiles to cards')
    assert.equal(cards.items.length, 3, 'three cards')
    const rowTop = cards.items[0].text.top
    assert(new Set(cards.items.map((c) => Math.round(c.icon.top))).size === 1, `${key}: the cards sit in one row`)
    for (const [i, card] of cards.items.entries()) {
      assert(close(card.text.top, rowTop), `${key} card ${i + 1}: heading top ${card.text.top} matches the row's ${rowTop}`)
      assert(card.subs.length >= 2, `${key} card ${i + 1} has sub-items`)
      assert.equal(card.subs[0].edges.top.style, 'none', `${key} card ${i + 1}: no line above the first sub-item`)
      for (const [j, sub] of card.subs.entries()) {
        if (j > 0) assertDotted(sub.edges.top, `${key} card ${i + 1} sub ${j + 1} top`)
        assert(sub.edges.bottom.style === 'none' || px(sub.edges.bottom.width) === 0, `${key} card ${i + 1} sub ${j + 1}: no rule below`)
      }
    }
    console.log(`PASS ${key}: cards — headings share one top edge; dotted separators between sub-items`)
    await page.close()
  }
} finally {
  await browser.close()
}
console.log('list alignment look (ADR-0028 §4): all checks passed')
