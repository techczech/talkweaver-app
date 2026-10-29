// Saved views shared across surfaces (owner feedback on 0.42.0-alpha.16): removing one saved view from
// a slide (live-page-capture-markup.mjs removeCaptureLine, the inspector's Remove from slide), the
// slide's saved views as the talk's current text has them (slideSavedViewLines, main's
// live-page-saved-views.ts) and the push that tells every open deck and Capture embed window
// (live-page-host.ts refreshSavedViews). The owner's three cases are run end to end with one talk text
// and real hosts on fake windows: a view saved in the capture window shows in the presenter and the
// audience; one saved in the presenter shows in the capture window and the inspector; one removed
// counts down everywhere. Plain Node, no Electron, no browser.
import assert from 'node:assert/strict'
import {
  CAPTURE_VIEWS_MARKER as MARK, captureMarkupLine, placeCaptureLines, removeCaptureLine, slideHeadingRef, slideSavedViewLines
} from '../compiler/scripts/lib/live-page-capture-markup.mjs'
import { captureAltWhen, slideSavedViews } from '../src/main/live-page-saved-views.ts'
import { SLOT_SCRIPT, createLivePageHost, disposeAllLivePageHosts, pairLivePageHosts } from '../src/main/live-page-host.ts'
import { planSavedViewRemoval, slideLivePages } from '../src/renderer/src/lib/captureEmbed.ts'
import { extractInspectorSlideBlock, headingLineForSlideId } from '../src/renderer/src/components/inspectorModel.ts'
import { replaceDocTransaction } from '../src/renderer/src/lib/replaceDocTransaction.ts'
import { computeSlideLines } from '../src/shared/slide-lines.ts'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildPerSlideProjections } from '../compiler/scripts/lib/10-projections.mjs'
import { EditorState } from '@codemirror/state'
import { history, undo } from '@codemirror/commands'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
fs.mkdirSync(new URL('../research/', import.meta.url), { recursive: true })
const scratch = fs.mkdtempSync(join(fileURLToPath(new URL('..', import.meta.url)), 'research/scratch-live-page-saved-views-'))

let passed = 0
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`) } catch (err) { console.error(`  FAIL ${name}`); throw err }
}
const flush = () => new Promise((r) => setImmediate(r))
const SITE = 'https://elicit.example/review/abc'
const PAGE = SITE
const img = (c) => `assets/live-page-captures/${c.repeat(16)}.jpg`
const A = img('a'); const B = img('b'); const C = img('c'); const D = img('d')
const line = (image, at = '2026-10-27T22:22:00.000Z', mode) => captureMarkupLine(image, at, mode)
const slide = (body) => `# Talk\n\n### Elicit (on the web)\n{id=gl4cs}\n[Embed: ${SITE}]\n${body}\n### Next {id=next}\n- point\n`

console.log('live page saved views')

await test('remove from slide: the one line goes; the marker stays, so the view does not come back', () => {
  const text = slide(`${MARK}\n${line(A)}\n${line(B)}\n`)
  const r = removeCaptureLine(text, 'gl4cs', PAGE, A)
  assert.deepEqual([r.removed, r.reason], [true, undefined])
  assert.equal(r.text, slide(`${MARK}\n${line(B)}\n`))
  const last = removeCaptureLine(r.text, 'gl4cs', PAGE, B)
  assert.equal(last.text, slide(`${MARK}\n`), 'the last one: the marker kept')
  assert.deepEqual(slideSavedViewLines(last.text, 'gl4cs', PAGE), { managed: true, views: [] }, 'none, not the older views')
})

await test('remove from slide: an embed with hand-typed lines and no marker gets the marker in the same edit', () => {
  const text = slide(`  ${line(A)}\n`).replace(`[Embed: ${SITE}]`, `  [Embed: ${SITE}]`)
  const r = removeCaptureLine(text, 'gl4cs', PAGE, A)
  assert.equal(r.removed, true)
  assert.equal(r.text, slide('').replace(`[Embed: ${SITE}]\n`, `  [Embed: ${SITE}]\n  ${MARK}\n`), 'marker under the embed, its indent kept')
  assert.deepEqual(slideSavedViewLines(r.text, 'gl4cs', PAGE), { managed: true, views: [] })
})

