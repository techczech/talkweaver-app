// Capture embed and Place earlier views on a web page card (objectBlocks/cardActions.ts, the
// object:earlier-views channel in src/main/object-status.ts, planPlaceEarlierViews). Main reads a page's
// views saved before {capture} lines only for the window's own talk, from inside the talk's folder, within
// the writer's limits, and fails closed rather than answer a partial list. The card says which page and
// which slide: two pages on one slide and one address on two slides are never confused, and placing the
// views is one change that one Undo takes back. Real temp folders; CodeMirror state; nothing on screen.
import { strict as assert } from 'node:assert'
import { mock } from 'node:test'
import fsModule, { chmodSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { history, undo } from '@codemirror/commands'
import { EditorState } from '@codemirror/state'
import { installTestDom } from './test-dom.mjs'
import { gateFsOps, settle } from './fs-op-gate.mjs'
import { answerEarlierViews, STATUS_BUDGET_MS } from '../src/main/object-status.ts'
import { LIVE_PAGE_CAPTURES_DIR, MAX_CAPTURES_TOTAL, captureEntryName, encodeCaptureEntry } from '../compiler/scripts/lib/live-page-captures.mjs'
import { planPlaceEarlierViews } from '../src/shared/objects/card-actions.ts'

installTestDom()
const { objectBlocksExtension, objectBlocksIn } = await import('../src/renderer/src/extensions/objectBlocks/field.ts')
const { cardActionHost, cardActionsFor, runCardAction } = await import('../src/renderer/src/extensions/objectBlocks/cardActions.ts')

const base = realpathSync(mkdtempSync(join(tmpdir(), 'tw-card-capture-')))
process.on('exit', () => rmSync(base, { recursive: true, force: true }))
let passed = 0
const test = async (name, fn) => { await fn(); passed += 1; console.log(`  ✓ ${name}`) }

const PAGE = 'https://example.org/'
let ids = 0
const capture = (over = {}) => ({
  id: `cap-${(++ids).toString(16).padStart(12, '0')}`, capturedAt: `2026-10-2${ids % 9}T10:00:00.000Z`, slideId: 'page',
  image: `assets/live-page-captures/${ids.toString(16).padStart(16, '0')}.jpg`, bytes: 10,
  width: 1280, height: 720, source: 'audience', viewport: { w: 1280, h: 720, zoom: 1 }, scroll: { fx: 0, fy: 0 }, ...over
})
const talkDir = join(base, 'vault', 'talk')
const records = join(talkDir, LIVE_PAGE_CAPTURES_DIR)
mkdirSync(records, { recursive: true })
const record = (c, page = PAGE, dir = records) => writeFileSync(join(dir, captureEntryName(c)), encodeCaptureEntry(page, c))
const legacy = [capture(), capture()]
for (const c of legacy) record(c)
record(capture({ slideMarkup: true }))
record(capture(), 'https://other.example/')
// A record that is a link to a file outside the talk is not read.
const outside = join(base, 'outside')
mkdirSync(outside)
const sneaky = capture()
writeFileSync(join(outside, 'r.json'), encodeCaptureEntry(PAGE, sneaky))
symlinkSync(join(outside, 'r.json'), join(records, captureEntryName(sneaky)))

const outline = join(talkDir, 'talk.md')
const deps = { currentTalkOf: (id) => (id === 7 ? outline : null), contextFor: () => ({ talkDir, roots: [join(base, 'vault')], vaultRoot: join(base, 'vault') }) }

console.log('Main: earlier saved views')
await test('only the page’s views saved before the markup, oldest first, public fields only', async () => {
  const answer = await answerEarlierViews(7, outline, PAGE, deps)
  assert.equal(answer.ok, true)
  assert.deepEqual(answer.views.map((v) => v.image), legacy.map((c) => c.image))
  assert.deepEqual(Object.keys(answer.views[0]).sort(), ['capturedAt', 'image'])
})
await test('another window, another talk or a non-web address is not answered', async () => {
  assert.equal((await answerEarlierViews(8, outline, PAGE, deps)).reason, 'not-current-talk')
  assert.equal((await answerEarlierViews(7, join(base, 'other.md'), PAGE, deps)).reason, 'not-current-talk')
  assert.equal((await answerEarlierViews(7, outline, 'file:///etc/passwd', deps)).reason, 'invalid-input')
})
const names = (n) => Array.from({ length: n }, (_, i) => captureEntryName(capture({ id: `cap-${(1000 + i).toString(16).padStart(12, '0')}` })))
await test('too many records, or a folder not read within the budget, answers unreadable (never a partial list)', async () => {
  const many = { list: async () => names(MAX_CAPTURES_TOTAL * 2 + 1), read: async () => null }
  assert.equal((await answerEarlierViews(7, outline, PAGE, { ...deps, earlierFs: many })).reason, 'unreadable')
  const slowList = { list: () => new Promise((done) => setTimeout(() => done([]), 400)), read: async () => null }
  assert.equal((await answerEarlierViews(7, outline, PAGE, { ...deps, earlierFs: slowList })).reason, 'unreadable')
})
await test('a talk with no saved-view folder has no earlier views', async () => {
  const bare = { ...deps, contextFor: () => ({ talkDir: join(base, 'empty'), roots: [base], vaultRoot: base }) }
  assert.deepEqual(await answerEarlierViews(7, outline, PAGE, bare), { ok: true, views: [] })
})

// Review R3/R4 of a222975a: the list is all or nothing, and the disk is never asked on main's thread.
const realNames = [...legacy.map(captureEntryName)]
const realText = new Map(legacy.map((c) => [captureEntryName(c), encodeCaptureEntry(PAGE, c)]))
const seamOf = (read) => ({ list: async () => realNames, read: async (path, max) => read(path.split('/').pop(), max) })
await test('a record that could not be read (no permission, an I/O error) answers unreadable, not the other views', async () => {
  for (const code of ['EACCES', 'EIO', 'EMFILE']) {
    const failing = seamOf((name) => { if (name === realNames[1]) throw Object.assign(new Error(code), { code }); return realText.get(name) })
    assert.deepEqual(await answerEarlierViews(7, outline, PAGE, { ...deps, earlierFs: failing }), { ok: false, reason: 'unreadable' }, code)
  }
  const listFails = { list: async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) }, read: async () => null }
  assert.deepEqual(await answerEarlierViews(7, outline, PAGE, { ...deps, earlierFs: listFails }), { ok: false, reason: 'unreadable' })
})
await test('records that are not saved views (out of shape, too large, gone) are left out; the rest is the whole list', async () => {
  const shaped = seamOf((name) => (name === realNames[1] ? '{not json' : realText.get(name)))
  const answer = await answerEarlierViews(7, outline, PAGE, { ...deps, earlierFs: shaped })
  assert.deepEqual(answer.views.map((v) => v.image), [legacy[0].image])
  const excluded = seamOf((name) => (name === realNames[1] ? null : realText.get(name)))
  assert.deepEqual((await answerEarlierViews(7, outline, PAGE, { ...deps, earlierFs: excluded })).views.map((v) => v.image), [legacy[0].image])
})
await test('the real reader: an unreadable record file fails the whole list', async () => {
  const locked = join(records, captureEntryName(legacy[1]))
  chmodSync(locked, 0o000)
  try {
    if (process.getuid?.() === 0) return // root reads anything
    assert.deepEqual(await answerEarlierViews(7, outline, PAGE, deps), { ok: false, reason: 'unreadable' })
  } finally { chmodSync(locked, 0o644) }
  assert.equal((await answerEarlierViews(7, outline, PAGE, deps)).views.length, 2)
})
await test('a slow disk: main keeps running, the answer comes at the deadline, and a read finishing after it is not used', async () => {
  let ticks = 0
  const ticker = setInterval(() => { ticks += 1 }, 10)
  // The last read finishes after the 250 ms budget: no success with it.
  const slow = seamOf((name) => new Promise((done) => setTimeout(() => done(realText.get(name)), name === realNames[1] ? 300 : 0)))
  const t0 = performance.now()
  const answer = await answerEarlierViews(7, outline, PAGE, { ...deps, earlierFs: slow })
  const ms = performance.now() - t0
  clearInterval(ticker)
  assert.deepEqual(answer, { ok: false, reason: 'unreadable' })
  assert.ok(ms < 300, `answered at the deadline (${ms} ms)`)
  assert.ok(ticks >= 15, `main kept running (${ticks} ticks)`)
})
await test('a window that changed talk while the records were read is not answered', async () => {
  let talk = outline
  const switching = { ...deps, currentTalkOf: () => talk, earlierFs: seamOf((name) => { talk = 'elsewhere.md'; return realText.get(name) }) }
  assert.deepEqual(await answerEarlierViews(7, outline, PAGE, switching), { ok: false, reason: 'not-current-talk' })
})

