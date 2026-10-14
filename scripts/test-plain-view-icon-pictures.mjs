// test:plain-view-icon-pictures — plain editing view ticket 05 (spec T10).
//
// The real extensions, bundled for chrome-headless-shell, with a stubbed icon source, in Plain mode:
//   - a list item ending in {icon=key} shows the picture at its start where the bullet was, the token
//     hidden; an item with no icon keeps its bullet; an ordered item keeps its number, then the picture;
//   - the token shows as a chip while the caret is in [end of text, end of line], hides when it leaves;
//   - an unknown key: no picture, bullet stays, warning chip; no source at all: chips;
//   - a late answer repaints without typing; each key is asked once;
//   - editing: typing at the end lands before the token; Backspace deletes text; a click past the text
//     rests before the token; select-and-delete takes the token; Enter starts a new item without an icon
//     (also through the app's own list continuation); cut and paste carry the token;
//   - a long item wraps under its text, not under the picture;
//   - a NESTED item (indented) gets no picture and keeps its bullet; its token shows as the ordinary chip, and no icon is fetched for it;
//   - Markdown mode shows the raw token and no pictures;
//   - ticket 07: a heading's `{icon=…}` shows as its picture before the title and a paragraph's
//     trailing `{icon=…}` as its picture at the start of the paragraph, with the same reveal, caret,
//     Enter and unknown-key rules; `{title-icon=above}` is hidden like any heading option.
//   - ticket 07, fix round 2 (as changed in the seventh): Enter at the visible end of a heading, a
//     paragraph or a list item with hidden tokens is the Enter from the line's end, made as ONE
//     transaction (no caret move of its own before it, which Undo would come back to); a remote
//     transaction, an unannotated one, a formatting change and a paste produce exactly the document
//     asked for with annotations and effects intact; every icon group of a heading is hidden and a
//     quoted value that contains `icon=` is not an icon.
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('..', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'talk-weaver-plain-view-icons-'))
const outfile = join(dir, 'bundle.js')
const entry = `
import { EditorView, keymap } from '@codemirror/view'
import { EditorState, EditorSelection, Compartment, Prec, Transaction, StateEffect } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands'
import { languages } from '@codemirror/language-data'
import { search, setSearchQuery, SearchQuery, findNext } from '@codemirror/search'
import { viewModeExtension } from './src/renderer/src/extensions/plainView/index.ts'
import { clearIconCache } from './src/renderer/src/extensions/plainView/iconPictures.ts'
import { appEnterBindings, appKeyState, failOnCaughtExceptions } from './scripts/lib/plain-view-test-mount.mjs'
import { tokenProtectExtension } from './src/renderer/src/extensions/idProtect.ts'

const compartment = new Compartment()
const svgFor = (k) => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" data-k="' + k + '"><circle cx="12" cy="12" r="10"/></svg>'
window.calls = []
window.log = []
const testMark = StateEffect.define()
// Dispatch a transaction as other code would: { changes, remote, event, mark, selection }.
window.send = (spec) => { window.log.length = 0; window.__v.dispatch({
  changes: spec.changes,
  ...(spec.selection !== undefined ? { selection: EditorSelection.cursor(spec.selection) } : {}),
  ...(spec.remote ? { annotations: Transaction.remote.of(true) } : {}),
  ...(spec.event ? { userEvent: spec.event } : {}),
  ...(spec.mark ? { effects: testMark.of(spec.mark) } : {})
}); return window.log.slice() }
window.chips = (n) => [...window.lineEl(n).querySelectorAll('.cm-plain-icon-chip')].map((c) => c.textContent)
let gate = null
window.release = () => gate && gate()
const source = (key) => {
  window.calls.push(key)
  if (key === 'lucide:nope' || key === 'svgl:nope' || key === 'tabler:nope') return Promise.resolve(null)
  if (key === 'lucide:late') return new Promise((res) => { gate = () => res(svgFor(key)) })
  if (key.startsWith('lucide:') || key === 'svgl:brandy') return Promise.resolve(svgFor(key))
  return Promise.resolve(null)
}
const options = (withSource) => withSource ? { iconSvg: source } : {}
window.mount = (doc, mode, withSource = true, outliner = true) => {
  clearIconCache(); window.calls.length = 0
  document.getElementById('host').innerHTML = ''
  const view = new EditorView({ parent: document.getElementById('host'), state: EditorState.create({
    doc, selection: EditorSelection.cursor(0),
    extensions: [EditorView.lineWrapping, history(), markdown({ base: markdownLanguage, codeLanguages: languages }), tokenProtectExtension(), appKeyState(), search(), keymap.of(historyKeymap),
      // The app's own Enter chain (keymap/registry.ts), with the state it reads. outliner = false leaves them out, to show
      // that Plain's own Enter rule (Enter as if from the line's end) holds without them too.
      ...(outliner ? [Prec.highest(keymap.of(appEnterBindings()))] : []),
      keymap.of(defaultKeymap), compartment.of(viewModeExtension(mode, options(withSource))), failOnCaughtExceptions(),
      EditorView.updateListener.of((u) => { for (const tr of u.transactions) window.log.push({
        doc: tr.docChanged, remote: tr.annotation(Transaction.remote) === true, event: tr.annotation(Transaction.userEvent) ?? null,
        marks: tr.effects.filter((e) => e.is(testMark)).map((e) => e.value), head: tr.newSelection.main.head
      }) })]
  }) })
  return window.__v = view
}
window.setMode = (mode) => window.__v.dispatch({ effects: compartment.reconfigure(viewModeExtension(mode, options(true))) })
window.caret = (pos, head, event) => window.__v.dispatch({ selection: head === undefined ? EditorSelection.cursor(pos) : EditorSelection.single(pos, head), ...(event ? { userEvent: event } : {}) })
window.at = (needle, offset = 0) => window.__v.state.doc.toString().indexOf(needle) + offset
window.head = () => window.__v.state.selection.main.head
window.lineEl = (n) => {
  const v = window.__v
  const { node } = v.domAtPos(v.state.doc.line(n).from)
  return (node.nodeType === 1 ? node : node.parentElement).closest('.cm-line')
}
window.shown = (n) => window.lineEl(n).textContent
window.docText = () => window.__v.state.doc.toString()
window.pic = (n) => window.lineEl(n).querySelector('.cm-plain-icon-picture svg') ? window.lineEl(n).querySelector('.cm-plain-icon-picture svg').getAttribute('data-k') : null
window.chip = (n) => { const c = window.lineEl(n).querySelector('.cm-plain-icon-chip'); return c ? { text: c.textContent, warn: c.classList.contains('cm-plain-icon-chip-warn') } : null }
window.bullets = (n) => window.lineEl(n).querySelectorAll('.cm-plain-bullet').length
window.clipboard = (type, text) => {
  const dt = new DataTransfer(); if (text !== undefined) dt.setData('text/plain', text)
  window.__v.contentDOM.dispatchEvent(new ClipboardEvent(type, { clipboardData: dt, bubbles: true, cancelable: true }))
  return dt.getData('text/plain')
}
`
await build({ stdin: { contents: entry, resolveDir: root, loader: 'ts' }, bundle: true, format: 'iife', outfile, logLevel: 'silent' })