await test('remove from slide: refusals leave the text byte for byte (gone already, other slide, ambiguous title, inside a comment); CRLF kept', () => {
  const text = slide(`${MARK}\n${line(A)}\n`)
  const same = (t, r, reason) => assert.deepEqual([r.removed, r.reason, r.text], [false, reason, t], reason)
  same(text, removeCaptureLine(text, 'gl4cs', PAGE, B), 'capture-view-missing')
  same(text, removeCaptureLine(text, 'next', PAGE, A), 'capture-embed-missing')
  same(text, removeCaptureLine(text, 'nope', PAGE, A), 'capture-slide-missing')
  same(text, removeCaptureLine(text, 'gl4cs', PAGE, 'assets/photo.jpg'), 'capture-view-missing')
  const twice = `### P\n[Embed: ${SITE}]\n${MARK}\n${line(A)}\n\n### P\n[Embed: ${SITE}]\n`
  same(twice, removeCaptureLine(twice, { id: 'p', heading: '### P' }, PAGE, A), 'capture-slide-ambiguous')
  const commented = slide(`${MARK}\n<!--\n${line(A)}\n-->\n`)
  same(commented, removeCaptureLine(commented, 'gl4cs', PAGE, A), 'capture-view-missing')
  // Another slide showing the same picture keeps it.
  const two = `${slide(`${MARK}\n${line(A)}\n`)}\n### Again {id=again}\n[Embed: ${SITE}]\n${MARK}\n${line(A)}\n`
  const r = removeCaptureLine(two, 'gl4cs', PAGE, A)
  assert.equal(r.text, `${slide(`${MARK}\n`)}\n### Again {id=again}\n[Embed: ${SITE}]\n${MARK}\n${line(A)}\n`)
  const crlf = text.replace(/\n/g, '\r\n')
  assert.equal(removeCaptureLine(crlf, 'gl4cs', PAGE, A).text, slide(`${MARK}\n`).replace(/\n/g, '\r\n'))
})

await test('the slide\'s saved views from the text: lines in order; an embed on the compatibility listing; not found', async () => {
  const text = slide(`${MARK}\n${line(A)}\n${line(B, '2026-10-27T22:23:00.000Z', 'page')}\n![photo](assets/photo.jpg){capture}\n`)
  assert.deepEqual(slideSavedViewLines(text, 'gl4cs', PAGE).views.map((v) => v.image), [A, B], 'only the capture writer\'s pictures')
  assert.deepEqual(slideSavedViewLines(slide(''), 'gl4cs', PAGE), { managed: false, views: [] })
  assert.equal(slideSavedViewLines(text, 'other', PAGE).reason, 'capture-slide-missing')
  assert.deepEqual(captureAltWhen('Saved view, 27 Oct 2026 22:22'), { capturedAt: '2026-10-27T22:22:00.000Z', mode: 'view' })
  assert.deepEqual(captureAltWhen('Entire page, 3 Jan 2027 09:05'), { capturedAt: '2027-01-03T09:05:00.000Z', mode: 'page' })
  assert.deepEqual(captureAltWhen('my own words'), { capturedAt: '', mode: 'view' })
  const deps = { read: async () => text, compiledSlides: async () => [], pictures: (_p, items) => items.map((v) => ({ image: v.image, alt: v.alt, src: `data:image/jpeg;base64,${Buffer.from(v.image).toString('base64')}` })) }
  const found = await slideSavedViews(deps, '/t/talk.md', 'gl4cs', PAGE)
  assert.deepEqual(found.views().map((v) => [v.mode, v.capturedAt]), [['view', '2026-10-27T22:22:00.000Z'], ['page', '2026-10-27T22:23:00.000Z']])
  assert.equal((await slideSavedViews({ ...deps, read: async () => slide('') }, '/t/talk.md', 'gl4cs', PAGE)).views(), null, 'the compiled deck decides')
  assert.equal(await slideSavedViews(deps, '/t/talk.md', 'gone', PAGE), null, 'not in the text now: windows keep what they show')
  // An id the compiler derives: a compile of the text says which heading.
  const derived = `### Page\n[Embed: ${SITE}]\n${MARK}\n${line(C)}\n`
  const viaCompile = await slideSavedViews({ ...deps, read: async () => derived, compiledSlides: async () => [{ id: 'page', sourceLine: 1 }] }, '/t/talk.md', 'page', PAGE)
  assert.deepEqual(viaCompile.views().map((v) => v.alt), ['Saved view, 27 Oct 2026 22:22'])
})

