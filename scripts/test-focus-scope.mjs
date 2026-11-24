// Tests for the focus-scope range-guard predicate (src/renderer/src/extensions/focusScope.ts).
// Imports the REAL exported function — Node ≥23.6 strips erasable TypeScript natively — so this
// cannot drift from the shipped code. changesTouchOutside is a PURE function over plain {fromA,toA}
// spans + a {from,to} range: no DOM, no CodeMirror state needed to run it (the import resolves
// @codemirror/view headlessly, but the function itself touches none of it).
import { readFileSync } from 'node:fs'
import { strict as assert } from 'node:assert'
import { history, undo, undoDepth } from '@codemirror/commands'
import { renderInline } from '../compiler/scripts/lib/00-inline-render.mjs'
import { lexMarkdownBlocks } from '../compiler/scripts/lib/03-markdown-lexer.mjs'
import { focusRangeForSlideLine } from '../src/renderer/src/components/slideFocusModel.ts'
import { EditorState } from '@codemirror/state'
import { exactTextWrite } from '../src/renderer/src/extensions/objectBlocks/effects.ts'
import {
  changesTouchOutside,
  currentFocusRange,
  focusScopeExtension,
  slideTextInput,
  setFocusRangeEffect
} from '../src/renderer/src/extensions/focusScope.ts'

let fail = 0
const ck = (c, m) => { if (!c) { console.error('FAIL:', m); fail++ } }

const R = { from: 100, to: 200 } // the focused block [100, 200)

// ── edits fully INSIDE the band pass (touchOutside === false) ────────────────
ck(changesTouchOutside([{ fromA: 150, toA: 150 }], R) === false, 'insertion inside passes')
ck(changesTouchOutside([{ fromA: 120, toA: 180 }], R) === false, 'deletion fully inside passes')
ck(changesTouchOutside([{ fromA: 150, toA: 160 }], R) === false, 'replacement fully inside passes')
ck(changesTouchOutside([{ fromA: 100, toA: 100 }], R) === false, 'insertion AT from passes')
ck(changesTouchOutside([{ fromA: 100, toA: 200 }], R) === false, 'deletion of the exact block passes')
ck(changesTouchOutside([{ fromA: 150, toA: 200 }], R) === false, 'deletion up to `to` passes')

// ── insert exactly at `to` grows the block and passes ────────────────────────
ck(changesTouchOutside([{ fromA: 200, toA: 200 }], R) === false, 'insert exactly at `to` passes (grows the range)')

// ── straddling / crossing a boundary rejects (touchOutside === true) ─────────
ck(changesTouchOutside([{ fromA: 95, toA: 110 }], R) === true, 'deletion straddling `from` rejects')
ck(changesTouchOutside([{ fromA: 190, toA: 210 }], R) === true, 'deletion straddling `to` rejects')
ck(changesTouchOutside([{ fromA: 98, toA: 103 }], R) === true, 'delete crossing `from` rejects')
ck(changesTouchOutside([{ fromA: 150, toA: 201 }], R) === true, 'deletion running one past `to` rejects')
ck(changesTouchOutside([{ fromA: 99, toA: 99 }], R) === true, 'insertion just before `from` rejects')
ck(changesTouchOutside([{ fromA: 201, toA: 201 }], R) === true, 'insertion just after `to` rejects')

// ── multiple spans: any one outside rejects; all inside passes ───────────────
ck(changesTouchOutside([{ fromA: 120, toA: 130 }, { fromA: 190, toA: 210 }], R) === true, 'multi-span with one outside rejects')
ck(changesTouchOutside([{ fromA: 110, toA: 110 }, { fromA: 150, toA: 160 }], R) === false, 'multi-span all inside passes')
ck(changesTouchOutside([], R) === false, 'no spans (no doc change) passes')

// ── empty-range edge: only an exact-point insertion at that offset passes ─────
const E = { from: 100, to: 100 }
ck(changesTouchOutside([{ fromA: 100, toA: 100 }], E) === false, 'empty range: insertion at the point passes')
ck(changesTouchOutside([{ fromA: 100, toA: 101 }], E) === true, 'empty range: any deletion rejects')
ck(changesTouchOutside([{ fromA: 99, toA: 99 }], E) === true, 'empty range: insertion before the point rejects')
ck(changesTouchOutside([{ fromA: 101, toA: 101 }], E) === true, 'empty range: insertion after the point rejects')

// ── the live StateField range is readable by composing extensions ───────────
let state = EditorState.create({
  doc: 'alpha\nbeta',
  extensions: [focusScopeExtension(() => ({ from: 0, to: 5 }))]
})
ck(
  JSON.stringify(currentFocusRange(state)) === JSON.stringify({ from: 0, to: 5 }),
  'currentFocusRange reads the seeded live range'
)
state = state.update({ effects: setFocusRangeEffect.of({ from: 6, to: 10 }) }).state
ck(
  JSON.stringify(currentFocusRange(state)) === JSON.stringify({ from: 6, to: 10 }),
  'currentFocusRange reads an effect-updated range'
)
state = state.update({ changes: { from: 10, insert: '!' } }).state
ck(
  JSON.stringify(currentFocusRange(state)) === JSON.stringify({ from: 6, to: 11 }),
  'currentFocusRange reads the range after edge-associated edit mapping'
)


