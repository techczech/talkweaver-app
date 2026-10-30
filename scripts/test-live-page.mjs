// A live web page on a slide (src/main/live-page-policy.ts, src/main/live-page-host.ts): the address
// rule, the deck's report, bounds and zoom, the test-only loopback gate, the session's request rule
// (every request treated as embedded), the app-wide guard leaving live views alone, the session
// hardening, and the host's lifecycle against fake windows and views. No Electron, no browser.
import assert from 'node:assert/strict'
import {
  hostPortOf, livePageRequestScheme, livePageStateScript, livePageUserAgent, parseLivePageUrl, presenterZoom, slotToViewBounds,
  testLoopbackAllowance, validateSlotReport
} from '../src/main/live-page-policy.ts'
import { decideLocalRequest, localAddressRequestListener } from '../src/main/local-address-filter.ts'
import { guardWebContents } from '../src/main/navigation-guard.ts'
import {
  INTERACT_OFF_SCRIPT, LIVE_PAGE_WORLD_ID, SLOT_SCRIPT, createLivePageHost, disposeAllLivePageHosts, hardenLivePageSession, isLivePageContents,
  livePageRequestListener, livePageViewCount, livePageWebPreferences, pairLivePageHosts
} from '../src/main/live-page-host.ts'

let passed = 0
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`) } catch (err) { console.error(`  FAIL ${name}`); throw err }
}
const flush = () => new Promise((r) => setImmediate(r))

console.log('live page')

await test('address rule: web pages on the internet only', () => {
  for (const ok of ['https://example.org', 'https://audioarchive.semanticmachines.fyi/', 'http://languagelog.ldc.upenn.edu/nll/?p=60956', 'https://8.8.8.8/', 'https://[2606:4700::1]/']) {
    assert.ok(parseLivePageUrl(ok), ok)
  }
  for (const bad of [
    '', null, 42, 'not a url', 'file:///etc/hosts', 'twasset://x/y', 'javascript:alert(1)', 'data:text/html,hi', 'chrome://settings', 'mailto:a@b.c',
    'ftp://example.com/', 'blob:https://example.com/x', 'about:blank', 'https://user:pw@example.com/', 'https://user@example.com/',
    'http://localhost/', 'http://localhost:8080/', 'http://a.localhost/', 'http://printer.local/', 'http://127.0.0.1/', 'http://2130706433/',
    'http://0x7f.1/', 'http://10.0.0.1/', 'http://192.168.1.1/', 'http://172.16.0.1/', 'http://169.254.169.254/', 'http://[::1]/',
    'http://[fe80::1]/', 'http://[::ffff:127.0.0.1]/', 'http://0.0.0.0/', 'http://100.64.0.1/', `https://example.com/${'a'.repeat(2100)}`
  ]) assert.equal(parseLivePageUrl(bad), null, String(bad).slice(0, 60))
})

await test('test-only loopback gate: never packaged, never without the e2e flag, exact host:port', () => {
  assert.equal(testLoopbackAllowance({ isPackaged: true, e2e: true, value: '127.0.0.1:5000' }).size, 0)
  assert.equal(testLoopbackAllowance({ isPackaged: false, e2e: false, value: '127.0.0.1:5000' }).size, 0)
  assert.equal(testLoopbackAllowance({ isPackaged: false, e2e: true, value: undefined }).size, 0)
  assert.equal(testLoopbackAllowance({ isPackaged: false, e2e: true, value: 'localhost:5000,192.168.1.1:80,127.0.0.1,127.0.0.1:0,127.0.0.1:99999' }).size, 0)
  const allow = testLoopbackAllowance({ isPackaged: false, e2e: true, value: '127.0.0.1:5000, 127.0.0.1:5001' })
  assert.deepEqual([...allow].sort(), ['127.0.0.1:5000', '127.0.0.1:5001'])
  assert.ok(parseLivePageUrl('http://127.0.0.1:5000/page', allow))
  assert.equal(parseLivePageUrl('http://127.0.0.1:5002/page', allow), null, 'another port on loopback stays refused')
  assert.equal(parseLivePageUrl('http://localhost:5000/page', allow), null, 'a name for loopback stays refused')
  assert.equal(hostPortOf(new URL('https://Example.com/')), 'example.com:443')
})

const report = (over = {}) => ({ v: 1, slideId: 's1', url: 'https://example.com/', rect: { x: 10, y: 20, w: 800, h: 450 }, visible: true, interact: false, reloadSeq: 0, layoutWidth: null, ...over })

await test('deck report: strict shape', () => {
  // A report without the capture gallery's fields still reads (defaults); with them, both are checked.
  assert.deepEqual(validateSlotReport(report()), { ...report(), captureSeq: 0, gallery: { on: false, index: 0 }, captureMode: 'view', freeze: { seq: 0, want: null } })
  const withGallery = report({ captureSeq: 3, gallery: { on: true, index: 2 } })
  assert.deepEqual(validateSlotReport(withGallery), { ...withGallery, captureMode: 'view', freeze: { seq: 0, want: null } })
  // The Capture embed window also says what Capture takes; only the two words are read.
  assert.equal(validateSlotReport({ ...withGallery, captureMode: 'page' }).captureMode, 'page')
  assert.equal(validateSlotReport({ ...withGallery, captureMode: 'view' }).captureMode, 'view')
  for (const mode of ['Page', 'full', '', null, 1, { page: true }]) assert.equal(validateSlotReport({ ...withGallery, captureMode: mode }), null, String(mode))
  assert.equal(validateSlotReport({ ...report(), captureMode: 'page' }), null, 'only with the capture fields')
  for (const bad of [report({ captureSeq: 1 }), report({ captureSeq: -1, gallery: { on: false, index: 0 } }), report({ captureSeq: 1.5, gallery: { on: false, index: 0 } }),
    report({ captureSeq: 1, gallery: { on: 'yes', index: 0 } }), report({ captureSeq: 1, gallery: { on: true, index: 1000 } }), report({ captureSeq: 1, gallery: { on: true, index: 0, x: 1 } }),
    report({ captureSeq: 1, gallery: null })]) {
    assert.equal(validateSlotReport(bad), null, JSON.stringify(bad)?.slice(0, 120))
  }
  assert.ok(validateSlotReport(report({ layoutWidth: 1280 })))
  for (const bad of [null, [], 'x', report({ v: 2 }), report({ extra: 1 }), report({ slideId: 'x'.repeat(129) }), report({ url: '' }), report({ visible: 'yes' }),
    report({ interact: 1 }), report({ reloadSeq: -1 }), report({ reloadSeq: 1.5 }), report({ layoutWidth: 0 }), report({ rect: { x: 0, y: 0, w: 1 } }),
    report({ rect: { x: NaN, y: 0, w: 1, h: 1 } }), report({ rect: { x: 0, y: 0, w: Infinity, h: 1 } }), report({ rect: { x: 0, y: 0, w: 1, h: 1, z: 1 } })]) {
    assert.equal(validateSlotReport(bad), null, JSON.stringify(bad)?.slice(0, 80))
  }
  const { url: _u, ...missing } = report()
  assert.equal(validateSlotReport(missing), null)
})

