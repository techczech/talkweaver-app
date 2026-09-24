import { strict as assert } from 'node:assert'

const { parseTriggerTable, serialiseTriggerTable } =
  await import(new URL('../src/shared/objects/trigger-table.ts', import.meta.url))
const {
  innerSource,
  objectEditorReplacement,
  objectEditorCommitRefusal,
  planObjectEditorCommit,
} = await import(new URL('../src/renderer/src/objects/registry.ts', import.meta.url))
const { detectObjectBlocks } = await import(
  new URL('../src/renderer/src/extensions/objectBlocks/detect.ts', import.meta.url)
)

const list = '- Role\n  - Oracle\n  - Tool user\n- Where\n  - ChatGPT\n  - Codex'
const model = parseTriggerTable(list)
assert.deepEqual(
  model.cells,
  [['Role', 'Where'], ['Oracle', 'ChatGPT'], ['Tool user', 'Codex']],
  'depth-0 items are headers; children transpose to rows'
)
assert.equal(serialiseTriggerTable(model), list, 'byte round-trip on the canonical shape')

const ragged = parseTriggerTable('- A\n  - 1\n- B')
assert.deepEqual(ragged.cells, [['A', 'B'], ['1', '']])
assert.equal(serialiseTriggerTable(ragged), '- A\n  - 1\n- B')
assert.equal(
  parseTriggerTable('- A\n    - nested too deeply'),
  null,
  'unsupported deeper nesting fails closed instead of being flattened'
)

const tableSource = '| A | B |\n| :--- | ---: |\n| 1 | 2 |\n'
const tableBlock = {
  kind: 'gfm-table',
  from: 0,
  to: tableSource.length,
  source: tableSource,
}
assert.equal(innerSource(tableBlock), tableSource.trimEnd())
assert.equal(
  objectEditorReplacement(tableBlock, innerSource(tableBlock)),
  tableSource,
  'an unedited block preserves every original byte including its final newline'
)
assert.equal(
  objectEditorCommitRefusal(tableBlock, tableSource, '', ''),
  'replacement inner source was empty while the original inner source was not'
)
assert.equal(
  objectEditorCommitRefusal(tableBlock, `X${tableSource.slice(1)}`, tableSource, innerSource(tableBlock)),
  'the editor shell was stale and no longer matched the active document'
)
assert.match(
  objectEditorCommitRefusal(
    tableBlock,
    tableSource,
    '| A | B |\nnot a separator',
    '| A | B |\nnot a separator'
  ) ?? '',
  /parsed back/,
  'malformed table serialisation is refused before it can write'
)

const blankSource = '|  |  |  |\n| :--- | :--- | :--- |\n|  |  |  |\n|  |  |  |\n|  |  |  |'
const blankBlock = {
  kind: 'gfm-table',
  from: 0,
  to: blankSource.length,
  source: blankSource,
}
assert.equal(
  objectEditorCommitRefusal(blankBlock, blankSource, blankSource, innerSource(blankBlock)),
  null,
  'an all-blank inserted table remains a valid grid'
)
assert.equal(
  blankSource.split('\n').length,
  5,
  'the all-blank table keeps all three body rows'
)

const triggerDoc = `{table}\n${list}\n`
const triggerBlock = {
  kind: 'trigger-table',
  from: '{table}\n'.length,
  to: triggerDoc.length,
  source: `${list}\n`,
  triggerLine: 1,
}
const changedTrigger = `${serialiseTriggerTable({
  cells: [['Role', 'Where'], ['Editor', 'ChatGPT'], ['Tool user', 'Codex']],
  alignments: ['left', 'left'],
})}\n`
assert.equal(
  objectEditorCommitRefusal(triggerBlock, triggerDoc, changedTrigger, changedTrigger.trimEnd()),
  null,
  'trigger-table edits parse back in nested-list storage form'
)
assert.match(
  objectEditorCommitRefusal(
    triggerBlock,
    triggerDoc,
    '| Role | Where |\n| --- | --- |',
    '| Role | Where |\n| --- | --- |'
  ) ?? '',
  /parsed back/,
  'trigger-table commits refuse a pipe-table replacement'
)

