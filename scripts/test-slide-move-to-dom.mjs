// Cut, copy and paste of whole slides, the slide and section menus, and "Move slide to…" /
// "Move section to…", in a browser (Playwright's chromium headless shell, never the real Chrome), on
// a 100-slide talk with the app's real stylesheet.
//
// What is mounted: the Slides organizer and the slide grid, each wired to a real CodeMirror editor
// that carries the real guard (idProtect.ts) and the real whole-slide cut/copy/paste
// (slideCutPaste.ts). The clipboard keys are real key presses (⌘X, ⌘C, ⌘V), so what is asserted is
// the text the user's talk would have and the toast they would read.
//   1. the editor: Backspace and Delete on a title are still refused; ⌘X on a title cuts the whole
//      slide; ⌘V on a title pastes whole slides after it and in body text pastes text; a second paste
//      gets a fresh id; each is one undo step;
//   2. the outline: ⌘X / ⌘C / ⌘V on the selected row, a section with its slides, the end of the talk;
//   3. the row menus and the destination list, by mouse and by keyboard, and the reveal after a move;
//   4. the grid: the same keys on the selected card, the card and section-header menus.
// SCREENSHOT_DIR=<dir> saves the five pictures of the menus and the list.
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { slideRows, relocateBlockAfter, relocateBlockInto, relocateBlockToEnd } from '../src/renderer/src/extensions/slideOutline.ts'
import { cutBlock } from '../src/renderer/src/extensions/slideBlockOps.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'talk-weaver-slide-move-to-'))
const outfile = join(dir, 'bundle.js')
const shots = process.env.SCREENSHOT_DIR
if (shots) mkdirSync(shots, { recursive: true })

// ── The talk: 100 slides in 10 sections, each slide with an id line, a body and a note ──
const SECTIONS = 10
const PER = 10
const parts = ['# Talk', '']
for (let s = 0; s < SECTIONS; s += 1) {
  parts.push(`## Section ${s}`, '')
  for (let i = 0; i < PER; i += 1) parts.push(`### Slide ${s}.${i}`, `{id=s${s}-${i}}`, '', `- point ${s}.${i}`, '', `Note: note ${s}.${i}`, '')
}
const TALK = parts.join('\n')
// Ordinal number of an outline row when nothing compiled is published: the title row is 1 and every row counts (outlineNumbers).
const ordOf = (text, line) => slideRows(text).findIndex((r) => r.line === line) + 1
const two = (n) => String(n).padStart(2, '0')
const lineOf = (text, heading) => { const i = text.split('\n').indexOf(heading); assert(i >= 0, `the talk has ${heading}`); return i + 1 }
const words = (t) => t.split('\n').filter((l) => l.trim() !== '').sort()
const headings = (t) => t.split('\n').filter((l) => /^#{1,6}\s/.test(l))
const ids = (t) => [...t.matchAll(/\{id=([^}]+)\}/g)].map((m) => m[1])
const TALK_KEY = '/v/t/t-outline.md'

