// =============================================================================
// test:no-lone-last-word — ADR-0028 amendment 2026-09-28 (slide design ticket 09)
//
// What must hold:
//   1. Slide titles and statement text carry `text-wrap: pretty` (computed), so the browser
//      rebalances their last lines instead of leaving one word alone on the final line.
//   2. On two fixtures where greedy wrapping leaves a lone last word (checked below by forcing
//      `text-wrap: wrap` inline AND undoing the compiler's no-break join, i.e. with neither
//      guard layer), the deck renders them with at least two words on the last line and the same
//      number of lines, at 1280×720 and 1920×1080 (ADR-0030: one scaled canvas).
//      ADR-0028 §10 has two layers since 46af11f: `text-wrap: pretty`/`balance`, and the compiler
//      joining the last two words with U+00A0 (no-lone-word.mjs). The greedy probe must strip
//      both, or it measures the guarded layout and the precondition can never hold.
//
// Compiles a real deck (prepareSource → model.fullHtml) and lets the deck runtime (fitting
// included) lay it out in Chromium. Chromium only rebalances when the cost is low: the
// layout-showcase statement "This is an important statement slide" wrapped greedily under
// `text-wrap: pretty` alone (before the no-break join) and is logged, not asserted.
//
// ADR-0033 §6/§7 (slide design round 2, ticket 08):
//   3. tieShortWords binds a, an, the, at, of, in, on, to, and, or, for, by, with, is (any case) to
//      the next word with a no-break space, in titles, and leaves code, links, braces and short
//      words with trailing punctuation alone.
//   4. In a sidebar (rail) title, a title wider than its column drops the last-two-words join and
//      wraps at normal size instead of shrinking; only more than five lines (or one word wider than
//      the column) shrinks it, in 3% steps to 60%.
//   5. A title's line never ends on a short word, except where the runtime gave the bond way
//      (h1[data-short-word-give-way]) because binding would leave a word alone or overflow.
// =============================================================================

import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { tieShortWords, keepLastTwoWordsTogether } from '../compiler/scripts/lib/no-lone-word.mjs'

// --- 3. tieShortWords (pure) -------------------------------------------------------------------
const NBSP = '&nbsp;'
assert.equal(tieShortWords('From email to completed forms'), `From email to${NBSP}completed forms`)
assert.equal(tieShortWords('What can the model do on its own with this?'),
  `What can the${NBSP}model do on${NBSP}its own with${NBSP}this?`)
assert.equal(tieShortWords('A tale of the sea'), `A${NBSP}tale of${NBSP}the${NBSP}sea`, 'case-insensitive, chains bind')
assert.equal(tieShortWords('Is AI a tool or a partner'), `Is${NBSP}AI a${NBSP}tool or${NBSP}a${NBSP}partner`)
assert.equal(tieShortWords('What is that for'), `What is${NBSP}that for`, 'a short word at the very end has nothing to bind to')
assert.equal(tieShortWords('Wait, a moment. Then, in'), `Wait, a${NBSP}moment. Then, in`)
assert.equal(tieShortWords('Yes and, then no'), 'Yes and, then no', 'a short word with trailing punctuation is left alone')
assert.equal(tieShortWords('Another thing to know'), `Another thing to${NBSP}know`, 'a short word inside a longer word is not one')
assert.equal(tieShortWords('Use <code>a b</code> in the code'), `Use <code>a b</code> in${NBSP}the${NBSP}code`, 'text inside code is not touched')
assert.equal(tieShortWords('See <a href="x">the docs</a> for more'), `See <a href="x">the docs</a> for${NBSP}more`, 'a link is skipped')
assert.equal(tieShortWords('The {id=x} slide'), 'The {id=x} slide', 'a brace token is skipped')
assert.equal(tieShortWords('Plain words only here'), 'Plain words only here', 'nothing to bind returns the input')
assert.equal(tieShortWords(`of${NBSP}this`), `of${NBSP}this`, 'an existing no-break space is kept')
// The last-two-words join runs first and its pair survives the ties.
assert.equal(tieShortWords(keepLastTwoWordsTogether('Why a model is the best')), `Why a${NBSP}model is${NBSP}the${NBSP}best`)

// Sidebar (rail) titles, from the round-2 specimen talks (slide ids in the ticket): [id, title].
const RAIL_TITLES = [
  ['cs27', 'Building explainers'],
  ['cs36', 'The UI does not make the difference obvious'],
  ['ex37', 'Phenomenal nature of LLMs vs the "ineluctable core"?'],
  ['ex34', 'What can the model do on its own with this?'],
  ['ex94', 'NotebookLM is the best place for text exploration'],
  ['ex144', 'What is the meaning of AI?'],
  ['long', 'A very long sidebar title that certainly needs far more than five lines to say everything it wants to say here']
]
// A top (wide) title from the same talks: cs22 wraps in two lines, the second must not start a chain of short words.
const TOP_TITLES = [['cs22', 'York expenses: from email to completed forms']]
const dir = mkdtempSync(join(tmpdir(), 'tw-no-lone-last-word-'))
const source = [
  '---', 'title: No lone last word probe', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '',
  '## Fixtures', '',
  // A visible title over a statement (layout-showcase rairt): greedy "A single strong / claim".
  '### A single strong claim', '{statement}{id=title-fixture}', '',
  'The fastest way to lose an audience is a slide that says everything at once.', '',
  // A statement paragraph (after agents-and-ai-2026 qkd58): greedy ends on "steps." alone. The
  // statement measure and type changed in 46af11f/3edf144, after which the deck's own wording
  // ("Model using tools …") wraps into three full lines; the "An agent is a" lead-in restores a
  // four-line greedy break with "steps." alone.
  '### Agent definition', '{layout=statement}{id=statement-fixture}', '',
  'An agent is a model using tools in a loop to achieve complex tasks that require multiple steps.', '',
  // Dominik's screenshot: logged only (under `pretty` alone Chromium kept the greedy break here).
  '### This is an important statement slide', '{id=screenshot-statement} {statement}', '',
  ...TOP_TITLES.flatMap(([id, title]) => [`### ${title}`, `{id=${id}}{title=top}`, '', '- One', '- Two', '']),
  ...RAIL_TITLES.flatMap(([id, title]) => [`### ${title}`, `{id=${id}}{title=side}`, '', '- One', '- Two', ''])
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
  // The unguarded baseline: greedy wrapping AND no no-break join (the compiler's U+00A0 between the
  // last two words, ADR-0028 §10), both restored below.
  const joined = []
  if (forceWrap) {
    el.style.textWrap = 'wrap'
    const nbspWalker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let node; (node = nbspWalker.nextNode());) {
      if (node.data.includes('\u00a0')) { joined.push([node, node.data]); node.data = node.data.replaceAll('\u00a0', ' ') }
    }
  }
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
  if (forceWrap) {
    el.style.textWrap = ''
    for (const [node, data] of joined) node.data = data
  }
  return { textWrap, lines: lines.map((line) => line.words.join(' ')) }
}

