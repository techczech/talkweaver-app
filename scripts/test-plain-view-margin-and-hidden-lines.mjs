// test:plain-view-margin-and-hidden-lines — plain editing view ticket 03 (spec T5, T6, T7).
//
// The real extensions (plainView, idProtect, focusScope, the slide-number gutter, search), bundled
// for chrome-headless-shell, in Plain mode over a sample outline:
//   - the margin gutter: TALK / SECTION / SLIDE n with the layout name, fed through setMarginLabels,
//     riding edits, falling back to depth for a heading nothing compiled names; Markdown shows the
//     slide-number gutter and no margin;
//   - hidden layout lines: gone from the DOM and from the layout (no gap), wherever in the slide they stand (ticket 11:
//     a layout line among the body is hidden as one under the heading is);
//     the caret never rests in one or after a heading's hidden tokens (arrows, clicks, a caret set
//     by code), Backspace at the next line's start and Delete at the heading's end do nothing,
//     Enter in a title is the app's "Enter from a title" (the harness binds the app's three Enter
//     commands), a change is applied exactly as asked (nothing is cancelled or extended), deleting
//     the slide takes them, Find reveals one while its match is selected, Slide Focus composes, a
//     hand-typed layout line stays visible while the caret is on it and hides when the caret leaves;
//   - heading tokens: `{id=…}` hidden, `{icon=…}` kept as a chip, ArrowRight steps over them;
//   - list marks: `-` shows as a bullet on and off the caret line, the text is not changed;
//   - Markdown mode: every line, chip and layout line as today.
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('..', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'talk-weaver-plain-view-margin-'))
const outfile = join(dir, 'bundle.js')
const entry = `
import { EditorView, keymap, highlightActiveLine } from '@codemirror/view'
import { EditorState, EditorSelection, Compartment, Prec, Transaction, StateEffect } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands'
import { languages } from '@codemirror/language-data'
import { search, setSearchQuery, SearchQuery, findNext, searchKeymap } from '@codemirror/search'
import { viewModeExtension } from './src/renderer/src/extensions/plainView/index.ts'
import { setMarginLabels } from './src/renderer/src/extensions/plainView/margin.ts'
import { hiddenRegions } from './src/renderer/src/extensions/plainView/hiddenLines.ts'
import { tokenProtectExtension } from './src/renderer/src/extensions/idProtect.ts'
import { focusScopeExtension, setFocusRange } from './src/renderer/src/extensions/focusScope.ts'
import { slideNumberGutterExtension, setSlideNumberLines } from './src/renderer/src/extensions/slideNumberGutter.ts'
import { marginLabels } from './src/shared/plain-view-margin.ts'
import { appEnterBindings, appKeyState, failOnCaughtExceptions } from './scripts/lib/plain-view-test-mount.mjs'

const compartment = new Compartment()
window.mount = (doc, mode, protect = true) => {
  document.getElementById('host').innerHTML = ''
  const view = new EditorView({ parent: document.getElementById('host'), state: EditorState.create({
    doc, selection: EditorSelection.cursor(0),
    extensions: [
      slideNumberGutterExtension, history(), highlightActiveLine(),
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      protect ? tokenProtectExtension() : [], focusScopeExtension(), appKeyState(), search(),
      // The app's own Enter chain (keymap/registry.ts), with the state it reads, ahead of the default keymap: the cases below test what the app does.
      Prec.highest(keymap.of(appEnterBindings())),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
      compartment.of(viewModeExtension(mode)),
      failOnCaughtExceptions()
    ]
  }) })
  view.focus()
  return window.__v = view
}
window.setMode = (mode) => window.__v.dispatch({ effects: compartment.reconfigure(viewModeExtension(mode)) })
window.labels = () => setMarginLabels(window.__v, marginLabels(null, window.__v.state.doc.toString()))
window.setLabels = (l) => setMarginLabels(window.__v, l)
window.numbers = (lines) => setSlideNumberLines(window.__v, lines)
window.focusBlock = (from, to) => setFocusRange(window.__v, from === null ? null : { from, to })
window.caret = (pos, head) => window.__v.dispatch({ selection: head === undefined ? EditorSelection.cursor(pos) : EditorSelection.single(pos, head), userEvent: 'select' })
const testMark = StateEffect.define()
// What the filters make of a transaction, without dispatching it: { changes, selection, remote, event }.
window.filtered = (spec) => {
  const tr = window.__v.state.update({
    ...(spec.changes ? { changes: spec.changes } : {}),
    ...(spec.selection !== undefined ? { selection: EditorSelection.cursor(spec.selection) } : {}),
    ...(spec.remote ? { annotations: Transaction.remote.of(true) } : {}),
    ...(spec.event ? { userEvent: spec.event } : {}),
    effects: testMark.of('mark')
  })
  return { doc: tr.newDoc.toString(), head: tr.newSelection.main.head, remote: tr.annotation(Transaction.remote) === true,
    event: tr.annotation(Transaction.userEvent) ?? null, marks: tr.effects.filter((e) => e.is(testMark)).length }
}
window.sel = () => { const r = window.__v.state.selection.main; return [r.anchor, r.head] }
window.lineFrom = (n) => window.__v.state.doc.line(n).from
window.lineTo = (n) => window.__v.state.doc.line(n).to
window.docText = () => window.__v.state.doc.toString()
window.docLine = (n) => window.__v.state.doc.line(n).text
window.regions = () => hiddenRegions(window.__v.state).map((r) => [r.kind, r.from, r.to])
window.userEdit = (spec, userEvent) => window.__v.dispatch({ changes: spec, userEvent })
window.domText = () => window.__v.contentDOM.innerText
window.lineBox = (text) => {
  const line = [...window.__v.contentDOM.querySelectorAll('.cm-line')].find((l) => l.textContent.includes(text))
  if (!line) return null
  const r = line.getBoundingClientRect()
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, html: line.innerHTML }
}
window.margin = () => [...document.querySelectorAll('.cm-plain-margin .cm-gutterElement [data-margin-kind]:not([data-margin-line="0"])')].map((e) => ({
  kind: e.dataset.marginKind, line: Number(e.dataset.marginLine), text: [...e.children].map((c) => c.querySelector('.cm-plain-margin-chevron') ? c.firstElementChild.textContent : c.textContent).join(' '), word: e.querySelector('.cm-plain-margin-word')?.textContent, layout: e.querySelector('.cm-plain-margin-layout > span:first-child')?.textContent ?? null
}))
window.selectMatch = (text) => {
  const v = window.__v
  v.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: text })), selection: EditorSelection.cursor(0) })
  findNext(v)
}
`
await build({ stdin: { contents: entry, resolveDir: root, loader: 'ts' }, bundle: true, format: 'iife', outfile, logLevel: 'silent' })