await test('bounds: deck zoom, clipping, minimum size', () => {
  assert.deepEqual(slotToViewBounds({ x: 10, y: 20, w: 800, h: 450 }, 1, { width: 1440, height: 900 }), { x: 10, y: 20, width: 800, height: 450 })
  assert.deepEqual(slotToViewBounds({ x: 10.4, y: 20.6, w: 100, h: 100 }, 1.25, { width: 1440, height: 900 }), { x: 13, y: 26, width: 125, height: 125 })
  assert.deepEqual(slotToViewBounds({ x: -50, y: 0, w: 300, h: 300 }, 1, { width: 200, height: 900 }), { x: 0, y: 0, width: 200, height: 300 })
  assert.equal(slotToViewBounds({ x: 0, y: 0, w: 39, h: 300 }, 1, { width: 1440, height: 900 }), null)
  assert.equal(slotToViewBounds({ x: 1430, y: 0, w: 300, h: 300 }, 1, { width: 1440, height: 900 }), null)
})

await test('presenter zoom: audience width parity, clamped', () => {
  assert.equal(presenterZoom(640, 1280), 0.5)
  assert.equal(presenterZoom(640, null), 0.5, 'default audience width 1280')
  assert.equal(presenterZoom(100, 1280), 0.25)
  assert.equal(presenterZoom(2000, 1280), 1)
})

await test('request schemes, user agent, state script', () => {
  assert.equal(livePageRequestScheme('https://a.example/'), 'web')
  assert.equal(livePageRequestScheme('wss://a.example/'), 'web')
  assert.equal(livePageRequestScheme('data:image/png;base64,AA'), 'pass')
  for (const bad of ['file:///etc/hosts', 'twasset://x', 'twpresent://x', 'chrome://gpu', 'devtools://x', 'mailto:a@b', 'zoommtg://x', 'nonsense', 7]) assert.equal(livePageRequestScheme(bad), 'cancel', String(bad))
  assert.equal(livePageUserAgent('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) talk-weaver/0.42.0 Chrome/140.0 Electron/42.11.16 Safari/537.36'),
    'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36')
  const script = livePageStateScript({ v: 1, slideId: 's', state: 'failed', host: 'h', message: '</script><img src=x onerror=alert(1)>"\'`${x}' })
  assert.ok(!script.includes('</script>'))
  let got = null
  // Evaluate as the deck would: the argument is a string the deck parses itself.
  new Function('window', script)({ __twLivePageState: (json) => { got = JSON.parse(json) } })
  assert.equal(got.message, '</script><img src=x onerror=alert(1)>"\'`${x}')
  assert.equal(got.state, 'failed')
})

await test('local-address rule: the live-page mode treats the page itself as embedded; the default mode is unchanged', async () => {
  const run = (opts, details) => new Promise((resolve) => localAddressRequestListener({ resolveHost: async (h) => h === 'rebind.example' ? ['127.0.0.1'] : ['93.184.216.34'], log: () => {}, ...opts })(details, resolve))
  const mainFrame = { url: 'http://127.0.0.1:8080/', resourceType: 'mainFrame', frame: { parent: null }, webContentsId: 1 }
  assert.deepEqual(await run({}, mainFrame), {}, 'default session: a window\'s own page may reach loopback (dev server, app pages)')
  assert.deepEqual(await run({ everyRequestIsEmbedded: true }, mainFrame), { cancel: true })
  assert.deepEqual(await run({ everyRequestIsEmbedded: true }, { ...mainFrame, url: 'http://rebind.example/' }), { cancel: true }, 'a name resolving to loopback')
  assert.deepEqual(await run({ everyRequestIsEmbedded: true }, { ...mainFrame, url: 'https://example.com/' }), {})
  assert.equal(decideLocalRequest({ url: 'http://127.0.0.1/', requester: 'main-frame' }), 'allow', 'decideLocalRequest itself is unchanged')
})

await test('live-page session request rule: schemes, local addresses, the test fixture', async () => {
  const allowance = testLoopbackAllowance({ isPackaged: false, e2e: true, value: '127.0.0.1:5000' })
  const listener = livePageRequestListener({ allowance, resolveHost: async (h) => h === 'rebind.example' ? ['10.0.0.5'] : ['93.184.216.34'], log: () => {} })
  const ask = (url, extra = {}) => new Promise((resolve) => listener({ url, resourceType: 'mainFrame', frame: { parent: null }, webContentsId: 9, ...extra }, resolve))
  assert.deepEqual(await ask('https://example.com/'), {})
  assert.deepEqual(await ask('data:text/plain,x'), {})
  assert.deepEqual(await ask('file:///etc/hosts'), { cancel: true })
  assert.deepEqual(await ask('twasset://img-1/x.png'), { cancel: true })
  assert.deepEqual(await ask('http://192.168.1.1/'), { cancel: true })
  assert.deepEqual(await ask('http://localhost/'), { cancel: true })
  assert.deepEqual(await ask('http://rebind.example/'), { cancel: true })
  assert.deepEqual(await ask('http://127.0.0.1:5000/fixture'), {}, 'the test fixture, under the e2e gate only')
  assert.deepEqual(await ask('http://127.0.0.1:5001/'), { cancel: true })
  const none = livePageRequestListener({ allowance: testLoopbackAllowance({ isPackaged: true, e2e: true, value: '127.0.0.1:5000' }), resolveHost: async () => [], log: () => {} })
  assert.deepEqual(await new Promise((r) => none({ url: 'http://127.0.0.1:5000/', resourceType: 'mainFrame' }, r)), { cancel: true }, 'packaged: no fixture')
})