const entry = `
import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { EditorView, keymap } from '@codemirror/view'
import { EditorState, EditorSelection } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, undo } from '@codemirror/commands'
import SlidesOrganizer from './src/renderer/src/components/SlidesOrganizer.tsx'
import GridView from './src/renderer/src/components/GridView.tsx'
import { tokenProtectExtension } from './src/renderer/src/extensions/idProtect.ts'
import {
  copySlideAt, cutSlideAt, deleteSlideAt, moveSlideTo, pasteSlideTextAtCaret, pasteSlidesAfter, pasteSlidesAt, slideCutCopyExtension, wouldPasteAsSlides
} from './src/renderer/src/extensions/slideCutPaste.ts'
import { publishStripNumbers, stripNumbersToPublish } from './src/renderer/src/lib/stripNumbers.ts'
import { computeSlideLines } from './src/shared/slide-lines.ts'
import { pasteAtHeadingEnd } from './src/renderer/src/extensions/headingEndInsert.ts'
import { publishOutline, resetOutlineCollapseForTests } from './src/renderer/src/lib/outlineCollapseStore.ts'
import { activeHeadingLine, createActiveLineReporter, slideIndexAtLine } from './src/renderer/src/lib/activeOutlineLine.ts'
import { blockAt, copyBlocks, cutBlocks, refHolds } from './src/shared/slide-handling/blocks.ts'
import { rememberSlideClip } from './src/renderer/src/extensions/slideBlockOps.ts'
import { writeSlideClipboard } from './src/renderer/src/components/SlideRowMenus.tsx'
import { notify } from './src/renderer/src/lib/notify.ts'
import { isolateHistory } from '@codemirror/commands'

const TALK_KEY = ${JSON.stringify(TALK_KEY)}
window.toasts = []
window.addEventListener('tw-toast', (e) => window.toasts.push(e.detail.message))

let mounted = null
function unmount() { if (mounted) { mounted.root.unmount(); mounted.view.destroy(); mounted = null } }

// The editor as the app builds it for these operations: history, the id and heading guard, the
// whole-slide cut and copy, and the paste rule of Editor.tsx's paste handler.
function makeEditor(doc, onChange, onCursor) {
  const view = new EditorView({
    parent: document.getElementById('cm'),
    state: EditorState.create({ doc, extensions: [
      history(),
      tokenProtectExtension(),
      slideCutCopyExtension(),
      EditorView.domEventHandlers({ paste(event, v) {
        const text = event.clipboardData?.getData('text/plain') ?? ''
        if (!wouldPasteAsSlides(v, text)) {
          // The end of Editor.tsx's paste handler: text with a line break at the end of a title.
          if (!text || !pasteAtHeadingEnd(v, text)) return false
          event.preventDefault()
          return true
        }
        event.preventDefault()
        pasteSlideTextAtCaret(v, text)
        return true
      } }),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) onChange(u.state.doc.toString())
        if (onCursor && (u.selectionSet || u.docChanged)) onCursor()
      })
    ] })
  })
  window.docText = () => view.state.doc.toString()
  window.insertBeforeLine = (line, text) => { view.dispatch({ changes: { from: view.state.doc.line(line).from, insert: text } }) }
  window.undoDoc = () => undo(view)
  window.cutAt = (line) => cutSlideAt(view, line)
  window.selectRange = (from, to) => { view.dispatch({ selection: EditorSelection.range(from, to) }); view.focus() }
  window.wouldPaste = (text) => wouldPasteAsSlides(view, text)
  window.pasteAfter = (clip, line) => pasteSlidesAfter(view, clip, line)
  window.pasteAtEnd = (clip) => pasteSlidesAt(view, clip, 'end')
  window.caretLine = () => view.state.doc.lineAt(view.state.selection.main.head).number
  // Caret (or a selection to toCol) on the line holding exactly this text; the editor takes the keyboard.
  window.setCaret = (lineText, col = 0, toCol = null) => {
    const n = view.state.doc.toString().split('\\n').indexOf(lineText) + 1
    const line = view.state.doc.line(n)
    view.dispatch({ selection: toCol == null ? EditorSelection.cursor(line.from + col) : EditorSelection.range(line.from + col, line.from + toCol), scrollIntoView: true })
    view.focus()
  }
  return view
}
// The whole-slide operations exactly as Editor.tsx registers them.
const slideOpsOf = (view) => ({
  cut: (line) => cutSlideAt(view, line),
  copy: (line) => copySlideAt(view, line),
  paste: (clip, afterLine) => pasteSlidesAfter(view, clip, afterLine),
  moveTo: (fromLine, target, cardRef) => moveSlideTo(view, fromLine, target, cardRef),
  delete: (line) => deleteSlideAt(view, line)
})
function stage() {
  resetOutlineCollapseForTests({ storage: null })
  window.toasts.length = 0
  document.getElementById('stage').innerHTML =
    '<div style="display:flex;gap:16px"><div id="left"></div><div id="cm" style="width:420px;height:300px;overflow:auto;border:1px solid #ccc"></div></div>'
}

const headingLines = (text) => text.split('\\n').map((l, i) => (/^#{1,6}\\s/.test(l) ? i + 1 : null)).filter((n) => n != null)

// What WorkspaceLayout publishes (same call): before the first compile compiled is null and computeSlideLines gives the fallback strip's lines.
window.publishFromWorkspace = (compiled, content) => publishStripNumbers(stripNumbersToPublish(compiled, computeSlideLines(compiled, content)))
window.publishNumbers = (pairs) => publishStripNumbers(pairs ? new Map(pairs) : null)
window.mountOutline = (doc) => {
  unmount()
  stage()
  document.getElementById('left').innerHTML = '<div class="sidebar-wrap" style="width:260px;height:620px"><div class="sidebar-modebar" style="height:40px;padding:0">tabs</div><div class="sidebar-nav-body" id="nav"></div></div>'
  let setContent = () => {}
  // window.followCaret ('new' | 'old', unset in the older blocks): the outline is told which row the
  // caret is in, and a row jump moves the caret, as the workspace does it. The heading lines of the
  // slides arrive a moment AFTER the text (they come from a compile). 'new' is the rule of
  // lib/activeOutlineLine.ts as WorkspaceLayout uses it: told by line, and again when the slides
  // arrive. 'old' is the rule before the fix round: told only when the slide INDEX under the caret
  // changed, at caret moves only.
  const follow = window.followCaret || null
  let setCurrent = () => {}
  let slideLines = headingLines(doc)
  let lastIndex = -1
  const reporter = createActiveLineReporter(() => (line) => setCurrent(line))
  const caretLine = () => view.state.doc.lineAt(view.state.selection.main.head).number
  const onCursor = () => {
    const index = slideIndexAtLine(slideLines, caretLine())
    if (index < 0) return
    if (follow === 'old') { if (index !== lastIndex) { lastIndex = index; setCurrent(slideLines[index]) } }
    else reporter.report(slideLines[index] ?? null)
  }
  const onCompiled = (text) => {
    slideLines = headingLines(text)
    if (follow === 'new') reporter.report(activeHeadingLine(slideLines, caretLine()))
  }
  const view = makeEditor(doc, (text) => { setContent(text); if (follow) setTimeout(() => onCompiled(text), 60) }, follow ? () => onCursor() : null)
  const ops = { move: () => {}, reLevel: () => {}, moveTo: () => {}, moveToEnd: () => {}, moveInto: () => {}, slides: slideOpsOf(view) }
  window.jumps = []
  const jump = (line) => {
    window.jumps.push(line)
    if (!follow) return
    const at = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)))
    view.dispatch({ selection: EditorSelection.cursor(at.from) })
  }
  function Host() {
    const [content, set] = useState(doc)
    const [current, setCur] = useState(null)
    useEffect(() => { setContent = set; setCurrent = setCur }, [])
    return React.createElement(SlidesOrganizer, { content, onJump: jump, ops, currentLine: follow ? current : null, talkKey: TALK_KEY })
  }
  const root = createRoot(document.getElementById('nav'))
  flushSync(() => root.render(React.createElement(Host)))
  mounted = { root, view }
}

// The grid's cards from the talk's text: a section-title card per ## heading and a card per ### slide,
// each knowing its source line (what the workspace's line lookup answers in the app).
function cardsOf(text) {
  const lines = text.split('\\n')
  const rows = []
  let section = ''
  lines.forEach((l, i) => {
    const m = l.match(/^(#{2,3})\\s+(.*)$/)
    if (!m) return
    const title = m[2].replace(/\\{[^}]*\\}/g, '').trim()
    const id = ((lines[i + 1] || '').match(/\\{id=([^}]+)\\}/) || [])[1] || 'auto' + i
    if (m[1].length === 2) { section = title; rows.push({ slide_id: 'sec-' + i, title, nav_title: title, section, role: 'section-title', layout: 'section', source_markdown: '', render_hash: 'sec' + i, content_hash: 'sec' + i, warnings: [], line: i + 1 }) }
    else rows.push({ slide_id: id, title, nav_title: title, section, role: 'content', layout: 'default', source_markdown: '### ' + title, render_hash: id, content_hash: id, warnings: [], line: i + 1 })
  })
  return rows
}
window.mountGrid = (doc) => {
  unmount()
  stage()
  document.getElementById('left').innerHTML = '<div id="grid" style="width:620px;height:620px"></div>'
  let setContent = () => {}
  const view = makeEditor(doc, (text) => setContent(text))
  const slideOps = slideOpsOf(view)
  window.landed = []
  window.explained = []
  window.more = []
  function Host() {
    const [content, set] = useState(doc)
    const [active, setActive] = useState(1)
    const [landing, setLanding] = useState(null)
    useEffect(() => { setContent = set }, [])
    // window.frozenText: the cards stay as compiled from that text while the buffer changes (a compile lag).
    const cards = React.useMemo(() => cardsOf(window.frozenText ?? content), [content])
    useEffect(() => { publishOutline(TALK_KEY, content) }, [content])
    // As the workspace does: once the cards carry the change, the landed slide's card is selected.
    useEffect(() => {
      if (landing == null) return
      const i = cards.findIndex((c) => c.line === landing)
      if (i >= 0) { setActive(i); setLanding(null) }
    }, [cards, landing])
    window.activeTitle = () => cards[active]?.title ?? null
    return React.createElement(GridView, {
      talk: { slug: 't', title: 'T', outlinePath: TALK_KEY },
      compiledSlides: cards, triggerFindings: [], thumbnails: null, activeIndex: active, columns: 3,
      onSelectSlide: setActive, onEdit: () => {}, onReorder: () => {},
      onExplain: (i) => { window.explained.push(cards[i].title) },
      slideOps,
      lineOfSlide: (i) => cards[i]?.line ?? null,
      // Wired as WorkspaceLayout wires them (slideRefOf: the card's heading; cut / copy / paste checked against the buffer).
      slideRefOf: (i) => {
        const c = cards[i]
        if (!c || !/^#{1,6}\\s/.test(view.state.doc.line(Math.min(c.line, view.state.doc.lines)).text)) return null
        return { line: c.line, headingText: c.source_markdown ? c.source_markdown.split('\\n')[0] : c.title }
      },
      onCutSlides: async (refs, mode) => {
        const text = view.state.doc.toString()
        const r = cutBlocks(text, refs)
        if ('refused' in r) { notify(r.refused, 'info', 'slide-clipboard'); return false }
        view.dispatch({ changes: r.changes, annotations: isolateHistory.of('full') })
        const outer = blockAt(text, Math.min(...refs.map((x) => x.line)))
        const one = (outer?.section ? 'section' : 'slide') + ' “' + r.titles[0] + '”'
        if (mode === 'cut') { writeSlideClipboard(r.clip, true); notify(r.count === 1 ? 'Cut ' + one + '. Paste with ⌘V.' : 'Cut ' + r.count + ' slides. Paste with ⌘V.', 'info', 'slide-clipboard') }
        else notify(r.count === 1 ? 'Deleted ' + one + '. Undo with ⌘Z to get it back.' : 'Deleted ' + r.count + ' slides. Undo with ⌘Z to get them back.', 'info', 'slide-clipboard')
        return true
      },
      onCopySlides: (refs) => {
        const text = view.state.doc.toString()
        const r = copyBlocks(text, refs)
        if ('refused' in r) { notify(r.refused, 'info', 'slide-clipboard'); return null }
        rememberSlideClip(r.clip)
        return r.clip
      },
      onPasteAfterCard: (clip, i) => {
        const c = cards[i]
        if (!c) return slideOps.paste(clip, null)
        const ref = { line: c.line, headingText: c.source_markdown ? c.source_markdown.split('\\n')[0] : c.title }
        if (!refHolds(view.state.doc.toString(), ref)) { notify('The talk changed while you were pasting, and the slide you chose is no longer where it was. Nothing was pasted; try again.', 'info', 'slide-clipboard'); return null }
        return slideOps.paste(clip, ref.line)
      },
      onLanded: (line) => { window.landed.push(line); setLanding(line) },
      onMoreActions: (i) => { window.more.push(cards[i].title) }
    })
  }
  const root = createRoot(document.getElementById('grid'))
  flushSync(() => root.render(React.createElement(Host)))
  mounted = { root, view }
}
`