// --- 4/5. Sidebar titles in Chromium ------------------------------------------------------------
const SHORT = new Set('a an the at of in on to and or for by with is'.split(' '))
function railTitle() {
  const h1 = document.querySelector('.slide.active h1:not(.sr-only)')
  const walker = document.createTreeWalker(h1, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  const words = []
  for (let node; (node = walker.nextNode());) {
    for (const m of node.data.matchAll(/[^\s\u00a0]+/g)) {
      range.setStart(node, m.index); range.setEnd(node, m.index + m[0].length)
      const rect = range.getClientRects()[0]
      if (rect) words.push({ word: m[0], top: Math.round(rect.top / 6) })
    }
  }
  const lines = []
  for (const { word, top } of words) {
    if (!lines.length || lines.at(-1).top !== top) lines.push({ top, words: [] })
    lines.at(-1).words.push(word)
  }
  const authored = parseFloat(getComputedStyle(h1).fontSize)
  return {
    lines: lines.map((l) => l.words), inlineSize: h1.style.fontSize, size: authored, wide: h1.scrollWidth - h1.clientWidth,
    giveWay: h1.dataset.shortWordGiveWay || '', join: h1.dataset.nbJoin || ''
  }
}
async function checkRailTitles(page, show) {
  const got = {}
  for (const [id] of [...TOP_TITLES, ...RAIL_TITLES]) { await show(id); got[id] = await page.evaluate(railTitle) }
  const at = (id) => `${id}: ${got[id].lines.map((l) => l.join(' ')).join(' / ')}`
  // Normal size, wrapped: no inline shrink for a title of up to five lines, and nothing wider than its column.
  for (const id of ['cs27', 'cs36', 'ex37', 'cs22', 'ex34', 'ex94', 'ex144']) {
    assert.equal(got[id].inlineSize, '', `${at(id)} keeps its normal size (${got[id].inlineSize})`)
    assert(got[id].lines.length <= 5, `${at(id)} wraps to at most five lines`)
    assert(got[id].wide <= 1, `${at(id)} fits its column`)
  }
  assert.equal(got.ex37.lines.length, 5, `${at('ex37')}: five lines at normal size (the limit)`)
  assert(got.cs27.lines.length >= 2, `${at('cs27')}: a two-word title wider than its column wraps`)
  assert.equal(got.cs27.join, 'released', 'cs27: the last-two-words join is dropped when the title is wider than its column')
  assert(Math.abs(got.cs27.size - got.ex144.size) < 0.5, 'a wrapped rail title is the same size as a short one')
  // Only more than five lines shrinks, in 3% steps, to the 60% floor.
  const base = got.ex144.size
  assert(got.long.inlineSize !== '', `${at('long')}: more than five lines shrinks`)
  const shrunk = parseFloat(got.long.inlineSize)
  assert(shrunk >= base * 0.6 - 0.01 && shrunk < base, `${at('long')}: shrinks within the 60% floor (${shrunk} of ${base})`)
  assert(got.long.lines.length <= 5 || Math.abs(shrunk - base * 0.6) < 0.01, `${at('long')}: stops shrinking once it is five lines or at the floor`)
  // A short word never ends a line, unless the runtime gave the bond way; a word left alone is what makes it give way.
  for (const id of ['cs36', 'cs22', 'ex34', 'ex94', 'ex144']) {
    got[id].lines.slice(0, -1).forEach((words) => {
      if (SHORT.has(words.at(-1).toLowerCase().replace(/[^a-z]/g, '')))
        assert(got[id].giveWay, `${at(id)}: a line ends on a short word without a give-way`)
    })
  }
  assert(!got.cs22.giveWay && !got.ex34.giveWay, `cs22 and ex34 need no give-way (${at('cs22')}; ${at('ex34')})`)
  assert(got.cs22.lines.every((l, i) => i === got.cs22.lines.length - 1 || !SHORT.has(l.at(-1).toLowerCase())), `${at('cs22')}`)
  // Nothing is stranded by the rule: ex144 has no one-word line, and cs36 does not leave "make" alone.
  assert(got.ex144.lines.every((l) => l.length > 1), `${at('ex144')}: no word alone`)
  assert(!got.cs36.lines.some((l) => l.length === 1 && l[0] === 'make'), `${at('cs36')}: "make" is not alone`)
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
    if (viewport.width === 1920) await checkRailTitles(page, show)
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
