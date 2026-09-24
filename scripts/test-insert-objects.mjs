import { strict as assert } from 'node:assert'
const m = await import(new URL('../src/shared/objects/insert-objects.ts', import.meta.url))
const triggerCommit = await import(
  new URL('../src/renderer/src/extensions/inlineTriggerCommitModel.ts', import.meta.url)
)
const { parseTable, serialiseTable } = await import(new URL('../src/shared/objects/object-markup.ts', import.meta.url))
const { logicalTriggerBlockAfterHeading } = await import(new URL('../src/shared/trigger-line.ts', import.meta.url))

const empty = parseTable(m.buildEmptyTable(3, 3))
assert.ok(empty, 'empty table parses')
assert.equal(empty.alignments.length, 3, '3 columns')
assert.equal(empty.cells.length, 4, 'header + 3 body rows')
assert.ok(empty.cells.every((row) => row.every((c) => c === '')), 'all cells empty — opens ready to type')
const roundTripped = parseTable(serialiseTable(empty))
assert.ok(roundTripped, 'serialised empty table still parses')
assert.equal(roundTripped.cells.length, 4, 'serialise round-trip preserves all 3 blank body rows')

assert.match(m.buildMermaid(), /^```mermaid\nflowchart LR\n/)
assert.match(m.buildSvg(), /^```svg\n<svg xmlns=/)
assert.match(m.buildMindmapList(), /^- /m)
assert.equal(
  m.buildFencedObjectSource('chart=bar', '- Alpha: 40\n- Beta: 25'),
  '```chart=bar\n- Alpha: 40\n- Beta: 25\n```',
  'the chart door writes one fenced object with a list body'
)

assert.equal(
  typeof triggerCommit.prepareObjectInsertDocument,
  'function',
  'object insertion exposes the eager current-slide stamping path'
)

const collisionDoc = '### Existing\n{id=4fzzz}\n\n### Target\nBody'
const collisionValues = [0.123456789, 0.987654321]
const collisionResult = triggerCommit.prepareObjectInsertDocument(
  collisionDoc,
  collisionDoc.indexOf('### Target') + '### Target'.length,
  undefined,
  () => collisionValues.shift() ?? 0.987654321
)
assert.equal(
  [...collisionResult.doc.matchAll(/\{id=4fzzz\}/g)].length,
  1,
  'an injected collision never duplicates an existing same-outline slide id'
)
assert.match(
  collisionResult.doc,
  /### Target\n\{id=zk000\}/,
  'the editor retries the id mint after an injected same-outline collision'
)

function lineAt(doc, position) {
  const before = doc.slice(0, position)
  const from = before.lastIndexOf('\n') + 1
  const nextBreak = doc.indexOf('\n', position)
  return {
    from,
    to: nextBreak === -1 ? doc.length : nextBreak,
    text: doc.slice(from, nextBreak === -1 ? doc.length : nextBreak),
    number: before.split('\n').length
  }
}

function applyPreparedChartDoor({ doc, at, replace }) {
  const prepared = triggerCommit.prepareObjectInsertDocument(
    doc,
    at,
    replace,
    () => 0.123456789
  )
  let targetLine = lineAt(prepared.doc, prepared.at)
  if (/^#{2,6}\s/.test(targetLine.text)) {
    const trigger = logicalTriggerBlockAfterHeading(
      prepared.doc.split('\n'),
      targetLine.number - 1
    )
    assert.ok(trigger, 'the insertion preparation eagerly stamps the target heading')
    targetLine = lineAt(
      prepared.doc,
      lineAt(prepared.doc, 0).from
        + prepared.doc.split('\n')
          .slice(0, trigger.end)
          .reduce((sum, line) => sum + line.length + 1, 0)
        - 1
    )
  }
  const splice = m.planObjectBlockSplice(
    prepared.doc,
    targetLine.to,
    m.buildFencedObjectSource('chart=bar', '- Alpha: 40'),
    '```chart=bar\n'.length
  )
  return prepared.doc.slice(0, splice.from)
    + splice.insert
    + prepared.doc.slice(splice.to)
}

const unstampedDoorCases = [
  {
    door: 'Command-K slide menu',
    caret: 'heading',
    doc: '### Revenue\nFirst body',
    at: '### Revenue'.length
  },
  {
    door: 'command palette',
    caret: 'heading',
    doc: '### Revenue\nFirst body',
    at: '### Revenue'.length
  },
  {
    door: 'brace palette',
    caret: 'heading',
    doc: '### Revenue {cha}\nFirst body',
    at: '### Revenue {cha}'.length,
    replace: {
      from: '### Revenue '.length,
      to: '### Revenue {cha}'.length
    }
  },
  {
    door: 'Command-K slide menu',
    caret: 'first body line',
    doc: '### Revenue\nFirst body',
    at: '### Revenue\nFirst body'.length
  },
  {
    door: 'command palette',
    caret: 'first body line',
    doc: '### Revenue\nFirst body',
    at: '### Revenue\nFirst body'.length
  },
  {
    door: 'brace palette',
    caret: 'first empty body line',
    doc: '### Revenue\n{cha}\nFirst body',
    at: '### Revenue\n{cha}'.length,
    replace: {
      from: '### Revenue\n'.length,
      to: '### Revenue\n{cha}'.length
    }
  }
]

