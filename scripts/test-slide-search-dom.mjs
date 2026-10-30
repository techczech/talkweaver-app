// Search in the grid and the outline sidebar (slide handling ticket 2), in a browser (Playwright's chromium
// headless shell, never the real Chrome) with the app's real stylesheet.
// Mounted: the real SlidesOrganizer and GridView on ONE talk key (so they share one query string), the picture-text
// lookup stubbed (window.tw.talk.slidePictureText), previews published as the workspace does (publishSlideThumbs).
//   outline: dim in place (nothing hidden), <mark> hits, "in text:" / "in picture:" line, section hit counts, k of N and
//            Previous / Next move the editor (onJump), rows stay draggable, a preview only under hits while searching;
//   grid:    dim in place, <mark> hits, snippet, k of N and Previous / Next change the active card, drag and ticks stay on;
//   both:    one query string; operators (t: s: i: e:) and a Scratchpad prefix (slide:).
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('..', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'talk-weaver-slide-search-'))
const outfile = join(dir, 'bundle.js')
const TALK_KEY = '/v/t/t-outline.md'

// 3 sections, 4 slides each; a few slides carry a distinctive word in the body or in a picture.
const BODY = { 1: 'a citation that looks real', 6: 'checking citations twice', 9: 'only a zebra here' }
const PICTURE = { 2: 'Screenshot: chatbot reply with a zebra', 7: 'Notebook output: regression table' }
const parts = ['# Talk', '']
let n = 0
for (let s = 1; s <= 3; s += 1) {
  parts.push(`## Section ${s}`, '')
  for (let i = 1; i <= 4; i += 1) {
    n += 1
    parts.push(`### Slide ${n}`, `{id=s${n}}`, '', `- ${BODY[n] ?? `plain point ${n}`}`, '', ...(PICTURE[n] ? [`![](img-${String(n).padStart(7, '0')}.png)`, ''] : []))
  }
}
const TALK = parts.join('\n')
const SLIDES = n

