import { strict as assert } from 'node:assert'

const {
  LAYOUTS,
  isFencedObjectLayout,
  objectInsertEntries,
  objectLayoutEntries,
  objectLayoutReadsStorage,
} = await import(
  new URL('../src/shared/layout-registry/entries.ts', import.meta.url)
)
const {
  buildEmptyTable,
  buildMermaid,
  buildMindmapList,
  buildSvg,
} = await import(
  new URL('../src/shared/objects/insert-objects.ts', import.meta.url)
)
const { detectObjectBlocks } = await import(
  new URL('../src/renderer/src/extensions/objectBlocks/detect.ts', import.meta.url)
)

assert.equal(typeof objectLayoutEntries, 'function', 'the registry exposes its object declarations')
assert.equal(typeof objectInsertEntries, 'function', 'insert doors consume the registry object list')
assert.equal(typeof isFencedObjectLayout, 'function', 'fenced-object routing consumes the declaration')
assert.equal(
  typeof objectLayoutReadsStorage,
  'function',
  'compatibility readings remain declared by the object registry'
)

const objectEntries = objectLayoutEntries(LAYOUTS)
assert.deepEqual(
  objectEntries.map((entry) => [
    entry.name,
    entry.object.storage,
    entry.object.widget,
    entry.object.editor,
  ]),
  [
    ['table', 'trigger-list', 'table', 'grid'],
    ['chart', 'fence', 'chart', 'outline'],
    ['barchart', 'fence', 'chart', 'outline'],
    ['piechart', 'fence', 'chart', 'outline'],
    ['linechart', 'fence', 'chart', 'outline'],
    ['mindmap', 'trigger-list', 'mindmap', 'outline'],
    ['mermaid', 'fence', 'mermaid', 'source'],
    ['svg', 'fence', 'svg', 'source'],
  ],
  'the current object family carries registry declarations matching renderer dispatch'
)
for (const entry of objectEntries.filter((candidate) =>
  ['chart', 'barchart', 'piechart', 'linechart'].includes(candidate.name)
)) {
  assert.equal(objectLayoutReadsStorage(entry, 'fence'), true, `${entry.name} writes fences`)
  assert.equal(
    objectLayoutReadsStorage(entry, 'trigger-list'),
    true,
    `${entry.name} keeps its trigger-list compatibility reading`
  )
}
assert.equal(objectEntries.find((entry) => entry.name === 'table').object.emptySkeleton(), buildEmptyTable())
assert.equal(
  objectEntries.find((entry) => entry.name === 'chart').object.emptySkeleton(),
  '- Alpha: 40\n- Beta: 25\n- Gamma: 35'
)
assert.equal(
  objectEntries.find((entry) => entry.name === 'barchart').object.emptySkeleton(),
  '- Alpha: 40\n- Beta: 25\n- Gamma: 35'
)
assert.equal(
  objectEntries.find((entry) => entry.name === 'piechart').object.emptySkeleton(),
  '- Alpha: 40\n- Beta: 25\n- Gamma: 35'
)
assert.equal(
  objectEntries.find((entry) => entry.name === 'linechart').object.emptySkeleton(),
  '- 2022: 1\n- 2024: 50\n- 2026: 100'
)
assert.equal(objectEntries.find((entry) => entry.name === 'mindmap').object.emptySkeleton(), buildMindmapList())
assert.equal(objectEntries.find((entry) => entry.name === 'mermaid').object.emptySkeleton(), buildMermaid())
assert.equal(objectEntries.find((entry) => entry.name === 'svg').object.emptySkeleton(), buildSvg())
assert.equal(
  isFencedObjectLayout(objectEntries.find((entry) => entry.name === 'mermaid')),
  true,
  'Mermaid is a fenced insert because its object declaration says so'
)
assert.equal(
  isFencedObjectLayout({
    ...objectEntries.find((entry) => entry.name === 'mermaid'),
    object: undefined,
  }),
  false,
  'a fence-looking entry without an object declaration is not a fenced insert'
)

