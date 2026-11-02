// Freeze and mark on a live web page (design-live-page-pointing-and-annotation-options-2026-10-28.md):
// main's lifecycle against fake windows and views (src/main/live-page-host.ts, live-page-freeze.ts), the
// deck's state machine, message check and picture list (compiler/assets/runtime/live-page-freeze.js), the
// Pointer/Pen 'still' space checks, the online worker refusing it, and the compiled deck carrying it.
// Plain Node: no Electron, no browser. Proves no file is written and nothing goes on the network.
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SLOT_SCRIPT, createLivePageHost, disposeAllLivePageHosts, pairLivePageHosts } from '../src/main/live-page-host.ts'
import { LIVE_PAGE_FREEZE_MAX_JPEG, LIVE_PAGE_FREEZE_MS, frozenAck, stillIdOf, validateFreezeRequest, withDeadline } from '../src/main/live-page-freeze.ts'
import { validateSlotReport } from '../src/main/live-page-policy.ts'
import {
  LIVE_FREEZE_LIMITS, createLiveFreeze, createLiveStillLedger, liveFreezeRuntimeSource, liveFrozenMessage, liveSamePage, liveStillKey
} from '../compiler/assets/runtime/live-page-freeze.js'
import { validPointer, pointerPoint } from '../compiler/assets/runtime/pointer-overlay.js'
import { penInkView, penLayerKey, createPenStore } from '../compiler/assets/runtime/pen-ink.js'
import { parseInkMessage, parsePointerMessage } from '../worker/protocol.ts'

const repo = fileURLToPath(new URL('..', import.meta.url))
let passed = 0
const test = async (name, fn) => {
  // TW_FREEZE_RED=1 lists every failing case instead of stopping at the first (a red run against old code).
  try { await fn(); passed++; console.log(`  ok  ${name}`) } catch (err) { console.error(`  FAIL ${name}: ${String(err?.message ?? err).split('\n')[0]}`); if (!process.env.TW_FREEZE_RED) throw err }
}
const flush = () => new Promise((r) => setImmediate(r))
const settle = async () => { for (let i = 0; i < 6; i++) await flush() }

// --- No file and no network for the whole run: every write call and fetch is counted ------------
const writes = []
for (const name of ['writeFileSync', 'writeFile', 'appendFileSync', 'appendFile', 'mkdirSync', 'mkdir', 'renameSync', 'rename', 'copyFileSync', 'createWriteStream', 'openSync', 'symlinkSync', 'rmSync', 'unlinkSync']) {
  const real = fs[name]
  if (typeof real !== 'function') continue
  try { fs[name] = (...args) => { writes.push(name); return real.apply(fs, args) } } catch { /* read-only binding */ }
}
for (const name of ['writeFile', 'appendFile', 'mkdir', 'rename', 'copyFile', 'open', 'rm', 'unlink']) {
  const real = fs.promises[name]
  fs.promises[name] = (...args) => { writes.push(`promises.${name}`); return real.apply(fs.promises, args) }
}
const network = []
globalThis.fetch = async (...args) => { network.push(String(args[0])); throw new Error('no network in this test') }

console.log('live page freeze')

