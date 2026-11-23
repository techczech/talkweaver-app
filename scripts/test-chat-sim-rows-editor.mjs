import assert from 'node:assert/strict'
import { installTestDom, TestEvent } from './test-dom.mjs'
import { ROWS } from './fixtures/chat-sim-rows/scenario.mjs'
import { splitTurnSegments } from '../compiler/scripts/lib/simulation-segments.mjs'
import { ObjectWidget } from '../src/renderer/src/extensions/objectBlocks/widgets.ts'
import { ObjectEditorWidget } from '../src/renderer/src/extensions/objectBlocks/field.ts'
installTestDom()
globalThis.HTMLTextAreaElement ??= class {}
const { mountRowsEditor } = await import('../src/renderer/src/objects/card-editors.ts')
const { detectOutlineObjects } = await import('../src/renderer/src/extensions/objectBlocks/detect.ts')
const editor = mountRowsEditor('turns', ROWS, undefined, 2)
assert.equal(editor.serialise(), ROWS)
assert.equal(editor.refusal(ROWS), null)
const field = (name, index) => editor.element.querySelectorAll(`[data-field="${name}"]`)[index]
const edit = (name, index, value) => { const input = field(name, index); input.value = value; input.dispatchEvent(new TestEvent('input')) }
assert.equal(field('label', 1).value, 'Thought for 3 s')
edit('label', 1, 'Checked the inputs')
edit('content', 1, 'Same group size.\nuser: literal, not another row')
edit('detail', 1, 'Forty people for each quote.\n  Keep indentation.')
let result = editor.serialise()
assert.equal(editor.refusal(result), null)
let rows = splitTurnSegments(result, { version: 2 }).rows
assert.equal(rows.length, 7)
assert.equal(rows[1].label, 'Checked the inputs')
assert.equal(rows[1].detail, 'Forty people for each quote.\n  Keep indentation.')
assert.equal(rows[2].lines.join('\n'), splitTurnSegments(ROWS, { version: 2 }).rows[2].lines.join('\n'))
const menu = editor.element.querySelectorAll('select').filter((x) => x.className === 'oe-row-menu')[1]
menu.value = 'down'; menu.dispatchEvent(new TestEvent('change'))
result = editor.serialise()
assert.equal(editor.refusal(result), null)
assert.equal(splitTurnSegments(result, { version: 2 }).rows[2].label, 'Checked the inputs')
const add = editor.element.querySelectorAll('button').find((x) => x.textContent === '+ Add turn')
add.dispatchEvent(new TestEvent('click'))
assert.equal(splitTurnSegments(editor.serialise(), { version: 2 }).rows.length, 8)
assert.equal(editor.refusal(editor.serialise()), null)
const outline = `# Synthetic\n\n## Examples\n\n### Native\n{chat sim-version=2}\n\n\`\`\`chat\n${ROWS}\n\`\`\`\n`
const card = detectOutlineObjects(outline).blocks.find((x) => x.kind === 'chat')
assert.equal(card.simulationVersion, 2)
const legacy = detectOutlineObjects(outline.replace(' sim-version=2', '')).blocks.find((x) => x.kind === 'chat')
assert.equal(legacy.simulationVersion, undefined)
// The trigger can change while the fence's source/range stays identical. Both the card and its
// editor must be rebuilt so they do not retain a parser from the previous format.
const sameSourceLegacy = { ...card, simulationVersion: undefined }
assert.equal(new ObjectWidget(card, false, false).eq(new ObjectWidget(sameSourceLegacy, false, false)), false)
assert.equal(new ObjectEditorWidget(card).eq(new ObjectEditorWidget(sameSourceLegacy)), false)
assert.equal(new ObjectEditorWidget(card).eq(new ObjectEditorWidget({ ...card })), true)
console.log('PASS native row editor: no-op, sibling bytes, fields, move/add, and compiler version routing')
