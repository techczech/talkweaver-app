// test:plain-view-editor — plain editing view ticket 01 (spec T1, T2).
//
// The real extensions, bundled for chrome-headless-shell, over a sample outline:
//   - viewMode 'markdown' (through the view compartment) renders exactly what the editor did before
//     the Plain view existed: the same line DOM (decorations and highlight classes) and the same
//     computed look, compared with an editor built from the old flat extension list, not a snapshot;
//   - viewMode 'plain' uses the sans, 16px, the heading sizes by depth, and keeps code in the code font;
//   - plain -> markdown -> plain leaves the document, selection and undo depth identical and does
//     not create a new view (same view object, same DOM node).
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('..', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'talk-weaver-plain-view-editor-'))
const outfile = join(dir, 'bundle.js')
const entry = `
import { EditorView, highlightActiveLine, keymap } from '@codemirror/view'
import { EditorState, EditorSelection, Compartment } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { history, undoDepth, historyKeymap } from '@codemirror/commands'
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { twTheme } from './src/renderer/src/extensions/editorLook.ts'
import { viewModeExtension } from './src/renderer/src/extensions/plainView/index.ts'
import { inlineMarkExtension } from './src/renderer/src/extensions/inlineMark.ts'
import { keyCapExtension } from './src/renderer/src/extensions/keyCap.ts'
import { tokenProtectExtension } from './src/renderer/src/extensions/idProtect.ts'
import { slideNumberGutterExtension, setSlideNumberLines } from './src/renderer/src/extensions/slideNumberGutter.ts'

const common = () => [slideNumberGutterExtension, tokenProtectExtension(), history(), highlightActiveLine(), markdown({ base: markdownLanguage, codeLanguages: languages }), inlineMarkExtension, keyCapExtension, keymap.of(historyKeymap)]
// Today's list, before the Plain view: highlight and theme as flat extensions.
window.mountOld = (doc, host) => {
  const view = new EditorView({ parent: host, state: EditorState.create({ doc, extensions: [syntaxHighlighting(defaultHighlightStyle), ...common(), twTheme] }) })
  return window.__old = view
}
const compartment = new Compartment()
window.mountNew = (doc, host, mode) => {
  const view = new EditorView({ parent: host, state: EditorState.create({ doc, extensions: [...common(), compartment.of(viewModeExtension(mode))] }) })
  return window.__new = view
}
window.numberBoth = (lines) => { setSlideNumberLines(window.__old, lines); setSlideNumberLines(window.__new, lines) }
window.setMode = (mode) => window.__new.dispatch({ effects: compartment.reconfigure(viewModeExtension(mode)) })
window.snapshot = (view) => {
  const content = view.contentDOM
  const pick = (el) => { const s = getComputedStyle(el); return [s.fontFamily, s.fontSize, s.lineHeight, s.color, s.backgroundColor, s.paddingLeft].join('|') }
  const lines = [...content.querySelectorAll('.cm-line')]
  return {
    html: content.innerHTML.replace(/class="[^"]*"/g, (m) => m),
    gutters: view.dom.querySelector('.cm-gutters')?.innerHTML ?? '',
    editor: pick(view.dom), content: pick(content), lines: lines.map(pick),
    classes: [...content.querySelectorAll('[class]')].map((e) => e.className).join('\\n')
  }
}
window.lineStyle = (view, n) => {
  const pos = view.state.doc.line(n).from
  const { node } = view.domAtPos(pos)
  const el = (node.nodeType === 1 ? node : node.parentElement).closest('.cm-line')
  const span = el.querySelector('span[class]') ?? el
  const s = getComputedStyle(el.querySelector('span[class]:not(.cm-key-cap):not(.cm-plain-hmark):not(.cm-plain-hmark *)') ?? el)
  const l = getComputedStyle(el)
  return { font: s.fontFamily, size: parseFloat(s.fontSize), weight: s.fontWeight, lineFont: l.fontFamily }
}
window.state = (view) => ({ doc: view.state.doc.toString(), sel: view.state.selection.ranges.map((r) => [r.anchor, r.head]), depth: undoDepth(view.state) })
`
await build({ stdin: { contents: entry, resolveDir: root, loader: 'js' }, bundle: true, format: 'iife', outfile, logLevel: 'silent' })