// Review of 03756f0f: record bytes come only from an open the kernel binds to the talk's own folders,
// and no disk operation starts after the deadline.
const views = async () => (await answerEarlierViews(7, outline, PAGE, deps))
await test('the reviewer’s race: a parent folder swapped for a link to outside records just before the open reads no outside bytes', async () => {
  const before = await views()
  assert.equal(before.ok, true)
  const elsewhere = join(base, 'elsewhere-records')
  mkdirSync(elsewhere)
  const outsideCap = { ...legacy[0], image: 'assets/live-page-captures/0000000000000099.jpg' }
  for (const c of legacy) writeFileSync(join(elsewhere, captureEntryName(c)), encodeCaptureEntry(PAGE, c.id === legacy[0].id ? outsideCap : c))
  const outsideAssets = join(base, 'elsewhere-assets')
  mkdirSync(join(outsideAssets, LIVE_PAGE_CAPTURES_DIR.split('/').slice(1).join('/')), { recursive: true })
  for (const c of legacy) writeFileSync(join(outsideAssets, LIVE_PAGE_CAPTURES_DIR.split('/').slice(1).join('/'), captureEntryName(c)), encodeCaptureEntry(PAGE, outsideCap))
  const original = fsModule.promises.open
  // Swap the saved-view folder itself, then (second case) the `assets` folder above it.
  for (const [swapped, target] of [[records, elsewhere], [join(talkDir, 'assets'), outsideAssets]]) {
    const outcomes = []
    let done = false
    fsModule.promises.open = async function (path, ...args) {
      if (!done && String(path).startsWith(records)) {
        done = true
        renameSync(swapped, `${swapped}-parked`)
        symlinkSync(target, swapped, 'dir')
      }
      try { const fh = await original.call(this, path, ...args); outcomes.push('opened'); return fh } catch (error) { outcomes.push(error.code); throw error }
    }
    syncBuiltinESMExports()
    try {
      const raced = await views()
      assert.deepEqual(raced, { ok: false, reason: 'unreadable' }, 'nothing placed, and no outside image')
      assert.deepEqual(outcomes, ['ELOOP'], 'the kernel refused the open through the link: no outside byte was read')
    } finally {
      fsModule.promises.open = original
      syncBuiltinESMExports()
      unlinkSync(swapped)
      renameSync(`${swapped}-parked`, swapped)
    }
  }
  assert.deepEqual(await views(), before, 'with the folders back, the same list as before')
})
await test('a saved-view folder that is a link, or a system without the no-link open, places nothing', async () => {
  const linked = join(base, 'linked-talk')
  mkdirSync(join(linked, 'assets'), { recursive: true })
  symlinkSync(records, join(linked, LIVE_PAGE_CAPTURES_DIR), 'dir')
  const viaLink = { ...deps, contextFor: () => ({ talkDir: linked, roots: [base], vaultRoot: base }) }
  assert.deepEqual(await answerEarlierViews(7, outline, PAGE, viaLink), { ok: false, reason: 'unreadable' })
  assert.deepEqual(await answerEarlierViews(7, outline, PAGE, { ...deps, platformSupported: false }), { ok: false, reason: 'unreadable' })
})
await test('every disk operation, held past the deadline: the answer comes at the deadline and NO operation starts after it', async () => {
  const gate = gateFsOps()
  const realTimeout = globalThis.setTimeout
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    gate.holdAt(-1)
    assert.equal((await answerEarlierViews(7, outline, PAGE, deps)).ok, true)
    const sequence = gate.ops.map((op) => op.name)
    assert.ok(sequence.includes('realpath') && sequence.includes('opendir') && sequence.includes('file.read'), sequence.join(','))
    for (let k = 0; k < sequence.length; k += 1) {
      gate.holdAt(k)
      const work = answerEarlierViews(7, outline, PAGE, { ...deps, budgetMs: k === 0 ? undefined : 20 })
      // Freeze only the deadline while real filesystem operations reach the chosen gate.
      // Otherwise a busy disk can use 20 ms before the operation we intend to hold starts.
      const end = Date.now() + 5000
      while (!gate.held && Date.now() < end) await new Promise((resolve) => setImmediate(resolve))
      assert.equal(gate.held?.name, sequence[k], 'the intended operation is held before the deadline fires')
      mock.timers.tick(k === 0 ? STATUS_BUDGET_MS : 20)
      const answer = await work
      const answeredAt = performance.now()
      assert.deepEqual(answer, { ok: false, reason: 'unreadable' }, `held ${sequence[k]}`)
      gate.release()
      await new Promise((resolve) => realTimeout(resolve, 40))
      assert.deepEqual(gate.startedAfter(answeredAt), [], `held ${sequence[k]} (operation ${k}): nothing new after the answer`)
    }
  } finally { gate.release(); gate.restore(); mock.timers.reset() }
})

