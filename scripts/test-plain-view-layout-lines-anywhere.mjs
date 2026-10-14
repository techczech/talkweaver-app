// Plain view, ticket 11: every layout line the compiler removes is hidden, wherever it stands in
// its slide, and the editor's keys beside such a line are safe.
//
// A layout line is hidden in Plain if and only if the compiler takes it out of its slide's content
// and reads it whole (shared/plain-view-margin.ts hiddenLayout). Before this ticket only the lines
// directly under the heading were; Dominik's older talks write
//     ### Effort spent on building pyramids / (blank) / {pyramid} / (blank) / - Pyramid
// and showed a `{pyramid}` chip with "Auto" in the margin.
//
// Held here, in the real editor (the app's base keymap and its own keys, line wrapping on):
//   - the two legacy shapes: the line is hidden, the margin names the layout, and ONE blank row
//     stands between the title and the body (the blank line before the hidden line is drawn hidden
//     with it; the document is not changed);
//   - a layout line in the middle of body content, and two layout lines separated by a blank line;
//   - for each hidden line: End then type, Enter at the end of the line before, Backspace at the
//     start of the line after, Delete at the end of the line before, Down and Up across it, a
//     click below it, and Undo and Redo after each. Every key's result is compared with what
//     Markdown mode makes of the same document from the same caret; the table below says, per
//     case, "same" (the same document as Markdown) or "held" (nothing changes). After every key
//     the hidden lines are in the document byte for byte, and the caret is on none of them;
//   - a selection across a hidden line, deleted, takes it, with the notice;
//   - Fail open (issue 126): a document the compiler's reading throws on is edited as text, and
//     the decorations and protection of the document before it clear.
//
//   node scripts/test-plain-view-layout-lines-anywhere.mjs [--print]
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const PRINT = process.argv.includes('--print')
const root = fileURLToPath(new URL('..', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'talk-weaver-plain-view-layout-lines-'))
const outfile = join(dir, 'bundle.js')
const entry = `
import { EditorView, keymap } from '@codemirror/view'
import { EditorState, EditorSelection, Compartment, Prec } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { history } from '@codemirror/commands'
import { languages } from '@codemirror/language-data'
import { search } from '@codemirror/search'
import { viewModeExtension } from './src/renderer/src/extensions/plainView/index.ts'
import { setMarginLabels } from './src/renderer/src/extensions/plainView/margin.ts'
import { hiddenRegions, protectedRegions } from './src/renderer/src/extensions/plainView/hiddenLines.ts'
import { placeholderSpots } from './src/renderer/src/extensions/plainView/placeholders.ts'
import { factsFailures } from './src/renderer/src/extensions/plainView/outlineLines.ts'
import { protectedRegionsOf } from './src/renderer/src/extensions/plainView/guardKeys.ts'
import { settleDispatches } from './src/renderer/src/extensions/plainView/settleCaret.ts'
import { tokenProtectExtension } from './src/renderer/src/extensions/idProtect.ts'
import { focusScopeExtension } from './src/renderer/src/extensions/focusScope.ts'
import { frontmatterTableExtension } from './src/renderer/src/extensions/frontmatterTable.ts'
import { editorBaseKeymap } from './src/renderer/src/extensions/editorBaseKeymap.ts'
import { buildEditorKeyBindings } from './src/renderer/src/keymap/store.ts'
import { marginLabels } from './src/shared/plain-view-margin.ts'
import { appKeyState, failOnCaughtExceptions } from './scripts/lib/plain-view-test-mount.mjs'

const compartment = new Compartment()
window.mount = (doc, mode = 'plain') => {
  document.getElementById('host').innerHTML = ''
  const view = new EditorView({ parent: document.getElementById('host'), state: EditorState.create({
    doc, selection: EditorSelection.cursor(0),
    extensions: [
      history(), markdown({ base: markdownLanguage, codeLanguages: languages }),
      tokenProtectExtension(), focusScopeExtension(), frontmatterTableExtension(), appKeyState(), search(),
      keymap.of([...editorBaseKeymap]),
      Prec.highest(keymap.of(buildEditorKeyBindings())),
      compartment.of(viewModeExtension(mode)),
      EditorView.lineWrapping,
      failOnCaughtExceptions()
    ]
  }) })
  view.focus()
  return window.__v = view
}
window.labels = () => setMarginLabels(window.__v, marginLabels(null, window.__v.state.doc.toString()))
window.labelsOf = (text) => marginLabels(null, text)
window.caret = (pos, head) => window.__v.dispatch({ selection: head === undefined ? EditorSelection.cursor(pos) : EditorSelection.single(pos, head), userEvent: 'select' })
window.sel = () => { const r = window.__v.state.selection.main; return [r.anchor, r.head] }
window.docText = () => window.__v.state.doc.toString()
window.setDoc = (text) => window.__v.dispatch({ changes: { from: 0, to: window.__v.state.doc.length, insert: text }, selection: EditorSelection.cursor(0) })
window.lineFrom = (n) => window.__v.state.doc.line(n).from
window.lineTo = (n) => window.__v.state.doc.line(n).to
window.lineAt = (pos) => window.__v.state.doc.lineAt(pos).number
window.regions = () => hiddenRegions(window.__v.state).map((r) => [r.kind, r.from, r.to])
window.zones = () => protectedRegions(window.__v.state.doc).filter((r) => r.kind === 'run').map((r) => [r.zoneFrom, r.zoneTo, r.from, r.to])
window.protectedCount = () => protectedRegionsOf(window.__v.state).length
window.spots = () => placeholderSpots(window.__v.state.doc, window.__v.state.selection.ranges.map((r) => r.head))
window.failures = () => ({ ...factsFailures })
window.settles = () => settleDispatches.count
// The rows the editor draws: each visible line's text, top to bottom ('' for an empty row).
// (A list item's mark is drawn as a bullet: read back as written.)
const rowText = (l) => l.textContent.replace(/^[^A-Za-z0-9{#]+ +/, '- ')
window.rows = () => [...window.__v.contentDOM.querySelectorAll('.cm-line')].filter((l) => l.getBoundingClientRect().height > 1).map(rowText)
window.rowTop = (text) => { const l = [...window.__v.contentDOM.querySelectorAll('.cm-line')].find((e) => rowText(e).includes(text)); if (!l) return null; const r = l.getBoundingClientRect(); return { left: r.left, top: r.top, height: r.height } }
window.margin = () => [...document.querySelectorAll('.cm-plain-margin .cm-gutterElement [data-margin-kind]:not([data-margin-line="0"])')].map((e) => ({
  line: Number(e.dataset.marginLine), word: e.querySelector('.cm-plain-margin-word')?.textContent, layout: e.querySelector('.cm-plain-margin-layout > span:first-child')?.textContent ?? null
}))
window.caretBox = () => { const c = window.__v.coordsAtPos(window.__v.state.selection.main.head); return c ? { top: c.top, bottom: c.bottom, left: c.left } : null }
window.toasts = []
window.addEventListener('tw-toast', (e) => window.toasts.push(e.detail))
`
await build({ stdin: { contents: entry, resolveDir: root, loader: 'ts' }, bundle: true, format: 'iife', outfile, logLevel: 'silent' })