// --- fakes (the shape of scripts/test-live-page.mjs) ------------------------------------------------
function fakeTimers() {
  const intervals = new Map(); const timeouts = new Map(); let n = 0
  return {
    intervals, timeouts,
    setInterval(fn, ms) { n++; intervals.set(n, { fn, ms }); return n },
    clearInterval(h) { intervals.delete(h) },
    setTimeout(fn, ms) { n++; timeouts.set(n, { fn, ms }); return n },
    clearTimeout(h) { timeouts.delete(h) },
    async tick(ms) { for (const [, t] of [...intervals]) if (t.ms === ms) t.fn(); await settle() },
    /** Fire every pending timeout of at most `ms` (the freeze deadline). */
    async expire(ms) { for (const [h, t] of [...timeouts]) if (t.ms <= ms) { timeouts.delete(h); t.fn() } await settle() }
  }
}
let nextId = 5000
function fakeView(views) {
  const listeners = new Map()
  const wc = {
    id: ++nextId, url: '', destroyed: false, zoom: 1, muted: false, loads: [], scripts: [], captures: 0, picture: { tag: 'picture' }, pictureGate: null,
    on(event, fn) { listeners.set(event, [...(listeners.get(event) ?? []), fn]); return this },
    emit(event, ...args) { for (const fn of listeners.get(event) ?? []) fn(...args) },
    getURL() { return this.url }, isDestroyed() { return this.destroyed },
    loadURL(u) { this.loads.push(u); this.url = u; return Promise.resolve() },
    focus() {}, close() { this.destroyed = true }, setWindowOpenHandler() {}, setAudioMuted(m) { this.muted = m }, setIgnoreMenuShortcuts() {},
    setZoomFactor(z) { this.zoom = z }, getZoomFactor() { return this.zoom },
    capturePage() { this.captures++; return this.pictureGate ? this.pictureGate.then(() => this.picture) : Promise.resolve(this.picture) },
    executeJavaScriptInIsolatedWorld(world, scripts) { this.scripts.push(scripts[0].code); return Promise.resolve(scripts[0].code.includes('scrollTo(') ? undefined : [0, 500, 0, 1000]) }
  }
  const view = { webContents: wc, bounds: null, visible: null, setBounds(b) { this.bounds = b }, setVisible(v) { this.visible = v }, setBackgroundColor() {} }
  views.push(view)
  return view
}
/** Main's message out of the fixed call script (a JSON string literal holding the JSON). */
const frozenOf = (code) => {
  const at = code.indexOf('window.__twLivePageFrozen(')
  const literal = code.slice(at + 'window.__twLivePageFrozen('.length, code.lastIndexOf(') : false'))
  return JSON.parse(JSON.parse(literal))
}
function fakeDeck(id) {
  const listeners = new Map()
  const deck = {
    destroyed: false, children: new Set(), closedFns: [], report: null, frozen: [], scripts: [],
    // How this deck answers main's freeze messages: show -> the picture id (as a deck that decoded it).
    answer: (m) => (m.op === 'show' ? Promise.resolve(m.id) : true),
    isDestroyed() { return this.destroyed },
    getContentBounds() { return { width: 1440, height: 900 } },
    contentView: { addChildView: (v) => deck.children.add(v), removeChildView: (v) => deck.children.delete(v) },
    webContents: {
      id, isDestroyed: () => deck.destroyed, focus() {}, getZoomFactor: () => 1, removeListener() {},
      on(event, fn) { listeners.set(event, [...(listeners.get(event) ?? []), fn]) },
      emit(event, ...args) { for (const fn of listeners.get(event) ?? []) fn(...args) },
      executeJavaScript(code) {
        if (code === SLOT_SCRIPT) return Promise.resolve(deck.report)
        if (code.startsWith('window.__twLivePageFrozen')) { const m = frozenOf(code); deck.frozen.push(m); return Promise.resolve(deck.answer(m)) }
        deck.scripts.push(code); return Promise.resolve()
      }
    },
    once(event, fn) { if (event === 'closed') this.closedFns.push(fn) },
    ops() { return this.frozen.map((m) => m.op) }
  }
  return deck
}
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])
function makeHost(deck, role, timers, views, capture) {
  return createLivePageHost(deck, role, {
    createView: () => fakeView(views),
    sessionFor: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDevicePermissionHandler() {}, setDisplayMediaRequestHandler() {}, on() {}, webRequest: { onBeforeRequest() {} }, resolveHost: async () => ({ endpoints: [] }), setUserAgent() {}, clearStorageData: async () => {}, clearCache: async () => {} }),
    allowance: new Set(), devTools: false, userAgent: 'UA', newId: () => `n${nextId}`, log: () => {}, timers, capture
  })
}
const captureDeps = (over = {}) => ({
  saves: 0,
  encode: (picture) => (picture && picture.tag === 'picture' ? { jpeg: JPEG, width: 1280, height: 720 } : null),
  save: async () => { throw new Error('a freeze never saves') },
  ...over
})
const report = (over = {}) => ({
  v: 1, slideId: 'page', url: 'https://example.com', rect: { x: 0, y: 0, w: 640, h: 360 }, visible: true, interact: false, reloadSeq: 0, layoutWidth: null,
  captureSeq: 0, gallery: { on: false, index: 0 }, freeze: { seq: 0, want: null }, ...over
})

/** A presenter and an audience window, both showing the page, painted and visible. */
async function pair(opts = {}) {
  const timers = fakeTimers(); const views = []
  const capture = captureDeps(opts.capture)
  const pDeck = fakeDeck(++nextId); const aDeck = fakeDeck(++nextId)
  const p = makeHost(pDeck, 'presenter', timers, views, capture)
  const a = opts.alone ? null : makeHost(aDeck, 'audience', timers, views, capture)
  if (a) pairLivePageHosts(p, a)
  if (a) aDeck.report = report({ rect: { x: 0, y: 0, w: 1280, h: 720 }, layoutWidth: 1280 })
  pDeck.report = report()
  await timers.tick(100)
  const pv = views.find((v) => v.webContents.muted); const av = views.find((v) => !v.webContents.muted)
  for (const v of views) v.webContents.emit('dom-ready')
  await timers.tick(100)
  const press = async (seq, want) => { pDeck.report = report({ freeze: { seq, want } }); await timers.tick(100) }
  return { timers, views, p, a, pDeck, aDeck, pv, av, press, capture }
}
const sha16 = (b) => createHash('sha256').update(b).digest('hex').slice(0, 16)

// --- main: the lifecycle -----------------------------------------------------------------------------
await test('report: the freeze field is optional, strictly checked; only a presenter press counts', () => {
  assert.deepEqual(validateFreezeRequest({ seq: 3, want: 'pen' }), { seq: 3, want: 'pen' })
  assert.deepEqual(validateFreezeRequest({ seq: 0, want: null }), { seq: 0, want: null })
  for (const bad of [null, [], { seq: -1, want: null }, { seq: 1.5, want: 'pen' }, { seq: 1, want: 'eraser' }, { seq: 1, want: 'pen', x: 1 }, { seq: '1', want: 'pen' }]) assert.equal(validateFreezeRequest(bad), null, JSON.stringify(bad))
  assert.deepEqual(validateSlotReport(report({ freeze: { seq: 2, want: 'pointer' } })).freeze, { seq: 2, want: 'pointer' })
  assert.equal(validateSlotReport(report({ freeze: { seq: 2, want: 'brush' } })), null)
  assert.equal(stillIdOf(JPEG), sha16(JPEG))
  assert.equal(frozenAck(sha16(JPEG), sha16(JPEG)), true)
  assert.equal(frozenAck('0000000000000000', sha16(JPEG)), false, 'another picture is not an answer')
  assert.equal(frozenAck(true, sha16(JPEG)), false)
})

