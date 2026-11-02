// Focused robustness tests for the object cards of ADR-0042 (fences, speaker notes, HTML comments, page
// embeds): recogniser parity with the compiler's reading, lossless row round trips, no-op and Discard
// writing nothing, isolated undo, refusals, unclosed regions failing closed, the capture marker grouped
// with its page, and the agent verbs' stale checks. CodeMirror state only; no browser, nothing on screen.
import { strict as assert } from 'node:assert'
import { history, undo, undoDepth } from '@codemirror/commands'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { readOutlineLines } from '../src/shared/plain-view-outline-lines.ts'
import { readOutlineObjectRegions } from '../src/shared/objects/outline-object-regions.ts'
import { detectOutlineObjects } from '../src/renderer/src/extensions/objectBlocks/detect.ts'
import {
  ObjectEditorWidget,
  objectBlocksExtension,
  objectBlocksIn,
  setOpenObjectBlock
} from '../src/renderer/src/extensions/objectBlocks/field.ts'
import { planObjectEditorCommit, innerSource } from '../src/renderer/src/objects/registry.ts'
import { isNotesOpenLine } from '../compiler/scripts/lib/outline-regions.mjs'
import { serialiseSegments, splitSegments, segmentHash } from '../compiler/scripts/lib/simulation-segments.mjs'
import {
  commentList, commentRemove, commentReplace, notesGet, notesInsert, notesRemove, notesReplace, rowList, rowReplace
} from '../src/shared/objects/object-verbs.ts'
import { deletionNotice } from '../src/renderer/src/extensions/objectBlocks/commands.ts'
import { installTestDom } from './test-dom.mjs'

