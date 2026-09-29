// =============================================================================
// test:no-lone-last-word — ADR-0028 amendment 2026-09-28 (slide design ticket 09)
//
// What must hold:
//   1. Slide titles and statement text carry `text-wrap: pretty` (computed), so the browser
//      rebalances their last lines instead of leaving one word alone on the final line.
//   2. On two fixtures where greedy wrapping leaves a lone last word (checked below by forcing
//      `text-wrap: wrap` inline), the deck renders them with at least two words on the last line
//      and the same number of lines, at 1280×720 and 1920×1080 (ADR-0030: one scaled canvas).
//
// Compiles a real deck (prepareSource → model.fullHtml) and lets the deck runtime (fitting
// included) lay it out in Chromium. Chromium only rebalances when the cost is low: the
// layout-showcase statement "This is an important statement slide" still wraps greedily and is
// logged, not asserted.
// =============================================================================

import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

const dir = mkdtempSync(join(tmpdir(), 'tw-no-lone-last-word-'))
const source = [
  '---', 'title: No lone last word probe', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '',
  '## Fixtures', '',
  // A visible title over a statement (layout-showcase rairt): greedy "A single strong / claim".
  '### A single strong claim', '{statement}{id=title-fixture}', '',
  'The fastest way to lose an audience is a slide that says everything at once.', '',
  // A statement paragraph (agents-and-ai-2026 qkd58): greedy ends on "steps." alone.
  '### Agent definition', '{layout=statement}{id=statement-fixture}', '',
  'Model using tools in a loop to achieve complex tasks that require multiple steps.', '',
  // Dominik's screenshot: logged only (Chromium keeps the greedy break here).
  '### This is an important statement slide', '{id=screenshot-statement} {statement}', ''
].join('\n')
const path = join(dir, 'no-lone-last-word.md')
writeFileSync(path, source, 'utf8')
const model = await prepareSource(path, source, 'No lone last word probe', statSync(path))
const htmlPath = join(dir, 'no-lone-last-word.html')
writeFileSync(htmlPath, model.fullHtml, 'utf8')

const FIXTURES = [
  { id: 'title-fixture', selector: 'h1:not(.sr-only)', what: 'slide title' },
  { id: 'statement-fixture', selector: '.slide-content.layout-statement > p:not(.kicker)', what: 'statement text' }
]

// Lines of an element's text, by the top of each word's first client rect; punctuation-only
// tokens ride on the word before them.
function linesOf({ selector, forceWrap }) {
  const el = document.querySelector(`.slide.active ${selector}`)
  if (!el) return null
  if (forceWrap) el.style.textWrap = 'wrap'
  const fontSize = parseFloat(getComputedStyle(el).fontSize)
  const words = []
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  for (let node; (node = walker.nextNode());) {
    for (const match of node.textContent.matchAll(/\S+/g)) {
      range.setStart(node, match.index)
      range.setEnd(node, match.index + match[0].length)
      const rect = range.getClientRects()[0]
      if (rect) words.push({ word: match[0], top: rect.top })
    }
  }
  const lines = []
  for (const { word, top } of words) {
    const line = lines.find((candidate) => Math.abs(candidate.top - top) < fontSize * 0.5)
    if (line && !/[\p{L}\p{N}]/u.test(word)) line.words[line.words.length - 1] += word
    else if (line) line.words.push(word)
    else lines.push({ top, words: [word] })
  }
  lines.sort((a, b) => a.top - b.top)
  const textWrap = getComputedStyle(el).textWrapStyle
  if (forceWrap) el.style.textWrap = ''
  return { textWrap, lines: lines.map((line) => line.words.join(' ')) }
}

const browser = await chromium.launch({ headless: true })
const logged = []
try {
  for (const viewport of [{ width: 1280, height: 720 }, { width: 1920, height: 1080 }]) {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 })
    await page.goto(pathToFileURL(htmlPath).href)
    await page.evaluate(() => document.fonts?.ready)
    const size = `${viewport.width}x${viewport.height}`
    const show = async (id) => {
      await page.evaluate((target) => { location.hash = '#' + target }, id)
      await page.waitForFunction((target) => document.querySelector('.slide.active')?.dataset.id === target, id)
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 200)))))
    }
    for (const fixture of FIXTURES) {
      await show(fixture.id)
      const greedy = await page.evaluate(linesOf, { selector: fixture.selector, forceWrap: true })
      const pretty = await page.evaluate(linesOf, { selector: fixture.selector, forceWrap: false })
      assert(greedy && pretty, `${size} ${fixture.id}: ${fixture.what} renders`)
      assert.equal(pretty.textWrap, 'pretty', `${size} ${fixture.id}: ${fixture.what} computes text-wrap: pretty`)
      assert(greedy.lines.length > 1 && greedy.lines.at(-1).split(' ').length === 1,
        `${size} ${fixture.id}: fixture must leave a lone last word when wrapped greedily (got ${greedy.lines.join(' / ')})`)
      assert.equal(pretty.lines.length, greedy.lines.length, `${size} ${fixture.id}: rebalancing keeps the line count`)
      assert(pretty.lines.at(-1).split(' ').length >= 2,
        `${size} ${fixture.id}: ${fixture.what} ends on a lone word: ${pretty.lines.join(' / ')}`)
    }
    await show('screenshot-statement')
    const screenshot = await page.evaluate(linesOf, { selector: '.slide-content.layout-statement > p:not(.kicker)', forceWrap: false })
    logged.push(`${size} ${screenshot ? screenshot.lines.join(' / ') : '(no statement)'}`)
    await page.close()
  }
} finally {
  await browser.close()
  rmSync(dir, { recursive: true, force: true })
}
console.log(`no lone last word: title and statement fixtures rebalance at 1280x720 and 1920x1080 (logged, not asserted: ${logged.join('; ')})`)
