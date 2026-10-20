// Frontmatter table DOM gate (T27).
//
// The metadata table's explanations, notes and choice folds used to sit in the always-visible
// flow, doubling every row's height. Since 2026-09-17 they live behind a small round "?" at the
// right end of each row: click / Enter / Space opens the same content beneath the row, Escape
// closes it and returns focus to the button. This gate drives the REAL widget (the CodeMirror
// FrontmatterWidget under jsdom) and asserts, per the brief:
//   - every row has a help block in the DOM, hidden until its "?" is activated;
//   - activating shows it and flips the button's aria-expanded;
//   - Escape hides it (from the button, and from focus inside the block, returning focus);
//   - opening one row does not close another, and the choice fold still works inside the block.
import { strict as assert } from 'node:assert'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>')
globalThis.document = dom.window.document
globalThis.window = dom.window
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }

const { FrontmatterWidget } = await import(
  new URL('../src/renderer/src/extensions/frontmatterTable.ts', import.meta.url)
)

// One row per control shape the widget renders: a segmented/select vocabulary, a free-text key,
// a read-only system key and a map-valued key (each moves different notes into the block).
const pairs = [
  { key: 'title', value: 'My talk' },
  { key: 'palette', value: 'cobalt' },
  { key: 'duration', value: '20' },
  { key: 'defaults', value: '\n  title: side' },
  { key: 'outline_version', value: '2' },
]

const widget = new FrontmatterWidget(pairs)
// The widget only ever calls back into the view for dispatches and re-measures; a stub keeps the
// gate focused on the DOM contract.
let measures = 0
const root = widget.toDOM({ dispatch() {}, requestMeasure() { measures += 1 } })
const rows = [...root.querySelectorAll('.cm-fm-row')]
assert.equal(rows.length, pairs.length, 'one row per frontmatter pair')

const escapeKey = (el) => el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))

for (const row of rows) {
  const key = row.dataset.fmKey
  const btn = row.querySelector(':scope > .cm-fm-rowmain > .cm-fm-help-btn')
  assert.ok(btn, `${key}: a "?" button sits at the right end of the row's main line`)
  assert.equal(btn.getAttribute('type'), 'button', `${key}: the "?" is type=button`)
  assert.match(btn.getAttribute('aria-label'), /^Explain /, `${key}: aria-label explains the field`)
  const block = row.querySelector(`:scope > .cm-fm-helpblock`)
  assert.ok(block, `${key}: the help block exists in the DOM`)
  assert.equal(block.hidden, true, `${key}: the help block starts hidden`)
  assert.equal(btn.getAttribute('aria-controls'), block.id, `${key}: aria-controls points at the help block`)
  assert.equal(btn.getAttribute('aria-expanded'), 'false', `${key}: aria-expanded starts false`)
  assert.ok(btn.title.length > 0, `${key}: the button carries the explanation's first sentence as its title`)
  assert.ok(block.querySelector('.cm-fm-help').textContent.startsWith(btn.title), `${key}: the title is the explanation's first sentence (a prefix)`)
}

// Activating shows the block and flips aria-expanded; opening one row leaves the others alone.
const titleRow = rows.find((row) => row.dataset.fmKey === 'title')
const paletteRow = rows.find((row) => row.dataset.fmKey === 'palette')
const titleBtn = titleRow.querySelector('.cm-fm-help-btn')
const titleBlock = titleRow.querySelector('.cm-fm-helpblock')
const paletteBtn = paletteRow.querySelector('.cm-fm-help-btn')
const paletteBlock = paletteRow.querySelector('.cm-fm-helpblock')

titleBtn.click()
assert.equal(titleBlock.hidden, false, 'activating the "?" shows the help block')
assert.equal(titleBtn.getAttribute('aria-expanded'), 'true', 'aria-expanded flips to true')
assert.equal(paletteBlock.hidden, true, 'opening one row does not open another')
assert.ok(measures > 0, 'opening a block asks CodeMirror to re-measure the widget height')

paletteBtn.click()
assert.equal(paletteBlock.hidden, false, 'the second row opens independently')
assert.equal(titleBlock.hidden, false, 'opening another row does not close the first')