const mermaidSource = '```mermaid\nflowchart LR\n  A --> B\n```\n'
const mermaidBlock = {
  kind: 'mermaid',
  from: 0,
  to: mermaidSource.length,
  source: mermaidSource,
}
const emptyMermaidReplacement = objectEditorReplacement(mermaidBlock, '')
assert.equal(
  objectEditorCommitRefusal(mermaidBlock, mermaidSource, emptyMermaidReplacement, ''),
  'replacement inner source was empty while the original inner source was not',
  'fences around an empty Mermaid body do not defeat the empty-over-nonempty guard'
)

const svgSource = '```SVG preview dark\r\n<svg><text>Before</text></svg>\r\n```\r\n'
const svgBlock = {
  kind: 'svg',
  from: 0,
  to: svgSource.length,
  source: svgSource,
}
assert.equal(
  objectEditorReplacement(svgBlock, '<svg><text>After</text></svg>'),
  '```SVG preview dark\r\n<svg><text>After</text></svg>\r\n```\r\n',
  'editing a fenced object preserves its complete info string and CRLF line endings'
)

const fencedChartDoc = [
  '### Chart',
  '{id=fenced-chart}',
  '',
  '```chart=bar',
  '- Alpha: 40',
  '- Beta: 60',
  '```',
  '',
].join('\n')
const fencedChartBlock = detectObjectBlocks(fencedChartDoc)[0]
assert(fencedChartBlock, 'the fenced chart is detected before its commit is planned')
assert.equal(
  innerSource(fencedChartBlock),
  '- Alpha: 40\n- Beta: 60',
  'the chart editor receives only the fenced body'
)
assert.equal(typeof planObjectEditorCommit, 'function', 'the object editor exposes one fail-closed commit planner')
const fencedChartPlan = planObjectEditorCommit(
  fencedChartBlock,
  fencedChartDoc,
  '- Alpha: 45\n- Beta: 60'
)
assert.deepEqual(
  fencedChartPlan,
  {
    ok: true,
    change: {
      from: fencedChartDoc.indexOf('- Alpha: 40'),
      to: fencedChartDoc.indexOf('- Beta: 60') + '- Beta: 60'.length,
      insert: '- Alpha: 45\n- Beta: 60',
    },
  },
  'a fenced chart commit targets only its body bytes'
)
const committedFencedChart = fencedChartPlan.ok
  ? `${fencedChartDoc.slice(0, fencedChartPlan.change.from)}${fencedChartPlan.change.insert}${fencedChartDoc.slice(fencedChartPlan.change.to)}`
  : fencedChartDoc
assert.equal(
  committedFencedChart,
  fencedChartDoc.replace('- Alpha: 40', '- Alpha: 45'),
  'the planned commit leaves the fence and every unedited line byte-identical'
)

for (const eol of ['\n', '\r\n']) {
  for (const [info, inner] of [
    ['mermaid', 'flowchart LR\n  A --> B'],
    ['svg', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
    ['chart=bar', '- Alpha: 40']
  ]) {
    for (const closing of ['```', '````']) {
      const prefix = `### Empty${eol}{id=empty}${eol}${eol}`
      const source = `\`\`\`${info}${eol}${closing}${eol}`
      const doc = prefix + source
      const block = detectObjectBlocks(doc)[0]
      assert.equal(innerSource(block), '', `${info}: adjacent markers expose an empty body`)
      assert.equal(objectEditorReplacement(block, ''), source, 'an empty no-op remains byte-identical')
      for (const edited of [inner, inner + '\n']) {
        const plan = planObjectEditorCommit(block, doc, edited)
        assert.equal(plan.ok, true, `${info}: first content commits inside adjacent fence markers`)
        const result = doc.slice(0, plan.change.from) + plan.change.insert + doc.slice(plan.change.to)
        assert.equal(result, prefix + `\`\`\`${info}${eol}${inner.replace(/\n/g, eol)}${eol}${closing}${eol}`,
          'the inserted body keeps the closing marker, surrounding bytes and line-ending style')
      }
    }
  }
}

const crlfTableSource = '| A | B |\r\n| --- | --- |\r\n| 1 | 2 |\r\n'
const crlfTableBlock = {
  kind: 'gfm-table',
  from: 0,
  to: crlfTableSource.length,
  source: crlfTableSource,
}
const changedCrlfTable = '| A | B |\n| :--- | :--- |\n| 3 | 2 |'
assert.equal(
  objectEditorReplacement(crlfTableBlock, changedCrlfTable),
  '| A | B |\r\n| :--- | :--- |\r\n| 3 | 2 |\r\n',
  'editing a CRLF table does not leave mixed line endings'
)

console.log('test:trigger-table OK')
