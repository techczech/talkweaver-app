// The five findings of the independent object-card review at 7cbf6a179 (research/embed-objects-and-
// pointing-2026-10-28/review-talkweaver-object-source-7cbf6a179-sol.md), each on the reviewer's own input:
//   F1 notes inserted after an unfinished fence reached the audience HTML (P1)
//   F2 a card commit rewrote untouched mixed line endings
//   F3 the row verb changed the untouched CRLF before the closing fence
//   F4 the editor chose a chat session where the compiler draws a media slide; a comment on the info string
//   F5 "Add closing :::" wrote a closer inside an unfinished fence and left the notes open
// and R1 of the follow-up review at a02a05f2 (review-talkweaver-object-fixes-a02a05f2-independent-sol.md): an
// untouched line between two edits in a code card lost its own line ending.
// Privacy is checked on the real audience build (prepareSource → buildShareHtml, includeNotes false).
// CodeMirror state and the repository's DOM shim only; nothing on screen.
import { strict as assert } from 'node:assert'
import { history, undo, undoDepth } from '@codemirror/commands'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { detectOutlineObjects } from '../src/renderer/src/extensions/objectBlocks/detect.ts'
import { planObjectEditorCommit, innerSource, restoreLineEndings } from '../src/renderer/src/objects/registry.ts'
import { matchLines } from '../src/shared/objects/line-endings.ts'
import { splitSegments, serialiseSegments } from '../compiler/scripts/lib/simulation-segments.mjs'
import { notesInsert, rowList, rowReplace } from '../src/shared/objects/object-verbs.ts'
import { planNotesClose, planNotesInsert, compilerNotesLines } from '../src/shared/objects/notes-planner.ts'
import { readOutlineObjectRegions } from '../src/shared/objects/outline-object-regions.ts'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { extractSlides, extractStyles } from '../compiler/scripts/lib/04-html-extraction.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'
import { lexMarkdownBlocks } from '../compiler/scripts/lib/03-markdown-lexer.mjs'
import { inferSlideLayout } from '../compiler/scripts/lib/authored-layout.mjs'
import { blankHtmlComments } from '../compiler/scripts/lib/html-comments.mjs'
import { installTestDom, TestEvent } from './test-dom.mjs'
import { AddNotesCloseWidget } from '../src/renderer/src/extensions/objectBlocks/cardWidgets.ts'
import { insertSpeakerNotes } from '../src/renderer/src/extensions/objectBlocks/commands.ts'
import {
  ObjectEditorWidget, objectBlocksExtension, objectBlocksIn, setOpenObjectBlock
} from '../src/renderer/src/extensions/objectBlocks/field.ts'

