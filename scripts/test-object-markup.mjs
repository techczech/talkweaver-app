import { strict as assert } from 'node:assert'

const { parseTable, serialiseTable, validateObjectMarkup, objectBlock } =
  await import(new URL('../src/shared/objects/object-markup.ts', import.meta.url))

// Round-trip with alignment colons preserved
const src = '| Model | Fit |\n| :--- | ---: |\n| GPT-5.6 | drafting |'
const model = parseTable(src)
assert.deepEqual(model.alignments, ['left', 'right'])
assert.equal(serialiseTable(model), '| Model | Fit |\n| :--- | ---: |\n| GPT-5.6 | drafting |')

// Escaped pipes and <br> line breaks survive the round trip
const esc = parseTable('| a\\|b | c |\n| --- | --- |\n| x<br>y | z |')
assert.equal(esc.cells[1][0], 'x\ny', 'cell <br> decodes to newline')
assert.ok(serialiseTable(esc).includes('a\\|b'), 'pipe re-escapes')
assert.ok(serialiseTable(esc).includes('x<br>y'), 'newline re-encodes as <br>')

// Editing a cell must not rewrite an untouched separator row.
const plainSeparatorSource = '| a | b |\n| --- | --- |\n| c | d |'
const plainSeparator = parseTable(plainSeparatorSource)
plainSeparator.cells[0][0] = 'A'
const plainSeparatorEdited = serialiseTable(plainSeparator)
assert.equal(
  plainSeparatorEdited,
  '| A | b |\n| --- | --- |\n| c | d |',
  'an ordinary cell edit preserves the original separator line byte-for-byte'
)
assert.deepEqual(
  plainSeparatorEdited.split('\n')
    .map((line, index) => line === plainSeparatorSource.split('\n')[index] ? null : index)
    .filter((index) => index !== null),
  [0],
  'an ordinary cell edit changes exactly one line'
)

// Blank body rows are authored data and remain in place beside non-empty rows.
const blanks = { cells: [['H1', 'H2'], ['', ''], ['a', 'b']], alignments: ['left', 'left'] }
assert.equal(
  serialiseTable(blanks),
  '| H1 | H2 |\n| :--- | :--- |\n|  |  |\n| a | b |',
  'editing a neighbouring cell does not delete a spacer row'
)

for (const separator of ['|-|-|', '| - | - |']) {
  const short = parseTable(`| a | b |\n${separator}\n| 1 | 2 |`)
  assert(short, `${separator} is a legal GFM separator row`)
  assert.equal(
    serialiseTable(short),
    `| a | b |\n${separator}\n| 1 | 2 |`,
    `${separator} round-trips byte-for-byte`
  )
}

const raggedSource = '| a | b |\n| - | - |\n| short |\n| x | y | overflow |'
const ragged = parseTable(raggedSource)
assert(ragged, 'a ragged GFM table remains editable')
assert.deepEqual(
  ragged.cells,
  [['a', 'b', ''], ['short', '', ''], ['x', 'y', 'overflow']],
  'ragged rows pad short rows and retain overflow cells'
)
const raggedRoundTrip = parseTable(serialiseTable(ragged))
assert.deepEqual(
  raggedRoundTrip.cells,
  ragged.cells,
  'ragged table content round-trips without losing any cell'
)
validateObjectMarkup('table', raggedSource)

// Validation throws instructive, kind-specific errors
assert.throws(() => validateObjectMarkup('table', 'not a table'), /pipe table/)
assert.throws(() => validateObjectMarkup('svg', '<div>nope</div>'), /<svg> root/)
assert.throws(() => validateObjectMarkup('markmap', '- ok\n    - jumps two levels'), /more than one level/)
assert.throws(() => validateObjectMarkup('mermaid', 'notatype\nx'), /diagram type/)
validateObjectMarkup('mermaid', 'flowchart LR\n  A --> B') // does not throw
validateObjectMarkup('mermaid', 'gitGraph\n  commit id: "ZERO"')
validateObjectMarkup('mermaid', "flowchart LR\n  A[Bob's plan] --> B")
validateObjectMarkup('mermaid', 'flowchart LR\n  A[Happy :)] --> B')
assert.throws(
  () => validateObjectMarkup('mermaid', 'flowchart LR\n  A["Unclosed label] --> B'),
  /unbalanced quotes/
)

// objectBlock: table stays bare, fenced kinds wrap
assert.equal(objectBlock('table', src), src)
assert.equal(objectBlock('mermaid', 'flowchart LR\n  A --> B'), '```mermaid\nflowchart LR\n  A --> B\n```')
assert.equal(objectBlock('markmap', '- Central idea\n  - Branch'), '- Central idea\n  - Branch')

console.log('test:object-markup OK')
