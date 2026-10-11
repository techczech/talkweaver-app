// test:key-cap-editor — onboarding 0.38.1 ticket 05: key caps in the outline editor.
//
// The real keyCapExtension (with the markdown language, as components/Editor.tsx mounts it) is
// bundled for chrome-headless-shell (Playwright's headless Chromium) over a fixture outline:
//   - caret on another line: `<kbd>⌘⇧↓</kbd>` shows as one key cap with the text ⌘⇧↓;
//   - caret on the line (by keyboard or by a click on the cap): the source shows, no cap;
//   - a `<kbd>` in a code span, inside a fenced block, or with an attribute is never a cap;
//   - no cap on any line of a run (paragraph, quotation paragraph, list item) that carries link
//     syntax, as on the slide (review round 1); a list item next to a linked one keeps its cap;
//   - the face is a sans, not the editor's monospace: the caps O and 0 differ in width; 12px;
//   - the document never changes.
// SCREENSHOT=<path> saves a picture of the editor with the caret off the practice line.
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('..', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'talk-weaver-key-cap-editor-'))
const outfile = join(dir, 'bundle.js')
const entry = `
import { EditorView } from '@codemirror/view'
import { EditorState, EditorSelection } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { keyCapExtension } from './src/renderer/src/extensions/keyCap.ts'
window.mountEditor = (doc, caretLine) => {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(0),
    extensions: [markdown({ base: markdownLanguage }), keyCapExtension, EditorView.lineWrapping]
  })
  const view = new EditorView({ parent: document.getElementById('host'), state })
  window.__view = view
  window.caretTo(caretLine)
}
window.caretTo = (lineNumber) => {
  const view = window.__view
  const line = view.state.doc.line(lineNumber)
  view.dispatch({ selection: EditorSelection.cursor(line.from) })
}
window.lineView = (lineNumber) => {
  const view = window.__view
  const pos = view.state.doc.line(lineNumber).from
  const { node } = view.domAtPos(pos)
  const el = (node.nodeType === 1 ? node : node.parentElement).closest('.cm-line')
  return {
    text: el.textContent,
    caps: [...el.querySelectorAll('.cm-key-cap')].map((cap) => {
      const style = getComputedStyle(cap)
      const box = cap.getBoundingClientRect()
      return { text: cap.textContent, fontFamily: style.fontFamily, fontSize: parseFloat(style.fontSize), width: box.width, x: box.x + box.width / 2, y: box.y + box.height / 2 }
    })
  }
}
window.docText = () => window.__view.state.doc.toString()
window.caretLine = () => { const v = window.__view; return v.state.doc.lineAt(v.state.selection.main.head).number }
`
await build({
  stdin: { contents: entry, resolveDir: root, loader: 'js' },
  bundle: true,
  format: 'iife',
  outfile,
  logLevel: 'silent'
})

const doc = [
  '### Four stalls',
  '',
  '> **Try it: move a slide.** Put the caret on the heading above and press <kbd>⌘⇧↓</kbd>. The whole slide moves below **Opening hours**.',
  'Type `<kbd>K</kbd>` to get a key cap.',
  'Bad <kbd onclick=x>y</kbd> stays as typed.',
  '```',
  '<kbd>Z</kbd>',
  '```',
  'Keys <kbd>O</kbd> and <kbd>0</kbd>.',
  '',
  'See [the guide](https://e/**b**<kbd>a b</kbd>) and press <kbd>K</kbd>.',
  '',
  'Press <kbd>J</kbd> on this line,',
  'then read https://example.com on the next.',
  '',
  '- List item <kbd>L</kbd>',
  '- Other item [x](https://e)'
].join('\n')

