// test:plain-view-conceal — plain editing view ticket 02 (spec T4, T4a, T4b).
//
// The real extensions, bundled for chrome-headless-shell, over a sample outline, in Plain mode:
//   - each element kind (bold, italic, strike, inline code, link, ==, ~~, ++, heading, quotation) shows
//     no marks while the caret is elsewhere and its marks while the caret is inside it;
//   - a selection spanning two elements reveals both; a selected search match reveals its element;
//   - the caret's heading shows faint, body-sized `#` marks; the other headings show none;
//   - quotation lines carry the quotation class, the final dash line the attribution class;
//   - fenced code is never concealed;
//   - typed Markdown (real key presses, one character at a time) and pasted Markdown format and
//     conceal; `## ` makes a heading; lists continue on Enter; nothing typed is rewritten;
//   - Markdown mode shows no concealment (the full text of every line is in the DOM).
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('..', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'talk-weaver-plain-view-conceal-'))
const outfile = join(dir, 'bundle.js')
const entry = `
import { EditorView, keymap } from '@codemirror/view'
import { EditorState, EditorSelection, Compartment } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { history, historyKeymap } from '@codemirror/commands'
import { languages } from '@codemirror/language-data'
import { search, setSearchQuery, SearchQuery, findNext } from '@codemirror/search'
import { viewModeExtension } from './src/renderer/src/extensions/plainView/index.ts'
import { inlineMarkExtension } from './src/renderer/src/extensions/inlineMark.ts'
import { keyCapExtension } from './src/renderer/src/extensions/keyCap.ts'

const compartment = new Compartment()
window.mount = (doc, mode) => {
  document.getElementById('host').innerHTML = ''
  const view = new EditorView({ parent: document.getElementById('host'), state: EditorState.create({
    doc, selection: EditorSelection.cursor(0),
    extensions: [history(), markdown({ base: markdownLanguage, codeLanguages: languages }), inlineMarkExtension, keyCapExtension, search(), keymap.of(historyKeymap), compartment.of(viewModeExtension(mode))]
  }) })
  return window.__v = view
}
window.setMode = (mode) => window.__v.dispatch({ effects: compartment.reconfigure(viewModeExtension(mode)) })
window.caret = (pos, head) => window.__v.dispatch({ selection: head === undefined ? EditorSelection.cursor(pos) : EditorSelection.single(pos, head) })
window.at = (needle, offset = 0) => window.__v.state.doc.toString().indexOf(needle) + offset
window.lineEl = (n) => {
  const v = window.__v
  const { node } = v.domAtPos(v.state.doc.line(n).from)
  return (node.nodeType === 1 ? node : node.parentElement).closest('.cm-line')
}
window.shown = (n) => window.lineEl(n).textContent
window.docText = () => window.__v.state.doc.toString()
window.selectMatch = (text) => {
  const v = window.__v
  v.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: text })), selection: EditorSelection.cursor(0) })
  findNext(v)
}
window.paste = (text) => {
  const dt = new DataTransfer(); dt.setData('text/plain', text)
  window.__v.contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
}
`
await build({ stdin: { contents: entry, resolveDir: root, loader: 'js' }, bundle: true, format: 'iife', outfile, logLevel: 'silent' })