function fakeContents(id, url = '') {
  const listeners = new Map()
  return {
    id, url, opened: [],
    on(event, fn) { listeners.set(event, [...(listeners.get(event) ?? []), fn]); return this },
    getURL() { return this.url },
    emit(event, ...args) { for (const fn of listeners.get(event) ?? []) fn(...args) },
    count(event) { return (listeners.get(event) ?? []).length }
  }
}
const navEvent = (url, extra = {}) => ({ url, prevented: false, preventDefault() { this.prevented = true }, ...extra })

await test('app-wide guard: a live view\'s main frame is left to its own guard and nothing is handed to the OS; other windows unchanged', () => {
  const opened = []
  const live = new Set([77])
  const opts = { openExternal: (u) => { opened.push(u) }, log: () => {}, isLivePageContents: (c) => live.has(c?.id) }
  const view = fakeContents(77, 'https://example.org/')
  guardWebContents(view, opts)
  view.emit('did-navigate')
  let e = navEvent('https://other.example/'); view.emit('will-navigate', e, e.url); assert.equal(e.prevented, false); assert.deepEqual(opened, [])
  e = navEvent('https://other.example/'); view.emit('will-redirect', e, e.url); assert.equal(e.prevented, false)
  e = navEvent('file:///etc/hosts', { isMainFrame: false, frame: { parent: {} } }); view.emit('will-frame-navigate', e); assert.equal(e.prevented, true, 'the frame rule still holds inside a live view')
  const deck = fakeContents(5, 'file:///deck.html?presenter=1')
  guardWebContents(deck, opts)
  deck.emit('did-navigate')
  e = navEvent('https://other.example/'); deck.emit('will-navigate', e, e.url); assert.equal(e.prevented, true); assert.deepEqual(opened, ['https://other.example/'], 'a deck window still hands web links to the browser')
})

function fakeSession() {
  const s = {
    handlers: {}, events: new Map(), ua: '', cleared: 0, filter: null,
    setPermissionRequestHandler(h) { s.handlers.request = h },
    setPermissionCheckHandler(h) { s.handlers.check = h },
    setDevicePermissionHandler(h) { s.handlers.device = h },
    setDisplayMediaRequestHandler(h) { s.handlers.display = h },
    on(event, fn) { s.events.set(event, fn) },
    webRequest: { onBeforeRequest(filter, fn) { s.filter = { filter, fn } } },
    resolveHost: async () => ({ endpoints: [{ address: '93.184.216.34' }] }),
    setUserAgent(ua) { s.ua = ua },
    clearStorageData: async () => { s.cleared++ },
    clearCache: async () => { s.cleared++ },
    protocol: { isProtocolHandled: () => false }
  }
  return s
}

await test('session hardening: every permission, device, capture and download refused; all requests filtered; app UA tokens gone', async () => {
  const s = fakeSession()
  hardenLivePageSession(s, { allowance: new Set(), userAgent: 'Mozilla/5.0 talk-weaver/1 Chrome/1 Electron/42 Safari/1', log: () => {} })
  for (const permission of ['openExternal', 'media', 'notifications', 'geolocation', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'display-capture', 'midi', 'pointerLock']) {
    let granted = null; s.handlers.request(null, permission, (g) => { granted = g }); assert.equal(granted, false, permission)
  }
  assert.equal(s.handlers.check(), false)
  assert.equal(s.handlers.device(), false)
  let streams = null; s.handlers.display({}, (x) => { streams = x }); assert.deepEqual(streams, {})
  for (const ev of ['select-hid-device', 'select-serial-port', 'select-usb-device', 'will-download']) {
    const e = navEvent(''); let called = false
    s.events.get(ev)(e, {}, () => { called = true })
    assert.equal(e.prevented, true, ev)
    if (ev !== 'will-download') assert.equal(called, true, `${ev} answered with no device`)
  }
  assert.deepEqual(s.filter.filter, { urls: ['<all_urls>'] })
  assert.equal(s.ua, 'Mozilla/5.0 Chrome/1 Safari/1')
  const prefs = livePageWebPreferences(s, false)
  assert.equal(prefs.nodeIntegrationInSubFrames, false); assert.equal(prefs.nodeIntegrationInWorker, false)
  assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.nodeIntegration, false)
  assert.equal(prefs.disableDialogs, true); assert.equal(prefs.webviewTag, false); assert.equal(prefs.webSecurity, true)
  for (const key of ['preload', 'additionalArguments', 'enableBlinkFeatures', 'partition']) assert.equal(key in prefs, false, key)
})

