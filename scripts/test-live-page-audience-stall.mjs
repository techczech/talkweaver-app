// KNOWN FAILING (fault found 16 Nov 2026, not yet fixed; not in the test chain): the audience window's copy of a
// live web page (src/main/live-page-host.ts) can stay unloaded while the presenter's copy shows, with nothing
// that retries it. Owner report on 0.45.1: one embedded page did not show on the projector until he
// entered Interact in the presenter view; later visits loaded at once.
//   1. A main-frame load that ends in ERR_ABORTED (-3) is ignored (did-fail-load returns early). When no other
//      navigation follows, the view is never painted, so it stays hidden in 'loading' (then 'slow') for good.
//      Only a later loadURL wakes it: the presenter's own navigation (_followNavigation), which is what using
//      the page in Interact causes.
//   2. A failed audience load is never retried: Reload exists only in the presenter view, and its press
//      (reloadSeq) reaches only the presenter's host; the audience deck's reloadSeq never changes.
// Fakes as in scripts/test-live-page.mjs. No Electron, no browser.
import assert from 'node:assert/strict'
import { SLOT_SCRIPT, createLivePageHost, pairLivePageHosts } from '../src/main/live-page-host.ts'

const flush = () => new Promise((r) => setImmediate(r))
let failed = 0
const test = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`) } catch (err) { failed++; console.error(`  FAIL ${name}\n       ${err.message.split('\n')[0]}`) }
}
function fakeTimers() {
  const intervals = new Map(); const timeouts = new Map(); let n = 0
  return {
    intervals, timeouts,
    setInterval(fn, ms) { n++; intervals.set(n, { fn, ms }); return n },
    clearInterval(h) { intervals.delete(h) },
    setTimeout(fn, ms) { n++; timeouts.set(n, { fn, ms }); return n },
    clearTimeout(h) { timeouts.delete(h) },
    async tick(ms) { for (const [, t] of [...intervals]) if (t.ms === ms) t.fn(); await flush(); await flush() },
    async fire(ms) { for (const [h, t] of [...timeouts]) if (t.ms === ms) { timeouts.delete(h); t.fn() } await flush() }
  }
}
function fakeContents(id, url = '') {
  const listeners = new Map()
  return {
    id, url, getURL() { return this.url },
    on(event, fn) { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(fn); return this },
    once(event, fn) { return this.on(event, fn) },
    emit(event, ...args) { for (const fn of listeners.get(event) ?? []) fn(...args) },
    session: { webRequest: { onBeforeRequest() {}, onHeadersReceived() {} } }
  }
}
let nextId = 3000
function fakeView(log) {
  const wc = fakeContents(++nextId)
  Object.assign(wc, {
    destroyed: false, zoom: 1, loads: [],
    isDestroyed() { return this.destroyed },
    loadURL(u) { this.loads.push(u); return Promise.resolve() },
    focus() {}, close() { this.destroyed = true }, setWindowOpenHandler() {}, setAudioMuted(m) { this.muted = m }, setIgnoreMenuShortcuts() {},
    setZoomFactor(z) { this.zoom = z }, getZoomFactor() { return this.zoom },
    executeJavaScriptInIsolatedWorld() { return Promise.resolve([0, 500, 0, 1000]) }
  })
  const view = { webContents: wc, bounds: null, visible: null, setBounds(b) { this.bounds = b }, setVisible(v) { this.visible = v }, setBackgroundColor() {} }
  log.push(view)
  return view
}
function fakeSession() {
  return {
    webRequest: { onBeforeRequest() {}, onBeforeSendHeaders() {}, onHeadersReceived() {} },
    setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDevicePermissionHandler() {}, setDisplayMediaRequestHandler() {},
    on() {}, setUserAgent() {}, protocol: { isProtocolHandled() { return false } }, clearStorageData() { return Promise.resolve() }, clearCache() { return Promise.resolve() },
    setSpellCheckerEnabled() {}, setBluetoothPairingHandler() {}, setUSBProtectedClassesHandler() {}, serviceWorkers: { on() {} }, resolveHost() { return Promise.resolve({ endpoints: [] }) }
  }
}
function fakeDeck(id) {
  const wc = fakeContents(id, 'file:///deck.html?livepage=1')
  const deck = {
    destroyed: false, report: null, scripts: [],
    isDestroyed() { return this.destroyed },
    getContentBounds() { return { x: 0, y: 0, width: 1440, height: 900 } },
    contentView: { addChildView() {}, removeChildView() {} },
    webContents: Object.assign(wc, {
      isDestroyed: () => deck.destroyed,
      executeJavaScript(code) { if (code === SLOT_SCRIPT) return Promise.resolve(deck.report); deck.scripts.push(code); return Promise.resolve() },
      focus() {}, getZoomFactor: () => 1, removeListener() {}
    }),
    once() {}, close() { this.destroyed = true }
  }
  return deck
}
const report = (over = {}) => ({ v: 1, slideId: 's1', url: 'https://example.com/', rect: { x: 0, y: 0, w: 1280, h: 720 }, visible: true, interact: false, reloadSeq: 0, layoutWidth: 1280, ...over })
function pair() {
  const timers = fakeTimers(); const views = []
  const make = (deck, role) => createLivePageHost(deck, role, {
    createView: () => fakeView(views), sessionFor: () => fakeSession(),
    allowance: new Set(), devTools: false, userAgent: 'UA Electron/1', newId: () => 'x', log: () => {}, timers
  })
  const pDeck = fakeDeck(1); const aDeck = fakeDeck(2)
  const p = make(pDeck, 'presenter'); const a = make(aDeck, 'audience')
  pairLivePageHosts(p, a)
  return { timers, views, pDeck, aDeck, p, a }
}

console.log('live page: the audience copy is not left unloaded (KNOWN FAILING)')

await test('an audience load aborted with nothing after it is retried (or shown), not left hidden for good', async () => {
  const { timers, views, pDeck, aDeck } = pair()
  pDeck.report = report({ rect: { x: 0, y: 0, w: 640, h: 360 }, layoutWidth: null }); aDeck.report = report()
  await timers.tick(100)
  const pv = views.find((v) => v.webContents.muted); const av = views.find((v) => !v.webContents.muted)
  pv.webContents.emit('dom-ready'); await timers.tick(100)
  assert.equal(pv.visible, true, 'presenter copy shows')
  av.webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://example.com/', true)
  for (let i = 0; i < 5; i++) await timers.tick(100)
  await timers.fire(20_000)
  for (let i = 0; i < 5; i++) await timers.tick(100)
  assert.ok(av.visible === true || av.webContents.loads.length > 1, `audience copy hidden with ${av.webContents.loads.length} load(s): the room sees an empty slot`)
})

await test("the presenter's Reload also retries a failed audience copy", async () => {
  const { timers, views, pDeck, aDeck } = pair()
  pDeck.report = report({ rect: { x: 0, y: 0, w: 640, h: 360 }, layoutWidth: null }); aDeck.report = report()
  await timers.tick(100)
  const pv = views.find((v) => v.webContents.muted); const av = views.find((v) => !v.webContents.muted)
  pv.webContents.emit('dom-ready')
  av.webContents.emit('did-fail-load', {}, -118, 'ERR_CONNECTION_TIMED_OUT', 'https://example.com/', true)
  await timers.tick(100)
  const before = av.webContents.loads.length
  pDeck.report = report({ rect: { x: 0, y: 0, w: 640, h: 360 }, layoutWidth: null, reloadSeq: 1 })
  for (let i = 0; i < 3; i++) await timers.tick(100)
  assert.ok(av.webContents.loads.length > before, `Reload pressed: the audience copy was loaded ${av.webContents.loads.length - before} more time(s)`)
})

if (failed) { console.error(`${failed} known failing check(s): see the header`); process.exit(1) }
console.log('PASS (the fault is fixed: register this test and drop KNOWN FAILING)')
