// An object card's header actions (src/shared/objects/card-actions.ts, objectBlocks/cardActions.ts):
// Remove and Replace file are planned against the text as it is now, keep every byte they do not
// change, refuse when the card is no longer where it was read, and write one change that one Undo
// restores; a cancelled picker writes nothing; Open and Reveal use the app's shell channels with the
// path main answered, never a path the card text names. CodeMirror state only; nothing on screen.
import { strict as assert } from 'node:assert'
import { history, undo, undoDepth } from '@codemirror/commands'
import { EditorState } from '@codemirror/state'
import { installTestDom } from './test-dom.mjs'
import { locateCard, planCardFileReplace, planCardRemoval } from '../src/shared/objects/card-actions.ts'

installTestDom()
const { objectBlocksExtension, objectBlocksIn } = await import('../src/renderer/src/extensions/objectBlocks/field.ts')
const { cardActionHost, cardActionsFor, runCardAction } = await import('../src/renderer/src/extensions/objectBlocks/cardActions.ts')
const { setObjectStatuses } = await import('../src/renderer/src/extensions/objectBlocks/status.ts')

let passed = 0
const test = async (name, fn) => { await fn(); passed += 1; console.log(`  ✓ ${name}`) }
const apply = (text, change) => `${text.slice(0, change.from)}${change.insert}${text.slice(change.to)}`
const card = (text, source) => ({ from: text.indexOf(source), to: text.indexOf(source) + source.length, source })

console.log('Planners')
await test('Remove takes the card line and one of the blank lines around it', () => {
  const text = '## S\n\nBefore\n\n[Embed: media/a.html]\n\nAfter\n'
  const plan = planCardRemoval(text, card(text, '[Embed: media/a.html]'))
  assert.equal(apply(text, plan.change), '## S\n\nBefore\n\nAfter\n')
})
await test('Remove at the end of the text leaves no trailing gap; CRLF lines keep their endings', () => {
  const text = '## S\n\nBefore\n\n[Embed: media/a.html]\n'
  assert.equal(apply(text, planCardRemoval(text, card(text, '[Embed: media/a.html]')).change), '## S\n\nBefore\n')
  const crlf = '## S\r\n\r\nBefore\r\n\r\n```python\r\nx\r\n```\r\n\r\nAfter\r\n'
  assert.equal(apply(crlf, planCardRemoval(crlf, card(crlf, '```python\r\nx\r\n```')).change), '## S\r\n\r\nBefore\r\n\r\nAfter\r\n')
})
await test('a page card that runs to its own line ending is removed with its line and one blank line', () => {
  for (const text of ['## S\n\n[Embed: x.html]\nAfter\n', '## S\nBefore\n[Embed: x.html]\n\nAfter\n', '## S\n\n[Embed: x.html]\n\nAfter\n']) {
    const plan = planCardRemoval(text, card(text, '[Embed: x.html]\n'))
    const out = apply(text, plan.change)
    assert.ok(!out.includes('Embed') && !out.includes('\n\n\n'), JSON.stringify(out))
    assert.ok(out.includes('After\n'))
  }
})
await test('a card that moved is found by its only copy; an edited or doubled card is refused', () => {
  const text = 'Typed\n## S\n\n[Embed: media/a.html]\n'
  const old = { from: 4, to: 25, source: '[Embed: media/a.html]' }
  assert.equal(locateCard(text, old).from, text.indexOf('[Embed'))
  assert.equal(planCardRemoval(text.replace('a.html', 'b.html'), old).ok, false)
  assert.equal(planCardRemoval(`${text}\n[Embed: media/a.html]\n`, old).ok, false)
})
await test('Replace file changes only the file name; spacing, the brackets and anything after stay', () => {
  const text = '## S\n\n[Embed:   media/old page.html ]\n'
  const plan = planCardFileReplace(text, card(text, '[Embed:   media/old page.html ]'), 'assets/new.html')
  assert.equal(apply(text, plan.change), '## S\n\n[Embed:   assets/new.html ]\n')
  const sim = '[Simulation: sims/a.html]\n'
  assert.equal(apply(sim, planCardFileReplace(sim, card(sim, '[Simulation: sims/a.html]'), 'sims/b.html').change), '[Simulation: sims/b.html]\n')
  assert.equal(planCardFileReplace(text, card(text, '[Embed:   media/old page.html ]'), 'x]y').ok, false)
})