// ── The documents ───────────────────────────────────────────────────────────────────────────────
// Each: the lines, and for each hidden layout line the 1-based line "before" (the visible line the
// caret rests on above it) and "after" (the first visible line below it).
const SHAPES = {
  // Dominik's legacy shape, a list under it.
  pyramid: {
    lines: ['# Talk', '', '## Section', '', '### Effort spent on building pyramids', '', '{pyramid}', '', '- Pyramid', '- Food for workers', '', '### Next slide', 'Body'],
    hidden: [7], before: 5, after: 8, heading: 5, layout: 'Pyramid',
    rows: ['Effort spent on building pyramids', '', '- Pyramid']
  },
  // The other legacy shape: a heading, a blank line, the layout line, then the next slide.
  statement: {
    lines: ['# Talk', '', '## Section', '', '### Can LLMs help us resolve this conflict?', '', '{statement}', '', '### Next slide', 'Body'],
    hidden: [7], before: 5, after: 8, heading: 5, layout: 'Statement',
    rows: ['Can LLMs help us resolve this conflict?', '', 'Next slide']
  },
  // A layout line in the middle of body content.
  middle: {
    lines: ['# Talk', '', '## Section', '', '### Body slide', 'Intro text', '{cards}', '- One', '- Two', '', '### Next slide', 'Body'],
    hidden: [7], before: 6, after: 8, heading: 5, layout: 'Cards',
    rows: ['Body slide', 'Intro text', '- One']
  },
  // Two layout lines separated by a blank line.
  twoLines: {
    lines: ['# Talk', '', '## Section', '', '### Two lines', '{iconlist}', '', '{reveal}', '- a', '- b', '', '### Next slide', 'Body'],
    hidden: [6, 8], before: 5, after: 9, heading: 5, layout: 'Icon list',
    rows: ['Two lines', '- a']
  }
}

