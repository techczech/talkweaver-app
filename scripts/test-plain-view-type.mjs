// test:plain-view-type — the font and text size reach the Plain tab only (plain editing view, spec T13).
// The real extensions, bundled for chrome-headless-shell, with the compartments Editor.tsx uses:
//   - Markdown mode with a look set renders exactly what the old flat editor did (line DOM and look);
//   - Plain with Serif at 20 px: Charter stack, 20 px, headings scale (2.1em = 42 px), code stays in the code font;
//   - changing the look, and switching tab, keep the same view, document, selection and undo depth.
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('..', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'talk-weaver-plain-view-type-'))
const outfile = join(dir, 'bundle.js')
const entry = `
import { EditorView, keymap } from '@codemirror/view'
import { EditorState, Compartment } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { history, undoDepth, historyKeymap } from '@codemirror/commands'
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { twTheme } from './src/renderer/src/extensions/editorLook.ts'
import { viewModeExtension } from './src/renderer/src/extensions/plainView/index.ts'
import { plainTypeExtension } from './src/renderer/src/extensions/plainView/theme.ts'

const common = () => [history(), markdown({ base: markdownLanguage, codeLanguages: languages }), keymap.of(historyKeymap)]
window.mountOld = (doc, host) => window.__old = new EditorView({ parent: host, state: EditorState.create({ doc, extensions: [syntaxHighlighting(defaultHighlightStyle), ...common(), twTheme] }) })
const view = new Compartment(), type = new Compartment()
const typeFor = (mode, look) => mode === 'plain' ? plainTypeExtension(look) : []
window.mountNew = (doc, host, mode, look) => window.__new = new EditorView({ parent: host, state: EditorState.create({ doc, extensions: [...common(), view.of(viewModeExtension(mode)), type.of(typeFor(mode, look))] }) })
window.setLook = (look, mode) => window.__new.dispatch({ effects: type.reconfigure(typeFor(mode, look)) })
window.setMode = (mode, look) => window.__new.dispatch({ effects: [view.reconfigure(viewModeExtension(mode)), type.reconfigure(typeFor(mode, look))] })
window.snapshot = (v) => {
  const pick = (el) => { const s = getComputedStyle(el); return [s.fontFamily, s.fontSize, s.lineHeight, s.color, s.backgroundColor].join('|') }
  return { html: v.contentDOM.innerHTML, editor: pick(v.dom), content: pick(v.contentDOM), lines: [...v.contentDOM.querySelectorAll('.cm-line')].map(pick) }
}
window.style = (v, text) => {
  const line = [...v.contentDOM.querySelectorAll('.cm-line')].find((l) => l.textContent.includes(text))
  const inner = line.querySelector('span[class]:not(.cm-plain-hmark):not(.cm-plain-hmark *)') ?? line
  const s = getComputedStyle(inner), l = getComputedStyle(line)
  return { family: s.fontFamily, size: parseFloat(s.fontSize), lineFamily: l.fontFamily }
}
window.state = (v) => ({ doc: v.state.doc.toString(), sel: v.state.selection.ranges.map((r) => [r.anchor, r.head]), depth: undoDepth(v.state) })
`
await build({ stdin: { contents: entry, resolveDir: root, loader: 'js' }, bundle: true, format: 'iife', outfile, logLevel: 'silent' })

const doc = ['# Ten years of bike hire', '', '## The decade in numbers', '', 'Steepest rises: *2018*, **2022**, and `code`.', '', '```js', 'const a = 1', '```', ''].join('\n')
const SERIF20 = { font: 'serif', size: 20 }

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } })
  await page.setContent('<div id="a" style="width:800px;height:400px"></div><div id="b" style="width:800px;height:400px"></div>')
  await page.addScriptTag({ path: outfile })

  // Markdown tab with Serif 20 set: today's editor.
  await page.evaluate(([d, look]) => { window.mountOld(d, document.getElementById('a')); window.mountNew(d, document.getElementById('b'), 'markdown', look) }, [doc, SERIF20])
  const [o, n] = await page.evaluate(() => [window.snapshot(window.__old), window.snapshot(window.__new)])
  assert.equal(n.html, o.html, 'Markdown: same line DOM')
  assert.deepEqual(n.lines, o.lines, 'Markdown: same look per line')
  assert.equal(n.editor, o.editor)
  assert.equal(n.content, o.content)
  assert.match(n.editor, /JetBrains Mono/)
  assert.doesNotMatch(n.editor, /Charter/)

  // Plain: Sans default, then Serif 20.
  await page.evaluate(() => window.setMode('plain', { font: 'sans', size: 16 }))
  let s = await page.evaluate(() => ({ snap: window.snapshot(window.__new), h1: window.style(window.__new, 'Ten years') }))
  assert.match(s.snap.editor, /apple-system/); assert.match(s.snap.editor, /\|16px\|/)
  assert.ok(Math.abs(s.h1.size - 33.6) < 0.05, 'H1 at 16: ' + s.h1.size)

  const r = await page.evaluate((look) => {
    const v = window.__new
    v.dispatch({ changes: { from: v.state.doc.length, insert: 'X' }, selection: { anchor: 10, head: 14 }, userEvent: 'input.type' })
    const before = window.state(v), dom = v.dom
    window.setLook(look, 'plain')
    const after = window.state(v)
    return {
      before, after, same: window.__new === v && v.dom === dom && dom.isConnected,
      snap: window.snapshot(v), h1: window.style(v, 'Ten years'), h2: window.style(v, 'The decade'),
      body: window.style(v, 'Steepest'), fenced: getComputedStyle([...v.contentDOM.querySelectorAll('.cm-line')].find((l) => l.textContent === 'const a = 1')).fontFamily
    }
  }, SERIF20)
  assert.deepEqual(r.after, r.before, 'a look change keeps document, selection and undo depth')
  assert.ok(r.same, 'the view is not recreated')
  assert.match(r.snap.editor, /Charter/); assert.match(r.snap.editor, /\|20px\|/)
  assert.match(r.body.lineFamily, /Charter/, 'paragraph in Serif')
  assert.ok(Math.abs(r.h1.size - 42) < 0.05, 'H1 scales with the text size: ' + r.h1.size)
  assert.ok(Math.abs(r.h2.size - 32) < 0.05, 'H2 scales: ' + r.h2.size)
  assert.match(r.fenced, /JetBrains Mono/, 'fenced code stays in the code font')

  // Back to Markdown and Plain again: the look is held, Markdown is today's.
  const t = await page.evaluate((look) => {
    const v = window.__new
    window.setMode('markdown', look)
    const md = window.snapshot(v)
    window.setMode('plain', look)
    return { md, plain: window.snapshot(v), st: window.state(v) }
  }, SERIF20)
  assert.equal(t.md.editor, o.editor, 'Markdown tab unchanged after the look was set')
  assert.match(t.plain.editor, /Charter.*\|20px\|/)
  assert.deepEqual(t.st, r.before)
  console.log('plain view type: ok')
} finally {
  await browser.close()
  rmSync(dir, { recursive: true, force: true })
}