console.log('Actions in the editor')
function fakeView(doc, host, statuses) {
  let state = EditorState.create({ doc, extensions: [history(), objectBlocksExtension({}), cardActionHost.of(host)] })
  if (statuses) state = state.update({ effects: setObjectStatuses.of(statuses) }).state
  const view = {
    get state() { return state },
    dispatches: 0,
    // The undo command passes a transaction; every other write passes a spec.
    dispatch(spec) { view.dispatches += 1; state = (spec.startState ? spec : state.update(spec)).state },
    focus() {}
  }
  return view
}
const PAGE = '## S\n\nBefore\n\n[Embed: media/a.html]\n\nAfter\n'
const embed = (view) => objectBlocksIn(view.state).find((b) => b.kind === 'embed')

await test('a local page offers Open, Reveal, Copy, Replace and Remove; a web page Open, Copy and Remove', () => {
  const host = { openPath: async () => true, showInFolder: async () => true, openExternal: async () => true, copyText: () => {}, chooseReplacementPage: async () => null }
  assert.deepEqual(cardActionsFor(embed(fakeView(PAGE, host)), host), ['open', 'reveal', 'copy', 'replace', 'remove'])
  const web = fakeView('## S\n\n[Embed: https://example.org/]\n', host)
  assert.deepEqual(cardActionsFor(embed(web), host), ['open', 'copy', 'remove'])
})
await test('Remove is one change and one Undo restores the text exactly', async () => {
  const view = fakeView(PAGE, {})
  await runCardAction(view, embed(view), 'remove')
  assert.equal(view.dispatches, 1)
  assert.equal(view.state.doc.toString(), '## S\n\nBefore\n\nAfter\n')
  assert.equal(undoDepth(view.state), 1)
  undo({ state: view.state, dispatch: (tr) => view.dispatch(tr) })
  assert.equal(view.state.doc.toString(), PAGE)
})
await test('Replace file: a cancelled picker writes nothing; a chosen page is one change and one Undo', async () => {
  let answer = null
  const view = fakeView(PAGE, { chooseReplacementPage: async () => answer })
  await runCardAction(view, embed(view), 'replace')
  assert.equal(view.state.doc.toString(), PAGE)
  assert.equal(undoDepth(view.state), 0)
  answer = { ref: 'assets/b.html', note: '', warn: false }
  await runCardAction(view, embed(view), 'replace')
  assert.equal(view.state.doc.toString(), PAGE.replace('media/a.html', 'assets/b.html'))
  undo({ state: view.state, dispatch: (tr) => view.dispatch(tr) })
  assert.equal(view.state.doc.toString(), PAGE)
})
await test('Replace file: when the card line was edited while the picker was open, nothing is written', async () => {
  let view = null
  view = fakeView(PAGE, {
    chooseReplacementPage: async () => {
      view.dispatch({ changes: { from: PAGE.indexOf('a.html'), insert: 'x' } })
      return { ref: 'assets/b.html', note: '', warn: false }
    }
  })
  const block = embed(view)
  await runCardAction(view, block, 'replace')
  assert.equal(view.state.doc.toString(), PAGE.replace('a.html', 'xa.html'))
})
await test('Open and Reveal use the path main answered, and only for a present file', async () => {
  const opened = []
  const host = { openPath: async (p) => { opened.push(['open', p]); return true }, showInFolder: async (p) => { opened.push(['reveal', p]); return true } }
  const unchecked = fakeView(PAGE, host)
  await runCardAction(unchecked, embed(unchecked), 'open')
  const missing = fakeView(PAGE, host, new Map([['media/a.html', { state: 'missing' }]]))
  await runCardAction(missing, embed(missing), 'open')
  assert.deepEqual(opened, [])
  const present = fakeView(PAGE, host, new Map([['media/a.html', { state: 'present', path: '/vault/t/media/a.html' }]]))
  await runCardAction(present, embed(present), 'open')
  await runCardAction(present, embed(present), 'reveal')
  assert.deepEqual(opened, [['open', '/vault/t/media/a.html'], ['reveal', '/vault/t/media/a.html']])
  assert.equal(present.dispatches, 0, 'Open and Reveal write nothing')
})
await test('Copy markup copies the card as written', async () => {
  let copied = null
  const view = fakeView(PAGE, { copyText: (t) => { copied = t } })
  await runCardAction(view, embed(view), 'copy')
  assert.equal(copied, '[Embed: media/a.html]')
})