// --- The owner's three cases: one talk text, every surface told -------------------------------------
function fakeContents(id) {
  const listeners = new Map()
  return { id, url: '', on(event, fn) { listeners.set(event, [...(listeners.get(event) ?? []), fn]); return this }, getURL() { return this.url }, emit(event, ...args) { for (const fn of listeners.get(event) ?? []) fn(...args) } }
}
function fakeTimers() {
  const intervals = new Map(); let n = 0
  return {
    setInterval(fn, ms) { n++; intervals.set(n, { fn, ms }); return n }, clearInterval(h) { intervals.delete(h) },
    setTimeout() { return ++n }, clearTimeout() {},
    async tick(ms) { for (const [, t] of [...intervals]) if (t.ms === ms) t.fn(); for (let i = 0; i < 4; i++) await flush() }
  }
}
function fakeDeck(id) {
  const wc = fakeContents(id)
  const deck = {
    destroyed: false, closedFns: [], report: null, scripts: [],
    isDestroyed() { return this.destroyed },
    getContentBounds() { return { x: 0, y: 0, width: 1440, height: 900 } },
    contentView: { addChildView() {}, removeChildView() {} },
    webContents: Object.assign(wc, {
      isDestroyed: () => deck.destroyed,
      executeJavaScript(code) { if (code === SLOT_SCRIPT) return Promise.resolve(deck.report); deck.scripts.push(code); return Promise.resolve() },
      focus() {}, getZoomFactor: () => 1, removeListener() {}
    }),
    once(event, fn) { if (event === 'closed') this.closedFns.push(fn) }
  }
  return deck
}
/** The views the deck was last told for the slide (the __twLivePageViews argument), or undefined. */
const told = (deck) => {
  const calls = deck.scripts.filter((c) => c.startsWith('window.__twLivePageViews'))
  if (!calls.length) return undefined
  return JSON.parse(JSON.parse(calls.at(-1).match(/__twLivePageViews\((".*")\)$/)[1]))
}
const report = { v: 1, slideId: 'gl4cs', url: PAGE, rect: { x: 0, y: 0, w: 800, h: 450 }, visible: false, interact: false, reloadSeq: 0, layoutWidth: null, captureSeq: 0, gallery: { on: false, index: 0 } }