// --- host lifecycle with fakes ------------------------------------------------------------------
function fakeTimers() {
  const intervals = new Map(); const timeouts = new Map(); let n = 0
  return {
    intervals, timeouts,
    setInterval(fn, ms) { n++; intervals.set(n, { fn, ms }); return n },
    clearInterval(h) { intervals.delete(h) },
    setTimeout(fn, ms) { n++; timeouts.set(n, { fn, ms }); return n },
    clearTimeout(h) { timeouts.delete(h) },
    async tick(ms) { for (const [, t] of [...intervals]) if (t.ms === ms) t.fn(); await flush(); await flush() }
  }
}
let nextId = 1000
/** A view's debugger for Entire page captures: a 1280×3000 page; `gate` holds the screenshot back. */
function fakeCdp() {
  const jpeg = (w, h) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 8, h >> 8, h & 255, w >> 8, w & 255, 3, ...new Array(12).fill(0)]).toString('base64')
  const d = {
    attached: false, gate: null, commands: [], pageHeight: 3000, onShot: null,
    isAttached() { return d.attached }, attach() { d.attached = true }, detach() { d.attached = false },
    async sendCommand(method, params) {
      d.commands.push(method)
      if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { clientWidth: 1280 }, cssContentSize: { width: 1280, height: d.pageHeight }, contentSize: { width: 2560, height: d.pageHeight * 2 } }
      if (d.gate) await d.gate
      if (d.onShot) d.onShot()
      const c = params.clip
      return { data: jpeg(Math.round(c.width * c.scale * 2), Math.round(c.height * c.scale * 2)) }
    }
  }
  return d
}
function fakeView(log) {
  const wc = fakeContents(++nextId)
  Object.assign(wc, {
    destroyed: false, zoom: 1, muted: false, focused: 0, scripts: [], loads: [], openHandler: null,
    isDestroyed() { return this.destroyed },
    loadURL(u) { this.loads.push(u); this.url = u; return Promise.resolve() },
    focus() { this.focused++ },
    close() { this.destroyed = true },
    setWindowOpenHandler(h) { this.openHandler = h },
    setAudioMuted(m) { this.muted = m },
    setIgnoreMenuShortcuts() {},
    setZoomFactor(z) { this.zoom = z },
    getZoomFactor() { return this.zoom },
    scrollAnswer: [0, 500, 0, 1000],
    captures: 0, picture: { tag: 'picture' }, pictureGate: null,
    debugger: fakeCdp(),
    capturePage() { this.captures++; return this.pictureGate ? this.pictureGate.then(() => this.picture) : Promise.resolve(this.picture) },
    executeJavaScriptInIsolatedWorld(world, scripts) { this.scripts.push({ world, code: scripts[0].code }); return Promise.resolve(scripts[0].code.includes('scrollTo(') ? undefined : this.scrollAnswer) }
  })
  const view = { webContents: wc, bounds: null, visible: null, setBounds(b) { this.bounds = b }, setVisible(v) { this.visible = v }, setBackgroundColor() {} }
  log.push(view)
  return view
}
function fakeDeck(id) {
  const wc = fakeContents(id, 'file:///deck.html?livepage=1')
  const deck = {
    destroyed: false, children: new Set(), closedFns: [], report: null, scripts: [], focused: 0,
    isDestroyed() { return this.destroyed },
    getContentBounds() { return { x: 0, y: 0, width: 1440, height: 900 } },
    contentView: { addChildView: (v) => deck.children.add(v), removeChildView: (v) => deck.children.delete(v) },
    webContents: Object.assign(wc, {
      isDestroyed: () => deck.destroyed,
      executeJavaScript(code) { if (code === SLOT_SCRIPT) return Promise.resolve(deck.report); deck.scripts.push(code); return Promise.resolve() },
      focus() { deck.focused++ },
      getZoomFactor: () => 1,
      removeListener() {}
    }),
    once(event, fn) { if (event === 'closed') this.closedFns.push(fn) },
    close() { this.destroyed = true; for (const fn of this.closedFns) fn() }
  }
  return deck
}
function makeHost(deck, role, timers, views, sessions, capture) {
  return createLivePageHost(deck, role, {
    createView: () => fakeView(views), sessionFor: (p) => { const s = fakeSession(); sessions.push({ p, s }); return s },
    allowance: new Set(), devTools: false, userAgent: 'UA Electron/1', newId: () => `id${sessions.length}`, log: () => {}, timers,
    ...(capture ? { capture } : {})
  })
}

await test('host lifecycle: create on a visible report, show after paint, hide when covered, close when the slide is left', async () => {
  const timers = fakeTimers(); const views = []; const sessions = []
  const deck = fakeDeck(1)
  const host = makeHost(deck, 'presenter', timers, views, sessions)
  await timers.tick(100)
  assert.equal(views.length, 0, 'no report: no view')
  deck.report = report({ visible: false })
  await timers.tick(100)
  assert.equal(views.length, 0, 'a hidden slot creates nothing')
  deck.report = report()
  await timers.tick(100)
  assert.equal(views.length, 1)
  const [v] = views
  assert.ok(isLivePageContents(v.webContents), 'registered for the app-wide guard')
  assert.equal(sessions.length, 1); assert.match(sessions[0].p, /^tw-live-page:presenter:/)
  assert.deepEqual(v.webContents.loads, ['https://example.com/'])
  assert.equal(v.webContents.muted, true, 'presenter copy muted')
  assert.equal(v.visible, false, 'hidden until first paint')
  assert.equal(v.webContents.openHandler({ url: 'https://x/' }).action, 'deny')
  v.webContents.emit('dom-ready')
  await timers.tick(100)
  assert.equal(v.visible, true)
  assert.deepEqual(v.bounds, { x: 10, y: 20, width: 800, height: 450 })
  assert.ok(deck.scripts.some((c) => c.includes('__twLivePageState') && c.includes('\\"live\\"')), 'state pushed to the deck')
  deck.report = report({ visible: false })
  await timers.tick(100)
  assert.equal(v.visible, false, 'covered by an overlay: hidden, kept')
  assert.ok(isLivePageContents(v.webContents))
  deck.report = null
  await timers.tick(100)
  assert.equal(v.webContents.destroyed, true, 'left the slide: closed')
  assert.equal(isLivePageContents(v.webContents), false)
  assert.equal(deck.children.size, 0)
  host.dispose()
})

await test('host navigation guard: redirects and links to local or non-web addresses refused; web links kept in the view', async () => {
  const timers = fakeTimers(); const views = []; const sessions = []
  const deck = fakeDeck(2)
  makeHost(deck, 'presenter', timers, views, sessions)
  deck.report = report()
  await timers.tick(100)
  const wc = views[0].webContents
  for (const [event, url] of [['will-redirect', 'http://localhost/'], ['will-redirect', 'http://192.168.1.1/'], ['will-navigate', 'file:///etc/hosts'], ['will-navigate', 'mailto:a@b.c'], ['will-navigate', 'twasset://x'], ['will-navigate', 'chrome://settings'], ['will-frame-navigate', 'javascript:alert(1)']]) {
    const e = navEvent(url, { isMainFrame: true }); wc.emit(event, e, url); assert.equal(e.prevented, true, `${event} ${url}`)
  }
  assert.ok(deck.scripts.some((c) => c.includes('blocked')), 'a blocked first load is reported')
  const ok = navEvent('https://elsewhere.example/page', { isMainFrame: true }); wc.emit('will-navigate', ok, ok.url); assert.equal(ok.prevented, false)
  const sub = navEvent('http://localhost/', { isMainFrame: false }); wc.emit('will-frame-navigate', sub); assert.equal(sub.prevented, false, 'subframes: Chromium + session filter')
  const unload = navEvent(''); wc.emit('will-prevent-unload', unload); assert.equal(unload.prevented, true)
  disposeAllLivePageHosts()
})

