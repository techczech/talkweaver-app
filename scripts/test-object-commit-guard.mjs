// The compiler-error check on an object editor's commit (src/shared/objects/compiler-error-check.ts,
// planObjectEditorCommit) and the deck row count on the rows editor (compiledRowCount). A commit that
// ADDS a compiler error occurrence is not written; errors already in the outline never block one; the
// same error code from a new line is new. A rows edit may add and remove rows, but never one the deck
// would split or merge; a difference the body already had is kept. Pure state; nothing on screen.
import { strict as assert } from 'node:assert'
import { installTestDom, TestEvent } from './test-dom.mjs'
import { compilerErrorOccurrences, compilerErrorRefusal, newCompilerErrors } from '../src/shared/objects/compiler-error-check.ts'
import { compiledRowCount } from '../compiler/scripts/lib/simulation-reading.mjs'

installTestDom()
// The shim's elements are not textarea instances; the rows editor only uses the type to auto-size.
globalThis.HTMLTextAreaElement ??= class {}
const { detectOutlineObjects } = await import('../src/renderer/src/extensions/objectBlocks/detect.ts')
const { planObjectEditorCommit, innerSource } = await import('../src/renderer/src/objects/registry.ts')
const { mountRowsEditor } = await import('../src/renderer/src/objects/card-editors.ts')

let passed = 0
const test = (name, fn) => { fn(); passed += 1; console.log(`  ✓ ${name}`) }

console.log('Compiler error occurrences')
const BASE = '# Talk\n\n## One {bogusword}\n\nText\n\n## Two\n\nMore\n'
test('an unknown trigger is an error occurrence; a hint or warning is not counted', () => {
  const found = compilerErrorOccurrences(BASE)
  assert.equal([...found.values()].reduce((n, e) => n + e.count, 0), 1)
  assert.match([...found.values()][0].message, /bogusword/)
})
test('errors already there never block; an unrelated edit passes', () => {
  assert.equal(compilerErrorRefusal(BASE, BASE.replace('More', 'More text')), null)
})
test('the same code with a new occurrence is new: a second heading, then a Trigger line in a body', () => {
  const twice = BASE.replace('## Two', '## Two {bogusword}')
  assert.match(compilerErrorRefusal(BASE, twice) ?? '', /add a slide error.*bogusword/)
  const stray = BASE.replace('More', 'More\n\n{otherbogus}')
  assert.match(compilerErrorRefusal(BASE, stray) ?? '', /otherbogus/)
  const strayMoved = '# Talk\n\n## One\n\n{otherbogus}\n\n## Two\n\nMore\n'
  const strayAgain = '# Talk\n\n## One\n\n{otherbogus}\n\n## Two\n\nMore\n\n{otherbogus}\n'
  assert.match(compilerErrorRefusal(strayMoved, strayAgain) ?? '', /otherbogus/, 'one more of the same line is new')
})
test('removing an error, or fixing one while another stays, passes', () => {
  assert.equal(compilerErrorRefusal(BASE, BASE.replace(' {bogusword}', '')), null)
})
test('a trigger inside a fence, notes or a comment is not read as one (as the compiler reads it)', () => {
  const fenced = BASE.replace('More', 'More\n\n```text\n{otherbogus}\n```')
  assert.equal(compilerErrorRefusal(BASE, fenced), null)
  const noted = BASE.replace('More', 'More\n\n:::notes\n{otherbogus}\n:::')
  assert.equal(compilerErrorRefusal(BASE, noted), null)
  const commented = BASE.replace('More', 'More\n\n<!-- {otherbogus} -->')
  assert.equal(compilerErrorRefusal(BASE, commented), null)
})
test('file facts: a newly named missing or outside file is new; one already missing is kept', () => {
  const missing = [{ ref: 'media/a.html', state: 'missing' }]
  assert.match(compilerErrorRefusal(BASE, BASE, [], missing) ?? '', /media\/a\.html is not found/)
  assert.match(compilerErrorRefusal(BASE, BASE, [], [{ ref: '../x.html', state: 'outside' }]) ?? '', /outside this talk/)
  assert.equal(compilerErrorRefusal(BASE, BASE, missing, missing), null)
  assert.deepEqual(newCompilerErrors(compilerErrorOccurrences(BASE, missing), compilerErrorOccurrences(BASE, [...missing, ...missing])).length, 1)
})

