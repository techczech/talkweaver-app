// test:plain-view-margin-menus — plain editing view ticket 04 (spec T8, T9): the margin's buttons.
//
// The real plainView extension, bundled for chrome-headless-shell, in Plain mode over a sample outline:
//   - the margin word (TALK / SECTION / SLIDE n) and, on slides, the layout name are buttons with
//     aria-haspopup="menu", a pointer cursor and a hover pill; Section and Talk have no layout button;
//   - a click raises onLevelMenu / onLayoutMenu with the clicked heading's line and a rectangle, moves
//     neither the caret nor the document; Enter and Space on a focused button do the same;
//   - the label of the heading holding the caret is dark and bold, others grey, and it follows the caret;
//   - Markdown mode has no margin buttons.
// (The menus themselves and what a choice writes are the workspace's: their pure halves are tested by
// test:plain-view-menu-verbs.)
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('..', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'talk-weaver-plain-view-menus-'))
const outfile = join(dir, 'bundle.js')
const entry = `
import { EditorView, keymap } from '@codemirror/view'
import { EditorState, EditorSelection, Compartment } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { defaultKeymap } from '@codemirror/commands'
import { viewModeExtension } from './src/renderer/src/extensions/plainView/index.ts'
import { setMarginLabels, caretHeadingTarget, focusHeading } from './src/renderer/src/extensions/plainView/margin.ts'
import { marginLabels } from './src/shared/plain-view-margin.ts'

const compartment = new Compartment()
window.calls = []
const handlers = {
  onLevelMenu: (line, rect) => window.calls.push({ menu: 'level', line, w: rect.width, h: rect.height }),
  onLayoutMenu: (line, rect) => window.calls.push({ menu: 'layout', line, w: rect.width, h: rect.height })
}
window.mount = (doc, mode) => {
  document.getElementById('host').innerHTML = ''
  window.calls.length = 0
  const view = new EditorView({ parent: document.getElementById('host'), state: EditorState.create({
    doc, selection: EditorSelection.cursor(0),
    extensions: [markdown({ base: markdownLanguage }), keymap.of(defaultKeymap), compartment.of(viewModeExtension(mode, handlers))]
  }) })
  view.focus()
  setMarginLabels(view, marginLabels(null, doc))
  return window.__v = view
}
window.caret = (pos) => window.__v.dispatch({ selection: EditorSelection.cursor(pos), userEvent: 'select' })
window.sel = () => window.__v.state.selection.main.head
window.docText = () => window.__v.state.doc.toString()
window.lineFrom = (n) => window.__v.state.doc.line(n).from
window.target = () => { const t = caretHeadingTarget(window.__v); return t && { line: t.line, hasRect: t.anchor.width > 0 } }
window.focusHeading = (n) => focusHeading(window.__v, n)
window.buttons = () => [...document.querySelectorAll('.cm-plain-margin [data-margin-kind]:not([data-margin-line="0"])')].map((e) => ({
  kind: e.dataset.marginKind, line: Number(e.dataset.marginLine),
  word: e.querySelector('button.cm-plain-margin-word')?.textContent ?? null,
  wordPopup: e.querySelector('button.cm-plain-margin-word')?.getAttribute('aria-haspopup') ?? null,
  layout: e.querySelector('button.cm-plain-margin-layout > span')?.textContent ?? null,
  layoutPopup: e.querySelector('button.cm-plain-margin-layout')?.getAttribute('aria-haspopup') ?? null,
  active: e.classList.contains('cm-plain-margin-active')
}))
window.wordColour = (line) => { const w = document.querySelector('[data-margin-line="' + line + '"] .cm-plain-margin-word'); const s = getComputedStyle(w); return { color: s.color, weight: s.fontWeight } }
`
await build({ stdin: { contents: entry, resolveDir: root, loader: 'js' }, bundle: true, format: 'iife', outfile, logLevel: 'silent' })

const doc = [
  '# Ten years of bike hire {id=talk}',  // 1
  '',                                    // 2
  '## Section A',                        // 3
  '',                                    // 4
  '### Slide one {id=s1}',               // 5
  '{iconlist}',                          // 6
  '{id=one}',                            // 7
  'First body line',                     // 8
  '',                                    // 9
  '### Slide two',                       // 10
  'Body two',                            // 11
  ''
].join('\n')