await test('host: a refused report address closes the view and reports blocked; failures hide the view', async () => {
  const timers = fakeTimers(); const views = []; const sessions = []
  const deck = fakeDeck(3)
  makeHost(deck, 'audience', timers, views, sessions)
  deck.report = report({ url: 'http://192.168.1.1/' })
  await timers.tick(100)
  assert.equal(views.length, 0)
  assert.ok(deck.scripts.some((c) => c.includes('blocked')))
  deck.report = report()
  await timers.tick(100)
  const v = views[0]
  assert.equal(v.webContents.muted, false, 'audience plays sound')
  v.webContents.emit('dom-ready'); await timers.tick(100)
  assert.equal(v.visible, true)
  v.webContents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://example.com/', true)
  await timers.tick(100)
  assert.equal(v.visible, false)
  assert.ok(deck.scripts.some((c) => c.includes('ERR_NAME_NOT_RESOLVED')))
  v.webContents.emit('render-process-gone')
  assert.equal(v.webContents.destroyed, true)
  // Reload recreates.
  deck.report = report({ reloadSeq: 1 })
  await timers.tick(100)
  assert.equal(views.length, 2)
  disposeAllLivePageHosts()
})

await test('host: a crashed or unresponsive page stays closed until Reload or the slide is left (no automatic reopen)', async () => {
  for (const event of ['render-process-gone', 'unresponsive']) {
    const timers = fakeTimers(); const views = []; const sessions = []
    const deck = fakeDeck(event === 'unresponsive' ? 31 : 30)
    const host = makeHost(deck, 'presenter', timers, views, sessions)
    deck.report = report()
    await timers.tick(100)
    views[0].webContents.emit('dom-ready')
    views[0].webContents.emit(event)
    assert.equal(views[0].webContents.destroyed, true, `${event}: the view is closed`)
    for (let i = 0; i < 5; i++) await timers.tick(100)
    assert.equal(views.length, 1, `${event}: unchanged reports create no replacement`)
    assert.equal(livePageViewCount(), 0, `${event}: no view registered while failed`)
    assert.ok(deck.scripts.some((c) => c.includes('Reload to try again')), `${event}: the failure stays shown`)
    deck.report = report({ visible: false }); await timers.tick(100)
    deck.report = report(); await timers.tick(100)
    assert.equal(views.length, 1, `${event}: covering and uncovering is not a reload`)
    deck.report = report({ reloadSeq: 1 })
    for (let i = 0; i < 3; i++) await timers.tick(100)
    assert.equal(views.length, 2, `${event}: Reload creates exactly one replacement`)
    views[1].webContents.emit(event)
    for (let i = 0; i < 3; i++) await timers.tick(100)
    assert.equal(views.length, 2, `${event}: a second failure latches again`)
    deck.report = null; await timers.tick(100)
    deck.report = report({ reloadSeq: 1 }); await timers.tick(100)
    assert.equal(views.length, 3, `${event}: leaving the slide and coming back opens it again`)
    views[2].webContents.emit(event)
    deck.report = report({ reloadSeq: 1, url: 'https://other.example/', slideId: 's2' }); await timers.tick(100)
    assert.equal(views.length, 4, `${event}: another page opens`)
    views[3].webContents.emit(event)
    deck.report = report({ reloadSeq: 1, url: 'https://other.example/', slideId: 's3' }); await timers.tick(100)
    assert.equal(views.length, 5, `${event}: another slide with the same URL opens`)
    host.dispose()
    assert.equal(timers.intervals.size, 0)
  }
})

await test('host: reload, another address, deck reload and window close', async () => {
  const timers = fakeTimers(); const views = []; const sessions = []
  const deck = fakeDeck(4)
  makeHost(deck, 'window', timers, views, sessions)
  deck.report = report()
  await timers.tick(100)
  const v = views[0]
  v.webContents.emit('dom-ready')
  deck.report = report({ reloadSeq: 1 })
  await timers.tick(100)
  assert.deepEqual(v.webContents.loads, ['https://example.com/', 'https://example.com/'])
  deck.report = report({ url: 'https://other.example/', slideId: 's2' })
  await timers.tick(100)
  assert.equal(v.webContents.destroyed, true)
  assert.equal(views.length, 2)
  assert.deepEqual(views[1].webContents.loads, ['https://other.example/'])
  deck.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  assert.equal(views[1].webContents.destroyed, true, 'the deck reloaded: the view goes')
  deck.report = report()
  await timers.tick(100)
  assert.equal(views.length, 3)
  const before = livePageViewCount()
  deck.close()
  assert.equal(views[2].webContents.destroyed, true)
  assert.equal(livePageViewCount(), before - 1)
  assert.ok(sessions.every(({ s }) => s.cleared >= 2), 'partition cleared on dispose')
  assert.equal(timers.intervals.size, 0, 'no poll left running')
})

await test('host keys: focus bounces to the deck until Interact; Esc in the view returns; the audience view never keeps keys', async () => {
  const timers = fakeTimers(); const views = []; const sessions = []
  const deck = fakeDeck(5)
  makeHost(deck, 'presenter', timers, views, sessions)
  deck.report = report()
  await timers.tick(100)
  const wc = views[0].webContents
  wc.emit('focus')
  assert.equal(deck.focused, 1, 'not interacting: focus goes back to the deck')
  const arrow = navEvent(''); wc.emit('before-input-event', arrow, { type: 'keyDown', key: 'ArrowRight' })
  assert.equal(arrow.prevented, true)
  deck.report = report({ interact: true })
  await timers.tick(100)
  assert.equal(wc.focused, 1, 'Interact focuses the view')
  wc.emit('focus')
  assert.equal(deck.focused, 2, 'unchanged: interacting keeps focus in the view')
  const key = navEvent(''); wc.emit('before-input-event', key, { type: 'keyDown', key: 'ArrowDown' })
  assert.equal(key.prevented, false, 'interacting: keys reach the page')
  const esc = navEvent(''); wc.emit('before-input-event', esc, { type: 'keyDown', key: 'Escape' })
  assert.equal(esc.prevented, true)
  assert.equal(deck.focused, 3)
  assert.ok(deck.scripts.includes(INTERACT_OFF_SCRIPT), 'the deck is told Interact ended')
  const aDeck = fakeDeck(6)
  makeHost(aDeck, 'audience', timers, views, sessions)
  aDeck.report = report()
  await timers.tick(100)
  const awc = views[1].webContents
  const k = navEvent(''); awc.emit('before-input-event', k, { type: 'keyDown', key: 'ArrowRight' })
  assert.equal(k.prevented, true)
  awc.emit('focus'); assert.equal(aDeck.focused >= 1, true)
  disposeAllLivePageHosts()
})

