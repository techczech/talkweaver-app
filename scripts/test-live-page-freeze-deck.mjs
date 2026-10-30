// Freeze and mark, the compiled deck's own handlers (presenter-popup-single-html.html), run in jsdom:
// Pointer and Pen keys on a live page slide ask main for a freeze, the tool turns on only when main says
// every window shows the picture, switching tools reuses it, Esc keeps it, Return Live (a rebindable
// palette command with no default key) ends it, failures leave the tool off, and nothing of the frozen
// picture reaches the venue channel. The audience deck shows and drops main's picture. Plain Node with
// jsdom (no browser, no Electron); main's side is scripts/test-live-page-freeze.mjs.
import assert from 'node:assert/strict'
import { JSDOM, VirtualConsole } from 'jsdom'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

let passed = 0
const test = async (name, fn) => {
  // TW_FREEZE_RED=1 lists every failing case instead of stopping at the first (a red run against old code).
  try { await fn(); passed++; console.log(`  ok  ${name}`) } catch (err) { console.error(`  FAIL ${name}: ${String(err?.message ?? err).split('\n')[0]}`); if (!process.env.TW_FREEZE_RED) throw err }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const URL_A = 'https://example.org'
const outline = `---\ntitle: Freeze\nauto_title_slide: false\nauto_thanks_slide: false\n---\n\n### Before {id=before}\n\n- a\n\n### Radio Times {id=page}\n\n[Embed: ${URL_A}]\n`
const model = await prepareSource('/nonexistent/freeze-outline.md', outline, null, { mtimeMs: 0, size: 1, isDirectory: () => false, isFile: () => true }, {}, {})

/** One deck window as main opens it (file:, livepage=1). Storage is memory (jsdom's file: origin has none). */
async function open(query, shortcuts, html = model.fullHtml) {
  const errors = []
  const vc = new VirtualConsole()
  vc.on('jsdomError', (e) => errors.push(String(e?.message || e).slice(0, 200)))
  const dom = new JSDOM(html, {
    url: `file:///deck/freeze.html?${query}&livepage=1#page`, runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} }
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {} })
      w.document.elementFromPoint = () => null
      // A decoded picture (jsdom loads no images): its natural size.
      w.HTMLImageElement.prototype.decode = function () {
        Object.defineProperty(this, 'naturalWidth', { value: 1280, configurable: true })
        Object.defineProperty(this, 'naturalHeight', { value: 720, configurable: true })
        return Promise.resolve()
      }
      w.scrollTo = () => {}
      w.HTMLElement.prototype.scrollIntoView = () => {}
      const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size } } }
      for (const name of ['localStorage', 'sessionStorage']) Object.defineProperty(w, name, { value: mem(), configurable: true })
      if (shortcuts) w.localStorage.setItem('talkweaver:presenter:shortcuts', JSON.stringify(shortcuts))
    }
  })
  await wait(1200)
  const w = dom.window
  const doc = w.document
  return {
    w, doc, errors, close: () => dom.window.close(),
    key: async (k) => { doc.body.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); await wait(30) },
    report: () => JSON.parse(JSON.stringify(w.__twLivePageSlot())), // into this realm (deepEqual compares prototypes)
    pressed: (id) => doc.getElementById(id)?.getAttribute('aria-pressed'),
    note: () => doc.querySelector('.live-page-capture-note')?.textContent ?? '',
    frozenImg: () => doc.querySelector('.live-page-slot > .live-page-frozen > img'),
    send: (m) => w.__twLivePageFrozen(JSON.stringify(m))
  }
}
const ID = 'ab12cd34ef567890'
const show = (seq, over = {}) => ({ v: 1, op: 'show', seq, slideId: 'page', url: `${URL_A}/`, id: ID, src: 'data:image/jpeg;base64,AAAA', width: 1280, height: 720, source: 'audience', ...over })

console.log('live page freeze (deck)')
const p = await open('presenter=1', { 'palette.return-live': { chord: 'Y', entryId: 'return-live' } })

await test('the presenter deck boots with the freeze contract: report field, window call, Return Live hidden', () => {
  assert.deepEqual(p.errors, [])
  assert.equal(typeof p.w.__twLivePageFrozen, 'function')
  assert.deepEqual(p.report().freeze, { seq: 0, want: null })
  assert.equal(p.doc.getElementById('livePageReturnLive')?.hidden, true)
})