await test('Pointer on a live page: the audience copy is captured once; both windows get the same picture; views hide only after both answer; the tool comes on last', async () => {
  const t = await pair()
  let releaseA
  t.aDeck.answer = (m) => (m.op === 'show' ? new Promise((r) => { releaseA = () => r(m.id) }) : true)
  await t.press(1, 'pointer')
  assert.equal(t.av.webContents.captures, 1, 'the audience copy is the source')
  assert.equal(t.pv.webContents.captures, 0)
  const pShow = t.pDeck.frozen.find((m) => m.op === 'show'); const aShow = t.aDeck.frozen.find((m) => m.op === 'show')
  assert.ok(pShow && aShow, 'both windows were sent the picture')
  assert.equal(pShow.id, sha16(JPEG)); assert.equal(aShow.id, pShow.id); assert.equal(aShow.src, pShow.src)
  assert.match(pShow.src, /^data:image\/jpeg;base64,/)
  assert.equal(pShow.source, 'audience')
  assert.equal(t.pv.visible, true, 'presenter view still shown while the audience has not answered')
  assert.equal(t.av.visible, true)
  assert.ok(!t.pDeck.ops().includes('on'), 'no tool before both answer')
  assert.equal(t.p._freezeState().phase, 'pending')
  releaseA(); await settle()
  assert.equal(t.pv.visible, false, 'presenter view hidden behind the picture')
  assert.equal(t.av.visible, false, 'audience view hidden behind the picture')
  assert.deepEqual(t.pDeck.ops(), ['show', 'on'], 'the tool comes on after the picture shows')
  assert.ok(!t.aDeck.ops().includes('on'), 'the audience window is never told to turn a tool on')
  assert.deepEqual(t.p._freezeState(), { phase: 'frozen', id: sha16(JPEG), frozen: true })
  assert.equal(t.a._freezeState().frozen, true)
  // Switching tools on the same picture never re-captures: the deck keeps its number.
  t.pDeck.report = report({ freeze: { seq: 1, want: 'pen' } }); await t.timers.tick(100)
  assert.equal(t.av.webContents.captures, 1, 'no second capture on a tool switch')
  assert.equal([...t.timers.timeouts.values()].filter((x) => x.ms <= LIVE_PAGE_FREEZE_MS).length, 0, 'no freeze timer left after it finished')
  disposeAllLivePageHosts()
})

await test('Return Live: both views shown again, not reloaded or replaced; the audience told to drop the picture; following resumes', async () => {
  const t = await pair()
  await t.press(1, 'pen')
  assert.equal(t.p._freezeState().phase, 'frozen')
  const loadsP = t.pv.webContents.loads.length; const loadsA = t.av.webContents.loads.length
  const readsBefore = t.pv.webContents.scripts.length
  for (const [, iv] of t.timers.intervals) if (iv.ms === 200) iv.fn()
  await settle()
  assert.equal(t.pv.webContents.scripts.length, readsBefore, 'no scroll following while frozen')
  await t.press(2, null)
  assert.equal(t.pv.visible, true); assert.equal(t.av.visible, true)
  assert.equal(t.pv.webContents.loads.length, loadsP, 'Live never reloads the page'); assert.equal(t.av.webContents.loads.length, loadsA)
  assert.equal(t.pv.webContents.destroyed, false); assert.equal(t.av.webContents.destroyed, false)
  assert.ok(t.aDeck.ops().includes('clear'), 'the audience window drops the picture')
  assert.deepEqual(t.p._freezeState(), { phase: 'idle', id: null, frozen: false })
  for (const [, iv] of t.timers.intervals) if (iv.ms === 200) iv.fn()
  await settle()
  assert.ok(t.pv.webContents.scripts.length > readsBefore, 'following resumes after Live')
  disposeAllLivePageHosts()
})

