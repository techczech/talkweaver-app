// Select many slides in the grid (slide handling ticket 1b), in a browser (Playwright's chromium headless shell,
// never the real Chrome), with the app's real stylesheet and a real CodeMirror buffer behind the grid.
// What is mounted: GridView wired as WorkspaceLayout wires it: moves are the real moveBlocks and cut/delete the real
// cutBlocks, each one transaction with its own undo step in the editor's history; paste and Move … to… are the
// editor's own whole-slide operations. Asserted: the text the user's talk would have.
//   1. selecting: tick box, ⇧-click range, ⌘-click toggle, Select section, Esc, Clear; the bar appears at two;
//   2. Move to… (section end, after a slide found by typing); the selection survives the move; one Undo;
//   3. Cut several then ⌘V round trip; Copy; Delete several + one Undo; the title cannot be deleted;
//   4. drag: a selected card drags all selected (talk order), an unselected card just itself.
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { copyBlocks, cutBlocks, moveBlocks } from '../src/shared/slide-handling/blocks.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'talk-weaver-grid-selection-'))
const outfile = join(dir, 'bundle.js')
const TALK_KEY = '/v/t/t-outline.md'

const SECTIONS = 4
const PER = 4
const parts = ['# Talk', '']
for (let s = 0; s < SECTIONS; s += 1) {
  parts.push(`## Section ${s}`, '')
  for (let i = 0; i < PER; i += 1) parts.push(`### Slide ${s}.${i}`, `{id=s${s}-${i}}`, '', `- point ${s}.${i}`, '', `Note: note ${s}.${i}`, '')
}
const TALK = parts.join('\n')
const lineOf = (text, heading) => { const i = text.split('\n').indexOf(heading); assert(i >= 0, `the talk has ${heading}`); return i + 1 }
const ref = (text, heading) => ({ line: lineOf(text, heading), headingText: heading })
const sorted = (t) => t.split('\n').filter((l) => l.trim()).sort().join('\n')
const sl = (s, i) => `### Slide ${s}.${i}`