await test('Pointer (I) on a live page asks for a freeze; the tool stays off until main says every window shows the picture; Pen while waiting swaps without a new press', async () => {
  p.w.__twLivePageState(JSON.stringify({ v: 1, state: 'live' }))
  await p.key('i')
  assert.deepEqual(p.report().freeze, { seq: 1, want: 'pointer' })
  assert.equal(p.pressed('presenterPointer'), 'false', 'no Pointer before the picture shows')
  assert.equal(p.note(), 'Freezing the audience view…')
  await p.key('d')
  assert.deepEqual(p.report().freeze, { seq: 1, want: 'pen' })
  assert.equal(p.pressed('presenterPen'), 'false')
})

await test('main\'s picture: another press is refused; this one shown and answered with its id; on turns the Pen on and offers Return Live', async () => {
  assert.equal(await p.send(show(9)), false)
  assert.equal(await p.send(show(1, { slideId: 'before' })), false, 'another slide')
  assert.equal(p.frozenImg(), null)
  assert.equal(await p.send(show(1)), ID)
  assert.equal(p.frozenImg()?.getAttribute('src'), 'data:image/jpeg;base64,AAAA')
  assert.equal(p.pressed('presenterPen'), 'false', 'shown is not yet on')
  assert.equal(p.send({ v: 1, op: 'on', seq: 1, slideId: 'page', url: `${URL_A}/`, id: '0000000000000000' }), false, 'on for another picture')
  assert.equal(p.send({ v: 1, op: 'on', seq: 1, slideId: 'page', url: `${URL_A}/`, id: ID }), true)
  assert.equal(p.pressed('presenterPen'), 'true')
  assert.equal(p.doc.getElementById('livePageReturnLive').hidden, false)
  assert.equal(p.note(), 'Frozen view: the room sees this picture')
  assert.equal(p.report().interact, false)
})

await test('switching to Pointer reuses the picture (same press); Esc turns Pointer off and the picture stays; nothing frozen on the venue channel', async () => {
  await p.key('i')
  assert.deepEqual(p.report().freeze, { seq: 1, want: 'pointer' })
  assert.equal(p.pressed('presenterPointer'), 'true'); assert.equal(p.pressed('presenterPen'), 'false')
  await p.key('Escape')
  assert.equal(p.pressed('presenterPointer'), 'false')
  assert.ok(p.frozenImg(), 'still frozen')
  assert.equal(p.doc.getElementById('livePageReturnLive').hidden, false)
  const ink = p.doc.documentElement.dataset.twLiveInk
  assert.ok(!ink || !ink.includes('still'), `venue ink: ${ink}`)
  assert.ok(!String(p.doc.documentElement.dataset.twLivePointer || '').includes('still'))
})

await test('Return Live (a rebound key on the palette command; no default key) ends the freeze and asks main for the live page', async () => {
  await p.key('y')
  assert.deepEqual(p.report().freeze, { seq: 2, want: null })
  assert.equal(p.frozenImg(), null)
  assert.equal(p.doc.getElementById('livePageReturnLive').hidden, true)
})

await test('Esc while freezing cancels; a failure from main leaves the tool off and says why; a page not showing is refused', async () => {
  await p.key('i'); await p.key('Escape')
  assert.deepEqual(p.report().freeze, { seq: 4, want: null })
  assert.equal(p.pressed('presenterPointer'), 'false')
  await p.key('d')
  assert.equal(p.send({ v: 1, op: 'clear', seq: 5, slideId: 'page', url: `${URL_A}/`, message: "Couldn't freeze the page." }), true)
  assert.deepEqual(p.report().freeze, { seq: 5, want: null })
  assert.equal(p.pressed('presenterPen'), 'false')
  assert.equal(p.note(), "Couldn't freeze the page.")
  p.w.__twLivePageState(JSON.stringify({ v: 1, state: 'loading' }))
  await p.key('i')
  assert.deepEqual(p.report().freeze, { seq: 5, want: null }, 'no request while loading')
  assert.match(p.note(), /not showing yet/)
  assert.deepEqual(p.errors, [])
})

await test('malformed or hostile messages are dropped without effect', async () => {
  for (const bad of ['{', JSON.stringify({ v: 1, op: 'show', seq: 5, slideId: 'page', url: URL_A, id: ID, src: 'javascript:alert(1)', width: 1, height: 1 }), JSON.stringify({ v: 1, op: 'eval' })]) {
    assert.equal(p.w.__twLivePageFrozen(bad), false)
  }
  assert.equal(p.frozenImg(), null)
})
p.close()