const doc = [
  '# Ten years of bike hire {id=talk}', '', '## The decade in numbers', '{id=decade}', '', '### Trips have grown {id=trips}', '{iconlist}', '{id=growth}', '',
  '#### A deeper heading', '', 'Steepest rises: *2018*, **2022**, and `code` with ==mark==.', '',
  'See [the data](https://example.org) and ~~old~~.', '', '> A quoted line.', '> — Anon, 2019', '',
  '- Bikes that are there', '- A safe lane', '', '```js', 'const a = 1', '```', ''
].join('\n')

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } })
  await page.setContent('<div id="a" style="width:800px;height:400px"></div><div id="b" style="width:800px;height:400px"></div>')
  await page.addScriptTag({ path: outfile })

  // (a) Markdown mode equals today's editor.
  await page.evaluate((d) => { window.mountOld(d, document.getElementById('a')); window.mountNew(d, document.getElementById('b'), 'markdown') }, doc)
  const [oldSnap, newSnap] = await page.evaluate(() => [window.snapshot(window.__old), window.snapshot(window.__new)])
  assert.ok(oldSnap.lines.length > 10, 'sample rendered')
  assert.equal(newSnap.html, oldSnap.html, 'Markdown mode: same line DOM (decorations and highlight classes) as the old editor')
  assert.deepEqual(newSnap.lines, oldSnap.lines, 'Markdown mode: same computed look per line')
  assert.equal(newSnap.editor, oldSnap.editor, 'Markdown mode: same editor look')
  assert.equal(newSnap.content, oldSnap.content, 'Markdown mode: same content look')
  assert.match(oldSnap.editor, /JetBrains Mono/)
  // The slide-number gutter, the chips and the layout lines are today's in Markdown mode.
  await page.evaluate(() => window.numberBoth([1, 3, 6, 11]))
  const [oldNum, newNum] = await page.evaluate(() => [window.snapshot(window.__old), window.snapshot(window.__new)])
  assert.equal(newNum.gutters, oldNum.gutters, 'Markdown mode: same gutters (slide numbers) as the old editor')
  assert.match(newNum.gutters, />3</, 'the slide-number gutter shows its numbers')
  assert.doesNotMatch(newNum.gutters, /cm-plain-margin/, 'Markdown mode has no margin gutter')
  assert.equal(newNum.html, oldNum.html, 'Markdown mode: same line DOM after the numbers arrive')
  for (const shown of ['{iconlist}', '{id=growth}', '{id=decade}', '{id=trips}', '{id=talk}']) assert.ok(newNum.html.includes(shown.replace('{', '{').replace('}', '}')) || newNum.html.includes(shown.slice(1, -1)), shown + ' is shown in Markdown mode')
  assert.match(newNum.html, /cm-trigger-chip/, 'Markdown mode shows the chips')

  // Plain look.
  await page.evaluate(() => window.setMode('plain'))
  const plainSnap = await page.evaluate(() => window.snapshot(window.__new))
  assert.notEqual(plainSnap.html, oldSnap.html, 'Plain differs from Markdown')
  assert.match(plainSnap.editor, /apple-system/)
  assert.match(plainSnap.editor, /\|16px\|/)
  const sizes = await page.evaluate(() => [1, 3, 6, 10].map((n) => window.lineStyle(window.__new, n)))
  for (const [i, want] of [33.6, 25.6, 20, 17.6].entries()) assert.ok(Math.abs(sizes[i].size - want) < 0.05, 'heading ' + (i + 1) + ' size ' + sizes[i].size + ' vs ' + want)
  assert.ok(Number(sizes[0].weight) >= 700 && Number(sizes[3].weight) === 600, 'weights ' + sizes.map((s) => s.weight))
  const code = await page.evaluate(() => { const v = window.__new; const lines = [...v.contentDOM.querySelectorAll('.cm-line')]; const fenced = lines.find((l) => l.textContent === 'const a = 1'); return { fenced: getComputedStyle(fenced).fontFamily, text: getComputedStyle(lines.find((l) => l.textContent.startsWith('Steepest'))).fontFamily } })
  assert.match(code.fenced, /JetBrains Mono/, 'fenced code keeps the code font')
  assert.match(code.text, /apple-system/, 'paragraph is sans')
  const inlineFont = await page.evaluate(() => {
    const line = [...window.__new.contentDOM.querySelectorAll('.cm-line')].find((l) => l.textContent.startsWith('Steepest'))
    const spans = [...line.querySelectorAll('span')].filter((s) => s.textContent === 'code')
    return spans.length ? getComputedStyle(spans[spans.length - 1]).fontFamily : null
  })
  assert.match(inlineFont ?? '', /JetBrains Mono/, 'inline code keeps the code font')

  // (b) Switching leaves document, selection and undo untouched; the view is not recreated.
  const result = await page.evaluate(() => {
    const v = window.__new
    window.setMode('markdown'); window.setMode('plain')
    const dom = v.dom
    v.dispatch({ changes: { from: 0, insert: 'X' }, selection: { anchor: 10, head: 14 }, userEvent: 'input.type' })
    const before = window.state(v)
    const out = []
    for (const m of ['markdown', 'plain', 'markdown', 'plain']) { window.setMode(m); out.push(window.state(v)) }
    return { before, out, sameView: window.__new === v && v.dom === dom && dom.isConnected && document.querySelectorAll('#b .cm-editor').length === 1 }
  })
  assert.ok(result.before.depth >= 1)
  for (const s of result.out) assert.deepEqual(s, result.before, 'document, selection and undo depth unchanged by a switch')
  assert.ok(result.sameView, 'the view and its DOM are the same objects')
  console.log('plain view editor: ok')
} finally {
  await browser.close()
  rmSync(dir, { recursive: true, force: true })
}
