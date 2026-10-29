// The chat, terminal and trace row editor's browse state and paste (objects/card-editors.ts, the table
// editor's pattern): Esc in a field selects its row and a second Esc leaves; ↑↓ move the selection; ↵
// or a typed character edits the row again. A paste while browsing that is made only of labelled turns
// (prompt lines, trace headers) becomes those rows after the selected one, written as pasted when the
// body takes them as they are; anything else goes into the selected row's text exactly as pasted, so
// unknown labels and plain text are never coerced into turns. DOM shim; nothing on screen.
import { strict as assert } from 'node:assert'
import { installTestDom, TestEvent } from './test-dom.mjs'
import { compiledRowCount } from '../compiler/scripts/lib/simulation-reading.mjs'

installTestDom()
// The shim's elements are not textarea instances; the rows editor only uses the type to auto-size.
globalThis.HTMLTextAreaElement ??= class {}
const { mountRowsEditor } = await import('../src/renderer/src/objects/card-editors.ts')

let passed = 0
const test = async (name, fn) => { await fn(); passed += 1; console.log(`  ✓ ${name}`) }
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const key = (target, k, init = {}) => target.dispatchEvent(new TestEvent('keydown', { key: k, ...init }))
const paste = (target, text) => target.dispatchEvent(new TestEvent('paste', { clipboardData: { getData: () => text } }))
const field = (editor, row, name) => editor.element.querySelectorAll('[data-field]').find((f) => f.dataset.row === String(row) && f.dataset.field === name)
const selected = (editor) => editor.element.querySelectorAll('div').findIndex((d) => d.className === 'oe-row oe-row-sel')
const rowsOf = (editor) => editor.element.querySelectorAll('div').filter((d) => /^oe-row( |$)/.test(d.className) && !d.className.includes('preamble'))

const CHAT = 'user: one\nbot: two\nuser: three'