await test('a window that does not show the picture: neither changes, both told to drop it, the tool stays off', async () => {
  const t = await pair()
  t.aDeck.answer = (m) => (m.op === 'show' ? Promise.resolve(false) : true)
  await t.press(1, 'pointer')
  assert.equal(t.pv.visible, true); assert.equal(t.av.visible, true)
  assert.ok(!t.pDeck.ops().includes('on'))
  const clear = t.pDeck.frozen.find((m) => m.op === 'clear')
  assert.ok(clear && /Couldn't freeze/.test(clear.message), 'the presenter is told why')
  assert.ok(t.aDeck.ops().includes('clear'))
  assert.equal(t.p._freezeState().phase, 'idle')
  disposeAllLivePageHosts()
})

await test('timeout: no answer within the bound fails the freeze atomically and leaves no timer; a late answer changes nothing', async () => {
  const t = await pair()
  let late
  t.aDeck.answer = (m) => (m.op === 'show' ? new Promise((r) => { late = () => r(m.id) }) : true)
  await t.press(1, 'pen')
  const deadline = [...t.timers.timeouts.values()].find((x) => x.ms <= LIVE_PAGE_FREEZE_MS && x.ms > 0)
  assert.ok(deadline, 'one bounded deadline is set')
  await t.timers.expire(LIVE_PAGE_FREEZE_MS)
  assert.equal(t.p._freezeState().phase, 'idle')
  assert.ok(t.pDeck.ops().includes('clear') && t.aDeck.ops().includes('clear'))
  assert.equal(t.pv.visible, true); assert.equal(t.av.visible, true)
  late(); await settle()
  assert.equal(t.pv.visible, true, 'the late answer is dropped'); assert.ok(!t.pDeck.ops().includes('on'))
  assert.equal([...t.timers.timeouts.values()].filter((x) => x.ms <= LIVE_PAGE_FREEZE_MS).length, 0, 'no freeze timer left')
  // A capture that never comes back is bounded the same way.
  const u = await pair()
  u.av.webContents.pictureGate = new Promise(() => {})
  await u.press(1, 'pointer')
  await u.timers.expire(LIVE_PAGE_FREEZE_MS)
  assert.equal(u.p._freezeState().phase, 'idle'); assert.equal(u.pDeck.frozen.filter((m) => m.op === 'show').length, 0)
  disposeAllLivePageHosts()
})

await test('cancel while freezing (same tool again, Esc, Live): the picture is dropped when it arrives; views and tool unchanged', async () => {
  const t = await pair()
  let release
  t.av.webContents.pictureGate = new Promise((r) => { release = r })
  await t.press(1, 'pointer')
  await t.press(2, null)
  release(); await settle()
  assert.equal(t.pDeck.frozen.filter((m) => m.op === 'show').length, 0, 'nothing shown after a cancel')
  assert.equal(t.pv.visible, true); assert.equal(t.av.visible, true)
  assert.equal(t.p._freezeState().phase, 'idle')
  // A new press within one poll of a cancel replaces the old freeze and runs on its own.
  await t.press(3, 'pointer')
  assert.equal(t.p._freezeState().phase, 'frozen')
  await t.press(4, null); await t.press(5, 'pen')
  assert.equal(t.p._freezeState().phase, 'frozen'); assert.equal(t.av.webContents.captures, 3, 'a new press after Live takes a new picture')
  disposeAllLivePageHosts()
})

await test('stale: a navigation, reload, slide change or the saved views while capturing drops the picture (raw address without a slash still freezes)', async () => {
  for (const change of ['navigate', 'in-page', 'slide', 'reload', 'gallery']) {
    const t = await pair()
    let release
    t.av.webContents.pictureGate = new Promise((r) => { release = r })
    await t.press(1, 'pointer')
    if (change === 'navigate') { t.av.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }); t.av.webContents.emit('did-navigate', {}, 'https://example.com/next', 200) }
    if (change === 'in-page') t.pv.webContents.emit('did-navigate-in-page', {}, 'https://example.com/#x', true)
    if (change === 'slide') { t.pDeck.report = report({ slideId: 'other', freeze: { seq: 1, want: 'pointer' } }); await t.timers.tick(100) }
    if (change === 'reload') { t.pDeck.report = report({ reloadSeq: 1, freeze: { seq: 1, want: 'pointer' } }); await t.timers.tick(100) }
    if (change === 'gallery') { t.pDeck.report = report({ gallery: { on: true, index: 0 }, freeze: { seq: 1, want: 'pointer' } }); await t.timers.tick(100) }
    release(); await settle()
    assert.equal(t.pDeck.frozen.filter((m) => m.op === 'show').length, 0, `${change}: nothing shown`)
    assert.ok(!t.pDeck.ops().includes('on'), change)
    assert.equal(t.p._freezeState().phase, 'idle', change)
    disposeAllLivePageHosts()
  }
  // The report's own address (no slash) is compared like with like: the press still freezes (owner bug alpha.14).
  const t = await pair()
  await t.press(1, 'pen')
  assert.equal(t.p._freezeState().phase, 'frozen')
  disposeAllLivePageHosts()
})

await test('while frozen: a slide change, Reload or deck reload ends the freeze in both windows', async () => {
  for (const change of ['slide', 'reload', 'deck', 'audience-deck']) {
    const t = await pair()
    await t.press(1, 'pointer')
    assert.equal(t.p._freezeState().phase, 'frozen', change)
    if (change === 'slide') { t.pDeck.report = report({ slideId: 'next', freeze: { seq: 1, want: 'pointer' } }); await t.timers.tick(100) }
    if (change === 'reload') { t.pDeck.report = report({ reloadSeq: 1, freeze: { seq: 1, want: 'pointer' } }); await t.timers.tick(100) }
    if (change === 'deck') t.pDeck.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    if (change === 'audience-deck') t.aDeck.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    await settle()
    assert.equal(t.p._freezeState().phase, 'idle', change)
    assert.equal(t.a._freezeState().frozen, false, change)
    disposeAllLivePageHosts()
  }
})

await test('no audience window: the presenter view is the source and the only window asked; refused when not live; capped size refused', async () => {
  const t = await pair({ alone: true })
  await t.press(1, 'pen')
  const show = t.pDeck.frozen.find((m) => m.op === 'show')
  assert.equal(show.source, 'presenter')
  assert.equal(t.p._freezeState().phase, 'frozen')
  disposeAllLivePageHosts()
  const big = await pair({ capture: { encode: () => ({ jpeg: new Uint8Array(LIVE_PAGE_FREEZE_MAX_JPEG + 1), width: 1920, height: 1080 }) } })
  await big.press(1, 'pointer')
  assert.equal(big.pDeck.frozen.filter((m) => m.op === 'show').length, 0, 'a picture over the cap is never sent')
  assert.ok(big.pDeck.ops().includes('clear'))
  disposeAllLivePageHosts()
  const empty = await pair({ capture: { encode: () => null } })
  await empty.press(1, 'pointer')
  assert.equal(empty.p._freezeState().phase, 'idle'); assert.equal(empty.pv.visible, true)
  disposeAllLivePageHosts()
  // Still loading: refused, nothing captured.
  const timers = fakeTimers(); const views = []
  const deck = fakeDeck(++nextId)
  const host = makeHost(deck, 'presenter', timers, views, captureDeps())
  deck.report = report(); await timers.tick(100)
  deck.report = report({ freeze: { seq: 1, want: 'pointer' } }); await timers.tick(100)
  assert.equal(views[0].webContents.captures, 0)
  assert.match(deck.frozen.find((m) => m.op === 'clear').message, /not showing yet/)
  assert.equal(host._freezeState().phase, 'idle')
  disposeAllLivePageHosts()
})