console.log('Planner and card')
const lines = ['![Saved view, 27 Oct](assets/live-page-captures/0000000000000001.jpg){capture}']
const card = (text, source, nth = 0) => {
  let from = -1
  for (let i = 0; i <= nth; i += 1) from = text.indexOf(source, from + 1)
  return { from, to: from + source.length, source }
}
await test('two pages on one slide: the views go under the card that was read, with its indent and line ending', () => {
  const text = '## S\r\n\r\n  [Embed: https://example.org/]\r\n\r\n[Embed: https://example.org/b]\r\n'
  const plan = planPlaceEarlierViews(text, card(text, '[Embed: https://example.org/b]\r\n'), 'https://example.org/b', lines)
  const out = `${text.slice(0, plan.change.from)}${plan.change.insert}${text.slice(plan.change.to)}`
  assert.equal(out, `## S\r\n\r\n  [Embed: https://example.org/]\r\n\r\n[Embed: https://example.org/b]\r\n<!-- saved views {capture} -->\r\n${lines[0]}\r\n`)
  assert.equal(planPlaceEarlierViews(text, card(text, '[Embed: https://example.org/b]\r\n'), PAGE, lines).ok, false, 'another page')
})
await test('one address on two slides: the card at its own place is the one written; a moved twin is refused', () => {
  const text = '## A\n\n[Embed: https://example.org/]\n\n## B\n\n[Embed: https://example.org/]\n'
  const second = card(text, '[Embed: https://example.org/]\n', 1)
  const plan = planPlaceEarlierViews(text, second, PAGE, lines)
  assert.equal(plan.change.from, second.from + '[Embed: https://example.org/]'.length)
  assert.equal(planPlaceEarlierViews(`x${text}`, second, PAGE, lines).ok, false)
})
await test('a card with the marker or a capture line already is refused; so is anything but saved-view lines', () => {
  const marked = '## A\n\n[Embed: https://example.org/]\n<!-- saved views {capture} -->\n'
  assert.equal(planPlaceEarlierViews(marked, card(marked, '[Embed: https://example.org/]\n<!-- saved views {capture} -->\n'), PAGE, lines).ok, false)
  const plain = '## A\n\n[Embed: https://example.org/]\n'
  assert.equal(planPlaceEarlierViews(plain, card(plain, '[Embed: https://example.org/]\n'), PAGE, ['![x](media/a.png){capture}']).ok, false)
})