console.log('R2 (review of a222975a) — a pending action writes only to the card it was started on')
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
const TWINS = '# T\n\n## A\n\n[Embed: media/page.html]\n\n## B\n\n[Embed: media/page.html]\n'
const embeds = (view) => objectBlocksIn(view.state).filter((b) => b.kind === 'embed')
await test('the reviewer’s case: Replace on A, A removed while the picker is open, B is never written', async () => {
  const picked = deferred()
  const view = fakeView(TWINS, { chooseReplacementPage: () => picked.promise })
  const pending = runCardAction(view, embeds(view)[0], 'replace')
  await runCardAction(view, embeds(view)[0], 'remove')
  const afterRemove = view.state.doc.toString()
  assert.equal(embeds(view).length, 1)
  picked.resolve({ ref: 'assets/new.html', note: '', warn: false })
  await pending
  assert.equal(view.state.doc.toString(), afterRemove, 'the surviving twin keeps its page')
  assert.ok(!afterRemove.includes('assets/new.html'))
  assert.equal(undoDepth(view.state), 1, 'only the removal is in the history')
})
await test('Place earlier views on A, A removed while main reads: the marker never lands under B', async () => {
  const read = deferred()
  const web = '# T\n\n## A\n\n[Embed: https://example.org/]\n\n## B\n\n[Embed: https://example.org/]\n'
  const view = fakeView(web, { earlierViews: () => read.promise })
  const pending = runCardAction(view, embeds(view)[0], 'place-earlier')
  await runCardAction(view, embeds(view)[0], 'remove')
  const afterRemove = view.state.doc.toString()
  read.resolve([{ image: 'assets/live-page-captures/0000000000000001.jpg', capturedAt: '2026-10-27T10:00:00.000Z' }])
  await pending
  assert.equal(view.state.doc.toString(), afterRemove)
  assert.ok(!afterRemove.includes('{capture}'))
})
await test('deleted and retyped with the same bytes while waiting is not the card that was started on', async () => {
  const picked = deferred()
  const view = fakeView(TWINS, { chooseReplacementPage: () => picked.promise })
  const first = embeds(view)[0]
  const pending = runCardAction(view, first, 'replace')
  view.dispatch({ changes: { from: first.from, to: first.from + '[Embed: media/page.html]'.length } })
  view.dispatch({ changes: { from: first.from, insert: '[Embed: media/page.html]' } })
  assert.equal(view.state.doc.toString(), TWINS)
  picked.resolve({ ref: 'assets/new.html', note: '', warn: false })
  await pending
  assert.equal(view.state.doc.toString(), TWINS)
})
await test('an edit elsewhere while waiting: the card is followed to its new place and written there', async () => {
  const picked = deferred()
  const view = fakeView(TWINS, { chooseReplacementPage: () => picked.promise })
  const pending = runCardAction(view, embeds(view)[1], 'replace')
  view.dispatch({ changes: { from: TWINS.indexOf('## A') + 4, insert: ' and more' } })
  view.dispatch({ changes: { from: view.state.doc.length, insert: '\nAfter\n' } })
  picked.resolve({ ref: 'assets/new.html', note: '', warn: false })
  await pending
  const expected = '# T\n\n## A and more\n\n[Embed: media/page.html]\n\n## B\n\n[Embed: assets/new.html]\n\nAfter\n'
  assert.equal(view.state.doc.toString(), expected)
})

console.log(`\n${passed} card action checks passed`)