const a = await open('audience=1')
await test('audience deck: shows main\'s picture over its slot and answers its id; drops it on clear', async () => {
  assert.deepEqual(a.errors, [])
  assert.deepEqual(a.report().freeze, { seq: 0, want: null }, 'the audience never asks')
  assert.equal(await a.send(show(3)), ID)
  assert.ok(a.frozenImg())
  assert.equal(a.send({ v: 1, op: 'on', seq: 3, slideId: 'page', url: `${URL_A}/`, id: ID }), false, 'no tool in the audience window')
  assert.equal(a.send({ v: 1, op: 'clear', seq: 3, slideId: 'page', url: `${URL_A}/` }), true)
  assert.equal(a.frozenImg(), null)
  assert.equal(await a.send(show(4, { slideId: 'before' })), false, 'a picture for another slide is not shown')
})
a.close()

// --- review 61cf3de9 P2 1: a saved view replaced (or the tool changed) mid-stroke -------------------------
// A test-only window hook in the in-memory deck (never in a built deck) reads the pen's layer and view.
const hooked = model.fullHtml.replace('  function livePageStillSurface() {',
  '  window.__testFreeze = { penLayer: () => penLayer(), penView: () => penView(), writeInk: () => writeLiveInk(), phase: () => livePageFreezePhase(), returnLive: () => livePageReturnLive() };\n  function livePageStillSurface() {')
assert.notEqual(hooked, model.fullHtml)
const src1 = 'data:image/jpeg;base64,QUJD', src2 = 'data:image/jpeg;base64,REVG'
/** Every value the venue slots and the freeze mark take, in order. */
function watchSlots(t) {
  const seen = []
  const take = (records) => { for (const r of records) seen.push({ name: r.attributeName, value: t.doc.documentElement.getAttribute(r.attributeName) }) }
  const obs = new t.w.MutationObserver(take)
  obs.observe(t.doc.documentElement, { attributes: true, attributeFilter: ['data-tw-live-ink', 'data-tw-live-pointer', 'data-tw-live-freeze'] })
  return { seen, flush: () => take(obs.takeRecords()) }
}
async function savedDeck() {
  const t = await open('presenter=1', null, hooked)
  const box = { left: 0, top: 0, width: 640, height: 360, right: 640, bottom: 360, x: 0, y: 0, toJSON() { return this } }
  t.w.HTMLElement.prototype.getBoundingClientRect = function () { return box }
  t.setViews = (src) => t.w.__twLivePageViews(JSON.stringify({ v: 1, slideId: 'page', url: URL_A, views: [{ src, mode: 'view', capturedAt: '2026-10-28T00:00:00Z' }] }))
  t.ready = () => { const img = t.doc.querySelector('.live-page-saved > img'); Object.defineProperty(img, 'naturalWidth', { value: 1280, configurable: true }); Object.defineProperty(img, 'naturalHeight', { value: 720, configurable: true }) }
  t.pointer = (type, x, y) => { const e = new t.w.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }); Object.defineProperty(e, 'pointerId', { value: 2 }); t.doc.querySelector('.tw-live-overlay').dispatchEvent(e) }
  t.setViews(src1); t.w.__twLivePageState(JSON.stringify({ v: 1, state: 'failed' })); t.ready()
  await t.key('d')
  assert.equal(t.pressed('presenterPen'), 'true'); assert.equal(t.w.__testFreeze.penLayer().space, 'still')
  return t
}
const noVenueDraft = (slots) => {
  for (const s of slots.seen.filter((x) => x.name === 'data-tw-live-ink' && x.value)) {
    const ink = JSON.parse(s.value)
    assert.ok(ink.space !== 'still', 'still ink never in the venue slot')
    assert.equal(ink.draft ?? null, null, `no draft ever in the venue slot: ${s.value}`)
  }
}

await test('a saved view replaced mid-stroke: marking ends, the stroke is dropped, nothing reaches the venue slot as slide ink', async () => {
  const t = await savedDeck()
  const slots = watchSlots(t)
  t.pointer('pointerdown', 100, 100); t.pointer('pointermove', 200, 150)
  assert.ok(t.w.__testFreeze.penView().draft, 'drawing')
  t.setViews(src2); t.ready()
  assert.equal(t.w.__testFreeze.phase(), 'off', 'the marked picture is gone, so marking ends')
  assert.equal(t.pressed('presenterPen'), 'false')
  assert.equal(t.note(), 'The saved view changed, so Pointer and Pen are off.')
  t.pointer('pointermove', 260, 200); t.pointer('pointerup', 260, 200)
  t.w.__testFreeze.writeInk(); await wait(120); slots.flush()
  const view = t.w.__testFreeze.penView()
  assert.equal(view.draft, null); assert.equal(view.strokes.length, 0, 'the stroke was not kept on the slide')
  noVenueDraft(slots)
  assert.equal(t.doc.documentElement.hasAttribute('data-tw-live-freeze'), false)
  const order = slots.seen.map((x) => x.name)
  assert.ok(order.indexOf('data-tw-live-freeze') > order.indexOf('data-tw-live-ink'), 'the mark comes off only after the slot is rewritten from the slide')
  assert.deepEqual(t.errors, [])
  t.close()
})