await test('owner cases: capture window → presenter + audience; presenter → capture window + inspector; remove one → all count down', async () => {
  // The talk as the editor has it: the owner's slide, two views on it.
  let text = slide(`${MARK}\n${line(A)}\n${line(B)}\n`)
  let reads = 0
  const views = (slideId, pageUrl) => slideSavedViews({
    read: async () => { reads++; return text },
    compiledSlides: async () => [],
    pictures: (_p, items) => items.map((v) => ({ image: v.image, alt: v.alt, src: `data:image/jpeg;base64,${Buffer.from(v.image).toString('base64')}` }))
  }, '/talk/talk.md', slideId, pageUrl)
  const timers = fakeTimers()
  const make = (deck, role) => createLivePageHost(deck, role, {
    createView: () => { throw new Error('no view in this test') }, sessionFor: () => ({}),
    allowance: new Set(), devTools: false, userAgent: 'UA', newId: () => 'x', log: () => {}, timers,
    capture: { encode: () => null, save: async () => ({ ok: false, message: 'not here' }), views }
  })
  const pDeck = fakeDeck(1); const aDeck = fakeDeck(2); const cDeck = fakeDeck(3)
  const p = make(pDeck, 'presenter'); const a = make(aDeck, 'audience'); const c = make(cDeck, 'presenter')
  const unpair = pairLivePageHosts(p, a)
  // main after any save of the talk (index.ts refreshLivePageSavedViews): every window of the talk.
  const saved = async (next) => { text = next; await Promise.all([p, a, c].map((h) => h.refreshSavedViews())) }
  const inspector = () => slideLivePages(extractInspectorSlideBlock(text, headingLineForSlideId(text, 'gl4cs')))[0].count
  const counts = () => [told(pDeck)?.views.length, told(aDeck)?.views.length, told(cDeck)?.views.length, inspector()]
  for (const d of [pDeck, aDeck, cDeck]) d.report = report
  await timers.tick(100)
  assert.deepEqual(counts(), [2, 2, 2, 2], 'each window told its slide\'s two views when it came to the slide')
  assert.deepEqual(told(pDeck).views.map((v) => v.alt), ['Saved view, 27 Oct 2026 22:22', 'Saved view, 27 Oct 2026 22:22'])

  // 1. Saved in the capture window and placed (the saver's place: one edit through the talk writer).
  await saved(placeCaptureLines(text, 'gl4cs', PAGE, line(C, '2026-10-27T22:30:00.000Z')).text)
  assert.deepEqual(counts(), [3, 3, 3, 3], 'capture window → presenter and audience (and the inspector)')
  // 2. Saved in the presenter.
  await saved(placeCaptureLines(text, 'gl4cs', PAGE, line(D, '2026-10-27T22:31:00.000Z', 'page')).text)
  assert.deepEqual(counts(), [4, 4, 4, 4], 'presenter → capture window and inspector')
  assert.equal(told(cDeck).views.at(-1).mode, 'page')
  // 3. Removed in the inspector (one edit on the editor's text; autosave → talk:write-outline).
  const removed = removeCaptureLine(text, { id: 'gl4cs' }, PAGE, B)
  assert.equal(removed.removed, true)
  await saved(removed.text)
  assert.deepEqual(counts(), [3, 3, 3, 3], 'every surface counts down')
  assert.equal(told(pDeck).views.some((v) => v.src.includes(Buffer.from(B).toString('base64'))), false)

  // An unrelated save tells nobody again (same list); a slide not in the text now keeps what is shown.
  const before = pDeck.scripts.length
  await saved(text.replace('- point', '- point typed'))
  assert.equal(pDeck.scripts.length, before, 'same list: not sent again')
  await saved(text.replace('{id=gl4cs}', '{id=renamed}'))
  assert.equal(told(pDeck).views.length, 3, 'slide not found now: unchanged')
  // The marker deleted by hand: back to the compiled deck's views (null), as before alpha.16.
  await saved(slide(''))
  assert.equal(told(pDeck).views, null)
  // A deck that reloads is told again on its first report.
  pDeck.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  text = slide(`${MARK}\n${line(A)}\n`)
  const n = reads
  await timers.tick(100)
  assert.ok(reads > n)
  assert.equal(told(pDeck).views.length, 1, 'reloaded deck told the current list')
  unpair()
  disposeAllLivePageHosts()
})

await test('the newest answer wins: a slow read for the slide left behind is dropped', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const text = slide(`${MARK}\n${line(A)}\n`)
  const other = `${text}\n### Other {id=other}\n[Embed: ${SITE}]\n${MARK}\n${line(B)}\n${line(C)}\n`
  const views = async (slideId, pageUrl) => {
    if (slideId === 'gl4cs') await gate
    return slideSavedViews({ read: async () => other, compiledSlides: async () => [], pictures: (_p, items) => items.map((v) => ({ ...v, src: 'data:image/jpeg;base64,AA==' })) }, '/t.md', slideId, pageUrl)
  }
  const timers = fakeTimers()
  const deck = fakeDeck(9)
  const host = createLivePageHost(deck, 'presenter', { createView: () => { throw new Error('no view') }, sessionFor: () => ({}), allowance: new Set(), devTools: false, userAgent: 'UA', newId: () => 'x', log: () => {}, timers, capture: { encode: () => null, save: async () => ({ ok: false, message: '' }), views } })
  deck.report = report
  await timers.tick(100)
  deck.report = { ...report, slideId: 'other' }
  await timers.tick(100)
  release(); await flush(); await flush()
  assert.deepEqual([told(deck).slideId, told(deck).views.length], ['other', 2], 'the left slide\'s late answer never overwrote it')
  host.dispose()
})

// --- Review e3b41fd1: who may remove which line --------------------------------------------------
const compileRows = async (text) => {
  const path = join(scratch, 'outline.md'); fs.writeFileSync(path, text)
  return buildPerSlideProjections(await prepareSource(path, text, null, fs.statSync(path), {}, {}), 'probe')
}
const FM = '---\ntitle: Probe\nauto_title_slide: false\nauto_thanks_slide: false\n---\n\n'
/** What the inspector shows and what its Remove button sends, for compiled row `index` over `text`. */
const shown = (rows, text, index) => {
  const line = computeSlideLines(rows, text)[index]
  const pages = slideLivePages(extractInspectorSlideBlock(text, line))
  return { line, pages, embedOf: (n) => ({ index: pages.slice(0, n).filter((p) => p.pageUrl === pages[n].pageUrl).length, of: pages.filter((p) => p.pageUrl === pages[n].pageUrl).length }) }
}

