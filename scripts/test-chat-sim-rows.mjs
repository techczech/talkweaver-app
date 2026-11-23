// Synthetic native rows: parser, source-preserving editing and legacy rendering contract.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseSimulationTurns, annotateSimulationLayout, renderSimulation, simulationStatic } from '../compiler/scripts/lib/simulation-layout.mjs'
import { splitTurnSegments, serialiseSegments } from '../compiler/scripts/lib/simulation-segments.mjs'
import { compiledRowCount } from '../compiler/scripts/lib/simulation-reading.mjs'

import { ROWS } from './fixtures/chat-sim-rows/scenario.mjs'
export function renderRows(text = ROWS, attrs = { 'sim-version': '2', reveal: 'steps', sidebar: 'off', size: 'large' }, design = 'chat') {
  const block = { type: 'code', lang: 'chat', text }
  const warnings = []
  annotateSimulationLayout([block], design, attrs, { id: 'rows', title: 'Sample quotes' }, (w) => warnings.push(w))
  return { html: renderSimulation(block), warnings, block }
}
const native = parseSimulationTurns(ROWS, { version: 2 })
assert.equal(native.exchanges.flatMap((ex) => ex.parts).length, 7, 'each envelope is an independent row')
assert.deepEqual(native.warnings, [])
const parts = native.exchanges.flatMap((ex) => ex.parts)
assert.deepEqual(parts.map((p) => p.row.kind), ['user','thought','tool-call','tool-result','status','files','answer'])
assert.equal(parts[1].row.body, 'Check the inputs first.')
assert.equal(parts[1].row.detail, 'Use the same group size for each quote.')
assert.equal(parts[2].row.options.id, 'quotes')
assert.equal(parts[3].row.options.ref, 'quotes')
assert.equal(parts[5].row.body, 'sample-quotes/\n├─ cedar.md\n├─ harbour.md\n└─ grove.md')
const rowOf = (text) => parseSimulationTurns(text, { version: 2 }).exchanges[0].parts[0].row
const quoted = rowOf(String.raw`turn thought "Check: \"quote\" and \\ path" id="a:b c" open=on: summary`)
assert.equal(quoted.options.id, 'a:b c')
assert.match(quoted.label, /Check:/)
const reserved = rowOf('turn thought "Check": summary\n  \\detail:\n    literal\n  detail:\n    first\n      nested\n  continuation\n   detail:\n    not a field')
assert.equal(reserved.detail, 'first\n  nested')
assert.match(reserved.body, /detail:\n  literal/)
assert.match(reserved.body, /continuation\n detail:\n  not a field/)
assert.equal(rowOf('turn thought "Empty":\n  detail:\n').detail, '')
const bad = renderRows('turn thought "Supported": start\nturn other "Unsupported": <script>bad()</script>\n  detail:\n    first\n  detail:\n    second')
assert.match(bad.warnings.join(), /sim-turn-unknown-kind/)
assert.match(bad.warnings.join(), /sim-turn-duplicate-field/)
assert.match(bad.html, /turn other &quot;Unsupported&quot;:/)
assert.match(bad.html, /&lt;script&gt;/)
assert.doesNotMatch(bad.html, /<script>/)
assert.match(renderRows('turn tool-result "Result" ref=missing: nope').warnings.join(), /sim-turn-unresolved-ref/)
assert.match(renderRows('turn status "One" id=x: start\nturn status "Two" id=x: end').warnings.join(), /sim-turn-duplicate-id/)
assert.match(renderRows('turn files "Object": x\n  object:\n    [embed: nope.html]').warnings.join(), /sim-turn-object-unsupported/)
assert.match(renderRows('turn answer "Agent": start\nturn thought "Missing colon" source preserved').warnings.join(), /sim-turn-invalid-header/)
assert.match(renderRows('turn answer "Agent": start\nturn thought "Missing colon" source preserved').html, /source preserved/)
assert.match(renderRows('turn tool-call "Call" id=x: tool\nturn status "Status" ref=x: message').warnings.join(), /sim-turn-ref-kind/)
assert.match(renderRows('turn thought "Thought" open=bad: body').warnings.join(), /sim-turn-invalid-open/)
assert.match(renderRows('turn thought "Thought" open=on open=off: body').warnings.join(), /sim-turn-duplicate-option/)
assert.match(renderRows('turn thought "Thought" panel=agents: body').warnings.join(), /sim-turn-option-unsupported/)
const { html } = renderRows()
assert.equal((html.match(/sim-step/g) || []).length, 6, 'first user anchors; every other row has one step')
assert.equal((html.match(/class="sim-toggle"/g) || []).length, 2, 'only nonempty details have disclosure controls')
assert.match(html, /sim-row-thought sim-step is-closed/)
assert.match(html, /data-row-open="off"/)
assert.match(renderRows(ROWS.replace('open=off', 'open=on')).html, /aria-expanded="true"/)
assert.match(simulationStatic(html), /sim-static/)
assert.doesNotMatch(simulationStatic(html), /aria-expanded="false"/, 'static controls describe the expanded transcript accurately')
assert.match(html, /template class="sim-transcript-source"/)
assert.match(html, /Comparison ready — done/, 'the full transcript retains the visible authored status')
assert.equal(renderRows(ROWS, {}).html.includes('sim-native-rows'), false, 'v2 must be explicit')
assert.equal(renderRows(ROWS, { 'sim-version': '2' }, 'chat-lanes').html.includes('sim-native-rows'), false, 'panels are not enabled')