const entry = `
import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import SlidesOrganizer from './src/renderer/src/components/SlidesOrganizer.tsx'
import GridView from './src/renderer/src/components/GridView.tsx'
import { publishStripNumbers } from './src/renderer/src/lib/stripNumbers.ts'
import { publishOutline, resetOutlineCollapseForTests } from './src/renderer/src/lib/outlineCollapseStore.ts'
import { publishSlideThumbs, setSlideQuery, pictureTextByRef } from './src/renderer/src/lib/slideSearch.ts'

const TALK_KEY = ${JSON.stringify(TALK_KEY)}
const PICTURE = ${JSON.stringify(PICTURE)}
const doc = ${JSON.stringify(TALK)}
window.asked = []
window.PICTURE = PICTURE
window.gen = 0
window.failNext = false
window.pictureTextByRef = pictureTextByRef
window.tw = { talk: {
  slidePictureGeneration: async () => window.gen,
  slidePictureText: async (path, blocks) => { window.asked.push(blocks.length); if (window.failNext) { window.failNext = false; throw new Error('boom') } return blocks.map((b) => { const m = b.match(/img-0*(\\d+)\\.png/); return m && PICTURE[m[1]] ? PICTURE[m[1]] : '' }) }
} }
window.jumps = []
window.moves = []
window.opMoves = []
window.selects = []

// The compiled cards: a section-title card per ## and a card per ### (what the workspace compiles).
function cardsOf(text) {
  const lines = text.split('\\n')
  const rows = []
  // A cover title card with no heading line (as a front-matter title): the grid has it, the outline has no row for it.
  if (window.withCover) rows.push({ slide_id: 'cover', title: 'Cover about a citation', nav_title: 'Cover about a citation', section: '', role: 'title', layout: 'title', source_markdown: '', render_hash: 'cover', content_hash: 'cover', warnings: [] })
  let section = ''
  lines.forEach((l, i) => {
    const m = l.match(/^(#{2,3})\\s+(.*)$/)
    if (!m) return
    const title = m[2]
    let body = l
    for (let j = i + 1; j < lines.length && !/^#{1,6}\\s/.test(lines[j]); j += 1) body += '\\n' + lines[j]
    if (m[1].length === 2) { section = title; rows.push({ slide_id: 'sec-' + i, title, nav_title: title, section, role: 'section-title', layout: 'section', source_markdown: '', render_hash: 'sec' + i, content_hash: 'sec' + i, warnings: [], line: i + 1 }) }
    else rows.push({ slide_id: 's' + title.split(' ')[1], title, nav_title: title, section, role: 'content', layout: 'default', source_markdown: body, render_hash: 'h' + i, content_hash: 'h' + i, warnings: [], line: i + 1 })
  })
  return rows
}
const cards = cardsOf(doc)
const PIX = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="#cde"/></svg>')

window.__orig = doc
window.setCover = (on) => { window.withCover = on; window.setDoc(on ? doc + '\\n' : doc) }
window.publishNumbers = (m) => publishStripNumbers(m)
window.mountBoth = () => {
  resetOutlineCollapseForTests({ storage: null })
  setSlideQuery(TALK_KEY, '')
  publishOutline(TALK_KEY, doc)
  publishStripNumbers(new Map(cards.map((c, i) => [c.line, i + 2])))
  publishSlideThumbs([null, ...cards.map(() => PIX)])
  function Host() {
    const [active, setActive] = useState(1)
    const [d, setD] = useState(doc)
    window.setDoc = (next) => { publishOutline(TALK_KEY, next); const cs = cardsOf(next); publishStripNumbers(new Map(cs.map((c, i) => [c.line, i + 2]))); flushSync(() => setD(next)) }
    const cards = React.useMemo(() => cardsOf(d), [d])
    return React.createElement('div', { style: { display: 'flex', gap: 16 } },
      React.createElement('div', { id: 'nav', style: { width: 300, height: 640, display: 'flex', flexDirection: 'column' } },
        React.createElement(SlidesOrganizer, { content: d, onJump: (line, opts) => window.jumps.push([line, opts?.takeFocus ?? true]), ops: { move: (line, dir) => window.opMoves.push([line, dir]), reLevel: () => {}, moveTo: () => {}, moveToEnd: () => {}, moveInto: () => {} }, talkKey: TALK_KEY, talkTitle: 'T' })),
      React.createElement('div', { id: 'grid', style: { width: 700, height: 640 } },
        React.createElement(GridView, {
          talk: { slug: 't', title: 'T', outlinePath: TALK_KEY }, compiledSlides: cards, triggerFindings: [], thumbnails: null,
          activeIndex: active, columns: 3, onSelectSlide: (i) => { window.activeIndex = i; window.selects.push(i); setActive(i) }, onEdit: () => {},
          slideRefOf: (i) => cards[i] ? { line: cards[i].line, headingText: cards[i].source_markdown ? cards[i].source_markdown.split('\\n')[0] : cards[i].title } : null,
          onMoveSlides: (refs, place) => window.moves.push([refs.length, place.kind]),
          onCutSlides: async () => true, onCopySlides: () => 'x'
        })))
  }
  const rootEl = createRoot(document.getElementById('stage'))
  flushSync(() => rootEl.render(React.createElement(Host)))
}
`