assert.deepEqual(
  objectInsertEntries(LAYOUTS).map((entry) => [entry.name, entry.commandId, entry.route]),
  [
    ['table', 'insert-object-table', 'object'],
    ['mindmap', 'insert-object-mindmap', 'object'],
    ['chart', 'insert-object-chart', 'object'],
    ['mermaid', 'insert-object-mermaid', 'object'],
    ['diagram', 'insert-object-diagram', 'layout-picker'],
    ['svg', 'insert-object-svg', 'object'],
  ],
  'insert doors remain six rows in mockup order while the chart registry route goes live'
)
const fakeObjectEntry = {
  ...LAYOUTS.find((entry) => entry.name === 'orgchart'),
  name: 'registry-probe',
  label: 'Registry probe',
  trigger: '{registry-probe}',
  triggerWords: ['registry-probe'],
  object: {
    storage: 'trigger-list',
    widget: 'mindmap',
    editor: 'outline',
    emptySkeleton: () => '- Probe',
  },
}
assert.equal(
  objectInsertEntries([...LAYOUTS, fakeObjectEntry])
    .some((entry) => entry.commandId === 'insert-object-registry-probe'),
  true,
  'an object-declaring entry contributes an insert door without another kind list'
)
assert.equal(
  objectInsertEntries(LAYOUTS.map((entry) => entry.name === 'mindmap'
    ? { ...entry, object: undefined }
    : entry))
    .some((entry) => entry.commandId === 'insert-object-mindmap'),
  false,
  'a non-declared kind contributes no insert door'
)
const chartEntryWithDeclaration = {
  ...LAYOUTS.find((entry) => entry.name === 'chart'),
  object: {
    storage: 'trigger-list',
    widget: 'chart',
    editor: 'outline',
    emptySkeleton: () => '- Category\n  - Value',
  },
}
const chartInsertEntries = objectInsertEntries(
  LAYOUTS.map((entry) => entry.name === 'chart' ? chartEntryWithDeclaration : entry)
).filter((entry) => entry.commandId === 'insert-object-chart')
assert.equal(
  chartInsertEntries.length,
  1,
  'a registry-declared chart replaces rather than duplicates the layout-picker fallback row'
)
assert.equal(
  chartInsertEntries[0].route,
  'object',
  'the registry-derived chart row wins once chart has an object declaration'
)
assert.equal(
  objectInsertEntries(LAYOUTS).filter((entry) => /chart/.test(entry.name)).length,
  1,
  'chart aliases declare objects without manufacturing duplicate insert rows'
)

const doc = [
  '### Slide one', '{table}{reveal}{id=abc12}', '',
  '- Role', '  - Oracle', '- Where', '  - ChatGPT', '',
  '### Slide two', '',
  '| a | b |', '| --- | --- |', '| c | d |', '',
  '```mermaid', 'flowchart LR', '  A --> B', '```', '',
  '```svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>', '```', '',
  '```python', 'print(1)', '```', ''
].join('\n')

const blocks = detectObjectBlocks(doc)
const kinds = blocks.map((block) => block.kind)
assert.deepEqual(
  kinds,
  ['trigger-table', 'gfm-table', 'mermaid', 'svg'],
  'python fence is NOT an object'
)

const trig = blocks[0]
assert.equal(trig.triggerLine, 2, 'trigger-table records its trigger line')
assert.ok(trig.source.startsWith('- Role'), 'trigger-table block is the LIST, not the trigger line')

const gfm = blocks[1]
assert.equal(
  doc.slice(gfm.from, gfm.to),
  '| a | b |\n| --- | --- |\n| c | d |\n',
  'byte-exact slice incl. trailing newline'
)