installTestDom()
let passed = 0
function test(name, fn) {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

const kindsOf = (text) => detectOutlineObjects(text).blocks.map((b) => [b.kind, b.info ?? null])

console.log('Recogniser parity')
test('the whole info string decides the fence kind; unknown and near-miss info strings are code, never SVG', () => {
  assert.deepEqual(kindsOf('# T\n\n```python\nx = 1\n```\n'), [['code', 'python']])
  assert.deepEqual(kindsOf('# T\n\n```svg extra\n<svg/>\n```\n')[0][0], 'code')
  assert.deepEqual(kindsOf('# T\n\n```\nplain\n```\n')[0][0], 'code')
})
test('only closed fences become objects; an unclosed fence stays text', () => {
  assert.deepEqual(kindsOf('# T\n\n```python\nx = 1\n'), [])
})
test('no objects inside comments, notes or front matter', () => {
  assert.deepEqual(kindsOf('# T\n\n<!--\n```python\nx\n```\n-->\n').filter(([k]) => k !== 'comment'), [])
  const inNotes = kindsOf('# T\n\n:::notes\n```python\nx\n```\n:::\n')
  assert.deepEqual(inNotes, [['notes', null]], 'a fence inside notes is notes body, not a card')
  assert.deepEqual(kindsOf('---\ntitle: x\nnote: <!-- c -->\n---\n# T\n'), [])
})
test('region line kinds match readOutlineLines (the compiler reading) over a mixed fixture', () => {
  const text = [
    '---', 'title: Talk', '---', '# Talk', '', '## One', 'Text <!-- inline --> more', '', '<!--', 'block', '-->', '',
    '```chat', 'user: hi', 'bot: hello', '```', '', ':::notes', 'Private', '```', 'code in notes', '```', ':::', '',
    '## Two', ':::notes', 'unclosed', '## Three', '```python', '# not a heading', '```', ''
  ].join('\n')
  const plain = readOutlineLines(text)
  const regions = readOutlineObjectRegions(text)
  const kinds = Array.isArray(plain) ? plain.map((l) => l.kind) : plain.kinds ?? plain.lines?.map((l) => l.kind)
  assert.ok(Array.isArray(kinds), 'readOutlineLines exposes per-line kinds')
  const comparable = (k) => (k === 'notes' || k === 'comment' || k === 'fence' || k === 'frontmatter' ? k : 'outline')
  regions.kinds.forEach((kind, i) => assert.equal(comparable(kind), comparable(kinds[i]), `line ${i + 1}: ${text.split('\n')[i]}`))
})
test('notes open exactly on `:::notes` (trimmed, any case); `::: notes` and `:::notes x` are not notes', () => {
  assert.ok(isNotesOpenLine(':::notes') && isNotesOpenLine('  :::NOTES  '))
  assert.ok(!isNotesOpenLine('::: notes') && !isNotesOpenLine(':::notes x'))
  assert.deepEqual(kindsOf('# T\n\n::: notes\nnot notes\n:::\n'), [])
})

console.log('Notes and comments')
test('only closed notes get a card; unclosed notes stay raw with a close action', () => {
  const found = detectOutlineObjects('# T\n\n:::notes\nopen\n\n## Next\n')
  assert.equal(found.blocks.filter((b) => b.kind === 'notes').length, 0)
  assert.ok(found.warnings.some((w) => w.kind === 'unclosed-notes' && typeof w.closeAt === 'number'))
})
test('each of several notes blocks keeps its own card', () => {
  assert.equal(kindsOf('# T\n\n:::notes\na\n:::\n\n:::notes\nb\n:::\n').length, 2)
})
test('an unclosed <!-- fails closed: a warning, and the objects after it are still read', () => {
  const found = detectOutlineObjects('# T\n\nText <!-- never closed\n\n```python\nx\n```\n')
  assert.ok(found.warnings.some((w) => w.kind === 'unclosed-comment'))
  assert.deepEqual(found.blocks.map((b) => b.kind), ['code'])
})
test('a standalone comment is a block card, an inline one a chip, a mixed multi-line one stays raw', () => {
  const found = detectOutlineObjects('# T\n\n<!-- alone -->\n\nText <!-- chip --> more\n\nA <!-- mixed\nlines --> B\n')
  assert.deepEqual(found.blocks.map((b) => b.kind), ['comment'])
  assert.equal(found.inline.length, 1)
  assert.equal(found.inline[0].source, '<!-- chip -->')
})
test('no comment widgets inside fences', () => {
  const found = detectOutlineObjects('# T\n\n```html\n<!-- code -->\n```\n')
  assert.deepEqual(found.blocks.map((b) => b.kind), ['code'])
  assert.equal(found.inline.length, 0)
})
test('the saved-views marker and its {capture} lines belong to the web page card', () => {
  const text = '# T\n\n[Embed: https://example.org/page]\n<!-- saved views {capture} -->\n![View one](media/a.png){capture}\n\nAfter\n'
  const page = detectOutlineObjects(text).blocks.find((b) => b.kind === 'embed')
  assert.ok(page?.embed?.marker, 'the marker is inside the page card')
  assert.equal(page.embed.captures.length, 1)
  assert.ok(page.source.endsWith('{capture}\n'), 'the card ends with its last saved view line; nothing orphaned')
  assert.match(deletionNotice(page), /saved view/)
})

console.log('Lossless rows')
const CHAT = 'user: Hello\n  continued\n\nbot (2s): Hi\nassistant: near miss stays in the turn\n\ntool-call: x'
test('a no-op returns the original body byte for byte (LF and CRLF)', () => {
  for (const body of [CHAT, CHAT.replace(/\n/g, '\r\n')]) {
    const split = splitSegments('turns', body)
    const rows = split.rows.map((row) => ({ ...row, original: row }))
    assert.equal(serialiseSegments('turns', body, split, rows), body)
  }
})
test('one edited row changes only its own lines; CRLF stays CRLF', () => {
  const body = CHAT.replace(/\n/g, '\r\n')
  const split = splitSegments('turns', body)
  const rows = split.rows.map((row, i) => ({ ...row, original: row, ...(i === 1 ? { content: 'Changed' } : {}) }))
  const out = serialiseSegments('turns', body, split, rows)
  const a = body.split('\n')
  const b = out.split('\n')
  assert.deepEqual(b.slice(0, split.rows[0].lines.length), a.slice(0, split.rows[0].lines.length), 'the first row is untouched')
  assert.ok(out.endsWith('tool-call: x'), 'the last row is untouched')
  assert.ok(out.split('\n').slice(0, -1).every((l) => l.endsWith('\r')), 'every written line keeps CRLF')
  assert.ok(out.includes('bot (2s): Changed\r\n'))
})
test('terminal: an escaped prompt line is output, not a new command', () => {
  const split = splitSegments('shell', '~ $ ls\nfile\n\\$ not a prompt\n$ pwd')
  assert.equal(split.rows.length, 2)
  assert.equal(split.rows[0].output, 'file\n\\$ not a prompt')
})

console.log('Commits, Discard and undo')
function fakeView(state) {
  return {
    state,
    dispatched: 0,
    dispatch(spec) { this.dispatched += 1; this.state = this.state.update(spec).state },
    focus() {},
    coordsAtPos: () => ({ left: 0, right: 0, top: 0, bottom: 0 })
  }
}
function openEditor(text, kind) {
  const state = EditorState.create({ doc: text, extensions: [history(), objectBlocksExtension({})] })
  const block = objectBlocksIn(state).find((b) => b.kind === kind)
  assert.ok(block, `a ${kind} card`)
  const view = fakeView(state.update({ effects: setOpenObjectBlock.of({ from: block.from, to: block.to }) }).state)
  let widget = null
  for (const source of view.state.facet(EditorView.decorations)) {
    if (typeof source === 'function') continue
    source.between(0, view.state.doc.length, (_f, _t, value) => { if (value.spec.widget instanceof ObjectEditorWidget) widget = value.spec.widget })
  }
  assert.ok(widget, 'the open editor widget')
  return { view, block, api: widget.editorApi(view) }
}
const TALK = '# T\n\n## Slide\n\nTyped before\n\n```python\nx = 1\n```\n\n:::notes\nKeep **this** <!-- odd --> text\n:::\n'
test('a no-op commit dispatches no document change and adds no undo step', () => {
  const { view, block, api } = openEditor(TALK, 'code')
  const before = view.state.doc.toString()
  assert.equal(api.commit(innerSource(block), 'interactive').ok, true)
  assert.equal(view.state.doc.toString(), before)
  assert.equal(undoDepth(view.state), 0)
})
test('the notes no-op keeps a complex body exactly', () => {
  const { view, block, api } = openEditor(TALK, 'notes')
  assert.equal(api.commit(innerSource(block), 'interactive').ok, true)
  assert.equal(view.state.doc.toString(), TALK)
})
test('Discard dispatches no change', () => {
  const { view, api } = openEditor(TALK, 'code')
  assert.equal(typeof api.discard, 'function')
  api.discard()
  assert.equal(view.state.doc.toString(), TALK)
  assert.equal(undoDepth(view.state), 0)
})
test('a commit is one isolated undo step: typing before it survives its Undo', () => {
  const state0 = EditorState.create({ doc: TALK, extensions: [history(), objectBlocksExtension({})] })
  const at = TALK.indexOf('Typed before') + 'Typed before'.length
  const typed = state0.update({ changes: { from: at, insert: '!' }, userEvent: 'input.type' }).state
  const block = objectBlocksIn(typed).find((b) => b.kind === 'code')
  const view = fakeView(typed.update({ effects: setOpenObjectBlock.of({ from: block.from, to: block.to }) }).state)
  let widget = null
  for (const source of view.state.facet(EditorView.decorations)) {
    if (typeof source === 'function') continue
    source.between(0, view.state.doc.length, (_f, _t, v) => { if (v.spec.widget instanceof ObjectEditorWidget) widget = v.spec.widget })
  }
  assert.equal(widget.editorApi(view).commit('x = 2', 'interactive').ok, true)
  assert.ok(view.state.doc.toString().includes('x = 2'))
  undo({ state: view.state, dispatch: (tr) => { view.state = tr.state } })
  assert.ok(view.state.doc.toString().includes('x = 1'), 'Undo removes the commit')
  assert.ok(view.state.doc.toString().includes('Typed before!'), 'and keeps the typing before it')
})
test('a stale editor refuses to write', () => {
  const block = detectOutlineObjects(TALK).blocks.find((b) => b.kind === 'code')
  const changed = TALK.replace('x = 1', 'x = 9')
  assert.equal(planObjectEditorCommit(block, changed, 'x = 2').ok, false)
})
test('refusals: a fence line that would close the block; notes that would end early or start a slide', () => {
  const code = detectOutlineObjects(TALK).blocks.find((b) => b.kind === 'code')
  assert.equal(planObjectEditorCommit(code, TALK, 'a\n```\nb').ok, false)
  const notes = detectOutlineObjects(TALK).blocks.find((b) => b.kind === 'notes')
  for (const bad of ['a\n:::\nb', '## Heading', '# Title', '```\nopen', 'a <!-- open']) {
    assert.equal(planObjectEditorCommit(notes, TALK, bad).ok, false, bad)
  }
  assert.equal(planObjectEditorCommit(notes, TALK, 'Fine text\n\nwith #hashtag and ::: inline').ok, true)
})

console.log('Notes privacy')
test('the audience compile carries no notes text', () => {
  // Covered by the existing test:notes-never-published; this is the editor-side half: the insert snippet
  // is the grammar's own `:::notes` block, so the compiler drops it like any other notes.
  assert.deepEqual(kindsOf('# T\n\n## S\n\n:::notes\n\n:::\n'), [['notes', null]])
})

console.log('Agent verbs')
const VTALK = '# T\n\n## One\n\nText <!-- inline -->\n\n<!-- alone -->\n\n```chat\nuser: Hi\nbot: Hello\n```\n\n## Two\n\nBody\n'
test('notes.insert, get, replace and remove, with stale-hash refusals', () => {
  const inserted = notesInsert(VTALK, 15, 'Remember')
  assert.equal(inserted.ok, true)
  assert.ok(inserted.text.includes('Body\n\n:::notes\nRemember\n:::'))
  assert.equal(notesInsert(inserted.text, 15).code, 'exists')
  const [block] = notesGet(inserted.text, 15).blocks
  assert.equal(block.body, 'Remember')
  assert.equal(notesReplace(inserted.text, 0, 'deadbeef', 'x').code, 'stale')
  assert.equal(notesReplace(inserted.text, 0, block.hash, '## no').code, 'refused')
  const replaced = notesReplace(inserted.text, 0, block.hash, 'New body')
  assert.ok(replaced.text.includes(':::notes\nNew body\n:::'))
  const removed = notesRemove(replaced.text, 0, notesGet(replaced.text).blocks[0].hash)
  assert.equal(removed.text, `${VTALK}\n`, 'only the block and its line go')
  assert.ok(!removed.text.includes(':::notes'))
})
test('comment.list, remove and replace', () => {
  const { comments } = commentList(VTALK)
  assert.deepEqual(comments.map((c) => c.text), ['<!-- inline -->', '<!-- alone -->'])
  const alone = comments[1]
  assert.equal(commentRemove(VTALK, alone.from, 'bad').code, 'stale')
  const removed = commentRemove(VTALK, alone.from, alone.hash)
  assert.ok(!removed.text.includes('<!-- alone -->') && removed.text.includes('<!-- inline -->'))
  assert.equal(commentReplace(VTALK, alone.from, alone.hash, '<!-- a --> b').code, 'refused')
  assert.ok(commentReplace(VTALK, alone.from, alone.hash, '<!-- new -->').text.includes('<!-- new -->'))
})
test('object.row.list and replace change one row only', () => {
  const line = VTALK.split('\n').indexOf('```chat') + 1
  const listed = rowList(VTALK, line)
  assert.equal(listed.rows.length, 2)
  assert.equal(rowReplace(VTALK, line, 1, 'stale', { content: 'x' }).code, 'stale')
  const out = rowReplace(VTALK, line, 1, listed.rows[1].hash, { content: 'Changed' })
  assert.equal(out.text, VTALK.replace('bot: Hello', 'bot: Changed'))
  assert.equal(rowReplace(VTALK, line, 1, listed.rows[1].hash, { content: 'a\n```' }).code, 'refused')
  assert.equal(segmentHash('a'), segmentHash('a'))
})

console.log(`\ntest-outline-objects: ${passed} passed.`)
