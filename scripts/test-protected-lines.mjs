import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { stampMissingIds } from '../compiler/scripts/lib/12-outline-edit.mjs'

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
        "export { insertNewlineAndIndent, history, undo, undoDepth } from '@codemirror/commands'",
        "export { headingEndInsertion, insertAtHeadingEnd, pasteTextAtSelection, blockAnchorAfterLine, insertBlockAfterLine, insertBlockAtHeadingEnd, pasteAtHeadingEnd, pasteBlockAtSelection, startsWithBlockLine, caretLineInsertion, insertAtCaretLine } from './src/renderer/src/extensions/headingEndInsert.ts'",
        "export { moveBlock } from './src/renderer/src/extensions/slideBlockOps.ts'",
        "export { deleteSlideAtCursor, reLevel, jumpHeading, getCursorListItemContext, setHeadingFromPrevious } from './src/renderer/src/extensions/outliner.ts'",
        "export { planObjectBlockSplice } from './src/shared/objects/insert-objects.ts'",
        "export { tokenProtectExtension } from './src/renderer/src/extensions/idProtect.ts'",
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
  history, undo, undoDepth,
  headingEndInsertion, insertAtHeadingEnd, pasteTextAtSelection,
  blockAnchorAfterLine, insertBlockAfterLine, insertBlockAtHeadingEnd, pasteAtHeadingEnd, pasteBlockAtSelection, startsWithBlockLine, caretLineInsertion, insertAtCaretLine,
  moveBlock,
  deleteSlideAtCursor, reLevel, jumpHeading, getCursorListItemContext, setHeadingFromPrevious,
  planObjectBlockSplice,
  tokenProtectExtension,
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

