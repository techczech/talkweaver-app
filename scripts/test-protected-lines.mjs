import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

// Bundle the real renderer modules so these checks exercise the production CodeMirror commands.
// Node cannot resolve the renderer's extensionless TypeScript imports directly.
const bundleDir = mkdtempSync(join(tmpdir(), 'talk-weaver-protected-lines-'))
const bundleUrl = pathToFileURL(join(bundleDir, 'bundle.mjs'))
let runtime
try {
  await build({
    stdin: {
      contents: [
        "export { triggerSource } from './src/renderer/src/extensions/triggerComplete.ts'",
        "export { CompletionContext } from '@codemirror/autocomplete'",
        "export { EditorState } from '@codemirror/state'",
        "export { insertNewlineAndIndent } from '@codemirror/commands'",
        "export { markdown } from '@codemirror/lang-markdown'",
        "export { EDITOR_COMMANDS } from './src/renderer/src/keymap/registry.ts'",
        "export { objectBlocksExtension, setOpenObjectBlock } from './src/renderer/src/extensions/objectBlocks/field.ts'",
        "export { inlineConflictFindings } from './src/renderer/src/extensions/idProtect.ts'"
      ].join('\n'),
      resolveDir: fileURLToPath(new URL('..', import.meta.url)),
      sourcefile: 'test-protected-lines-entry.ts'
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: fileURLToPath(bundleUrl)
  })
  runtime = await import(`${bundleUrl.href}?t=${Date.now()}`)
} finally {
  rmSync(bundleDir, { recursive: true, force: true })
}

const {
  EDITOR_COMMANDS,
  CompletionContext,
  triggerSource,
  EditorState,
  insertNewlineAndIndent,
  inlineConflictFindings,
  markdown,
  objectBlocksExtension,
  setOpenObjectBlock
} = runtime

const threeChartForms = [
  '### Chart conflict',
  '{id=chart-conflict}{chart=bar}',
  '',
  '{piechart}',
  '- Block Alpha: 40',
  '',
  '```chart=line',
  '- Fence 2024: 25',
  '- Fence 2025: 75',
  '```',
  '',
].join('\n')
assert.deepEqual(
  inlineConflictFindings(threeChartForms)
    .map(({ kind, token, line }) => ({ kind, token, line })),
  [
    { kind: 'trigger-conflict', token: 'chart=bar', line: 2 },
    { kind: 'trigger-conflict', token: 'piechart', line: 4 },
  ],
  'the shared Doctor findings mark both compatibility chart forms as losing to the fence'
)
assert.deepEqual(
  inlineConflictFindings(threeChartForms, [2])
    .map(({ kind, token, line }) => ({ kind, token, line })),
  [{ kind: 'trigger-conflict', token: 'piechart', line: 4 }],
  'a focused conflict line keeps its ordinary focused rendering'
)

const generalConflicts = [
  '### Duplicate layout',
  '{statement}{quote}',
  '',
  '### Same-key conflict',
  '{bg=cobalt}{bg=emerald}',
  '',
  '### Unresolved registered key',
  '{layout=nonsense}',
  '',
  '### Unknown bare word',
  '{nonesuch}',
  '',
  '### Unknown key',
  '{nonesuch=value}',
  '',
  '### Valid',
  '{statement}',
].join('\n')
assert.deepEqual(
  inlineConflictFindings(generalConflicts)
    .map(({ kind, token, line }) => ({ kind, token, line })),
  [
    { kind: 'duplicate-layout', token: 'quote', line: 2 },
    { kind: 'trigger-conflict', token: 'bg=emerald', line: 5 },
    { kind: 'unregistered-value', token: 'layout=nonsense', line: 8 },
  ],
  'inline conflict state covers layout, non-layout, and unresolved registered tokens without marking unknown or valid tokens'
)

function fakeView(state) {
  const view = {
    state,
    dispatch: null,
    focus() {}
  }
  view.dispatch = (spec) => {
    const transaction = spec?.state && spec?.startState ? spec : view.state.update(spec)
    view.state = transaction.state
  }
  return view
}

function positionInLine(doc, exactLine, column) {
  const lines = doc.split('\n')
  const index = lines.indexOf(exactLine)
  assert.notEqual(index, -1, `fixture contains ${JSON.stringify(exactLine)}`)
  return lines.slice(0, index).reduce((sum, line) => sum + line.length + 1, 0)
    + Math.min(column, exactLine.length)
}

function pressEnterThroughCommandChain(view) {
  let handledBy = 'default'
  for (const command of EDITOR_COMMANDS.filter((candidate) => candidate.keys === 'Enter')) {
    if (!command.run(view)) continue
    handledBy = command.id
    break
  }
  if (handledBy === 'default') {
    assert.equal(insertNewlineAndIndent(view), true, 'the production default Enter command handles the key')
  }
  return { state: view.state, handledBy }
}

function pressEditorEnter(doc, exactLine, column, extensions = []) {
  const view = fakeView(EditorState.create({
    doc,
    selection: { anchor: positionInLine(doc, exactLine, column) },
    extensions: [markdown(), objectBlocksExtension({}), ...extensions]
  }))
  return pressEnterThroughCommandChain(view)
}

function pressEditorEnterSelection(doc, from, to) {
  const view = fakeView(EditorState.create({
    doc,
    selection: { anchor: from, head: to },
    extensions: [markdown(), objectBlocksExtension({})]
  }))
  return pressEnterThroughCommandChain(view)
}

function assertCaretAtLineStart(state, lineNumber, message) {
  assert.equal(state.selection.main.head, state.doc.line(lineNumber).from, message)
}

const structuralCommand = EDITOR_COMMANDS.find(
  (command) => command.shortcutId === 'editor.protected-line-continue'
)
assert.ok(
  structuralCommand,
  'the protected structural-line command is present in the rebindable editor registry'
)

const protectedHeadingLevels = ['##', '###', '####']

// Rule 1: Enter at the start or middle of any slide heading never splits the heading.
for (const hashes of protectedHeadingLevels) {
  const heading = `${hashes} Protected heading`
  for (const column of [0, Math.min(9, heading.length)]) {
    const doc = `${heading}\n{id=heading-${hashes.length}}{sidebar}\n\nBody`
    const result = pressEditorEnter(doc, heading, column)
    assert.equal(result.handledBy, 'title-continue')
    assert.equal(result.state.doc.toString(), doc)
    assertCaretAtLineStart(
      result.state,
      3,
      `${hashes} heading Enter at column ${column} lands on the existing body line`
    )
  }
}

// A newly typed slide heading is structural before the id-stamping pass adds its Trigger line.
for (const hashes of protectedHeadingLevels) {
  const heading = `${hashes} Unstamped heading`
  for (const fixture of [
    {
      doc: `${heading}\nBody`,
      expected: `${heading}\nBody`,
      bodyLine: 2
    },
    {
      doc: heading,
      expected: `${heading}\n`,
      bodyLine: 2
    },
    {
      doc: `${heading}\n${hashes} Next slide`,
      expected: `${heading}\n\n${hashes} Next slide`,
      bodyLine: 2
    }
  ]) {
    const result = pressEditorEnter(fixture.doc, heading, 8)
    assert.equal(result.handledBy, 'title-continue')
    assert.equal(result.state.doc.toString(), fixture.expected)
    assertCaretAtLineStart(
      result.state,
      fixture.bodyLine,
      `${hashes} unstamped heading lands on or creates its body line without being split`
    )
  }
}

// Rule 2: Enter in the canonical Trigger line creates a body line at EOF without splitting it.
for (const hashes of protectedHeadingLevels) {
  const trigger = `{id=trigger-${hashes.length}}{sidebar}`
  for (const column of [0, 6, trigger.length]) {
    const doc = `${hashes} Protected trigger\n${trigger}`
    const result = pressEditorEnter(doc, trigger, column)
    assert.equal(result.handledBy, 'protected-line-continue')
    assert.equal(result.state.doc.toString(), `${doc}\n`)
    assert.equal(result.state.doc.line(2).text, trigger)
    assertCaretAtLineStart(
      result.state,
      3,
      `${hashes} Trigger-line Enter at column ${column} lands on the created body line`
    )
  }
}

// Rule 3: Enter at the end of a heading never wedges a blank line above its Trigger line.
for (const hashes of protectedHeadingLevels) {
  const heading = `${hashes} Protected title end`
  const trigger = `{id=title-end-${hashes.length}}{statement}`
  const doc = `${heading}\n${trigger}\n\nBody`
  const result = pressEditorEnter(
    doc,
    heading,
    heading.length
  )
  assert.equal(result.handledBy, 'title-continue')
  assert.equal(result.state.doc.toString(), doc)
  assert.deepEqual(
    result.state.doc.toString().split('\n').slice(0, 2),
    [heading, trigger]
  )
  assertCaretAtLineStart(result.state, 3, `${hashes} title-end Enter lands on the body line`)
}

// Rule 4: Enter in a compiler-recognised block token lands in its first list item.
for (const hashes of protectedHeadingLevels) {
  for (const column of [0, 5, '{chart=bar}'.length]) {
    const doc = [
      `${hashes} Protected block token`,
      `{id=block-token-${hashes.length}}`,
      '',
      '{chart=bar}',
      '',
      '- Alpha: 40',
      '- Beta: 60'
    ].join('\n')
    const result = pressEditorEnter(doc, '{chart=bar}', column)
    assert.equal(result.handledBy, 'protected-line-continue')
    assert.equal(result.state.doc.toString(), doc)
    assertCaretAtLineStart(
      result.state,
      6,
      `${hashes} block-token Enter at column ${column} lands in the first owned list item`
    )
  }
}

// Dominik ruling, 2026-07-29: every structural line lands on an existing first body line.
for (const hashes of protectedHeadingLevels) {
  const heading = `${hashes} Existing body`
  const trigger = `{id=existing-body-${hashes.length}}`
  const doc = `${heading}\n${trigger}\nBody already here`
  for (const [line, handledBy] of [
    [heading, 'title-continue'],
    [trigger, 'protected-line-continue']
  ]) {
    const result = pressEditorEnter(doc, line, line.length)
    assert.equal(result.handledBy, handledBy)
    assert.equal(result.state.doc.toString(), doc)
    assertCaretAtLineStart(
      result.state,
      3,
      `${hashes} ${line === heading ? 'heading' : 'Trigger line'} lands on the existing body without inserting a blank`
    )
  }
}

// Negative: ordinary body text retains the default newline transaction.
{
  const result = pressEditorEnter('Body text', 'Body text', 4)
  assert.equal(result.handledBy, 'default')
  assert.equal(
    result.state.doc.toString(),
    'Body\ntext',
    'Markdown Enter consumes the split-point space in production; this pre-existing behaviour is unchanged'
  )
}

// Negative: list continuation keeps its existing marker semantics.
{
  const result = pressEditorEnter('- Item', '- Item', '- Item'.length)
  assert.equal(result.handledBy, 'list-continue')
  assert.equal(result.state.doc.toString(), '- Item\n- ')
}

// Negative: Trigger-shaped text inside a fence retains the default newline transaction.
{
  const doc = ['```md', '{chart=bar}', '- Alpha: 40', '```'].join('\n')
  const result = pressEditorEnter(doc, '{chart=bar}', 6)
  assert.equal(result.handledBy, 'default')
  assert.equal(result.state.doc.toString(), doc.replace('{chart=bar}', '{chart\n=bar}'))
}

// Negative: while an object shell is open, Enter still runs through the real command chain and
// reaches production Markdown Enter for an ordinary paragraph.
{
  const doc = '{chart=bar}\n- Alpha: 40\n- Beta: 60\n\nBody text'
  let state = EditorState.create({
    doc,
    selection: { anchor: doc.indexOf('Body text') + 4 },
    extensions: [markdown(), objectBlocksExtension({})]
  })
  state = state.update({
    effects: setOpenObjectBlock.of({
      from: doc.indexOf('- Alpha'),
      to: doc.indexOf('\n\nBody')
    })
  }).state
  const result = pressEnterThroughCommandChain(fakeView(state))
  assert.equal(result.handledBy, 'default')
  assert.equal(
    result.state.doc.toString(),
    doc.replace('Body text', 'Body\ntext'),
    'an open object shell does not consume ordinary paragraph Enter'
  )
}

// A non-empty selection that intersects a structural line is refused without changing bytes.
{
  const doc = [
    '### Structural selection',
    '{id=selection}',
    '',
    '{chart=bar}',
    '- Alpha: 40',
    '',
    'Ordinary paragraph'
  ].join('\n')
  for (const [label, from, to, expectedHandler] of [
    ['heading and Trigger line', 0, doc.indexOf('\n\n'), 'title-continue'],
    ['canonical Trigger line', doc.indexOf('{id=selection}'), doc.indexOf('{id=selection}') + 5, 'protected-line-continue'],
    ['block token line', doc.indexOf('{chart=bar}'), doc.indexOf('{chart=bar}') + 5, 'protected-line-continue']
  ]) {
    const result = pressEditorEnterSelection(doc, from, to)
    assert.equal(result.handledBy, expectedHandler, `${label} is refused by the protected command`)
    assert.equal(result.state.doc.toString(), doc, `${label} selection leaves structural bytes unchanged`)
  }

  const ordinaryFrom = doc.indexOf('Ordinary')
  const ordinary = pressEditorEnterSelection(doc, ordinaryFrom, ordinaryFrom + 'Ordinary'.length)
  assert.equal(ordinary.handledBy, 'default', 'an ordinary selection remains on the default Enter path')
  assert.equal(
    ordinary.state.doc.toString(),
    doc.replace('Ordinary ', '\n'),
    'ordinary selected text and its split-point space follow the unchanged production Markdown newline'
  )
}

for (const alias of ['barchart', 'piechart', 'linechart']) {
  const doc = `### Alias {${alias}}\n{id=keep-alias-id}\nBody`
  const from = doc.indexOf('{')
  const to = doc.indexOf('}')
  const view = fakeView(EditorState.create({ doc, selection: { anchor: to } }))
  const calls = []
  const completions = triggerSource(new CompletionContext(view.state, to, true), {
    onInsertObject: (kind, request) => calls.push({ kind, request })
  })
  const completion = completions.options.find((entry) => entry.label === alias)
  assert.ok(completion, `${alias}: the brace palette exposes the registered alias`)
  completion.apply(view, completion, completions.from, to)
  assert.deepEqual(calls, [{ kind: 'chart', request: { triggerToken: alias, replace: { from, to: to + 1 } } }],
    `${alias}: the existing chart door receives the selected shape and exact provisional span`)
  assert.equal(view.state.doc.toString(), doc, 'the chart door owns the provisional replacement and preserves the slide ID')
}

console.log('test:protected-lines OK')