// A table with a touching prose line keeps the prose OUT (WriteFlex walk find 2026-07-12).
const touched = detectObjectBlocks('| a |\n| --- |\n| b |\ntyped text under the table\n')
assert.equal(
  touched[0].source,
  '| a |\n| --- |\n| b |\n',
  'prose line under a table is not swallowed'
)

const pipeBearingProse = detectObjectBlocks(
  '| a |\n| --- |\n| b |\nprose with a | pipe\nnext paragraph\n'
)
assert.equal(
  pipeBearingProse[0].source,
  '| a |\n| --- |\n| b |\n',
  'prose containing an interior pipe is not swallowed into a table block'
)

// An incomplete hand-authored fence remains ordinary source until its closing fence exists.
const open = detectObjectBlocks('```mermaid\nflowchart LR\n  A --> B')
assert.deepEqual(open, [], 'an unterminated drawable fence is not a complete object')

const mindmap = detectObjectBlocks('{mindmap}{id=map12}\n- Root\n  - Branch\n')
assert.equal(mindmap[0].kind, 'mindmap', 'mindmap trigger attaches its nested list block')

for (const [opening, expectedKind, expectedToken] of [
  ['chart=bar', 'chart', 'chart=bar'],
  ['chart=pie', 'chart', 'chart=pie'],
  ['chart=line', 'chart', 'chart=line'],
  ['barchart', 'barchart', 'barchart'],
  ['piechart', 'piechart', 'piechart'],
  ['linechart', 'linechart', 'linechart'],
  ['curve', 'linechart', 'curve'],
]) {
  const source = `\`\`\`${opening}\n- Alpha: 40\n- Beta: 60\n\`\`\`\n`
  const [block] = detectObjectBlocks(source)
  assert.deepEqual(
    {
      kind: block?.kind,
      triggerToken: block?.triggerToken,
      source: block?.source,
      body: source.slice(block?.bodyFrom, block?.bodyTo),
    },
    {
      kind: expectedKind,
      triggerToken: expectedToken,
      source,
      body: '- Alpha: 40\n- Beta: 60',
    },
    `${opening} is one closed chart object whose editable range is exactly the fence body`
  )
}

const longChartFence = [
  '````chart=bar',
  '- Alpha: 40',
  '```',
  '- Beta: 60',
  '````',
  '',
].join('\n')
assert.equal(
  detectObjectBlocks(longChartFence)[0]?.source,
  longChartFence,
  'chart object detection consumes the shared length-aware four-backtick extent'
)

const invalidFencedChart = [
  '```chart=bar',
  '- Alpha: 40',
  '| Beta: 60',
  '```',
  '',
].join('\n')
assert.equal(
  detectObjectBlocks(invalidFencedChart)[0]?.source,
  invalidFencedChart,
  'a registered chart fence with an invalid body still reaches the visible object error path'
)

assert.deepEqual(
  [
    ['{mindmap, chart=pie}', 'mindmap', 'mindmap'],
    ['{timeline, chart=pie}', undefined, undefined],
    ['{quote, chart=pie}', undefined, undefined],
    ['{table, chart}', 'chart', 'chart'],
    ['{chart=bar}', 'chart', 'chart=bar'],
    ['{table}{reveal}', 'trigger-table', 'table'],
  ].map(([trigger, expectedKind, expectedToken]) => {
    const [block] = detectObjectBlocks(`${trigger}\n- Alpha: 40\n- Beta: 25\n`)
    return [block?.kind, block?.triggerToken, expectedKind, expectedToken]
  }),
  [
    ['mindmap', 'mindmap', 'mindmap', 'mindmap'],
    [undefined, undefined, undefined, undefined],
    [undefined, undefined, undefined, undefined],
    ['chart', 'chart', 'chart', 'chart'],
    ['chart', 'chart=bar', 'chart', 'chart=bar'],
    ['trigger-table', 'table', 'trigger-table', 'table'],
  ],
  'object detection follows compiler layout precedence before choosing an object declaration'
)