for (const fixture of JSON.parse(readFileSync(new URL('./fixtures/chat-sim-rows/legacy-rendering.json', import.meta.url)))) {
  // Fixture ids intentionally differ from renderRows' synthetic native slide.
  const block = { type: 'code', lang: 'chat', text: fixture.text }
  const warnings = []
  annotateSimulationLayout([block], fixture.design, fixture.attrs, { id: 'legacy', title: 'Legacy sample' }, (w) => warnings.push(w))
  assert.equal(renderSimulation(block), fixture.html, `legacy byte identity: ${fixture.design}`)
  assert.deepEqual(warnings, fixture.warnings)
}
for (const eol of ['\n', '\r\n']) {
  const body = ROWS.replaceAll('\n', eol)
  const split = splitTurnSegments(body, { version: 2 })
  assert.equal(split.rows.length, 7)
  assert.equal(compiledRowCount('turns', body, { version: 2 }), 7)
  const rows = split.rows.map((row) => ({ ...row, original: row }))
  assert.equal(serialiseSegments('turns', body, split, rows), body)
  rows[1].label = 'Changed: "quote" \\ path'
  rows[1].content = 'changed\nuser: literal continuation\ndetail:'
  rows[1].detail = 'new detail\n  nested'
  const edited = serialiseSegments('turns', body, split, rows)
  const reread = splitTurnSegments(edited, { version: 2 })
  assert.equal(reread.rows.length, 7)
  assert.equal(reread.rows[1].label, rows[1].label)
  assert.equal(reread.rows[1].content, rows[1].content)
  assert.equal(reread.rows[1].detail, rows[1].detail)
  assert.deepEqual(reread.rows[2].lines, split.rows[2].lines, 'untouched sibling bytes survive edits')
}

for (const first of ['  nested', '\tnested']) {
  const body = `turn files "Listing":\n  ${first}\n    child`
  const split = splitTurnSegments(body, { version: 2 })
  const rows = split.rows.map((row) => ({ ...row, original: row }))
  rows[0].label = 'Changed label'
  const edited = serialiseSegments('turns', body, split, rows)
  assert.equal(splitTurnSegments(edited, { version: 2 }).rows[0].content, split.rows[0].content, 'editing a label retains first-line payload indentation')
}

console.log('PASS native turn parse/render/segments and 18 legacy byte-identity fixtures')