const doc = [
  '# Riders',                                   // 1
  '',                                           // 2
  '- Bikes that are there {icon=lucide:bike}',  // 3
  '- Plain item with no icon',                  // 4
  '1. First ordered {icon=lucide:zap}',         // 5
  '- Unknown thing {icon=lucide:nope}',         // 6
  '- Late arrival {icon=lucide:late}',          // 7
  '- Shorthand {lucide:bike}',                  // 8
  '- Unprefixed {icon=zap}',                    // 9
  '',                                           // 10
  '## Heading {icon=lucide:bike}',              // 11
  'A paragraph {icon=lucide:bike}',             // 12
  '',
  '```',
  '- in a fence {icon=lucide:bike}',            // 15
  '```',
  ''
].join('\n')

const browser = await chromium.launch()
const errors = []
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } })
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.setContent('<div id="host" style="width:800px;height:700px"></div>')
  await page.addScriptTag({ path: outfile })
  const ev = (fn, arg) => page.evaluate(fn, arg)
  const open = (d, mode = 'plain', src = true, outliner = true) => ev(([d, m, s, o]) => { window.mount(d, m, s, o) }, [d, mode, src, outliner])
  const shown = (n) => ev((n) => window.shown(n), n)
  const pic = (n) => ev((n) => window.pic(n), n)
  const chip = (n) => ev((n) => window.chip(n), n)
  const text = () => ev(() => window.docText())
  const caretAt = (needle, offset = 0) => ev(([n, o]) => window.caret(window.at(n, o)), [needle, offset])
  const focus = () => ev(() => window.__v.focus())
  const settle = async () => { await page.waitForFunction(() => window.pic(3) !== null); await page.waitForTimeout(30) }

  await open(doc)
  await settle()
  await caretAt('# Riders', 3)

  // Placement.
  assert.equal(await pic(3), 'lucide:bike', 'picture on the first item')
  assert.equal(await shown(3), 'Bikes that are there', 'token hidden, no bullet character, text kept')
  assert.equal(await ev(() => window.bullets(3)), 0, 'no bullet where a picture is drawn')
  assert.equal(await ev(() => window.bullets(4)), 1, 'an item with no icon keeps its bullet')
  assert.equal(await shown(4), '• Plain item with no icon')
  assert.equal(await pic(4), null)
  assert.equal(await pic(5), 'lucide:zap', 'ordered item: picture')
  assert.equal(await shown(5), '1.First ordered', 'ordered item keeps its number, then the picture, then the text')
  assert.equal(await pic(8), 'lucide:bike', 'bare prefixed shorthand {lucide:bike}')
  assert.equal(await pic(9), 'lucide:zap', 'an unprefixed {icon=zap} resolves as the compiler does (Lucide first)')
  assert.equal(await text(), doc, 'drawing pictures never changes the document')
  const geo = await ev(() => {
    const el = window.lineEl(3), p = el.querySelector('.cm-plain-icon-picture'), s = getComputedStyle(p)
    const fs = parseFloat(getComputedStyle(el).fontSize)
    const r = p.getBoundingClientRect(), l = el.getBoundingClientRect()
    return { color: s.color, size: r.height / fs, w: r.width / fs, left: r.left - l.left }
  })
  assert.equal(geo.color, 'rgb(26, 95, 180)', 'accent blue of the margin layout name')
  assert.ok(Math.abs(geo.size - 1.15) < 0.02, 'about 1.15em: ' + geo.size)
  // Text of an iconed item starts at one fixed distance from the line start; wrap lines align to it.
  assert.equal(await ev(() => window.bullets(8)), 0)

  // Slide 7 of the drawing: nothing at the end of the line off the caret.
  assert.equal(await chip(3), null, 'no chip while the caret is elsewhere')

  // Reveal range: end of text and end of line (both), not one character before.
  const tokenStart = await ev(() => window.at('Bikes that are there') + 'Bikes that are there'.length)
  await ev((p) => window.caret(p), tokenStart)
  assert.deepEqual(await chip(3), { text: '{icon=lucide:bike}', warn: false }, 'caret at the end of the text: chip')
  assert.equal(await pic(3), 'lucide:bike', 'the picture stays while the chip shows')
  assert.equal(await shown(3), 'Bikes that are there {icon=lucide:bike}')
  await ev((p) => window.caret(p - 1), tokenStart)
  assert.equal(await chip(3), null, 'one character before the end: hidden again')
  await ev(() => window.caret(window.__v.state.doc.line(3).to, undefined, 'select'))
  // (settled before the token, still revealed)
  assert.equal(await ev(() => window.head()), tokenStart, 'a caret put at the line end rests before the token')
  assert.ok(await chip(3), 'and the chip shows')
  // Moving away hides it.
  await caretAt('Plain item', 2)
  assert.equal(await chip(3), null, 'moving away hides the chip')

  // Typing at the end of the text lands before the token.
  await focus()
  await ev((p) => window.caret(p), tokenStart)
  await page.keyboard.type('XY')
  assert.equal(await ev(() => window.__v.state.doc.line(3).text), '- Bikes that are thereXY {icon=lucide:bike}', 'typed text lands before the token')
  assert.equal(await ev(() => window.head()), tokenStart + 2)
  await page.keyboard.type(' more')
  assert.equal(await ev(() => window.__v.state.doc.line(3).text), '- Bikes that are thereXY more {icon=lucide:bike}')
  // Backspace at the end of the text deletes text, not the token.
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Backspace')
  assert.equal(await ev(() => window.__v.state.doc.line(3).text), '- Bikes that are thereXY {icon=lucide:bike}', 'Backspace deletes text before the token')
  await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace')
  assert.equal(await ev(() => window.__v.state.doc.line(3).text), '- Bikes that are there {icon=lucide:bike}')
  // Arrow right walks into the revealed token (so it can be edited), Backspace there edits it.
  await page.keyboard.press('ArrowRight')
  assert.equal(await ev(() => window.head()), tokenStart + 1, 'ArrowRight steps into the chip')
  assert.ok(await chip(3), 'the chip stays while the caret is inside it')
  await page.keyboard.press('End')
  // (Fifth fix round of ticket 07: End on such a line always goes to the end of the visible text,
  // as on a title, so typing after End lands before the token.)
  assert.equal(await ev(() => window.head()), tokenStart, 'End from inside the revealed token goes to the end of the item\'s text')
  assert.ok(await chip(3), 'the chip is still showing')
  await ev((p) => window.caret(p), tokenStart)
  await page.keyboard.press('End')
  await ev((p) => window.caret(p), tokenStart)
  // Select the whole line and delete: the token goes too.
  await ev(() => { const l = window.__v.state.doc.line(3); window.caret(l.from, l.to) })
  assert.ok(await chip(3), 'a selection over the line reveals the token')
  await page.keyboard.press('Backspace')
  assert.equal(await ev(() => window.__v.state.doc.line(3).text), '', 'select the line and delete: text and token')
  await page.keyboard.press('ControlOrMeta+z')
  assert.equal(await text(), doc, 'undo restores it')

  // Enter at the end of an item with an icon: a new item with no icon, the token stays.
  for (const outliner of [false, true]) {
    await open(doc, 'plain', true, outliner)
    await page.waitForFunction(() => window.pic(3) !== null)
    await focus()
    const end = await ev(() => window.at('Bikes that are there') + 'Bikes that are there'.length)
    await ev((p) => window.caret(p), end)
    await page.keyboard.press('Enter')
    const lines = await ev(() => [3, 4, 5].map((n) => window.__v.state.doc.line(n).text))
    assert.deepEqual(lines, ['- Bikes that are there {icon=lucide:bike}', '- ', '- Plain item with no icon'], 'Enter at the end: new empty item, token stays (outliner ' + outliner + ')')
    assert.equal(await ev(() => window.head()), await ev(() => window.__v.state.doc.line(4).to), 'caret in the new item')
    assert.equal(await pic(3), 'lucide:bike')
    // Ordered, and Enter at the end of the line itself (caret inside the chip).
    const o = await ev(() => window.__v.state.doc.line(6).to)
    await ev((p) => window.caret(p), o - 1)
    await page.keyboard.press('Enter')
    assert.equal(await ev(() => window.__v.state.doc.line(6).text), '1. First ordered {icon=lucide:zap}', 'Enter inside the token leaves it whole')
    assert.equal(await ev(() => window.__v.state.doc.line(7).text), '2. ', 'ordered: next number, no icon')
  }

  // Cut and paste carry the token.
  await open(doc)
  await page.waitForFunction(() => window.pic(3) !== null)
  await focus()
  await ev(() => { const l = window.__v.state.doc.line(3); window.caret(l.from, l.to) })
  const cut = await ev(() => window.clipboard('cut'))
  assert.equal(cut, '- Bikes that are there {icon=lucide:bike}', 'cut text includes the token')
  assert.equal(await ev(() => window.__v.state.doc.line(3).text), '')
  await ev(() => window.caret(window.__v.state.doc.line(4).to))
  await ev((t) => window.clipboard('paste', '\n' + t), cut)
  assert.equal(await ev(() => window.__v.state.doc.line(5).text), '- Bikes that are there {icon=lucide:bike}', 'paste brings the token')
  await caretAt('# Riders', 3)
  assert.equal(await pic(5), 'lucide:bike', 'the pasted item shows its picture')

  // Unknown key, late answer, one request per key, fences, headings, paragraphs.
  await open(doc)
  await page.waitForFunction(() => window.pic(3) !== null)
  await caretAt('# Riders', 3)
  assert.equal(await pic(6), null, 'unknown key: no picture')
  assert.equal(await ev(() => window.bullets(6)), 1, 'unknown key: the bullet stays')
  assert.deepEqual(await chip(6), { text: '{icon=lucide:nope}', warn: true }, 'unknown key: warning chip, always shown')
  assert.equal(await pic(7), null, 'late key: no picture yet')
  assert.equal(await ev(() => window.bullets(7)), 1, 'late key: the bullet stays meanwhile')
  assert.equal(await shown(7), '• Late arrival', 'late key: token hidden while waiting')
  await ev(() => window.release())
  await page.waitForFunction(() => window.pic(7) === 'lucide:late')
  assert.equal(await ev(() => window.bullets(7)), 0, 'late answer repaints without typing')
  const calls = await ev(() => window.calls)
  assert.equal(calls.filter((k) => k === 'lucide:bike').length, 1, 'each key is asked once: ' + calls.join())
  assert.equal(await pic(11), 'lucide:bike', 'a heading shows its picture (ticket 07)')
  assert.equal(await shown(11), 'Heading', 'heading token hidden')
  assert.equal(await pic(12), 'lucide:bike', 'a paragraph shows its picture (ticket 07)')
  assert.equal(await shown(12), 'A paragraph', 'paragraph token hidden')
  assert.equal(await shown(15), '- in a fence {icon=lucide:bike}', 'fenced code is left alone')

  // No source: the token is a chip and the bullet stays.
  await open(doc, 'plain', false)
  await caretAt('# Riders', 3)
  assert.deepEqual(await chip(3), { text: '{icon=lucide:bike}', warn: false }, 'no icon source: chip')
  assert.equal(await ev(() => window.bullets(3)), 1)
  assert.equal(await pic(3), null)

  // A long item wraps under its text, not under the picture.
  const long = '- ' + 'word '.repeat(60).trim() + ' {icon=lucide:bike}\n- short\n'
  await open(long)
  await page.waitForFunction(() => window.pic(1) !== null)
  await caretAt('short', 1)
  const wrap = await ev(() => {
    const el = window.lineEl(1)
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    const r = document.createRange()
    const first = walker.nextNode()
    r.setStart(first, 0); r.setEnd(first, 1)
    const firstLeft = r.getBoundingClientRect().left
    r.selectNodeContents(el)
    const lefts = [...r.getClientRects()].map((x) => Math.round(x.left))
    return { firstLeft: Math.round(firstLeft), lefts, picRight: Math.round(el.querySelector('.cm-plain-icon-picture').getBoundingClientRect().right), height: el.getBoundingClientRect().height }
  })
  assert.ok(wrap.height > 40, 'the long item wraps: ' + wrap.height)
  const wrapLeft = Math.min(...wrap.lefts.filter((l) => l > wrap.picRight - 40 && l !== wrap.lefts[0]))
  assert.ok(Math.abs(wrapLeft - wrap.firstLeft) <= 2, 'wrapped line aligns with the first line of text: first ' + wrap.firstLeft + ', wrapped ' + wrapLeft + ' (' + wrap.lefts.join() + ')')

  // A nested item: no picture, chip in the ordinary colour, never fetched.
  await open(['# T', '', '- Top {icon=lucide:bike}', '  - Nested {icon=lucide:zap}', '    - Deeper {icon=lucide:nope}', ''].join('\n'))
  await settle()
  await caretAt('# T', 1)
  assert.equal(await pic(3), 'lucide:bike', 'the top-level item has its picture')
  assert.equal(await pic(4), null, 'a nested item gets no picture')
  assert.deepEqual(await chip(4), { text: '{icon=lucide:zap}', warn: false }, 'nested: the code chip in the ordinary colour')
  assert.deepEqual(await chip(5), { text: '{icon=lucide:nope}', warn: false }, 'nested with an unknown key: still the ordinary chip')
  assert.equal(await ev(() => window.calls.some((k) => /zap|nope/.test(k))), false, 'no icon is asked for a nested item')

  // Ticket 07: icons on titles and paragraphs.
  const doc7 = [
    '# Talk',                                                            // 1
    '',                                                                  // 2
    '- Bikes {icon=lucide:bike}',                                        // 3
    '',                                                                  // 4
    '## How it works {icon=lucide:route} {title-icon=above} {id=s1}',    // 5
    '',                                                                  // 6
    '### What riders ask for {icon=lucide:bike}',                        // 7
    '',                                                                  // 8
    'A safe lane for the whole trip is the request riders make,',        // 9
    'ahead of price and dock position. {icon=lucide:zap}',               // 10
    '',                                                                  // 11
    'The set {a, b} stays as written {a, b}',                            // 12
    '',                                                                  // 13
    '> A quotation {icon=lucide:bike}',                                  // 14
    '',                                                                  // 15
    '### Unknown title {icon=lucide:nope}',                              // 16
    '',                                                                  // 17
    'Unknown paragraph. {icon=lucide:nope}',                             // 18
    '',                                                                  // 19
    '| a {icon=lucide:bike} |',                                          // 20
    '',
    '### Shared group {icon=lucide:bike title-icon=above}',              // 22
    ''
  ].join('\n')
  await open(doc7)
  await settle()
  await caretAt('# Talk', 2)
  await page.waitForFunction(() => window.pic(5) !== null && window.pic(9) !== null)
  assert.equal(await pic(5), 'lucide:route', 'section heading: its picture')
  assert.equal(await shown(5), 'How it works  ', 'section heading: the icon token, {title-icon=above} and {id=…} are all hidden')
  assert.equal(await pic(7), 'lucide:bike', 'slide heading: its picture')
  assert.equal(await shown(7), 'What riders ask for', 'slide heading: token hidden')
  const headGeo = await ev(() => {
    const el = window.lineEl(7), p = el.querySelector('.cm-plain-icon-picture').getBoundingClientRect()
    const r = document.createRange(); const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let first = null
    for (let node; (node = w.nextNode());) if (node.data.includes('What')) { first = node; break }
    r.setStart(first, first.data.indexOf('What')); r.setEnd(first, first.data.indexOf('What') + 1)
    const t = r.getBoundingClientRect()
    return { picRight: p.right, picLeft: p.left, textLeft: t.left, lineLeft: el.getBoundingClientRect().left, picMid: p.top + p.height / 2, textMid: t.top + t.height / 2, w: p.width }
  })
  assert.ok(headGeo.picRight <= headGeo.textLeft && headGeo.textLeft - headGeo.picRight < 20, 'the picture sits just before the title: ' + JSON.stringify(headGeo))
  assert.ok(Math.abs(headGeo.picMid - headGeo.textMid) < 6, 'the picture is centred on the title line: ' + JSON.stringify(headGeo))
  assert.equal(await pic(9), 'lucide:zap', 'paragraph: the picture is at the start of its FIRST line')
  assert.equal(await pic(10), null, 'paragraph: no second picture on its last line')
  assert.equal(await shown(10), 'ahead of price and dock position.', 'paragraph: token hidden at the end of its last line')
  assert.equal(await shown(12), 'The set {a, b} stays as written {a, b}', 'ordinary braces in a paragraph are text')
  assert.equal(await pic(12), null)
  assert.equal(await pic(14), null, 'a quotation gets no picture')
  assert.equal(await shown(14).then((t) => t.includes('{icon=lucide:bike}')), true, 'a quotation keeps its token as written')
  assert.equal((await shown(20)).includes('{icon=lucide:bike}'), true, 'a table row keeps its token as written')
  assert.equal(await pic(16), null, 'unknown key on a title: no picture')
  assert.deepEqual(await chip(16), { text: '{icon=lucide:nope}', warn: true }, 'unknown key on a title: warning chip')
  assert.deepEqual(await chip(18), { text: '{icon=lucide:nope}', warn: true }, 'unknown key on a paragraph: warning chip')
  // S9: an icon that shares its brace group with other options is drawn; the whole group is hidden.
  assert.equal(await pic(22), 'lucide:bike', 'S9: an icon sharing a group with other options shows its picture')
  assert.equal(await shown(22), 'Shared group', 'S9: the whole shared group is hidden')
  assert.equal(await text(), doc7, 'drawing pictures never changes the document')
  // Reveal: the caret at the end of the title shows the chip; the picture stays.
  await caretAt('What riders ask for', 'What riders ask for'.length)
  assert.deepEqual(await chip(7), { text: '{icon=lucide:bike}', warn: false }, 'caret at the end of the title: the code shows as a chip')
  assert.equal(await pic(7), 'lucide:bike', 'the picture stays while the chip shows')
  await caretAt('# Talk', 2)
  assert.equal(await chip(7), null, 'chip hidden again when the caret leaves')
  await caretAt('dock position.', 'dock position.'.length)
  assert.deepEqual(await chip(10), { text: '{icon=lucide:zap}', warn: false }, 'caret at the end of the paragraph: chip')
  assert.equal(await pic(9), 'lucide:zap')
  // A click past the text rests before the token; typing lands before it.
  await caretAt('# Talk', 2)
  await ev(() => window.caret(window.at('{icon=lucide:zap}', 5), undefined, 'select.pointer'))
  assert.equal(await ev(() => window.head()), await ev(() => window.at('dock position.', 'dock position.'.length)), 'a click inside the hidden paragraph token rests before it')
  await focus()
  await page.keyboard.type('!')
  assert.equal((await text()).split('\n')[9], 'ahead of price and dock position.! {icon=lucide:zap}', 'typing at the end of the paragraph lands before the token')
  // Enter at the end of a title keeps the token on the title.
  await caretAt('What riders ask for', 'What riders ask for'.length)
  await focus()
  await page.keyboard.press('Enter')
  assert.equal((await text()).split('\n')[6], '### What riders ask for {icon=lucide:bike}', 'Enter at the end of the title leaves the token on the title')
  assert.equal((await text()).split('\n')[7], '', 'and starts an empty line under it')
  // S9: with the caret on it, the whole shared group shows as the chip; the picture stays.
  await open(doc7)
  await settle()
  await page.waitForFunction(() => window.pic(22) !== null)
  await caretAt('Shared group', 'Shared group'.length)
  assert.deepEqual(await chip(22), { text: '{icon=lucide:bike title-icon=above}', warn: false }, 'S9: caret on it: the whole group is the chip')
  assert.equal(await pic(22), 'lucide:bike', 'S9: the picture stays while the chip shows')
  await caretAt('# Talk', 2)
  assert.equal(await chip(22), null, 'S9: chip hidden again when the caret leaves')
  assert.equal(await text(), doc7, 'S9: nothing was written')
  // Enter at the end of a title whose icon group is followed by other groups: the whole line stays.
  await caretAt('How it works', 'How it works'.length)
  await focus()
  await page.keyboard.press('Enter')
  assert.equal((await text()).split('\n')[4], '## How it works {icon=lucide:route} {title-icon=above} {id=s1}', 'Enter at the end of a title keeps every group on the title')
  assert.equal((await text()).split('\n')[5], '', 'and starts an empty line under it')

  // Braces glued to text are text (the compiler's reading): no picture, nothing hidden.
  const glued = ['# Talk', '', '- Bikes {icon=lucide:bike}', '', '### See https://example.org/{icon=lucide:bike}', '', 'See https://example.org/{icon=lucide:bike}', '', 'Literal \\{icon=lucide:bike}', '', '### Title {reveal}{icon=lucide:zap}', ''].join('\n')
  await open(glued)
  await settle()
  await caretAt('# Talk', 2)
  await page.waitForFunction(() => window.pic(11) !== null)
  assert.equal(await pic(5), null, 'a heading whose braces end a URL gets no picture')
  assert.equal(await pic(7), null, 'a paragraph whose braces end a URL gets no picture')
  assert.equal(await shown(7), 'See https://example.org/{icon=lucide:bike}', 'and is shown as written')
  assert.equal(await pic(9), null, 'an escaped brace gets no picture')
  assert.equal(await pic(11), 'lucide:zap', 'a group written right after another authored group is drawn')

  // Standards B1: only a plain Enter at an empty caret is moved. A paste over a selection, a paste
  // at a caret, a deletion and Enter typed over a selection go through exactly as given.
  const b1 = '### A   {icon=lucide:bike}\n'
  const spaces = async () => { await open('- x {icon=lucide:bike}\n\n' + b1); await settle(); await focus(); await ev(() => window.caret(window.at('### A') + 5, window.at('### A') + 8)) }
  const last = async () => (await text()).slice('- x {icon=lucide:bike}\n\n'.length)
  await spaces()
  await ev(() => window.clipboard('paste', '\nPASTED'))
  // (Fourth fix round: an icon group is part of the title's hidden tail, so the selection's end
  // rests at the end of the visible text, one space before the token, as for any other group.
  // The paste replaces what is selected and the token stays apart from the text.)
  assert.equal(await last(), '### A\nPASTED {icon=lucide:bike}\n', 'B1: a paste over the selected spaces replaces them, where it was pasted')
  await spaces()
  await page.keyboard.press('Enter')
  assert.equal(await last(), b1, 'B1: Enter over a selection inside a title is the app\'s own rule (the title is not split): nothing changes, in Plain as in Markdown')
  await spaces()
  await page.keyboard.press('Backspace')
  assert.equal(await last(), '### A {icon=lucide:bike}\n', 'B1: deleting the selected spaces deletes them (the one space before the token is not selected)')
  await spaces()
  await ev(() => window.caret(window.at('### A') + 5))
  await ev(() => window.clipboard('paste', '\nPASTED'))
  assert.equal(await last(), '### A\nPASTED   {icon=lucide:bike}\n', 'B1: a paste at an empty caret lands at the caret')
  await spaces()
  await ev(() => window.caret(window.at('### A') + 5))
  await page.keyboard.press('Enter')
  assert.equal(await last(), b1, 'B1: a plain Enter at an empty caret before the token keeps the token on its line (the app\'s Enter from a title goes to the empty line under it)')
  assert.equal(await ev(() => window.head()), await ev(() => window.docText().length), 'B1: and the caret is on the line under the title')

  // ── Fix round 2 ────────────────────────────────────────────────────────────────────────────
  // Each case is run to its end and the failures listed together.
  const failed = []
  const check = async (label, fn) => { try { await fn() } catch (e) { failed.push(`${label}: ${String(e.message).split('\n')[0]}${e.actual !== undefined ? ' | got ' + JSON.stringify(e.actual) : ''}`) } }
  const PRE = '- x {icon=lucide:bike}\n\n'
  const mountLine = async (lineText, outliner = true) => { await open(PRE + lineText, 'plain', true, outliner); await page.waitForFunction(() => window.pic(1) !== null); await page.waitForTimeout(30); await focus() }
  const rest = async () => (await text()).slice(PRE.length)

  // 1. Enter at the visible end of a line is the Enter from the line's end, in one transaction
  //    (seventh fix round: no caret move before it); nothing rewrites a change.
  for (const outliner of [false, true]) {
    const enterAtEndOf = async (lineText, visible) => {
      await mountLine(lineText + '\n\nnext\n', outliner)
      await ev(([v]) => window.caret(window.at(v) + v.length), [visible])
      await ev(() => { window.log.length = 0 })
      await page.keyboard.press('Enter')
      return { text: await rest(), log: await ev(() => window.log.slice()), head: await ev(() => window.head() - 24) }
    }
    // A title is never split and nothing is inserted when a line already follows it: the caret
    // goes to the line under the title. That is the app's Enter from a title, and without the
    // app's commands it is Plain's own rule for every title with hidden text (seventh fix round:
    // one reader of heading lines, one Enter rule for all of them).
    const afterTitle = (title) => `${title}\n\nnext\n`
    await check(`Enter, heading with an icon (outliner ${outliner})`, async () => {
      const r = await enterAtEndOf('### What riders ask {icon=lucide:bike}', 'What riders ask')
      assert.equal(r.text, afterTitle('### What riders ask {icon=lucide:bike}'))
      assert.equal(r.head, '### What riders ask {icon=lucide:bike}\n'.length, 'the caret is on the line under the title')
      assert.deepEqual(r.log.map((t) => t.doc), [false], 'one transaction, the caret move onto the line under the title: ' + JSON.stringify(r.log))
      assert.equal(r.log[0].event, null, 'it is selection-only and carries no user event')
    })
    await check(`Enter, heading with an icon and an id (outliner ${outliner})`, async () => {
      const r = await enterAtEndOf('### What riders ask {icon=lucide:bike} {id=x}', 'What riders ask')
      assert.equal(r.text, afterTitle('### What riders ask {icon=lucide:bike} {id=x}'))
    })
    await check(`Enter, heading with an id between two icons (outliner ${outliner})`, async () => {
      const r = await enterAtEndOf('### What riders ask {icon=lucide:bike} {id=x} {icon=lucide:zap}', 'What riders ask')
      assert.equal(r.text, afterTitle('### What riders ask {icon=lucide:bike} {id=x} {icon=lucide:zap}'))
    })
    await check(`Enter, talk title with an icon and an id: the tokens stay on it (outliner ${outliner})`, async () => {
      // The app's Enter from a title covers \`##\` to \`######\`; on a talk title with hidden tokens Plain's own
      // command gives the same rule (sixth fix round, second ruling): the caret goes to the empty line under it.
      const r = await enterAtEndOf('# The talk {icon=lucide:bike} {id=t}', 'The talk')
      assert.equal(r.text, '# The talk {icon=lucide:bike} {id=t}\n\nnext\n')
      assert.ok(r.log.every((t) => !t.doc), JSON.stringify(r.log))
    })
    await check(`Enter, paragraph with an icon (outliner ${outliner})`, async () => {
      const r = await enterAtEndOf('A safe lane. {icon=lucide:zap}', 'A safe lane.')
      assert.equal(r.text, 'A safe lane. {icon=lucide:zap}\n\n\nnext\n')
      assert.deepEqual(r.log.map((t) => [t.doc, t.event]), [[true, 'input']], 'one transaction, and no caret move before it: ' + JSON.stringify(r.log))
    })
    await check(`Enter, list item with an icon (outliner ${outliner})`, async () => {
      const r = await enterAtEndOf('- Bikes there {icon=lucide:zap}', 'Bikes there')
      // The app's continuation writes a tight item; CodeMirror's own (no outliner) keeps this list's blank lines.
      assert.equal(r.text, outliner ? '- Bikes there {icon=lucide:zap}\n- \n\nnext\n' : '- Bikes there {icon=lucide:zap}\n\n- \n\nnext\n', 'the list continues and the token stays on its line')
      assert.deepEqual(r.log.map((t) => [t.doc, t.event]), [[true, 'input']], 'one transaction, and no caret move before it: ' + JSON.stringify(r.log))
    })
    await check(`Enter in the middle of the text is the ordinary Enter (outliner ${outliner})`, async () => {
      await mountLine('A safe lane. {icon=lucide:zap}\n', outliner)
      await ev(() => window.caret(window.at('A safe') + 6))
      await ev(() => { window.log.length = 0 })
      await page.keyboard.press('Enter')
      assert.equal(await rest(), 'A safe\nlane. {icon=lucide:zap}\n', 'split where the caret was (CodeMirror drops the space at the break)')
      assert.deepEqual(await ev(() => window.log.map((t) => t.doc)), [true], 'no caret move is dispatched')
    })
    await check(`Enter at the end of a line with no token dispatches no caret move (outliner ${outliner})`, async () => {
      await mountLine('Plain paragraph.\n', outliner)
      await ev(() => window.caret(window.at('Plain paragraph.') + 16))
      await ev(() => { window.log.length = 0 })
      await page.keyboard.press('Enter')
      assert.equal(await rest(), 'Plain paragraph.\n\n')
      assert.deepEqual(await ev(() => window.log.map((t) => t.doc)), [true])
    })
  }
  // Review 2, Standards 1: a remote change, an unannotated change, a formatting change tagged
  // `input` and a paste produce exactly the document asked for, annotations and effects intact.
  const B = '### A   {icon=lucide:bike}\n'
  const at5 = async () => { await mountLine(B); await ev(() => window.caret(window.at('### A') + 5)) }
  const off = PRE.length
  await check('remote change (the review\'s transaction)', async () => {
    await at5()
    const log = await ev((o) => window.send({ changes: { from: o + 5, to: o + 8, insert: '\n' }, remote: true, mark: 'm1' }), off)
    assert.equal(await rest(), '### A\n{icon=lucide:bike}\n')
    assert.deepEqual(log.map((t) => [t.remote, t.event, t.marks]), [[true, null, ['m1']]], 'the remote annotation and the effect arrive: ' + JSON.stringify(log))
  })
  await check('remote insertion of a line break at the caret', async () => {
    await at5()
    const log = await ev((o) => window.send({ changes: { from: o + 5, insert: '\nREMOTE' }, remote: true, mark: 'm2' }), off)
    assert.equal(await rest(), '### A\nREMOTE   {icon=lucide:bike}\n')
    assert.deepEqual(log.map((t) => [t.remote, t.marks]), [[true, ['m2']]])
  })
  await check('unannotated programmatic change', async () => {
    await at5()
    const log = await ev((o) => window.send({ changes: { from: o + 5, to: o + 8, insert: '\n' }, mark: 'm3' }), off)
    assert.equal(await rest(), '### A\n{icon=lucide:bike}\n')
    assert.deepEqual(log.map((t) => [t.event, t.marks]), [[null, ['m3']]])
  })
  await check('unannotated insertion of a line break at the caret', async () => {
    await at5()
    await ev((o) => window.send({ changes: { from: o + 5, insert: '\n' } }), off)
    assert.equal(await rest(), '### A\n   {icon=lucide:bike}\n')
  })
  await check('unannotated change with a caret placed inside the hidden token', async () => {
    await at5()
    const log = await ev((o) => window.send({ changes: { from: o + 4, insert: 'Z' }, selection: o + 12, mark: 'm4' }), off)
    assert.equal(await rest(), '### ZA   {icon=lucide:bike}\n')
    // Fourth fix round: a title's icon group is part of its hidden tail, and the caret never rests
    // in a tail, whoever put it there (hiddenLines' rule for every heading token). The change and
    // the mark arrive as sent; the caret is settled to the end of the visible text.
    assert.deepEqual(log.map((t) => [t.head, t.marks]), [[off + 8, ['m4']]], 'the transaction is as sent; the caret rests at the end of the title text')
  })
  await check('a programmatic or remote selection inside a title\'s icon token rests at the end of the title text; a paragraph\'s is put at the end of its text by a transaction that follows', async () => {
    await at5()
    let log = await ev((o) => window.send({ selection: o + 14, mark: 'm5' }), off)
    assert.deepEqual(log.map((t) => [t.head, t.marks]), [[off + 7, ['m5']]])
    await at5()
    log = await ev((o) => window.send({ selection: o + 14, remote: true, mark: 'm6' }), off)
    assert.deepEqual(log.map((t) => [t.head, t.remote, t.marks]), [[off + 7, true, ['m6']]])
    await mountLine('Hello there. {icon=lucide:zap}\n')
    log = await ev((o) => window.send({ selection: o + 20, mark: 'm8' }), off)
    // Seventh fix round: the transaction is as sent, and the caret is then settled after it
    // (settleCaret.ts), as after a transaction that passes no filter (Undo).
    assert.deepEqual(log.map((t) => [t.head, t.marks]), [[off + 20, ['m8']], [off + 12, []]])
  })
  await check('formatting change tagged input', async () => {
    await at5()
    const log = await ev((o) => window.send({ changes: { from: o + 5, to: o + 8, insert: '\n' }, event: 'input', mark: 'm7' }), off)
    assert.equal(await rest(), '### A\n{icon=lucide:bike}\n')
    assert.deepEqual(log.map((t) => [t.event, t.marks]), [['input', ['m7']]])
  })
  await check('line break typed at the caret by code tagged input.type', async () => {
    await at5()
    await ev((o) => window.send({ changes: { from: o + 5, insert: '\n' }, event: 'input.type' }), off)
    assert.equal(await rest(), '### A\n   {icon=lucide:bike}\n', 'a transaction is never rewritten; only the Enter key moves the caret first')
  })
  await check('paste over a selection', async () => {
    await at5()
    await ev((o) => window.caret(o + 5, o + 8), off)
    await ev(() => window.clipboard('paste', '\nPASTED'))
    assert.equal(await rest(), '### A\nPASTED {icon=lucide:bike}\n', 'the selection ends at the end of the visible text; the space before the token stays')
  })
  await check('a click inside the hidden token still rests before it', async () => {
    await mountLine('Hello there. {icon=lucide:zap}\n')
    await ev(() => window.caret(window.at('{icon=lucide:zap}', 5), undefined, 'select.pointer'))
    assert.equal(await ev(() => window.head()), await ev(() => window.at('Hello there.') + 12))
  })

  // 4. Plain reads groups as the compiler does (review 2, Standards 2, 3).
  await check('a quoted value that contains icon= is not an icon', async () => {
    await mountLine('### Quoted {foo="a icon=lucide:bike"}\n\ntext\n')
    await caretAt('text', 2)
    await page.waitForTimeout(60)
    assert.equal(await pic(3), null, 'no picture')
    assert.deepEqual(await ev(() => window.chips(3)), [], 'no icon chip')
    assert.equal(await ev(() => window.calls.some((k) => k.includes('"'))), false, 'no icon was asked for: ' + JSON.stringify(await ev(() => window.calls)))
    assert.equal((await shown(3)).trim(), 'Quoted', 'the group is hidden like any heading option')
    await caretAt('Quoted', 6)
    assert.deepEqual(await ev(() => window.chips(3)), [], 'caret at the end: still no icon chip')
  })
  await check('every icon group on a heading is hidden; the last one is drawn; all show as chips', async () => {
    await mountLine('### Twice {icon=lucide:bike} {icon=lucide:zap}\n\n### Thrice {icon=lucide:bike} {id=c1} {icon=lucide:zap}{icon=lucide:bike}\n\ntext\n')
    await caretAt('text', 2)
    await page.waitForFunction(() => window.pic(3) !== null && window.pic(5) !== null)
    assert.equal(await pic(3), 'lucide:zap', 'the effective (last) icon is drawn')
    assert.equal((await shown(3)).trim(), 'Twice', 'no icon group stays visible')
    assert.equal(await pic(5), 'lucide:bike')
    assert.equal((await shown(5)).trim(), 'Thrice')
    await caretAt('Twice', 5)
    assert.deepEqual(await ev(() => window.chips(3)), ['{icon=lucide:bike}', '{icon=lucide:zap}'], 'caret at the title\'s end: both groups show as chips')
    assert.equal(await pic(3), 'lucide:zap', 'the picture stays')
    await caretAt('Thrice', 6)
    assert.deepEqual(await ev(() => window.chips(5)), ['{icon=lucide:bike}', '{icon=lucide:zap}', '{icon=lucide:bike}'])
    await caretAt('text', 2)
    assert.deepEqual(await ev(() => window.chips(3).concat(window.chips(5))), [], 'chips hidden again when the caret leaves')
  })
  await check('a tab before the group, and a quoted key', async () => {
    await mountLine('### Tabbed\t{icon=lucide:zap}\n\n### Quoted key {icon="lucide:bike"}\n\ntext\n')
    await caretAt('text', 2)
    await page.waitForFunction(() => window.pic(3) !== null && window.pic(5) !== null)
    assert.equal(await pic(3), 'lucide:zap')
    assert.equal(await pic(5), 'lucide:bike', 'a quoted key is read without its quotes, as the compiler reads it')
  })
  assert.deepEqual(failed, [], 'fix round 2:\n  ' + failed.join('\n  '))

  // Markdown mode: as written.
  await open(doc7, 'markdown')
  assert.equal(await shown(7), '### What riders ask for {icon=lucide:bike}', 'Markdown mode shows the heading as written')
  assert.equal(await ev(() => document.querySelectorAll('.cm-plain-icon-picture, .cm-plain-icon-box').length), 0, 'Markdown mode: no pictures')

  // Markdown mode: the raw token, no pictures; switching modes round-trips.
  await open(doc, 'markdown')
  assert.equal(await shown(3), '- Bikes that are there {icon=lucide:bike}', 'Markdown mode shows the raw token')
  assert.equal(await ev(() => document.querySelectorAll('.cm-plain-icon-picture, .cm-plain-icon-chip, .cm-plain-icon-box').length), 0, 'Markdown mode: no icon decorations')
  await ev(() => window.setMode('plain'))
  await page.waitForFunction(() => window.pic(3) !== null)
  assert.equal(await shown(3), 'Bikes that are there')
  await ev(() => window.setMode('markdown'))
  assert.equal(await shown(3), '- Bikes that are there {icon=lucide:bike}', 'back to Markdown: raw again')

  assert.equal(errors.length, 0, 'no page errors: ' + errors.join(' | '))
  assert.deepEqual([...new Set(await ev(() => window.__caught))], [], 'no exception that CodeMirror caught')
  console.log('plain view icon pictures: ok')
} finally {
  await browser.close()
  rmSync(dir, { recursive: true, force: true })
}