let browser
let passed = 0
const pass = (message) => { passed += 1; console.log(`PASS ${message}`) }
try {
  await build({
    stdin: { contents: entry, resolveDir: root, sourcefile: 'slide-move-to-entry.tsx', loader: 'tsx' },
    bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', outfile, logLevel: 'error',
    define: { 'process.env.NODE_ENV': '"production"' }
  })
  browser = await chromium.launch()
  // A localhost page (a secure context) with clipboard access granted: the menus' Paste row reads the clipboard.
  const ORIGIN = 'http://localhost:4173'
  const context = await browser.newContext({ viewport: { width: 1100, height: 700 }, permissions: ['clipboard-read', 'clipboard-write'] })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body style="margin:0"><div id="stage" style="padding:20px 0 0 20px"></div></body></html>' }))
  await page.goto(`${ORIGIN}/`)
  await page.addStyleTag({ content: readFileSync(join(root, 'src/renderer/src/styles.css'), 'utf8') })
  await page.addScriptTag({ content: readFileSync(outfile, 'utf8') })

  const ORG = '.slides-organizer'
  const GRID = '.grid-view'
  const MENU = '[data-slide-row-menu]'
  const LIST = '[data-move-to]'
  const sleep = (ms) => page.waitForTimeout(ms)
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const doc = () => page.evaluate(() => window.docText())
  const toasts = () => page.evaluate(() => window.toasts.splice(0))
  const lastToast = async () => (await toasts()).pop() ?? null
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText())
  const undo = async () => { await page.evaluate(() => window.undoDoc()); await sleep(60) }
  const key = async (k) => { await page.keyboard.press(k); await sleep(80) }
  const row = (text) => page.locator(`${ORG} [data-line]`).filter({ has: page.locator('.so-section-label, .so-slide-title', { hasText: new RegExp(`^${esc(text)}$`) }) })
  const clickRow = async (text) => { await row(text).first().scrollIntoViewIfNeeded(); await row(text).first().locator('.so-section-label, .so-slide-title').click(); await sleep(40) }
  const menuLabels = () => page.locator(`${MENU} .tl-mi`).evaluateAll((els) => els.map((el) => { const k = el.querySelector('.tl-mi-k'); const label = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(''); return k ? `${label} [${k.textContent}]` : label }))
  const options = () => page.locator(`${LIST} [data-move-option]`).evaluateAll((els) => els.map((el) => el.querySelector('.actions-here-label').textContent))
  const inView = (sel, scroller) => page.evaluate(([s, sc]) => {
    const el = document.querySelector(s)
    if (!el) return false
    const box = document.querySelector(sc).getBoundingClientRect()
    const r = el.getBoundingClientRect()
    return r.top >= box.top - 1 && r.bottom <= box.bottom + 1
  }, [sel, scroller])
  const selectedRow = () => page.evaluate((sel) => document.querySelector(`${sel} .so-row--sel`)?.querySelector('.so-section-label, .so-slide-title')?.textContent ?? null, ORG)
  const shot = async (name) => { if (shots) await page.screenshot({ path: join(shots, name) }) }
  const blockOf = (text, heading) => cutBlock(text, lineOf(text, heading)).clip

  // ═══ 1. The editor ═══
  await page.evaluate((d) => window.mountOutline(d), TALK)
  await page.evaluate(() => window.setCaret('### Slide 0.1', 4))
  await key('Backspace')
  assert.equal(await doc(), TALK, 'Backspace at the start of a title changes nothing')
  assert.match(await lastToast(), /^A slide title has to stay/)
  await page.evaluate(() => window.setCaret('{id=s0-1}', 9))
  await key('Delete')
  assert.equal(await doc(), TALK, 'Delete at the end of the id line changes nothing')
  await page.evaluate(() => window.setCaret('{id=s0-1}', 9))
  await key('Backspace')
  assert.equal(await doc(), TALK, 'Backspace on the id changes nothing')
  pass('editor: Backspace on a title, and Delete and Backspace on its id line, are still refused')

  await page.evaluate(() => window.setCaret('### Slide 0.1', 6))
  await toasts()
  await key('Meta+x')
  const afterCut = cutBlock(TALK, lineOf(TALK, '### Slide 0.1'))
  assert.equal(await doc(), afterCut.text, '⌘X on the title line cut the whole slide: title, id line, body, note')
  assert.equal(await clipboard(), '### Slide 0.1\n{id=s0-1}\n\n- point 0.1\n\nNote: note 0.1\n', 'the clipboard holds the slide as plain Markdown')
  assert.equal(await lastToast(), 'Cut slide “Slide 0.1”. Paste with ⌘V.')
  await undo()
  assert.equal(await doc(), TALK, 'one undo brings the slide back')
  await page.evaluate(() => window.setCaret('{id=s0-1}', 0))
  await key('Meta+x')
  assert.equal(await doc(), afterCut.text, '⌘X on the id line under the title cuts the same slide')
  pass('editor: ⌘X with the caret on a title (or its id line) cuts the whole slide in one undo step, with the toast and the Markdown on the clipboard')

  await page.evaluate(() => window.setCaret('### Slide 5.5', 3))
  await key('Meta+v')
  let text = await doc()
  assert.deepEqual(headings(text).slice(headings(text).indexOf('### Slide 5.5'), headings(text).indexOf('### Slide 5.5') + 3), ['### Slide 5.5', '### Slide 0.1', '### Slide 5.6'], 'it went after the slide the caret was on')
  assert.deepEqual(words(text), words(TALK), 'cut then paste: the same lines as before, in a new order')
  assert.ok(text.includes('### Slide 0.1\n{id=s0-1}\n'), 'a cut then one paste is a move: the id is kept')
  assert.equal(await lastToast(), 'Pasted slide “Slide 0.1” after “Slide 5.5”.')
  assert.equal(await page.evaluate(() => window.caretLine()), lineOf(text, '### Slide 0.1'), 'the caret is on the pasted title')
  const moved = text
  await key('Meta+v')
  text = await doc()
  assert.equal(headings(text).filter((h) => h === '### Slide 0.1').length, 2, 'a second paste adds a copy')
  assert.equal(new Set(ids(text)).size, ids(text).length, 'no id is in the talk twice')
  const fresh = ids(text).filter((id) => !ids(TALK).includes(id))
  assert.equal(fresh.length, 1)
  assert.match(fresh[0], /^[a-z0-9]{5}$/, 'the copy has a freshly minted id of the usual shape')
  assert.deepEqual(words(text.replace(`{id=${fresh[0]}}`, '{id=s0-1}')), [...words(TALK), ...words(blockOf(TALK, '### Slide 0.1'))].sort(), 'nothing else in the pasted text changed')
  await undo()
  assert.equal(await doc(), moved, 'the second paste, with its new id, is one undo step')
  await undo()
  assert.equal(await doc(), afterCut.text, 'and the first paste another')
  pass('editor: ⌘V on a title pastes the slide after that slide; one paste keeps the id, a second gets a fresh one in the same undo step')

  await page.evaluate(() => window.setCaret('- point 4.4', 2))
  await key('Meta+v')
  text = await doc()
  assert.ok(text.includes('- ### Slide 0.1\n{id=s0-1}\n\n- point 0.1\n\nNote: note 0.1\npoint 4.4'), 'in body text the clipboard is pasted as text at the caret, as before')
  await undo()
  await page.evaluate(() => window.setCaret('Note: note 3.3', 14))
  await key('ArrowDown') // the blank line between Slide 3.3 and Slide 3.4
  await key('Meta+v')
  text = await doc()
  assert.deepEqual(headings(text).slice(headings(text).indexOf('### Slide 3.3'), headings(text).indexOf('### Slide 3.3') + 3), ['### Slide 3.3', '### Slide 0.1', '### Slide 3.4'], 'on the blank line between two slides it lands between them')
  assert.deepEqual(words(text), words(TALK))
  await undo()
  await undo()
  assert.equal(await doc(), TALK)
  pass('editor: in body text ⌘V pastes text as before; between two slides it pastes the slide between them')

  await page.evaluate(() => window.setCaret('### Slide 2.2', 5, 9)) // "lide" inside the title
  await key('Meta+x')
  assert.equal(await doc(), TALK.replace('### Slide 2.2', '### S 2.2'), 'a selection inside a title cuts only that text; the heading stays')
  assert.equal(await clipboard(), 'lide')
  await undo()
  await page.evaluate(() => window.setCaret('### Slide 2.2', 0, 13)) // the whole title line
  await toasts()
  await key('Meta+c')
  assert.equal(await clipboard(), blockOf(TALK, '### Slide 2.2').replace(/\n$/, '\n\n'), 'copying a selection that holds a whole title copies its whole slide')
  await key('Meta+x')
  assert.equal(await doc(), cutBlock(TALK, lineOf(TALK, '### Slide 2.2')).text, 'cutting it cuts the whole slide, so a title is never parted from its slide')
  assert.equal(await lastToast(), 'Cut the whole slide “Slide 2.2”: its title was in the selection.')
  await undo()
  assert.equal(await doc(), TALK)
  pass('editor: a selection inside a title cuts text only; a selection holding the whole title takes the whole slide')

  // The last slide of the talk. (The case an ordinary cut would be refused, blank lines after the last
  // slide, is in scripts/test-slide-cut-guard.mjs, which fails when the guard's exemption is removed.)
  await page.evaluate(() => window.setCaret('### Slide 9.9', 0))
  await toasts()
  await key('Meta+x')
  assert.equal(await doc(), cutBlock(TALK, lineOf(TALK, '### Slide 9.9')).text, 'the last slide of the talk is cut whole')
  assert.ok(!(await doc()).includes('Slide 9.9') && (await doc()).endsWith('Note: note 9.8\n'))
  assert.equal(await lastToast(), 'Cut slide “Slide 9.9”. Paste with ⌘V.')
  await undo()
  assert.equal(await doc(), TALK)
  pass('editor: ⌘X cuts the last slide of the talk whole')

  // The talk's title (#): its block is the whole talk, so a whole-slide cut of it is refused everywhere.
  await page.evaluate(() => navigator.clipboard.writeText('kept'))
  await page.evaluate(() => window.setCaret('# Talk', 3))
  await toasts()
  await key('Meta+x')
  assert.equal(await doc(), TALK, '⌘X with the caret on the talk\'s title cuts nothing')
  assert.deepEqual(await toasts(), ['The talk’s title can’t be cut.'], 'one notice, and no other toast (no native cut reached the heading guard)')
  assert.equal(await clipboard(), 'kept', 'nothing is written to the clipboard')
  assert.equal(await page.evaluate(() => window.cutAt(1)), null, 'the operation the outline, the grid and the commands call refuses it too')
  assert.equal(await doc(), TALK)
  assert.equal(await lastToast(), 'The talk’s title can’t be cut.')
  await page.evaluate(() => window.setCaret('# Talk', 0, 6)) // the whole title line selected
  await toasts()
  await key('Meta+x')
  assert.equal(await doc(), TALK, 'a selection holding the title line does not take the whole talk either')
  assert.deepEqual(await toasts(), ['The talk’s title can’t be cut.'])
  // A selection from the title into the first slide's heading: widened, it would start at the title.
  const intoSlide = TALK.indexOf('### Slide 0.0') + '### Slide 0.0'.length
  for (const [from, to, what] of [[0, intoSlide, 'from the title to the end of the first slide\'s title'], [3, intoSlide, 'from inside the title'], [0, TALK.length, 'the whole talk']]) {
    await page.evaluate(([f, t]) => window.selectRange(f, t), [from, to])
    await toasts()
    await key('Meta+x')
    assert.equal(await doc(), TALK, `⌘X on a selection ${what}: nothing is removed`)
    assert.deepEqual(await toasts(), ['The talk’s title can’t be cut.'], `${what}: the one notice, no native cut`)
    assert.equal(await clipboard(), 'kept', `${what}: nothing is written to the clipboard`)
  }
  await page.evaluate(() => window.setCaret('# Talk', 2, 6)) // "Talk", inside the title
  await key('Meta+x')
  assert.equal(await doc(), TALK.replace('# Talk', '# '), 'a selection inside the title\'s text is an ordinary cut, as before')
  await undo()
  assert.equal(await doc(), TALK)
  // ⌘C on a selection that touches the title: the selected text, not widened, not a slide to paste.
  await page.evaluate((t) => window.selectRange(0, t), intoSlide)
  await toasts()
  await key('Meta+c')
  assert.equal(await clipboard(), TALK.slice(0, intoSlide), 'exactly what is selected is copied')
  assert.deepEqual(await toasts(), [], 'and it is not announced as a whole slide')
  await page.evaluate(() => window.setCaret('### Slide 5.5', 3))
  assert.equal(await page.evaluate((t) => window.wouldPaste(t), TALK.slice(0, intoSlide)), false, 'on a slide title it would be pasted as text')
  await page.evaluate(() => window.setCaret('# Talk', 3))
  await key('Meta+c')
  assert.equal(await clipboard(), TALK, 'copying from the title is as it was: the whole talk')
  await page.evaluate(() => window.setCaret('### Slide 5.5', 3))
  assert.equal(await page.evaluate((t) => window.wouldPaste(t), TALK), false, 'but it is not a slide to paste')
  await toasts()
  assert.equal(await page.evaluate((t) => window.pasteAfter(t, 5), TALK), null, 'Paste slide after refuses it')
  assert.equal(await lastToast(), 'Nothing to paste. Cut or copy a slide first.')
  assert.equal(await page.evaluate(() => window.pasteAtEnd('# Another talk\n\n### S\n')), null, 'a clip that starts with a talk title is never pasted as slides')
  assert.equal(await lastToast(), 'Nothing to paste. Cut or copy a slide first.')
  assert.equal(await doc(), TALK)
  pass('editor: the talk\'s title is not cut by ⌘X on its line, by a selection holding it, or by the whole-slide cut operation; one plain notice')

  // Clipboard text from somewhere else that merely starts with a # line is ordinary text.
  const FOREIGN = '# install\nnpm i foo'
  await page.evaluate((t) => navigator.clipboard.writeText(t), FOREIGN)
  await page.evaluate(() => window.setCaret('Note: note 3.3', 14))
  await key('ArrowDown') // the blank line between Slide 3.3 and Slide 3.4, where a slide would be pasted between them
  await toasts()
  await key('Meta+v')
  assert.equal(await doc(), TALK.replace('Note: note 3.3\n\n### Slide 3.4', `Note: note 3.3\n${FOREIGN}\n### Slide 3.4`), 'it goes in at the caret as text, not as a slide with separators')
  assert.deepEqual((await toasts()).filter((t) => t.startsWith('Pasted')), [], 'and is not announced as a pasted slide')
  await undo()
  assert.equal(await doc(), TALK)
  // The same text with the caret at the END of a slide title (0.38.3-preview.12: `npm i foo` went
  // between the title and its id line, and the save gave the slide a new id). The first line stays on
  // the title; the rest goes under the id line, which is still directly under its heading.
  await page.evaluate(() => window.setCaret('### Slide 3.3', '### Slide 3.3'.length))
  await key('Meta+v')
  assert.equal(await doc(), TALK.replace('### Slide 3.3\n{id=s3-3}\n', '### Slide 3.3# install\n{id=s3-3}\nnpm i foo\n'), 'pasted at the end of a title: the id line stays directly under the heading')
  assert.equal(await page.evaluate(() => window.caretLine()), lineOf(await doc(), 'npm i foo'), 'the caret is at the end of the pasted text')
  await undo()
  assert.equal(await doc(), TALK, 'one undo puts the whole paste back')
  // In the middle of the title it is CodeMirror's own paste, as before.
  await page.evaluate(() => window.setCaret('### Slide 3.3', 6))
  await key('Meta+v')
  assert.ok((await doc()).includes('### Sl# install\nnpm i fooide 3.3\n{id=s3-3}\n'), 'in the middle of a title the paste is the ordinary one')
  await undo()
  assert.equal(await doc(), TALK)
  // The same slide text, typed elsewhere rather than cut or copied here: still ordinary text.
  await page.evaluate((t) => navigator.clipboard.writeText(t), blockOf(TALK, '### Slide 0.1') + ' ')
  await page.evaluate(() => window.setCaret('Note: note 3.3', 14))
  await key('ArrowDown')
  await key('Meta+v')
  assert.ok((await doc()).includes('Note: note 3.3\n### Slide 0.1\n{id=s0-1}\n'), 'text that only looks like this app\'s slide is pasted as text: no separator, the id not rewritten')
  await undo()
  assert.equal(await doc(), TALK)
  pass('editor: clipboard text this app did not write with a slide cut or copy is pasted as ordinary text, even when it starts with a heading')

  // ═══ 2. The outline: ⌘X / ⌘C / ⌘V on the selected row ═══
  await clickRow('Slide 3.3')
  await toasts()
  await key('Meta+x')
  const cut33 = cutBlock(TALK, lineOf(TALK, '### Slide 3.3'))
  assert.equal(await doc(), cut33.text, '⌘X in the outline cut the selected slide')
  assert.equal(await lastToast(), 'Cut slide “Slide 3.3”. Paste with ⌘V.')
  assert.equal(await row('Slide 3.3').count(), 0)
  await clickRow('Slide 7.7')
  await key('Meta+v')
  text = await doc()
  assert.deepEqual(headings(text).slice(headings(text).indexOf('### Slide 7.7'), headings(text).indexOf('### Slide 7.7') + 3), ['### Slide 7.7', '### Slide 3.3', '### Slide 7.8'])
  assert.deepEqual(words(text), words(TALK))
  assert.equal(await lastToast(), 'Pasted slide “Slide 3.3” after “Slide 7.7”.')
  await sleep(120)
  assert.equal(await selectedRow(), 'Slide 3.3', 'the pasted slide is the selected row')
  assert.ok(await inView(`${ORG} .so-row--sel`, ORG), 'and it is in view')
  assert.deepEqual(await page.evaluate(() => window.jumps.slice(-1)), [lineOf(text, '### Slide 3.3')], 'the editor is taken to it')
  await undo()
  assert.equal(await doc(), cut33.text, 'the paste is one undo step')
  await undo()
  assert.equal(await doc(), TALK, 'the cut another')
  pass('outline: ⌘X cuts the selected slide, ⌘V pastes it after the newly selected slide and selects it there; one undo step each')

  await clickRow('Section 2')
  await key('Meta+c')
  assert.equal(await lastToast(), 'Copied section “Section 2”. Paste with ⌘V.')
  assert.equal(await doc(), TALK, 'copy leaves the talk alone')
  await clickRow('Section 8')
  await key('Meta+v')
  text = await doc()
  const hs = headings(text)
  assert.equal(hs[hs.indexOf('### Slide 8.9') + 1], '## Section 2', 'pasted after the WHOLE of Section 8')
  assert.deepEqual(hs.slice(hs.lastIndexOf('## Section 2'), hs.lastIndexOf('## Section 2') + 12), ['## Section 2', ...Array.from({ length: 10 }, (_, i) => `### Slide 2.${i}`), '## Section 9'], 'with its ten slides')
  assert.equal(ids(text).length, 110)
  assert.equal(new Set(ids(text)).size, 110, 'each of the ten copied slides has a fresh id')
  assert.equal(await lastToast(), 'Pasted section “Section 2” after “Section 8”.')
  await undo()
  assert.equal(await doc(), TALK, 'a section with ten fresh ids is one undo step')
  pass('outline: a section is copied with its slides and pasted after the whole selected section, every copied slide with a fresh id')

  await clickRow('Slide 0.0')
  await key('Meta+x')
  await page.focus(ORG) // the panel has the keyboard and no row is selected
  assert.equal(await selectedRow(), null)
  await key('Meta+v')
  text = await doc()
  assert.equal(headings(text).pop(), '### Slide 0.0', 'with nothing selected the slide is pasted at the end of the talk')
  assert.equal(await lastToast(), 'Pasted slide “Slide 0.0” at the end of the talk.')
  assert.deepEqual(words(text), words(TALK))
  await undo(); await undo()
  await page.focus(`${ORG} .so-search-input`)
  await key('Meta+v')
  assert.equal(await doc(), TALK, '⌘V in the search box types into the box, not into the talk')
  assert.ok((await page.inputValue(`${ORG} .so-search-input`)).includes('Slide 0.0'))
  await page.fill(`${ORG} .so-search-input`, '')
  pass('outline: with no row selected ⌘V pastes at the end of the talk; the search box keeps its own paste')

  // ═══ 3. The row menus and the destination list ═══
  await row('Slide 1.1').first().scrollIntoViewIfNeeded()
  await row('Slide 1.1').first().click({ button: 'right' })
  await sleep(60)
  assert.deepEqual(await menuLabels(), ['Move slide to…', 'Cut slide [⌘X]', 'Copy slide [⌘C]', 'Paste slide after [⌘V]', 'Delete slide [⌘⇧⌫]'])
  assert.equal(await selectedRow(), 'Slide 1.1', 'a right-click selects the row')
  await shot('outline-slide-menu.png')
  await key('Escape')
  assert.equal(await page.locator(MENU).count(), 0, 'Escape closes the menu')
  await row('Section 6').first().scrollIntoViewIfNeeded()
  await row('Section 6').first().click({ button: 'right' })
  await sleep(60)
  assert.deepEqual(await menuLabels(), ['Move section to…', 'Cut section [⌘X]', 'Copy section [⌘C]', 'Paste after section [⌘V]', 'Collapse [←]'])
  await shot('outline-section-menu.png')
  await page.locator(`${MENU} [data-slide-row-action="collapse"]`).click()
  await sleep(60)
  assert.equal(await row('Slide 6.3').count(), 0, 'Collapse collapses the section')
  await row('Section 6').first().click({ button: 'right' })
  await sleep(60)
  assert.deepEqual((await menuLabels()).slice(-1), ['Expand [→]'], 'a collapsed section offers Expand')
  await page.locator(`${MENU} [data-slide-row-action="collapse"]`).click()
  await sleep(60)
  assert.equal(await row('Slide 6.3').count(), 1)
  assert.equal(await doc(), TALK, 'opening and closing menus changes nothing')
  pass('outline: the slide menu and the section menu show their rows and shortcuts; Collapse and Expand work from the menu')

  // Copy from the menu, paste from the menu (the clipboard itself, not a key event).
  await row('Slide 1.1').first().scrollIntoViewIfNeeded()
  await row('Slide 1.1').first().click({ button: 'right' })
  await page.locator(`${MENU} [data-slide-row-action="copy"]`).click()
  await sleep(80)
  assert.equal(await clipboard(), blockOf(TALK, '### Slide 1.1'))
  await row('Slide 1.4').first().click({ button: 'right' })
  await page.locator(`${MENU} [data-slide-row-action="paste"]`).click()
  await sleep(200)
  text = await doc()
  assert.deepEqual(headings(text).slice(headings(text).indexOf('### Slide 1.4'), headings(text).indexOf('### Slide 1.4') + 3), ['### Slide 1.4', '### Slide 1.1', '### Slide 1.5'])
  assert.equal(new Set(ids(text)).size, 101, 'the pasted copy has a fresh id')
  await undo()
  await row('Slide 1.1').first().click({ button: 'right' })
  await page.locator(`${MENU} [data-slide-row-action="delete"]`).click()
  await sleep(80)
  assert.equal(await doc(), cutBlock(TALK, lineOf(TALK, '### Slide 1.1')).text.replace(/\n\n$/, '\n\n'), 'Delete slide removes the slide')
  await undo()
  assert.equal(await doc(), TALK)
  pass('outline: Copy slide, Paste slide after and Delete slide work from the menu')

  // Paste from the menu and ⌘V on a row, with a clipboard this app did not write as a slide.
  await page.evaluate(() => navigator.clipboard.writeText('# install\nnpm i foo'))
  await row('Slide 1.4').first().click({ button: 'right' })
  await toasts()
  await page.locator(`${MENU} [data-slide-row-action="paste"]`).click()
  await sleep(200)
  assert.equal(await doc(), TALK, 'Paste slide after does nothing')
  assert.equal(await lastToast(), 'Nothing to paste. Cut or copy a slide first.')
  await clickRow('Slide 1.4')
  await key('Meta+v')
  assert.equal(await doc(), TALK, '⌘V on the selected row does nothing')
  assert.equal(await lastToast(), 'Nothing to paste. Cut or copy a slide first.')
  pass('outline: Paste slide after and ⌘V do nothing and say so when the clipboard is not a slide cut or copied here')

  // Move slide to…: into a collapsed section, by keyboard.
  await row('Section 9').first().scrollIntoViewIfNeeded()
  await row('Section 9').first().locator('.so-caret').click()
  assert.equal(await row('Slide 9.0').count(), 0, 'Section 9 is collapsed')
  await row('Slide 1.1').first().scrollIntoViewIfNeeded()
  await row('Slide 1.1').first().click({ button: 'right' })
  await sleep(60)
  await key('ArrowDown') // Move slide to…
  await key('Enter')
  assert.equal(await page.locator(MENU).count(), 0)
  const outlineNo = (text) => row(text).first().locator('.so-slide-no').textContent()
  assert.equal(await page.locator(`${LIST} [data-move-to-title]`).textContent().then((t) => t.replace(/\s+/g, ' ')), `Move slide ${(await page.locator(`${LIST} [data-move-to-title] .move-to-no`).textContent())} “Slide 1.1” to`, 'the heading line carries the moved slide\'s number')
  assert.match(await page.locator(`${LIST} [data-move-to-title] .move-to-no`).textContent(), /^\d\d$/)
  assert.deepEqual(await options(), ['Start of talk', 'End of talk', ...Array.from({ length: 10 }, (_, i) => `Section ${i}`)])
  assert.deepEqual(await page.locator(`${LIST} [data-current="true"] .actions-here-label`).allTextContents(), ['Section 1'], 'the section it is in is marked')
  assert.equal(await page.locator(`${LIST} [data-move-option="into:${lineOf(TALK, '## Section 4')}"] .actions-here-chord`).textContent(), '10 slides')
  assert.ok(await page.evaluate(() => document.activeElement?.hasAttribute('data-move-to-input')), 'the filter box has the keyboard')
  assert.equal(await page.locator(`${LIST} [data-move-option="into:${lineOf(TALK, '## Section 4')}"] [data-move-no]`).textContent(), two(ordOf(TALK, lineOf(TALK, '## Section 4'))), 'before the first compile a section row shows its ordinal (title 01, every row counts)')
  {
    // With the strip's numbers published (as the workspace does after each compile) a section row shows the number of
    // its own title slide, then its heading, and typing the number finds it.
    const heading = lineOf(TALK, '## Section 4')
    const pairs = slideRows(TALK).map((r, i) => [r.line, i + 1])
    await page.evaluate((p) => window.publishNumbers(p), pairs)
    await page.keyboard.press('Escape'); await sleep(60)
    await row('Slide 1.1').first().click({ button: 'right' }); await sleep(60)
    await key('ArrowDown'); await key('Enter')
    const secRow = page.locator(`${LIST} [data-move-option="into:${heading}"]`)
    assert.equal(await secRow.locator('[data-move-no]').textContent(), String(pairs.find(([l]) => l === heading)[1]).padStart(2, '0'), 'a section row: its own slide\'s number at the left')
    assert.equal(await secRow.locator('.actions-here-label').textContent(), 'Section 4')
    assert.equal(await secRow.locator('.actions-here-chord').textContent(), '10 slides', 'the count stays on the right')
    assert.equal(await secRow.evaluate((el) => el.firstElementChild.hasAttribute('data-move-no')), true)
    await page.locator(`${LIST} [data-move-to-input]`).fill(String(pairs.find(([l]) => l === heading)[1]))
    await sleep(80)
    assert.ok((await options()).includes('Section 4'), 'typing a section\'s number finds the section')
    // The outline's own rows carry the same compiled numbers as the Move list: slide rows, section rows and the talk title row.
    {
      const shownRows = await page.locator(`${ORG} [data-line]`).evaluateAll((els) => els.map((el) => [Number(el.getAttribute('data-line')), el.querySelector('.so-slide-no')?.textContent ?? null, el.querySelector('.so-count') != null]))
      assert.ok(shownRows.length > 20)
      for (const [l, no, hasCount] of shownRows) {
        const want = pairs.find(([pl]) => pl === l)
        assert.equal(no, String(want[1]).padStart(2, '0'), `outline row at line ${l} shows the compiled number`)
        if (hasCount) assert.notEqual(no, null)
      }
      assert.equal(await row('Section 4').first().locator('.so-slide-no').textContent(), String(pairs.find(([l]) => l === heading)[1]).padStart(2, '0'), 'a section row shows its own title slide\'s number')
      assert.equal(await row('Section 4').first().evaluate((el) => el.firstElementChild.classList.contains('so-slide-no')), true, 'the number is first in the row')
      assert.equal(await secRow.locator('[data-move-no]').textContent(), await row('Section 4').first().locator('.so-slide-no').textContent(), 'outline and Move list agree for the section')
      await page.locator(`${LIST} [data-move-to-input]`).fill('Slide 6.4'); await sleep(80)
      const slideOpt = await page.locator(`${LIST} [data-move-option^="slide:"]`).first().evaluate((el) => [el.dataset.moveOption, el.firstElementChild.textContent])
      assert.equal(await page.locator(`${ORG} [data-line="${slideOpt[0].slice(6)}"] .so-slide-no`).textContent(), slideOpt[1], 'outline and Move list agree for a slide')
    }
    pass('outline: every row (slide, section, talk title) shows the compiled number, equal to the Move list\'s')
    await page.evaluate(() => window.publishNumbers(null))
    await sleep(60)
    {
      // Before the first compile: every row counts, the title row is 01, so sections and slides all have a number and nothing jumps.
      const fb = await page.locator(`${ORG} [data-line]`).evaluateAll((els) => els.map((el) => [Number(el.getAttribute('data-line')), el.querySelector('.so-slide-no')?.textContent ?? null]))
      assert.ok(fb.length > 20)
      for (const [l, no] of fb) assert.equal(no, two(ordOf(TALK, l)), `row at line ${l}: ordinal before any compile`)
      assert.equal(fb[0][1], '01', 'the title row is 01')
    }
    pass('outline: before compiled numbers exist every row, title and sections included, shows its ordinal')
    {
      // The real initial state: the workspace publishes on every change of its slide lines, and before the first compile those are the fallback
      // strip's (### headings only, no cover, no sections). The outline must still count by ordinal from the first frame, and nothing may change
      // when the compile lands in an ordinary talk.
      const nos = () => page.locator(`${ORG} [data-line]`).evaluateAll((els) => els.map((el) => [Number(el.getAttribute('data-line')), el.querySelector('.so-slide-no')?.textContent ?? '']))
      await page.evaluate((t) => window.publishFromWorkspace(null, t), TALK)
      await sleep(60)
      const first = await nos()
      for (const [l, no] of first) assert.equal(no, two(ordOf(TALK, l)), `first frame, line ${l}: ordinal`)
      assert.equal(first[0][1], '01')
      const compiled = slideRows(TALK).map((r, i) => ({ source_line: i === 0 ? null : r.line, role: r.level === 2 ? 'section-title' : 'content' }))
      await page.evaluate(([c, t]) => window.publishFromWorkspace(c, t), [compiled, TALK])
      await sleep(60)
      assert.deepEqual(await nos(), first, 'nothing changes when the compile lands')
      await page.evaluate((t) => window.publishFromWorkspace(null, t), TALK)
      await sleep(60)
      assert.deepEqual(await nos(), first, 'a talk load clears the published numbers: ordinals again')
    }
    pass('outline: the first frame (workspace publish before any compile) counts by ordinal, and nothing changes when the compile lands')
    {
      // Label alignment: Start / End of talk start where the other labels do; a section label starts where a slide label does.
      const labelX = (sel) => page.locator(sel).first().evaluate((el) => { const r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect().left })
      await page.locator(`${LIST} [data-move-to-input]`).fill(''); await sleep(80)
      const startX = await labelX(`${LIST} [data-move-option="start"] .actions-here-label`)
      const otherX = await labelX(`${LIST} [data-move-option^="into:"] .actions-here-label`)
      assert.ok(Math.abs(startX - otherX) < 0.5, `Start of talk label at ${startX}, others at ${otherX}`)
      // A section's label sits where its slides' labels do (the slides are one level deeper).
      const sec = await labelX(`${ORG} .so-section-label`)
      const sli = await labelX(`${ORG} .so-slide-title`)
      assert.ok(Math.abs(sec - sli) < 0.5, `section label at x=${sec}, slide label at x=${sli}`)
    }
    pass('move list: Start and End of talk labels line up with the others; outline: section labels line up with slide labels')
    {
      // Stale published numbers (they are keyed by the lines of the last compile): after an edit that adds lines, before the recompile.
      const outlineNos = () => page.locator(`${ORG} [data-line]`).evaluateAll((els) => els.map((el) => `${el.querySelector('.so-slide-title, .so-section-label').textContent}=${el.querySelector('.so-slide-no')?.textContent ?? ''}`))
      // Even numbers, so a number kept by position is told from one counted by ordinal.
      const pairs = slideRows(TALK).map((r, i) => [r.line, (i + 1) * 2])
      await page.evaluate((p) => window.publishNumbers(p), pairs)
      await sleep(60)
      const before = await outlineNos()
      assert.ok(before.length > 20)
      const rowsNow = slideRows(TALK)
      assert.deepEqual(before, before.map((b) => { const t = b.slice(0, b.lastIndexOf('=')); const r = rowsNow.find((x) => x.text === t); return `${t}=${two(pairs.find(([l]) => l === r.line)[1])}` }), 'fresh: the published numbers')
      // Two lines typed under Slide 0.0: every later heading moves down two lines, the map still names the old lines.
      await page.evaluate((l) => window.insertBeforeLine(l, 'first added line\nsecond added line\n'), lineOf(TALK, '### Slide 0.0') + 3)
      await sleep(80)
      assert.deepEqual(await outlineNos(), before, 'two lines added under a slide before the recompile: every number unchanged, none blank or repeated')
      await page.keyboard.press('Escape'); await sleep(60)
      await row('Slide 6.4').first().click({ button: 'right' }); await sleep(60)
      await key('ArrowDown'); await key('Enter')
      await page.locator(`${LIST} [data-move-to-input]`).fill('Slide 5.5'); await sleep(80)
      const opt = await page.locator(`${LIST} [data-move-option^="slide:"]`).first().evaluate((el) => [el.dataset.moveOption, el.firstElementChild.textContent])
      assert.equal(await page.locator(`${ORG} [data-line="${opt[0].slice(6)}"] .so-slide-no`).textContent(), opt[1], 'stale: the Move list shows the outline\'s number')
      await page.keyboard.press('Escape'); await sleep(60)
      // A slide added: the counts differ, so ordinals from the title row; none blank.
      await page.evaluate((l) => window.insertBeforeLine(l, '### Added slide\n\n'), lineOf(TALK, '### Slide 0.0') + 5)
      await sleep(80)
      const grown = await outlineNos()
      assert.equal(grown.length, before.length + 1)
      const grownNos = grown.map((g) => g.slice(g.lastIndexOf('=') + 1))
      assert.ok(grownNos.every((n) => /^\d+$/.test(n)) && new Set(grownNos).size === grownNos.length, 'a slide added before the recompile: every row numbered, no repeats')
      assert.equal(grownNos[0], '01', 'ordinal numbers from the title row')
      assert.ok(grown.includes('Added slide=' + grownNos[grown.findIndex((g) => g.startsWith('Added slide='))]), 'the new slide has a number')
      await page.evaluate(() => { window.undoDoc(); window.undoDoc() }); await sleep(80)
      assert.equal(await page.evaluate(() => window.docText()), TALK, 'the edits are undone')
      await page.evaluate(() => window.publishNumbers(null))
    }
    pass('outline: after an edit that shifts lines, before the recompile, the numbers stay exact (position) or run by ordinal when a slide was added; never blank, never repeated, and equal to the Move list')
    await page.keyboard.press('Escape'); await sleep(60)
    await row('Slide 1.1').first().click({ button: 'right' }); await sleep(60)
    await key('ArrowDown'); await key('Enter')
    pass('move list: a section row shows the number of its own title slide, then the heading, the count on the right; the number finds it')
  }
  await shot('move-slide-to-list.png')
  await page.keyboard.type('9')
  await sleep(80)
  {
    // Every slide row carries, first in the row, the number the outline shows (slideRows is the outline's own source), then its title.
    const outlineRows = slideRows(TALK)
    const shown = await page.locator(`${LIST} [data-move-option^="slide:"]`).evaluateAll((els) => els.map((el) => [el.dataset.moveOption, el.firstElementChild.hasAttribute('data-move-no'), el.firstElementChild.textContent, el.querySelector('.actions-here-label').textContent]))
    assert.ok(shown.length > 5)
    for (const [k, first, no, title] of shown) {
      const r = outlineRows.find((x) => x.line === Number(k.slice(6)))
      assert.equal(first, true, `${title}: the number is the first thing in the row`)
      assert.equal(no, two(ordOf(TALK, r.line)), `${title}: the outline's number (ordinal before a compile)`)
      assert.equal(title, r.text)
    }
    pass('move list: every slide row shows the outline\'s number at the left, then the title')
    // Typed digits find the slide with that number.
    const target = outlineRows.find((x) => x.text === 'Slide 6.4')
    await page.locator(`${LIST} [data-move-to-input]`).fill(String(ordOf(TALK, target.line)))
    await sleep(80)
    assert.ok((await options()).includes('Slide 6.4'), 'typing a slide\'s number finds it')
    await page.locator(`${LIST} [data-move-to-input]`).fill('9')
    await sleep(80)
  }
  assert.deepEqual(await options(), [...slideRows(TALK).filter((r) => r.level === 2 && (r.text.includes('9') || String(ordOf(TALK, r.line)).startsWith('9'))).map((r) => r.text), ...Array.from({ length: 10 }, (_, i) => `Slide ${i}.9`).filter((t) => t !== 'Slide 9.9').concat(Array.from({ length: 10 }, (_, i) => `Slide 9.${i}`)).concat(slideRows(TALK).filter((r) => r.slideNo != null && String(ordOf(TALK, r.line)).startsWith('9') && !/9/.test(r.text) && r.text !== 'Slide 1.1').map((r) => r.text)).sort((a, b) => lineOf(TALK, `### ${a}`) - lineOf(TALK, `### ${b}`))], 'typing filters the sections and offers the slides whose titles match')
  await shot('move-slide-to-filtered.png')
  await key('Escape')
  assert.equal(await page.locator(LIST).count(), 0)
  assert.equal(await doc(), TALK, 'Escape cancels with nothing changed')
  await row('Slide 1.1').first().click({ button: 'right' })
  await page.locator(`${MENU} [data-slide-row-action="move"]`).click()
  await page.keyboard.type('section 9')
  await sleep(80)
  assert.deepEqual(await options(), ['Section 9'])
  await toasts()
  await key('Enter')
  await sleep(150)
  text = await doc()
  assert.equal(text, relocateBlockInto(TALK, lineOf(TALK, '### Slide 1.1'), lineOf(TALK, '## Section 9')), 'the slide is now the last slide of Section 9')
  assert.equal(headings(text).pop(), '### Slide 1.1')
  assert.equal(await lastToast(), 'Moved “Slide 1.1” to the end of “Section 9”.')
  assert.equal(await row('Slide 9.0').count(), 1, 'the collapsed destination section was opened')
  assert.equal(await selectedRow(), 'Slide 1.1', 'the moved slide is selected')
  assert.ok(await inView(`${ORG} .so-row--sel`, ORG), 'and scrolled into view')
  await undo()
  assert.equal(await doc(), TALK, 'the move is one undo step')
  pass('outline: Move slide to… lists Start, End and every section with its slide count, filters as you type, and moves the slide into a collapsed section, which opens with the slide selected and in view; Escape cancels; one undo step')

  // By slide title: Before / After.
  await row('Slide 2.2').first().scrollIntoViewIfNeeded()
  await row('Slide 2.2').first().click({ button: 'right' })
  await page.locator(`${MENU} [data-slide-row-action="move"]`).click()
  await page.keyboard.type('slide 6.4')
  await sleep(80)
  assert.deepEqual(await options(), ['Slide 6.4'])
  await key('Enter')
  assert.deepEqual(await options(), ['Before “Slide 6.4”', 'After “Slide 6.4”'], 'choosing a slide asks before or after')
  await key('ArrowDown')
  await key('Enter')
  await sleep(150)
  assert.equal(await doc(), relocateBlockAfter(TALK, lineOf(TALK, '### Slide 2.2'), lineOf(TALK, '### Slide 6.4')))
  assert.equal(await lastToast(), 'Moved “Slide 2.2” after “Slide 6.4”.')
  await undo()
  // A section.
  await row('Section 4').first().scrollIntoViewIfNeeded()
  await row('Section 4').first().click({ button: 'right' })
  await page.locator(`${MENU} [data-slide-row-action="move"]`).click()
  await sleep(60)
  assert.equal(await page.locator(`${LIST} [data-move-to-title]`).textContent(), `Move section ${two(ordOf(TALK, lineOf(TALK, '## Section 4')))} “Section 4” to`)
  const sectionOptions = await options()
  assert.deepEqual(sectionOptions.slice(0, 4), ['Start of talk', 'End of talk', 'Before “Section 0”', 'After “Section 0”'])
  assert.ok(!sectionOptions.some((o) => o.includes('Section 4') || o.includes('Slide')), 'never inside itself, never among slides')
  assert.ok(!sectionOptions.includes('After “Section 3”') && !sectionOptions.includes('Before “Section 5”'), 'where it already is, is not offered')
  await page.locator(`${LIST} [data-move-option="after:${lineOf(TALK, '## Section 7')}"]`).click()
  await sleep(150)
  assert.equal(await doc(), relocateBlockAfter(TALK, lineOf(TALK, '## Section 4'), lineOf(TALK, '## Section 7')))
  assert.equal(await lastToast(), 'Moved “Section 4” after “Section 7”.')
  assert.equal(await selectedRow(), 'Section 4')
  await undo()
  assert.equal(await doc(), TALK)
  pass('outline: a slide chosen by title asks Before or After; Move section to… offers only places among sections of its level and moves the section with its slides')

  // ═══ 4. The grid ═══
  await page.evaluate((d) => window.mountGrid(d), TALK)
  await sleep(100)
  const cell = (title) => page.locator(`${GRID} [data-slide-index]`).filter({ hasText: new RegExp(`${esc(title)}$`) })
  const clickCell = async (title) => { await cell(title).first().scrollIntoViewIfNeeded(); await cell(title).first().click(); await sleep(40) }
  const activeTitle = () => page.evaluate(() => window.activeTitle())
  await clickCell('Slide 2.4')
  await toasts()
  await key('Meta+x')
  const cut24 = cutBlock(TALK, lineOf(TALK, '### Slide 2.4'))
  assert.equal(await doc(), cut24.text, '⌘X in the grid cut the selected card\'s slide')
  assert.equal(await lastToast(), 'Cut slide “Slide 2.4”. Paste with ⌘V.')
  await clickCell('Slide 6.0')
  await key('Meta+v')
  await sleep(120)
  text = await doc()
  assert.deepEqual(headings(text).slice(headings(text).indexOf('### Slide 6.0'), headings(text).indexOf('### Slide 6.0') + 3), ['### Slide 6.0', '### Slide 2.4', '### Slide 6.1'])
  assert.deepEqual(words(text), words(TALK))
  assert.deepEqual(await page.evaluate(() => window.landed), [lineOf(text, '### Slide 2.4')], 'the grid reports where it landed')
  assert.equal(await activeTitle(), 'Slide 2.4', 'and that card is selected')
  assert.ok(await inView(`${GRID} [data-active="true"]`, GRID))
  await undo(); await undo()
  assert.equal(await doc(), TALK)
  await clickCell('Section 3')
  assert.equal(await activeTitle(), 'Section 3')
  await key('Meta+x')
  // Slide handling ticket 1a: the grid's `###`-only refusal is gone; a section's card cuts the whole section.
  assert.equal(await doc(), cutBlock(TALK, lineOf(TALK, '## Section 3')).text, 'a section-title card cuts its whole section')
  assert.equal(await lastToast(), 'Cut section “Section 3”. Paste with ⌘V.')
  await undo()
  assert.equal(await doc(), TALK, 'one undo step')
  pass('grid: ⌘X cuts the selected slide, ⌘V pastes it after the selected card and selects it; a section card cuts its whole section')

  // Fix round 2 (R1): a card whose line is stale (the cards lag the buffer: an id-less heading, lines typed above it
  // before the compile) never cuts, copies, deletes or pastes at another block. Seven lines typed above Slide 2.3
  // put "### Slide 2.3" on the line the card "Slide 2.4" still names.
  {
    await page.evaluate((d) => { window.frozenText = d; window.mountGrid(d) }, TALK)
    await sleep(100)
    await clickCell('Slide 2.4')
    const typed = '### Typed above\nx\n\n- t\n\nNote: t\n\n'
    await page.evaluate(([line, t]) => window.insertBeforeLine(line, t), [lineOf(TALK, '### Slide 2.3'), typed])
    const shifted = await doc()
    assert.equal(shifted.split('\n')[lineOf(TALK, '### Slide 2.4') - 1], '### Slide 2.3', 'the card\'s old line now holds another slide')
    await toasts()
    await key('Meta+x')
    assert.equal(await doc(), shifted, '⌘X on the stale card cut nothing')
    assert.match(await lastToast(), /no longer where it was\. Nothing was moved/, 'and says why')
    await key('Meta+c')
    assert.match(await lastToast(), /no longer where it was/, '⌘C refused too')
    await page.evaluate(() => navigator.clipboard.writeText('### Pasted\n\nbody\n'))
    await key('Meta+v')
    await sleep(120)
    assert.equal(await doc(), shifted, '⌘V after the stale card pasted nothing')
    assert.match(await lastToast(), /Nothing was pasted/)
    await cell('Slide 2.4').first().click({ button: 'right' })
    await sleep(60)
    await page.locator(`${MENU} [data-slide-row-action="delete"]`).click()
    await sleep(120)
    assert.equal(await doc(), shifted, 'menu Delete on the stale card deleted nothing')
    assert.match(await lastToast(), /no longer where it was/)
    await cell('Slide 2.4').first().click({ button: 'right' })
    await sleep(60)
    await page.locator(`${MENU} [data-slide-row-action="move"]`).click()
    await sleep(60)
    await page.locator(`${LIST} [data-move-option="end"]`).click()
    await sleep(150)
    assert.equal(await doc(), shifted, 'menu Move slide to… on the stale card moved nothing')
    assert.match(await lastToast(), /no longer where it was\. Nothing was moved/)
    await page.evaluate((d) => { window.frozenText = undefined; window.mountGrid(d) }, TALK) // the cases below start from the talk as it was
    await sleep(100)
    pass('grid: a card whose line is stale is refused for ⌘X, ⌘C, ⌘V and the menu\'s Delete and Move slide to…; the talk is unchanged')
  }

  await cell('Slide 0.2').first().scrollIntoViewIfNeeded()
  await cell('Slide 0.2').first().click({ button: 'right' })
  await sleep(60)
  assert.deepEqual(await menuLabels(), ['Move slide to…', 'Cut slide [⌘X]', 'Copy slide [⌘C]', 'Paste slide after [⌘V]', 'Delete slide [⌘⇧⌫]', 'Explain rendering', 'More actions… [⌘K]'])
  assert.equal(await activeTitle(), 'Slide 0.2', 'a right-click selects the card')
  await shot('grid-cell-menu.png')
  await page.locator(`${MENU} [data-slide-row-action="explain"]`).click()
  assert.deepEqual(await page.evaluate(() => window.explained), ['Slide 0.2'], 'Explain rendering is still a row')
  await cell('Slide 0.2').first().click({ button: 'right' })
  await page.locator(`${MENU} [data-slide-row-action="more"]`).click()
  assert.deepEqual(await page.evaluate(() => window.more), ['Slide 0.2'])
  await cell('Section 1').first().scrollIntoViewIfNeeded()
  await cell('Section 1').first().click({ button: 'right' })
  await sleep(60)
  assert.deepEqual(await menuLabels(), ['Move section to…', 'Cut section [⌘X]', 'Copy section [⌘C]', 'Paste after section [⌘V]', 'Explain rendering', 'More actions… [⌘K]'], 'a section-title card: the section menu, as the section header has it (slide handling ticket 1a: no `###`-only refusal)')
  await key('Escape')
  const header = page.locator(`${GRID} [data-section-header]`).filter({ hasText: 'Section 5' })
  await header.scrollIntoViewIfNeeded()
  await header.click({ button: 'right' })
  await sleep(60)
  assert.deepEqual(await menuLabels(), ['Move section to…', 'Cut section [⌘X]', 'Copy section [⌘C]', 'Paste after section [⌘V]', 'Collapse'])
  await shot('grid-section-menu.png')
  await page.locator(`${MENU} [data-slide-row-action="collapse"]`).click()
  await sleep(60)
  assert.equal(await cell('Slide 5.5').count(), 0, 'Collapse from the header menu')
  await header.click({ button: 'right' })
  await page.locator(`${MENU} [data-slide-row-action="move"]`).click()
  await sleep(60)
  await page.locator(`${LIST} [data-move-option="end"]`).click()
  await sleep(150)
  assert.equal(await doc(), relocateBlockToEnd(TALK, lineOf(TALK, '## Section 5')), 'Move section to… End of talk, from the grid header')
  assert.equal(await lastToast(), 'Moved “Section 5” to the end of the talk.')
  await undo()
  await cell('Slide 0.2').first().scrollIntoViewIfNeeded()
  await cell('Slide 0.2').first().click({ button: 'right' })
  await page.locator(`${MENU} [data-slide-row-action="move"]`).click()
  await page.keyboard.type('section 8')
  await sleep(80)
  await key('Enter')
  await sleep(200)
  text = await doc()
  assert.equal(text, relocateBlockInto(TALK, lineOf(TALK, '### Slide 0.2'), lineOf(TALK, '## Section 8')))
  assert.equal(await lastToast(), 'Moved “Slide 0.2” to the end of “Section 8”.')
  assert.equal(await activeTitle(), 'Slide 0.2', 'the moved card is selected')
  assert.ok(await inView(`${GRID} [data-active="true"]`, GRID), 'and in view')
  assert.ok(await page.evaluate(() => document.activeElement?.classList.contains('grid-view')), 'the grid has the keyboard again')
  await undo()
  assert.equal(await doc(), TALK)
  pass('grid: the card menu keeps Explain rendering and adds More actions…; the section header has the section menu; Move … to… moves, selects and shows the card')

  // ═══ After a move, a cut and paste, or Move to…: one row is selected, and the "caret is here" marker is on it ═══
  // Fix round after preview.10: the marker stayed on a line number from before the move, which by
  // then was another row's, so two rows looked selected.
  const marks = () => page.evaluate((sel) => {
    const titles = (cls) => [...document.querySelectorAll(`${sel} .${cls}`)].map((r) => r.querySelector('.so-section-label, .so-slide-title')?.textContent ?? '?')
    const text = window.docText().split('\n')
    return { sel: titles('so-row--sel'), kbd: titles('so-row--kbd'), current: titles('so-row--current'), caret: text[window.caretLine() - 1] }
  }, ORG)
  const oneRow = async (title, what) => {
    const m = await marks()
    assert.deepEqual(m.sel, [title], `${what}: exactly one row is selected, the slide that was moved`)
    assert.deepEqual(m.kbd.filter((t) => t !== title), [], `${what}: no other row carries the keyboard highlight`)
    assert.deepEqual(m.current, [title], `${what}: the caret marker is on the same row`)
    assert.equal(m.caret, `### ${title}`, `${what}: and the editor's caret is on that slide's title`)
  }
  const moveByMenu = async (title, section) => {
    await row(title).first().scrollIntoViewIfNeeded()
    await row(title).first().click({ button: 'right' })
    await page.locator(`${MENU} [data-slide-row-action="move"]`).click()
    await page.keyboard.type(section.toLowerCase())
    await sleep(80)
    await key('Enter')
    await sleep(300)
  }
  // Slides are not all one length in a real talk: this one is longer than its neighbours, so a line
  // number from before the move does not happen to be a title line after it.
  const UNEVEN = TALK.replace('- point 3.5\n', '- point 3.5\n- second point\n- third point\n\n- fourth point\n')
  if (process.env.TW_OLD_MARKER_RULE === '1') {
    // The rule before the fix, kept runnable so the failure can be seen: `TW_OLD_MARKER_RULE=1` fails here.
    await page.evaluate((d) => { window.followCaret = 'old'; window.mountOutline(d) }, UNEVEN)
    await clickRow('Slide 3.5')
    await moveByMenu('Slide 3.5', 'Section 8')
    await oneRow('Slide 3.5', 'old rule, Move slide to…')
  }
  await page.evaluate((d) => { window.followCaret = 'new'; window.mountOutline(d) }, UNEVEN)
  await clickRow('Slide 3.5')
  await oneRow('Slide 3.5', 'a clicked row')
  await moveByMenu('Slide 3.5', 'Section 8')
  text = await doc()
  assert.equal(text, relocateBlockInto(UNEVEN, lineOf(UNEVEN, '### Slide 3.5'), lineOf(UNEVEN, '## Section 8')))
  await oneRow('Slide 3.5', 'Move slide to… the end of Section 8')
  // Cut and paste, by the keys, on rows chosen with the arrow keys as well as by a click.
  await clickRow('Slide 1.6')
  await key('Meta+x')
  await sleep(200)
  assert.deepEqual((await marks()).sel, [], 'after a cut no row is selected (the slide is gone)')
  assert.deepEqual((await marks()).kbd, [], 'and none is highlighted')
  await clickRow('Slide 7.2')
  await key('Meta+v')
  await sleep(300)
  await oneRow('Slide 1.6', 'cut, then pasted after Slide 7.2')
  // The keyboard highlight stays with its own row when the text above it changes from elsewhere.
  await clickRow('Slide 8.1')
  await page.locator(ORG).focus()
  await key('ArrowDown')
  await key('ArrowDown')
  const before = await marks()
  assert.equal(before.kbd.length, 1, 'the arrow keys highlight one row')
  assert.notEqual(before.kbd[0], 'Slide 8.1')
  await undo() // the paste is undone in the editor: every row below Slide 7.2 is on another line now
  await sleep(200)
  const after = await marks()
  assert.deepEqual(after.kbd, before.kbd, 'the highlight is on the row it was on, not on the row that took its line number')
  assert.deepEqual(after.sel, ['Slide 8.1'], 'and the selection is on its row')
  pass('outline: after Move slide to…, and after a cut and a paste, exactly one row is selected and the caret marker is on it; the keyboard highlight follows its row')

  // Ticket 2: the search box matches titles, slide text and picture text; non-matches dim in place (nothing is hidden).
  const search = page.locator(`${ORG} .so-search-input`)
  assert.equal(await search.getAttribute('placeholder'), 'Search titles, text and pictures…')
  const total = await page.locator(`${ORG} [data-line]`).count()
  await search.fill('point 4.4')
  await sleep(80)
  assert.equal(await page.locator(`${ORG} [data-line]`).count(), total, 'a search hides no row')
  assert.deepEqual(await page.locator(`${ORG} .so-slide:not(.so-row--dim) .so-slide-title`).allTextContents(), ['Slide 4.4'], 'a word of a slide body finds that slide')
  assert.match(await page.locator(`${ORG} .so-slide:not(.so-row--dim) [data-so-snippet]`).textContent(), /^in text: /)
  await search.fill('slide 4.4')
  await sleep(80)
  assert.deepEqual(await page.locator(`${ORG} .so-slide:not(.so-row--dim) .so-slide-title`).allTextContents(), ['Slide 4.4'])
  await search.fill('')
  pass('outline: the search box matches titles, text and pictures and dims the rest in place')

  assert.deepEqual(errors, [], 'no page errors')
  console.log(`slide move-to DOM: ${passed} checks passed`)
} finally {
  await browser?.close()
  rmSync(dir, { recursive: true, force: true })
}