await test('a saved view marked: Esc mid-stroke drops it; the Pen toggled off mid-stroke drops it; the picture stays marked; no venue ink', async () => {
  const t = await savedDeck()
  const slots = watchSlots(t)
  t.pointer('pointerdown', 100, 100); t.pointer('pointermove', 200, 150)
  await t.key('Escape')
  assert.equal(t.w.__testFreeze.penView().draft, null)
  t.pointer('pointerup', 200, 150)
  assert.equal(t.w.__testFreeze.penView().strokes.length, 0, 'a cancelled stroke is not kept')
  t.pointer('pointerdown', 100, 100); t.pointer('pointermove', 220, 160)
  await t.key('d')
  assert.equal(t.pressed('presenterPen'), 'false'); assert.equal(t.w.__testFreeze.phase(), 'frozen', 'the picture stays marked')
  t.pointer('pointermove', 260, 200); t.pointer('pointerup', 260, 200)
  assert.equal(t.w.__testFreeze.penView().draft, null); assert.equal(t.w.__testFreeze.penView().strokes.length, 0)
  t.w.__testFreeze.writeInk(); await wait(120); slots.flush()
  noVenueDraft(slots)
  assert.equal(slots.seen.some((x) => x.name === 'data-tw-live-ink'), false, 'nothing written to the venue slot while marked')
  t.close()
})

await test('a whole stroke on the marked saved view is kept on the picture only; the venue pointer is gone throughout', async () => {
  const t = await savedDeck()
  const slots = watchSlots(t)
  t.pointer('pointerdown', 100, 100); t.pointer('pointermove', 200, 150); t.pointer('pointerup', 200, 150)
  const view = t.w.__testFreeze.penView()
  assert.equal(view.space, 'still'); assert.equal(view.strokes.length, 1)
  assert.equal(t.doc.documentElement.hasAttribute('data-tw-live-freeze'), true, 'marked while a saved view is marked')
  t.w.__testFreeze.writeInk(); await wait(120); slots.flush()
  noVenueDraft(slots)
  for (const s of slots.seen.filter((x) => x.name === 'data-tw-live-pointer')) assert.equal(s.value, '"gone"')
  t.close()
})

await test('a live page freeze: marked from the press until Return Live; meanwhile the pointer slot says gone and no ink is written', async () => {
  const t = await open('presenter=1', null, hooked)
  const slots = watchSlots(t)
  t.w.__twLivePageState(JSON.stringify({ v: 1, state: 'live' }))
  await t.key('i')
  assert.equal(t.doc.documentElement.hasAttribute('data-tw-live-freeze'), true, 'marked while freezing')
  assert.equal(t.w.__testFreeze.penLayer(), null, 'no layer while the picture is missing')
  assert.equal(await t.send(show(1)), ID)
  assert.equal(t.send({ v: 1, op: 'on', seq: 1, slideId: 'page', url: `${URL_A}/`, id: ID }), true)
  assert.equal(t.pressed('presenterPointer'), 'true')
  t.w.__testFreeze.writeInk(); await wait(120)
  assert.equal(t.doc.documentElement.hasAttribute('data-tw-live-freeze'), true)
  await t.key('Escape')
  t.w.__testFreeze.returnLive()
  slots.flush()
  assert.equal(t.doc.documentElement.hasAttribute('data-tw-live-freeze'), false, 'unmarked after Return Live')
  const on = slots.seen.findIndex((x) => x.name === 'data-tw-live-freeze' && x.value === '')
  const off = slots.seen.findLastIndex((x) => x.name === 'data-tw-live-freeze' && x.value === null)
  assert.ok(on >= 0 && off > on)
  for (const s of slots.seen.slice(on, off)) {
    if (s.name === 'data-tw-live-pointer') assert.equal(s.value, '"gone"')
    if (s.name === 'data-tw-live-ink') assert.notEqual(s.value, null)
  }
  assert.deepEqual(t.errors, [])
  t.close()
})

console.log(`live page freeze (deck): ${passed} passed`)
process.exit(0)