// What each key does beside the hidden line, in Plain, against Markdown mode from the same caret:
//   same   the document and the caret after the key are the ones Markdown mode makes
//   held   nothing changes (Markdown mode would have changed the document)
// (enterBefore on a title is the app's "Enter from a title" in both modes: the caret goes to the
// first body line, past the layout line. enterThenBackspace then presses Backspace where that left
// the caret: on the empty line under a hidden line it is held, the accepted limit.)
const EXPECTED = {
  pyramid:   { endType: 'same', enterBefore: 'same', backspaceAfter: 'held', deleteBefore: 'held', enterThenBackspace: 'held', typeAfter: 'same' },
  statement: { endType: 'same', enterBefore: 'same', backspaceAfter: 'held', deleteBefore: 'held', enterThenBackspace: 'held', typeAfter: 'same' },
  middle:    { endType: 'same', enterBefore: 'same', backspaceAfter: 'held', deleteBefore: 'held', enterThenBackspace: 'same', typeAfter: 'same' },
  twoLines:  { endType: 'same', enterBefore: 'same', backspaceAfter: 'held', deleteBefore: 'held', enterThenBackspace: 'held', typeAfter: 'same' }
}

const browser = await chromium.launch()
const errors = []
const table = []
const mismatches = []
let checks = 0
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } })
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.setContent('<div id="host" style="width:900px;height:800px"></div>')
  await page.addScriptTag({ path: outfile })
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  const ev = (fn, ...args) => page.evaluate(([f, a]) => window[f](...a), [fn, args])
  const rowsFrom = async (title, n) => { const rows = await ev('rows'); const at = rows.findIndex((r) => r.includes(title)); return rows.slice(at, at + n) }

  for (const [name, shape] of Object.entries(SHAPES)) {
    const text = shape.lines.join('\n')
    const hiddenText = shape.hidden.map((n) => shape.lines[n - 1])
    const mount = async (mode) => { await page.evaluate(([t, m]) => { window.mount(t, m) }, [text, mode]); if (mode === 'plain') await ev('labels') }
    /** Every hidden line is in the document as a whole line, as written, and the caret is on none of them. */
    const intact = async (what) => {
      const now = (await ev('docText')).split('\n')
      for (const line of hiddenText) assert.equal(now.filter((l) => l === line).length, shape.lines.filter((l) => l === line).length, `${name}, ${what}: the hidden line ${line} is in the document as written`)
      const [anchor, head] = await ev('sel')
      for (const [zoneFrom, zoneTo] of await ev('zones')) assert.ok(anchor === head ? head < zoneFrom || head > zoneTo : true, `${name}, ${what}: the caret (${head}) is not on a hidden line (${zoneFrom}-${zoneTo})`)
      checks += 1
    }

    // ── Hidden, labelled, one blank row ──────────────────────────────────────────────────────────
    await mount('plain')
    const rows = await ev('rows')
    for (const line of hiddenText) assert.ok(!rows.includes(line), `${name}: ${line} is not drawn`)
    const at = rows.indexOf(shape.rows[0])
    assert.deepEqual(rows.slice(at, at + shape.rows.length), shape.rows, `${name}: the rows from the title down`)
    const label = (await ev('margin')).find((m) => m.line === shape.heading)
    assert.equal(label?.layout, shape.layout, `${name}: the margin names the layout`)
    assert.equal((await ev('labelsOf', text)).find((l) => l.line === shape.heading)?.layoutLabel, shape.layout, `${name}: marginLabels names the layout`)
    assert.equal(await ev('docText'), text, `${name}: mounting changes nothing`)
    checks += 4

    // ── The keys, each from a fresh mount, in Plain and in Markdown ──────────────────────────────
    const beforeEnd = text.split('\n').slice(0, shape.before).join('\n').length
    const afterStart = text.split('\n').slice(0, shape.after - 1).join('\n').length + 1
    const KEYS = {
      endType: { at: beforeEnd - 3, keys: ['End', 'x'] },
      enterBefore: { at: beforeEnd, keys: ['Enter'] },
      backspaceAfter: { at: afterStart, keys: ['Backspace'] },
      deleteBefore: { at: beforeEnd, keys: ['Delete'] },
      enterThenBackspace: { at: beforeEnd, keys: ['Enter', 'Backspace'] },
      typeAfter: { at: afterStart, keys: ['y'] }
    }
    for (const [key, spec] of Object.entries(KEYS)) {
      const run = async (mode) => {
        await mount(mode)
        await ev('caret', spec.at)
        for (const k of spec.keys) { if (k.length === 1) await page.keyboard.type(k); else await page.keyboard.press(k) }
        return { doc: await ev('docText'), sel: await ev('sel') }
      }
      const md = await run('markdown')
      const plain = await run('plain')
      await intact(key)
      const outcome = plain.doc === text && md.doc !== text ? 'held' : plain.doc !== md.doc ? 'plain' : plain.sel[1] === md.sel[1] ? 'same' : 'same text, other caret'
      table.push({ shape: name, key, outcome, caret: plain.sel[1], line: await ev('lineAt', plain.sel[1]), doc: plain.doc === text ? '(unchanged)' : JSON.stringify(plain.doc.split('\n').slice(shape.heading - 1, shape.after + 2)) })
      if (outcome !== EXPECTED[name][key]) mismatches.push(`${name}, ${key}: ${outcome}, expected ${EXPECTED[name][key]} (Plain ${JSON.stringify(plain.doc)}, Markdown ${JSON.stringify(md.doc)})`)
      // Undo and Redo: the document goes back and forth, the hidden line as written, the caret off it.
      if (plain.doc !== text) {
        await page.keyboard.press(`${mod}+z`)
        assert.equal(await ev('docText'), text, `${name}, ${key}: Undo restores the document`)
        await intact(`${key}, Undo`)
        await page.keyboard.press(`${mod}+Shift+z`)
        assert.equal(await ev('docText'), plain.doc, `${name}, ${key}: Redo makes the change again`)
        await intact(`${key}, Redo`)
      }
      const drawn = await ev('rows')
      for (const line of hiddenText) assert.ok(!drawn.includes(line), `${name}, ${key}: ${line} is still not drawn`)
      checks += 2
    }

    // ── Down and Up across it ────────────────────────────────────────────────────────────────────
    await mount('plain')
    await ev('caret', beforeEnd)
    await page.keyboard.press('ArrowDown')
    await intact('ArrowDown')
    assert.equal(await ev('lineAt', (await ev('sel'))[1]), shape.after, `${name}: Down from the line before goes to the line after`)
    await page.keyboard.press('ArrowUp')
    await intact('ArrowUp')
    assert.equal(await ev('lineAt', (await ev('sel'))[1]), shape.before, `${name}: Up from the line after goes to the line before`)
    // Right from the end of the line before steps over; Left from the start of the line after comes back.
    await ev('caret', beforeEnd)
    await page.keyboard.press('ArrowRight')
    await intact('ArrowRight')
    assert.equal((await ev('sel'))[1], afterStart, `${name}: Right from the end of the line before steps over the hidden line`)
    await page.keyboard.press('ArrowLeft')
    await intact('ArrowLeft')
    assert.equal((await ev('sel'))[1], beforeEnd, `${name}: Left from the start of the line after comes back to the end of the line before`)
    // Home and End on the line before and the line after stay on their line.
    for (const [n, k] of [[shape.before, 'End'], [shape.before, 'Home'], [shape.after, 'End'], [shape.after, 'Home']]) {
      await ev('caret', await ev('lineFrom', n))
      await page.keyboard.press(k)
      await intact(k)
      assert.equal(await ev('lineAt', (await ev('sel'))[1]), n, `${name}: ${k} on line ${n} stays on it`)
    }
    // Shift-Down from the line before selects across it; the selection's ends are off the hidden line.
    await ev('caret', beforeEnd)
    await page.keyboard.press('Shift+ArrowDown')
    const [sa, sh] = await ev('sel')
    for (const [zoneFrom, zoneTo] of await ev('zones')) assert.ok((sa < zoneFrom || sa > zoneTo) && (sh < zoneFrom || sh > zoneTo), `${name}: a selection's ends are off the hidden line`)
    checks += 8

    // ── A click below it ─────────────────────────────────────────────────────────────────────────
    await mount('plain')
    const below = await ev('rowTop', shape.rows[shape.rows.length - 1])
    await page.mouse.click(below.left + 30, below.top + below.height / 2)
    await intact('a click below')
    const clicked = await ev('lineAt', (await ev('sel'))[1])
    assert.equal(shape.lines[clicked - 1], shape.lines.find((l) => l.includes(shape.rows[shape.rows.length - 1])), `${name}: a click on the row below the hidden line lands on that row's line`)
    await page.keyboard.type('Z')
    await intact('typing after a click below')
    assert.ok((await ev('docText')).split('\n')[clicked - 1].includes('Z'), `${name}: typing after the click goes into the clicked line`)
    await page.keyboard.press(`${mod}+z`)
    assert.equal(await ev('docText'), text, `${name}: Undo after the click's typing`)
    await intact('Undo after a click below')
    checks += 3

    // ── A selection across it, deleted, takes it (as in Markdown) ────────────────────────────────
    await mount('plain')
    await page.evaluate(([a, b]) => window.caret(a, b), [beforeEnd - 2, afterStart])
    await page.keyboard.press('Backspace')
    const cut = await ev('docText')
    await mount('markdown')
    await page.evaluate(([a, b]) => window.caret(a, b), [beforeEnd - 2, afterStart])
    await page.keyboard.press('Backspace')
    assert.equal(cut, await ev('docText'), `${name}: deleting a selection across the hidden line does what Markdown does`)
    for (const line of hiddenText) assert.ok(!cut.split('\n').includes(line), `${name}: the selection took ${line}`)
    checks += 2
  }

  // ── The notice, and Undo, for a selection that takes a hidden line ─────────────────────────────
  {
    const text = SHAPES.pyramid.lines.join('\n')
    await page.evaluate((t) => { window.mount(t, 'plain') }, text)
    const from = text.indexOf('pyramids'), to = text.indexOf('- Pyramid') + 2
    await page.evaluate(() => { window.toasts.length = 0 })
    await page.evaluate(([a, b]) => window.caret(a, b), [from, to])
    await page.keyboard.press('Backspace')
    assert.ok(!(await ev('docText')).includes('{pyramid}'), 'the selection took the layout line')
    const notices = await page.evaluate(() => window.toasts.filter((t) => t.key === 'plain-hidden-removed'))
    assert.equal(notices.length, 1, 'one notice: ' + JSON.stringify(notices))
    assert.equal(notices[0].message, 'A slide\'s layout line was removed with the selection. Undo restores it.')
    await page.keyboard.press(`${mod}+z`)
    assert.equal(await ev('docText'), text, 'Undo restores the layout line')
    const [a, h] = await ev('sel')
    for (const [zoneFrom, zoneTo] of await ev('zones')) assert.ok(a !== h || h < zoneFrom || h > zoneTo, 'after Undo the caret is not on the hidden line')
    checks += 3
  }

  // ── Display only: the blank line before a hidden line ─────────────────────────────────────────
  {
    const text = SHAPES.pyramid.lines.join('\n')
    await page.evaluate((t) => { window.mount(t, 'plain') }, text)
    // Typing on the one blank row goes onto the blank line AFTER the layout line (the body's first line).
    await ev('caret', await ev('lineFrom', 8))
    await page.keyboard.type('New text')
    assert.deepEqual((await ev('docText')).split('\n').slice(4, 9), ['### Effort spent on building pyramids', '', '{pyramid}', 'New text', '- Pyramid'], 'typing on the blank row')
    assert.deepEqual(await rowsFrom('Effort', 3), ['Effort spent on building pyramids', 'New text', '- Pyramid'], 'the rows after typing on it: no row appears or goes')
    // A caret put on the hidden blank line by code shows that line (it is an ordinary line), and the layout line stays hidden.
    await page.evaluate((t) => { window.mount(t, 'plain') }, text)
    await page.evaluate(() => window.__v.dispatch({ selection: { anchor: window.lineFrom(6) } }))
    assert.deepEqual(await rowsFrom('Effort', 4), ['Effort spent on building pyramids', '', '', '- Pyramid'], 'the blank line shows while the caret is on it')
    await page.keyboard.type('Above')
    assert.deepEqual((await ev('docText')).split('\n').slice(4, 8), ['### Effort spent on building pyramids', 'Above', '{pyramid}', ''], 'typing on it')
    assert.ok(!(await ev('rows')).includes('{pyramid}'), 'the layout line is hidden under a body line too')
    // No placeholder on a slide whose body has text below a hidden line; one on a slide whose only line is hidden.
    const empty = ['# T', '', '## S', '', '### ', '', '{statement}', ''].join('\n')
    await page.evaluate((t) => { window.mount(t, 'plain') }, empty)
    assert.deepEqual((await ev('spots')).map((s) => s.kind), ['title', 'body'], 'placeholders: the body placeholder is on the row after the hidden line')
    assert.equal((await ev('spots'))[1].pos, empty.length, 'the body placeholder is on the last line')
    checks += 7
  }

  // ── Undo that would put the caret on a hidden line; a key that would make an unseen blank line ─
  {
    const text = SHAPES.middle.lines.join('\n')
    await page.evaluate((t) => { window.mount(t, 'plain') }, text)
    // A caret put on the layout line by code shows it; a character typed after it makes it text.
    const end = text.indexOf('{cards}') + 7
    await page.evaluate((at) => window.__v.dispatch({ selection: { anchor: at } }), end)
    assert.ok((await ev('rows')).includes('{cards}'), 'a caret put on the layout line by code shows it')
    await page.keyboard.type('x')
    await ev('caret', text.indexOf('- One') + 4)
    const settled = await ev('settles')
    // Undo restores the line and the caret that typed on it: the caret is taken off the hidden line.
    await page.keyboard.press(`${mod}+z`)
    assert.equal(await ev('docText'), text, 'Undo restores the layout line')
    const [, head] = await ev('sel')
    for (const [zoneFrom, zoneTo] of await ev('zones')) assert.ok(head < zoneFrom || head > zoneTo, `after Undo the caret (${head}) is off the hidden line`)
    assert.equal(head, text.indexOf('Intro text') + 10, 'it rests at the end of the line above')
    assert.ok(!(await ev('rows')).includes('{cards}'), 'and the line is hidden again')
    assert.equal((await ev('settles')) - settled, 1, 'one settling transaction')
    await page.keyboard.press(`${mod}+Shift+z`)
    assert.equal((await ev('docText')).split('\n')[6], '{cards}x', 'Redo types the character again')
    // Ctrl-O at the end of the line above a hidden line would put an empty line there that Plain
    // draws hidden: held. (Enter there makes the same line with the caret on it: allowed, above.)
    await page.evaluate((t) => { window.mount(t, 'plain') }, text)
    await ev('caret', text.indexOf('Intro text') + 10)
    await page.keyboard.press('Control+o')
    assert.equal(await ev('docText'), text, 'Ctrl-O at the end of the line above a hidden line is held')
    checks += 8
  }

  // ── The layout line is the last line of the document: the blank line above it stays, to type on ─
  {
    const text = ['# T', '', '## S', '', '### Last slide', '', '{statement}'].join('\n')
    await page.evaluate((t) => { window.mount(t, 'plain'); window.labels() }, text)
    assert.deepEqual(await rowsFrom('Last slide', 3), ['Last slide', ''], 'the title and one blank row; the layout line is hidden')
    assert.equal((await ev('margin')).find((m) => m.line === 5)?.layout, 'Statement', 'the margin names the layout')
    const blank = text.indexOf('\n\n{statement}') + 1
    await ev('caret', blank)
    await page.keyboard.press('Delete')
    assert.equal(await ev('docText'), text, 'Delete on the blank line above the hidden line is held')
    await page.keyboard.press('ArrowRight')
    assert.equal((await ev('sel'))[1], blank, 'Right has nowhere to go past the hidden last line: the caret stays')
    await page.keyboard.press('ArrowDown')
    assert.equal((await ev('sel'))[1], blank, 'Down too')
    await page.keyboard.type('Body')
    assert.equal(await ev('docText'), text.replace('\n\n{statement}', '\nBody\n{statement}'), 'typing on the blank row')
    assert.deepEqual(await rowsFrom('Last slide', 3), ['Last slide', 'Body'], 'the layout line stays hidden under the typed line')
    await page.keyboard.press(`${mod}+z`)
    assert.equal(await ev('docText'), text, 'Undo')
    checks += 8
  }

  // ── A line the compiler keeps, and a partly commented one, stay shown ─────────────────────────
  {
    const text = ['# T', '{reveal}', '', '## S', '', '### Chart', 'Intro', '', '{chart=bar}', '- A: 1', '- B: 2', '', '### Commented', 'Text', '{rev<!-- c -->eal}', 'More'].join('\n')
    await page.evaluate((t) => { window.mount(t, 'plain') }, text)
    const rows = await ev('rows')
    assert.ok(rows.includes('{reveal}'), 'a {…} line before the first slide is shown')
    assert.ok(rows.includes('{chart=bar}'), 'a chart token that owns the list under it is shown')
    assert.ok(rows.some((r) => r.includes('eal}')), 'a partly commented layout line is shown')
    assert.deepEqual(await ev('zones'), [], 'and none of them is protected')
    checks += 4
  }

  // ── Fail open (issue 126): the compiler's reading throws ──────────────────────────────────────
  {
    const good = SHAPES.pyramid.lines.join('\n')
    await page.evaluate((t) => { window.mount(t, 'plain') }, good)
    assert.ok((await ev('regions')).length > 0 && (await ev('protectedCount')) > 0, 'a document with hidden text')
    const before = (await ev('failures')).count
    // Thousands of list rows, each indented one more space: the compiler's lexer recurses on them.
    const deep = '# T {id=t}\n\n## S\n\n### Deep {reveal}\n{cards}\nBody text\n' + Array.from({ length: 6000 }, (_, i) => `${' '.repeat(i)}- row`).join('\n')
    await ev('setDoc', deep)
    const failed = await ev('failures')
    assert.ok(failed.count > before, 'the facts pass threw on the deep document')
    assert.match(failed.last, /Maximum call stack|RangeError|stack/i, `the error is the stack overflow: ${failed.last}`)
    assert.deepEqual(await ev('regions'), [], 'nothing is hidden')
    assert.equal(await ev('protectedCount'), 0, 'nothing is protected')
    assert.ok((await ev('rows')).includes('{cards}'), 'the layout line of the failing document shows as text')
    assert.deepEqual(await ev('margin'), [], 'no margin label is drawn from stale facts')
    // The editor keeps working: typing, Backspace and Enter change the text as in Markdown.
    await ev('caret', deep.indexOf('Body text') + 9)
    await page.keyboard.type('!')
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Backspace')
    assert.equal((await ev('docText')).split('\n')[6], 'Body tex', 'typing and Backspace edit the text of the failing document')
    // The margin's own pass (WorkspaceLayout's memo) answers too.
    assert.deepEqual(await ev('labelsOf', deep), [], 'marginLabels gives no labels and does not throw')
    // A good document after it is read again.
    await ev('setDoc', good)
    assert.ok((await ev('regions')).length > 0, 'a good document after it is hidden and protected again')
    checks += 9
  }

  assert.deepEqual(await page.evaluate(() => window.__caught), [], 'no exception was caught by CodeMirror')
  assert.deepEqual(errors, [], 'no page error')
} finally {
  await browser.close()
  rmSync(dir, { recursive: true, force: true })
}

if (PRINT || mismatches.length) for (const row of table) console.log(`  ${row.shape.padEnd(10)} ${row.key.padEnd(15)} ${row.outcome.padEnd(6)} caret on line ${row.line}  ${row.doc}`)
assert.deepEqual(mismatches, [], 'every key does what the table says')
console.log(`plain view, layout lines anywhere in a slide: ${Object.keys(SHAPES).length} shapes, ${table.length} keys compared with Markdown mode, ${checks} checks`)
console.log('ok')