// Scope boundaries use the same reading as the compiler and retain every original byte.
const source = [
  '### A statement', '{layout=statement}{id=sample}', '', 'A claim.',
  '', '<!--', '# Private comment', '-->', '', '~~~sh', '# Shell comment', '~~~',
  '', 'A final paragraph.', '', '### A neighbouring slide', 'Keep this unchanged.', ''
].join('\n')
const scope = focusRangeForSlideLine(source, 1)
const firstSlide = source.slice(0, source.indexOf('\n\n### A neighbouring slide'))
assert.deepEqual(scope, { from: 0, to: firstSlide.length })
assert.equal(source.slice(scope.from, scope.to), firstSlide)

const extensions = [history(), focusScopeExtension(() => scope)]
const makeState = (scoped = true, doc = source) => EditorState.create({
  doc, extensions: scoped ? [...extensions, slideTextInput.of(true)] : extensions
})
for (const userEvent of ['input.type', 'input.paste']) {
  for (const marker of ['#', '##', '###', '####', '#####', '######']) {
    let scoped = makeState()
    const text = '\n' + marker + ' Foo'
    const tr = scoped.update({
      changes: { from: firstSlide.length, insert: text },
      selection: { anchor: firstSlide.length + text.length }, userEvent
    })
    assert.equal(tr.newDoc.toString(), firstSlide + '\n\\' + marker + ' Foo' + source.slice(firstSlide.length))
    assert.equal(tr.newSelection.main.head, firstSlide.length + text.length + 1)
    scoped = tr.state
    assert.ok(undo({ state: scoped, dispatch: undone => { scoped = undone.state } }))
    assert.equal(scoped.doc.toString(), source, userEvent + ' Undo restores all source bytes')
  }
}

const first = makeState()
assert.equal(first.update({ changes: { from: firstSlide.length, insert: '\n#' }, userEvent: 'input.type' })
  .newDoc.toString(), firstSlide + '\n\\#' + source.slice(firstSlide.length), 'the first hash is escaped before space is typed')

const typedHash = first.update({ changes: { from: firstSlide.length, insert: '\n# Foo' }, userEvent: 'input.type' }).state
const hiddenEscape = firstSlide.length + 1
const afterBackspace = typedHash.update({
  changes: { from: hiddenEscape, to: hiddenEscape + 1 },
  selection: { anchor: hiddenEscape },
  userEvent: 'delete.backward'
}).state
assert.equal(afterBackspace.doc.toString(), typedHash.doc.toString())
assert.equal(undoDepth(afterBackspace), 1, 'Backspace over the hidden escape adds no Undo step')
assert.ok(undo({ state: afterBackspace, dispatch: tr => assert.equal(tr.newDoc.toString(), source) }))

const withFinalObject = '### One\n{id=one}\n\n![](picture.png)\n\n### Next\n{id=next}\n'
const objectRange = focusRangeForSlideLine(withFinalObject, 1)
const objectState = EditorState.create({ doc: withFinalObject, extensions: [
  focusScopeExtension(() => objectRange), slideTextInput.of(true)
] })
const objectStart = withFinalObject.indexOf('![]')
const nextHeading = withFinalObject.indexOf('### Next')
const deleteObject = to => objectState.update({
  changes: { from: objectStart, to }, userEvent: 'delete.object', annotations: exactTextWrite.of(true)
})
assert.equal(deleteObject(nextHeading).newDoc.toString(), '### One\n{id=one}\n\n### Next\n{id=next}\n')
assert.equal(deleteObject(nextHeading + 1).newDoc.toString(), withFinalObject, 'object deletion cannot cross into a heading')

const nonBreakingHeading = '\n###\u00a0Copied heading'
assert.equal(first.update({ changes: { from: firstSlide.length, insert: nonBreakingHeading }, userEvent: 'input.paste' })
  .newDoc.toString(), firstSlide + '\n\\' + nonBreakingHeading.slice(1) + source.slice(firstSlide.length))

const fenceHash = source.indexOf('# Shell comment') + '# Shell comment'.length
assert.match(first.update({ changes: { from: fenceHash, insert: '\n# Another code line' }, userEvent: 'input.paste' })
  .newDoc.toString(), /# Shell comment\n# Another code line\n~~~/, 'hashes already literal in fenced code are kept as typed')

const blankBody = '\n### Structural outside Slide view'
assert.equal(makeState(false).update({ changes: { from: firstSlide.length, insert: blankBody }, userEvent: 'input.paste' })
  .newDoc.toString(), firstSlide + blankBody + source.slice(firstSlide.length))

const paragraph = lexMarkdownBlocks(['A point.', '\\# Foo', '\\## Bar'])[0]
assert.equal(renderInline(paragraph.text), 'A point. # Foo ## Bar', 'the compiled paragraph renders literal hashes on subsequent lines')

const focusScopeSource = readFileSync(
  new URL('../src/renderer/src/extensions/focusScope.ts', import.meta.url),
  'utf8'
)
ck(
  focusScopeSource.includes(
    'function makeField(getRange?: () => FocusRange | null): StateField<ScopeState>'
  ),
  'the focus field factory remains parameterised by its initial range accessor'
)
ck(
  !focusScopeSource.includes('const focusScopeField = makeField()'),
  'the read accessor does not turn the focus field into a module singleton'
)

if (fail) { console.error(`\n${fail} check(s) failed`); process.exit(1) }
console.log('test-focus-scope: all checks passed')