installTestDom()
let passed = 0
async function test(name, fn) {
  await fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

const SENTINEL = 'PRIVATE-REVIEW-SENTINEL'
async function audienceHtml(text) {
  const model = await prepareSource('/tmp/object-review-fix.md', text, 'review', { mtimeMs: 0, size: text.length, isDirectory: () => false })
  const share = buildShareHtml({ title: model.title, slides: extractSlides(model.fullHtml), styles: extractStyles(model.fullHtml), includeNotes: false, slug: 'review' })
  return { model, share }
}

function editorWith(doc) {
  let state = EditorState.create({ doc, extensions: [history(), objectBlocksExtension({})] })
  const view = {
    get state() { return state },
    dispatch(spec) { state = (spec?.startState ? spec : state.update(spec)).state },
    focus() {},
    coordsAtPos: () => ({ left: 0, right: 0, top: 0, bottom: 0 })
  }
  return view
}
function openWidget(view, block) {
  view.dispatch({ effects: setOpenObjectBlock.of({ from: block.from, to: block.to }) })
  let widget = null
  for (const source of view.state.facet(EditorView.decorations)) {
    if (typeof source === 'function') continue
    source.between(0, view.state.doc.length, (_f, _t, v) => { if (v.spec.widget instanceof ObjectEditorWidget) widget = v.spec.widget })
  }
  assert.ok(widget, 'the open editor widget')
  return widget.editorApi(view)
}

console.log('F1 — notes never land in an unfinished fence')
const F1_INPUT = '---\ntitle: T\n---\n# T\n\n## Section\n\n### S\n\n```python\nprint(1)\n'
await test('the reviewer’s input: the verb refuses and the planner names the open code block', () => {
  const write = notesInsert(F1_INPUT, 8, SENTINEL)
  assert.equal(write.ok, false)
  assert.equal(write.code, 'refused')
  assert.match(write.message, /code block that is not closed/)
  assert.equal(planNotesInsert(F1_INPUT, 7).ok, false)
})
await test('the editor command writes nothing on the same text', () => {
  const view = editorWith(F1_INPUT)
  view.dispatch({ selection: { anchor: F1_INPUT.indexOf('print') } })
  insertSpeakerNotes(view)
  assert.equal(view.state.doc.toString(), F1_INPUT)
})
await test('with the fence closed, the inserted notes are private in the real audience build', async () => {
  const closedFence = F1_INPUT + '```\n'
  const write = notesInsert(closedFence, 8, SENTINEL)
  assert.equal(write.ok, true)
  const { model, share } = await audienceHtml(write.text)
  assert.equal(model.adapter, 'markdown-outline-v2')
  assert.ok(!share.includes(SENTINEL), 'the sentinel is not in the audience HTML')
  assert.ok(model.slides.some((s) => JSON.stringify(s.notes ?? "").includes(SENTINEL)), 'it is in the presenter notes')
})
await test('CRLF and a following slide: the block is private and nothing else moves out of notes', async () => {
  const text = '---\r\ntitle: T\r\n---\r\n# T\r\n\r\n## A\r\n\r\nText\r\n## B\r\n\r\nMore\r\n'
  const write = notesInsert(text, 6, SENTINEL)
  assert.equal(write.ok, true)
  assert.ok(write.text.includes(`Text\r\n\r\n:::notes\r\n${SENTINEL}\r\n:::\r\n## B`))
  const { share } = await audienceHtml(write.text)
  assert.ok(!share.includes(SENTINEL))
})

console.log('F2 — card commits keep untouched line endings')
const MIXED = '# T\n\n## S\n\n```chat\nuser: untouched LF\nbot: edit me\r\ntool-call: untouched CRLF\r\ntool-results: end\n```\n'
await test('the reviewer’s input: one row edit changes that row only', () => {
  const b = detectOutlineObjects(MIXED).blocks[0]
  const body = innerSource(b)
  const split = splitSegments('turns', body)
  const rows = split.rows.map((r, i) => ({ ...r, original: r, ...(i === 1 ? { content: 'edited' } : {}) }))
  const p = planObjectEditorCommit(b, MIXED, serialiseSegments('turns', body, split, rows))
  assert.equal(p.ok, true)
  assert.equal(MIXED.slice(0, p.change.from) + p.change.insert + MIXED.slice(p.change.to), MIXED.replace('bot: edit me', 'bot: edited'))
})
await test('a text-field edit (LF only) restores every untouched line’s own ending', () => {
  const original = 'a LF\nb CRLF\r\nc edit\r\nd CRLF\r\ne last'
  assert.equal(restoreLineEndings(original, 'a LF\nb CRLF\nc changed\nd CRLF\ne last'), 'a LF\nb CRLF\r\nc changed\r\nd CRLF\r\ne last')
  assert.equal(restoreLineEndings(original, 'a LF\nb CRLF\nnew\nc edit\nd CRLF\ne last'), 'a LF\nb CRLF\r\nnew\r\nc edit\r\nd CRLF\r\ne last')
  assert.equal(restoreLineEndings('x\ny', 'x\nz'), 'x\nz')
})
// CodeMirror keeps lines without their CR (it splits on any line break), so inside the editor the text is
// LF from load; byte-exact mixed endings are held on the planner path above. Here: real field and history.
await test('through the real field and history: only the edited row changes, one Undo restores the text', () => {
  const view = editorWith(MIXED)
  const before = view.state.doc.toString()
  const block = objectBlocksIn(view.state).find((b) => b.kind === 'chat')
  const api = openWidget(view, block)
  const body = innerSource(block)
  const split = splitSegments('turns', body)
  const rows = split.rows.map((r, i) => ({ ...r, original: r, ...(i === 1 ? { content: 'edited' } : {}) }))
  assert.equal(api.commit(serialiseSegments('turns', body, split, rows), 'interactive').ok, true)
  assert.equal(view.state.doc.toString(), before.replace('bot: edit me', 'bot: edited'))
  assert.equal(undoDepth(view.state), 1)
  undo({ state: view.state, dispatch: (tr) => view.dispatch(tr) })
  assert.equal(view.state.doc.toString(), before)
})

console.log('R1 (review of a02a05f2) — untouched lines between edits keep their endings')
function commitCode(source, edited) {
  const b = detectOutlineObjects(source).blocks.find((x) => x.kind === 'code')
  const p = planObjectEditorCommit(b, source, edited)
  assert.equal(p.ok, true, p.reason)
  return source.slice(0, p.change.from) + p.change.insert + source.slice(p.change.to)
}
await test('the reviewer’s fixture: two edits around an untouched LF line keep it LF', () => {
  const source = '# T\n\n### S\n\n```python\nfirst = 1\r\nuntouched = 2\nlast = 3\r\n```\n'
  assert.equal(commitCode(source, 'first = 10\nuntouched = 2\nlast = 30'), '# T\n\n### S\n\n```python\nfirst = 10\r\nuntouched = 2\nlast = 30\r\n```\n')
})
await test('two separated changed lines around several untouched mixed lines', () => {
  const source = '# T\n\n### S\n\n```python\na = 1\r\nb\nc\r\nd\ne = 5\r\n```\n'
  assert.equal(commitCode(source, 'a = 10\nb\nc\nd\ne = 50'), '# T\n\n### S\n\n```python\na = 10\r\nb\nc\r\nd\ne = 50\r\n```\n')
})
await test('duplicate lines: each unchanged copy keeps its own ending; an inserted copy takes the body ending', () => {
  const original = 'x\r\nsame\nmid\r\nsame\r\nend'
  assert.equal(restoreLineEndings(original, 'X\nsame\nmid\nsame\nend'), 'X\r\nsame\nmid\r\nsame\r\nend')
  assert.equal(restoreLineEndings(original, 'x\nsame\nmid\nsame\nsame\nend'), 'x\r\nsame\nmid\r\nsame\r\nsame\r\nend')
  assert.equal(restoreLineEndings(original, 'x\nmid\nsame\nend'), 'x\r\nmid\r\nsame\r\nend')
})
await test('a deleted line and a moved block keep the others’ endings; LF-only bodies stay LF', () => {
  assert.equal(restoreLineEndings('a\nb\r\nc\nd\r\ne', 'a\nc\nd\ne'), 'a\nc\nd\r\ne')
  assert.equal(restoreLineEndings('a\nb\nc', 'c\na\nb'), 'c\na\nb')
})
await test('bounded: a large changed region stays fast and never rewrites a matched line', () => {
  const n = 3000
  const original = Array.from({ length: n }, (_, i) => `line ${i}${i % 2 ? '\r' : ''}`).join('\n')
  const edited = Array.from({ length: n }, (_, i) => (i % 500 === 0 ? `changed ${i}` : `line ${i}`)).join('\n')
  const t0 = performance.now()
  const out = restoreLineEndings(original, edited)
  const ms = performance.now() - t0
  assert.ok(ms < 500, `took ${ms} ms`)
  const lines = out.split('\n')
  for (let i = 0; i < n - 1; i += 1) if (i % 500 !== 0) assert.equal(lines[i].endsWith('\r'), i % 2 === 1, `line ${i}`)
  assert.deepEqual(matchLines(['a', 'b'], ['b', 'a']).filter((j) => j >= 0).length, 1)
})

console.log('R1 (review of a222975a) — long runs of identical lines keep their endings, or nothing is written')
const apply = (text, change) => `${text.slice(0, change.from)}${change.insert}${text.slice(change.to)}`
const repeated = (n, ending) => Array.from({ length: n }, (_, i) => `same${ending(i)}`).join('')
const codeCard = (body) => `# T\n\n## S\n\n\`\`\`python\nfirst\r\n${body}last\r\n\`\`\`\n`
const planCode = (source, edited) => planObjectEditorCommit(detectOutlineObjects(source).blocks.find((b) => b.kind === 'code'), source, edited)
await test('the reviewer’s input: 1,100 identical lines alternating LF and CRLF, first and last edited, every one keeps its ending', () => {
  const middle = repeated(1100, (i) => (i % 2 ? '\r\n' : '\n'))
  const source = codeCard(middle)
  const plan = planCode(source, `FIRST\n${middle.replace(/\r\n/g, '\n')}LAST`)
  assert.equal(plan.ok, true, plan.reason)
  assert.equal(apply(source, plan.change), source.replace('first', 'FIRST').replace('last', 'LAST'))
})
await test('large N, LF-heavy and CRLF-heavy runs, with a line added and one removed in the middle', () => {
  for (const ending of [(i) => (i % 7 === 3 ? '\r\n' : '\n'), (i) => (i % 5 === 1 ? '\n' : '\r\n')]) {
    const lines = Array.from({ length: 4000 }, (_, i) => `same${ending(i)}`)
    const source = codeCard(lines.join(''))
    const edited = [...lines.slice(0, 1500), 'inserted\n', ...lines.slice(1500, 2600), ...lines.slice(2601)]
    const plan = planCode(source, `first\n${edited.join('').replace(/\r\n/g, '\n')}last`)
    assert.equal(plan.ok, true, plan.reason)
    const out = apply(source, plan.change)
    const body = out.slice(out.indexOf('first\r\n') + 7, out.indexOf('last\r\n')).split(/(?<=\n)/)
    assert.equal(body[1500], 'inserted\r\n', 'the added line takes the body ending')
    // Which of several identical lines was removed cannot be told from the text; what must hold is that
    // every other line is kept byte for byte, in order: the result is the original less exactly one line.
    const kept = [...body.slice(0, 1500), ...body.slice(1501)]
    assert.equal(kept.length, lines.length - 1)
    let p = 0
    while (p < kept.length && kept[p] === lines[p]) p += 1
    assert.deepEqual(kept.slice(p), lines.slice(p + 1))
  }
})
await test('past the bounds in a mixed body nothing is written; a body with one ending is never refused', () => {
  const mixed = Array.from({ length: 3000 }, (_, i) => `line ${i}${i % 2 ? '\r\n' : '\n'}`).join('')
  const rewritten = Array.from({ length: 3000 }, (_, i) => `other ${i}\n`).join('')
  const refused = planCode(codeCard(mixed), `first\n${rewritten}last`)
  assert.equal(refused.ok, false)
  assert.match(refused.reason, /nothing was written/)
  assert.equal(restoreLineEndings(`first\r\n${mixed}last`, `first\n${rewritten}last`), null)
  const uniform = Array.from({ length: 3000 }, (_, i) => `line ${i}\r\n`).join('')
  const plan = planCode(codeCard(uniform), `first\n${rewritten}last`)
  assert.equal(plan.ok, true, plan.reason)
  assert.ok(!apply(codeCard(uniform), plan.change).includes('other 1\n'), 'every line CRLF, as the body was')
})

console.log('F3 — the row verb keeps the CRLF before the closing fence')
const CRLF = '# T\r\n\r\n## S\r\n\r\n```chat\r\nuser: Hi\r\nbot: Hello\r\n```\r\n'
await test('the reviewer’s input: only the edited row changes', () => {
  const listed = rowList(CRLF, 5)
  const replaced = rowReplace(CRLF, 5, 0, listed.rows[0].hash, { content: 'Changed' })
  assert.equal(replaced.ok, true)
  assert.equal(replaced.text, CRLF.replace('user: Hi', 'user: Changed'))
})
await test('editing the last row keeps CRLF; a mixed body keeps its LF rows', () => {
  const listed = rowList(CRLF, 5)
  assert.equal(rowReplace(CRLF, 5, 1, listed.rows[1].hash, { content: 'Bye' }).text, CRLF.replace('bot: Hello', 'bot: Bye'))
  const mixed = '# T\n\n## S\n\n```chat\nuser: LF\nbot: CRLF\r\n```\n'
  const rows = rowList(mixed, 5).rows
  assert.equal(rowReplace(mixed, 5, 0, rows[0].hash, { content: 'X' }).text, mixed.replace('user: LF', 'user: X'))
})

console.log('F4 — the editor follows the compiler’s layout reading')
await test('a chat fence beside a picture: the compiler draws media, the card is code', () => {
  const body = '![x](a.png)\n\n```chat\nuser: a\nbot: b\n```'
  assert.equal(inferSlideLayout({ lines: body.split('\n'), cards: [], attrs: {}, authoredAttrKeys: [] }, lexMarkdownBlocks), 'media')
  const card = detectOutlineObjects('# T\n\n### S\n\n' + body).blocks[0]
  assert.equal(card.kind, 'code')
  assert.equal(card.design, undefined)
})
await test('without the picture it is a chat session; an authored layout and a second fence follow the compiler', () => {
  assert.deepEqual(detectOutlineObjects('# T\n\n### S\n\n```chat\nuser: a\n```').blocks.map((b) => [b.kind, b.design]), [['chat', 'chat']])
  const authored = detectOutlineObjects('# T\n\n### S {chat-lanes}\n\n![x](a.png)\n\n```chat\nuser: a\n```').blocks.map((b) => [b.kind, b.design])
  assert.deepEqual(authored, [['chat', 'chat-lanes']])
  const two = detectOutlineObjects('# T\n\n### S\n\n```chat\nuser: a\n```\n\n```chat\nuser: b\n```').blocks.map((b) => [b.kind, b.simNote ?? null])
  assert.deepEqual(two, [['chat', null], ['code', 'ignored']])
})
await test('a comment on the info string is blanked as the compiler blanks it', () => {
  const info = '```svg <!-- internal -->\n<svg/>\n```'
  const compiler = lexMarkdownBlocks(blankHtmlComments(info).split('\n')).map((b) => [b.type, b.lang])
  assert.deepEqual(compiler, [['code', 'svg']])
  assert.deepEqual(detectOutlineObjects('# T\n\n### S\n\n' + info).blocks.map((b) => b.kind), ['svg'])
})

console.log('F5 — Add closing ::: closes notes or writes nothing')
function clickClose(doc) {
  let state = EditorState.create({ doc })
  const warning = detectOutlineObjects(doc).warnings.find((w) => w.kind === 'unclosed-notes')
  const view = { get state() { return state }, dispatch(spec) { state = state.update(spec).state }, focus() {} }
  const dom = new AddNotesCloseWidget(warning.from, warning.closeAt).toDOM(view)
  dom.querySelector('button').dispatchEvent(new TestEvent('mousedown'))
  return state.doc.toString()
}
await test('the reviewer’s input (an unfinished fence inside the notes): nothing is written', () => {
  const doc = '# T\n\n## S\n:::notes\n```python\nprivate\n'
  assert.equal(clickClose(doc), doc)
  assert.equal(planNotesClose(doc, 3).ok, false)
})
await test('ordinary unclosed notes close, stay private in the real build, and the next slide stays content', async () => {
  const doc = `---\ntitle: T\n---\n# T\n\n## S\n\nText\n\n:::notes\n${SENTINEL}\n\n## Next\n\nVisible\n`
  const after = clickClose(doc)
  assert.equal(after, doc.replace('\n## Next', '\n:::\n## Next'))
  const regions = readOutlineObjectRegions(after)
  assert.ok(regions.notes.every((n) => n.closed))
  const { share, model } = await audienceHtml(after)
  assert.ok(!share.includes(SENTINEL))
  assert.ok(share.includes('Visible'))
  assert.ok(model.slides.some((s) => JSON.stringify(s.notes ?? "").includes(SENTINEL)))
})
await test('notes at the end of the text close on the last line; a second click finds nothing to close', () => {
  const doc = '# T\n\n## S\n:::notes\nprivate\n'
  const after = clickClose(doc)
  assert.equal(after, '# T\n\n## S\n:::notes\nprivate\n:::')
  assert.ok(compilerNotesLines(after).has(5))
  assert.equal(detectOutlineObjects(after).warnings.length, 0)
})

console.log(`\ntest-object-source-review-fixes: ${passed} passed.`)