await test('pairing: audience follows presenter scroll (isolated world, numbers only), navigation and zoom parity', async () => {
  const timers = fakeTimers(); const views = []; const sessions = []
  const pDeck = fakeDeck(7); const aDeck = fakeDeck(8)
  const p = makeHost(pDeck, 'presenter', timers, views, sessions)
  const a = makeHost(aDeck, 'audience', timers, views, sessions)
  const unpair = pairLivePageHosts(p, a)
  aDeck.report = report({ rect: { x: 0, y: 0, w: 1280, h: 720 }, layoutWidth: 1280 })
  pDeck.report = report({ rect: { x: 0, y: 0, w: 640, h: 360 } })
  await timers.tick(100)
  const [pv, av] = views[0].webContents.id < views[1].webContents.id && views[0].bounds?.width === 640 ? [views[0], views[1]] : [views.find((v) => v.webContents.muted), views.find((v) => !v.webContents.muted)]
  pv.webContents.emit('dom-ready'); av.webContents.emit('dom-ready')
  await timers.tick(100)
  assert.equal(pv.webContents.zoom, 0.5, 'presenter laid out at the audience width')
  assert.equal(av.webContents.zoom, 1)
  assert.notEqual(sessions[0].p, sessions[1].p, 'separate partitions per role')
  await timers.tick(200)
  const set = av.webContents.scripts.find((s) => s.code.includes('scrollTo('))
  assert.ok(set, 'audience scrolled')
  assert.equal(set.world, LIVE_PAGE_WORLD_ID)
  assert.match(set.code, /0\.00000 \*.*0\.50000 \*/)
  assert.ok(pv.webContents.scripts.every((s) => s.world === LIVE_PAGE_WORLD_ID))
  pv.webContents.scrollAnswer = ['bad', 1, 2, 3]
  const count = av.webContents.scripts.length
  await timers.tick(200)
  assert.equal(av.webContents.scripts.length, count, 'a page answering anything but numbers moves nothing')
  pv.webContents.url = 'https://example.com/next'
  pv.webContents.emit('did-navigate', {}, 'https://example.com/next', 200)
  assert.equal(av.webContents.loads.at(-1), 'https://example.com/next', 'presenter link followed')
  pv.webContents.emit('did-navigate', {}, 'http://localhost/', 200)
  assert.notEqual(av.webContents.loads.at(-1), 'http://localhost/', 'never a refused address')
  pv.webContents.emit('did-navigate-in-page', {}, 'https://example.com/next#part', true)
  assert.equal(av.webContents.loads.at(-1), 'https://example.com/next#part')
  unpair()
  disposeAllLivePageHosts()
  assert.equal(livePageViewCount(), 0)
})

await test('capture: a slide written with a bare site address (no slash), Interact on — the press saves (owner bug alpha.14)', async () => {
  // The deck reports the address as written (`https://example.com`); main's view is keyed by its
  // normalised form (`https://example.com/`). Every press was dropped as "changed while capturing".
  const timers = fakeTimers(); const views = []; const sessions = []
  const saved = []
  const capture = {
    encode: () => ({ jpeg: new Uint8Array([0xff, 0xd8, 0xff, 1]), width: 2, height: 2 }),
    save: async (request) => { saved.push(request); return { ok: true, capturedAt: '2026-10-27T10:00:00.000Z', count: saved.length, how: 'written' } }
  }
  const deck = fakeDeck(31)
  makeHost(deck, 'presenter', timers, views, sessions, capture)
  const bare = (over) => report({ url: 'https://example.com', gallery: { on: false, index: 0 }, ...over })
  deck.report = bare({ captureSeq: 0 }); await timers.tick(100)
  views[0].webContents.emit('dom-ready'); await timers.tick(100)
  deck.report = bare({ captureSeq: 0, interact: true }); await timers.tick(100)
  deck.report = bare({ captureSeq: 1, interact: true }); await timers.tick(100); await flush(); await flush()
  assert.equal(saved.length, 1, 'saved')
  assert.equal(saved[0].pageUrl, 'https://example.com/')
  assert.equal(saved[0].isCurrent(), true)
  assert.ok(deck.scripts.some((c) => c.includes('Saved this view')))
  // Still stale-checked: the slide changes to another bare address while the picture is taken.
  let release
  views[0].webContents.pictureGate = new Promise((r) => { release = r })
  deck.report = bare({ captureSeq: 2, interact: true }); await timers.tick(100)
  deck.report = bare({ captureSeq: 2, slideId: 's2', url: 'https://example.org' }); await timers.tick(100)
  release(); await flush(); await flush(); await flush()
  assert.equal(saved.length, 1, 'another slide: dropped')
  disposeAllLivePageHosts()
})