const doc = [
  '# Ten years of bike hire',        // 1
  '',                                // 2
  '## The decade in numbers',        // 3
  '',                                // 4
  'Plain text with **bold** and *italic* and ~~gone~~ and `code` here.', // 5
  '',                                // 6
  'See [the council](https://example.org/open) for ==marked== and ++under++ words.', // 7
  '',                                // 8
  '> Cycling is the best way to see a city.', // 9
  '> You never have to park.',       // 10
  '> — Anon, 2019',                  // 11
  '',                                // 12
  '```js',                           // 13
  'const a = **b**',                 // 14
  '```',                             // 15
  '',                                // 16
  'Two: **one** then *two* end.',    // 17
  ''
].join('\n')

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } })
  await page.setContent('<div id="host" style="width:800px;height:700px"></div>')
  await page.addScriptTag({ path: outfile })
  const ev = (fn, arg) => page.evaluate(fn, arg)
  const open = (d, mode = 'plain') => ev(([d, m]) => { window.mount(d, m); }, [d, mode])
  const shown = (n) => ev((n) => window.shown(n), n)

  await open(doc)
  // Caret on line 1 (a heading, offset 0 is inside it); move away for the element tests.
  await ev(() => window.caret(window.at('Plain text', 3)))
  assert.equal(await shown(1), 'Ten years of bike hire', 'heading 1: no marks off the caret')
  assert.equal(await shown(3), 'The decade in numbers', 'heading 2: no marks off the caret')
  assert.equal(await shown(5), 'Plain text with bold and italic and gone and code here.', 'bold, italic, strike, code: no marks off the caret')
  assert.equal(await shown(7), 'See the council for marked and under words.', 'link brackets and address, ==, ++: concealed')
  assert.equal(await shown(9), 'Cycling is the best way to see a city.', 'quotation: > concealed')
  assert.equal(await shown(11), '— Anon, 2019', 'attribution line: > concealed, dash kept')
  assert.equal(await shown(14), 'const a = **b**', 'fenced code is never concealed')
  assert.equal(await ev(() => window.docText()), doc, 'concealment never changes the document')

  // Caret inside each element reveals that element only.
  const reveal = async (needle, offset, line, want, label) => {
    await ev(([n, o]) => window.caret(window.at(n, o)), [needle, offset])
    assert.equal(await shown(line), want, label)
  }
  const L5 = 'Plain text with **bold** and italic and gone and code here.'
  await reveal('bold', 2, 5, 'Plain text with **bold** and italic and gone and code here.', 'caret in bold: its ** show, others stay concealed')
  await reveal('italic', 2, 5, 'Plain text with bold and *italic* and gone and code here.', 'caret in italic')
  await reveal('gone', 1, 5, 'Plain text with bold and italic and ~~gone~~ and code here.', 'caret in strike')
  await reveal('code` here', 2, 5, 'Plain text with bold and italic and gone and `code` here.', 'caret in inline code')
  await reveal('the council', 3, 7, 'See [the council](https://example.org/open) for marked and under words.', 'caret in link text: full [text](address); == and ++ stay concealed')
  await reveal('https', 3, 7, 'See [the council](https://example.org/open) for marked and under words.', 'caret in the address reveals the link')
  await reveal('marked', 2, 7, 'See the council for ==marked== and under words.', 'caret in ==mark==')
  await reveal('under++', 2, 7, 'See the council for marked and ++under++ words.', 'caret in ++underline++')
  await reveal('Cycling', 3, 9, '> Cycling is the best way to see a city.', 'caret in a quotation reveals its > marks')
  assert.equal(await shown(10), '> You never have to park.', 'the whole quotation reveals, line 2')
  assert.equal(await shown(11), '> — Anon, 2019', 'the whole quotation reveals, attribution line')
  await reveal('decade', 2, 3, '## The decade in numbers', 'caret in a heading shows its ## marks')
  assert.equal(await shown(1), 'Ten years of bike hire', 'other headings stay without marks')
  assert.equal(await shown(5), 'Plain text with bold and italic and gone and code here.', 'other lines stay concealed')
  assert.ok(L5.length > 0)

  // Caret on the boundary of an element counts as inside; one character outside does not.
  await ev(() => window.caret(window.at('**bold**')))
  assert.match(await shown(5), /\*\*bold\*\*/, 'caret at the opening mark: revealed')
  await ev(() => window.caret(window.at('**bold**', 8)))
  assert.match(await shown(5), /\*\*bold\*\*/, 'caret after the closing mark: revealed')
  await ev(() => window.caret(window.at('**bold**', 9)))
  assert.doesNotMatch(await shown(5), /\*\*/, 'caret one space after: concealed')

  // A selection spanning two elements reveals both.
  await ev(() => window.caret(window.at('bold', 1), window.at('italic', 3)))
  assert.equal(await shown(5), 'Plain text with **bold** and *italic* and gone and code here.', 'selection across bold and italic reveals both, not strike or code')
  await ev(() => window.caret(window.at('**one**', 3), window.at('*two*', 2)))
  assert.equal(await shown(17), 'Two: **one** then *two* end.', 'selection across two elements on a line')
  // Per element, not per line: bold revealed, the italic beside it is not.
  await ev(() => window.caret(window.at('**one**', 3)))
  assert.equal(await shown(17), 'Two: **one** then two end.', 'reveal is per element, not per line')

  // Search: the selected match reveals the element it is in, and only while selected.
  await ev(() => window.selectMatch('example.org'))
  assert.equal(await shown(7), 'See [the council](https://example.org/open) for marked and under words.', 'a match inside a concealed address reveals the link')
  await ev(() => window.selectMatch('**'.slice(0, 0) + 'italic'))
  assert.match(await shown(5), /\*italic\*/, 'a match inside italic reveals its marks')
  await ev(() => window.caret(window.at('Plain text', 2)))
  assert.doesNotMatch(await shown(5), /\*/, 'moving away conceals again')

  // Headings: the caret's heading shows faint marks at body size; the others show none.
  await ev(() => window.caret(window.at('decade', 2)))
  const hm = await ev(() => {
    const el = [...window.lineEl(3).querySelectorAll('.cm-plain-hmark *')].find((x) => x.textContent === '#' || x.textContent === '##') ?? window.lineEl(3).querySelector('.cm-plain-hmark')
    const body = getComputedStyle(window.lineEl(5))
    const s = getComputedStyle(el)
    return { text: el.textContent, size: parseFloat(s.fontSize), body: parseFloat(body.fontSize), color: s.color, weight: s.fontWeight, count: document.querySelectorAll('.cm-plain-hmark').length }
  })
  assert.equal(hm.text.trim(), '##', 'faint marks are the heading marks')
  assert.ok(hm.size <= hm.body + 0.01 && hm.size >= hm.body * 0.7 && hm.text === '##', 'mark size ' + hm.size + ' is at most body size ' + hm.body)
  assert.equal(hm.color, 'rgb(138, 144, 153)', 'grey')
  assert.equal(hm.count, 1, 'only the caret heading shows marks')
  await ev(() => window.caret(window.at('Ten years', 2)))
  const h1 = await ev(() => { const s = getComputedStyle([...window.lineEl(1).querySelectorAll('.cm-plain-hmark *')].find((x) => x.textContent === '#')); return parseFloat(s.fontSize) })
  assert.ok(h1 <= hm.body + 0.01, 'a # mark is not at heading size: ' + h1)

  // Quotations and attribution.
  const q = await ev(() => {
    const cls = (n) => window.lineEl(n).className
    const cs = (n) => getComputedStyle(window.lineEl(n))
    return { c9: cls(9), c10: cls(10), c11: cls(11), c5: cls(5), b9: cs(9).borderLeftWidth, i9: cs(9).fontStyle, i11: cs(11).fontStyle, s9: parseFloat(cs(9).fontSize), s11: parseFloat(cs(11).fontSize), col9: cs(9).color, col11: cs(11).color }
  })
  assert.match(q.c9, /cm-plain-quote/); assert.match(q.c10, /cm-plain-quote/); assert.match(q.c11, /cm-plain-quote-cite/)
  assert.doesNotMatch(q.c10, /cite/, 'only the final dash line is attribution'); assert.doesNotMatch(q.c5, /quote/)
  assert.equal(q.b9, '3px', 'left rule'); assert.equal(q.i9, 'italic', 'quotation text style'); assert.equal(q.i11, 'normal', 'attribution: no italics')
  assert.ok(q.s11 < q.s9, 'attribution smaller'); assert.notEqual(q.col9, q.col11, 'attribution greyer')

  // Links: underlined, in the link colour, when concealed.
  await ev(() => window.caret(window.at('Plain text', 3)))
  const link = await ev(() => { const s = getComputedStyle(window.lineEl(7).querySelector('.cm-plain-link')); return { deco: s.textDecorationLine, color: s.color, text: window.lineEl(7).querySelector('.cm-plain-link').textContent } })
  assert.equal(link.text, 'the council'); assert.equal(link.deco, 'underline'); assert.equal(link.color, 'rgb(26, 95, 180)')

  // Typed Markdown, one key press at a time, then the caret leaves.
  const typeAtEnd = async (text) => {
    await ev(() => { window.__v.focus(); const e = window.__v.state.doc.length; window.caret(e) })
    await page.keyboard.type(text, { delay: 5 })
  }
  const leave = () => ev(() => window.caret(0))
  const typedCases = [
    ['**word**', 'word', 'font-weight'], ['*word*', 'word', 'font-style'], ['==word==', 'word', null], ['[text](https://example.org)', 'text', 'link']
  ]
  for (const [typed, visible, prop] of typedCases) {
    await open('# T\n\n')
    await typeAtEnd('before ' + typed + ' after')
    assert.equal(await ev(() => window.docText()), '# T\n\nbefore ' + typed + ' after', 'nothing typed is escaped or rewritten: ' + typed)
    await leave()
    assert.equal(await shown(3), 'before ' + visible + ' after', 'typed ' + typed + ': marks concealed once the caret leaves')
    if (prop === 'font-weight') assert.ok(await ev(() => [...window.lineEl(3).querySelectorAll('span')].some((s) => s.textContent === 'word' && Number(getComputedStyle(s).fontWeight) >= 700)), 'typed bold is bold')
    if (prop === 'font-style') assert.ok(await ev(() => [...window.lineEl(3).querySelectorAll('span')].some((s) => s.textContent === 'word' && getComputedStyle(s).fontStyle === 'italic')), 'typed italic is italic')
    if (prop === 'link') assert.equal(await ev(() => window.lineEl(3).querySelector('.cm-plain-link')?.textContent), 'text', 'typed link is a link')
  }
  // While typing, the element shows its marks (the caret is inside it).
  await open('# T\n\n')
  await typeAtEnd('x **wo')
  assert.equal(await shown(3), 'x **wo', 'half-typed bold shows as typed')
  await page.keyboard.type('rd**')
  assert.equal(await shown(3), 'x **word**', 'caret at the closing mark: still shown')
  await page.keyboard.type(' y')
  assert.equal(await shown(3), 'x word y', 'caret past the closing mark: concealed')

  // A typed heading.
  await open('# T\n\n')
  await typeAtEnd('## Typed heading')
  assert.equal(await shown(3), '## Typed heading', 'caret on the heading: marks shown')
  await leave()
  assert.equal(await shown(3), 'Typed heading', 'caret away: no marks')
  const size = await ev(() => parseFloat(getComputedStyle([...window.lineEl(3).querySelectorAll('span')].find((x) => x.textContent) ?? window.lineEl(3)).fontSize))
  assert.ok(size > 20, 'typed ## makes a heading at heading size, got ' + size)

  // Lists and continuation on Enter; quotations.
  await open('# T\n\n')
  await typeAtEnd('- one')
  await page.keyboard.press('Enter'); await page.keyboard.type('two')
  assert.equal(await ev(() => window.docText()), '# T\n\n- one\n- two', 'bullet list continues on Enter')
  await page.keyboard.press('Enter'); await page.keyboard.press('Enter'); await page.keyboard.press('Enter')
  await page.keyboard.type('1. a'); await page.keyboard.press('Enter'); await page.keyboard.type('b')
  assert.match(await ev(() => window.docText()), /1\. a\n2\. b$/, 'numbered list continues on Enter')
  await open('# T\n\n')
  await typeAtEnd('> a quoted line')
  await leave()
  assert.equal(await shown(3), 'a quoted line', 'typed > makes a quotation, mark concealed')
  assert.match(await ev(() => window.lineEl(3).className), /cm-plain-quote/)

  // Pasted Markdown formats the same way.
  await open('# T\n\n')
  await ev(() => { window.__v.focus(); window.caret(window.__v.state.doc.length) })
  await ev(() => window.__v.dispatch({ changes: { from: window.__v.state.doc.length, insert: 'A **b** and [c](https://d.example) and\n> q' }, userEvent: 'input.paste' }))
  await leave()
  assert.equal(await shown(3), 'A b and c and', 'pasted fragment: marks concealed')
  assert.equal(await shown(4), 'q', 'pasted quotation')

  // Markdown mode: no concealment anywhere.
  await open(doc, 'markdown')
  await ev(() => window.caret(0))
  for (const [n, text] of [[5, 'Plain text with **bold** and *italic* and ~~gone~~ and `code` here.'], [7, 'See [the council](https://example.org/open) for ==marked== and ++under++ words.'], [9, '> Cycling is the best way to see a city.'], [3, '## The decade in numbers']]) {
    assert.equal(await shown(n), text, 'Markdown mode line ' + n + ' shows every mark')
  }
  assert.equal(await ev(() => document.querySelectorAll('.cm-plain-quote, .cm-plain-hmark, .cm-plain-link').length), 0, 'Markdown mode: none of the Plain classes')
  // Switching to Plain conceals; back to Markdown reveals again, with the caret unmoved.
  await ev(() => window.setMode('plain'))
  assert.equal(await shown(5), 'Plain text with bold and italic and gone and code here.')
  await ev(() => window.setMode('markdown'))
  assert.equal(await shown(5), 'Plain text with **bold** and *italic* and ~~gone~~ and `code` here.')

  console.log('plain view conceal: ok')
} finally {
  await browser.close()
  rmSync(dir, { recursive: true, force: true })
}