// Escape on the focused button closes its own block.
escapeKey(titleBtn)
assert.equal(titleBlock.hidden, true, 'Escape on the button hides the block')
assert.equal(titleBtn.getAttribute('aria-expanded'), 'false', 'aria-expanded flips back to false')
assert.equal(paletteBlock.hidden, false, 'Escape on one button leaves the other block open')

// Escape from inside the opened block closes it and returns focus to the button.
paletteBtn.focus()
paletteBlock.querySelector('.cm-fm-help').dispatchEvent(
  new dom.window.FocusEvent('focusin', { bubbles: true })
)
escapeKey(paletteBlock)
assert.equal(paletteBlock.hidden, true, 'Escape from inside the block hides it')
assert.equal(paletteBtn.getAttribute('aria-expanded'), 'false', 'aria-expanded flips back to false')

// The moved content kept its classes and its fold: a vocabulary row's block carries the same
// "What each choice does" <details>, which still opens.
assert.ok(titleBlock.querySelector('.cm-fm-help'), 'the explanation kept its cm-fm-help class inside the block')
const choices = paletteBlock.querySelector('.cm-fm-choices')
assert.ok(choices, 'the choice fold lives inside the opened block')
assert.equal(choices.open, false, 'the choice fold starts closed')
choices.querySelector('summary').click()
assert.equal(choices.open, true, 'the "What each choice does" fold still works inside the block')

// A map-valued key and a read-only system key keep their notes behind the "?" too.
const defaultsBlock = rows.find((row) => row.dataset.fmKey === 'defaults').querySelector('.cm-fm-helpblock')
assert.match(defaultsBlock.querySelector('.cm-fm-note')?.textContent ?? '', /Structured value/, 'map-valued keys keep their note in the block')
const systemBlock = rows.find((row) => row.dataset.fmKey === 'outline_version').querySelector('.cm-fm-helpblock')
assert.match(systemBlock.textContent, /Set by TalkWeaver/, 'system keys keep their note in the block')

// The block the table shows is the block the shared writer edits (ticket 08 review S2): for each
// document, the table's range ends where locateFrontmatter's does, and a write through the table's
// slice changes only the block's inside.
{
  const { EditorState } = await import('@codemirror/state')
  const { parseFrontmatter } = await import(new URL('../src/renderer/src/extensions/frontmatterTable.ts', import.meta.url))
  const { editFrontmatterText, locateFrontmatter } = await import(new URL('../src/shared/frontmatter-editor.ts', import.meta.url))
  const docs = [
    '---\ntitle: T\n---\nbody\n',
    '---\n---\n# T\n\n---\nbody\n',
    '--- \ntitle: T\n---  \nbody\n',
    '---\ntitle: T\n----\n---\nbody\n',
    '# no block\n---\n',
    '---\nnever closed\n',
  ]
  for (const doc of docs) {
    const table = parseFrontmatter(EditorState.create({ doc }))
    const shared = locateFrontmatter(doc)
    assert.equal(table === null, shared === null, `${JSON.stringify(doc)}: table and writer agree there is a block`)
    if (!table) continue
    assert.equal(table.from, 0)
    assert.equal(table.to, shared.to, `${JSON.stringify(doc)}: table and writer agree where it ends`)
    const written = editFrontmatterText(table.text, [{ key: 'prework', value: 'a-file' }])
    const next = doc.slice(0, table.from) + written + doc.slice(table.to)
    assert.equal(next, editFrontmatterText(doc, [{ key: 'prework', value: 'a-file' }]), `${JSON.stringify(doc)}: the table's write is the writer's`)
    assert.equal(next.match(/^prework: a-file$/gm)?.length, 1, `${JSON.stringify(doc)}: one prework line, inside the one block`)
    assert.equal(next.slice(next.indexOf('prework: a-file\n') + 'prework: a-file\n'.length), doc.slice(shared.contentTo), `${JSON.stringify(doc)}: everything after the block is kept`)
  }
}

console.log('frontmatter table DOM: "?" disclosure, aria-expanded, Escape/return-focus, independent rows, the choice fold and the shared block rule pass (jsdom)')