await test('capture: any navigation of the source view while capturing (new page, same-address reload, in-page move, audience saved view) drops it; re-checked before the write', async () => {
  // Independent review 2026-10-27, P2 (probe-independent-capture-navigation.mjs): a navigation during
  // capturePage() left the generation unchanged and the old address was saved with the new picture.
  const timers = fakeTimers(); const views = []; const sessions = []
  const saved = []
  let saveGate = null
  const capture = {
    encode: (picture) => (picture && picture.tag === 'picture' ? { jpeg: new Uint8Array([0xff, 0xd8, 0xff, 1]), width: 2, height: 2 } : null),
    save: async (request) => { saved.push({ request, currentAtSave: request.isCurrent ? request.isCurrent() : 'none' }); if (saveGate) await saveGate; return { ok: true, capturedAt: '2026-10-27T10:00:00.000Z', count: saved.length, how: 'written' } }
  }
  const deck = fakeDeck(21)
  makeHost(deck, 'presenter', timers, views, sessions, capture)
  let seq = 0
  deck.report = report({ captureSeq: seq, gallery: { on: false, index: 0 } }); await timers.tick(100)
  const wc = views[0].webContents
  wc.emit('dom-ready'); await timers.tick(100)
  const during = async (move) => {
    let release
    wc.pictureGate = new Promise((r) => { release = r })
    deck.report = report({ captureSeq: ++seq, gallery: { on: false, index: 0 } }); await timers.tick(100)
    move()
    release(); await flush(); await flush(); await flush()
    wc.pictureGate = null
  }
  await during(() => { wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }); wc.url = 'https://example.com/changed-after-press'; wc.emit('did-navigate', {}, wc.url, 200) })
  assert.equal(saved.length, 0, 'another page: dropped (the reviewer\'s reproduction)')
  wc.url = 'https://example.com/'
  await during(() => { wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }); wc.emit('did-navigate', {}, wc.url, 200) })
  assert.equal(saved.length, 0, 'the same address reloaded: dropped')
  await during(() => { wc.emit('did-navigate-in-page', {}, 'https://example.com/#part', true) })
  assert.equal(saved.length, 0, 'an in-page move: dropped')
  await during(() => { wc.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false }) })
  assert.equal(saved.length, 1, 'a frame inside the page is not the page navigating')
  assert.equal(saved[0].currentAtSave, true)
  // A press handed to the writer is re-checked there (the saver calls isCurrent right before the write).
  let releaseSave
  saveGate = new Promise((r) => { releaseSave = r })
  deck.report = report({ captureSeq: ++seq, gallery: { on: false, index: 0 } }); await timers.tick(100); await flush(); await flush()
  assert.equal(saved.length, 2)
  assert.equal(saved[1].request.isCurrent(), true)
  wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  assert.equal(saved[1].request.isCurrent(), false, 'a reload after the picture, before the write: no longer current')
  releaseSave(); await flush(); saveGate = null
  assert.ok(deck.scripts.filter((c) => c.includes('changed while capturing')).length >= 3, 'each dropped press is told')
  disposeAllLivePageHosts()

  // Paired: the audience copy (the source) navigates, or shows a saved view, while being captured.
  const pDeck = fakeDeck(22); const aDeck = fakeDeck(23)
  const pv0 = views.length
  const p = makeHost(pDeck, 'presenter', timers, views, sessions, capture)
  const a = makeHost(aDeck, 'audience', timers, views, sessions, capture)
  const unpair = pairLivePageHosts(p, a)
  saved.length = 0
  aDeck.report = report({ rect: { x: 0, y: 0, w: 1280, h: 720 }, layoutWidth: 1280, captureSeq: 0, gallery: { on: false, index: 0 } })
  pDeck.report = report({ rect: { x: 0, y: 0, w: 640, h: 360 }, captureSeq: 0, gallery: { on: false, index: 0 } })
  await timers.tick(100)
  const fresh = views.slice(pv0)
  const pv = fresh.find((v) => v.webContents.muted); const av = fresh.find((v) => !v.webContents.muted)
  pv.webContents.emit('dom-ready'); av.webContents.emit('dom-ready'); await timers.tick(100)
  let release
  av.webContents.pictureGate = new Promise((r) => { release = r })
  pDeck.report = report({ rect: { x: 0, y: 0, w: 640, h: 360 }, captureSeq: 1, gallery: { on: false, index: 0 } }); await timers.tick(100)
  av.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }); av.webContents.emit('did-navigate', {}, 'https://example.com/', 200)
  release(); await flush(); await flush(); await flush()
  assert.equal(av.webContents.captures, 1)
  assert.equal(saved.length, 0, 'the audience copy reloaded while captured: dropped')
  av.webContents.pictureGate = new Promise((r) => { release = r })
  pDeck.report = report({ rect: { x: 0, y: 0, w: 640, h: 360 }, captureSeq: 2, gallery: { on: false, index: 0 } }); await timers.tick(100)
  a._setGallery({ on: true, index: 0 }, 'https://example.com/')
  release(); await flush(); await flush(); await flush()
  assert.equal(saved.length, 0, 'the audience copy showing a saved view while captured: dropped')
  unpair()
  disposeAllLivePageHosts()
})

await test('capture gallery: only the deck\'s own Capture press saves; from the audience copy; stale views dropped; gallery passed on', async () => {
  const timers = fakeTimers(); const views = []; const sessions = []
  const saved = []
  const capture = {
    encode: (picture) => (picture && picture.tag === 'picture' ? { jpeg: new Uint8Array([0xff, 0xd8, 0xff, 1]), width: 1280, height: 720 } : null),
    save: async (request) => { saved.push(request); return { ok: true, capturedAt: '2026-10-27T10:00:00.000Z', count: saved.length, how: 'written' } }
  }
  const pDeck = fakeDeck(11); const aDeck = fakeDeck(12)
  const p = makeHost(pDeck, 'presenter', timers, views, sessions, capture)
  const a = makeHost(aDeck, 'audience', timers, views, sessions, capture)
  const unpair = pairLivePageHosts(p, a)
  const g = (on = false, index = 0) => ({ on, index })
  aDeck.report = report({ rect: { x: 0, y: 0, w: 1280, h: 720 }, layoutWidth: 1280, captureSeq: 0, gallery: g() })
  pDeck.report = report({ rect: { x: 0, y: 0, w: 640, h: 360 }, captureSeq: 5, gallery: g() })
  await timers.tick(100)
  const pv = views.find((v) => v.webContents.muted); const av = views.find((v) => !v.webContents.muted)
  pv.webContents.emit('dom-ready'); av.webContents.emit('dom-ready')
  await timers.tick(100)
  assert.equal(saved.length, 0, 'the first report\'s count is not a press')
  // The page itself has no way to press: a page event, a navigation or a scroll saves nothing.
  pv.webContents.emit('did-navigate', {}, 'https://example.com/', 200)
  await timers.tick(200)
  assert.equal(saved.length, 0)
  pDeck.report = report({ rect: { x: 0, y: 0, w: 640, h: 360 }, captureSeq: 6, gallery: g() })
  await timers.tick(100); await flush()
  assert.equal(saved.length, 1, 'one press, one save')
  assert.equal(av.webContents.captures, 1, 'taken from the audience copy (its own size)')
  assert.equal(pv.webContents.captures, 0)
  assert.equal(saved[0].source, 'audience')
  assert.deepEqual(saved[0].viewport, { w: 1280, h: 720, zoom: 1 })
  assert.equal(saved[0].pageUrl, 'https://example.com/')
  assert.ok(pDeck.scripts.some((c) => c.includes('__twLivePageCaptured') && c.includes('Saved this view')), 'presenter told')
  assert.ok(aDeck.scripts.some((c) => c.includes('__twLivePageCaptured') && c.includes('data:image/jpeg;base64,')), 'audience given the new view')
  await timers.tick(100)
  assert.equal(saved.length, 1, 'the same count again saves nothing')
  // Stale: the presenter leaves the slide while the picture is being taken: dropped, never saved.
  let release
  av.webContents.pictureGate = new Promise((r) => { release = r })
  pDeck.report = report({ rect: { x: 0, y: 0, w: 640, h: 360 }, captureSeq: 7, gallery: g() })
  await timers.tick(100)
  pDeck.report = report({ slideId: 's2', url: 'https://example.org/', rect: { x: 0, y: 0, w: 640, h: 360 }, captureSeq: 7, gallery: g() })
  await timers.tick(100)
  release(); await flush(); await flush()
  assert.equal(saved.length, 1, 'a view of a page no longer shown is dropped')
  assert.ok(pDeck.scripts.some((c) => c.includes('changed while capturing')))
  // Gallery: the presenter's choice reaches the audience deck (numbers and the checked address only).
  pDeck.report = report({ slideId: 's2', url: 'https://example.org/', rect: { x: 0, y: 0, w: 640, h: 360 }, captureSeq: 7, gallery: g(true, 2), visible: false })
  await timers.tick(100)
  const passedOn = aDeck.scripts.filter((c) => c.includes('__twLivePageGallery')).at(-1)
  assert.ok(passedOn && passedOn.includes('\\"on\\":true') && passedOn.includes('\\"index\\":2') && passedOn.includes('https://example.org/'), passedOn)
  // Without capture deps (a window main gave none): a press answers, nothing else.
  const lone = fakeDeck(13)
  makeHost(lone, 'presenter', timers, views, sessions)
  lone.report = report({ captureSeq: 0, gallery: g() }); await timers.tick(100)
  lone.report = report({ captureSeq: 1, gallery: g() }); await timers.tick(100); await flush()
  assert.ok(lone.scripts.some((c) => c.includes('__twLivePageCaptured') && c.includes('\\"ok\\":false')))
  unpair()
  disposeAllLivePageHosts()
  assert.equal(livePageViewCount(), 0)
})