let browser
let passed = 0
const pass = (m) => { passed += 1; console.log(`PASS ${m}`) }
try {
  await build({
    stdin: { contents: entry, resolveDir: root, sourcefile: 'slide-search-entry.tsx', loader: 'tsx' },
    bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', outfile, logLevel: 'error',
    define: { 'process.env.NODE_ENV': '"production"' }
  })
  browser = await chromium.launch()
  const ORIGIN = 'http://localhost:4173'
  const context = await browser.newContext({ viewport: { width: 1100, height: 760 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body style="margin:0"><div id="stage" style="padding:20px"></div></body></html>' }))
  await page.goto(`${ORIGIN}/`)
  await page.addStyleTag({ content: readFileSync(join(root, 'src/renderer/src/styles.css'), 'utf8') })
  await page.addScriptTag({ content: readFileSync(outfile, 'utf8') })
  await page.evaluate(() => window.mountBoth())

  const sleep = (ms) => page.waitForTimeout(ms)
  const ORG = '.slides-organizer'
  const GRID = '.grid-view'
  const oSearch = page.locator(`${ORG} .so-search-input`)
  const gSearch = page.locator(`${GRID} [data-grid-search]`)
  const texts = (sel) => page.locator(sel).allTextContents()
  const oLit = () => texts(`${ORG} .so-slide:not(.so-row--dim) .so-slide-title`)
  const gLit = () => page.locator(`${GRID} .grid-cell:not([data-search-dim])`).evaluateAll((els) => els.map((e) => e.getAttribute('data-slide-index')))

  // ── outline ──
  const rowsBefore = await page.locator(`${ORG} [data-line]`).count()
  assert.equal(await page.locator(`${ORG} [data-so-thumb]`).count(), 0, 'no preview while not searching: text-only')
  assert.equal(await page.locator(`${ORG} [data-so-hitbar]`).count(), 0)
  await oSearch.fill('citation')
  await sleep(450)
  assert.equal(await page.locator(`${ORG} [data-line]`).count(), rowsBefore, 'a search hides no row')
  assert.deepEqual(await oLit(), ['Slide 1', 'Slide 6'], 'rows whose text holds the word stay lit, the rest dim')
  assert.ok((await page.locator(`${ORG} .so-slide.so-row--dim`).count()) >= SLIDES - 2)
  assert.deepEqual(await texts(`${ORG} .so-slide:not(.so-row--dim) mark`), ['citation', 'citation'], 'the hit is marked in the line under the title')
  assert.deepEqual(await texts(`${ORG} [data-so-snippet]`).then((t) => t.map((x) => x.split(':')[0])), ['in text', 'in text'])
  assert.deepEqual(await texts(`${ORG} [data-so-hits]`), ['2 hits', '1 hit', '1 hit'], 'the title row and each section show how many hits they hold; a section with none dims')
  assert.equal(await page.locator(`${ORG} .so-section.so-row--dim`).count(), 1)
  assert.equal((await page.locator(`${ORG} [data-so-hitcount]`).textContent()).replace(/\s+/g, ' ').trim(), '1 of 2')
  pass('outline: dim in place, marks, "in text:" line, section hit counts, k of N')

  assert.equal(await page.locator(`${ORG} [data-so-thumb]`).count(), 2, 'a preview under each matching row while a search is active, none under the dimmed rows')
  pass('outline: previews only under hits while searching (option C)')

  assert.ok(await page.evaluate(() => window.jumps.length) >= 1, 'typing took the editor to the first hit')
  assert.equal((await page.evaluate(() => window.jumps)).at(-1)[1], false, 'without taking the keyboard out of the search box')
  const jumpsBefore = await page.evaluate(() => window.jumps.length)
  await page.locator(`${ORG} [data-so-next]`).click()
  await sleep(50)
  const jumps = await page.evaluate(() => window.jumps)
  assert.equal(jumps.length, jumpsBefore + 1, 'Next moves the editor')
  assert.equal(jumps.at(-1)[0], TALK.split('\n').indexOf('### Slide 6') + 1, 'to the second hit')
  assert.equal((await page.locator(`${ORG} [data-so-hitcount]`).textContent()).replace(/\s+/g, ' ').trim(), '2 of 2')
  await page.locator(`${ORG} [data-so-next]`).click()
  assert.equal((await page.locator(`${ORG} [data-so-hitcount]`).textContent()).replace(/\s+/g, ' ').trim(), '1 of 2', 'Next wraps')
  await page.locator(`${ORG} [data-so-prev]`).click()
  assert.equal((await page.locator(`${ORG} [data-so-hitcount]`).textContent()).replace(/\s+/g, ' ').trim(), '2 of 2', 'Previous wraps back')
  await oSearch.press('Enter')
  assert.equal((await page.locator(`${ORG} [data-so-hitcount]`).textContent()).replace(/\s+/g, ' ').trim(), '1 of 2', 'Enter in the box is Next')
  await oSearch.press('Shift+Enter')
  assert.equal((await page.locator(`${ORG} [data-so-hitcount]`).textContent()).replace(/\s+/g, ' ').trim(), '2 of 2', 'Shift+Enter is Previous')
  pass('outline: k of N, Previous / Next (button, Enter, Shift+Enter) move the editor and wrap')

  const drag = await page.evaluate((sel) => ({ rows: [...document.querySelectorAll(sel + ' [data-line]')].every((r) => r.getAttribute('draggable') === 'true'), end: !!document.querySelector(sel + ' [data-drop-end]'), carets: document.querySelectorAll(sel + ' .so-caret').length }), ORG)
  assert.deepEqual(drag, { rows: true, end: true, carets: 4 }, 'while searching every row stays draggable, with its drop zone and its collapse caret')
  pass('outline: drag stays on while searching')

  // picture text
  await oSearch.fill('zebra')
  await sleep(500)
  assert.deepEqual(await oLit(), ['Slide 2', 'Slide 9'])
  assert.deepEqual((await texts(`${ORG} [data-so-snippet]`)).map((t) => t.split(':')[0]), ['in picture', 'in text'], 'a word found in a picture says "in picture:"')
  pass('outline: picture text is searched and quoted as "in picture:"')

  // ── one query: the grid shows what the outline typed ──
  assert.equal(await gSearch.inputValue(), 'zebra', 'one shared query between outline and grid')
  assert.deepEqual(await gLit(), ['2', '11'], 'grid lights the same slides (its cards are numbered with the section cards)')
  pass('both: one query string; the grid shows the outline query')

  // ── grid ──
  await gSearch.fill('citation')
  await sleep(450)
  assert.equal(await oSearch.inputValue(), 'citation', 'typing in the grid box changes the outline box')
  const cellCount = await page.locator(`${GRID} .grid-cell`).count()
  assert.equal(cellCount, SLIDES + 3, 'the grid hides no card (every slide and the three section cards)')
  assert.deepEqual(await gLit(), ['1', '7'], 'only matching cards stay lit')
  assert.deepEqual(await texts(`${GRID} .grid-cell:not([data-search-dim]) mark`), ['citation', 'citation'], 'the hit in each snippet is marked')
  assert.deepEqual((await texts(`${GRID} [data-grid-snippet]`)).map((t) => t.split(':')[0]), ['in text', 'in text'])
  const gCount = async () => (await page.locator(`${GRID} [data-grid-hitcount]`).textContent()).replace(/\s+/g, ' ').trim()
  assert.equal(await gCount(), '2 of 2', 'typing lands on the first hit at or after the active card (card 2, so the second hit)')
  assert.deepEqual(await texts(`${GRID} [data-grid-section-hits]`), ['1 hit', '1 hit'])
  pass('grid: dim in place, snippet, section hit counts, k of N')

  const a0 = await page.evaluate(() => window.activeIndex)
  await page.locator(`${GRID} [data-grid-next]`).click()
  await sleep(80)
  assert.notEqual(await page.evaluate(() => window.activeIndex), a0, 'Next changes the active card')
  assert.equal(await page.locator(`${GRID} [data-search-hit]`).getAttribute('data-slide-index'), String(await page.evaluate(() => window.activeIndex)))
  assert.equal(await gCount(), '1 of 2', 'Next wraps from the last hit to the first')
  await page.locator(`${GRID} [data-grid-next]`).click()
  assert.equal(await gCount(), '2 of 2')
  pass('grid: Previous / Next move through the hits')

  const dr = await page.evaluate((sel) => [...document.querySelectorAll(sel + ' .grid-cell')].every((c) => c.getAttribute('draggable') === 'true'), GRID)
  assert.ok(dr, 'cards stay draggable while searching')
  await page.locator(`${GRID} .grid-cell[data-slide-index="3"]`).hover()
  await page.locator(`${GRID} .grid-cell[data-slide-index="3"] [data-grid-tick]`).click()
  await page.locator(`${GRID} .grid-cell[data-slide-index="4"]`).hover()
  await page.locator(`${GRID} .grid-cell[data-slide-index="4"] [data-grid-tick]`).click()
  assert.equal(await page.locator(`${GRID} .grid-cell[data-selected="true"]`).count(), 2, 'dimmed cards can still be ticked')
  pass('grid: drag and selection stay on while searching')

  // ── operators and prefix ──
  await oSearch.fill('t:zebra')
  await sleep(450)
  assert.deepEqual(await oLit(), [], 't: looks in titles only')
  await oSearch.fill('i:zebra')
  await sleep(450)
  assert.deepEqual(await oLit(), ['Slide 2'], 'i: looks in picture text only')
  await oSearch.fill('s:zebra')
  await sleep(450)
  assert.deepEqual(await oLit(), ['Slide 9'], 's: looks in slide text only')
  await oSearch.fill('e:"looks real"')
  await sleep(450)
  assert.deepEqual(await oLit(), ['Slide 1'], 'e: an exact phrase')
  await oSearch.fill('svg: citation')
  await sleep(450)
  assert.deepEqual(await oLit(), [], 'a type prefix other than slide: leaves no slide')
  await oSearch.fill('slide: citation')
  await sleep(450)
  assert.deepEqual(await oLit(), ['Slide 1', 'Slide 6'], 'slide: keeps slides')
  pass('operators t: s: i: e: and the slide: / svg: prefixes work in the outline')

  // ── a search never moves the selection or the caret after the content changes (review round 1, F1) ──
  await gSearch.fill('')
  await oSearch.fill('')
  await sleep(200)
  const lineOf = (title) => TALK.split('\n').indexOf(`### ${title}`) + 1
  await oSearch.fill('citation')
  await sleep(450)
  const hitText = async () => (await page.locator(`${ORG} .so-row--hit .so-slide-title`).allTextContents())
  assert.deepEqual(await hitText(), ['Slide 1'], 'typing landed on the first hit')
  await page.locator(`${ORG} [data-line="${lineOf('Slide 3')}"] .so-slide-title`).click()
  await sleep(60)
  const selText = async () => (await page.locator(`${ORG} .so-row--sel .so-slide-title`).allTextContents())
  assert.deepEqual(await selText(), ['Slide 3'])
  await page.keyboard.press('Meta+ArrowUp')
  await sleep(80)
  assert.deepEqual((await page.evaluate(() => window.opMoves)).at(-1), [lineOf('Slide 3'), 'up'], 'search active, a non-hit row selected: Cmd+Up moves THAT row')
  assert.deepEqual(await hitText(), ['Slide 1'], 'and the hit stays where it was')
  pass('outline: with a search active Cmd+Up moves the selected row, not the hit')

  const jumpsN = await page.evaluate(() => window.jumps.length)
  const shifted = TALK.replace('### Slide 1\n', '### Slide 0\n{id=s0}\n\n- extra\n\n### Slide 1\n')
  assert.notEqual(shifted, TALK)
  await page.evaluate((t) => window.setDoc(t), shifted)
  await sleep(450)
  assert.deepEqual(await selText(), ['Slide 3'], 'an edit that shifts lines above the hit leaves the selection where it was')
  assert.equal(await page.evaluate(() => window.jumps.length), jumpsN, 'and the editor caret is not moved')
  assert.deepEqual(await hitText(), ['Slide 1'], 'the current hit is found again by its heading')
  assert.equal((await page.locator(`${ORG} [data-so-hitcount]`).textContent()).replace(/\s+/g, ' ').trim(), '1 of 2')
  const movesN = await page.evaluate(() => window.opMoves.length)
  await page.locator(`${ORG} .so-row--sel .so-slide-title`).click() // focus back on the panel (the click only re-selects the row)
  await page.keyboard.press('Meta+ArrowUp')
  await sleep(80)
  assert.equal(await page.evaluate(() => window.opMoves.length), movesN + 1)
  const shiftedLine = shifted.split('\n').indexOf('### Slide 3') + 1
  assert.deepEqual((await page.evaluate(() => window.opMoves)).at(-1), [shiftedLine, 'up'], 'Cmd+Up still moves the user\'s row at its new line')
  pass('outline: an edit that shifts lines moves neither the selection nor the caret; the hit follows its heading')

  // the grid: a recompile with the cards moved
  await page.evaluate(() => window.setDoc(window.__orig))
  await sleep(100)
  await oSearch.fill('')
  await gSearch.fill('zebra')
  await sleep(450)
  const gHit = async () => page.locator(`${GRID} [data-search-hit]`).evaluateAll((els) => els.map((e) => e.getAttribute('data-slide-index')))
  const hitBefore = await gHit()
  assert.equal(hitBefore.length, 1)
  const selectsN = await page.evaluate(() => window.selects.length)
  const activeBefore = await page.evaluate(() => window.activeIndex)
  const askedBefore = await page.evaluate(() => window.asked.length)
  await page.evaluate((t) => window.setDoc(t), shifted)
  await sleep(450)
  assert.equal(await page.evaluate(() => window.selects.length), selectsN, 'a recompile selects nothing')
  assert.equal(await page.evaluate(() => window.activeIndex), activeBefore, 'the active card does not change')
  assert.deepEqual(await gHit(), [String(Number(hitBefore[0]) + 1)], 'the hit card is found again by its title at its new place')
  assert.equal(await page.evaluate(() => window.asked.length), askedBefore, 'an edit that names the same pictures asks for no picture text again (one request per set of picture references, shared by both views)')
  pass('grid: a recompile that shifts the cards moves no selection; the hit follows its title')

  // typing in the grid does not open a collapsed section (the outline does not either)
  await page.evaluate(() => window.setDoc(window.__orig))
  await gSearch.fill('')
  await sleep(200)
  await page.locator(`${GRID} [data-grid-collapse-all]`).click()
  await sleep(100)
  const cellsClosed = await page.locator(`${GRID} .grid-cell`).count()
  await gSearch.fill('citation')
  await sleep(450)
  assert.equal(await page.locator(`${GRID} .grid-cell`).count(), cellsClosed, 'typing a search in the grid opens no collapsed section')
  await page.locator(`${GRID} [data-grid-next]`).click()
  await sleep(100)
  assert.ok((await page.locator(`${GRID} .grid-cell`).count()) > cellsClosed, 'Next does reveal the hit')
  pass('grid: typing opens no collapsed section; Next does')

  // from: reads the same talk title in both
  await page.locator(`${GRID} [data-grid-expand-all]`).click()
  await sleep(100)
  await gSearch.fill('from:t')
  await sleep(450)
  assert.equal(await page.locator(`${ORG} .so-slide:not(.so-row--dim)`).count(), SLIDES, 'from: the talk title lights every slide in the outline')
  assert.equal((await gLit()).length, SLIDES + 3, 'and in the grid')
  pass('both: from: compares the same talk title')

  // stale numbers: no preview rather than a wrong one
  await oSearch.fill('citation')
  await sleep(450)
  assert.equal(await page.locator(`${ORG} [data-so-thumb]`).count(), 2)
  await page.evaluate(() => window.publishNumbers(new Map([[9999, 2], [9998, 3]])))
  await sleep(100)
  assert.equal(await page.locator(`${ORG} [data-so-thumb]`).count(), 0, 'numbers that do not match the rows (counted by position): text-only rows')
  pass('outline: stale slide numbers show no preview')

  // ── fix round 2: landing only in answer to the query text; picture text follows the OCR generation ──
  await page.evaluate(() => window.setDoc(window.__orig))
  await oSearch.fill('')
  await sleep(200)
  const state = async () => ({ jumps: await page.evaluate(() => window.jumps.length), selects: await page.evaluate(() => window.selects.length), sel: await selText(), active: await page.evaluate(() => window.activeIndex) })
  const above = TALK.replace('### Slide 1\n', '### Slide 0\n{id=s0}\n\n- extra\n\n### Slide 1\n')

  // outline: refine to a query with the same hits, then edit above the hits
  await oSearch.fill('citatio')
  await sleep(450)
  await oSearch.fill('citation')
  await sleep(450)
  let st = await state()
  await page.evaluate((t) => window.setDoc(t), above)
  await sleep(450)
  assert.deepEqual(await state(), st, 'outline: refined query with the same hits, then an edit above them: caret and selection stay')
  await page.evaluate(() => window.setDoc(window.__orig)) // undo while searching
  await sleep(450)
  assert.deepEqual(await state(), st, 'outline: undo while searching moves nothing')
  // a query with no hit, then an edit that creates one
  await oSearch.fill('qqzzy')
  await sleep(450)
  st = await state()
  await page.evaluate((t) => window.setDoc(t), TALK.replace('plain point 5', 'plain qqzzy 5'))
  await sleep(450)
  assert.deepEqual(await state(), st, 'outline: no-hit query, then an edit that creates a hit: nothing moves')
  await page.evaluate(() => window.setDoc(window.__orig))
  await oSearch.fill('')
  await sleep(200)
  pass('outline: caret and selection move only for the query, Next / Previous or a click')

  // grid: the same three
  await gSearch.fill('citatio')
  await sleep(450)
  await gSearch.fill('citation')
  await sleep(450)
  st = await state()
  await page.evaluate((t) => window.setDoc(t), above)
  await sleep(450)
  assert.deepEqual(await state(), st, 'grid: refined query with the same hits, then an edit above them: selection stays')
  await page.evaluate(() => window.setDoc(window.__orig))
  await sleep(450)
  assert.deepEqual(await state(), st, 'grid: undo while searching moves nothing')
  await gSearch.fill('qqzzy')
  await sleep(450)
  st = await state()
  await page.evaluate((t) => window.setDoc(t), TALK.replace('plain point 5', 'plain qqzzy 5'))
  await sleep(450)
  assert.deepEqual(await state(), st, 'grid: no-hit query, then an edit that creates a hit: nothing moves')
  await page.evaluate(() => window.setDoc(window.__orig))
  await gSearch.fill('')
  await sleep(200)
  pass('grid: selection moves only for the query, Next / Previous or a click')

  // picture text: a picture read later (generation rises) is found; a rejected request is not cached
  await gSearch.fill('quokka')
  await sleep(450)
  assert.equal((await gLit()).length, 0, 'no picture says quokka yet')
  await page.evaluate(() => { window.PICTURE[2] = 'Screenshot: a quokka'; window.gen = 1 })
  await sleep(2800)
  assert.equal((await gLit()).length, 1, 'the new picture text is found once the OCR generation rises')
  await gSearch.fill('')
  await sleep(200)
  const rej = await page.evaluate(async () => {
    window.gen = 2
    const path = '/v/t/t-outline.md'
    const refs = ['img-0000002.png']
    const key = path + '\u0000' + refs.join('\u0001')
    const asked0 = window.asked.length
    window.failNext = true
    const first = await window.pictureTextByRef(path, key)
    const second = await window.pictureTextByRef(path, key)
    return { first: first.get(refs[0]), second: second.get(refs[0]), asks: window.asked.length - asked0 }
  })
  assert.equal(rej.first, '', 'a rejected request answers empty')
  assert.equal(rej.second, 'Screenshot: a quokka', 'and is not cached: the next ask goes to the main process again')
  assert.equal(rej.asks, 2)
  pass('picture text: refetched when the OCR generation rises; a rejected request is not cached')

  // ── clearing ──
  await oSearch.fill('')
  await sleep(200)
  assert.equal(await page.locator(`${ORG} [data-so-thumb]`).count(), 0, 'previews go when the search ends')
  assert.equal(await page.locator(`${ORG} .so-row--dim`).count(), 0)
  assert.equal(await page.locator(`${GRID} [data-search-dim]`).count(), 0)
  assert.equal(await page.locator(`${GRID} [data-grid-hitbar]`).count(), 0)
  pass('clearing the query restores both views')

  // The count rule: a cover title card that has no heading in the text is not a searched slide in either view.
  await page.evaluate(() => window.setCover(true))
  await sleep(80)
  assert.equal(await page.locator(`${GRID} .grid-cell`).count(), SLIDES + 3 + 1, 'the grid shows the cover card as well')
  await oSearch.fill('citation')
  await sleep(300)
  assert.equal((await page.locator(`${ORG} [data-so-hitcount]`).textContent()).replace(/\s+/g, ' ').trim().split(' of ')[1], '2', 'outline counts the two slides with a citation')
  assert.equal((await gCount()).split(' of ')[1], '2', 'the grid counts the same two: the cover card with citation in its title is not counted')
  await page.evaluate(() => window.setCover(false))
  await oSearch.fill('')
  pass('search counts: the grid and the outline count the same set (a headingless cover card is in neither)')

  assert.deepEqual(errors, [], 'no page errors')
  console.log(`slide search DOM: ${passed} checks passed`)
} finally {
  await browser?.close()
  rmSync(dir, { recursive: true, force: true })
}
