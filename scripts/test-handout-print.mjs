#!/usr/bin/env node
/**
 * Printing the handout page (the share page's Print button calls window.print()): every slide, one per
 * landscape page, each scaled to the page width. Found 2026-10-12: the stage clipped everything after the
 * first screen, so the print was one cropped title slide.
 *
 * Real pipeline: outline -> prepareSource -> compiled deck -> extractSlides -> buildShareHtml, then the page is
 * opened in the headless browser under print media and printed to PDF. Checked for the Download handout build and
 * for the published (lazyAssets) build: the page count equals the slide count, every page is landscape, each
 * page carries its own slide's title and none carries the page's own chrome.
 * Carousels (2026-10-12): the same checks on a talk with four carousels (scripts/lib/handout-carousel-fixture.mjs): each
 * carousel item prints on its own landscape page with the slide's title and a "2 / 3" marker, nothing is blank or
 * cut off (an item taller than its page is scaled to fit), the other slides still print one per page.
 * Set HANDOUT_PRINT_SHOTS_DIR to also keep the PDF and a picture of each page (needs pdftoppm).
 */
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildDeckHtmlFromModel } from '../compiler/scripts/lib/07-assembly.mjs'
import { extractSlides, extractStyles } from '../compiler/scripts/lib/04-html-extraction.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'
import { buildCarouselHandout, CAROUSEL_WORDS, CAROUSEL_ITEM_COUNT, CAROUSEL_SLIDE_COUNT } from './lib/handout-carousel-fixture.mjs'

const dir = mkdtempSync(join(tmpdir(), 'tw-handout-print-'))
const shotsDir = process.env.HANDOUT_PRINT_SHOTS_DIR ? resolve(process.env.HANDOUT_PRINT_SHOTS_DIR) : ''
if (shotsDir) mkdirSync(shotsDir, { recursive: true })

const outline = [
  '# Paper probe', '', '## Probe', '',
  '### Opening slide', '{statement}', '', 'A first statement.', '',
  '### A list of four {list}', '', '- One', '- Two', '- Three', '- Four', '',
  '### A plain quote', '{quote}', '', '> The essence of metaphor is understanding one thing in terms of another.', '', '- George Lakoff, 1980', '',
  '### Another statement', '{statement}', '', 'A fourth statement.', '',
  '### Closing slide', '{statement}', '', 'The last statement.', ''
].join('\n')

/** Build the share page for an outline, print it to PDF, return { pages, sizes, texts }. */
async function printed(browser, name, markdown, options) {
  const path = join(dir, `${name}.md`)
  writeFileSync(path, markdown)
  const model = await prepareSource(path, markdown, 'Talk', statSync(path), undefined, { allowedAssetRoots: [dir] })
  const deck = await buildDeckHtmlFromModel(model)
  const html = buildShareHtml({ title: 'Talk', slug: 't', includeNotes: false, license: null, slides: extractSlides(deck), styles: extractStyles(deck), ...options })
  const htmlPath = join(dir, `${name}.html`)
  writeFileSync(htmlPath, html)
  return { ...(await printFile(browser, name, htmlPath)), slideCount: extractSlides(deck).length }
}

/** Print an already built handout page to PDF, return { pages, sizes, texts, pdfPath }. */
async function printFile(browser, name, htmlPath) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 } })
  try {
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' })
    await page.evaluate(() => document.fonts?.ready)
    await page.waitForTimeout(400)
    await page.emulateMedia({ media: 'print' })
    const pdfPath = shotsDir ? join(shotsDir, `${name}.pdf`) : join(dir, `${name}.pdf`)
    await page.pdf({ path: pdfPath, preferCSSPageSize: true, printBackground: true })
    const info = execFileSync('pdfinfo', ['-f', '1', '-l', '99', pdfPath], { encoding: 'utf8' })
    const sizes = [...info.matchAll(/Page\s+\d+ size:\s+([\d.]+) x ([\d.]+) pts/g)].map((m) => [Number(m[1]), Number(m[2])])
    const texts = []
    for (let n = 1; n <= sizes.length; n += 1) texts.push(execFileSync('pdftotext', ['-f', String(n), '-l', String(n), pdfPath, '-'], { encoding: 'utf8' }))
    return { pages: sizes.length, sizes, texts, pdfPath }
  } finally {
    await page.close()
  }
}