await test('capture, entire page: the whole page saved (mode, size, cut when too tall); scroll put back; a navigation while capturing drops it', async () => {
  const timers = fakeTimers(); const views = []; const sessions = []
  const saved = []
  const capture = {
    encode: () => { throw new Error('the visible-view encoder is not used for an entire page') },
    save: async (request) => { saved.push(request); return { ok: true, capturedAt: '2026-10-27T10:00:00.000Z', count: saved.length, how: 'written', onSlide: true } }
  }
  const deck = fakeDeck(41)
  makeHost(deck, 'presenter', timers, views, sessions, capture)
  let seq = 0
  const page = (over) => report({ captureSeq: seq, gallery: { on: false, index: 0 }, captureMode: 'page', interact: true, ...over })
  deck.report = page(); await timers.tick(100)
  const wc = views[0].webContents
  wc.emit('dom-ready'); await timers.tick(100)
  // The page scrolled itself while it was painted beyond the view: the scroll read before is put back.
  wc.scrollAnswer = [0, 500, 0, 1000]
  wc.debugger.onShot = () => { wc.scrollAnswer = [0, 900, 0, 1000] }
  seq++; deck.report = page(); await timers.tick(100); await flush(); await flush(); await flush()
  assert.equal(saved.length, 1, 'saved')
  assert.equal(wc.captures, 0, 'not the visible-view picture')
  assert.deepEqual([saved[0].mode, saved[0].width, saved[0].height, saved[0].truncated], ['page', 1920, 4500, undefined])
  assert.deepEqual([saved[0].viewport.w, saved[0].viewport.h], [1280, 3000], 'the page in CSS pixels')
  assert.equal(wc.debugger.attached, false, 'debugger detached')
  const restores = wc.scripts.filter((s) => s.code.includes('scrollTo('))
  assert.equal(restores.length, 1, 'scroll put back once')
  assert.equal(restores[0].world, LIVE_PAGE_WORLD_ID)
  assert.ok(deck.scripts.some((c) => c.includes('Saved the entire page and added it to the slide.')))
  // An unmoved scroll is left alone.
  wc.debugger.onShot = null; wc.scrollAnswer = [0, 500, 0, 1000]
  seq++; deck.report = page(); await timers.tick(100); await flush(); await flush(); await flush()
  assert.equal(saved.length, 2)
  assert.equal(wc.scripts.filter((s) => s.code.includes('scrollTo(')).length, 1, 'no scroll written when it did not move')
  // Too tall: cut at the limit, and said so.
  wc.debugger.pageHeight = 40000
  seq++; deck.report = page(); await timers.tick(100); await flush(); await flush(); await flush()
  assert.equal(saved.length, 3); assert.equal(saved[2].truncated, true); assert.ok(saved[2].height <= 16384)
  assert.ok(deck.scripts.some((c) => c.includes('cut at the tallest picture kept')))
  wc.debugger.pageHeight = 3000
  // The page navigates while the entire page is painted: dropped, and the debugger still detached.
  let release
  wc.debugger.gate = new Promise((r) => { release = r })
  seq++; deck.report = page(); await timers.tick(100)
  wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }); wc.emit('did-navigate', {}, wc.url, 200)
  release(); await flush(); await flush(); await flush(); await flush()
  wc.debugger.gate = null
  assert.equal(saved.length, 3, 'a navigation while capturing: dropped')
  assert.equal(wc.debugger.attached, false)
  assert.ok(deck.scripts.some((c) => c.includes('changed while capturing')))
  // Developer tools open on the page: refused with its reason, nothing taken over.
  wc.debugger.attached = true
  seq++; deck.report = page(); await timers.tick(100); await flush(); await flush(); await flush()
  assert.equal(saved.length, 3)
  assert.equal(wc.debugger.attached, true, 'someone else\'s debugger session left attached')
  assert.ok(deck.scripts.some((c) => c.includes('Developer tools are open')))
  disposeAllLivePageHosts()
})

console.log(`live page: ${passed} passed`)