await test('only the presenter deck\'s own report starts a freeze: the audience deck\'s report and the page\'s own events never do', async () => {
  const t = await pair()
  t.aDeck.report = report({ rect: { x: 0, y: 0, w: 1280, h: 720 }, layoutWidth: 1280, freeze: { seq: 7, want: 'pen' } })
  await t.timers.tick(100); await t.timers.tick(100)
  for (const ev of ['did-navigate', 'dom-ready', 'did-finish-load', 'focus']) { t.av.webContents.emit(ev, {}, 'https://example.com/'); t.pv.webContents.emit(ev, {}, 'https://example.com/') }
  await settle()
  assert.equal(t.av.webContents.captures + t.pv.webContents.captures, 0)
  assert.equal(t.p._freezeState().phase, 'idle')
  disposeAllLivePageHosts()
})

// --- main: the audience is the only source while its window is open (review 61cf3de9, P2 2 and 3) ---
const refused = (t, what) => {
  assert.equal(t.pv.webContents.captures + t.av.webContents.captures, 0, `${what}: nothing captured`)
  assert.equal(t.pDeck.frozen.filter((m) => m.op === 'show').length + t.aDeck.frozen.filter((m) => m.op === 'show').length, 0, `${what}: no picture sent`)
  assert.equal(t.p._freezeState().phase, 'idle'); assert.equal(t.a._freezeState().frozen, false)
  assert.match(t.pDeck.frozen.find((m) => m.op === 'clear')?.message ?? '', /audience window isn't showing this page/, `${what}: said why`)
}
await test('an open audience window whose slot is hidden: refused; the presenter copy is never captured or sent to it', async () => {
  const t = await pair()
  t.aDeck.report = report({ visible: false }); await t.timers.tick(100)
  await t.press(1, 'pen')
  refused(t, 'hidden audience slot')
  assert.equal(t.pv.visible, true)
  disposeAllLivePageHosts()
})
await test('an open audience window with its view closed: refused, no presenter fallback', async () => {
  const t = await pair()
  t.a.closeView('test closed')
  await t.press(1, 'pointer')
  refused(t, 'closed audience view')
  disposeAllLivePageHosts()
})
await test('an audience window on another slide with the same page: refused; never its pixels', async () => {
  const t = await pair()
  t.aDeck.report = report({ slideId: 'different-slide', rect: { x: 0, y: 0, w: 1280, h: 720 }, layoutWidth: 1280 }); await t.timers.tick(100)
  await t.press(1, 'pointer')
  refused(t, 'audience on another slide')
  disposeAllLivePageHosts()
})
await test('the audience alone moves to another slide with the same page while frozen: both views shown again, both decks cleared', async () => {
  const t = await pair()
  await t.press(1, 'pointer')
  assert.equal(t.p._freezeState().phase, 'frozen'); assert.equal(t.av.visible, false); assert.equal(t.pv.visible, false)
  t.aDeck.report = report({ slideId: 'different-slide', rect: { x: 0, y: 0, w: 1280, h: 720 }, layoutWidth: 1280 }); await t.timers.tick(100)
  assert.equal(t.a._freezeState().frozen, false); assert.equal(t.av.visible, true, 'audience native view shown')
  assert.equal(t.p._freezeState().phase, 'idle'); assert.equal(t.pv.visible, true, 'presenter native view shown')
  assert.match(t.pDeck.frozen.findLast((m) => m.op === 'clear').message, /audience window moved/)
  assert.ok(t.aDeck.ops().includes('clear'))
  for (const v of t.views) assert.equal(v.webContents.loads.length, 1, 'no reload')
  disposeAllLivePageHosts()
})
await test('the audience alone reloads or leaves the slide while frozen: released in both windows', async () => {
  for (const change of [{ reloadSeq: 1 }, null]) {
    const t = await pair()
    await t.press(1, 'pen')
    assert.equal(t.p._freezeState().phase, 'frozen')
    t.aDeck.report = change && report({ rect: { x: 0, y: 0, w: 1280, h: 720 }, layoutWidth: 1280, ...change }); await t.timers.tick(100)
    assert.equal(t.a._freezeState().frozen, false); assert.equal(t.p._freezeState().phase, 'idle'); assert.equal(t.pv.visible, true)
    // A reload shows the view again once the reloaded page paints (never kept hidden by the freeze).
    if (change) { t.av.webContents.emit('dom-ready'); await t.timers.tick(100); assert.equal(t.av.visible, true) }
    disposeAllLivePageHosts()
  }
})
await test('the audience alone moves on while the picture is being taken: nothing hidden, no picture shown, no timer left', async () => {
  const t = await pair()
  let release; t.av.webContents.pictureGate = new Promise((r) => { release = r })
  await t.press(1, 'pointer')
  assert.equal(t.p._freezeState().phase, 'pending')
  t.aDeck.report = report({ slideId: 'different-slide', rect: { x: 0, y: 0, w: 1280, h: 720 }, layoutWidth: 1280 }); await t.timers.tick(100)
  assert.equal(t.p._freezeState().phase, 'idle')
  release(); await settle()
  assert.equal(t.aDeck.frozen.filter((m) => m.op === 'show').length + t.pDeck.frozen.filter((m) => m.op === 'show').length, 0)
  assert.equal(t.av.visible, true); assert.equal(t.pv.visible, true); assert.equal(t.a._freezeState().frozen, false)
  assert.equal(t.timers.timeouts.size, 0)
  disposeAllLivePageHosts()
})
await test('the audience moves on between both answers and the hide: refused at commit, nothing hidden', async () => {
  const t = await pair()
  // The audience deck answers, and from then on no longer shows that slide (as if it moved on).
  const realShows = t.a._showsPage
  let answered = false
  t.a._showsPage = (slideId, authored) => (answered ? false : realShows(slideId, authored))
  t.aDeck.answer = (m) => { if (m.op === 'show') answered = true; return m.op === 'show' ? Promise.resolve(m.id) : true }
  await t.press(1, 'pen')
  assert.equal(t.p._freezeState().phase, 'idle'); assert.equal(t.av.visible, true); assert.equal(t.pv.visible, true)
  assert.equal(t.pDeck.ops().includes('on'), false, 'the tool never comes on')
  disposeAllLivePageHosts()
})

// --- the presenter preload's venue and recorder sinks refuse while the deck is frozen (review 61cf3de9 P2 1) ---
await test('preload sinks: while the deck root carries the freeze mark no ink goes to the venue or a recording, and the pointer is gone', async () => {
  const { LIVE_FREEZE_ATTRIBUTE, venueInk, venuePointer, recordedDeckInk, readInkSlot } = await import('../src/preload/recorder-ink.ts')
  assert.equal(LIVE_FREEZE_ATTRIBUTE, 'data-tw-live-freeze')
  const slideDraft = { slideId: 'page', space: 'slide', strokes: [], draft: { tool: 'freehand', ink: 'red', width: 'thin', points: [[0.1563, 0.2778], [0.3125, 0.4167]] } }
  const committed = { slideId: 'page', space: 'slide', strokes: [{ tool: 'freehand', ink: 'red', width: 'thin', points: [[0.1, 0.1], [0.3, 0.4]] }], draft: null }
  const root = (frozen, ink, pointer) => ({ hasAttribute: (n) => frozen && n === LIVE_FREEZE_ATTRIBUTE, dataset: { twLiveInk: JSON.stringify(ink), twLivePointer: JSON.stringify(pointer) } })
  const at = { x: 0.5, y: 0.5, space: 'slide', slideId: 'page' }
  // The review's leaked draft: accepted by the plain reader and the worker; refused by the sink while frozen.
  assert.ok(readInkSlot(JSON.stringify(slideDraft)))
  assert.ok(parseInkMessage({ type: 'ink.live', ink: slideDraft }))
  assert.equal(venueInk(root(true, slideDraft, at)), null)
  assert.equal(venueInk(root(true, committed, at)), null)
  assert.deepEqual(venuePointer(root(true, committed, at)), { type: 'pointer.live', pointer: 'gone' })
  assert.equal(recordedDeckInk(root(true, committed, at), 'page'), null)
  // An unreadable root counts as frozen.
  assert.equal(venueInk({ hasAttribute() { throw new Error('gone') }, dataset: {} }), null)
  // Outside a freeze, ordinary slide pointer and ink are unchanged.
  assert.deepEqual(venueInk(root(false, committed, at)), readInkSlot(JSON.stringify(committed)))
  assert.deepEqual(venuePointer(root(false, committed, at)), parsePointerMessage({ type: 'pointer.live', pointer: at }))
  assert.equal(recordedDeckInk(root(false, committed, at), 'page')?.strokes.length, 1)
  assert.equal(recordedDeckInk(root(false, slideDraft, at), 'page'), null, 'a draft is still never recorded')
  // The real preload modules read their slots only through these sinks, and wake on the mark too.
  const bridge = fs.readFileSync(join(repo, 'src/preload/present-live-bridge.ts'), 'utf8')
  assert.ok(bridge.includes('venueInk(document.documentElement)') && bridge.includes('venuePointer(document.documentElement)'))
  assert.ok(!/readInkSlot\(|parsePointerMessage\(/.test(bridge), 'no unguarded slot read in the live bridge')
  assert.match(bridge, /attributeFilter: \['data-tw-live-pointer', 'data-tw-live-pointer-tick', LIVE_FREEZE_ATTRIBUTE\]/)
  const recorder = fs.readFileSync(join(repo, 'src/preload/present-recorder.ts'), 'utf8')
  assert.ok(recorder.includes('recordedDeckInk(document.documentElement, slideId)') && !recorder.includes('recordedInk('))
})

await test('withDeadline: the value, a timeout or a rejection; its timer always cleared', async () => {
  const timers = fakeTimers()
  const ok = await withDeadline(Promise.resolve(4), 1000, () => 0, timers)
  assert.deepEqual(ok, { ok: true, value: 4 }); assert.equal(timers.timeouts.size, 0)
  const bad = await withDeadline(Promise.reject(new Error('x')), 1000, () => 0, timers)
  assert.deepEqual(bad, { ok: false, why: 'error' }); assert.equal(timers.timeouts.size, 0)
  const pending = withDeadline(new Promise(() => {}), 1000, () => 0, timers)
  await timers.expire(1000)
  assert.deepEqual(await pending, { ok: false, why: 'timeout' })
})

// --- the deck: state machine, message check, picture list ------------------------------------------
const ctx = (over = {}) => ({ slideId: 'page', url: 'https://example.com', live: true, saved: null, now: 0, ...over })
const ID = 'ab12cd34ef567890'
await test('deck: Pointer/Pen on a live page asks main (no manual Freeze step); the same tool again cancels; the other tool swaps without a new press', () => {
  const f = createLiveFreeze()
  assert.equal(f.want(), null)
  assert.deepEqual(f.press('pointer', ctx()), { do: 'pending' })
  assert.deepEqual([f.state().seq, f.want()], [1, 'pointer'])
  assert.deepEqual(f.press('pen', ctx()), { do: 'swap' })
  assert.deepEqual([f.state().seq, f.want()], [1, 'pen'], 'swap keeps the number: main takes no second picture')
  assert.deepEqual(f.press('pen', ctx()), { do: 'cancel' })
  assert.deepEqual([f.state().phase, f.state().seq, f.want()], ['off', 2, null])
  assert.deepEqual(f.press('pen', ctx({ live: false })), { do: 'refuse', message: 'The page is not showing yet, so there is nothing to point at.' })
  assert.equal(f.state().phase, 'off')
})

await test('deck: show/on accepted only for this press, slide and page; Esc keeps the picture; Live ends it; a slide change ends it', () => {
  const f = createLiveFreeze()
  f.press('pen', ctx())
  const show = { v: 1, op: 'show', seq: 1, slideId: 'page', url: 'https://example.com/', id: ID, src: 'data:image/jpeg;base64,AA==', width: 2, height: 2, source: 'audience' }
  assert.equal(f.show({ ...show, seq: 9 }), false, 'another press')
  assert.equal(f.show({ ...show, slideId: 'x' }), false, 'another slide')
  assert.equal(f.show({ ...show, url: 'https://other.example/' }), false, 'another page')
  assert.equal(f.show(show), true, 'a slash more or less is the same page')
  assert.equal(f.on({ ...show, op: 'on', id: '0000000000000000' }), null, 'another picture')
  assert.equal(f.on({ ...show, op: 'on' }), 'pen')
  assert.equal(f.state().phase, 'frozen')
  assert.equal(f.toolOff(), 'keep', 'Esc or the tool button: the picture stays')
  assert.deepEqual(f.press('pointer', ctx()), { do: 'arm' }, 'switching tools reuses the picture')
  assert.equal(f.state().seq, 1)
  assert.equal(f.live(), 'live'); assert.deepEqual([f.state().phase, f.state().seq, f.want()], ['off', 2, null])
  f.press('pointer', ctx()); f.show({ ...show, seq: 3 }); f.on({ ...show, op: 'on', seq: 3 })
  assert.equal(f.leave(), true); assert.equal(f.state().phase, 'off')
  // Failure from main clears only this press.
  f.press('pen', ctx())
  assert.equal(f.clear({ v: 1, op: 'clear', seq: 2, slideId: 'page', url: 'x' }), false)
  assert.equal(f.clear({ v: 1, op: 'clear', seq: f.state().seq, slideId: 'page', url: 'x' }), true)
  // The deck gives up on its own when main never answers.
  f.press('pen', ctx({ now: 1000 }))
  assert.equal(f.expire(1000 + LIVE_FREEZE_LIMITS.pendingMs - 1), false)
  assert.equal(f.expire(1000 + LIVE_FREEZE_LIMITS.pendingMs), true)
  assert.equal(f.want(), null)
})

await test('deck: a shown saved view is marked as it is (no main); an Entire page view is refused honestly; Live goes back to the page', () => {
  const f = createLiveFreeze()
  const src = 'data:image/jpeg;base64,QUJD'
  assert.deepEqual(f.press('pen', ctx({ live: false, saved: { src, mode: 'view' } })), { do: 'arm' })
  assert.deepEqual([f.state().source, f.state().id, f.want(), f.state().seq], ['saved', liveStillKey(src), null, 0], 'main is not asked')
  assert.equal(f.live(), 'saved')
  assert.equal(f.press('pen', ctx({ saved: { src, mode: 'page' } })).do, 'refuse')
  assert.match(f.press('pen', ctx({ saved: { src, mode: 'page' } })).message, /Entire page/)
})

await test('deck: main\'s message checked field by field; only a JPEG data: picture within the size cap', () => {
  const show = { v: 1, op: 'show', seq: 1, slideId: 'page', url: 'https://example.com/', id: ID, src: 'data:image/jpeg;base64,AA==', width: 2, height: 2, source: 'audience' }
  assert.deepEqual(liveFrozenMessage(JSON.stringify(show)), show)
  assert.equal(liveFrozenMessage(JSON.stringify({ ...show, source: 'evil' })).source, 'audience')
  for (const bad of [
    { ...show, v: 2 }, { ...show, op: 'run' }, { ...show, id: 'ABCDEF0123456789' }, { ...show, id: '<img>' },
    { ...show, src: 'data:text/html,<script>1</script>' }, { ...show, src: 'https://x.example/a.jpg' }, { ...show, src: 'javascript:1' },
    { ...show, width: 0 }, { ...show, seq: -1 }, { ...show, slideId: 'x'.repeat(200) }, { ...show, src: `data:image/jpeg;base64,${'A'.repeat(LIVE_FREEZE_LIMITS.srcChars)}` }
  ]) assert.equal(liveFrozenMessage(JSON.stringify(bad)), null, JSON.stringify(bad).slice(0, 80))
  assert.equal(liveFrozenMessage('{'), null)
  assert.equal(liveFrozenMessage(JSON.stringify({ v: 1, op: 'clear', seq: 1, slideId: 'p', url: 'https://e.x/', message: 'm'.repeat(900) })).message.length, 300)
  assert.equal(liveSamePage('https://example.com', 'https://example.com/'), true)
  assert.equal(liveSamePage('https://example.com/a', 'https://example.com/b'), false)
})

await test('deck: at most 20 pictures a talk; the oldest without marks goes first, and its marks with it', () => {
  const ledger = createLiveStillLedger(3)
  const marked = new Set(['k1'])
  assert.equal(ledger.note('k1', (k) => marked.has(k)), null)
  ledger.note('k2'); ledger.note('k3')
  assert.equal(ledger.note('k4', (k) => marked.has(k)), 'k2', 'k1 has marks, so k2 goes')
  assert.equal(ledger.note('k3'), null, 'seen again: kept, moved to newest')
  assert.deepEqual(ledger.ids(), ['k1', 'k4', 'k3'])
  assert.equal(LIVE_FREEZE_LIMITS.stills, 20)
  const all = createLiveStillLedger(3)
  for (const k of ['a', 'b', 'c']) all.note(k)
  assert.equal(all.note('d', () => true), 'a', 'all marked: the oldest goes')
  assert.equal(liveStillKey('data:image/jpeg;base64,AA=='), liveStillKey('data:image/jpeg;base64,AA=='))
  assert.match(liveStillKey('x'), /^[0-9a-f]{16}$/)
  assert.notEqual(liveStillKey('data:image/jpeg;base64,AA=='), liveStillKey('data:image/jpeg;base64,AB=='))
})

// --- marks bound to the picture; never online -------------------------------------------------------
await test('still space: marks name their picture; a wrong or missing id is refused; the online worker refuses it all', () => {
  assert.equal(validPointer({ x: 0.5, y: 0.25, space: 'still', still: ID, slideId: 'page' }), true)
  assert.equal(validPointer({ x: 0.5, y: 0.25, space: 'still', slideId: 'page' }), false, 'no picture id')
  assert.equal(validPointer({ x: 0.5, y: 0.25, space: 'still', still: 'nope', slideId: 'page' }), false)
  assert.equal(validPointer({ x: 2, y: 0.25, space: 'still', still: ID, slideId: 'page' }), false, '0–1 units')
  assert.equal(validPointer({ x: 2, y: 2, space: 'slide', still: ID, slideId: 'page' }), false, 'only a still names a picture')
  assert.deepEqual(pointerPoint(300, 200, { left: 100, top: 100, width: 800, height: 400 }, 'still'), { x: 0.25, y: 0.25, space: 'still' })
  const stroke = { tool: 'arrow', ink: 'red', width: 'thin', points: [[0.1, 0.2], [0.5, 0.6]] }
  const view = penInkView({ slideId: 'page', space: 'still', still: ID, strokes: [stroke], draft: null })
  assert.equal(view.still, ID)
  assert.equal(penInkView({ slideId: 'page', space: 'still', strokes: [stroke], draft: null }), null)
  assert.equal(penInkView({ slideId: 'page', space: 'still', still: ID, strokes: [{ ...stroke, points: [[2, 2], [3, 3]] }], draft: null }), null)
  assert.equal(penInkView({ slideId: 'page', space: 'slide', still: ID, strokes: [], draft: null }), null)
  assert.notEqual(penLayerKey('page', 'still', ID), penLayerKey('page', 'still', '0000000000000000'), 'each picture its own layer')
  assert.notEqual(penLayerKey('page', 'still', ID), penLayerKey('page', 'slide'))
  const store = createPenStore()
  store.add(penLayerKey('page', 'still', ID), stroke)
  assert.equal(store.strokes(penLayerKey('page', 'slide')).length, 0, 'still marks never show on the slide layer')
  assert.equal(parsePointerMessage({ type: 'pointer.live', pointer: { x: 0.5, y: 0.5, space: 'still', still: ID, slideId: 'page' } }), null, 'the worker refuses a still pointer')
  assert.equal(parseInkMessage({ type: 'ink.live', ink: view }), null, 'the worker refuses still ink')
})

// Checked before the compiler runs (it is not the freeze path and keeps caches of its own).
await test('nothing written and nothing sent on the network by the freeze path', () => {
  assert.deepEqual(writes, [], `file writes: ${writes.join(', ')}`)
  assert.deepEqual(network, [])
})

await test('compiled deck: the freeze runtime and its window call are in it, and its script parses', async () => {
  const src = liveFreezeRuntimeSource()
  const made = new Function(`${src}; return { createLiveFreeze, liveFrozenMessage, liveStillKey, createLiveStillLedger, liveSamePage };`)()
  assert.equal(made.liveStillKey('abc'), liveStillKey('abc'))
  assert.deepEqual(made.createLiveFreeze().press('pen', ctx()), { do: 'pending' })
  const { prepareSource } = await import('../compiler/scripts/lib/08-source-adapters.mjs')
  const outline = '---\ntitle: Freeze\nauto_title_slide: false\nauto_thanks_slide: false\n---\n\n### Radio Times {id=page}\n\n[Embed: https://example.org]\n'
  // prepareSource reads the outline's folder for assets only; the outline itself is passed as text.
  const model = await prepareSource(join(repo, 'research', 'no-such-freeze-outline.md'), outline, null, { mtimeMs: 0, size: outline.length, isDirectory: () => false, isFile: () => true }, {}, {})
  const html = model.fullHtml
  for (const needle of ['window.__twLivePageFrozen', 'function createLiveFreeze', 'livePageReturnLive', 'live-page-frozen', '"return-live"']) assert.ok(html.includes(needle), needle)
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((s) => s.includes('__twLivePageFrozen'))
  assert.ok(scripts.length >= 1)
  for (const s of scripts) new Function(s) // parses (not run)
})

console.log(`live page freeze: ${passed} passed`)
