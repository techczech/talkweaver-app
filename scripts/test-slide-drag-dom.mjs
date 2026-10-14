// Dragging a slide a long way, in a browser (Playwright's chromium headless shell, never the real
// Chrome): the Slides organizer and the slide grid, each mounted with a 100-slide talk and the
// app's real stylesheet.
//
//   - held at the bottom edge with the pointer NOT moving, the list keeps scrolling (the loop is
//     driven by animation frames, not by dragover events), stops when the pointer leaves the edge
//     zone, on drag end and on Escape, and reaches the end of 100 slides in a few seconds;
//   - the drop indicator follows the row under the still pointer while the list moves;
//   - organizer: drop after the last row = end of the talk; drop on a collapsed section = inside
//     it, as its last slide; resting on a collapsed section opens it; a drop on a slide row still
//     goes before it; each move is one undo step in a real CodeMirror editor;
//   - grid: the same targets, through its block-index reorder (text worked out with the real
//     reorder function, src/shared/grid-reorder.ts).
// SCREENSHOT_DIR=<dir> saves pictures of the three indicators.
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { listSlideBlocks } from '../compiler/scripts/lib/12-outline-edit.mjs'
import { relocateBlock, relocateBlockInto, relocateBlockToEnd } from '../src/renderer/src/extensions/slideOutline.ts'
import { reorderGridBlocks } from '../src/shared/grid-reorder.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'talk-weaver-slide-drag-'))
const outfile = join(dir, 'bundle.js')
const shots = process.env.SCREENSHOT_DIR

// ── The talk: 100 slides in 10 sections, each slide with an id line, a body and a note ──
const SECTIONS = 10
const PER = 10
const parts = ['# Talk', '']
for (let s = 0; s < SECTIONS; s += 1) {
  parts.push(`## Section ${s}`, '')
  for (let i = 0; i < PER; i += 1) parts.push(`### Slide ${s}.${i}`, `{id=s${s}-${i}}`, '', `- point ${s}.${i}`, '', `Note: note ${s}.${i}`, '')
}
const TALK = parts.join('\n')
const talkLines = TALK.split('\n')
const lineOf = (heading) => talkLines.indexOf(heading) + 1
const sortedLines = (t) => t.split('\n').sort()
// The projection rows the grid gets: one section-title row per section (not reorderable) and one
// row per ### slide, so block indices and display indices differ, as they do in the app.
const gridRows = []
for (let s = 0; s < SECTIONS; s += 1) {
  gridRows.push({ slide_id: `sec${s}`, title: `Section ${s}`, nav_title: `Section ${s}`, section: `Section ${s}`, role: 'section-title', layout: 'section', source_markdown: '', render_hash: `sec${s}`, content_hash: `sec${s}`, warnings: [] })
  for (let i = 0; i < PER; i += 1) {
    gridRows.push({ slide_id: `s${s}-${i}`, title: `Slide ${s}.${i}`, nav_title: `Slide ${s}.${i}`, section: `Section ${s}`, role: 'content', layout: 'default', source_markdown: `### Slide ${s}.${i}\n{id=s${s}-${i}}\n\n- point ${s}.${i}`, render_hash: `r${s}-${i}`, content_hash: `c${s}-${i}`, warnings: [] })
  }
}
const block = (s, i) => s * PER + i

const entry = `
import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { EditorView } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { history, undo } from '@codemirror/commands'
import SlidesOrganizer from './src/renderer/src/components/SlidesOrganizer.tsx'
import GridView from './src/renderer/src/components/GridView.tsx'
import { moveBlockTo, moveBlockToEnd, moveBlockInto } from './src/renderer/src/extensions/outliner.ts'
import { resetOutlineCollapseForTests } from './src/renderer/src/lib/outlineCollapseStore.ts'

let mounted = null
function unmount() { if (mounted) { mounted.root.unmount(); mounted.view?.destroy(); mounted = null } }

// The organizer inside the sidebar's real frame, wired to a real editor: the three move ops are the
// editor's own commands, so what is asserted is the text the user's talk would have.
window.mountOutline = (doc) => {
  unmount()
  resetOutlineCollapseForTests({ storage: null }) // collapse state lives in a module store: every mount starts open
  document.getElementById('stage').innerHTML =
    '<div class="sidebar-wrap" style="width:240px;height:600px"><div class="sidebar-modebar" style="height:40px;padding:0">tabs</div><div class="sidebar-nav-body" id="nav"></div></div><div id="cm" style="display:none"></div>'
  let setContent = () => {}
  const view = new EditorView({
    parent: document.getElementById('cm'),
    state: EditorState.create({ doc, extensions: [history(), EditorView.updateListener.of((u) => { if (u.docChanged) setContent(u.state.doc.toString()) })] })
  })
  const ops = {
    move: () => {}, reLevel: () => {},
    moveTo: (from, to) => { moveBlockTo(view, from, to) },
    moveToEnd: (from) => { moveBlockToEnd(view, from) },
    moveInto: (from, section) => { moveBlockInto(view, from, section) }
  }
  function Host() {
    const [content, set] = useState(doc)
    useEffect(() => { setContent = set }, [])
    return React.createElement(SlidesOrganizer, { content, onJump: () => {}, ops, currentLine: null })
  }
  const root = createRoot(document.getElementById('nav'))
  flushSync(() => root.render(React.createElement(Host)))
  mounted = { root, view }
  window.outlineText = () => view.state.doc.toString()
  window.outlineUndo = () => undo(view)
}

window.mountGrid = (rows) => {
  unmount()
  resetOutlineCollapseForTests({ storage: null })
  document.getElementById('stage').innerHTML = '<div id="grid" style="width:900px;height:600px"></div>'
  window.reorders = []
  const root = createRoot(document.getElementById('grid'))
  flushSync(() => root.render(React.createElement(GridView, {
    talk: { slug: 't', title: 'T', outlinePath: '/v/t/t-outline.md' },
    compiledSlides: rows, triggerFindings: [], thumbnails: null, activeIndex: 0, columns: 3,
    onSelectSlide: () => {}, onEdit: () => {}, onExplain: () => {},
    onReorder: (from, to, placement) => { window.reorders.push([from, to, placement ?? null]) }
  })))
  mounted = { root }
}
`