function fakeView(doc, host) {
  let state = EditorState.create({ doc, extensions: [history(), objectBlocksExtension({}), cardActionHost.of(host)] })
  const view = {
    get state() { return state },
    dispatches: 0,
    dispatch(spec) { view.dispatches += 1; state = (spec.startState ? spec : state.update(spec)).state },
    focus() {}
  }
  return view
}
const TWO = '# T\n\n## A\n\n[Embed: https://example.org/]\n\n## B\n\nText\n\n[Embed: https://example.org/]\n'
await test('Capture embed opens for the card’s own slide (its heading line) and page', async () => {
  const asked = []
  const view = fakeView(TWO, { captureEmbed: (line, url) => asked.push([line, url]), earlierViews: async () => [] })
  const cards = objectBlocksIn(view.state).filter((b) => b.kind === 'embed')
  assert.deepEqual(cardActionsFor(cards[1], view.state.facet(cardActionHost)).slice(0, 2), ['capture', 'place-earlier'])
  await runCardAction(view, cards[1], 'capture')
  await runCardAction(view, cards[0], 'capture')
  assert.deepEqual(asked, [[7, PAGE], [3, PAGE]])
  assert.equal(view.dispatches, 0)
})
await test('Place earlier views writes one change under that card; one Undo takes it back; none found writes nothing', async () => {
  let views = []
  const view = fakeView(TWO, { earlierViews: async () => views })
  const second = () => objectBlocksIn(view.state).filter((b) => b.kind === 'embed')[1]
  await runCardAction(view, second(), 'place-earlier')
  assert.equal(view.state.doc.toString(), TWO)
  views = legacy.map((c) => ({ image: c.image, capturedAt: c.capturedAt }))
  await runCardAction(view, second(), 'place-earlier')
  const after = view.state.doc.toString()
  assert.equal(after.split('{capture}').length - 1, 3, 'the marker and two lines')
  assert.ok(after.indexOf('saved views') > after.indexOf('## B'), 'under the second card')
  assert.equal(second().embed.captures.length, 2)
  assert.deepEqual(cardActionsFor(second(), view.state.facet(cardActionHost)).includes('place-earlier'), false)
  undo({ state: view.state, dispatch: (tr) => view.dispatch(tr) })
  assert.equal(view.state.doc.toString(), TWO)
})

console.log(`\n${passed} card capture checks passed`)
