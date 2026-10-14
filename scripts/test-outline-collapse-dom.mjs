// Collapsing sections, in a browser (Playwright's chromium headless shell, never the real Chrome): the
// Slides outline and the slide grid, mounted together on a 100-slide talk in 10 sections with the
// app's real stylesheet, a real CodeMirror editor behind them, and the same wiring the workspace
// has (the store is told the text on every change; explicit jumps call revealLine).
//
//   - collapse two sections, change the outline above them (typing, a move, a rename, an undo), and the
//     same two are still collapsed; unmount the outline (sidebar to Talks and back) and restart the
//     app (new module state, same storage): restored;
//   - the grid shows the same sections collapsed, and the reverse; Collapse all / Expand all in both,
//     at every nesting level; option-click on a caret takes the whole subtree;
//   - an explicit jump (revealLine, a drop, a chosen search result, the grid's active slide) opens the
//     sections around the slide and scrolls to it; typing in a collapsed section does not open it;
//   - searching finds slides inside collapsed sections, and clearing the box leaves the state alone;
//   - dragging: a section opened by resting on it closes again unless the slide is dropped inside it.
// SCREENSHOT_DIR=<dir> saves the pictures (outline and grid with everything collapsed, narrow sidebar).
import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('..', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'talk-weaver-outline-collapse-'))
const outfile = join(dir, 'bundle.js')
const shots = process.env.SCREENSHOT_DIR
if (shots) mkdirSync(shots, { recursive: true })

// ── The talk: 100 slides in 10 sections. Section 2 has its id on the line below the heading,
// section 3 on the heading, the others none. Section 9 holds a sub-section (### Part A with three
// #### slides in place of its last slide), so there are two nesting levels. ──
const SECTIONS = 10
const PER = 10
const parts = ['# Talk', '']
for (let s = 0; s < SECTIONS; s += 1) {
  parts.push(s === 3 ? `## Section 3 {id=sec3}` : `## Section ${s}`)
  if (s === 2) parts.push('{id=sec2}')
  parts.push('')
  for (let i = 0; i < PER; i += 1) {
    if (s === 9 && i === PER - 1) {
      parts.push('### Part A', '')
      for (let k = 0; k < 3; k += 1) parts.push(`#### Deep ${k}`, '', `- deep ${k}`, '')
      continue
    }
    parts.push(`### Slide ${s}.${i}`, `{id=s${s}-${i}}`, '', `- point ${s}.${i}`, '', `Note: note ${s}.${i}`, '')
  }
}
const TALK = parts.join('\n')
const TALK_KEY = '/vault/talks/long/long-outline.md'