const browser = await chromium.launch({ headless: true })
try {
  for (const [name, options] of [['download', {}], ['published', { lazyAssets: true }]]) {
    const out = await printed(browser, name, outline, options)
    // The compiler adds a title slide, a section divider and a closing slide around the five written ones.
    assert.equal(out.slideCount, 8, `${name}: the deck has eight slides`)
    assert.equal(out.pages, out.slideCount, `${name}: every slide prints, one per page (got ${out.pages} pages)`)
    out.sizes.forEach(([w, h], i) => assert(w > h, `${name}: page ${i + 1} is landscape`))
    // Each written slide's words sit on one page only, in order; no page carries the page's own chrome.
    const words = ['A first statement.', 'Four', 'essence of metaphor', 'A fourth statement.', 'The last statement.']
    const at = words.map((word) => out.texts.flatMap((text, i) => (text.includes(word) ? [i] : [])))
    at.forEach((where, i) => assert.equal(where.length, 1, `${name}: "${words[i]}" is on exactly one page (pages ${where.map((n) => n + 1)})`))
    assert.deepEqual(at.flat(), [2, 3, 4, 5, 6], `${name}: the written slides print in order on pages 3 to 7`)
    out.texts.forEach((text, i) => assert(!/\b(Print|Overview|Prev|Next|Notes|Help)\b/.test(text), `${name}: page ${i + 1} carries no page chrome (${JSON.stringify(text.slice(0, 120))})`))
    if (shotsDir) execFileSync('pdftoppm', ['-r', '60', '-png', out.pdfPath, join(shotsDir, name)])
  }
  // Carousels: the Download handout and the published (lazyAssets) build.
  for (const [name, options] of [['carousel-download', {}], ['carousel-published', { lazyAssets: true }]]) {
    const built = await buildCarouselHandout(dir, name, options)
    const out = await printFile(browser, name, built.htmlPath)
    const expected = built.slideCount - CAROUSEL_SLIDE_COUNT + CAROUSEL_ITEM_COUNT
    assert.equal(out.pages, expected, `${name}: ${built.slideCount} slides, ${CAROUSEL_SLIDE_COUNT} of them carousels with ${CAROUSEL_ITEM_COUNT} items, print on ${expected} pages (got ${out.pages})`)
    out.sizes.forEach(([w, h], i) => assert(w > h, `${name}: page ${i + 1} is landscape`))
    out.texts.forEach((text, i) => {
      assert(text.trim().length > 0, `${name}: page ${i + 1} is not blank`)
      assert(!/\b(Print|Overview|Prev|Next|Notes|Help)\b/.test(text), `${name}: page ${i + 1} carries no page chrome`)
    })
    const where = (word) => out.texts.flatMap((text, i) => (text.includes(word) ? [i] : []))
    const groups = [['Paragraph carousel', CAROUSEL_WORDS.paragraph], ['Heading carousel', CAROUSEL_WORDS.heading], ['Picture carousel', CAROUSEL_WORDS.picture], ['Tall carousel', CAROUSEL_WORDS.tall]]
    const order = [where(CAROUSEL_WORDS.opening)]
    for (const [title, words] of groups) {
      words.forEach((word, k) => {
        const at = where(word)
        assert.equal(at.length, 1, `${name}: "${word}" is on exactly one page (pages ${at.map((n) => n + 1)})`)
        const text = out.texts[at[0]]
        assert(text.includes(title), `${name}: the page of "${word}" repeats the slide title "${title}"`)
        assert(text.replace(/\s+/g, '').includes(`${k + 1}/${words.length}`), `${name}: the page of "${word}" carries its "${k + 1} / ${words.length}" marker`)
        order.push(at)
      })
    }
    order.push(where(CAROUSEL_WORDS.closing))
    order.forEach((at, i) => assert.equal(at.length, 1, `${name}: expected text ${i} is on one page`))
    const pages = order.flat()
    assert.deepEqual(pages, [...pages].sort((a, b) => a - b), `${name}: items print in order`)
    assert.equal(new Set(pages).size, pages.length, `${name}: no two items share a page`)
    // Each carousel slide's items sit on consecutive pages; the slides around them are one page each.
    assert.equal(pages[0], 2, `${name}: the opening slide is page 3 (title and section slides first)`)
    assert.equal(pages.at(-1), expected - 2, `${name}: the closing slide is the second last page (the thank-you slide follows)`)
    if (shotsDir) execFileSync('pdftoppm', ['-r', '60', '-png', out.pdfPath, join(shotsDir, name)])
  }
  console.log('handout print: every slide prints on its own landscape page, one slide each, no page chrome, download and published builds pass; carousel items print one per page with title and marker')
} finally {
  await browser.close()
  rmSync(dir, { recursive: true, force: true })
}