console.log('Commit plans')
const PAGE = '# Talk\n\n## Page\n\n[Embed: media/page.html]\n\nAfter\n'
const embedOf = (text) => detectOutlineObjects(text).blocks.find((b) => b.kind === 'embed')
test('pointing a page card at a file main has answered missing is not written', () => {
  const block = embedOf(PAGE)
  const statuses = new Map([['media/page.html', 'present'], ['media/gone.html', 'missing']])
  const plan = planObjectEditorCommit(block, PAGE, '[Embed: media/gone.html]', undefined, { statusOf: (ref) => statuses.get(ref) })
  assert.equal(plan.ok, false)
  assert.match(plan.reason, /media\/gone\.html is not found/)
})
test('a file not answered yet is written (its card says so as soon as main answers)', () => {
  const block = embedOf(PAGE)
  const plan = planObjectEditorCommit(block, PAGE, '[Embed: media/new.html]', undefined, { statusOf: () => undefined })
  assert.equal(plan.ok, true)
})
test('a page already missing stays editable: rewriting its line with the same file passes', () => {
  const block = embedOf(PAGE)
  const plan = planObjectEditorCommit(block, PAGE, '[Embed:  media/page.html]', undefined, { statusOf: () => 'missing' })
  assert.equal(plan.ok, true)
})
test('a no-op commit is not checked and passes', () => {
  const block = embedOf(PAGE)
  assert.equal(planObjectEditorCommit(block, PAGE, innerSource(block), undefined, { statusOf: () => 'missing' }).ok, true)
})

console.log('Deck row counts')
test('the deck counts a labelled turn per label line, a command per prompt (the closing prompt too), a trace turn per header', () => {
  assert.equal(compiledRowCount('turns', '  user: hi\n  bot: yo\n  more\n'), 2)
  assert.equal(compiledRowCount('turns', 'intro\nuser: hi\nassistant: not a label\n'), 1)
  assert.equal(compiledRowCount('shell', 'before\n~ $ ls\nout\n$\n\n'), 2)
  assert.equal(compiledRowCount('shell', '\\$ escaped\n$ ls\n'), 1)
  assert.equal(compiledRowCount('trace', 'user\nhi\nassistant\nyo'), 2)
})
const body = 'user: one\nbot: two\n'
test('adding and removing turns is allowed: the deck reads what the editor holds', () => {
  const editor = mountRowsEditor('turns', body)
  const add = editor.element.querySelectorAll('button').find((b) => b.textContent === '+ Add turn')
  add.dispatchEvent(new TestEvent('click'))
  const added = editor.serialise()
  assert.equal(compiledRowCount('turns', added), 3)
  assert.equal(editor.refusal(added), null)
  const deleteFirst = () => {
    const menu = editor.element.querySelectorAll('select').find((m) => m.className === 'oe-row-menu')
    menu.value = 'delete'
    menu.dispatchEvent(new TestEvent('change'))
  }
  deleteFirst()
  deleteFirst()
  const removed = editor.serialise()
  assert.equal(compiledRowCount('turns', removed), 1)
  assert.equal(editor.refusal(removed), null)
})
test('a row the deck would split (a lone CR only the deck reads as a break) is refused', () => {
  const editor = mountRowsEditor('turns', body)
  const reason = editor.refusal('user: one\nnote\rbot: sneaky\nbot: two\n')
  assert.match(reason ?? '', /the slide would show 3 turns where the editor has 2/)
})
test('a difference the body already had is kept, not a reason to refuse every edit', () => {
  const odd = 'user: one\nnote\rbot: hidden\nbot: two\n'
  const editor = mountRowsEditor('turns', odd)
  assert.equal(editor.refusal(editor.serialise()), null)
})

console.log(`\n${passed} commit guard checks passed`)