let passed = 0
const check = (name, fn) => {
  fn()
  passed += 1
  console.log(`  ok  ${name}`)
}

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 500 } })
  await page.setContent(`<!doctype html><html><head><style>
    :root { --paper:#f7f3ea; --panel:#fffdf8; --line:#d9d0c1; --muted:#5d6875; }
    body { margin:0; background:var(--paper); }
    #host .cm-editor { font: 14px/1.7 'JetBrains Mono', 'SF Mono', Menlo, monospace; }
    #host .cm-content { font-family: 'JetBrains Mono', 'SF Mono', Menlo, monospace; }
  </style></head><body><div id="host"></div></body></html>`)
  await page.addScriptTag({ path: outfile })
  await page.evaluate((text) => window.mountEditor(text, 1), doc)

  const off = await page.evaluate(() => [3, 4, 5, 7, 9].map((n) => window.lineView(n)))
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT })
  check('caret off the line: the practice line shows one key cap, not its source', () => {
    assert.deepEqual(off[0].caps.map((cap) => cap.text), ['⌘⇧↓'])
    assert.ok(!off[0].text.includes('<kbd>'), off[0].text)
    assert.ok(off[0].text.includes('**Try it: move a slide.**'), 'the rest of the line is untouched')
  })
  check('a code span, an attribute and a fenced block never become a cap', () => {
    assert.equal(off[1].caps.length, 0)
    assert.ok(off[1].text.includes('`<kbd>K</kbd>`'))
    assert.equal(off[2].caps.length, 0)
    assert.ok(off[2].text.includes('<kbd onclick=x>y</kbd>'))
    assert.equal(off[3].caps.length, 0)
    assert.ok(off[3].text.includes('<kbd>Z</kbd>'))
  })
  const linked = await page.evaluate(() => [11, 13, 16].map((n) => window.lineView(n)))
  check('no cap on a run that carries link syntax; a separate list item keeps its cap', () => {
    assert.equal(linked[0].caps.length, 0, linked[0].text)
    assert.ok(linked[0].text.includes('<kbd>a b</kbd>') && linked[0].text.includes('<kbd>K</kbd>'))
    assert.equal(linked[1].caps.length, 0, 'the link on the next line of the same paragraph counts')
    assert.ok(linked[1].text.includes('<kbd>J</kbd>'))
    assert.deepEqual(linked[2].caps.map((cap) => cap.text), ['L'])
  })
  check('the key cap face is a sans at 12px with distinct O and 0', () => {
    const [capO, cap0] = off[4].caps
    assert.deepEqual([capO.text, cap0.text], ['O', '0'])
    assert.ok(!/mono|menlo|courier/i.test(capO.fontFamily), capO.fontFamily)
    assert.ok(capO.fontSize >= 12, `font size ${capO.fontSize}`)
    assert.ok(Math.abs(capO.width - cap0.width) >= 1, `O ${capO.width}px vs 0 ${cap0.width}px`)
  })

  await page.evaluate(() => window.caretTo(3))
  const on = await page.evaluate(() => [window.lineView(3), window.lineView(9)])
  check('caret on the line: the source shows and the cap goes', () => {
    assert.equal(on[0].caps.length, 0)
    assert.ok(on[0].text.includes('press <kbd>⌘⇧↓</kbd>.'), on[0].text)
    assert.equal(on[1].caps.length, 2, 'other lines keep their caps')
  })

  await page.evaluate(() => window.caretTo(1))
  const cap = (await page.evaluate(() => window.lineView(9))).caps[0]
  await page.mouse.click(cap.x, cap.y)
  const afterClick = await page.evaluate(() => ({ line: window.caretLine(), view: window.lineView(9) }))
  check('a click on a cap puts the caret on its line and shows the source', () => {
    assert.equal(afterClick.line, 9)
    assert.equal(afterClick.view.caps.length, 0)
    assert.ok(afterClick.view.text.includes('<kbd>O</kbd> and <kbd>0</kbd>'))
  })

  const finalDoc = await page.evaluate(() => window.docText())
  check('the document never changes', () => assert.equal(finalDoc, doc))
} finally {
  await browser.close()
  rmSync(dir, { recursive: true, force: true })
}
console.log(`test:key-cap-editor ${passed} passed`)