const entry = `
import React, { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { EditorView } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { history, undo, redo, isolateHistory } from '@codemirror/commands'
import GridView from './src/renderer/src/components/GridView.tsx'
import { copySlideAt, cutSlideAt, deleteSlideAt, moveSlideTo, pasteSlidesAfter } from './src/renderer/src/extensions/slideCutPaste.ts'
import { rememberSlideClip } from './src/renderer/src/extensions/slideBlockOps.ts'
import { copyBlocks, cutBlocks, moveBlocks, refHolds } from './src/shared/slide-handling/blocks.ts'
import { publishOutline, resetOutlineCollapseForTests } from './src/renderer/src/lib/outlineCollapseStore.ts'
import { slideSelectionControls } from './src/renderer/src/lib/slideSelectionBus.ts'

const TALK_KEY = ${JSON.stringify(TALK_KEY)}
window.toasts = []
window.addEventListener('tw-toast', (e) => window.toasts.push(e.detail.message))
let mounted = null
function unmount() { if (mounted) { mounted.root.unmount(); mounted.view.destroy(); mounted = null } }

function cardsOf(text) {
  const lines = text.split('\\n')
  const rows = []
  let section = ''
  lines.forEach((l, i) => {
    const m = l.match(/^(#{2,3})\\s+(.*)$/)
    if (!m) return
    const title = m[2].replace(/\\{[^}]*\\}/g, '').trim()
    const id = ((lines[i + 1] || '').match(/\\{id=([^}]+)\\}/) || [])[1] || 'auto' + i
    if (m[1].length === 2) { section = title; rows.push({ slide_id: 'sec-' + title, title, nav_title: title, section, role: 'section-title', layout: 'section', source_markdown: '', render_hash: 'sec' + i, content_hash: 'sec' + i, warnings: [], line: i + 1, heading: l }) }
    else rows.push({ slide_id: id, title, nav_title: title, section, role: 'content', layout: 'default', source_markdown: '### ' + title, render_hash: id, content_hash: id, warnings: [], line: i + 1, heading: l })
  })
  return rows
}
const step = (view, text, changes) => view.dispatch({ changes, annotations: isolateHistory.of('full') })

window.mountGrid = (doc) => {
  unmount()
  resetOutlineCollapseForTests({ storage: null })
  window.toasts.length = 0
  window.moves = []
  window.clip = null
  document.getElementById('stage').innerHTML = '<div id="grid" style="width:760px;height:620px"></div><div id="cm" style="display:none"></div>'
  let setContent = () => {}
  const view = new EditorView({
    parent: document.getElementById('cm'),
    state: EditorState.create({ doc, extensions: [history(), EditorView.updateListener.of((u) => { if (u.docChanged) setContent(u.state.doc.toString()) })] })
  })
  window.docText = () => view.state.doc.toString()
  window.undoDoc = () => undo(view)
  window.redoDoc = () => redo(view)
  const slideOps = {
    cut: (line) => cutSlideAt(view, line), copy: (line) => copySlideAt(view, line),
    paste: (clip, afterLine) => pasteSlidesAfter(view, clip, afterLine),
    moveTo: (fromLine, target, cardRef) => moveSlideTo(view, fromLine, target, cardRef), delete: (line) => deleteSlideAt(view, line)
  }
  function Host() {
    const [content, set] = useState(doc)
    const [active, setActive] = useState(1)
    useEffect(() => { setContent = set }, [])
    const cards = useMemo(() => cardsOf(content), [content])
    useEffect(() => { publishOutline(TALK_KEY, content) }, [content])
    window.activeTitle = () => cards[active]?.title ?? null
    return React.createElement(GridView, {
      talk: { slug: 't', title: 'T', outlinePath: TALK_KEY },
      compiledSlides: cards, triggerFindings: [], thumbnails: null, activeIndex: active, columns: 4,
      onSelectSlide: setActive, onEdit: () => {}, onExplain: () => {},
      slideOps,
      lineOfSlide: (i) => cards[i]?.line ?? null,
      // As WorkspaceLayout: paste after a card only when its heading is still on its line.
      onPasteAfterCard: (clip, i) => {
        const c = cards[i]
        if (!c) return slideOps.paste(clip, null)
        if (!refHolds(view.state.doc.toString(), { line: c.line, headingText: c.heading })) return null
        return slideOps.paste(clip, c.line)
      },
      slideRefOf: (i) => (cards[i] ? { line: cards[i].line, headingText: view.state.doc.line(cards[i].line).text } : null),
      onLanded: () => {},
      onMoveSlides: (refs, place) => {
        window.moves.push([refs, place])
        const r = moveBlocks(view.state.doc.toString(), refs, place)
        if ('refused' in r) { window.lastRefusal = r.refused; return }
        step(view, r.text, r.changes)
      },
      onCutSlides: async (refs, mode) => {
        const r = cutBlocks(view.state.doc.toString(), refs)
        if ('refused' in r) { window.lastRefusal = r.refused; return false }
        step(view, r.text, r.changes)
        if (mode === 'cut') { rememberSlideClip(r.clip); window.clip = r.clip }
        return true
      },
      onCopySlides: (refs) => {
        const r = copyBlocks(view.state.doc.toString(), refs)
        if ('refused' in r) return null
        rememberSlideClip(r.clip); window.clip = r.clip
        return r.clip
      }
    })
  }
  const root = createRoot(document.getElementById('grid'))
  flushSync(() => root.render(React.createElement(Host)))
  mounted = { root, view }
}
window.selectionCommands = () => slideSelectionControls()
`