await test('review P2 stale slide: rows compiled from the old text, a slide inserted above since: refused, text untouched; after the compile catches up, the right slide only', async () => {
  for (const alphaHeading of ['### Alpha', '### Alpha {id=al}']) {
    const original = `${FM}${alphaHeading}\n[Embed: ${PAGE}]\n${MARK}\n${line(A)}\n`
    const rows = await compileRows(original)
    const current = original.replace(alphaHeading, `### Beta\n[Embed: ${PAGE}]\n${MARK}\n${line(B)}\n\n${alphaHeading}`)
    // The inspector still shows compiled row 0 (Alpha) at the old line, which now holds Beta's block.
    const s = shown(rows, current, 0)
    assert.deepEqual(s.pages[0].images, [B], 'the inspector lists Beta\'s view (the lag the review describes)')
    // The review's exact call: the compiled id with the heading read from the new text at the old line.
    if (!alphaHeading.includes('{id=')) {
      const raw = removeCaptureLine(current, { id: rows[0].slide_id, ...slideHeadingRef(current, s.line) }, PAGE, B)
      assert.deepEqual([raw.removed, raw.reason, raw.text], [false, 'capture-slide-moved', current], 'a slide found by heading alone needs the shown line')
    }
    for (const image of [B, A]) {
      const plan = planSavedViewRemoval({ text: current, rows, index: 0, line: s.line, pageUrl: PAGE, image, embed: s.embedOf(0) })
      assert.ok('refused' in plan, `${alphaHeading}: ${image === B ? 'Beta\'s' : 'Alpha\'s'} view not removed on stale authority`)
    }
    // Compiled again: Alpha is found where it is now; Beta keeps its line byte for byte.
    const rows2 = await compileRows(current)
    const alpha = rows2.findIndex((r) => r.source_markdown.startsWith(alphaHeading))
    const s2 = shown(rows2, current, alpha)
    const plan = planSavedViewRemoval({ text: current, rows: rows2, index: alpha, line: s2.line, pageUrl: PAGE, image: A, embed: s2.embedOf(0) })
    assert.equal(plan.text, current.replace(`${MARK}\n${line(A)}\n`, `${MARK}\n`))
    assert.ok(plan.text.includes(`### Beta\n[Embed: ${PAGE}]\n${MARK}\n${line(B)}\n`), 'Beta untouched')
  }
  // A heading two compiled slides share, no id: no identity, refused (never the first of them).
  const twice = `${FM}### P\n[Embed: ${PAGE}]\n${MARK}\n${line(A)}\n\n### P\n[Embed: ${PAGE}]\n${MARK}\n${line(A)}\n`
  const rows = await compileRows(twice)
  const s = shown(rows, twice, 1)
  assert.ok('refused' in planSavedViewRemoval({ text: twice, rows, index: 1, line: s.line, pageUrl: PAGE, image: A, embed: s.embedOf(0) }))
})

await test('review P2 Undo: Remove from slide is its own undo step in real CodeMirror history; typing just before and just after survives one Undo', () => {
  const doc = slide(`${MARK}\n${line(A)}\n${line(B)}\ntail\n`)
  const type = (state, at, text) => state.update({ changes: { from: at, insert: text }, selection: { anchor: at + text.length }, userEvent: 'input.type' }).state
  const undoOnce = (state) => { let out = state; assert.equal(undo({ state, dispatch: (tr) => { out = tr.state } }), true); return out }
  for (const isolated of [true, false]) {
    let state = EditorState.create({ doc, extensions: [history()] })
    state = type(state, doc.indexOf('tail'), 'X')
    const typed = state.doc.toString()
    // B's line is the one just above the typing: CodeMirror joins adjacent changes made close together.
    const removed = removeCaptureLine(typed, 'gl4cs', PAGE, B)
    state = state.update(replaceDocTransaction(typed, removed.text, { ownUndoStep: isolated })).state
    assert.equal(state.doc.toString(), removed.text)
    // The review's case: typing just before, then Remove, then one Undo.
    const justRemoved = state
    const back = undoOnce(justRemoved)
    if (!isolated) { assert.equal(back.doc.toString(), doc, 'without its own step one Undo also takes X (the review\'s defect)'); continue }
    assert.equal(back.doc.toString(), typed, 'one Undo: the saved view back, X kept')
    assert.equal(undoOnce(back).doc.toString(), doc, 'the next Undo: the X')
    // Typing just after Remove: one Undo takes only that typing, the next only the Remove.
    const end = removed.text.indexOf('Xtail') + 'Xtail'.length
    state = type(justRemoved, end, 'Y')
    state = undoOnce(state)
    assert.equal(state.doc.toString(), removed.text, 'one Undo: only the Y')
    state = undoOnce(state)
    assert.equal(state.doc.toString(), typed, 'the next Undo: the saved view back, X still there')
  }
})