for (const fixture of unstampedDoorCases) {
  const result = applyPreparedChartDoor(fixture)
  const lines = result.split('\n')
  const headingIndex = lines.findIndex((line) => /^### Revenue\s*$/.test(line))
  const trigger = logicalTriggerBlockAfterHeading(lines, headingIndex)
  const chartIndex = lines.indexOf('```chart=bar')
  assert.ok(
    trigger?.line.match(/^\{id=[^}]+\}$/),
    `${fixture.door} from ${fixture.caret} stamps an id-only canonical Trigger line`
  )
  assert.ok(
    chartIndex >= trigger.end,
    `${fixture.door} from ${fixture.caret} writes the chart fence below the canonical Trigger line`
  )
  assert.deepEqual(
    lines.slice(chartIndex, chartIndex + 3),
    ['```chart=bar', '- Alpha: 40', '```'],
    `${fixture.door} from ${fixture.caret} writes the complete fenced chart skeleton`
  )
  assert.equal(
    lines.includes('{chart=bar}'),
    false,
    `${fixture.door} from ${fixture.caret} never writes the block-token compatibility form`
  )
  assert.equal(
    trigger.line.includes('chart'),
    false,
    `${fixture.door} from ${fixture.caret} never manufactures the legacy chart Trigger form`
  )
}

assert.equal(m.isSvgText('  <svg viewBox="0 0 1 1"></svg> '), true)
assert.equal(m.isSvgText('<p>no</p>'), false)
assert.equal(m.isSvgFile({ name: 'x.svg', type: '' }), true)
assert.equal(m.isSvgFile({ name: 'x.png', type: 'image/png' }), false)

assert.deepEqual(m.parseTablePaste('a\tb\nc\td'), [['a', 'b'], ['c', 'd']], 'TSV splits')
assert.deepEqual(m.parseTablePaste('| a | b |\n| --- | --- |\n| c | d |'), [['a', 'b'], ['c', 'd']], 'pipe table wins over tab split')
assert.equal(m.tablePasteKind('Heading\n---'), null, 'setext prose is not a pipe table')
assert.equal(m.tablePasteKind('---'), null, 'a thematic break is not a pipe table')
assert.equal(
  m.tablePasteKind('\tconst value = 1\n\tconsole.log(value)'),
  null,
  'tab-indented code is not TSV'
)
assert.equal(
  m.tablePasteKind('  \tfoo\tbar\n  \tbaz\tqux'),
  null,
  'space-then-tab indented code is not TSV'
)
assert.equal(
  m.tablePasteKind('### Slide\n\n![](assets/example.png)\tcaption'),
  null,
  'slide markdown carrying an asset ref and a tab stays on the assets-materialisation path'
)
assert.equal(m.tablePasteKind('Model\tFit\nGPT\tDrafting'), 'tsv', 'rectangular TSV is detected')
assert.equal(
  m.tablePasteKind('| Model | Fit |\n| --- | --- |\n| GPT | Drafting |'),
  'pipe',
  'a compiler-shaped leading-pipe table is detected'
)
assert.equal(
  m.tablePasteKind('| Model | Fit |\n\n| --- | --- |\n| GPT | Drafting |'),
  null,
  'pipe detection does not skip a blank line the compiler lexer would treat as the table boundary'
)
assert.equal(
  m.tablePasteKind('| Model | Fit |\n\n| --- | --- |\n| GPT | Drafting |'),
  null,
  'pipe detection does not skip a blank line the compiler lexer would treat as the table boundary'
)

// T27: the six object inserts surface in the Insert toolbar menu — same commands as the palette,
// no shortcuts, ordered after the built-in insert items under one group marker.
const { objectPaletteCommands, toolbarCommands } = await import(new URL('../src/shared/command-registry.ts', import.meta.url))
const { LAYOUTS } = await import(new URL('../src/shared/layout-registry/entries.ts', import.meta.url))
const objectCommands = objectPaletteCommands(LAYOUTS)
assert.deepEqual(
  objectCommands.map((command) => command.id),
  ['insert-object-table', 'insert-object-mindmap', 'insert-object-chart', 'insert-object-mermaid', 'insert-object-diagram', 'insert-object-svg'],
  'the six object commands exist in registry order'
)
for (const command of objectCommands) {
  assert.equal(command.toolbar?.menu, 'insert', `${command.id}: carries an Insert toolbar placement`)
  assert.equal(command.shortcutId, undefined, `${command.id}: no keyboard shortcut`)
  assert.equal(command.handlerId, command.id, `${command.id}: the menu item runs exactly what the palette entry runs`)
}
assert.deepEqual(
  toolbarCommands('insert').map((command) => command.id),
  ['layout', 'image', 'search', 'icon-picker', 'insert-object-table', 'insert-object-mindmap', 'insert-object-chart', 'insert-object-mermaid', 'insert-object-diagram', 'insert-object-svg'],
  'toolbarCommands(insert) is exactly the four built-ins then the six objects, in order'
)
console.log('test:insert-objects OK')