assert.deepEqual(
  [
    ['{chart=bar}', 'chart', 'chart=bar'],
    ['{chart=pie}', 'chart', 'chart=pie'],
    ['{chart=line}', 'chart', 'chart=line'],
    ['{barchart}', 'barchart', 'barchart'],
    ['{piechart}', 'piechart', 'piechart'],
    ['{linechart}', 'linechart', 'linechart'],
    ['{curve}', 'linechart', 'curve'],
  ].map(([trigger, expectedKind, expectedToken]) => {
    const [block] = detectObjectBlocks(`${trigger}\n- Alpha: 40\n- Beta: 25\n`)
    return [block?.kind, block?.triggerToken, expectedKind, expectedToken]
  }),
  [
    ['chart', 'chart=bar', 'chart', 'chart=bar'],
    ['chart', 'chart=pie', 'chart', 'chart=pie'],
    ['chart', 'chart=line', 'chart', 'chart=line'],
    ['barchart', 'barchart', 'barchart', 'barchart'],
    ['piechart', 'piechart', 'piechart', 'piechart'],
    ['linechart', 'linechart', 'linechart', 'linechart'],
    ['linechart', 'curve', 'linechart', 'curve'],
  ],
  'chart detection keeps the authored trigger token so shape remains a trigger-line concern'
)

const competingChartBlocks = detectObjectBlocks([
  '### Competing chart authorities',
  '{id=competing}{chart=bar}',
  '- Trigger compatibility: 10',
  '',
  '{piechart}',
  '',
  '- Block authority: 90',
  ''
].join('\n'))
assert.deepEqual(
  competingChartBlocks.map((block) => [block.kind, block.triggerToken, block.source]),
  [['piechart', 'piechart', '- Block authority: 90\n']],
  'a block-scoped chart token suppresses the trigger-only compatibility detection'
)

const gateShape = detectObjectBlocks([
  '### Gate shape',
  '{id=gate-shape}{chart=bar}',
  '',
  '{piechart}',
  '',
  '- Alpha: 40',
  '- Beta: 60',
  '',
  '```chart=line',
  '- 2024: 25',
  '- 2025: 75',
  '```',
  ''
].join('\n'))
assert.deepEqual(
  gateShape.map((block) => [block.kind, block.triggerToken]),
  [['chart', 'chart=line']],
  'the canonical fence wins editor detection when all three readable chart forms coexist'
)

for (const trigger of [
  '{table=grid}',
  '{table=2}',
  '{mindmap=x}',
  '{barchart=pie}',
  '{image=right}'
]) {
  assert.deepEqual(
    detectObjectBlocks(`${trigger}\n- Alpha: 40\n- Beta: 25\n`),
    [],
    `${trigger} stays source because the compiler rejects its undeclared value form`
  )
}

const orderedMindmap = detectObjectBlocks('{mindmap}\n1. Root\n\t1) Branch\n')
assert.equal(
  orderedMindmap[0]?.source,
  '1. Root\n\t1) Branch\n',
  'ordered and tab-indented list items follow the compiler list grammar'
)

const demoted = detectObjectBlocks('```mermaid code\nflowchart LR\n  A --> B\n```\n')
assert.deepEqual(demoted, [], 'a second fence token of code demotes a drawable fence')

const prose = detectObjectBlocks('A prose sentence ending in {table}\n- stays prose\n')
assert.deepEqual(prose, [], 'a trailing token on prose is not an authored Trigger line')

const tableEntry = LAYOUTS.find((entry) => entry.name === 'table')
const tableDeclaration = tableEntry.object
delete tableEntry.object
try {
  assert.deepEqual(
    detectObjectBlocks('{table}\n- Role\n  - Oracle\n'),
    [],
    'a trigger word contributes nothing when its registry entry has no object declaration'
  )
} finally {
  tableEntry.object = tableDeclaration
}

console.log('test:object-blocks OK')