const entry = `
import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { EditorView } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { history, undo } from '@codemirror/commands'
import SlidesOrganizer from './src/renderer/src/components/SlidesOrganizer.tsx'
import GridView from './src/renderer/src/components/GridView.tsx'
import { moveBlockTo, moveBlockInto } from './src/renderer/src/extensions/outliner.ts'
import { publishOutline, revealLine, resetOutlineCollapseForTests, collapseAllSections, expandAllSections } from './src/renderer/src/lib/outlineCollapseStore.ts'

// A storage that survives "restarting the app" (resetting the module state) inside the page.
window.fakeStorage = window.fakeStorage || (() => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v) }, size: () => m.size } })()

// Projection rows as the compiler gives the grid for an outline talk (compiler 08-source-adapters.mjs):
// a section-title row per ## heading and a row per ### block, and on every row "section" is the
// section's ID, not its text: the heading's {id=…} (on the heading or on the line below) when it has
// one, else a slug of its title. Slides before the first ## have section ''.
function rowsFromContent(content) {
  const rows = []
  let section = ''
  const lines = content.split('\\n')
  const strip = (t) => t.replace(/\\{[^}]*\\}/g, '').trim()
  const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const idAt = (i) => ((lines[i].match(/\\{id=([^}]+)\\}/) || (lines[i + 1] || '').match(/^\\{id=([^}]+)\\}$/) || [])[1]) ?? null
  lines.forEach((line, i) => {
    let m
    if ((m = line.match(/^## (.*)$/))) {
      const title = strip(m[1])
      section = idAt(i) ?? slug(title)
      rows.push({ slide_id: section, title, nav_title: title, section, role: 'section-title', layout: 'section-title', source_markdown: line, render_hash: 'h-' + section, content_hash: 'c-' + section, warnings: [] })
    } else if ((m = line.match(/^### (.*)$/))) {
      const title = strip(m[1])
      rows.push({ slide_id: 'r-' + title, title, nav_title: title, section, role: 'content', layout: 'default', source_markdown: line, render_hash: 'h-' + title, content_hash: 'c-' + title, warnings: [] })
    }
  })
  return rows
}
window.gridIndexOf = (title) => rowsFromContent(window.docText()).findIndex((r) => r.title === title)

let mounted = null
function unmount() { if (mounted) { mounted.root.unmount(); mounted.view?.destroy(); mounted = null } }

window.mountHost = ({ doc, talkKey, sidebarWidth = 240 }) => {
  unmount()
  document.getElementById('stage').innerHTML =
    '<div style="display:flex;gap:20px"><div class="sidebar-wrap" style="width:' + sidebarWidth + 'px;height:600px;display:flex;flex-direction:column"><div class="sidebar-modebar" style="height:40px;padding:0;flex:none">tabs</div><div class="sidebar-nav-body" id="nav" style="flex:1;min-height:0;display:flex;flex-direction:column"></div></div><div id="grid" style="width:700px;height:600px"></div></div><div id="cm" style="display:none"></div>'
  let setContent = () => {}
  const view = new EditorView({
    parent: document.getElementById('cm'),
    state: EditorState.create({ doc, extensions: [history(), EditorView.updateListener.of((u) => { if (u.docChanged) setContent(u.state.doc.toString()) })] })
  })
  const ops = {
    move: () => {}, reLevel: () => {},
    moveTo: (from, to) => { moveBlockTo(view, from, to) },
    moveToEnd: () => {},
    moveInto: (from, section) => { moveBlockInto(view, from, section) }
  }
  let setUi = () => {}
  window.jumps = []
  window.selected = []
  // The sidebar and the grid are two React roots sharing one state, as App and WorkspaceLayout are two trees.
  const navRoot = createRoot(document.getElementById('nav'))
  const gridRoot = createRoot(document.getElementById('grid'))
  const shared = { content: doc, listeners: new Set() }
  function Half({ which }) {
    const [content, setC] = useState(shared.content)
    const [ui, setU] = useState(shared.ui || { sidebar: true, grid: true, currentLine: null, active: 0 })
    useEffect(() => {
      const l = (c, u) => { setC(c); setU(u) }
      shared.listeners.add(l)
      return () => { shared.listeners.delete(l) }
    }, [])
    const rows = React.useMemo(() => rowsFromContent(content), [content])
    if (which === 'sidebar') return ui.sidebar ? React.createElement(SlidesOrganizer, { content, onJump: (line) => { window.jumps.push(line) }, ops, currentLine: ui.currentLine, talkKey }) : React.createElement('div', { className: 'pres-nav-empty' }, 'Talks list')
    return ui.grid ? React.createElement(GridView, {
      talk: { slug: 't', title: 'T', outlinePath: talkKey }, compiledSlides: rows, triggerFindings: [], thumbnails: null, activeIndex: ui.active, columns: 3,
      onSelectSlide: (i) => { window.selected.push(i) }, onEdit: () => {}, onExplain: () => {}, onReorder: () => {}
    }) : null
  }
  shared.ui = { sidebar: true, grid: true, currentLine: null, active: 0 }
  const push = () => { for (const l of shared.listeners) l(shared.content, shared.ui) }
  setContent = (c) => { shared.content = c; publishOutline(talkKey, c); push() }
  setUi = (patch) => { shared.ui = { ...shared.ui, ...patch }; push() }
  flushSync(() => {
    navRoot.render(React.createElement(Half, { which: 'sidebar' }))
    gridRoot.render(React.createElement(Half, { which: 'grid' }))
  })
  publishOutline(talkKey, doc)
  mounted = { root: { unmount: () => { navRoot.unmount(); gridRoot.unmount() } }, view }
  window.setUi = (patch) => setUi(patch)
  window.docText = () => view.state.doc.toString()
  window.undoDoc = () => undo(view)
  window.lineOf = (text) => view.state.doc.toString().split('\\n').indexOf(text) + 1
  // Editor edits: replace a whole line / insert lines after a line, by text.
  window.replaceLine = (oldText, newText) => {
    const n = window.lineOf(oldText); const l = view.state.doc.line(n)
    view.dispatch({ changes: { from: l.from, to: l.to, insert: newText } })
  }
  window.insertAfter = (afterText, text) => {
    const l = view.state.doc.line(window.lineOf(afterText))
    view.dispatch({ changes: { from: l.to, insert: '\\n' + text } })
  }
  window.moveBlock = (fromText, toText) => { moveBlockTo(view, window.lineOf(fromText), window.lineOf(toText)) }
  window.reveal = (line) => revealLine(talkKey, line, view.state.doc.toString())
  window.bulkCollapse = () => collapseAllSections(talkKey)
  window.bulkExpand = () => expandAllSections(talkKey)
}

window.restartApp = (talkKey, doc, sidebarWidth) => {
  unmount()
  resetOutlineCollapseForTests({ storage: window.fakeStorage })
  window.mountHost({ doc, talkKey, sidebarWidth })
}
window.freshApp = (talkKey, doc, sidebarWidth) => {
  window.fakeStorage = (() => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v) }, size: () => m.size } })()
  window.restartApp(talkKey, doc, sidebarWidth)
}
`

