// Review regressions use synthetic rows only.
import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSimulationTurns } from '../compiler/scripts/lib/simulation-layout.mjs'
import { splitTurnSegments, serialiseSegments } from '../compiler/scripts/lib/simulation-segments.mjs'
import { compiledRowCount } from '../compiler/scripts/lib/simulation-reading.mjs'
import { installTestDom, TestEvent } from './test-dom.mjs'
installTestDom()
globalThis.HTMLTextAreaElement ??= class {}
const { mountRowsEditor } = await import('../src/renderer/src/objects/card-editors.ts')
const rowsOf = (text) => parseSimulationTurns(text, { version: 2 }).exchanges.flatMap((ex) => ex.parts).map((part) => part.row)

test('ordinary turn prose stays in its row without warnings or extra steps', () => {
  const body = 'turn user "You": Question\nturn answer "Agent": Directions\nturn left at the junction\nTURN THE PAGE\nturn thought missing-quote: literal prose'
  const parsed = parseSimulationTurns(body, { version: 2 })
  assert.equal(rowsOf(body).length, 2)
  assert.equal(compiledRowCount('turns', body, { version: 2 }), 2)
  assert.equal(splitTurnSegments(body, { version: 2 }).rows.length, 2)
  assert.deepEqual(parsed.warnings, [])
  assert.match(rowsOf(body)[1].body, /turn left at the junction\nTURN THE PAGE\nturn thought missing-quote/)
})

test('intended but invalid headers warn and remain body text', () => {
  for (const [line, code] of [['turn thought "Missing colon"', 'sim-turn-invalid-header'], ['turn other "Unknown": preserve this', 'sim-turn-unknown-kind']]) {
    const body = `turn answer "Agent": Directions\n${line}`
    assert.equal(rowsOf(body).length, 1)
    assert.match(rowsOf(body)[0].body, new RegExp(line))
    assert.equal(splitTurnSegments(body, { version: 2 }).rows.length, 1)
    assert.equal(parseSimulationTurns(body, { version: 2 }).warnings[0][0], code)
  }
})

test('invalid editor kinds refuse and keep original source', () => {
  const body = 'turn thought "Thought": original'
  const editor = mountRowsEditor('turns', body, undefined, 2)
  const role = editor.element.querySelector('[data-field="role"]')
  role.value = 'invalid'
  role.dispatchEvent(new TestEvent('change'))
  assert.match(editor.refusal(editor.serialise()), /unsupported.*kind/i)
  assert.equal(editor.serialise(), body)
  const split = splitTurnSegments(body, { version: 2 })
  const invalid = { ...split.rows[0], original: split.rows[0], role: 'invalid', content: 'edited' }
  assert.equal(serialiseSegments('turns', body, split, [invalid]), body)
  // Defensive handling of a row produced by the former permissive header reader.
  const malformed = 'turn thought missing-quote: original'
  const old = { ...invalid, role: 'invalid', label: 'Invalid turn', lines: [malformed], content: malformed }
  assert.equal(serialiseSegments('turns', malformed, { ...split, rows: [old] }, [{ ...old, original: old, content: 'edited' }]), malformed)
})

test('detail fields accept trailing whitespace and two-column tabs', () => {
  for (const [field, content] of [['  detail:  \t', '    first'], ['\tdetail:\t', '\t\tfirst'], [' \tdetail: ', ' \t  first']]) {
    // One space plus a tab is three columns and stays literal rather than a field.
    const body = `turn thought "Thought": summary\n${field}\n${content}`
    const row = rowsOf(body)[0]
    const split = splitTurnSegments(body, { version: 2 })
    assert.equal(row.detail, field.startsWith(' \t') ? '' : 'first')
    assert.equal(split.rows[0].detail, row.detail)
    assert.equal(serialiseSegments('turns', body, split, [{ ...split.rows[0], original: split.rows[0] }]), body)
  }
})


test('editing a row keeps literal field names with trailing whitespace', () => {
  const body = 'turn thought "Thought": summary\n  \\detail:  \t\n  \\object: \t'
  const split = splitTurnSegments(body, { version: 2 })
  const row = split.rows[0]
  const source = serialiseSegments('turns', body, split, [{ ...row, original: row, label: 'Edited' }])
  const reread = splitTurnSegments(source, { version: 2 }).rows[0]
  assert.equal(reread.content, row.content)
  assert.equal(reread.detail, '')
  assert.deepEqual(parseSimulationTurns(source, { version: 2 }).warnings, [])
})