let browser
let passed = 0
const pass = (message) => { passed += 1; console.log(`PASS ${message}`) }
try {
  await build({
    stdin: { contents: entry, resolveDir: root, sourcefile: 'grid-selection-entry.tsx', loader: 'tsx' },
    bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', outfile, logLevel: 'error',
    define: { 'process.env.NODE_ENV': '"production"' }
  })
  browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1000, height: 760 }, permissions: ['clipboard-read', 'clipboard-write'] })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.route('http://localhost:4173/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body style="margin:0"><div id="stage" style="padding:20px 0 0 20px"></div></body></html>' }))
  await page.goto('http://localhost:4173/')
  await page.addStyleTag({ content: readFileSync(join(root, 'src/renderer/src/styles.css'), 'utf8') })
  await page.addScriptTag({ content: readFileSync(outfile, 'utf8') })

  const sleep = (ms) => page.waitForTimeout(ms)
  const doc = () => page.evaluate(() => window.docText())
  const mount = async (text = TALK) => { await page.evaluate((d) => window.mountGrid(d), text); await sleep(60) }
  const cell = (title) => page.locator('.grid-cell').filter({ has: page.locator('span', { hasText: new RegExp(`^${title.replace('.', '\\.')}$`) }) })
  const sCell = (s, i) => cell(`Slide ${s}.${i}`)
  const selectedTitles = () => page.locator('.grid-cell[data-selected="true"]').evaluateAll((els) => els.map((e) => e.querySelector('span:last-child').textContent))
  const bar = () => page.locator('[data-batch-bar]')
  const barCount = async () => ((await bar().count()) ? (await bar().locator('[data-batch-count]').textContent()) : null)
  const tick = (title) => cell(title).locator('[data-grid-tick]').click()
  const moves = () => page.evaluate(() => window.moves.splice(0))
  const toasts = () => page.evaluate(() => window.toasts.splice(0))
  const undo = async () => { await page.evaluate(() => window.undoDoc()); await sleep(60) }
  const redo = async () => { await page.evaluate(() => window.redoDoc()); await sleep(60) }
  const titles = (...pairs) => pairs.map(([s, i]) => `Slide ${s}.${i}`)

  // ── 1. selecting ──
  await mount()
  assert.equal(await page.locator('[data-grid-tick]').count(), 4 * 5, 'a tick box on every movable card (sections and slides)')
  assert.equal(await bar().count(), 0, 'no bar with nothing selected')
  await sCell(0, 1).click()
  assert.deepEqual(await selectedTitles(), [], 'a plain click only makes the card active: nothing is selected')
  assert.equal(await sCell(0, 1).getAttribute('data-active'), 'true')
  await tick('Slide 0.1')
  assert.equal(await bar().count(), 0, 'one selected: no bar')
  assert.deepEqual(await selectedTitles(), titles([0, 1]))
  await tick('Slide 1.2')
  assert.equal(await barCount(), '2 selected', 'the bar appears at two')
  assert.deepEqual(await selectedTitles(), titles([0, 1], [1, 2]))
  assert.deepEqual(await bar().locator('button').allTextContents(), ['Clear', 'Move to…', 'Cut', 'Copy', 'Delete'])
  await bar().locator('[data-batch-action="clear"]').click()
  assert.deepEqual(await selectedTitles(), [])
  assert.equal(await bar().count(), 0)
  pass('selecting: tick boxes select, the bar shows "N selected" with Clear, Move to…, Cut, Copy, Delete at two, Clear empties it')

  await sCell(0, 1).click()
  await sCell(0, 3).click({ modifiers: ['Shift'] })
  assert.deepEqual(await selectedTitles(), titles([0, 1], [0, 2], [0, 3]), '⇧-click: the range from the active card, talk order')
  await sCell(1, 1).click({ modifiers: ['Meta'] })
  assert.deepEqual(await selectedTitles(), titles([0, 1], [0, 2], [0, 3], [1, 1]), '⌘-click adds')
  await sCell(0, 2).click({ modifiers: ['Meta'] })
  assert.deepEqual(await selectedTitles(), titles([0, 1], [0, 3], [1, 1]), '⌘-click on a selected card takes it out')
  await sCell(2, 0).click()
  assert.deepEqual(await selectedTitles(), [], 'a plain click clears the selection and moves the active card')
  assert.equal(await sCell(2, 0).getAttribute('data-active'), 'true')
  pass('selecting: ⇧-click range, ⌘-click toggle, plain click clears')

  await page.locator('[data-section-header]').nth(1).locator('[data-grid-select-section]').click()
  assert.equal(await barCount(), '5 selected', 'Select section: the section card and its four slides')
  assert.deepEqual(await selectedTitles(), ['Section 1', ...titles([1, 0], [1, 1], [1, 2], [1, 3])])
  await page.locator('.grid-view').focus()
  await page.keyboard.press('Escape')
  assert.deepEqual(await selectedTitles(), [], 'Esc clears')
  assert.equal(await bar().count(), 0)
  // the commands
  await sCell(0, 0).click()
  assert.equal(await page.evaluate(() => window.selectionCommands().selectSection()), true)
  await sleep(60)
  assert.equal(await barCount(), '5 selected', 'the Select section command takes the active card\'s section')
  await page.evaluate(() => window.selectionCommands().clear())
  await sleep(60)
  assert.equal(await bar().count(), 0, 'the Clear slide selection command')
  pass('selecting: Select section on a heading, Esc, and the Select section / Clear slide selection commands')

  // ── 2. Move to… ──
  await mount()
  await tick('Slide 0.1'); await tick('Slide 0.3'); await tick('Slide 1.0')
  await bar().locator('[data-batch-action="move"]').click()
  await sleep(60)
  const opt = (key) => page.locator(`[data-batch-move-option="${key}"]`)
  const labels = await page.locator('[data-batch-move-option] .batch-menu-label').allTextContents()
  assert.deepEqual(labels.slice(0, 2), ['Start of talk', 'End of talk'])
  assert(labels.includes('End of “Section 2”') && labels.includes('End of “Section 3”'), 'a section end for each section')
  assert(!labels.includes('Slide 0.1') && !labels.includes('Slide 1.0'), 'the selected slides are not offered as places')
  assert(labels.includes('Slide 2.1'), 'the slide list follows')
  await opt(`into:${lineOf(TALK, '## Section 2')}`).click()
  await sleep(120)
  const sel3 = [ref(TALK, sl(0, 1)), ref(TALK, sl(0, 3)), ref(TALK, sl(1, 0))]
  const place2 = { kind: 'endOfSection', line: lineOf(TALK, '## Section 2'), title: 'Section 2' }
  const call = (await moves())[0]
  assert.deepEqual(call, [sel3, place2], 'one move with the three refs in talk order and the section end as place')
  const want = moveBlocks(TALK, sel3, place2)
  assert(!('refused' in want))
  assert.equal(await doc(), want.text, 'the text is the real moveBlocks result: three slides from two sections now end Section 2')
  assert.equal(sorted(await doc()), sorted(TALK), 'nothing lost or duplicated')
  assert.deepEqual(await selectedTitles(), titles([0, 1], [0, 3], [1, 0]), 'the same three slides are still selected after the move')
  await undo()
  assert.equal(await doc(), TALK, 'one Undo restores the talk byte for byte')
  await redo()
  assert.equal(await doc(), want.text, 'Redo moves them again')
  pass('Move to… : section end moves three slides from two sections in one step; selection survives; Undo/Redo byte-identical')

  await mount()
  await tick('Slide 0.0'); await tick('Slide 0.2')
  await bar().locator('[data-batch-action="move"]').click()
  await page.locator('[data-batch-move-input]').fill('Slide 3.1')
  await sleep(60)
  assert.deepEqual(await page.locator('[data-batch-move-option]').evaluateAll((els) => els.map((e) => e.dataset.batchMoveOption)), [`after:${lineOf(TALK, sl(3, 1))}`], 'typing finds a slide to go after')
  await page.keyboard.press('Enter')
  await sleep(120)
  const place31 = { kind: 'after', line: lineOf(TALK, sl(3, 1)), title: 'Slide 3.1' }
  const want31 = moveBlocks(TALK, [ref(TALK, sl(0, 0)), ref(TALK, sl(0, 2))], place31)
  assert.equal(await doc(), want31.text, 'After slide… by keyboard: the two slides follow Slide 3.1')
  await bar().locator('[data-batch-action="move"]').click()
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('[data-batch-menu]').count(), 0, 'Escape closes the menu')
  assert.equal(await barCount(), '2 selected', 'Escape in the menu keeps the selection')
  pass('Move to… : After slide… searches, Enter chooses, Escape closes the menu only')

  // ── 3. Cut, Copy, Delete ──
  await mount()
  await tick('Slide 0.1'); await tick('Slide 2.2')
  await bar().locator('[data-batch-action="cut"]').click()
  await sleep(120)
  const cut = cutBlocks(TALK, [ref(TALK, sl(0, 1)), ref(TALK, sl(2, 2))])
  assert.equal(await doc(), cut.text, 'Cut: both slides gone in one change')
  const clip = await page.evaluate(() => window.clip)
  assert.equal(clip, cut.clip, 'the clip is the two blocks in talk order')
  assert(clip.indexOf('Slide 0.1') < clip.indexOf('Slide 2.2'))
  assert.equal(await bar().count(), 0, 'the selection is cleared after a cut')
  await sCell(3, 3).click()
  await page.locator('.grid-view').focus()
  await page.evaluate((text) => {
    const dt = new DataTransfer(); dt.setData('text/plain', text)
    document.querySelector('.grid-view').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, clip)
  await sleep(120)
  const pasted = await doc()
  assert.equal(sorted(pasted), sorted(TALK), 'cut then paste: every line is back, none twice')
  assert(pasted.indexOf('### Slide 0.1') > pasted.indexOf('### Slide 3.3') && pasted.indexOf('### Slide 0.1') < pasted.indexOf('### Slide 2.2'), 'pasted after the active card, in talk order')
  await undo(); assert.equal(await doc(), cut.text, 'one Undo takes the paste back')
  await undo(); assert.equal(await doc(), TALK, 'one more Undo takes the cut back: byte-identical')
  pass('Cut several: one step, clip in talk order, ⌘V pastes them back whole, Undo byte-identical')

  await mount()
  await tick('Slide 1.1'); await tick('Slide 1.3')
  await bar().locator('[data-batch-action="copy"]').click()
  await sleep(80)
  assert.equal(await doc(), TALK, 'Copy changes nothing')
  assert.equal(await page.evaluate(() => window.clip), copyBlocks(TALK, [ref(TALK, sl(1, 1)), ref(TALK, sl(1, 3))]).clip)
  assert.equal(await barCount(), '2 selected', 'Copy keeps the selection')
  // ⌘C key: the clipboard event carries the clip
  const viaKey = await page.evaluate(() => {
    const dt = new DataTransfer()
    document.querySelector('.grid-view').dispatchEvent(new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }))
    return dt.getData('text/plain')
  })
  assert.equal(viaKey, await page.evaluate(() => window.clip), '⌘C with several selected puts all of them on the clipboard')
  pass('Copy several: nothing changes, the clip is the blocks in talk order, by button and by ⌘C')

  await mount()
  await tick('Slide 0.0'); await tick('Slide 3.3')
  await bar().locator('[data-batch-action="delete"]').click()
  await sleep(120)
  const del = cutBlocks(TALK, [ref(TALK, sl(0, 0)), ref(TALK, sl(3, 3))])
  assert.equal(await doc(), del.text, 'Delete several: both gone, no confirmation')
  assert.equal(await page.evaluate(() => window.clip), null, 'Delete does not touch the clipboard')
  await undo()
  assert.equal(await doc(), TALK, 'one Undo restores both, byte-identical')
  pass('Delete several: no question asked, one Undo step restores it')

  await mount()
  await page.locator('[data-section-header]').nth(2).locator('[data-grid-select-section]').click()
  await bar().locator('[data-batch-action="cut"]').click()
  await sleep(120)
  assert(!(await doc()).includes('Section 2') && !(await doc()).includes('Slide 2.'), 'a selected section (card + slides) cuts as one block')
  await undo()
  assert.equal(await doc(), TALK)
  pass('Select section then Cut takes the whole section in one step')

  // ── 4. drag ──
  async function drag(from, to) {
    await from.scrollIntoViewIfNeeded()
    const b = await from.boundingBox()
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
    await page.mouse.down()
    await page.mouse.move(b.x + b.width / 2 + 4, b.y + b.height / 2 + 6, { steps: 4 })
    const t = await to.boundingBox()
    await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 5 })
    await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2)
    await sleep(60)
    await page.mouse.up()
    await sleep(120)
  }
  await mount()
  await tick('Slide 0.3'); await tick('Slide 0.1')
  await drag(sCell(0, 3), sCell(1, 0))
  const dragged = await moves()
  assert.equal(dragged.length, 1)
  assert.deepEqual(dragged[0][0], [ref(TALK, sl(0, 1)), ref(TALK, sl(0, 3))], 'dragging a selected card moves all selected, in talk order')
  assert.deepEqual(dragged[0][1], { kind: 'after', line: lineOf(TALK, sl(1, 0)), title: 'Slide 1.0' })
  const wantDrag = moveBlocks(TALK, dragged[0][0], dragged[0][1])
  assert.equal(await doc(), wantDrag.text, 'both slides land after Slide 1.0')
  await undo(); assert.equal(await doc(), TALK)
  await drag(sCell(1, 2), sCell(1, 0))
  const one = await moves()
  assert.deepEqual(one[0][0], [ref(TALK, sl(1, 2))], 'dragging a card that is not selected moves just it')
  assert.deepEqual(await selectedTitles(), titles([0, 1], [0, 3]), 'and leaves the selection alone')
  pass('drag: a selected card drags every selected slide (talk order), an unselected card just itself; Undo byte-identical')

  await mount()
  await tick('Slide 0.3'); await tick('Slide 0.1')
  await drag(sCell(0, 3), sCell(0, 1))
  assert.deepEqual(await moves(), [], 'dropping the stack on one of its own cards does nothing')
  pass('drag: a drop on a selected card is ignored')

  // ── 5. the bar over the last row, and over the Scratchpad's pill and floating panel ──
  await mount()
  await tick('Slide 0.0'); await tick('Slide 0.1')
  const scroller = page.locator('.grid-view')
  await sleep(120)
  const barH = await bar().evaluate((el) => el.offsetHeight)
  const padBottom = await scroller.evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom))
  assert(padBottom >= barH + 12, `the grid's scroll area pads its bottom by the bar's height and a gap (${padBottom} vs bar ${barH})`)
  await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight })
  await sleep(80)
  const lastCard = await sCell(3, 3).boundingBox()
  const barBox = await bar().boundingBox()
  assert(lastCard.y + lastCard.height <= barBox.y + 0.5, 'scrolled to the end, the lowest card sits fully above the bar')
  await bar().locator('[data-batch-action="clear"]').click()
  await sleep(120)
  assert(await scroller.evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom)) <= 16, 'no bar: normal padding')
  pass('bar: the last row scrolls fully clear of the selection bar; padding goes with the bar')

  await tick('Slide 0.0'); await tick('Slide 0.1')
  const delBtn = bar().locator('[data-batch-action="delete"]')
  const overlap = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
  await page.evaluate(() => {
    const el = document.createElement('button')
    el.className = 'sp-pill'; el.id = 'fake-pill'; el.textContent = 'Slide Scratchpad · 0 Expand'
    el.style.cssText = 'position:fixed;z-index:800;right:18px;bottom:18px;padding:8px 14px'
    document.body.appendChild(el)
  })
  const barBottomEdge = await bar().evaluate((el) => el.getBoundingClientRect().bottom)
  await page.evaluate((b) => { document.getElementById('fake-pill').style.bottom = `${innerHeight - b + 2}px` }, barBottomEdge)
  await sleep(120)
  const pill = await page.locator('#fake-pill').boundingBox()
  assert(!overlap(await delBtn.boundingBox(), pill), 'with the collapsed pill over the corner, Delete is clear of it')
  assert(!overlap(await bar().boundingBox(), pill), 'the bar ends left of the pill')
  await page.evaluate(() => { document.getElementById('fake-pill').remove() })
  await sleep(120)
  assert.equal(await bar().evaluate((el) => el.style.marginRight), '', 'the pill gone, the bar is full width again')
  await page.evaluate((b) => {
    const el = document.createElement('div')
    el.className = 'sp-panel sp-panel--float'; el.id = 'fake-panel'
    el.style.cssText = `position:fixed;z-index:800;left:${innerWidth - 380}px;top:${b - 120}px;width:360px;height:260px;background:#fff`
    document.body.appendChild(el)
  }, barBottomEdge)
  await sleep(120)
  const panel = await page.locator('#fake-panel').boundingBox()
  assert(!overlap(await bar().boundingBox(), panel), 'with the floating panel over the corner, the bar ends left of it')
  await delBtn.click()
  assert.equal(await bar().count(), 0, 'Delete still works (the selection went)')
  await page.evaluate(() => { document.getElementById('fake-panel').remove() })
  await undo()
  pass('bar: stays fully usable beside the Scratchpad pill and its floating panel (ends left of them)')

  assert.deepEqual(errors, [], 'no page errors')
  console.log(`grid-selection-dom: ${passed} checks passed`)
} finally {
  await browser?.close()
  rmSync(dir, { recursive: true, force: true })
}