const doc = [
  '# Ten years of bike hire {id=talk}',        // 1
  '',                                          // 2
  '## Section A',                              // 3
  '{id=sec-a}',                                // 4
  '',                                          // 5
  '### Slide one {id=s1}',                     // 6
  '{iconlist}',                                // 7
  '{id=one}',                                  // 8
  'First body line',                           // 9
  '- item one',                                // 10
  '- item two',                                // 11
  '1. numbered',                               // 12
  '',                                          // 13
  '### Slide two {icon=lucide:bike}{id=s2}',   // 14
  'Body two',                                  // 15
  '{orphan}',                                  // 16
  '',                                          // 17
  '### Slide three',                           // 18
  '{statement}',                               // 19
  '',                                          // 20
  'Closing text'                               // 21
].join('\n')

const browser = await chromium.launch()
const errors = []
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } })
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.setContent('<div id="host" style="width:900px;height:800px"></div>')
  await page.addScriptTag({ path: outfile })
  const ev = (fn, arg) => page.evaluate(fn, arg)
  const open = async (d = doc, mode = 'plain', protect = true) => { await ev(([d, m, p]) => { window.mount(d, m, p); window.labels() }, [d, mode, protect]) }
  const text = () => ev(() => window.docText())
  const caret = (pos) => ev((p) => window.caret(p), pos)
  const at = async (n, col = 0) => (await ev((n) => window.lineFrom(n), n)) + col
  const sel = () => ev(() => window.sel())

  // ---------------------------------------------------------------- the margin
  await open()
  let m = await ev(() => window.margin())
  assert.deepEqual(m.map((x) => [x.kind, x.line]), [['talk', 1], ['section', 3], ['slide', 6], ['slide', 14], ['slide', 18]], 'one marker per heading, by depth before any compile')
  assert.equal(m[0].text, 'Talk')
  assert.equal(m[1].text, 'Section 1 L1 \u00b7 3 slides', 'a section: its number, its level and the slides inside it')
  assert.equal(m[2].word, 'Slide 1', 'number from the order of slide headings while nothing is compiled')
  assert.equal(m[2].layout, 'Icon list', 'the written {iconlist} names the slide')
  assert.equal(m[3].layout, 'Auto', 'a slide with no layout reads Auto')
  assert.equal(m[4].layout, 'Statement')
  const css = await ev(() => { const w = document.querySelector('.cm-plain-margin .cm-plain-margin-word'); const g = document.querySelector('.cm-plain-margin'); const l = document.querySelector('.cm-plain-margin-layout'); return { color: getComputedStyle(w).color, upper: getComputedStyle(w).textTransform, layoutColor: getComputedStyle(l).color, width: g.getBoundingClientRect().width, numberGutter: getComputedStyle(document.querySelector('.cm-gutter.cm-lineNumbers')).display, first: document.querySelector('.cm-gutters > .cm-gutter').className } })
  assert.equal(css.upper, 'uppercase')
  assert.equal(css.color, 'rgb(138, 144, 153)', 'label is grey')
  assert.equal(css.layoutColor, 'rgb(26, 95, 180)', 'layout name is the accent blue')
  assert.ok(css.width >= 70 && css.width <= 78, 'margin width ' + css.width)
  assert.equal(css.numberGutter, 'none', 'the slide-number gutter is not shown in Plain')
  assert.match(css.first, /cm-plain-margin/, 'the margin is the first gutter')

  // Compiled labels arrive, then edits move them with the heading.
  await ev(() => window.setLabels([{ line: 1, kind: 'talk' }, { line: 3, kind: 'section' }, { line: 6, kind: 'slide', number: 3, layoutLabel: 'Auto' }, { line: 14, kind: 'slide', number: 4, layoutLabel: 'Auto' }]))
  m = await ev(() => window.margin())
  assert.equal(m.find((x) => x.line === 6).word, 'Slide 3')
  assert.equal(m.find((x) => x.line === 6).layout, 'Auto', 'compiled labels win over the written fallback')
  await ev(() => window.userEdit({ from: 0, insert: 'New first line\n' }, 'input.type'))
  m = await ev(() => window.margin())
  assert.equal(m.find((x) => x.line === 7).word, 'Slide 3', 'the label rides the edit to its heading')
  assert.equal(m.find((x) => x.line === 2).kind, 'talk')
  assert.equal(m.find((x) => x.line === 19).layout, 'Statement', 'a heading with no anchor falls back to its written layout')
  await ev(() => window.userEdit({ from: 0, to: 15, insert: '' }, 'delete'))

  // Markdown: the slide-number gutter, no margin, every line and chip as today.
  await open()
  await ev(() => window.setMode('markdown'))
  await ev(() => window.numbers([1, 3, 6]))
  const md = await ev(() => ({ margin: document.querySelectorAll('.cm-plain-margin').length, numbers: [...document.querySelectorAll('.cm-gutter.cm-lineNumbers .cm-gutterElement')].map((e) => e.textContent).filter((t) => /^\d+$/.test(t)), text: window.domText(), chips: document.querySelectorAll('.cm-trigger-chip, .cm-id-chip').length, bullets: document.querySelectorAll('.cm-plain-bullet').length, display: getComputedStyle(document.querySelector('.cm-gutter.cm-lineNumbers')).display }))
  assert.equal(md.margin, 0, 'Markdown has no margin gutter')
  assert.notEqual(md.display, 'none')
  assert.ok(md.numbers.includes('1') && md.numbers.includes('2') && md.numbers.includes('3'), 'Markdown shows the slide-number gutter: ' + md.numbers)
  for (const want of ['{iconlist}', '{id=one}', '{id=sec-a}', '{statement}', '{orphan}', '{id=s1}', '{icon=lucide:bike}', '- item one']) assert.ok(md.text.includes(want), 'Markdown shows ' + want)
  assert.ok(md.chips >= 8, 'Markdown shows the chips: ' + md.chips)
  assert.equal(md.bullets, 0, 'Markdown keeps the typed list mark')
  assert.deepEqual(await ev(() => window.regions()), [], 'no hidden spans in Markdown')

  // ---------------------------------------------------------------- hidden lines and tokens
  await open()
  const dom = await ev(() => window.domText())
  for (const gone of ['{iconlist}', '{id=one}', '{id=sec-a}', '{statement}', '{id=s1}', '{id=s2}', '{id=talk}']) assert.ok(!dom.includes(gone), gone + ' is hidden in Plain')
  assert.ok(dom.includes('{icon=lucide:bike}'), 'an icon token stays visible')
  // Ticket 11: a layout line among the body is one the compiler removes too, and is hidden.
  assert.ok(!dom.includes('{orphan}'), 'a layout line among the body is hidden')
  assert.equal(await ev(() => window.lineBox('{orphan}')), null, 'and has no row')
  const heading = await ev(() => window.lineBox('Slide one')), body = await ev(() => window.lineBox('First body line'))
  assert.ok(body.top - heading.bottom < 2, 'no gap where the layout lines were: ' + (body.top - heading.bottom))
  assert.equal(await text(), doc, 'hiding changes no text')

  // The caret never rests inside one.
  const h6End = await at(6, 'Slide one {id=s1}'.length + 4) // end of line 6
  const visibleEnd6 = await at(6, '### Slide one'.length) // the end of the title text, before the space and the hidden {id=s1}
  const body9 = await at(9)
  await caret(visibleEnd6)
  await page.keyboard.press('ArrowRight')
  assert.equal((await sel())[1], body9, 'ArrowRight at the end of the heading text steps over the tokens and layout lines')
  await page.keyboard.press('ArrowLeft')
  assert.equal((await sel())[1], visibleEnd6, 'ArrowLeft from the next line returns to the end of the heading text')
  await page.keyboard.press('ArrowDown')
  assert.equal((await sel())[0], (await sel())[1], 'ArrowDown makes a caret: ' + (await sel()))
  assert.ok((await sel())[1] >= body9, 'ArrowDown from the heading lands on the next visible line, not in a hidden one')
  await page.keyboard.press('ArrowUp')
  assert.ok((await sel())[1] <= visibleEnd6, 'ArrowUp returns to the heading')
  for (const [name, pos] of [['inside the layout line', (await at(7, 3))], ['inside the id line', (await at(8, 2))], ['inside the heading id token', visibleEnd6 + 4], ['at the heading end after the tokens', h6End - 4]]) {
    await caret(await at(9))
    await caret(pos)
    const [a, h] = await sel()
    const regions = await ev(() => window.regions())
    assert.ok(!regions.some(([k, f, t]) => (k === 'run' ? h > f && h < t : h > f && h <= t)), `programmatic caret ${name} was moved out: ${h} vs ${JSON.stringify(regions)}`)
    assert.equal(a, h, name + ' anchor ' + a + ' head ' + h + ' wanted ' + pos)
  }
  // A click to the right of the heading text lands at its visible end.
  const box = await ev(() => window.lineBox('Slide one'))
  await page.mouse.click(box.right - 30, (box.top + box.bottom) / 2)
  assert.deepEqual(await sel(), [visibleEnd6, visibleEnd6], 'a click past the heading text is a caret at the end of the title text, before its hidden tokens')
  assert.ok(!(await ev(() => window.domText())).includes('{id=s1}'), 'and the tokens stay hidden')

  // Typing never changes a hidden line.
  await caret(visibleEnd6)
  await page.keyboard.type('s are great')
  let after = (await text()).split('\n')
  assert.equal(after[5], '### Slide ones are great {id=s1}', 'typing at the heading end goes before the space and the tokens')
  assert.deepEqual([after[6], after[7]], ['{iconlist}', '{id=one}'], 'the hidden lines are untouched')
  await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace')
  for (let i = 0; i < 9; i++) await page.keyboard.press('Backspace')
  assert.equal((await text()).split('\n')[5], '### Slide one {id=s1}')
  // A change that strikes into a hidden line is applied exactly as asked: Plain cancels nothing.
  const hiddenAt = await at(7, 2)
  await ev(([s]) => window.userEdit(s, 'input.type'), [{ from: hiddenAt, insert: 'zz' }])
  assert.equal(await text(), doc.replace('{iconlist}', '{izzconlist}'), 'an insertion inside a hidden line is applied where it was asked for')
  await open()

  // Backspace at the start of the first visible line after the hidden lines: no-op.
  await caret(body9)
  await page.keyboard.press('Backspace')
  assert.equal(await text(), doc, 'Backspace at the start of the next visible line is a no-op: it joins nothing into the hidden line')
  assert.equal((await sel())[1], body9)
  // Delete at the heading's visible end is a no-op too.
  await caret(visibleEnd6)
  await page.keyboard.press('Delete')
  assert.equal(await text(), doc, 'Delete at the heading end does not eat the tokens or the layout lines')
  // The same holds for a heading with a tail but no layout line (slide two: Backspace at "Body two").
  await caret(await at(15))
  await page.keyboard.press('Backspace')
  assert.equal(await text(), doc, 'Backspace at the start of the line under a heading with hidden tokens is a no-op')

  // Enter in a title is the app's "Enter from a title": the caret goes to the first body line,
  // from the end of the title text and from the middle of it; the document is not changed.
  for (const [where, pos] of [['the end of the title text', visibleEnd6], ['the middle of the title', await at(6, 8)]]) {
    await caret(pos)
    await page.keyboard.press('Enter')
    assert.equal(await text(), doc, 'Enter at ' + where + ' changes nothing')
    assert.equal((await sel())[1], body9, 'Enter at ' + where + ' puts the caret on the first body line')
  }
  // The talk title (`#`) with a hidden token: Plain gives it the same rule (sixth fix round, second
  // ruling). The caret goes to the line under it, which is empty already; nothing is added.
  await caret(await at(1, '# Ten years of bike hire'.length))
  await page.keyboard.press('Enter')
  let lines = (await text()).split('\n')
  assert.deepEqual(lines.slice(0, 3), ['# Ten years of bike hire {id=talk}', '', '## Section A'], 'Enter at the end of the talk title keeps its token on it and adds no line')
  assert.equal((await sel())[1], await at(2, 0), 'and puts the caret on the line under it')

  // A delete that covers the heading line but not its hidden lines is applied as asked: nothing is
  // extended to take them, nothing is cancelled. (Without idProtect, whose own guard refuses to
  // delete a heading on its own in both modes: this shows Plain's filters by themselves.)
  await open(doc, 'plain', false)
  await ev(() => window.userEdit({ from: window.lineFrom(6), to: window.lineTo(6) + 1 }, 'delete'))
  assert.equal(await text(), doc.replace('### Slide one {id=s1}\n', ''), 'a delete of the heading line removes that line and nothing more')
  await open(doc, 'plain', false)
  await ev(() => window.userEdit({ from: window.lineFrom(6) + 4, to: window.lineTo(6) + 1 }, 'delete'))
  assert.equal(await text(), doc.replace('### Slide one {id=s1}\n', '### '), 'a delete from inside the heading text through its line break is applied as asked')
  // With idProtect: a selection over the whole slide (heading to the next heading) removes the hidden lines with it.
  await open()
  await ev(() => window.caret(window.lineFrom(6), window.lineFrom(14)))
  await page.keyboard.press('Backspace')
  lines = (await text()).split('\n')
  assert.ok(!lines.some((l) => /Slide one|iconlist|id=one|id=s1/.test(l)), 'deleting a selection over the whole slide removes its hidden lines: ' + lines.slice(3, 8))
  // The whole slide, as Delete-slide does it, removes them.
  await open()
  await ev(() => window.userEdit({ from: window.lineFrom(6), to: window.lineFrom(14) }, 'delete.slide'))
  assert.ok(!(await text()).includes('{iconlist}'))

  // Find reveals a hidden line while a match in it is selected.
  await open()
  await ev(() => window.selectMatch('iconlist'))
  assert.ok((await ev(() => window.domText())).includes('{iconlist}'), 'Find reveals the hidden layout line')
  assert.ok(!(await ev(() => window.domText())).includes('{id=one}'), 'only the line with the match')
  await caret(await at(20))
  assert.ok(!(await ev(() => window.domText())).includes('{iconlist}'), 'it hides again when the match is no longer selected')
  await ev(() => window.selectMatch('id=s1'))
  assert.ok((await ev(() => window.domText())).includes('{id=s1}'), 'Find reveals a hidden heading token')

  // Slide Focus composes: the slide's own lines stay hidden, outside lines stay out, no errors.
  await open()
  const f = await ev(() => [window.lineFrom(6), window.lineFrom(14) - 1])
  await ev(([a, b]) => window.focusBlock(a, b), f)
  const focused = await ev(() => window.domText())
  assert.ok(focused.includes('Slide one') && focused.includes('First body line'), 'the focused slide shows')
  assert.ok(!focused.includes('Slide two') && !focused.includes('Section A'), 'outside lines are hidden by Slide Focus')
  assert.ok(!focused.includes('{iconlist}') && !focused.includes('{id=s1}'), 'its layout line and tokens stay hidden under focus')
  assert.deepEqual((await ev(() => window.margin())).map((x) => [x.kind, x.line]), [['slide', 6]], 'the margin shows only the slide label')
  await page.keyboard.press('Control+End')
  await ev(() => window.caret(window.lineFrom(18)))
  assert.ok((await sel())[1] <= f[1], 'the caret stays in the band')
  const last = await ev(() => window.focusBlock(window.lineFrom(18), window.docText().length))
  assert.ok((await ev(() => window.domText())).includes('Slide three') && !(await ev(() => window.domText())).includes('{statement}'), 'a heading that is the band edge hides its layout line')
  await ev(() => window.focusBlock(null))
  assert.equal(errors.length, 0, 'no page errors (decorations compose): ' + errors.join(' | '))

  // A layout line typed by hand stays visible while the caret is on it, and hides when it leaves.
  await open('### Fresh slide\n\nBody here\n')
  await caret(await at(1, 15))
  await page.keyboard.press('Enter')                // the app's Enter from a title: onto the empty line under it
  await page.keyboard.type('{cards}')
  let typed = await ev(() => window.domText())
  assert.ok(typed.includes('{cards}'), 'the layout line is visible while the caret is on it')
  await page.keyboard.press('ArrowDown')
  typed = await ev(() => window.domText())
  assert.ok(!typed.includes('{cards}'), 'it hides when the caret leaves it')
  assert.equal(await text(), '### Fresh slide\n{cards}\nBody here\n', 'the text is exactly what was typed')
  await page.keyboard.press('ArrowUp')
  assert.ok(!(await ev(() => window.domText())).includes('{cards}'), 'arrowing back up does not land in it')

  // ---------------------------------------------------------------- list marks
  await open()
  await caret(await at(10, 3))   // caret on the first item
  let bullets = await ev(() => ({ n: document.querySelectorAll('.cm-plain-bullet').length, line10: window.lineBox('item one'), text: window.domText() }))
  assert.equal(bullets.n, 2, 'both unordered items show a bullet, on and off the caret line')
  assert.ok(bullets.line10.html.includes('•'))
  assert.ok(!/(^|\n)- item/.test(bullets.text), 'no typed dash is shown')
  assert.ok(bullets.text.includes('1. numbered'), 'ordered marks show as typed')
  assert.equal(await text(), doc)
  await caret(await at(13))
  await page.keyboard.type('- ')
  await page.keyboard.type('fresh')
  assert.equal((await text()).split('\n')[12], '- fresh', 'typing "- " still starts a list item')
  assert.equal(await ev(() => document.querySelectorAll('.cm-plain-bullet').length), 3)
  await page.keyboard.press('Enter')
  assert.equal((await text()).split('\n')[13], '- ', 'Enter continues the list')
  await page.keyboard.press('Backspace')

  // Ticket 07, fix rounds 2 and 3: every transaction goes through this filter with its changes,
  // annotations and effects exactly as given, whoever made it (a remote one, the app's own code
  // with no user event, the person). The one thing added is a settled selection: a caret that
  // would rest inside a heading's hidden tokens rests at the end of the title text instead.
  {
    const d = '# T\n\n### A {id=a1}\n{statement}\n\nBody\n'
    await open(d, 'plain', false)
    const a = d.indexOf('### A') + 5 // the end of the heading's visible text
    const inTail = d.indexOf('{id=a1}') + 3
    const split = d.slice(0, a) + '\n' + d.slice(a)
    for (const [label, extra] of [['remote', { remote: true }], ['remote, tagged input', { remote: true, event: 'input.type' }], ['no user event', {}], ['typed', { event: 'input.type' }], ['pasted', { event: 'input.paste' }]]) {
      const got = await ev((spec) => window.filtered(spec), { changes: { from: a, insert: '\n' }, selection: inTail + 1, ...extra })
      assert.deepEqual(got, { doc: split, head: inTail + 1, remote: !!extra.remote, event: extra.event ?? null, marks: 1 }, label + ': a line break put in the title lands where it was put; annotations and effects are intact')
      const sel = await ev((spec) => window.filtered(spec), { selection: inTail, ...extra })
      assert.deepEqual(sel, { doc: d, head: a, remote: !!extra.remote, event: extra.event ?? null, marks: 1 }, label + ': a caret inside a hidden token is settled to the end of the title text; the rest is intact')
      const del = await ev((spec) => window.filtered(spec), { changes: { from: inTail, to: inTail + 2 }, ...extra })
      assert.equal(del.doc, d.slice(0, inTail) + d.slice(inTail + 2), label + ': a change inside a hidden span is applied')
      assert.deepEqual([del.remote, del.event, del.marks], [!!extra.remote, extra.event ?? null, 1])
    }
    const found = await ev((spec) => window.filtered(spec), { selection: inTail, event: 'select.search' })
    assert.equal(found.head, inTail, 'a Find selection is not settled')
    const composed = await ev((spec) => window.filtered(spec), { selection: inTail, event: 'input.type.compose' })
    assert.equal(composed.head, inTail, 'composition is not settled')
  }

  assert.equal(errors.length, 0, 'no page errors: ' + errors.join(' | '))
  assert.deepEqual([...new Set(await ev(() => window.__caught))], [], 'no exception that CodeMirror caught')
  console.log('plain view margin and hidden lines: ok')
} finally {
  await browser.close()
  rmSync(dir, { recursive: true, force: true })
}