let browser
let passed = 0
const pass = (message) => { passed += 1; console.log(`PASS ${message}`) }
try {
  await build({
    stdin: { contents: entry, resolveDir: root, sourcefile: 'outline-collapse-entry.tsx', loader: 'tsx' },
    bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', outfile, logLevel: 'error',
    define: { 'process.env.NODE_ENV': '"production"' }
  })
  browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  await page.setContent('<!doctype html><html><body style="margin:0"><div id="stage" style="padding:20px 0 0 20px"></div></body></html>')
  await page.addStyleTag({ content: readFileSync(join(root, 'src/renderer/src/styles.css'), 'utf8') })
  await page.addScriptTag({ content: readFileSync(outfile, 'utf8') })

  const ORG = '.slides-organizer'
  const GRID = '.grid-view'
  const sleep = (ms) => page.waitForTimeout(ms)
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const row = (text) => page.locator(`${ORG} [data-line]`).filter({ has: page.locator('.so-section-label, .so-slide-title', { hasText: new RegExp(`^${esc(text)}$`) }) })
  const caret = (text) => row(text).locator('.so-caret')
  const freshApp = async (width = 240) => { await page.evaluate(([k, d, w]) => window.freshApp(k, d, w), [TALK_KEY, TALK, width]); await sleep(50) }
  const restartApp = async (doc) => { await page.evaluate(([k, d]) => window.restartApp(k, d), [TALK_KEY, doc ?? await page.evaluate(() => window.docText())]); await sleep(50) }
  // Sections the outline shows collapsed / the grid shows collapsed, by label.
  const outlineCollapsed = () => page.evaluate((sel) => [...document.querySelectorAll(`${sel} .so-section`)].filter((el) => el.querySelector('.so-caret')?.getAttribute('aria-expanded') === 'false').map((el) => el.querySelector('.so-section-label').textContent), ORG)
  const outlineSections = () => page.evaluate((sel) => document.querySelectorAll(`${sel} .so-section`).length, ORG)
  const gridCollapsed = () => page.evaluate(() => [...document.querySelectorAll('.grid-view [data-section-header]')].filter((h) => h.textContent.trim().startsWith('▸')).map((h) => h.children[1].textContent))
  const gridCells = () => page.locator(`${GRID} [data-slide-index]`).count()
  const sameSet = (a, b) => assert.deepEqual([...a].sort(), [...b].sort())
  // Is the row with this label fully inside the outline's scroll area?
  const inView = async (text) => page.evaluate(([t, scroller]) => {
    const label = [...document.querySelectorAll(`${scroller} .so-section-label, ${scroller} .so-slide-title`)].find((el) => el.textContent === t)
    const el = label?.closest('[data-line]')
    if (!el) return false
    const box = document.querySelector(scroller).getBoundingClientRect()
    const r = el.getBoundingClientRect()
    return r.top >= box.top - 1 && r.bottom <= box.bottom + 1
  }, [text, ORG])

  // ═══ 1. Two sections collapsed; the outline changes above them ═══
  await freshApp()
  assert.equal(await page.locator(`${ORG} .so-slide`).count(), 102, 'the outline starts with every slide in view (100 + Part A deep ones counted as leaves: 99 + 3)')
  sameSet(await outlineCollapsed(), [])
  await row('Section 2').scrollIntoViewIfNeeded()
  await caret('Section 2').click()
  await row('Section 5').scrollIntoViewIfNeeded()
  await caret('Section 5').click()
  sameSet(await outlineCollapsed(), ['Section 2', 'Section 5'])
  assert.equal(await row('Slide 2.3').count(), 0, 'Section 2 hides its slides')
  assert.equal(await row('Section 2').locator('[data-so-count]').textContent(), '10', 'a collapsed section shows how many slides it holds')
  assert.equal(await page.locator(`${ORG} [data-so-count]`).count(), 2, 'open sections show no count')
  assert.equal(await page.locator(`${ORG} [data-so-collapse-all]`).getAttribute('title'), 'Collapse all sections')
  assert.equal(await page.locator(`${ORG} [data-so-expand-all]`).getAttribute('title'), 'Expand all sections')
  pass('outline: two sections collapsed by their caret, each showing its slide count; both header buttons carry their tooltips')

  const holds = async (label) => { sameSet(await outlineCollapsed(), ['Section 2', 'Section 5']); assert.equal(await row('Slide 2.3').count() + await row('Slide 5.3').count(), 0, `${label}: their slides are still hidden`) }

  await page.evaluate(() => window.insertAfter('# Talk', '\n## Brand new section\n\n### A new first slide'))
  await sleep(80)
  await holds('a new section at the top')
  await page.evaluate(() => window.insertAfter('## Section 0', '\n### typed above'))
  await sleep(80)
  await holds('a slide typed above')
  await page.evaluate(() => window.moveBlock('## Section 8', '## Section 1'))
  await sleep(80)
  await holds('a section moved from below to above them')
  await page.evaluate(() => window.undoDoc())
  await sleep(80)
  await holds('undo of that move')
  assert.equal(await page.evaluate(() => window.docText().includes('## Section 8')), true)
  pass('outline: a new section above, a slide typed above, a section moved from below to above, and an undo leave exactly the same two collapsed')

  // Rename: the section with an id and the one without.
  await page.evaluate(() => window.replaceLine('## Section 5', '## Section Five'))
  await sleep(80)
  sameSet(await outlineCollapsed(), ['Section 2', 'Section Five'])
  await page.evaluate(() => window.replaceLine('## Section 3 {id=sec3}', '## Third {id=sec3}'))
  await caret('Third').click() // collapse the id'd section, then rename it
  await page.evaluate(() => window.replaceLine('## Third {id=sec3}', '## Third, renamed {id=sec3}'))
  await sleep(80)
  sameSet(await outlineCollapsed(), ['Section 2', 'Section Five', 'Third, renamed'])
  await caret('Third, renamed').click()
  await page.evaluate(() => { window.replaceLine('## Section Five', '## Section 5'); window.replaceLine('## Third, renamed {id=sec3}', '## Section 3 {id=sec3}') })
  await sleep(80)
  await holds('renaming back')
  pass('outline: renaming a collapsed section keeps it collapsed, with or without an id (a one-for-one rename in the same place is followed)')

  // ═══ 2. Unmount and remount; restart ═══
  await page.evaluate(() => window.setUi({ sidebar: false }))
  await sleep(50)
  assert.equal(await page.locator(ORG).count(), 0, 'the sidebar now shows the Talks list')
  await page.evaluate(() => window.setUi({ sidebar: true }))
  await sleep(50)
  await holds('after the sidebar went to Talks and back')
  await page.evaluate(() => window.setUi({ grid: false }))
  await page.evaluate(() => window.setUi({ grid: true }))
  await sleep(50)
  sameSet(await gridCollapsed(), ['Section 2', 'Section 5'])
  await restartApp()
  await holds('after the app restarted (module state gone, storage kept)')
  sameSet(await gridCollapsed(), ['Section 2', 'Section 5'])
  assert.equal(await page.evaluate(() => window.fakeStorage.size()), 1, 'one stored entry, for this talk')
  const stored = JSON.parse(await page.evaluate(() => window.fakeStorage.getItem('tw-outline-collapse-v1')))
  assert.deepEqual(Object.keys(stored.talks), [TALK_KEY])
  assert.deepEqual([...stored.talks[TALK_KEY].keys].sort(), ['id:sec2', 'h2:Section 5'].sort(), 'stored by identity (id, or level+text), not by line number')
  assert.equal((await page.evaluate(() => window.docText())).includes('collapse'), false, 'nothing about collapsing is written into the talk text')
  pass('outline: remembered across the sidebar switching to Talks and back, the grid view closing and reopening, and an app restart; stored by identity')

  // ═══ 3. One state for both views ═══
  sameSet(await gridCollapsed(), ['Section 2', 'Section 5'])
  assert.equal(await gridCells(), 91, 'the grid shows 102 slide blocks (100 + the two typed above) and 11 section cards, minus the two collapsed sections of ten slides and their cards')
  await page.locator(`${GRID} [data-section-header]`, { hasText: 'Section 7' }).click()
  sameSet(await outlineCollapsed(), ['Section 2', 'Section 5', 'Section 7'])
  await page.locator(`${GRID} [data-section-header]`, { hasText: 'Section 2' }).click()
  sameSet(await outlineCollapsed(), ['Section 5', 'Section 7'])
  await row('Section 0').scrollIntoViewIfNeeded()
  await caret('Section 0').click()
  sameSet(await gridCollapsed(), ['Section 0', 'Section 5', 'Section 7'])
  pass('grid: the same sections are collapsed as in the outline, and a click in either view shows in the other')

  // ═══ 4. Collapse all / Expand all, option-click ═══
  await page.locator(`${ORG} [data-so-expand-all]`).click()
  sameSet(await outlineCollapsed(), [])
  sameSet(await gridCollapsed(), [])
  await page.locator(`${ORG} [data-so-collapse-all]`).click()
  const tenSections = ['Brand new section', ...Array.from({ length: 10 }, (_, i) => `Section ${i}`)] // (the new section typed in above is one too)
  assert.equal(await outlineSections(), 1 + tenSections.length, 'collapse all: the deck title row stays, with one collapsed row per section')
  sameSet(await outlineCollapsed(), tenSections)
  assert.equal(await caret('Talk').getAttribute('aria-expanded'), 'true', 'the deck title stays open')
  sameSet(await gridCollapsed(), tenSections)
  assert.equal(await gridCells(), 0, 'the grid shows no cells with everything collapsed')
  await caret('Talk').click()
  assert.equal(await outlineSections(), 1, 'the deck title can still be collapsed by hand')
  await caret('Talk').click()
  sameSet(await outlineCollapsed(), tenSections)
  await caret('Section 9').click()
  sameSet(await outlineCollapsed(), [...tenSections.filter((x) => x !== 'Section 9'), 'Part A'])
  await caret('Section 9').click() // all collapsed again, for the pictures
  if (shots) {
    await page.evaluate(() => { document.querySelector('.slides-organizer').scrollTop = 0 })
    await page.locator('.sidebar-wrap').screenshot({ path: join(shots, 'outline-all-collapsed.png') })
    await page.locator('#grid').screenshot({ path: join(shots, 'grid-all-collapsed.png') })
  }
  await page.locator(`${ORG} [data-so-expand-all]`).click()
  sameSet(await outlineCollapsed(), [])
  assert.equal(await page.locator(`${ORG} .so-slide`).count(), 104)
  pass('outline: Collapse all collapses every section and sub-section but not the deck title and Expand all opens them; the grid follows')

  // Grid buttons
  await page.locator(`${GRID} [data-grid-collapse-all]`).click()
  sameSet(await gridCollapsed(), tenSections)
  sameSet(await outlineCollapsed(), tenSections)
  await page.locator(`${GRID} [data-grid-expand-all]`).click()
  sameSet(await gridCollapsed(), [])
  sameSet(await outlineCollapsed(), [])
  assert.equal(await page.locator(`${GRID} [data-grid-collapse-all]`).getAttribute('title'), 'Collapse all sections')
  assert.equal(await page.locator(`${GRID} [data-grid-expand-all]`).getAttribute('title'), 'Expand all sections')
  pass('grid: Collapse all and Expand all buttons (with their tooltips) act on the shared state')

  // Option-click on a caret.
  await row('Section 9').scrollIntoViewIfNeeded()
  await caret('Section 9').click({ modifiers: ['Alt'] })
  sameSet(await outlineCollapsed(), ['Section 9']) // (Part A is inside it, out of sight)
  await caret('Section 9').click() // a plain click opens Section 9 alone...
  sameSet(await outlineCollapsed(), ['Part A']) // ...and Part A was collapsed with it
  await caret('Section 9').click({ modifiers: ['Alt'] })
  await caret('Section 9').click({ modifiers: ['Alt'] }) // collapsed: option-click opens it and everything inside
  sameSet(await outlineCollapsed(), [])
  assert.equal(await row('Deep 1').count(), 1, 'the deepest slides are on screen')
  pass('outline: option-click on a caret collapses or opens that section and every section inside it; a plain click takes one level')

  // ═══ 5. Reveal ═══
  await page.evaluate(() => window.bulkExpand())
  await row('Section 2').scrollIntoViewIfNeeded()
  await caret('Section 2').click()
  await page.evaluate(() => { document.querySelector('.slides-organizer').scrollTop = 0 })
  const target = await page.evaluate(() => window.lineOf('### Slide 2.7'))
  await page.evaluate((l) => window.reveal(l), target)
  await sleep(120)
  sameSet(await outlineCollapsed(), [])
  assert.equal(await row('Slide 2.7').count(), 1, 'the jump opened Section 2')
  assert(await inView('Slide 2.7'), 'and the row is scrolled into view')
  pass('outline: an explicit jump to a slide inside a collapsed section opens the section and scrolls the row into view')

  // Typing inside a collapsed section: not opened; the section stands for the caret.
  await caret('Section 5').click()
  await page.evaluate(() => { document.querySelector('.slides-organizer').scrollTop = 0 })
  const typingLine = await page.evaluate(() => window.lineOf('- point 5.4'))
  await page.evaluate((l) => window.setUi({ currentLine: l }), typingLine)
  await sleep(120)
  await page.evaluate(() => window.insertAfter('- point 5.4', ' more words typed'))
  await page.evaluate((l) => window.setUi({ currentLine: l }), typingLine)
  await sleep(120)
  sameSet(await outlineCollapsed(), ['Section 5'])
  assert.equal(await row('Section 5').evaluate((el) => el.classList.contains('so-row--current')), true, 'the collapsed section that hides the caret is marked as current')
  assert(await inView('Section 5'), 'and scrolled into view (the follow-the-caret scroll no longer does nothing)')
  pass('outline: typing in a slide inside a collapsed section does not open it; the section is marked and scrolled to instead')

  // The grid: an active slide inside a collapsed group opens it.
  await page.evaluate(() => window.bulkExpand())
  await page.locator(`${GRID} [data-section-header]`, { hasText: 'Section 4' }).click()
  sameSet(await gridCollapsed(), ['Section 4'])
  const inFour = await page.evaluate(() => window.gridIndexOf('Slide 4.3'))
  await page.evaluate((i) => window.setUi({ active: i }), inFour)
  await sleep(120)
  sameSet(await gridCollapsed(), [])
  assert.equal(await page.locator(`${GRID} [data-slide-index="${inFour}"]`).count(), 1)
  sameSet(await outlineCollapsed(), [])
  pass('grid: selecting a slide that sits in a collapsed group (a jump from the strip or a search) opens the group')

  // ═══ 6. Search ═══
  await page.evaluate(() => window.bulkExpand())
  await caret('Section 6').click()
  await caret('Section 8').click()
  const search = page.locator(`${ORG} .so-search-input`)
  await search.fill('Slide 6.4')
  assert.equal(await page.locator(`${ORG} .so-slide`).count(), 1, 'a slide inside a collapsed section is found')
  await search.fill('')
  sameSet(await outlineCollapsed(), ['Section 6', 'Section 8'])
  assert.equal(await row('Slide 6.4').count(), 0, 'clearing the search puts the collapsed state back as it was')
  await search.fill('Slide 8.3')
  await page.locator(`${ORG} .so-slide`).first().click()
  await search.fill('')
  sameSet(await outlineCollapsed(), ['Section 6'])
  assert.equal(await row('Slide 8.3').count(), 1)
  assert((await page.evaluate(() => window.jumps)).includes(await page.evaluate(() => window.lineOf('### Slide 8.3'))), 'the editor jumped to the chosen result')
  await sleep(150)
  assert(await inView('Slide 8.3'), 'the chosen result is scrolled into view once the search is cleared')
  pass('outline: search finds slides in collapsed sections; clearing restores the state; choosing a result opens its sections')

  // ═══ 7. Dragging ═══
  await page.evaluate(() => window.bulkExpand())
  const centre = async (locator) => { const b = await locator.boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 } }
  async function startDrag(locator) {
    await locator.scrollIntoViewIfNeeded()
    const c = await centre(locator)
    await page.mouse.move(c.x, c.y); await page.mouse.down()
    await page.mouse.move(c.x + 4, c.y + 6, { steps: 4 }); await page.mouse.move(c.x + 6, c.y + 12, { steps: 2 })
  }
  async function dragTo(x, y) { await page.mouse.move(x, y, { steps: 3 }); await page.mouse.move(x, y) }
  const toTop = () => page.evaluate(() => { document.querySelector('.slides-organizer').scrollTop = 0 })

  // Rest on a collapsed section: it opens; drop on a row of ANOTHER open section: it closes again.
  await toTop()
  await caret('Section 1').click()
  await toTop()
  await startDrag(row('Slide 0.2'))
  let c = await centre(row('Section 1'))
  await dragTo(c.x, c.y)
  await sleep(900)
  sameSet(await outlineCollapsed(), [], 'resting on it opened Section 1')
  c = await centre(row('Slide 0.5'))
  await dragTo(c.x, c.y)
  await page.mouse.up()
  await sleep(120)
  sameSet(await outlineCollapsed(), ['Section 1'])
  assert.equal(await page.evaluate(() => window.docText().split('\n').indexOf('### Slide 0.2')) > 0, true)
  pass('outline: a section opened by a drag resting on it goes back to collapsed when the slide is dropped elsewhere')

  // Rest on a collapsed section, then drop on one of its slides: it stays open and shows the slide.
  await page.evaluate(() => window.undoDoc())
  await sleep(80)
  await toTop()
  await startDrag(row('Slide 0.2'))
  c = await centre(row('Section 1'))
  await dragTo(c.x, c.y)
  await sleep(900)
  await row('Section 1').evaluate((el) => el.scrollIntoView({ block: 'start' })) // bring the opened section to the top, clear of the edge zones
  c = await centre(row('Slide 1.3'))
  await dragTo(c.x, c.y)
  await page.mouse.up()
  await sleep(150)
  sameSet(await outlineCollapsed(), [])
  assert.equal(await row('Slide 0.2').count(), 1, 'the moved slide is on screen')
  const t1 = await page.evaluate(() => window.docText())
  assert(t1.indexOf('### Slide 0.2') > t1.indexOf('## Section 1') && t1.indexOf('### Slide 0.2') < t1.indexOf('### Slide 1.3'), 'dropped before Slide 1.3, inside Section 1')
  pass('outline: a drop inside a section that the drag opened keeps it open and shows the moved slide')

  // Drop straight onto a collapsed section row (no waiting): into it, and it opens to show the slide.
  await page.evaluate(() => window.undoDoc())
  await sleep(80)
  await toTop()
  await caret('Section 1').click()
  await toTop()
  await startDrag(row('Slide 0.2'))
  c = await centre(row('Section 1'))
  await dragTo(c.x, c.y)
  await page.mouse.up()
  await sleep(200)
  sameSet(await outlineCollapsed(), [], 'Section 1 opened to show the slide dropped into it')
  assert.equal(await row('Slide 0.2').count(), 1)
  assert(await inView('Slide 0.2'))
  pass('outline: a slide dropped into a collapsed section opens it and is scrolled into view')

  // Drag that ends with no drop (outside the list) closes what it opened.
  await page.evaluate(() => window.undoDoc())
  await sleep(80)
  await toTop()
  await caret('Section 1').click()
  await toTop()
  await startDrag(row('Slide 0.4'))
  c = await centre(row('Section 1'))
  await dragTo(c.x, c.y)
  await sleep(900)
  sameSet(await outlineCollapsed(), [])
  await dragTo(900, 650) // out over the grid frame: no drop target
  await page.mouse.up()
  await sleep(150)
  sameSet(await outlineCollapsed(), ['Section 1'])
  pass('outline: a drag that ends with no drop closes the sections it opened')

  // ═══ 8. Layout at the sidebar\'s widths, and pictures ═══
  for (const width of [160, 240]) {
    await freshApp(width)
    await page.locator(`${ORG} [data-so-collapse-all]`).click()
    await page.evaluate(() => { document.querySelector('.slides-organizer').scrollTop = 0 })
    const m = await page.evaluate(() => {
      const bar = document.querySelector('.so-search').getBoundingClientRect()
      const input = document.querySelector('.so-search-input').getBoundingClientRect()
      const buttons = [...document.querySelectorAll('.so-search .tl-tbtn')].map((b) => b.getBoundingClientRect())
      const org = document.querySelector('.slides-organizer')
      return { bar: bar.width, input: input.width, buttons: buttons.map((b) => [Math.round(b.left - bar.left), Math.round(b.right - bar.left), Math.round(b.width)]), overflow: org.scrollWidth - org.clientWidth, barOverflow: document.querySelector('.so-search').scrollWidth - document.querySelector('.so-search').clientWidth }
    })
    assert(m.input >= 70, `at ${width}px the search box is still ${m.input}px wide`)
    assert.equal(m.barOverflow, 0, `at ${width}px the search bar does not overflow`)
    assert.equal(m.overflow, 0, `at ${width}px the outline does not scroll sideways`)
    assert(m.buttons.every(([l, r]) => r <= m.bar + 0.5 && l >= 0), 'both buttons sit inside the bar')
    assert(m.buttons[0][0] >= Math.round(m.input) - 4, 'the buttons sit beside the input, not on it')
    if (shots) await page.locator('.sidebar-wrap').screenshot({ path: join(shots, width === 160 ? 'outline-narrowest-sidebar.png' : 'outline-default-sidebar.png') })
    console.log(`     ${width}px sidebar: search box ${Math.round(m.input)}px, buttons at ${JSON.stringify(m.buttons)}`)
  }
  pass('layout: at the narrowest (160px) and default (240px) sidebar widths the two buttons sit beside the search box without crowding or overflow')

  // ═══ Sections with ids and without, one at a time, in both directions (0.38.3-preview.10: with the
  // section ids the compiler really gives the grid, no single section was ever shared) ═══
  {
    const J = (...lines) => lines.join('\n')
    const slides = (p) => [0, 1, 2].flatMap((i) => [`### ${p}${i}`, `{id=${p.toLowerCase()}${i}}`, '', `- ${p}${i}`, ''])
    const MIXED = J(
      '# Mixed', '', '### Welcome', '{id=w0}', '', '- hello', '',
      '## Alpha', '{id=aaa11}', '', ...slides('A'),      // id on the line below
      '## Bravo', '', ...slides('B'),                     // no id
      '## Charlie {id=ccc33}', '', ...slides('C'),        // id on the heading
      '## Bravo', '{id=bbb22}', '', ...slides('D'),       // the same title again, with an id
      '## Echo', '', ...slides('E')                       // no id
    )
    await page.evaluate(([k, d]) => window.freshApp(k, d, 240), [TALK_KEY, MIXED])
    await sleep(50)
    const headerAt = (n) => page.locator(`${GRID} [data-section-header]`).nth(n)
    const gridState = () => page.evaluate(() => [...document.querySelectorAll('.grid-view [data-section-header]')].map((h) => (h.textContent.trim().startsWith('▸') ? '▸' : '▾') + h.children[1].textContent))
    const outlineState = () => page.evaluate((sel) => [...document.querySelectorAll(`${sel} .so-section`)].filter((el) => el.querySelector('.so-caret')).map((el) => (el.querySelector('.so-caret').getAttribute('aria-expanded') === 'false' ? '▸' : '▾') + el.querySelector('.so-section-label').textContent), ORG)
    assert.deepEqual(await gridState(), ['▾(no section)', '▾Alpha', '▾Bravo', '▾Charlie', '▾Bravo', '▾Echo'], 'the grid: the slide before the first section, then the five sections')
    assert.deepEqual(await outlineState(), ['▾Mixed', '▾Alpha', '▾Bravo', '▾Charlie', '▾Bravo', '▾Echo'])
    // Outline -> grid, one section at a time: id below, no id, id on the heading, the twin with an id.
    const outlineCaretAt = (n) => page.locator(`${ORG} .so-section .so-caret`).nth(n)
    for (const [n, want] of [[1, ['▾(no section)', '▸Alpha', '▾Bravo', '▾Charlie', '▾Bravo', '▾Echo']], [2, ['▾(no section)', '▸Alpha', '▸Bravo', '▾Charlie', '▾Bravo', '▾Echo']], [3, ['▾(no section)', '▸Alpha', '▸Bravo', '▸Charlie', '▾Bravo', '▾Echo']], [4, ['▾(no section)', '▸Alpha', '▸Bravo', '▸Charlie', '▸Bravo', '▾Echo']]]) {
      await outlineCaretAt(n).click()
      assert.deepEqual(await gridState(), want, `collapsed in the outline (section row ${n}): the grid shows the same`)
    }
    // Opened again in the grid, one at a time: the outline follows, and only that section.
    await headerAt(2).click()
    assert.deepEqual(await outlineState(), ['▾Mixed', '▸Alpha', '▾Bravo', '▸Charlie', '▸Bravo', '▾Echo'], 'the first Bravo (no id) opened by its grid header, not its twin')
    await headerAt(4).click()
    assert.deepEqual(await outlineState(), ['▾Mixed', '▸Alpha', '▾Bravo', '▸Charlie', '▾Bravo', '▾Echo'], 'the second Bravo (with an id) opened by its grid header')
    await headerAt(1).click(); await headerAt(3).click()
    assert.deepEqual(await outlineState(), ['▾Mixed', '▾Alpha', '▾Bravo', '▾Charlie', '▾Bravo', '▾Echo'])
    // Grid -> outline: collapse by the grid headers.
    await headerAt(5).click() // Echo, no id
    await headerAt(3).click() // Charlie, id on the heading
    await headerAt(1).click() // Alpha, id on the line below
    assert.deepEqual(await outlineState(), ['▾Mixed', '▸Alpha', '▾Bravo', '▸Charlie', '▾Bravo', '▸Echo'], 'collapsed by their grid headers: the outline shows the same three')
    assert.equal(await gridCells(), 1 + 2 * 4, 'the grid shows the Welcome card and the two open sections (a section card and three slides each)')
    const storedMixed = JSON.parse(await page.evaluate(() => window.fakeStorage.getItem('tw-outline-collapse-v1'))).talks[TALK_KEY].keys
    assert.deepEqual([...storedMixed].sort(), ['h2:Echo', 'id:aaa11', 'id:ccc33'], 'and they are remembered by the outline\'s own keys')
    // Leave the grid and come back; restart the app.
    await page.evaluate(() => window.setUi({ grid: false }))
    await sleep(30)
    assert.equal(await page.locator(GRID).count(), 0, 'the grid is closed')
    await page.evaluate(() => window.setUi({ grid: true }))
    await sleep(50)
    assert.deepEqual(await gridState(), ['▾(no section)', '▸Alpha', '▾Bravo', '▸Charlie', '▾Bravo', '▸Echo'], 'after leaving the grid and returning: the same three collapsed')
    await page.evaluate(([k, d]) => window.restartApp(k, d), [TALK_KEY, MIXED])
    await sleep(50)
    assert.deepEqual(await gridState(), ['▾(no section)', '▸Alpha', '▾Bravo', '▸Charlie', '▾Bravo', '▸Echo'], 'after an app restart: the same three collapsed in the grid')
    assert.deepEqual(await outlineState(), ['▾Mixed', '▸Alpha', '▾Bravo', '▸Charlie', '▾Bravo', '▸Echo'], 'and in the outline')
    // The save gives the id-less sections ids while two are collapsed: nothing changes in either view.
    await page.evaluate(() => { window.insertAfter('## Echo', '{id=eee55}'); window.insertAfter('## Bravo', '{id=bbb00}') })
    await sleep(80)
    assert.deepEqual(await outlineState(), ['▾Mixed', '▸Alpha', '▾Bravo', '▸Charlie', '▾Bravo', '▸Echo'], 'ids written under the id-less headings: the outline keeps its three')
    assert.deepEqual(await gridState(), ['▾(no section)', '▸Alpha', '▾Bravo', '▸Charlie', '▾Bravo', '▸Echo'], 'and so does the grid')
    await headerAt(5).click()
    assert.deepEqual(await outlineState(), ['▾Mixed', '▸Alpha', '▾Bravo', '▸Charlie', '▾Bravo', '▾Echo'], 'Echo, now with an id, still opens from the grid')
    // The group that is no section (the slide before the first one): collapsed in the grid only, and kept while away.
    await headerAt(0).click()
    assert.deepEqual((await gridState())[0], '▸(no section)')
    assert.deepEqual(await outlineState(), ['▾Mixed', '▸Alpha', '▾Bravo', '▸Charlie', '▾Bravo', '▾Echo'], 'the outline has no such section and is unchanged')
    await page.evaluate(() => window.setUi({ grid: false }))
    await page.evaluate(() => window.setUi({ grid: true }))
    await sleep(50)
    assert.deepEqual(await gridState(), ['▸(no section)', '▸Alpha', '▾Bravo', '▸Charlie', '▾Bravo', '▾Echo'], 'after leaving and returning the grid still shows it collapsed')
    await headerAt(0).click()
    pass('sections with an id (below the heading, on the heading), without one, and two with the same title: each collapses and opens alone from either view, is remembered across leaving the grid and a restart, and survives the save writing ids')
  }

  assert.deepEqual(errors, [], 'no page errors')
  console.log(`\noutline-collapse-dom: ${passed} checks passed`)
} finally {
  await browser?.close()
  rmSync(dir, { recursive: true, force: true })
}