let browser
let passed = 0
const pass = (message) => { passed += 1; console.log(`PASS ${message}`) }
try {
  await build({
    stdin: { contents: entry, resolveDir: root, sourcefile: 'slide-drag-entry.tsx', loader: 'tsx' },
    bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', outfile, logLevel: 'error',
    define: { 'process.env.NODE_ENV': '"production"' }
  })
  browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.setContent('<!doctype html><html><body style="margin:0"><div id="stage" style="padding:20px 0 0 20px"></div></body></html>')
  await page.addStyleTag({ content: readFileSync(join(root, 'src/renderer/src/styles.css'), 'utf8') })
  await page.addScriptTag({ content: readFileSync(outfile, 'utf8') })

  // ── helpers ──
  const scrollTop = (sel) => page.evaluate((s) => document.querySelector(s).scrollTop, sel)
  const maxScroll = (sel) => page.evaluate((s) => { const el = document.querySelector(s); return el.scrollHeight - el.clientHeight }, sel)
  const rectOf = (sel) => page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, x: r.left + r.width / 2, y: r.top + r.height / 2 } }, sel)
  const centre = async (locator) => { const b = await locator.boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 } }
  const sleep = (ms) => page.waitForTimeout(ms)
  // Press on `locator` and move far enough for the browser to start a native drag.
  async function startDrag(locator) {
    await locator.scrollIntoViewIfNeeded()
    const c = await centre(locator)
    await page.mouse.move(c.x, c.y)
    await page.mouse.down()
    await page.mouse.move(c.x + 4, c.y + 6, { steps: 4 })
    await page.mouse.move(c.x + 6, c.y + 12, { steps: 2 })
  }
  // Move the dragged thing to a point and leave it there. The second move, to the same point, is
  // the dragover a browser sends for a pointer resting on an element (Playwright's drag emulation
  // sends only dragenter when the pointer arrives on a new element). After this, NOTHING is sent
  // until the next call: whatever scrolls meanwhile scrolls with no pointer events at all.
  async function dragTo(x, y, steps = 3) {
    await page.mouse.move(x, y, { steps })
    await page.mouse.move(x, y)
  }
  // Samples of scrollTop, `gap` ms apart, with NO pointer movement in between.
  async function sample(sel, n, gap = 120) {
    const out = []
    for (let i = 0; i < n; i += 1) { out.push(await scrollTop(sel)); if (i < n - 1) await sleep(gap) }
    return out
  }
  const growing = (xs) => xs.every((x, i) => i === 0 || x > xs[i - 1])
  const flat = (xs) => xs.every((x) => x === xs[0])
  async function untilBottom(sel, limitMs) {
    const started = Date.now()
    const max = await maxScroll(sel)
    while (Date.now() - started < limitMs) {
      if ((await scrollTop(sel)) >= max - 1) return Date.now() - started
      await sleep(50)
    }
    return null
  }

  // ════════ Slides organizer ════════
  const ORG = '.slides-organizer'
  // By the row's own label (a collapsed section also carries its slide count at the right).
  const row = (text) => page.locator(`${ORG} [data-line]`).filter({ has: page.locator('.so-section-label, .so-slide-title', { hasText: new RegExp(`^${text.replace('.', '\\.')}$`) }) })
  const mountOutline = () => page.evaluate((doc) => window.mountOutline(doc), TALK)
  const outlineText = () => page.evaluate(() => window.outlineText())

  await mountOutline()
  assert.equal(await page.locator(`${ORG} .so-slide`).count(), 100, 'the organizer shows 100 slide rows')
  // The scroll container: the organizer itself, and only it.
  const orgMax = await maxScroll(ORG)
  assert(orgMax > 2000, `the organizer is the scroll container (it can scroll ${orgMax}px)`)
  assert.equal(await maxScroll('.sidebar-nav-body'), 0, 'the frame around the organizer does not scroll')
  await page.evaluate((s) => { document.querySelector(s).scrollTop = 500 }, ORG)
  assert.equal(await scrollTop(ORG), 500)
  assert.equal(await scrollTop('.sidebar-nav-body'), 0)
  const stuck = await page.evaluate(() => document.querySelector('.so-search').getBoundingClientRect().top - document.querySelector('.slides-organizer').getBoundingClientRect().top)
  assert(Math.abs(stuck) < 1, `the search box stays at the top of the list while it scrolls (offset ${stuck})`)
  await page.evaluate((s) => { document.querySelector(s).scrollTop = 0 }, ORG)
  pass(`organizer: .slides-organizer is the one scroll container (${orgMax}px of travel), the search box stays put`)

  // Held at the bottom edge: scrolls with a still pointer; stops in the middle; resumes; reaches the end.
  {
    const box = await rectOf(ORG)
    await startDrag(row('Slide 0.1'))
    await dragTo(box.x, box.bottom - 30, 3)
    const slow = await sample(ORG, 4)
    assert(growing(slow), `scrollTop grows while the pointer is held still in the bottom zone (${slow})`)
    // The indicator follows the row under the still pointer.
    const seen = new Set()
    for (let i = 0; i < 6; i += 1) {
      const pair = await page.evaluate(([x, y]) => {
        const under = document.elementFromPoint(x, y)?.closest('[data-line]')?.getAttribute('data-line') ?? null
        const marked = document.querySelector('.so-row--dragover, .so-row--dropinto')?.getAttribute('data-line') ?? null
        return [under, marked]
      }, [box.x, box.bottom - 30])
      // One frame may separate the scroll from the repaint of the indicator: allow the neighbour row.
      if (pair[0] && pair[1]) { assert(Math.abs(Number(pair[0]) - Number(pair[1])) <= 7, `the indicator (line ${pair[1]}) is on the row under the pointer (line ${pair[0]})`); seen.add(pair[1]) }
      await sleep(100)
    }
    assert(seen.size >= 3, `the indicator moved from row to row under a still pointer (${[...seen]})`)
    pass(`organizer: held still in the bottom zone it keeps scrolling (${slow.join(' → ')}), and the indicator follows the rows`)

    await dragTo(box.x, box.y, 3)
    await sleep(80)
    const still = await sample(ORG, 4)
    assert(flat(still), `scrolling stops when the pointer leaves the zone (${still})`)
    pass('organizer: stops at once when the pointer leaves the edge zone')

    const before = await scrollTop(ORG)
    await dragTo(box.x, box.bottom - 50, 2)
    const edgeSlow = await sample(ORG, 3, 200)
    await dragTo(box.x, box.bottom - 2, 2)
    const t0 = Date.now()
    const edgeFast = await sample(ORG, 3, 200)
    const fastMs = Date.now() - t0
    const slowRate = edgeSlow[2] - edgeSlow[0]
    const fastRate = edgeFast[2] - edgeFast[0]
    assert(edgeSlow[0] >= before && slowRate > 0 && fastRate > slowRate * 3, `faster nearer the edge (${slowRate}px vs ${fastRate}px in 400ms)`)
    // The top speed is the module's (32px a frame = 1920px/s), not that plus Chromium's own drag
    // auto-scroll, which runs in the last 20px inside the edge and would roughly double it.
    const perSecond = Math.round(fastRate / (fastMs / 1000))
    assert(perSecond < 1920 * 1.2, `at the edge the list moves at the intended top speed, not faster (${perSecond}px/s)`)
    pass(`organizer: faster the closer to the edge (${slowRate}px vs ${fastRate}px per 400ms; ${perSecond}px/s at the edge)`)

    // A little below the list still scrolls.
    await dragTo(box.x, box.bottom + 30, 2)
    const outside = await sample(ORG, 3)
    assert(growing(outside) || outside[0] >= orgMax - 1, `scrolls with the pointer just below the list (${outside})`)
    const took = await untilBottom(ORG, 6000)
    assert(took !== null, 'reaches the bottom of 100 slides')
    pass(`organizer: pointer just below the list still scrolls; the whole 100-slide list is crossed (remaining travel took ${took}ms)`)

    // Drop on the zone after the last row = end of the talk.
    const end = await rectOf(`${ORG} [data-drop-end]`)
    await dragTo(end.x, end.y, 3)
    await sleep(60)
    assert.equal(await page.locator(`${ORG} .so-drop-end--active`).count(), 1, 'the end-of-talk line shows')
    const line = await page.evaluate(() => { const s = getComputedStyle(document.querySelector('.so-drop-end--active'), '::before'); return { h: s.height, bg: s.backgroundColor } })
    assert.equal(line.h, '2px', 'the end-of-talk indicator is a drawn line')
    assert.notEqual(line.bg, 'rgba(0, 0, 0, 0)')
    if (shots) await page.screenshot({ path: join(shots, 'organizer-drop-at-end.png') })
    await page.mouse.up()
    await sleep(60)
    const text = await outlineText()
    assert.equal(text, relocateBlockToEnd(TALK, lineOf('### Slide 0.1')), 'the slide is at the end of the talk')
    assert(text.endsWith(['### Slide 0.1', '{id=s0-1}', '', '- point 0.1', '', 'Note: note 0.1', ''].join('\n')), 'whole slide (id line, body, note) ends the talk')
    assert.deepEqual(sortedLines(text), sortedLines(TALK), 'no line lost or duplicated')
    assert.equal(await page.locator(`${ORG} .so-drop-end--active, ${ORG} .so-row--dragover`).count(), 0, 'no indicator left behind')
    const after = await sample(ORG, 3)
    assert(flat(after), 'nothing scrolls after the drop')
    await page.evaluate(() => window.outlineUndo())
    assert.equal(await outlineText(), TALK, 'one undo puts the slide back')
    pass('organizer: drop after the last row moves the slide to the end of the talk, whole, as one undo step')
  }

  // Drag end and Escape stop the scroll even with the pointer still at the edge.
  for (const how of ['dragend', 'Escape']) {
    await mountOutline()
    const box = await rectOf(ORG)
    await startDrag(row('Slide 0.1'))
    // 30px inside the edge: in this module's zone, outside the 20px belt of Chromium's own drag
    // auto-scroll (which this test's emulated drag cannot end).
    await dragTo(box.x, box.bottom - 30, 3)
    const moving = await sample(ORG, 3)
    assert(growing(moving), `${how}: scrolling before (${moving})`)
    // Escape is the real key: the browser cancels the drag and sends dragend, as it does in the app.
    if (how === 'Escape') await page.keyboard.press('Escape')
    else await page.evaluate(() => document.querySelector('.slides-organizer [data-line]').dispatchEvent(new DragEvent('dragend', { bubbles: true })))
    await sleep(60)
    const stopped = await sample(ORG, 3)
    assert(flat(stopped), `${how}: scrolling stops (${stopped})`)
    assert.equal(await page.locator(`${ORG} .so-row--dragover, ${ORG} .so-row--dropinto, ${ORG} .so-drop-end--active`).count(), 0, `${how}: no indicator left behind`)
    await page.mouse.up()
    assert.equal(await outlineText(), TALK, `${how}: nothing moved`)
    pass(`organizer: ${how} stops the scroll`)
  }

  // Top edge: scrolls back up.
  {
    await mountOutline()
    await page.evaluate((s) => { document.querySelector(s).scrollTop = 1500 }, ORG)
    const box = await rectOf(ORG)
    const visible = await page.evaluate(([x, y]) => document.elementFromPoint(x, y).closest('[data-line]').getAttribute('data-line'), [box.x, box.y])
    await startDrag(page.locator(`${ORG} [data-line="${visible}"]`))
    await dragTo(box.x, box.top + 3, 3)
    const up = await sample(ORG, 4)
    assert(up.every((x, i) => i === 0 || x < up[i - 1]), `scrolls up at the top edge (${up})`)
    await dragTo(box.x, box.y, 2)
    await page.mouse.up()
    pass(`organizer: the top edge scrolls up (${up.join(' → ')})`)
  }

  // The top zone starts under the sticky search box (0.38.3-preview.10: the box covered the first
  // 40px of a 56px zone, so the fast end of the zone had no rows under it and no drop indicator).
  {
    await mountOutline()
    await page.evaluate((s) => { const el = document.querySelector(s); el.scrollTop = el.scrollHeight }, ORG)
    const box = await rectOf(ORG)
    const head = await rectOf(`${ORG} .so-search`)
    const cover = head.bottom - box.top
    assert(cover > 30 && cover < 60, `the search box covers the top of the list (${cover}px)`)
    const visible = await page.evaluate(([x, y]) => document.elementFromPoint(x, y).closest('[data-line]').getAttribute('data-line'), [box.x, box.y])
    await startDrag(page.locator(`${ORG} [data-line="${visible}"]`))
    // The row under the pointer, and whether it carries the drop line.
    const under = (y) => page.evaluate(([x, yy]) => { const r = document.elementFromPoint(x, yy)?.closest('[data-line]'); return r ? [r.getAttribute('data-line'), r.classList.contains('so-row--dragover') || r.classList.contains('so-row--dropinto')] : [null, false] }, [box.x, y])
    async function marked(y) { let n = 0; for (let i = 0; i < 8; i += 1) { const [line, on] = await under(y); if (line && on) n += 1; await sleep(60) } return n }
    await dragTo(box.x, head.bottom + 58, 3)
    await sleep(80)
    assert(flat(await sample(ORG, 3)), 'two pixels below the zone (58px under the search box) nothing scrolls')
    await dragTo(box.x, head.bottom + 50, 2)
    const slow = await sample(ORG, 3, 200)
    assert(slow[2] < slow[0], `50px under the search box the list scrolls up (${slow})`)
    assert(await marked(head.bottom + 50) >= 3, 'with the drop line on the row under the pointer')
    await dragTo(box.x, head.bottom + 3, 2)
    const fast = await sample(ORG, 3, 200)
    const slowRate = slow[0] - slow[2]
    const fastRate = fast[0] - fast[2]
    assert(fastRate > slowRate * 3, `3px under the search box it scrolls much faster (${slowRate}px vs ${fastRate}px in 400ms)`)
    const [rowAtFast] = await under(head.bottom + 3)
    assert(rowAtFast, 'and the pointer is over a row, not under the search box')
    assert(await marked(head.bottom + 3) >= 3, 'which carries the drop line while the list moves')
    // Over the search box itself: the top speed, as above the list.
    await dragTo(box.x, box.y, 2) // out of the zone first: while the pointer is in it the loop owns the scroll position
    await sleep(60)
    await page.evaluate((s) => { const el = document.querySelector(s); el.scrollTop = el.scrollHeight }, ORG)
    await dragTo(box.x, box.top + 3, 2)
    const top = await sample(ORG, 3, 200)
    const perSecond = (top[0] - top[2]) / 0.4
    assert(perSecond > 1920 * 0.7 && perSecond < 1920 * 1.2, `over the search box the list moves at the top speed (${perSecond}px/s)`)
    // Held there until the list is at its top: the start of the talk is the target. The first row is the
    // talk's title, and nothing goes above it: the line is on the first row UNDER the title, never on the title row.
    const started = Date.now()
    while ((await scrollTop(ORG)) > 0 && Date.now() - started < 5000) await sleep(50)
    assert.equal(await scrollTop(ORG), 0, 'the list reaches its top')
    await dragTo(box.x, box.top + 4, 1)
    await sleep(80)
    const rowsAtTop = await page.evaluate((s) => [...document.querySelectorAll(`${s} [data-line]`)].slice(0, 2).map((r) => ({ line: Number(r.getAttribute('data-line')), on: r.classList.contains('so-row--dragover') || r.classList.contains('so-row--dropinto'), top: r.getBoundingClientRect().top })), ORG)
    const [titleRow, first] = rowsAtTop
    assert.equal(titleRow.line, lineOf('# Talk'), 'the first row is the talk\'s title')
    assert.equal(titleRow.on, false, 'at the top of the list, over the search box: no drop line before the title row')
    assert.equal(first.line, lineOf('## Section 0'), 'the row under the title is the first section')
    assert.equal(first.on, true, 'the first row under the title shows the drop line')
    assert(Math.abs(titleRow.top - head.bottom) < 1.5, 'and the title row is right under the search box, in view')
    if (shots) await page.screenshot({ path: join(shots, 'organizer-drop-before-first-row.png') })
    await page.mouse.up()
    await sleep(60)
    assert.equal(await outlineText(), relocateBlock(TALK, Number(visible), first.line), 'the drop put the slide at the start of the talk, under the title')
    assert.equal((await outlineText()).split('\n')[0], '# Talk', 'the title is still the first line')
    assert.deepEqual(sortedLines(await outlineText()), sortedLines(TALK), 'no line lost or duplicated')
    await page.evaluate(() => window.outlineUndo())
    assert.equal(await outlineText(), TALK, 'one undo puts it back')
    // The title row itself, 3px under the search box with the list at its top: no drop line anywhere,
    // and a drop released there does nothing (preview.12: it put the slide above the title).
    await startDrag(row('Slide 0.4'))
    await dragTo(box.x, head.bottom + 3, 3)
    await sleep(120)
    const direct = await under(head.bottom + 3)
    assert.deepEqual(direct, [String(titleRow.line), false], 'the title row is under the pointer and carries no drop line')
    assert.equal(await page.locator(`${ORG} .so-row--dragover, ${ORG} .so-row--dropinto, ${ORG} .so-drop-end--active`).count(), 0, 'no drop line is shown anywhere')
    await page.mouse.up()
    await sleep(60)
    assert.equal(await outlineText(), TALK, 'a drop released on the title row changes nothing')
    // The first row under the title takes the line directly.
    await startDrag(row('Slide 0.4'))
    const firstBox = await rectOf(`${ORG} [data-line="${first.line}"]`)
    await dragTo(box.x, firstBox.y, 3)
    await sleep(120)
    assert.deepEqual(await under(firstBox.y), [String(first.line), true], 'the first row under the title takes the drop line directly')
    await dragTo(box.x, box.y, 2)
    await page.mouse.up()
    pass(`organizer: the top zone starts under the search box (${Math.round(cover)}px): ${slowRate}px then ${fastRate}px per 400ms over rows with the drop line, ${Math.round(perSecond)}px/s over the box; at the top the drop goes under the title, and the title row takes no drop`)
  }
  // The bottom zone ends at the list's own edge: nothing sticky covers it, and the end-of-talk zone is in view at the end.
  {
    await mountOutline()
    const box = await rectOf(ORG)
    assert.equal(await page.evaluate((s) => [...document.querySelectorAll(`${s} *`)].filter((el) => getComputedStyle(el).position === 'sticky' && !el.closest('.so-search')).length, ORG), 0, 'the search box is the only sticky thing in the organizer')
    await startDrag(row('Slide 0.2'))
    await dragTo(box.x, box.bottom - 3, 3)
    assert((await untilBottom(ORG, 8000)) !== null, 'reaches the end')
    const end = await rectOf(`${ORG} [data-drop-end]`)
    assert(end.bottom <= box.bottom + 0.5 && end.top >= box.bottom - 30, 'the end-of-talk zone is the last 28px in view')
    await dragTo(end.x, end.y, 2)
    await sleep(80)
    assert.equal(await page.locator(`${ORG} .so-drop-end--active`).count(), 1, 'and takes the drop line')
    await dragTo(box.x, box.y, 2)
    await page.mouse.up()
    pass('organizer: nothing covers the bottom zone; the end-of-talk zone is in view and droppable at the end')
  }

  // Drop on a collapsed section row: inside it, as its last slide.
  async function collapse(section) {
    await row(section).scrollIntoViewIfNeeded()
    await row(section).locator('.so-caret').click()
    await page.evaluate((s) => { document.querySelector(s).scrollTop = 0 }, ORG)
  }
  {
    await mountOutline()
    await collapse('Section 1')
    assert.equal(await row('Slide 1.0').count(), 0, 'Section 1 is collapsed')
    await startDrag(row('Slide 0.2'))
    const c = await centre(row('Section 1'))
    await dragTo(c.x, c.y, 4)
    await sleep(80)
    assert.equal(await row('Section 1').evaluate((el) => el.classList.contains('so-row--dropinto')), true, 'the collapsed section shows the "into" highlight')
    assert.equal(await page.locator(`${ORG} .so-row--dragover`).count(), 0, 'and not the "before" line')
    if (shots) await page.screenshot({ path: join(shots, 'organizer-drop-into-section.png') })
    await page.mouse.up()
    await sleep(60)
    const text = await outlineText()
    assert.equal(text, relocateBlockInto(TALK, lineOf('### Slide 0.2'), lineOf('## Section 1')), 'the slide is inside the section')
    const lines = text.split('\n')
    const inSection = lines.slice(lines.indexOf('## Section 1'), lines.indexOf('## Section 2')).filter((l) => l.startsWith('### '))
    assert.equal(inSection.length, 11)
    assert.equal(inSection.at(-1), '### Slide 0.2', 'as its last slide')
    assert.deepEqual(sortedLines(text), sortedLines(TALK), 'no line lost or duplicated')
    await page.evaluate(() => window.outlineUndo())
    assert.equal(await outlineText(), TALK, 'one undo puts the slide back')
    pass('organizer: a drop on a collapsed section puts the slide inside it as its last slide, as one undo step')
  }

  // Resting on a collapsed section opens it; a drop on a slide row then goes before that row.
  {
    await mountOutline()
    await collapse('Section 1')
    await startDrag(row('Slide 0.2'))
    const c = await centre(row('Section 1'))
    await dragTo(c.x, c.y, 4)
    await sleep(300)
    assert.equal(await row('Slide 1.0').count(), 0, 'still collapsed after 300ms')
    await sleep(700)
    assert.equal(await row('Slide 1.0').count(), 1, 'the section opened after resting on it (about 700ms)')
    // Slide 1.1: well clear of the bottom edge zone, so the list is not moving under the drop.
    const target = await centre(row('Slide 1.1'))
    await dragTo(target.x, target.y, 4)
    await sleep(60)
    assert.equal(await row('Slide 1.1').evaluate((el) => el.classList.contains('so-row--dragover')), true, 'a slide row shows the "before" line')
    await page.mouse.up()
    await sleep(60)
    assert.equal(await outlineText(), relocateBlock(TALK, lineOf('### Slide 0.2'), lineOf('### Slide 1.1')), 'the slide is before the row it was dropped on, inside the opened section')
    pass('organizer: resting on a collapsed section opens it; a drop on a slide row goes before that row')
  }

  // Whole sections still drag as before: onto a section row = before that section, collapsed or not.
  {
    await mountOutline()
    await collapse('Section 0')
    await startDrag(row('Section 2'))
    const c = await centre(row('Section 0'))
    await dragTo(c.x, c.y, 4)
    await sleep(60)
    assert.equal(await row('Section 0').evaluate((el) => el.classList.contains('so-row--dragover')), true, 'a dragged section shows the "before" line on a section row')
    await page.mouse.up()
    await sleep(60)
    const text = await outlineText()
    assert.equal(text, relocateBlock(TALK, lineOf('## Section 2'), lineOf('## Section 0')), 'the section moved before the section it was dropped on')
    assert.deepEqual(sortedLines(text), sortedLines(TALK))
    pass('organizer: dragging a whole section is unchanged (lands before the section it is dropped on)')
  }

  // ════════ Grid ════════
  const GRID = '.grid-view'
  const cell = (s, i) => page.locator(`${GRID} .grid-cell[data-block-index="${block(s, i)}"]`)
  const header = (s) => page.locator(`${GRID} [data-section-header]`, { hasText: `Section ${s}` })
  const mountGrid = () => page.evaluate((rows) => window.mountGrid(rows), gridRows)
  const reorders = () => page.evaluate(() => window.reorders)
  const gridText = (call) => reorderGridBlocks(TALK, listSlideBlocks(TALK), call[0], call[1], call[2] ?? undefined)
  const lastIn = (text, s) => { const l = text.split('\n'); const a = l.indexOf(`## Section ${s}`); let b = l.findIndex((x, i) => i > a && x.startsWith('## ')); if (b < 0) b = l.length; return l.slice(a, b).filter((x) => x.startsWith('### ')).pop() }

  {
    await mountGrid()
    assert.equal(await page.locator(`${GRID} .grid-cell[draggable="true"]`).count(), 100, 'the grid shows 100 draggable cells')
    const gridMax = await maxScroll(GRID)
    assert(gridMax > 3000, `the grid scrolls (${gridMax}px of travel)`)
    const box = await rectOf(GRID)
    await startDrag(cell(0, 1))
    await dragTo(box.x, box.bottom - 30, 3)
    const slow = await sample(GRID, 4)
    assert(growing(slow), `scrollTop grows while the pointer is held still in the bottom zone (${slow})`)
    // The cell indicator follows the cell under the still pointer.
    let agreed = 0
    const targets = new Set()
    for (let i = 0; i < 10; i += 1) {
      const pair = await page.evaluate(([x, y]) => {
        const under = document.elementFromPoint(x, y)?.closest('.grid-cell[draggable="true"]')?.getAttribute('data-slide-index') ?? null
        const marked = document.querySelector('.grid-cell[data-drop-target="true"]')?.getAttribute('data-slide-index') ?? null
        return [under, marked]
      }, [box.x, box.bottom - 30])
      if (pair[0] && pair[0] === pair[1]) { agreed += 1; targets.add(pair[1]) }
      await sleep(90)
    }
    assert(agreed >= 3 && targets.size >= 2, `the drop indicator is on the cell under the still pointer as the grid moves (${agreed} of 10 samples over a cell, cells ${[...targets]})`)
    pass(`grid: held still in the bottom zone it keeps scrolling (${slow.join(' → ')}), and the indicator follows the cells`)

    await dragTo(box.x, box.y, 3)
    await sleep(80)
    const still = await sample(GRID, 4)
    assert(flat(still), `scrolling stops when the pointer leaves the zone (${still})`)
    pass('grid: stops at once when the pointer leaves the edge zone')

    const started = Date.now()
    await dragTo(box.x, box.bottom - 1, 2)
    const took = await untilBottom(GRID, 8000)
    assert(took !== null, 'reaches the bottom of 100 slides')
    const total = Date.now() - started
    assert(total < 6000, `the rest of a 100-slide grid is crossed in a few seconds (${total}ms)`)
    pass(`grid: the 100-slide grid is crossed to the bottom in ${total}ms at the edge`)

    // The empty slot beside the last cell is "after the last cell" as well.
    const lastCell = await cell(9, 9).boundingBox()
    await dragTo(lastCell.x + lastCell.width + 120, lastCell.y + lastCell.height / 2, 3)
    await sleep(60)
    assert.equal(await page.locator(`${GRID} [data-grid-drop-end][data-drop-active="true"]`).count(), 1, 'the empty slot beside the last cell shows the end-of-talk bar')
    const end = await rectOf(`${GRID} [data-grid-drop-end]`)
    await dragTo(end.x, end.y, 3)
    await sleep(60)
    assert.equal(await page.locator(`${GRID} [data-grid-drop-end][data-drop-active="true"]`).count(), 1, 'the end zone is the target')
    const bar = await page.evaluate(() => { const b = document.querySelector('[data-grid-drop-end] > div'); const r = b.getBoundingClientRect(); return { w: r.width, h: r.height, bg: getComputedStyle(b).backgroundColor } })
    assert(bar.w > 500 && bar.h === 4 && bar.bg !== 'rgba(0, 0, 0, 0)', 'the end-of-talk bar is drawn')
    if (shots) await page.screenshot({ path: join(shots, 'grid-drop-at-end.png') })
    await page.mouse.up()
    await sleep(60)
    const calls = await reorders()
    assert.deepEqual(calls, [[block(0, 1), block(9, 9), 'after']], 'one reorder: after the last slide of the talk')
    const text = gridText(calls[0])
    assert(text.trimEnd().endsWith('Note: note 0.1'), 'the slide ends the talk')
    assert.deepEqual(sortedLines(text), sortedLines(TALK), 'no line lost or duplicated')
    assert.equal(await page.locator(`${GRID} [data-drop-active], ${GRID} [data-drop-target], ${GRID} [data-drop-into]`).count(), 0, 'no indicator left behind')
    assert(flat(await sample(GRID, 3)), 'nothing scrolls after the drop')
    pass('grid: a drop after the last cell moves the slide to the end (one reorder, every line kept)')
  }

  // The top zone starts under the grid's sticky toolbar.
  {
    await mountGrid()
    await page.evaluate((s) => { const el = document.querySelector(s); el.scrollTop = el.scrollHeight }, GRID)
    const box = await rectOf(GRID)
    const bar = await rectOf(`${GRID} [data-grid-toolbar]`)
    const cover = bar.bottom - box.top
    assert(cover > 20 && cover < 60, `the toolbar covers the top of the grid (${cover}px)`)
    assert.equal(await page.evaluate((s) => [...document.querySelectorAll(`${s} *`)].filter((el) => getComputedStyle(el).position === 'sticky' && !el.closest('[data-grid-toolbar]')).length, GRID), 0, 'the toolbar is the only sticky thing in the grid (nothing covers the bottom)')
    const from = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('.grid-cell[draggable="true"]')?.getAttribute('data-block-index') ?? null, [box.left + 150, box.y])
    assert(from, 'a cell is in view to drag')
    await startDrag(page.locator(`${GRID} .grid-cell[data-block-index="${from}"]`))
    const x = box.left + 150 // over the first column of cells
    await dragTo(x, bar.bottom + 58, 3)
    await sleep(80)
    assert(flat(await sample(GRID, 3)), 'two pixels below the zone (58px under the toolbar) nothing scrolls')
    await dragTo(x, bar.bottom + 50, 2)
    const slow = await sample(GRID, 3, 200)
    assert(slow[2] < slow[0], `50px under the toolbar the grid scrolls up (${slow})`)
    let agreed = 0
    for (let i = 0; i < 14; i += 1) {
      const pair = await page.evaluate(([px, py]) => {
        const under = document.elementFromPoint(px, py)?.closest('.grid-cell[draggable="true"]')?.getAttribute('data-slide-index') ?? null
        const marked = document.querySelector('.grid-cell[data-drop-target="true"]')?.getAttribute('data-slide-index') ?? null
        return [under, marked]
      }, [x, bar.bottom + 50])
      if (pair[0] && pair[0] === pair[1]) agreed += 1
      await sleep(90)
    }
    assert(agreed >= 2, `the drop indicator is on the cell under the pointer in the top zone (${agreed} of 14 samples)`)
    await dragTo(x, bar.bottom + 3, 2)
    const fast = await sample(GRID, 3, 200)
    const slowRate = slow[0] - slow[2]
    const fastRate = fast[0] - fast[2]
    assert(fastRate > slowRate * 3, `3px under the toolbar it scrolls much faster (${slowRate}px vs ${fastRate}px in 400ms)`)
    await dragTo(x, box.y, 2)
    await sleep(60)
    await page.evaluate((s) => { const el = document.querySelector(s); el.scrollTop = el.scrollHeight }, GRID)
    await dragTo(x, box.top + 3, 2)
    const top = await sample(GRID, 3, 200)
    const perSecond = (top[0] - top[2]) / 0.4
    assert(perSecond > 1920 * 0.7 && perSecond < 1920 * 1.2, `over the toolbar the grid moves at the top speed (${perSecond}px/s)`)
    const started = Date.now()
    while ((await scrollTop(GRID)) > 0 && Date.now() - started < 6000) await sleep(50)
    assert.equal(await scrollTop(GRID), 0, 'the grid reaches its top')
    // At the top the first card is in view under the toolbar and takes the drop.
    const firstCell = await cell(0, 0).boundingBox()
    assert(firstCell.y > bar.bottom, 'the first card is below the toolbar')
    await dragTo(firstCell.x + firstCell.width / 2, firstCell.y + 12, 3)
    await sleep(80)
    assert.equal(await cell(0, 0).getAttribute('data-drop-target'), 'true', 'and shows the drop indicator')
    await page.mouse.up()
    await sleep(60)
    assert.deepEqual(await reorders(), [[Number(from), block(0, 0), null]], 'one reorder: onto the first slide')
    pass(`grid: the top zone starts under the toolbar (${Math.round(cover)}px): ${slowRate}px then ${fastRate}px per 400ms, ${Math.round(perSecond)}px/s over the toolbar, and the first card takes the drop at the top`)
  }

  // Collapsed section header: accepts the drop from above and from below.
  // Collapse Section 1 and bring its header to the middle of the grid: the last cells of Section 0
  // are above it and the first cells of Section 2 below it, all clear of the edge zones.
  async function collapseSection1() {
    await header(1).click()
    assert.equal(await cell(1, 0).count(), 0, 'Section 1 is collapsed')
    await header(1).evaluate((el) => el.scrollIntoView({ block: 'center' }))
  }
  for (const [fromS, fromI] of [[0, 9], [2, 1]]) {
    await mountGrid()
    await collapseSection1()
    await startDrag(cell(fromS, fromI))
    const c = await centre(header(1))
    await dragTo(c.x, c.y, 4)
    await sleep(80)
    assert.equal(await header(1).getAttribute('data-drop-into'), 'true', 'the collapsed header shows the "into" highlight')
    const shadow = await header(1).evaluate((el) => getComputedStyle(el).boxShadow)
    assert(shadow.includes('inset'), 'the highlight is drawn')
    if (shots && fromS === 0) await page.screenshot({ path: join(shots, 'grid-drop-into-section.png') })
    await page.mouse.up()
    await sleep(60)
    const calls = await reorders()
    assert.deepEqual(calls, [[block(fromS, fromI), block(1, 9), 'after']], 'one reorder: after the last slide of Section 1')
    const text = gridText(calls[0])
    assert.equal(lastIn(text, 1), `### Slide ${fromS}.${fromI}`, 'the slide is the last slide of Section 1')
    assert.deepEqual(sortedLines(text), sortedLines(TALK), 'no line lost or duplicated')
    pass(`grid: a drop on a collapsed section header (slide dragged from ${fromS < 1 ? 'above' : 'below'}) makes it the last slide of that section`)
  }

  // Resting on a collapsed header opens it.
  {
    await mountGrid()
    await collapseSection1()
    await startDrag(cell(0, 9))
    const c = await centre(header(1))
    await dragTo(c.x, c.y, 4)
    await sleep(300)
    assert.equal(await cell(1, 0).count(), 0, 'still collapsed after 300ms')
    await sleep(700)
    assert.equal(await cell(1, 0).count(), 1, 'the section opened after resting on its header')
    const target = await centre(cell(1, 1))
    await dragTo(target.x, target.y, 4)
    await sleep(60)
    await page.mouse.up()
    await sleep(60)
    assert.deepEqual(await reorders(), [[block(0, 9), block(1, 1), null]], 'a drop on a cell is the reorder it always was')
    pass('grid: resting on a collapsed header opens the section; a drop on a cell is unchanged')
  }

  assert.deepEqual(errors, [], 'no page errors')
  console.log(`slide-drag-dom: ${passed} checks passed`)
} finally {
  await browser?.close()
  rmSync(dir, { recursive: true, force: true })
}