await test('Esc in a field selects its row; Esc again is not taken (the editor leaves)', async () => {
  const editor = mountRowsEditor('turns', CHAT)
  field(editor, 1, 'content').focus()
  assert.equal(editor.onEscape(), true)
  assert.equal(rowsOf(editor)[1].className, 'oe-row oe-row-sel')
  assert.equal(editor.onEscape(), false)
})
await test('↑↓ move the selection within the rows; ↵ edits the selected row again', async () => {
  const editor = mountRowsEditor('turns', CHAT)
  field(editor, 0, 'content').focus()
  editor.onEscape()
  key(editor.element, 'ArrowDown'); key(editor.element, 'ArrowDown'); key(editor.element, 'ArrowDown')
  assert.equal(rowsOf(editor)[2].className, 'oe-row oe-row-sel')
  key(editor.element, 'ArrowUp')
  assert.equal(rowsOf(editor)[1].className, 'oe-row oe-row-sel')
  key(editor.element, 'Enter')
  await tick()
  assert.equal(selected(editor), -1)
  assert.equal(document.activeElement, field(editor, 1, 'content'))
  assert.equal(editor.serialise(), CHAT, 'browsing writes nothing')
})
await test('a typed character edits the selected row, after its text', async () => {
  const editor = mountRowsEditor('turns', CHAT)
  field(editor, 0, 'content').focus()
  editor.onEscape()
  key(editor.element, '!')
  await tick()
  assert.equal(editor.serialise(), 'user: one!\nbot: two\nuser: three')
})
await test('a paste of labelled turns adds them, as pasted, after the selected row', async () => {
  const editor = mountRowsEditor('turns', CHAT)
  field(editor, 0, 'content').focus()
  editor.onEscape()
  paste(editor.element, 'bot: pasted answer\n  with a second line\nuser: and a question\n')
  const out = editor.serialise()
  assert.equal(out, 'user: one\nbot: pasted answer\n  with a second line\nuser: and a question\nbot: two\nuser: three')
  assert.equal(compiledRowCount('turns', out), 5)
  assert.equal(editor.refusal(out), null, 'the deck reads the rows the editor holds')
})
await test('plain text, or text with unknown labels, goes into the selected row exactly as pasted', async () => {
  for (const text of ['Just a sentence: with a colon', 'assistant: not a label here\nnor here', 'intro line\nuser: after text']) {
    const editor = mountRowsEditor('turns', CHAT)
    field(editor, 1, 'content').focus()
    editor.onEscape()
    paste(editor.element, text)
    await tick()
    const out = editor.serialise()
    assert.ok(out.includes(`bot: two\n${text}`), JSON.stringify(out))
    assert.equal(rowsOf(editor).length, 3, 'no row was made from it')
  }
})
await test('in an empty chat, plain text goes before the first turn, kept as written', async () => {
  const editor = mountRowsEditor('turns', '')
  paste(editor.element, 'not a turn')
  assert.equal(editor.serialise(), '', 'not browsing: the paste is the field’s own')
})
await test('a terminal: pasted prompt lines become commands; other text becomes the selected command’s output', async () => {
  const editor = mountRowsEditor('shell', '~ $ ls\nfile.txt')
  field(editor, 0, 'command').focus()
  editor.onEscape()
  paste(editor.element, '~ $ cat file.txt\nhello\n')
  assert.equal(compiledRowCount('shell', editor.serialise()), 2)
  const other = mountRowsEditor('shell', '~ $ ls\nfile.txt')
  field(other, 0, 'command').focus()
  other.onEscape()
  paste(other.element, 'more output')
  assert.equal(other.serialise(), '~ $ ls\nfile.txt\nmore output')
})
await test('an indented or CRLF body gets pasted rows in its own indent and line ending', async () => {
  const body = '  user: one\r\n  bot: two'
  const editor = mountRowsEditor('turns', body)
  field(editor, 1, 'content').focus()
  editor.onEscape()
  paste(editor.element, 'user: three')
  const out = editor.serialise()
  assert.equal(out, '  user: one\r\n  bot: two\r\n  user: three')
  assert.equal(compiledRowCount('turns', out), 3)
})
await test('a turn added after the last one in a CRLF body leaves no LF line behind (+ Add turn)', async () => {
  const editor = mountRowsEditor('turns', 'user: one\r\nbot: two')
  editor.element.querySelectorAll('button').find((b) => b.textContent === '+ Add turn').dispatchEvent(new TestEvent('click'))
  assert.equal(editor.serialise(), 'user: one\r\nbot: two\r\nuser:')
})

await test('a chat the deck reads as different turns than rows would show opens on its lines as written', async () => {
  const { mountCardEditor } = await import('../src/renderer/src/objects/card-editors.ts')
  const { textareaEditor } = await import('../src/renderer/src/objects/shell.ts')
  const { detectOutlineObjects } = await import('../src/renderer/src/extensions/objectBlocks/detect.ts')
  const { cardKind } = await import('../src/shared/objects/card-kinds.ts')
  const api = { preflight: () => ({ ok: true }), commit: () => ({ ok: true }) }
  const open = (inner) => {
    const block = detectOutlineObjects(`# T\n\n## S\n\n\`\`\`chat\n${inner}\n\`\`\`\n`).blocks.find((b) => b.kind === 'chat')
    return mountCardEditor(block, cardKind('chat'), inner, textareaEditor(inner), api, undefined, (x) => x)
  }
  const classes = (node) => [node.className, ...(node.children ?? []).flatMap(classes)]
  assert.ok(classes(open('user: one\nbot: two')).some((c) => /\boe-rows\b/.test(c)), 'rows for an ordinary chat')
  const odd = open('user: one\nnote\rbot: hidden\nbot: two')
  assert.ok(!classes(odd).some((c) => /\boe-rows\b/.test(c)), 'no rows that mislead')
})

console.log(`\n${passed} row editor browse checks passed`)