const browser = await chromium.launch()
const errors = []
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.setContent('<div id="host" style="width:900px;height:600px"></div>')
  await page.addScriptTag({ path: outfile })
  const ev = (fn, arg) => page.evaluate(fn, arg)
  const open = (mode = 'plain') => ev((m) => { window.mount(window.__doc, m) }, mode)
  await ev((d) => { window.__doc = d }, doc)
  await open()

  // Roles.
  const b = await ev(() => window.buttons())
  assert.deepEqual(b.map((x) => [x.kind, x.line, x.word]), [['talk', 1, 'Talk'], ['section', 3, 'Section 1'], ['slide', 5, 'Slide 1'], ['slide', 10, 'Slide 2']])
  for (const x of b) assert.equal(x.wordPopup, 'menu', x.word + ' word is a menu button')
  // Slide one writes {iconlist} over one paragraph and no list: the compiler draws a Statement, and
  // the margin names the layout the slide is drawn in (it said Icon list before, which it is not).
  assert.deepEqual(b.map((x) => x.layout), [null, null, 'Statement', 'Auto'], 'only slides have a layout button')
  assert.deepEqual(b.map((x) => x.layoutPopup), [null, null, 'menu', 'menu'])
  const look = await ev(() => { const w = document.querySelector('button.cm-plain-margin-word'); return { cursor: getComputedStyle(w).cursor, tab: w.tabIndex, type: w.type } })
  assert.equal(look.cursor, 'pointer')
  assert.equal(look.type, 'button')
  assert.ok(look.tab >= 0, 'focusable')

  // Hover pill.
  const before = await ev(() => getComputedStyle(document.querySelector('[data-margin-line="5"] .cm-plain-margin-layout')).backgroundColor)
  await page.hover('[data-margin-line="5"] .cm-plain-margin-layout')
  const after = await ev(() => getComputedStyle(document.querySelector('[data-margin-line="5"] .cm-plain-margin-layout')).backgroundColor)
  assert.notEqual(before, after, 'the layout name shows a pill on hover: ' + before + ' -> ' + after)
  await page.mouse.move(500, 400)

  // Click: callbacks with the clicked line; the caret and the text stay.
  const caretBefore = await ev(() => { window.caret(window.lineFrom(11)); return window.sel() })
  await page.click('[data-margin-line="5"] .cm-plain-margin-word')
  await page.click('[data-margin-line="5"] .cm-plain-margin-layout')
  await page.click('[data-margin-line="3"] .cm-plain-margin-word')
  const calls = await ev(() => window.calls)
  assert.deepEqual(calls.map((c) => [c.menu, c.line]), [['level', 5], ['layout', 5], ['level', 3]], 'each click raises its menu with the clicked heading line, not the caret slide')
  assert.ok(calls.every((c) => c.w > 0 && c.h > 0), 'with the button rectangle')
  assert.equal(await ev(() => window.sel()), caretBefore, 'a click moves no caret')
  assert.equal(await ev(() => window.docText()), doc, 'a click changes no text')

  // Keyboard: Enter and Space on a focused button.
  await ev(() => { window.calls.length = 0 })
  await page.focus('[data-margin-line="10"] .cm-plain-margin-word')
  await page.keyboard.press('Enter')
  await page.focus('[data-margin-line="10"] .cm-plain-margin-layout')
  await page.keyboard.press('Space')
  await page.focus('[data-margin-line="10"] .cm-plain-margin-layout')
  await page.keyboard.press('Enter')
  assert.deepEqual((await ev(() => window.calls)).map((c) => [c.menu, c.line]), [['level', 10], ['layout', 10], ['layout', 10]], 'Enter and Space open the menus')

  // Tab reaches the buttons from the editor.
  await ev(() => window.__v.focus())
  await page.keyboard.press('Shift+Tab')
  assert.equal(await ev(() => document.activeElement?.classList.contains('cm-plain-margin-word') || document.activeElement?.classList.contains('cm-plain-margin-layout')), true, 'the buttons are in the tab order')

  // Active slide label.
  await ev(() => window.caret(window.lineFrom(11)))
  let a = await ev(() => window.buttons())
  assert.deepEqual(a.filter((x) => x.active).map((x) => x.line), [10], 'the caret in slide two body: slide two is active')
  await ev(() => window.caret(window.lineFrom(8)))
  a = await ev(() => window.buttons())
  assert.deepEqual(a.filter((x) => x.active).map((x) => x.line), [5], 'the label follows the caret')
  const on = await ev(() => window.wordColour(5)), off = await ev(() => window.wordColour(10))
  assert.equal(on.color, 'rgb(11, 58, 115)', 'active label is dark blue')
  assert.ok(Number(on.weight) >= 700, 'and bold: ' + on.weight)
  assert.equal(off.color, 'rgb(138, 144, 153)', 'others stay grey')
  assert.ok(Number(off.weight) < Number(on.weight), 'and lighter')

  // Putting the caret on a heading: end of the visible text, before hidden tokens.
  await ev(() => window.focusHeading(5))
  assert.equal(await ev(() => window.sel()), (await ev(() => window.lineFrom(5))) + '### Slide one'.length, 'caret at the end of the heading text, before {id=s1}')
  assert.deepEqual(await ev(() => window.target()), { line: 5, hasRect: true }, 'the caret heading and a place to draw its menu')

  // Markdown: no buttons.
  await open('markdown')
  assert.equal(await ev(() => document.querySelectorAll('.cm-plain-margin, button.cm-plain-margin-word, button.cm-plain-margin-layout').length), 0, 'Markdown mode has no margin buttons')
  assert.deepEqual(errors, [])
  console.log('plain view margin menus: ok')
} finally {
  await browser.close()
  rmSync(dir, { recursive: true, force: true })
}