// ── Text with a line break put in at the END of a heading line (headingEndInsert.ts) ──
// 0.38.3-preview.12: `# install\nnpm i foo` pasted with the caret at the end of `### Slide 3.0` put
// `npm i foo` between the title and `{id=s3-0}`, and the next save gave the heading a new id.
// The heading's id and layout lines stay directly under it; the save mints nothing.
{
  const J = (...lines) => lines.join('\n')
  const endOf = (doc, line) => positionInLine(doc, line, line.length)
  // The editor's own guard and history, so "passes the guard" and "one undo step" are the real ones.
  const editor = (doc, anchor) => fakeView(EditorState.create({ doc, selection: { anchor }, extensions: [markdown(), history(), tokenProtectExtension()] }))
  const paste = (doc, line, column, clip) => {
    const view = editor(doc, positionInLine(doc, line, column))
    const handled = insertAtHeadingEnd(view, clip, 'input.paste')
    return { view, handled, text: view.state.doc.toString() }
  }
  const CLIP = '# install\nnpm i foo'
  const SLIDES = J('## Part', '{id=part}', '', '### Slide 3.0', '{id=s3-0}', '', '- point 3.0', '', '### Slide 3.1', '{id=s3-1}', '', '- point 3.1', '')

  // The reported paste.
  {
    const r = paste(SLIDES, '### Slide 3.0', 99, CLIP)
    assert.equal(r.handled, true, 'the paste at the end of a stamped title is taken by the rule')
    assert.equal(r.text, J('## Part', '{id=part}', '', '### Slide 3.0# install', '{id=s3-0}', 'npm i foo', '', '- point 3.0', '', '### Slide 3.1', '{id=s3-1}', '', '- point 3.1', ''),
      'the first pasted line stays on the title, the rest goes under the id line')
    const lines = r.text.split('\n')
    assert.equal(lines[lines.indexOf('### Slide 3.0# install') + 1], '{id=s3-0}', 'the id line is still directly under its heading')
    assert.equal(r.view.state.selection.main.head, r.text.indexOf('npm i foo') + 'npm i foo'.length, 'the caret is at the end of the pasted text')
    assert.deepEqual([...r.text.split('\n')].sort(), [...SLIDES.split('\n').filter((l) => l !== '### Slide 3.0'), '### Slide 3.0# install', 'npm i foo'].sort(), 'no other line changed')
    // The save: the compiler's stampMissingIds, as talk:write-outline runs it. Nothing is minted.
    const saved = stampMissingIds(r.text)
    assert.deepEqual(saved.stamped, [], 'the save mints no id: every heading still has its own')
    assert.equal(saved.text, r.text, 'and the saved text is the editor\'s text')
    // One undo step.
    assert.equal(undoDepth(r.view.state), 1, 'the paste is one history event')
    assert.equal(undo(r.view), true)
    assert.equal(r.view.state.doc.toString(), SLIDES, 'one undo puts the whole paste back')
    // What the paste did before this rule (CodeMirror's replaceSelection), for the record: the id is
    // stranded under a body line and the save mints a fresh one for the heading.
    const old = editor(SLIDES, endOf(SLIDES, '### Slide 3.0'))
    old.dispatch(old.state.replaceSelection(CLIP))
    const oldLines = old.state.doc.toString().split('\n')
    assert.deepEqual(oldLines.slice(3, 6), ['### Slide 3.0# install', 'npm i foo', '{id=s3-0}'], 'the insertion this rule replaces: the id line under the body line')
  }
  // The same through the paste handler's own call (Editor.tsx: pasteTextAtSelection), and elsewhere it is replaceSelection.
  {
    const view = editor(SLIDES, endOf(SLIDES, '### Slide 3.1'))
    pasteTextAtSelection(view, 'a\nb\n')
    assert.equal(view.state.doc.toString(), J('## Part', '{id=part}', '', '### Slide 3.0', '{id=s3-0}', '', '- point 3.0', '', '### Slide 3.1a', '{id=s3-1}', 'b', '', '', '- point 3.1', ''), 'a clip that ends with a line break: its last line break stays, under the id line')
    const body = editor(SLIDES, endOf(SLIDES, '- point 3.0'))
    pasteTextAtSelection(body, 'a\nb')
    assert.equal(body.state.doc.toString(), SLIDES.replace('- point 3.0', '- point 3.0a\nb'), 'in body text the paste is the ordinary one')
  }
  // A layout line and an id line, a blank line before the block, the block ending the file, CRLF clip.
  {
    const rich = J('### Rich', '{columns}', '{id=rich}', 'body')
    assert.equal(paste(rich, '### Rich', 99, 'x\ny').text, J('### Richx', '{columns}', '{id=rich}', 'y', 'body'), 'after the LAST of the trigger-only lines')
    const gap = J('### Gap', '', '{id=gap}', 'body')
    assert.equal(paste(gap, '### Gap', 99, 'x\ny').text, J('### Gapx', '', '{id=gap}', 'y', 'body'), 'a blank line between the title and its id line: still after the id line')
    const last = J('### Last', '{id=last}')
    const r = paste(last, '### Last', 99, 'x\r\ny\r\nz')
    assert.equal(r.text, J('### Lastx', '{id=last}', 'y', 'z'), 'the block ends the file: the rest is appended, CRLF read as line breaks')
    assert.equal(r.view.state.selection.main.head, r.text.length, 'caret at the end')
    assert.deepEqual(stampMissingIds(r.text).stamped, [], 'no id minted')
    const next = J('### One', '{id=one}', '### Two', '{id=two}')
    assert.equal(paste(next, '### One', 99, 'x\ny').text, J('### Onex', '{id=one}', 'y', '### Two', '{id=two}'), 'the next heading directly below: the rest goes between the id line and it')
    const lead = paste(rich, '### Rich', 99, '\nonly below')
    assert.equal(lead.text, J('### Rich', '{columns}', '{id=rich}', 'only below', 'body'), 'a clip that starts with a line break leaves the title as it is')
  }
  // Where the rule does not apply: nothing is dispatched and the caller's ordinary path runs.
  {
    const plain = J('### No block', 'body')
    for (const [name, doc, line, column, clip] of [
      ['a clip with no line break', SLIDES, '### Slide 3.0', 99, 'one line'],
      ['the middle of a title', SLIDES, '### Slide 3.0', 7, CLIP],
      ['the start of a title', SLIDES, '### Slide 3.0', 0, CLIP],
      ['a title with no id or layout line under it', plain, '### No block', 99, CLIP],
      ['the end of the id line', SLIDES, '{id=s3-0}', 99, CLIP],
      ['a heading-shaped line in a code fence', J('### S', '{id=s}', '```sh', '# install', '{x}', '```'), '# install', 99, CLIP]
    ]) {
      const r = paste(doc, line, column, clip)
      assert.equal(r.handled, false, `${name}: not this rule`)
      assert.equal(r.text, doc, `${name}: nothing dispatched`)
    }
    assert.equal(headingEndInsertion(SLIDES, endOf(SLIDES, '### Slide 3.0'), 'one line'), null)
    // The Plain view rests the caret before a title's hidden `{…}` groups and counts it as the
    // line's end (lineEndCarets): the first pasted line goes in at the caret, the rest under the id line.
    {
      const tailed = J('### Title {reveal}', '{id=t1}', 'Body')
      const at = '### Title'.length
      assert.equal(headingEndInsertion(tailed, at, 'one\ntwo'), null, 'not the line\'s end, and no view says it counts as one')
      const plan = headingEndInsertion(tailed, at, 'one\ntwo', '### Title {reveal}'.length)
      let out = tailed
      for (const change of [...plan.changes].reverse()) out = out.slice(0, change.from) + change.insert + out.slice(change.from)
      assert.equal(out, J('### Titleone {reveal}', '{id=t1}', 'two', 'Body'))
      assert.equal(out.slice(0, plan.cursor), J('### Titleone {reveal}', '{id=t1}', 'two'), 'the caret is at the end of the pasted text')
    }
    const sel = fakeView(EditorState.create({ doc: SLIDES, selection: { anchor: endOf(SLIDES, '### Slide 3.0') - 3, head: endOf(SLIDES, '### Slide 3.0') } }))
    assert.equal(insertAtHeadingEnd(sel, CLIP, 'input.paste'), false, 'a selection (not a caret) is the ordinary paste')
    // For the record (unchanged behaviour): a line break pasted in the MIDDLE of a title splits it,
    // and the id line ends up under the second half, which is body text; the first half is a heading with no id.
    const mid = editor(SLIDES, positionInLine(SLIDES, '### Slide 3.0', 7))
    mid.dispatch(mid.state.replaceSelection('X\nY'))
    assert.deepEqual(mid.state.doc.toString().split('\n').slice(3, 6), ['### SliX', 'Yde 3.0', '{id=s3-0}'], 'mid-title: the id line follows the second half')
    assert.equal(stampMissingIds(mid.state.doc.toString()).stamped.length, 1, 'mid-title: the save mints an id for the first half (unchanged, reported)')
  }
  // Enter at the end of the talk's title (level 1: not a protected slide heading, Enter in it is the
  // ordinary Enter) when it has layout lines under it: the new empty line and the caret go after them.
  {
    const deck = J('# Talk', '{theme=dark}', '', '## One', '{id=one}')
    const r = pressEditorEnter(deck, '# Talk', 99)
    assert.equal(r.handledBy, 'title-continue')
    assert.equal(r.state.doc.toString(), J('# Talk', '{theme=dark}', '', '', '## One', '{id=one}'), 'the new empty line is under the title\'s layout line')
    assertCaretAtLineStart(r.state, 3, 'the caret is on the new empty line')
    const midTitle = pressEditorEnter(deck, '# Talk', 3)
    assert.equal(midTitle.handledBy, 'default', 'Enter in the middle of the talk\'s title is the ordinary Enter, as before')
    const bare = pressEditorEnter(J('# Talk', '', '## One'), '# Talk', 99)
    assert.equal(bare.handledBy, 'default', 'a title with no layout line under it: the ordinary Enter, as before')
    assert.equal(bare.state.doc.toString(), J('# Talk', '', '', '## One'))
  }

  // ── A BLOCK put in on a heading line: the whole block goes under the id and layout lines ──
  // Review of 54bc68e0: a pasted GIF or video on `### Slide 3.0` went in at the end of the title line
  // (`### Slide 3.0` / `![](clip)` / blank / `{id=s3-0}`), and a pasted SVG or table had its first
  // line glued onto the title. The heading line is left as it is and its id line stays under it.
  const headingKept = (text, heading, idLine, label) => {
    const lines = text.split('\n')
    const at = lines.indexOf(heading)
    assert.notEqual(at, -1, `${label}: the heading line is untouched`)
    assert.equal(lines[at + 1], idLine, `${label}: the id line is still directly under its heading`)
    assert.deepEqual(stampMissingIds(text).stamped, [], `${label}: the save mints no id`)
    assert.equal(stampMissingIds(text).text, text, `${label}: the saved text is the editor's text`)
  }
  const oneUndo = (view, before, label) => {
    assert.equal(undoDepth(view.state), 1, `${label}: one history event`)
    assert.equal(undo(view), true)
    assert.equal(view.state.doc.toString(), before, `${label}: one undo restores the text byte for byte`)
  }
  // Video/GIF paste (Editor.tsx insertMediaResult): after the line, the caret anywhere on it.
  {
    const clip = '![](vid-1a2b3c4){autoplay}{loop}{muted}'
    for (const column of [0, 7, 99]) {
      const view = editor(SLIDES, positionInLine(SLIDES, '### Slide 3.0', column))
      const from = insertBlockAfterLine(view, view.state.selection.main.head, '\n' + clip + '\n', { caret: ('\n' + clip).length })
      const text = view.state.doc.toString()
      assert.equal(text, J('## Part', '{id=part}', '', '### Slide 3.0', '{id=s3-0}', clip, '', '', '- point 3.0', '', '### Slide 3.1', '{id=s3-1}', '', '- point 3.1', ''),
        `clip on a title, caret at column ${column}: the clip line is under the id line`)
      assert.equal(from, endOf(SLIDES, '{id=s3-0}'), 'the place of insertion is the end of the id line')
      assert.equal(view.state.selection.main.head, text.indexOf(clip) + clip.length, 'the caret is at the end of the clip line, as on any other line')
      headingKept(text, '### Slide 3.0', '{id=s3-0}', `clip, column ${column}`)
      oneUndo(view, SLIDES, `clip, column ${column}`)
    }
    // The insertion this replaces (changes: { from: line.to, … }): the id is stranded and the save mints one.
    const old = editor(SLIDES, endOf(SLIDES, '### Slide 3.0'))
    old.dispatch({ changes: { from: endOf(SLIDES, '### Slide 3.0'), insert: '\n' + clip + '\n' } })
    assert.deepEqual(old.state.doc.toString().split('\n').slice(3, 7), ['### Slide 3.0', clip, '', '{id=s3-0}'], 'for the record: the old insertion strands the id line')
    assert.equal(stampMissingIds(old.state.doc.toString()).stamped.length, 1, 'for the record: the old insertion makes the save mint an id')
  }
  // The other "after the line" paths: pasted and dropped picture, dropped SVG, component and slide at the caret.
  {
    const rich = J('### Rich', '{columns}', '{id=rich}', 'body')
    const picture = editor(rich, positionInLine(rich, '### Rich', 2))
    insertBlockAfterLine(picture, picture.state.selection.main.head, '\n![](img-abc1234)\n')
    assert.equal(picture.state.doc.toString(), J('### Rich', '{columns}', '{id=rich}', '![](img-abc1234)', '', 'body'), 'after the LAST of the trigger-only lines')
    assert.equal(picture.state.selection.main.head, positionInLine(rich, '### Rich', 2), 'with no caret given the caret stays where it was')
    headingKept(picture.state.doc.toString(), '### Rich', '{columns}', 'pasted picture')
    oneUndo(picture, rich, 'pasted picture')

    const last = J('### Last', '{id=last}')
    const svg = '\n\n```svg\n<svg></svg>\n```\n'
    const dropped = editor(last, 0)
    insertBlockAfterLine(dropped, 3, svg, { caret: svg.length })
    assert.equal(dropped.state.doc.toString(), J('### Last', '{id=last}', '', '```svg', '<svg></svg>', '```', ''), 'the block ends the file: the dropped SVG is appended under the id line')
    assert.equal(dropped.state.selection.main.head, dropped.state.doc.length, 'the caret is after the dropped block')
    headingKept(dropped.state.doc.toString(), '### Last', '{id=last}', 'dropped SVG')
    oneUndo(dropped, last, 'dropped SVG')

    const gap = J('### Gap', '', '{id=gap}', 'body')
    assert.equal(blockAnchorAfterLine(gap, 0), endOf(gap, '{id=gap}'), 'a blank line between the title and its id line: still after the id line')
    const next = J('### One', '{id=one}', '### Two', '{id=two}')
    const slide = editor(next, 1)
    insertBlockAfterLine(slide, 1, '\n\n```js\nx\n```\n', { caret: 3, scrollIntoView: true })
    assert.equal(slide.state.doc.toString(), J('### One', '{id=one}', '', '```js', 'x', '```', '', '### Two', '{id=two}'), 'the next heading directly below: the block goes between the id line and it')
    assert.deepEqual(stampMissingIds(slide.state.doc.toString()).stamped, [], 'no id minted')

    // An object from the Insert menu (Editor.tsx insertObject): every kind, not only charts, goes under the id line.
    const at = blockAnchorAfterLine(SLIDES, positionInLine(SLIDES, '### Slide 3.0', 4))
    const splice = planObjectBlockSplice(SLIDES, at, '| a | b |\n| :--- | :--- |\n| 1 | 2 |')
    const table = SLIDES.slice(0, splice.from) + splice.insert + SLIDES.slice(splice.to)
    headingKept(table, '### Slide 3.0', '{id=s3-0}', 'inserted table object')
    assert.equal(table.slice(splice.blockFrom, splice.blockTo), '| a | b |\n| :--- | :--- |\n| 1 | 2 |', 'the object block is where the plan says it is')

    // Not a heading with trigger-only lines under it: the end of the line, exactly as before.
    const plain = J('### No block', 'body')
    for (const [name, doc, pos] of [
      ['a body line', SLIDES, positionInLine(SLIDES, '- point 3.0', 3)],
      ['the id line itself', SLIDES, positionInLine(SLIDES, '{id=s3-0}', 2)],
      ['an empty line', SLIDES, positionInLine(SLIDES, '### Slide 3.0', 0) - 1],
      ['a title with no id or layout line under it', plain, 4],
      ['a heading-shaped line in a code fence', J('### S', '{id=s}', '```sh', '# install', '{x}', '```'), 22]
    ]) {
      const lineEnd = doc.indexOf('\n', pos) < 0 ? doc.length : doc.indexOf('\n', pos)
      assert.equal(blockAnchorAfterLine(doc, pos), lineEnd, `${name}: the end of that line`)
      const view = editor(doc, pos)
      assert.equal(insertBlockAfterLine(view, pos, '\nX\n', { caret: 2 }), lineEnd)
      assert.equal(view.state.doc.toString(), doc.slice(0, lineEnd) + '\nX\n' + doc.slice(lineEnd), `${name}: inserted at the end of that line`)
      assert.equal(view.state.selection.main.head, lineEnd + 2, `${name}: caret as before`)
    }
  }
  // A block pasted as TEXT with the caret at the end of a title: fenced SVG, table, picture line.
  {
    const SVG = '```svg\n<svg xmlns="http://www.w3.org/2000/svg"></svg>\n```\n'
    const TABLE = '| a | b |\n| :--- | :--- |\n| 1 | 2 |\n'
    for (const [name, clip, viaText] of [
      ['SVG', SVG, false], ['table', TABLE, false],
      ['SVG through the text paste', SVG, true], ['table through the text paste', TABLE, true],
      ['picture line and text (materialised assets)', '![](img-abc1234)\nA caption', true],
      ['code fence with CRLF', '```sh\r\nnpm i foo\r\n```', true]
    ]) {
      const view = editor(SLIDES, endOf(SLIDES, '### Slide 3.0'))
      if (viaText) pasteTextAtSelection(view, clip)
      else pasteBlockAtSelection(view, clip)
      const lf = clip.replace(/\r\n/g, '\n')
      const text = view.state.doc.toString()
      assert.equal(text, SLIDES.replace('{id=s3-0}\n', '{id=s3-0}\n' + lf + '\n'), `${name}: the whole block is under the id line, on its own line`)
      assert.equal(view.state.selection.main.head, text.indexOf(lf) + lf.length, `${name}: the caret is at the end of the pasted block`)
      headingKept(text, '### Slide 3.0', '{id=s3-0}', name)
      oneUndo(view, SLIDES, name)
    }
    assert.equal(startsWithBlockLine(CLIP), false, 'prose is not a block')
    assert.equal(startsWithBlockLine('![a](b) and then words\nmore'), false, 'a picture inside a sentence is prose')
    assert.equal(startsWithBlockLine('![](vid-1){autoplay}{loop}{muted}'), true)
    // Review of 7d58c913: what is and is not a block at the start of pasted text.
    for (const [clip, block, why] of [
      ['| is how a shell pipes\nmore words', false, 'prose that merely starts with | is not a table'],
      ['| a | b |\nnot a separator', false, 'a | line with no separator row under it is prose'],
      ['| a | b |', false, 'one | line alone is prose'],
      ['| a | b |\n|---|---|\n| 1 | 2 |', true, 'a table row with its separator row'],
      ['| a | b |\n| :--- | ---: |', true, 'a separator row with colons'],
      ['```npm i``` installs it\nmore', false, 'inline code in three backticks is prose'],
      ['`npm i` installs it\nmore', false, 'inline code is prose'],
      ['```sh\nnpm i\n```', true, 'a backtick fence with an info string'],
      ['````\nx\n````', true, 'a longer backtick fence'],
      ['~~~\nx\n~~~', true, 'a tilde fence'],
      ['~~~md extra `words`\nx\n~~~', true, 'a tilde fence with an info string'],
      ['[Embed: https://example.com]\nA caption', true, 'an embed line'],
      ['[QR: https://example.com | Label]\nmore', true, 'a QR line'],
      ['[Simulation: sim.html]\nmore', true, 'a simulation line'],
      ['[Action: Go -> https://example.com]\nmore', true, 'an action line'],
      ['[Action: Go](https://example.com)\nmore', true, 'an action line in its link form'],
      ['[Video: clip.mp4] {play-on-next}\nmore', true, 'a video line with its token'],
      ['https://example.com/page\nmore', true, 'a URL alone on its line (auto-embed)'],
      ['[Embed: page.html] and then words\nmore', false, 'a component inside a sentence is prose'],
      ['[a link](https://example.com) and words\nmore', false, 'a Markdown link is prose'],
      ['[Note: remember this]\nmore', false, 'a bracketed word the registry and the lexer do not know is prose'],
      ['see https://example.com for more\nmore', false, 'a URL in a sentence is prose'],
      ['<div class="x">\nhello\n</div>', true, 'an HTML block'],
      ['<!-- a comment -->\nmore', true, 'an HTML comment'],
      ['</div>\nmore', true, 'a closing tag'],
      ['<https://example.com> is the page\nmore', false, 'a link in angle brackets is prose'],
      ['<3 this slide\nmore', false, '< before a digit is prose'],
    ]) assert.equal(startsWithBlockLine(clip), block, why)
    {
      // A very long first line is prose, and is decided at once: the component pattern backtracks
      // quadratically on a long run of `]{` (20,000 of them took 314 ms before the length bound).
      const t0 = performance.now()
      for (const long of ['[QR: x' + ']{'.repeat(20000), '[Embed: ' + 'a'.repeat(5000) + ']', '[QR: x' + ']{'.repeat(20000) + '\n| a |\n']) {
        assert.equal(startsWithBlockLine(long), false, 'a first line over 2,000 characters is prose')
      }
      const took = performance.now() - t0
      assert.ok(took < 100, `three pathological first lines took ${Math.round(took)} ms`)
      assert.equal(startsWithBlockLine('[Embed: ' + 'a'.repeat(1900) + ']\nmore'), true, 'a long component line under the bound is still a component')
    }
    for (const clip of ['[Embed: https://example.com]\nA caption', '<div>\nhello\n</div>', '~~~\nx\n~~~', '[QR: https://example.com | Label]\nmore']) {
      const view = editor(SLIDES, endOf(SLIDES, '### Slide 3.0'))
      assert.equal(pasteAtHeadingEnd(view, clip), true)
      const text = view.state.doc.toString()
      assert.equal(text, SLIDES.replace('{id=s3-0}\n', '{id=s3-0}\n' + clip + '\n'), `${clip.split('\n')[0]}: the whole block is under the id line`)
      headingKept(text, '### Slide 3.0', '{id=s3-0}', clip.split('\n')[0])
      oneUndo(view, SLIDES, clip.split('\n')[0])
    }
    for (const clip of ['| is how a shell pipes\nmore words', '```npm i``` installs it\nmore']) {
      const view = editor(SLIDES, endOf(SLIDES, '### Slide 3.0'))
      assert.equal(pasteAtHeadingEnd(view, clip), true)
      const [first, rest] = clip.split('\n')
      const text = view.state.doc.toString()
      assert.equal(text, SLIDES.replace('### Slide 3.0\n{id=s3-0}\n', '### Slide 3.0' + first + '\n{id=s3-0}\n' + rest + '\n'), `${first}: prose, first line on the title, the rest under the id line`)
      assert.deepEqual(stampMissingIds(text).stamped, [], `${first}: the save mints no id`)
      oneUndo(view, SLIDES, first)
    }
    // Prose keeps the rule above; a block elsewhere is the ordinary paste.
    const prose = editor(SLIDES, endOf(SLIDES, '### Slide 3.0'))
    assert.equal(pasteAtHeadingEnd(prose, CLIP), true)
    assert.deepEqual(prose.state.doc.toString().split('\n').slice(3, 6), ['### Slide 3.0# install', '{id=s3-0}', 'npm i foo'], 'prose: first line on the title, the rest under the id line (unchanged)')
    const plain = J('### No block', 'body')
    for (const [name, doc, line, column] of [
      ['the middle of a title', SLIDES, '### Slide 3.0', 7],
      ['a title with no id or layout line under it', plain, '### No block', 99],
      ['a body line', SLIDES, '- point 3.0', 99]
    ]) {
      const pos = positionInLine(doc, line, column)
      const view = editor(doc, pos)
      assert.equal(insertBlockAtHeadingEnd(view, SVG, 'input.paste'), false, `${name}: not this rule`)
      assert.equal(view.state.doc.toString(), doc, `${name}: nothing dispatched`)
      pasteBlockAtSelection(view, SVG)
      assert.equal(view.state.doc.toString(), doc.slice(0, pos) + SVG + doc.slice(pos), `${name}: the ordinary paste, exactly as before`)
    }
    const sel = editor(SLIDES, endOf(SLIDES, '### Slide 3.0'))
    sel.dispatch({ selection: { anchor: endOf(SLIDES, '### Slide 3.0') - 3, head: endOf(SLIDES, '### Slide 3.0') } })
    assert.equal(insertBlockAtHeadingEnd(sel, SVG, 'input.paste'), false, 'a selection (not a caret) is the ordinary paste')
  }
  // Review of 7d58c913: a whole slide put in at the caret (Editor.tsx registerInsert → insertAtCaretLine)
  // with the caret on a slide's title went under the title's id line, so the title's body became the
  // new slide's body. Whole slides go after the whole block of the caret's heading; a component keeps
  // its place under the id line; off a heading line everything is as it was.
  {
    const NEW = '### New\n{id=new01}\n\n- new point'
    const was = (doc, pos, source) => { // 7d58c913, registerInsert as it was written
      const block = source.replace(/^\n+/, '').replace(/\n+$/, '')
      const insert = '\n\n' + block + '\n'
      const from = blockAnchorAfterLine(doc, pos)
      return { text: doc.slice(0, from) + insert + doc.slice(from), cursor: from + insert.length }
    }
    const put = (doc, pos, source) => {
      const view = editor(doc, pos)
      insertAtCaretLine(view, source)
      const text = view.state.doc.toString()
      const plan = caretLineInsertion(doc, pos, source)
      assert.equal(text, doc.slice(0, plan.from) + plan.insert + doc.slice(plan.from), 'the plan is the change')
      assert.equal(view.state.selection.main.head, plan.cursor)
      assert.deepEqual(stampMissingIds(text).stamped, [], 'the save mints no id')
      assert.equal(stampMissingIds(text).text, text, 'the saved text is the editor\'s text')
      oneUndo(view, doc, 'insert at the caret')
      return { text, cursor: plan.cursor }
    }
    // The reported case, the caret anywhere on the title.
    for (const column of [0, 5, 99]) {
      const r = put(SLIDES, positionInLine(SLIDES, '### Slide 3.0', column), NEW)
      assert.equal(r.text, J('## Part', '{id=part}', '', '### Slide 3.0', '{id=s3-0}', '', '- point 3.0', '', '### New', '{id=new01}', '', '- new point', '', '### Slide 3.1', '{id=s3-1}', '', '- point 3.1', ''),
        'the new slide is after the whole slide the caret is on: its id line and its body stay its own')
      assert.equal(r.cursor, r.text.indexOf('- new point') + '- new point'.length, 'the caret is at the end of the inserted slide')
    }
    // A section: after its slides. The last slide: at the end, the file ending as it did. Several slides at once.
    assert.equal(put(SLIDES, positionInLine(SLIDES, '## Part', 2), NEW).text, SLIDES.replace(/\n$/, '\n\n' + NEW + '\n'), 'on a section title: after the whole section')
    assert.equal(put(SLIDES, positionInLine(SLIDES, '### Slide 3.1', 99), NEW).text, SLIDES.replace(/\n$/, '\n\n' + NEW + '\n'), 'on the last slide: at the end of the talk')
    const noNewline = J('### A', '{id=a}', 'body of A')
    assert.equal(put(noNewline, 2, NEW).text, noNewline + '\n\n' + NEW, 'no final newline: none is added')
    const tight = J('### A', '{id=a}', 'body of A', '### B', '{id=b}')
    assert.equal(put(tight, 2, '\n' + NEW + '\n\n### Second\n{id=new02}\n').text, J('### A', '{id=a}', 'body of A', '', '### New', '{id=new01}', '', '- new point', '', '### Second', '{id=new02}', '', '### B', '{id=b}'),
      'no blank lines round the place: one is put on each side; two slides go in together')
    const deeper = J('## S', '{id=s}', 'intro', '### Child', '{id=c}', 'child body', '## T', '{id=t}')
    assert.ok(put(deeper, positionInLine(deeper, '### Child', 3), NEW).text.includes('child body\n\n### New\n{id=new01}\n\n- new point\n\n## T'), 'before the next heading of a shallower level')
    // Nothing lands before the talk's title, and the title's own block is the whole talk.
    const titled = J('# Talk', '', '## One', '{id=one}', '', '- x', '')
    // With the caret on the title (where a freshly opened talk has it) the slide goes to the START of
    // the talk: after the title's own lines and before the first slide or section, where "Move … to…
    // Start of talk" lands. (fcfcd8ec put it at the end of the talk: "open talk, insert" appended.)
    for (const column of [0, 3, 6]) {
      assert.equal(put(titled, column, NEW).text, J('# Talk', '', '### New', '{id=new01}', '', '- new point', '', '## One', '{id=one}', '', '- x', ''), 'on the talk\'s title: before the first section')
    }
    const titleLines = J('---', 'title: "T"', '---', '# Talk', '{id=deck}{theme=dark}', 'A line of the title\'s own.', '', '## One', '{id=one}', '', '### S', '{id=s}', '')
    const onTitle = put(titleLines, positionInLine(titleLines, '# Talk', 4), NEW)
    assert.equal(onTitle.text, J('---', 'title: "T"', '---', '# Talk', '{id=deck}{theme=dark}', 'A line of the title\'s own.', '', '### New', '{id=new01}', '', '- new point', '', '## One', '{id=one}', '', '### S', '{id=s}', ''),
      'after the title, its id and layout line and its own text; before the first deeper heading')
    assert.equal(onTitle.cursor, onTitle.text.indexOf('- new point') + '- new point'.length, 'the caret is at the end of the inserted slide')
    {
      // The same place "Move … to… Start of talk" puts a slide.
      const moved = moveBlock(titleLines, titleLines.split('\n').indexOf('### S') + 1, { kind: 'start' })
      assert.equal(moved.line, onTitle.text.split('\n').indexOf('### New') + 1, 'the line Move … to… Start of talk lands on')
    }
    const fencedUnderTitle = J('# Talk', '```sh', '## in code', '```', '', '## One', '{id=one}', '')
    assert.equal(put(fencedUnderTitle, 2, NEW).text, J('# Talk', '```sh', '## in code', '```', '', '### New', '{id=new01}', '', '- new point', '', '## One', '{id=one}', ''), 'a fenced `##` under the title is the title\'s text, not the first section')
    const onlyTitle = J('# Talk', 'title text', '')
    assert.equal(put(onlyTitle, 1, NEW).text, J('# Talk', 'title text', '', '### New', '{id=new01}', '', '- new point', ''), 'a talk with only its title: the end of the talk')
    // A slide's block does not end inside its own code fence: the insert lands after the whole slide.
    const REPRO = J('### A', '{id=a}', '```sh', '# install', 'npm i', '```', 'after fence', '### B', '{id=b}')
    for (const column of [0, 5]) {
      assert.equal(put(REPRO, column, NEW).text, J('### A', '{id=a}', '```sh', '# install', 'npm i', '```', 'after fence', '', '### New', '{id=new01}', '', '- new point', '', '### B', '{id=b}'),
        'the caret on a slide with a fenced `# install`: the new slide is after the fence and the slide\'s last line')
    }
    // An id the talk already has is kept as given (the insert channel never re-ids; the save reports it).
    const same = caretLineInsertion(SLIDES, positionInLine(SLIDES, '### Slide 3.0', 2), '### Copy\n{id=s3-1}\n\nbody')
    assert.equal(same.insert, '### Copy\n{id=s3-1}\n\nbody\n\n', 'the slide goes in exactly as given')
    // A component, a picture line and text that starts with the talk-title level keep the 7d58c913 place.
    for (const source of ['[QR: https://example.com | Label]', '```python\n\n```', '![](img-abc1234)', '# Not slides\nwords']) {
      for (const column of [0, 99]) {
        const pos = positionInLine(SLIDES, '### Slide 3.0', column)
        assert.deepEqual(put(SLIDES, pos, source), was(SLIDES, pos, source), `${source.split('\n')[0]}: under the id line, as before`)
      }
    }
    assert.ok(put(SLIDES, positionInLine(SLIDES, '### Slide 3.0', 4), '[QR: https://example.com | Label]').text.includes('### Slide 3.0\n{id=s3-0}\n\n[QR: https://example.com | Label]\n\n\n- point 3.0'))
    // The caret not on a heading line: every insert, slides included, is byte for byte what it was.
    const fenced = J('### S', '{id=s}', '```sh', '# install', '{x}', '```', 'after')
    for (const [name, doc, pos] of [
      ['a body line', SLIDES, positionInLine(SLIDES, '- point 3.0', 3)],
      ['the id line', SLIDES, positionInLine(SLIDES, '{id=s3-0}', 2)],
      ['an empty line', SLIDES, positionInLine(SLIDES, '### Slide 3.0', 0) - 1],
      ['the last line', SLIDES, SLIDES.length],
      ['a heading-shaped line in a code fence', fenced, positionInLine(fenced, '# install', 3)],
    ]) {
      for (const source of [NEW, '\n\n' + NEW + '\n\n', '[QR: https://example.com | Label]', '![](img-abc1234)']) {
        assert.deepEqual(put(doc, pos, source), was(doc, pos, source), `${name}: ${source.trim().split('\n')[0]} goes in as before`)
      }
    }
    // What "as before" is on a body line (recorded, not changed): the slide starts right after the caret's line.
    const mid = J('### A', '{id=a}', 'first', 'second')
    assert.equal(put(mid, positionInLine(mid, 'first', 2), NEW).text, J('### A', '{id=a}', 'first', '', '### New', '{id=new01}', '', '- new point', '', 'second'))
  }
  // The outliner's commands read the same headings (src/shared/heading-lines.ts): a heading-shaped
  // line in a slide's fenced code is not the slide's heading, not the end of its block and not a
  // heading to re-level or jump to.
  {
    const CODE = J('### A', '{id=a}', '', '- one', '```md', '# install', '#### sample', '```', '- two', 'after fence', '', '#### Step', '{id=st}', 'step text', '', '### B', '{id=b}', '')
    const at = (line, column = 0) => editor(CODE, positionInLine(CODE, line, column))
    const lineOfCaret = (view) => view.state.doc.lineAt(view.state.selection.main.head).text
    // Delete slide, the caret below the fence: the whole of A goes (its step with it), B is left.
    const del = at('after fence', 2)
    assert.equal(deleteSlideAtCursor(del), true)
    assert.equal(del.state.doc.toString(), J('### B', '{id=b}', ''), 'delete slide below a fence: the slide the caret is in, whole')
    oneUndo(del, CODE, 'delete slide')
    // Demote with the subtree: A and its step; the fenced `####` is code and is left as written.
    const demote = at('### A', 2)
    assert.equal(reLevel(demote, 1, true), true)
    assert.equal(demote.state.doc.toString(), CODE.replace('### A', '#### A').replace('#### Step', '##### Step'), 'demote a slide with its subtree: the fenced heading-shaped lines are untouched')
    // On the fenced line itself the key indents it as it does any line of text; it is not re-levelled.
    const inCode = at('# install', 2)
    reLevel(inCode, 1, false)
    assert.equal(inCode.state.doc.toString(), CODE.replace('# install', '  # install'), 'a fenced `# ` line is a line of text')
    // Jump to the next and the previous heading.
    const down = at('### A', 1)
    jumpHeading(down, 'down')
    assert.equal(lineOfCaret(down), '#### Step', 'next heading: past the fence')
    const up = at('after fence', 1)
    jumpHeading(up, 'up')
    assert.equal(lineOfCaret(up), '### A', 'previous heading: the slide\'s own title')
    // The icon picker's bullet: counted in the slide the bullet is in.
    assert.deepEqual(getCursorListItemContext(at('- two', 3)), { slideHeading: '### A', itemLine: CODE.split('\n').indexOf('- two') + 1 }, 'the second bullet of A, below its fence')
    // "Heading like the previous one" below a fence: the previous real heading's level.
    const like = at('after fence', 1)
    setHeadingFromPrevious(like, 'same')
    assert.equal(lineOfCaret(like), '### after fence', 'the level of the slide\'s title, not of the fenced line')
  }
  // No insert path in Editor.tsx works the place out by hand: each goes through headingEndInsert.ts.
  {
    const source = readFileSync(new URL('../src/renderer/src/components/Editor.tsx', import.meta.url), 'utf8')
    assert.doesNotMatch(source, /from:\s*line\.to\b/, 'Editor.tsx: no insertion at the end of the caret line built by hand')
    assert.doesNotMatch(source, /replaceSelection\(/, 'Editor.tsx: no paste that skips the heading rules')
    for (const call of [
      /insertBlockAfterLine\(view, at, '\\n' \+ md \+ '\\n'/, // video and GIF, pasted or dropped
      /insertBlockAfterLine\(viewRef\.current, pos, /, // pasted picture
      /insertBlockAfterLine\(current, dropPos, /, // dropped SVG
      /insertBlockAfterLine\(viewRef\.current, dropPos, /, // dropped picture
      /insertAtCaretLine\(view, text\)/, // component or slide at the caret
      /blockAnchorAfterLine\(view\.state\.doc\.toString\(\), head\)/, // object from the Insert menu
      /pasteBlockAtSelection\(v, '```svg/, /pasteBlockAtSelection\(v, serialiseTable/
    ]) assert.match(source, call, `Editor.tsx calls ${call}`)
  }
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