await test('review P2 repeated address: the second embed\'s Remove changes only the second embed; the first stays byte for byte', async () => {
  const two = (a, b) => `${FM}### Slide {id=s}\n[Embed: ${PAGE}]\n${MARK}\n${line(a)}\n\n[Embed: ${PAGE}]\n${MARK}\n${line(b)}\n`
  for (const [first, second] of [[A, A], [A, B]]) {
    const text = two(first, second)
    const rows = await compileRows(text)
    const s = shown(rows, text, 0)
    assert.equal(s.pages.length, 2)
    const plan = planSavedViewRemoval({ text, rows, index: 0, line: s.line, pageUrl: PAGE, image: s.pages[1].images[0], embed: s.embedOf(1) })
    const cut = text.lastIndexOf(`${line(second)}\n`)
    assert.equal(plan.text, text.slice(0, cut) + text.slice(cut + `${line(second)}\n`.length), `${first === second ? 'same' : 'different'} pictures: only the second embed's line`)
    assert.ok(plan.text.startsWith(`${FM}### Slide {id=s}\n[Embed: ${PAGE}]\n${MARK}\n${line(first)}\n`), 'the first embed byte for byte')
    assert.deepEqual(slideLivePages(extractInspectorSlideBlock(plan.text, s.line)).map((p) => p.count), [1, 0])
    // A third embed of the address added since the inspector listed two: refused.
    const three = text + `\n[Embed: ${PAGE}]\n`
    assert.ok('refused' in planSavedViewRemoval({ text: three, rows, index: 0, line: s.line, pageUrl: PAGE, image: second, embed: s.embedOf(1) }))
  }
  // Without saying which embed, a repeated address is refused, never the first match.
  assert.equal(removeCaptureLine(two(A, A), 's', PAGE, A).reason, 'capture-embed-ambiguous')
  // The same address on another slide keeps its line.
  const other = `${FM}### One {id=one}\n[Embed: ${PAGE}]\n${MARK}\n${line(A)}\n\n### Two {id=two}\n[Embed: ${PAGE}]\n${MARK}\n${line(A)}\n`
  // Two slides with saved-view lines compile (slides are read concurrently; the records are read once
  // for all of them): both slides' pictures are looked up, neither is skipped or crashes the compile.
  const otherPath = join(scratch, 'two-slides.md'); fs.writeFileSync(otherPath, other)
  const model = await prepareSource(otherPath, other, null, fs.statSync(otherPath), {}, {})
  assert.deepEqual(model.warnings.filter((w) => w.startsWith('missing-asset:')).map((w) => w.split(':')[1]).sort(), ['one', 'two'])
  const rows = await compileRows(other)
  const s = shown(rows, other, 1)
  const plan = planSavedViewRemoval({ text: other, rows, index: 1, line: s.line, pageUrl: PAGE, image: A, embed: s.embedOf(0) })
  const cutTwo = other.lastIndexOf(`${line(A)}\n`)
  assert.equal(plan.text, other.slice(0, cutTwo) + other.slice(cutTwo + `${line(A)}\n`.length))
  assert.ok(plan.text.startsWith(`${FM}### One {id=one}\n[Embed: ${PAGE}]\n${MARK}\n${line(A)}\n`))
  // The windows' list for a repeated address: every embed's views, each picture once (as the deck merges).
  assert.deepEqual(slideSavedViewLines(two(A, B), 's', PAGE).views.map((v) => v.image), [A, B])
  assert.deepEqual(slideSavedViewLines(two(A, A), 's', PAGE).views.map((v) => v.image), [A])
})

fs.rmSync(scratch, { recursive: true, force: true })
console.log(`live page saved views: ${passed} passed`)
