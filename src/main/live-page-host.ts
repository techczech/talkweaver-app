// A live web page on a slide, shown in a deck window the app opened (presenter, audience, plain
// presentation window). Design: research/external-url-embed-2026-10-27/
// design-live-web-page-view-and-capture-gallery-2026-10-27.md (decisions D1–D12).
//
// The page is loaded as the TOP-LEVEL document of its own WebContentsView laid over an empty slot
// in the deck, the way a browser tab (or Simon Willison's Present, with WKWebView) shows it. So a
// site that refuses framing (frame-ancestors 'none', X-Frame-Options: DENY) still shows: framing
// rules govern frames only. No response header is read, stripped or rewritten. Ever.
//
// SECURITY BOUNDARY. The view shows another site's page; the app gives it nothing:
//   - no preload, no bridge, no IPC, no Node, sandboxed, context-isolated, dialogs disabled, no
//     webview tag, no plugins (webPreferences below);
//   - its own in-memory session per view role per deck window (`tw-live-page:<role>:<uuid>`, never
//     persisted): no cookie, permission, protocol handler or cache shared with the app's windows or
//     between the presenter's and the audience's copies; cleared when the deck window goes;
//   - that session refuses every permission, device, screen capture and download; only http(s),
//     ws(s), data: and blob: requests are let through, and none to a local address (the
//     local-address rule with every request treated as embedded, the page itself included);
//   - every main-frame address it goes to is checked (parseLivePageUrl): the first load (main only
//     ever calls loadURL with a checked address), every redirect hop and every later navigation;
//   - pop-ups are refused; nothing is ever handed to the OS from the view (no openExternal, no
//     openPath): the deck's own Open ↗ link is the one way out, under the deck's rules;
//   - the app-wide navigation guard leaves the view's main frame to this guard (isLivePageContents),
//     so a cross-origin link in the page is NOT sent to the default browser.
// Main reads the page's scroll position and sets the audience copy's, in an isolated world of its
// own, with fixed scripts and numbers only (remote-page-follow.ts READ_SCROLL / scrollToScript).
//
// The deck is the authority on WHERE the view goes: main polls the deck's own page (app-compiled
// HTML, its main world) every 100 ms for `window.__twLivePageSlot()` (validated, live-page-policy.ts)
// and tells it the page's state with `window.__twLivePageState(json)`. The deck reports the slot as
// not visible whenever anything of its own covers it (palette, help, menus, overview, blackout), so
// the view is hidden then. No IPC channel and no preload change: the audience window has neither.
//
// Freeze and mark (live-page-freeze.ts): the presenter deck's Pointer or Pen press on a live page arrives
// in the same polled report (`freeze`); main takes one picture of what the room sees, has every deck
// window that shows the page show it (`__twLivePageFrozen`, answered by the deck), and only then hides
// the views (they stay loaded: Live shows them again as they were). Nothing is written or uploaded.
//
// Accepted residual (as for the app's own local-address filter): a name whose address changes between
// the filter's lookup and Chromium's connection (DNS rebinding).
import {
  deckCallScript, hostPortOf, livePageRequestScheme, livePageStateScript, livePageUserAgent, parseLivePageUrl,
  presenterZoom, slotToViewBounds, validateSlotReport,
  type LivePageState, type LivePageStateName, type LoopbackAllowance, type SlotReport
} from './live-page-policy.ts'
import { localAddressRequestListener } from './local-address-filter.ts'
import { READ_SCROLL, scrollFraction, scrollToScript } from './remote-page-follow.ts'
import { captureWholePage, WHOLE_PAGE_TEXT, type CdpDebugger } from './live-page-whole-capture.ts'
import type { LivePageSavedViews } from './live-page-saved-views.ts'
import {
  FREEZE_TEXT, LIVE_PAGE_FREEZE_MAX_JPEG, LIVE_PAGE_FREEZE_MS, frozenAck, frozenCallScript, stillIdOf, withDeadline,
  type FrozenMessage
} from './live-page-freeze.ts'

/** After an Entire page capture: the page's scroll as it was before, if it moved (fixed numeric script, isolated world). */
async function restoreScroll(contents: ViewContents, before: { fx: number; fy: number }): Promise<void> {
  try {
    if (contents.isDestroyed()) return
    const now = scrollFraction(await contents.executeJavaScriptInIsolatedWorld(LIVE_PAGE_WORLD_ID, [{ code: READ_SCROLL }], false))
    if (now && Math.abs(now.fx - before.fx) < 0.001 && Math.abs(now.fy - before.fy) < 0.001) return
    await contents.executeJavaScriptInIsolatedWorld(LIVE_PAGE_WORLD_ID, [{ code: scrollToScript(before.fx, before.fy) }], false)
  } catch { /* the page went away: nothing to restore */ }
}

export type LivePageRole = 'presenter' | 'audience' | 'window'

export const LIVE_PAGE_POLL_MS = 100
export const LIVE_PAGE_FOLLOW_MS = 200
export const LIVE_PAGE_SLOW_MS = 20_000
/** The isolated world main reads and sets scroll positions in (never the page's own world). */
export const LIVE_PAGE_WORLD_ID = 1077
export const SLOT_SCRIPT = 'window.__twLivePageSlot ? window.__twLivePageSlot() : null'
export const INTERACT_OFF_SCRIPT = 'window.__twLivePageInteract && window.__twLivePageInteract(false)'

// ---------------------------------------------------------------------------------------------------
// Which webContents are live-page views (asked by the app-wide navigation guard).

const livePageContentsIds = new Set<number>()

export function isLivePageContents(contents: unknown): boolean {
  const id = (contents as { id?: unknown } | null | undefined)?.id
  return typeof id === 'number' && livePageContentsIds.has(id)
}

/** For the test: how many live-page views are open now. */
export function livePageViewCount(): number { return livePageContentsIds.size }

// ---------------------------------------------------------------------------------------------------
// The view's preferences and its session.

export function livePageWebPreferences(session: unknown, devTools: boolean): Record<string, unknown> {
  return {
    session,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    plugins: false,
    experimentalFeatures: false,
    navigateOnDragDrop: false,
    disableDialogs: true,
    spellcheck: false,
    disableHtmlFullscreenWindowResize: true,
    backgroundThrottling: false,
    devTools
    // no preload, no additionalArguments, no enableBlinkFeatures: nothing of the app reaches the page
  }
}

type RequestCallback = (response: { cancel?: boolean }) => void
type DeviceEvent = { preventDefault(): void }
export type LivePageSession = {
  setPermissionRequestHandler(handler: (wc: unknown, permission: string, callback: (granted: boolean) => void) => void): void
  setPermissionCheckHandler(handler: () => boolean): void
  setDevicePermissionHandler(handler: () => boolean): void
  setDisplayMediaRequestHandler(handler: (request: unknown, callback: (streams: Record<string, never>) => void) => void): void
  on(event: string, listener: (...args: any[]) => void): unknown
  webRequest: { onBeforeRequest(filter: { urls: string[] }, listener: (details: any, callback: RequestCallback) => void): void }
  resolveHost(host: string): Promise<{ endpoints: Array<{ address: string }> }>
  setUserAgent(ua: string): void
  clearStorageData(): Promise<void>
  clearCache(): Promise<void>
}

/**
 * The request rule for a live page's session: schemes other than http(s), ws(s), data: and blob:
 * are cancelled; a web request goes to the local-address rule with every request treated as made
 * from inside an embed (so the page itself, its redirects, fetches, pictures and sockets never
 * reach this Mac or the local network). `allowance`: the test-only loopback fixture, empty in a
 * packaged app.
 */
export function livePageRequestListener(opts: { allowance: LoopbackAllowance; resolveHost(host: string): Promise<readonly string[]>; log?: (m: string) => void }): (details: { url: string } & Record<string, unknown>, callback: RequestCallback) => void {
  const log = opts.log ?? console.warn
  const local = localAddressRequestListener({ resolveHost: opts.resolveHost, log, everyRequestIsEmbedded: true })
  return (details, callback) => {
    let kind: ReturnType<typeof livePageRequestScheme> = 'cancel'
    try { kind = livePageRequestScheme(details.url) } catch { kind = 'cancel' }
    if (kind === 'cancel') {
      log(`[live-page] refused a request to ${String(details.url).slice(0, 80).replace(/[?#].*$/, '')}: not a web address`)
      callback({ cancel: true }); return
    }
    if (kind === 'pass') { callback({}); return }
    try {
      if (opts.allowance.size && opts.allowance.has(hostPortOf(new URL(details.url)))) { callback({}); return }
    } catch { callback({ cancel: true }); return }
    local(details as never, callback)
  }
}

/** Once per partition, before its first load. */
export function hardenLivePageSession(session: LivePageSession, opts: { allowance: LoopbackAllowance; userAgent: string; log?: (m: string) => void }): void {
  const log = opts.log ?? console.warn
  session.setPermissionRequestHandler((_wc, permission, callback) => { log(`[live-page] refused permission ${String(permission).slice(0, 40)}`); callback(false) })
  session.setPermissionCheckHandler(() => false)
  session.setDevicePermissionHandler(() => false)
  session.setDisplayMediaRequestHandler((_request, callback) => callback({}))
  for (const event of ['select-hid-device', 'select-serial-port', 'select-usb-device']) {
    session.on(event, (e: DeviceEvent, _details: unknown, callback?: (id?: string) => void) => {
      try { e.preventDefault() } catch { /* ignore */ }
      try { callback?.() } catch { /* ignore */ }
    })
  }
  session.on('will-download', (e: DeviceEvent) => { e.preventDefault(); log('[live-page] refused a download') })
  const resolveHost = async (host: string): Promise<readonly string[]> => (await session.resolveHost(host)).endpoints.map((endpoint) => endpoint.address)
  session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, livePageRequestListener({ allowance: opts.allowance, resolveHost, log }))
  session.setUserAgent(livePageUserAgent(opts.userAgent))
}

// ---------------------------------------------------------------------------------------------------
// The host: at most one view per deck window.

type Listener = (...args: any[]) => void
export type ViewContents = {
  readonly id: number
  isDestroyed(): boolean
  loadURL(url: string): Promise<unknown>
  getURL(): string
  focus(): void
  close(): void
  on(event: string, listener: Listener): unknown
  setWindowOpenHandler(handler: (details: unknown) => { action: 'deny' }): void
  setAudioMuted(muted: boolean): void
  setIgnoreMenuShortcuts(ignore: boolean): void
  setZoomFactor(factor: number): void
  getZoomFactor(): number
  executeJavaScriptInIsolatedWorld(worldId: number, scripts: Array<{ code: string }>, userGesture?: boolean): Promise<unknown>
  /** The view's visible viewport as a picture (Electron NativeImage): used only for a saved view. */
  capturePage(): Promise<unknown>
  /** Chromium's DevTools protocol on this view (main only): used only for an Entire page saved view. */
  readonly debugger?: CdpDebugger
}
export type LiveView = {
  readonly webContents: ViewContents
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void
  setVisible(visible: boolean): void
  setBackgroundColor(color: string): void
}
export type DeckWindow = {
  isDestroyed(): boolean
  getContentBounds(): { width: number; height: number }
  contentView: { addChildView(view: LiveView): void; removeChildView(view: LiveView): void }
  webContents: {
    readonly id: number
    isDestroyed(): boolean
    executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>
    focus(): void
    getZoomFactor(): number
    on(event: string, listener: Listener): unknown
    removeListener(event: string, listener: Listener): unknown
  }
  once(event: 'closed', listener: () => void): unknown
}
export type Timers = { setInterval(fn: () => void, ms: number): unknown; clearInterval(handle: unknown): void; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }

/** What a saved view needs from main beyond the host (index.ts wires these to the deck's talk). */
export type LivePageCaptureDeps = {
  /** The picture as a JPEG of at most 1920 px wide, or null for an empty or unreadable picture. */
  encode(image: unknown): { jpeg: Uint8Array; width: number; height: number } | null
  /**
   * Save it with the talk this deck window presents (decided by main from the window, never from the
   * deck or the page). Resolves the writer's answer; never rejects.
   */
  save(request: LivePageCaptureRequest): Promise<LivePageCaptureResult>
  /**
   * The saved views the slide shows for the page, read from the talk's current text
   * (live-page-saved-views.ts); null when the slide or page is not in it now. Optional: without it
   * the deck shows its compiled views and the ones saved from it.
   */
  views?(slideId: string, pageUrl: string): Promise<LivePageSavedViews | null>
}
export type LivePageCaptureRequest = {
  pageUrl: string
  currentUrl: string | null
  slideId: string
  source: LivePageRole
  jpeg: Uint8Array
  width: number
  height: number
  viewport: { w: number; h: number; zoom: number }
  scroll: { fx: number; fy: number }
  /** Still the press's page, slide and source view: checked again right before the picture is written. */
  isCurrent?: () => boolean
  /** What was captured: the visible view (default) or the entire scrollable page as loaded; cut when taller than kept. */
  mode?: 'view' | 'page'
  truncated?: boolean
}
export type LivePageCaptureResult =
  | { ok: true; capturedAt: string; count: number; how: 'written' | 'reused'; image?: string; mode?: 'view' | 'page'; onSlide?: boolean; note?: string }
  | { ok: false; message: string }

export type LivePageHostDeps = {
  createView(webPreferences: Record<string, unknown>): LiveView
  sessionFor(partition: string): LivePageSession
  allowance: LoopbackAllowance
  devTools: boolean
  userAgent: string
  newId(): string
  log?: (m: string) => void
  timers?: Timers
  /** The capture gallery; without it Capture answers that saving is not available here. */
  capture?: LivePageCaptureDeps
}

export type LivePageHost = {
  readonly role: LivePageRole
  readonly deckId: number
  /** Presenter ↔ audience pairing (following and zoom parity); returns the unpair function. */
  pairWith(audience: LivePageHost): () => void
  /** For pairing and tests. */
  inspect(): { viewId: number | null; url: string; authored: string; state: LivePageStateName | null; visible: boolean; bounds: { x: number; y: number; width: number; height: number } | null; interact: boolean; zoom: number | null }
  /** Close the view (the deck reloaded or left the slide); the host keeps polling. */
  closeView(reason: string): void
  dispose(): void
  // used by the partner host
  _audienceWidth(): number | null
  _followNavigation(url: string): void
  _applyScroll(fx: number, fy: number, key: string): void
  _presenterUrlFor(authored: string): string | null
  _viewGeneration(): number
  _setPartner(partner: LivePageHost | null): void
  /** The audience copy shows the presenter's saved view (or the live page again). */
  _setGallery(gallery: { on: boolean; index: number }, url: string): void
  /** The audience's view of `authored`, ready to be captured (the audience's own size), or null. */
  _captureSource(authored: string, slideId?: string): { contents: ViewContents; bounds: { width: number; height: number }; generation: () => number } | null
  /** A saved view, added to this deck's gallery without a rebuild. */
  _addCapture(added: { url: string; src: string; capturedAt: string; mode?: 'view' | 'page' }): void
  /** For the test: whether a capture is being taken or saved now. */
  _capturing(): boolean
  /** For the test: the freeze (presenter) and whether this view is hidden for one. */
  _freezeState(): { phase: 'idle' | 'pending' | 'frozen'; id: string | null; frozen: boolean }
  /** Audience copy: shows the frozen picture; answers whether its deck showed exactly it. */
  _frozenShow(message: FrozenMessage): Promise<boolean>
  /** Audience copy: the frozen picture is gone (Live, failure, cancel). */
  _frozenClear(message: FrozenMessage): void
  /**
   * Audience copy: its view is hidden behind the frozen picture of `identity` (true; refused, false,
   * unless it still shows that slide and page) or shown again (false).
   */
  _setFrozen(on: boolean, identity?: { slideId: string; authored: string }): boolean
  /** Audience copy: whether its deck shows this slide's page now. */
  _showsPage(slideId: string, authored: string): boolean
  /** Presenter: the audience copy left the frozen slide or page, its deck reloaded or its view closed. */
  _audienceLost(): void
  /** The talk's text changed: tell the deck the saved views of the slide and page it shows now. */
  refreshSavedViews(): Promise<void>
}

const hosts = new Set<LivePageHost>()

/** Close every live page (app quit). */
export function disposeAllLivePageHosts(): void {
  for (const host of [...hosts]) host.dispose()
}

type ViewRecord = {
  view: LiveView
  contents: ViewContents
  id: number
  authored: string
  slideId: string
  painted: boolean
  state: LivePageStateName
  httpStatus?: number
  message?: string
  slowTimer: unknown
  visible: boolean
  bounds: { x: number; y: number; width: number; height: number } | null
  navigations: number
}

export function createLivePageHost(deck: DeckWindow, role: LivePageRole, deps: LivePageHostDeps): LivePageHost {
  const log = deps.log ?? console.warn
  const timers = deps.timers ?? (globalThis as unknown as Timers)
  const deckId = deck.webContents.id
  let disposed = false
  let polling = false
  let record: ViewRecord | null = null
  let session: LivePageSession | null = null
  let partition = ''
  let lastReloadSeq: number | null = null
  // A page whose renderer crashed or stopped responding stays closed (its failure shown) until the
  // person presses Reload, leaves the slide or the deck shows another page: never reopened by the poll.
  let failed: { url: string; slideId: string; reloadSeq: number } | null = null
  let interact = false
  let lastStateKey = ''
  let lastReport: SlotReport | null = null
  let generation = 0
  // What the view shows, counted: any main-frame navigation (a new document, the same address reloaded,
  // an in-page move), a failed load, a new or closed view, the view hidden or shown. A capture is for
  // ONE value of it, on its source view, from the press until the writer is handed the picture.
  let viewSerial = 0
  let partner: LivePageHost | null = null
  let followHandle: unknown = null
  let followReading = false
  let followLast = ''
  // The capture gallery: the deck's last Capture press handled, one capture at a time, and (presenter)
  // the gallery state last passed to the audience copy.
  let lastCaptureSeq: number | null = null
  let capturing = false
  let galleryKey = ''
  // The slide and page the deck shows now, and the saved-views list last told it (refreshSavedViews).
  let viewsSlot: { slideId: string; url: string } | null = null
  let viewsTold = ''
  let viewsSerial = 0
  let audienceGallery = { on: false, index: 0 }
  // Freeze and mark. `frozen`: this view is hidden behind a frozen picture in its deck (both roles).
  // `freeze` (presenter): the press being answered or the picture shown; `freezeToken` drops whatever
  // a cancelled, failed or ended freeze still had in flight.
  let frozen = false
  // Audience copy: the slide and page its view is hidden for; leaving them shows it again.
  let frozenFor: { slideId: string; authored: string } | null = null
  type Freeze = { phase: 'pending' | 'frozen'; token: number; seq: number; slideId: string; reportUrl: string; authored: string; audience: boolean; id: string | null }
  let freeze: Freeze | null = null
  let freezeToken = 0
  let lastFreezeSeq: number | null = null

  const deckAlive = (): boolean => { try { return !deck.isDestroyed() && !deck.webContents.isDestroyed() } catch { return false } }

  const pushState = (state: LivePageState | null): void => {
    const key = state ? JSON.stringify(state) : ''
    if (key === lastStateKey || !state || !deckAlive()) return
    lastStateKey = key
    deck.webContents.executeJavaScript(livePageStateScript(state), false).catch(() => { /* the deck reloaded */ })
  }
  const stateOf = (r: ViewRecord): LivePageState => {
    let host = ''
    try { host = new URL(r.authored).host } catch { /* checked before */ }
    return { v: 1, slideId: r.slideId, state: r.state, host, ...(r.httpStatus ? { httpStatus: r.httpStatus } : {}), ...(r.message ? { message: r.message } : {}) }
  }
  const setState = (r: ViewRecord, state: LivePageStateName, extra: { httpStatus?: number; message?: string } = {}): void => {
    r.state = state
    r.httpStatus = extra.httpStatus
    r.message = extra.message
    pushState(stateOf(r))
  }

  const ensureSession = (): LivePageSession => {
    if (session) return session
    partition = `tw-live-page:${role}:${deps.newId()}`
    session = deps.sessionFor(partition)
    hardenLivePageSession(session, { allowance: deps.allowance, userAgent: deps.userAgent, log })
    return session
  }

  const focusDeck = (): void => { if (deckAlive()) { try { deck.webContents.focus() } catch { /* gone */ } } }

  const closeView = (reason: string): void => {
    const r = record
    if (!r) return
    record = null
    generation++
    viewSerial++
    followLast = ''
    if (r.slowTimer) timers.clearTimeout(r.slowTimer)
    livePageContentsIds.delete(r.id)
    try { r.view.setVisible(false) } catch { /* gone */ }
    try { if (deckAlive()) deck.contentView.removeChildView(r.view) } catch { /* gone */ }
    try { if (!r.contents.isDestroyed()) r.contents.close() } catch { /* gone */ }
    if (interact) { interact = false }
    if (role !== 'presenter') { frozen = false; frozenFor = null; try { partner?._audienceLost() } catch { /* gone */ } }
    if (freeze && role === 'presenter') endFreeze(`the view closed (${reason})`)
    frozen = false
    log(`[live-page] closed the ${role} view (${reason})`)
  }

  const guardNavigation = (r: ViewRecord, kind: string) => (event: { preventDefault(): void; url?: string; isMainFrame?: boolean; frame?: { parent?: unknown } | null }, url?: string, _inPlace?: boolean, isMainFrame?: boolean): void => {
    const main = event?.isMainFrame ?? isMainFrame ?? (event?.frame ? event.frame.parent == null : true)
    if (main === false) return
    const to = typeof event?.url === 'string' ? event.url : String(url ?? '')
    if (parseLivePageUrl(to, deps.allowance)) return
    event.preventDefault()
    const shown = to.slice(0, 120).replace(/[?#].*$/, '')
    log(`[live-page] refused ${kind} of the ${role} view to ${shown}`)
    if (record !== r) return
    if (!r.painted) { setState(r, 'blocked', { message: `This page tried to go to an address TalkWeaver does not open (${shown.slice(0, 80)})` }); applyVisibility() }
    else setState(r, r.state === 'blocked' ? 'blocked' : 'live', { httpStatus: r.httpStatus, message: `Blocked a link to ${shown.slice(0, 80)}` })
  }

  const loadInto = (r: ViewRecord, url: string): void => {
    const checked = parseLivePageUrl(url, deps.allowance)
    if (!checked) { setState(r, 'blocked', { message: 'This address is not opened as a live page' }); return }
    r.painted = false
    viewSerial++
    if (r.slowTimer) timers.clearTimeout(r.slowTimer)
    setState(r, 'loading')
    r.slowTimer = timers.setTimeout(() => { if (record === r && !r.painted && r.state === 'loading') setState(r, 'slow', { message: 'Still loading' }) }, LIVE_PAGE_SLOW_MS)
    r.contents.loadURL(checked.href).catch(() => { /* reported by did-fail-load */ })
  }

  const createView = (report: SlotReport, url: URL): void => {
    const ses = ensureSession()
    const view = deps.createView(livePageWebPreferences(ses, deps.devTools))
    const contents = view.webContents
    const r: ViewRecord = { view, contents, id: contents.id, authored: url.href, slideId: report.slideId, painted: false, state: 'loading', slowTimer: null, visible: false, bounds: null, navigations: 0 }
    livePageContentsIds.add(r.id)
    record = r
    generation++
    viewSerial++
    try { view.setBackgroundColor('#ffffff') } catch { /* cosmetic */ }
    view.setVisible(false)
    contents.setWindowOpenHandler(() => { log(`[live-page] refused a pop-up from the ${role} view`); return { action: 'deny' } })
    contents.setIgnoreMenuShortcuts(false)
    if (role === 'presenter') contents.setAudioMuted(true) // D8: one sound source, the audience's
    contents.on('will-navigate', guardNavigation(r, 'navigation'))
    contents.on('will-redirect', guardNavigation(r, 'redirect'))
    contents.on('will-frame-navigate', guardNavigation(r, 'navigation'))
    contents.on('will-prevent-unload', (event: { preventDefault(): void }) => event.preventDefault())
    contents.on('select-bluetooth-device', (event: { preventDefault(): void }, _devices: unknown, callback: (id: string) => void) => { event.preventDefault(); try { callback('') } catch { /* ignore */ } })
    contents.on('did-start-navigation', (details: { isMainFrame?: boolean; isSameDocument?: boolean } | undefined, _url?: string, inPlace?: boolean, isMainFrame?: boolean) => {
      const main = details?.isMainFrame ?? isMainFrame
      const same = details?.isSameDocument ?? inPlace
      if (main && !same && record === r && r.painted) { r.navigations++ }
      if (main !== false && record === r) viewSerial++
    })
    const painted = (): void => {
      if (record !== r || r.painted) return
      r.painted = true
      if (r.slowTimer) { timers.clearTimeout(r.slowTimer); r.slowTimer = null }
      if (r.state === 'loading' || r.state === 'slow') setState(r, 'live', { httpStatus: r.httpStatus })
      applyVisibility()
    }
    contents.on('dom-ready', painted)
    contents.on('did-finish-load', painted)
    contents.on('did-navigate', (_event: unknown, navUrl: string, code?: number) => {
      if (record !== r) return
      r.navigations++
      viewSerial++
      r.httpStatus = typeof code === 'number' && code >= 400 ? code : undefined
      if (r.painted) setState(r, 'live', { httpStatus: r.httpStatus })
      if (role === 'presenter') partner?._followNavigation(navUrl)
    })
    contents.on('did-navigate-in-page', (_event: unknown, navUrl: string, isMainFrame?: boolean) => {
      if (record !== r || isMainFrame === false) return
      viewSerial++
      if (role === 'presenter') partner?._followNavigation(navUrl)
    })
    contents.on('did-fail-load', (_event: unknown, code: number, description: string, _url: string, isMainFrame?: boolean) => {
      if (record !== r || isMainFrame === false) return
      viewSerial++
      if (code === -3) return
      if (r.slowTimer) { timers.clearTimeout(r.slowTimer); r.slowTimer = null }
      const text = String(description || `error ${code}`).slice(0, 200)
      if (code === -20) setState(r, 'blocked', { message: 'This page is at an address TalkWeaver does not open (this computer or the local network)' })
      else setState(r, 'failed', { message: text })
      r.painted = false
      applyVisibility()
    })
    const gone = (why: string) => (): void => {
      if (record !== r) return
      const slideId = r.slideId
      const authored = r.authored
      failed = { url: authored, slideId, reloadSeq: lastReloadSeq ?? 0 }
      closeView(why)
      let host = ''
      try { host = new URL(authored).host } catch { /* checked */ }
      pushState({ v: 1, slideId, state: 'failed', host, message: why === 'unresponsive' ? 'The page stopped responding. Reload to try again.' : 'The page crashed. Reload to try again.' })
    }
    contents.on('render-process-gone', gone('crashed'))
    contents.on('unresponsive', gone('unresponsive'))
    // D11: the deck keeps the keys. Without Interact the view never keeps focus; in the audience
    // window it never does.
    contents.on('focus', () => {
      if (record !== r) return
      if (role !== 'presenter' || !interact) focusDeck()
    })
    contents.on('before-input-event', (event: { preventDefault(): void }, input: { type?: string; key?: string }) => {
      if (record !== r) return
      if (role !== 'presenter') {
        if (input?.type === 'keyDown' || input?.type === 'keyUp' || input?.type === 'char' || input?.type === 'rawKeyDown') { event.preventDefault(); focusDeck() }
        return
      }
      if (input?.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault()
        interact = false
        if (deckAlive()) deck.webContents.executeJavaScript(INTERACT_OFF_SCRIPT, false).catch(() => {})
        focusDeck()
        return
      }
      if (!interact && (input?.type === 'keyDown' || input?.type === 'rawKeyDown')) { event.preventDefault(); focusDeck() }
    })
    deck.contentView.addChildView(view)
    // The audience copy opens where the presenter's copy is now, when both show the same slide's page.
    const start = role !== 'presenter' ? (partner?._presenterUrlFor(url.href) ?? url.href) : url.href
    log(`[live-page] opened the ${role} view for ${url.host}`)
    loadInto(r, start)
  }

  const applyVisibility = (): void => {
    const r = record
    if (!r) return
    const report = lastReport
    let bounds: ViewRecord['bounds'] = null
    if (report && report.visible && deckAlive()) {
      let zoom = 1
      try { zoom = deck.webContents.getZoomFactor() } catch { /* 1 */ }
      let content = { width: 0, height: 0 }
      try { content = deck.getContentBounds() } catch { /* hidden */ }
      bounds = slotToViewBounds(report.rect, zoom, content)
    }
    const show = !!bounds && r.painted && !frozen && (r.state === 'live' || r.state === 'slow' || r.state === 'loading')
    if (bounds && (!r.bounds || bounds.x !== r.bounds.x || bounds.y !== r.bounds.y || bounds.width !== r.bounds.width || bounds.height !== r.bounds.height)) {
      try { r.view.setBounds(bounds) } catch { /* gone */ }
    }
    if (bounds) r.bounds = bounds
    if (role === 'presenter' && bounds) {
      const z = presenterZoom(bounds.width, partner?._audienceWidth() ?? null)
      try { if (Math.abs(r.contents.getZoomFactor() - z) > 0.005) r.contents.setZoomFactor(z) } catch { /* not loaded yet */ }
    }
    if (show !== r.visible) {
      if (r.visible !== show) viewSerial++
      r.visible = show
      try { r.view.setVisible(show) } catch { /* gone */ }
    }
  }

  // Audience copy: the slide and page it last reported (a change of either ends a freeze it is in).
  let audienceAt: { slideId: string; authored: string } | null = null
  /** Audience copy: it left what it was frozen for (or was freezing for): view shown, presenter told. */
  const audienceLeft = (reason: string): void => {
    audienceAt = null
    if (frozen || frozenFor) {
      frozen = false
      frozenFor = null
      followLast = ''
      applyVisibility()
      log(`[live-page] audience view shown again (${reason})`)
    }
    try { partner?._audienceLost() } catch { /* gone */ }
  }

  const apply = (raw: unknown): void => {
    if (disposed) return
    const report = validateSlotReport(raw)
    lastReport = report
    if (!report) {
      if (freeze) endFreeze('left the slide')
      if (role !== 'presenter') audienceLeft('left the slide')
      if (record) closeView('left the slide')
      failed = null
      lastReloadSeq = null
      lastCaptureSeq = null
      lastFreezeSeq = null
      if (role === 'presenter') passGallery({ on: false, index: 0 }, '')
      if (interact) interact = false
      lastStateKey = ''
      return
    }
    const url = parseLivePageUrl(report.url, deps.allowance)
    if (!url) {
      if (role !== 'presenter') audienceLeft('address not allowed')
      if (record) closeView('address not allowed')
      let host = ''
      try { host = new URL(report.url).host } catch { /* unreadable */ }
      pushState({ v: 1, slideId: report.slideId, state: 'blocked', host, message: 'TalkWeaver opens only web pages on the internet as live pages (not this computer, the local network or other kinds of address)' })
      return
    }
    // Another slide or page: the deck is told that slide's saved views as the text has them now.
    if (!viewsSlot || viewsSlot.slideId !== report.slideId || viewsSlot.url !== report.url) {
      viewsSlot = { slideId: report.slideId, url: report.url }
      void refreshSavedViews()
    }
    const reload = lastReloadSeq !== null && report.reloadSeq !== lastReloadSeq
    lastReloadSeq = report.reloadSeq
    // Capture: only a press seen after this slide's first report (a deck that reloads mid-count does not fire).
    const capturePressed = lastCaptureSeq !== null && report.captureSeq !== lastCaptureSeq
    lastCaptureSeq = report.captureSeq
    // Freeze: likewise only a press seen after a first report. A freeze ends with its slide or page, a
    // Reload, or the saved views shown instead of the page.
    const freezePressed = role === 'presenter' && lastFreezeSeq !== null && report.freeze.seq !== lastFreezeSeq
    if (role === 'presenter') lastFreezeSeq = report.freeze.seq
    if (freeze && (freeze.slideId !== report.slideId || freeze.reportUrl !== report.url || reload || report.gallery.on)) endFreeze('the slide or page changed')
    // The audience copy moved on by itself (another slide, even with the same page; another page; its
    // own Reload): its view is shown again and the presenter ends the freeze in both windows.
    if (role !== 'presenter' && (reload || (audienceAt && (audienceAt.slideId !== report.slideId || audienceAt.authored !== url.href))
      || (frozenFor && (frozenFor.slideId !== report.slideId || frozenFor.authored !== url.href)))) audienceLeft('the audience slide or page changed')
    if (role !== 'presenter') audienceAt = { slideId: report.slideId, authored: url.href }
    // The audience copy follows the presenter's Live / saved view choice, with or without a live view.
    if (role === 'presenter') passGallery(report.gallery, url.href)

    if (record && record.authored !== url.href) { closeView('another page'); lastStateKey = '' }
    if (failed && (failed.url !== url.href || failed.slideId !== report.slideId || failed.reloadSeq !== report.reloadSeq)) failed = null
    if (!record) {
      if (failed || !report.visible) {
        if (capturePressed && role === 'presenter') captureAnswer(report.slideId, url.href, { ok: false, message: 'The page is not showing, so there is nothing to capture.' })
        return
      }
      createView(report, url)
    } else {
      record.slideId = report.slideId
      if (reload) loadInto(record, record.authored)
    }
    if (role === 'presenter' && record) {
      if (report.interact && !interact) { interact = true; try { record.contents.focus() } catch { /* gone */ } }
      else if (!report.interact && interact) { interact = false; focusDeck() }
    }
    applyVisibility()
    if (role === 'presenter' && capturePressed) void captureNow(report, url.href)
    if (freezePressed) {
      if (report.freeze.want === null) { if (freeze) endFreeze('live') }
      else {
        // A new press (the deck numbers each one): an earlier freeze it cancelled or left within one poll
        // ends first. Switching tools on the same picture never changes the number, so never re-captures.
        if (freeze && freeze.seq !== report.freeze.seq) endFreeze('a new press')
        if (!freeze) void freezeNow(report, url.href, report.freeze.seq)
      }
    }
  }

  // --- The capture gallery -------------------------------------------------------------------------
  /**
   * Tells the deck the saved views of the slide and page it shows now (`views: null`: what its compiled
   * deck says), only when the list changed since it was last told. The newest call wins: an answer
   * that arrives after a later one, or after the deck moved on, is dropped.
   */
  const refreshSavedViews = async (): Promise<void> => {
    const slot = viewsSlot
    if (disposed || !slot || !deps.capture?.views) return
    const serial = ++viewsSerial
    let found: LivePageSavedViews | null = null
    try { found = await deps.capture.views(slot.slideId, slot.url) } catch { found = null }
    if (disposed || serial !== viewsSerial || viewsSlot !== slot || !found) return
    const key = `${slot.slideId}\n${slot.url}\n${found.key}`
    if (key === viewsTold) return
    let views: ReturnType<LivePageSavedViews['views']>
    try { views = found.views() } catch { return }
    viewsTold = key
    deckCall('__twLivePageViews', { v: 1, slideId: slot.slideId, url: slot.url, views })
  }
  const deckCall = (fn: '__twLivePageGallery' | '__twLivePageCaptured' | '__twLivePageViews', value: unknown): void => {
    if (!deckAlive()) return
    deck.webContents.executeJavaScript(deckCallScript(fn, value), false).catch(() => { /* the deck reloaded */ })
  }
  /** Presenter: the audience copy shows what the presenter chose (live page, or saved view n). */
  const passGallery = (gallery: { on: boolean; index: number }, url: string): void => {
    const key = `${gallery.on ? 1 : 0}|${gallery.index}|${url}`
    if (key === galleryKey) return
    galleryKey = key
    try { partner?._setGallery(gallery, url) } catch { /* gone */ }
  }
  const captureAnswer = (slideId: string, url: string, answer: { ok: boolean; message: string; count?: number }): void => {
    deckCall('__twLivePageCaptured', { v: 1, slideId, url, ok: answer.ok, message: String(answer.message).slice(0, 300), ...(typeof answer.count === 'number' ? { count: answer.count } : {}) })
  }
  /**
   * The deck's Capture press: the page's visible viewport, from the audience's copy when it shows the
   * same page (the audience's own size and layout), else from this view. Stale-checked twice: the
   * view, the page and the slide must still be the ones the press was for when the picture comes back
   * and again before it is handed to the writer; anything else drops it unsaved.
   */
  const captureNow = async (report: SlotReport, authored: string): Promise<void> => {
    const r = record
    const say = (ok: boolean, message: string, count?: number): void => captureAnswer(report.slideId, authored, { ok, message, count })
    if (!deps.capture) { say(false, 'Saving views is not available in this window.'); return }
    if (capturing) { say(false, 'Still saving the last view.'); return }
    if (!r || r.authored !== authored || !r.painted || r.state !== 'live' && r.state !== 'slow') { say(false, 'The page is not showing yet, so there is nothing to capture.'); return }
    const audience = partner?._captureSource(authored) ?? null
    const own = r.bounds && r.visible ? { contents: r.contents, bounds: r.bounds, generation: () => viewSerial } : null
    const src = audience ?? own
    if (!src) { say(false, 'The page is not on screen, so there is nothing to capture.'); return }
    const source: LivePageRole = audience ? 'audience' : role
    const genAtPress = src.generation()
    const ownGen = generation
    const ownSerial = viewSerial
    // The press's page, slide and source view, all unchanged: the audience copy must still be the
    // source it was (same view, not navigated, reloaded, hidden or showing a saved view), and this
    // view must not have navigated either (the presenter leads; the audience follows a moment later).
    const stillSame = (): boolean => !disposed && record === r && generation === ownGen && viewSerial === ownSerial
      && src.generation() === genAtPress && !src.contents.isDestroyed()
      && (!audience || partner?._captureSource(authored)?.contents === src.contents)
      // The deck reports the address as written on the slide (`https://site`, no slash); `authored` is its
      // normalised form (`https://site/`). Compare like with like: the press's own report (owner bug
      // 2026-10-27, alpha.14: a bare site address never matched, so every capture was dropped).
      && lastReport?.slideId === report.slideId && lastReport?.url === report.url
    capturing = true
    try {
      let currentUrl: string | null = null
      try { const now = src.contents.getURL(); currentUrl = parseLivePageUrl(now, deps.allowance) ? now : null } catch { currentUrl = null }
      let scroll = { fx: 0, fy: 0 }
      try {
        const at = scrollFraction(await src.contents.executeJavaScriptInIsolatedWorld(LIVE_PAGE_WORLD_ID, [{ code: READ_SCROLL }], false))
        if (at) scroll = { fx: Math.min(1, Math.max(0, at.fx)), fy: Math.min(1, Math.max(0, at.fy)) }
      } catch { /* top of the page */ }
      let zoom = 1
      try { zoom = src.contents.getZoomFactor() } catch { /* 1 */ }
      const mode: 'view' | 'page' = report.captureMode === 'page' ? 'page' : 'view'
      const stale = 'The slide or page changed while capturing, so that view was not saved.'
      let encoded: { jpeg: Uint8Array; width: number; height: number } | null
      let viewport = { w: src.bounds.width, h: src.bounds.height, zoom: Number.isFinite(zoom) && zoom > 0 ? zoom : 1 }
      let truncated = false
      if (mode === 'page') {
        // The entire scrollable page as loaded (live-page-whole-capture.ts): fixed protocol commands on
        // this view's own debugger, bounded; the scroll is read again after and put back if it moved.
        if (!src.contents.debugger) { say(false, WHOLE_PAGE_TEXT.failed); return }
        const whole = await captureWholePage(src.contents.debugger)
        await restoreScroll(src.contents, scroll)
        if (!stillSame()) { say(false, stale); return }
        if (!whole.ok) { say(false, whole.message); return }
        encoded = { jpeg: whole.jpeg, width: whole.width, height: whole.height }
        viewport = { w: whole.cssWidth, h: whole.cssHeight, zoom: viewport.zoom }
        truncated = whole.truncated
      } else {
        const picture = await src.contents.capturePage()
        if (!stillSame()) { say(false, stale); return }
        encoded = deps.capture.encode(picture)
        if (!encoded) { say(false, 'The view came back empty, so it was not saved.'); return }
      }
      if (!stillSame()) { say(false, stale); return }
      const result = await deps.capture.save({
        pageUrl: authored, currentUrl, slideId: report.slideId, source,
        jpeg: encoded.jpeg, width: encoded.width, height: encoded.height,
        viewport, scroll, mode, ...(truncated ? { truncated: true } : {}),
        isCurrent: stillSame
      })
      if (!result.ok) { say(false, result.message); return }
      const dataUrl = `data:image/jpeg;base64,${Buffer.from(encoded.jpeg).toString('base64')}`
      const added = { url: authored, src: dataUrl, capturedAt: result.capturedAt, mode }
      host._addCapture(added)
      try { partner?._addCapture(added) } catch { /* gone */ }
      const what = mode === 'page' ? (truncated ? 'Saved the entire page (cut at the tallest picture kept)' : 'Saved the entire page') : 'Saved this view'
      const where = result.onSlide === false ? `. ${result.note ?? 'It is saved with the talk but not on the slide.'}` : result.onSlide ? ' and added it to the slide.' : '.'
      say(true, result.how === 'reused' && mode !== 'page' ? 'This view was already saved.' : `${what}${where}`, result.count)
      log(`[live-page] saved a view of ${(() => { try { return new URL(authored).host } catch { return '' } })()} (${source}, ${mode}, ${encoded.width}×${encoded.height})`)
    } catch (error) {
      log(`[live-page] capture failed: ${String((error as Error)?.message ?? error).slice(0, 120)}`)
      say(false, 'The view could not be captured.')
    } finally {
      capturing = false
    }
  }

  // --- Freeze and mark ------------------------------------------------------------------------------
  /** Hands one message to this deck; resolves whether it answered with exactly the picture's id. */
  const frozenCall = (message: FrozenMessage): Promise<boolean> => {
    if (!deckAlive()) return Promise.resolve(false)
    const id = message.op === 'clear' ? '' : message.id
    return deck.webContents.executeJavaScript(frozenCallScript(message), false).then((value) => frozenAck(value, id), () => false)
  }
  /**
   * Ends a freeze (Live, cancel, failure, slide change): both views shown again, both decks told to drop
   * the picture (with `message` when it failed), anything still in flight dropped. Safe to call twice.
   */
  const endFreeze = (reason: string, message?: string): void => {
    const was = freeze
    freeze = null
    freezeToken++
    if (frozen) { frozen = false; applyVisibility() }
    try { partner?._setFrozen(false) } catch { /* gone */ }
    if (!was) return
    const clear: FrozenMessage = { v: 1, op: 'clear', seq: was.seq, slideId: was.slideId, url: was.reportUrl, ...(message ? { message } : {}) }
    void frozenCall(clear)
    if (was.audience) { try { partner?._frozenClear(clear) } catch { /* gone */ } }
    log(`[live-page] freeze ended (${reason})`)
  }
  /**
   * The presenter's Pointer or Pen press on a live page: one picture of the audience's copy (else this
   * view), shown in every deck window showing the page; when all have answered with the same picture
   * id the views are hidden and the deck turns the tool on. Any failure, change or timeout on the way:
   * both decks drop the picture, the views stay as they were, the tool stays off. Bounded by
   * LIVE_PAGE_FREEZE_MS from the press.
   */
  const freezeNow = async (report: SlotReport, authored: string, seq: number): Promise<void> => {
    const token = ++freezeToken
    // An open audience window is the only source and must show this slide and page; the presenter's
    // own copy is used only when there is no audience window at all.
    const pairedAtPress = partner
    const audience = !!pairedAtPress
    freeze = { phase: 'pending', token, seq, slideId: report.slideId, reportUrl: report.url, authored, audience, id: null }
    const current = (): boolean => !disposed && freezeToken === token && freeze?.token === token
    const fail = (message: string, why: string): void => { if (current()) endFreeze(why, message) }
    const r = record
    if (!deps.capture) { fail(FREEZE_TEXT.unavailable, 'not available'); return }
    if (!r || r.authored !== authored || !r.painted || r.state !== 'live' && r.state !== 'slow') { fail(FREEZE_TEXT.notShowing, 'not showing'); return }
    const audienceSource = (): ReturnType<LivePageHost['_captureSource']> => {
      const p = partner
      if (!p || p !== pairedAtPress || !p._showsPage(report.slideId, authored)) return null
      return p._captureSource(authored, report.slideId)
    }
    const fromAudience = audience ? audienceSource() : null
    if (audience && !fromAudience) { fail(FREEZE_TEXT.audienceNotShowing, 'the audience window does not show this page'); return }
    const own = !audience && r.bounds && r.visible ? { contents: r.contents, bounds: r.bounds, generation: () => viewSerial } : null
    const src = fromAudience ?? own
    if (!src) { fail(FREEZE_TEXT.notShowing, 'not on screen'); return }
    const source: 'audience' | 'presenter' = fromAudience ? 'audience' : 'presenter'
    const genAtPress = src.generation()
    const ownGen = generation
    const ownSerial = viewSerial
    // As Capture's check: the same views, not navigated, reloaded or hidden, the same slide and page.
    const stillSame = (): boolean => current() && record === r && generation === ownGen && viewSerial === ownSerial
      && src.generation() === genAtPress && !src.contents.isDestroyed()
      && (!audience || audienceSource()?.contents === src.contents)
      && lastReport?.slideId === report.slideId && lastReport?.url === report.url
    const now = (): number => Date.now()
    const deadline = now() + LIVE_PAGE_FREEZE_MS
    try {
      const shot = await withDeadline(src.contents.capturePage(), deadline, now, timers)
      if (!current()) return
      if (!stillSame()) { fail(FREEZE_TEXT.failed, 'stale picture'); return }
      if (!shot.ok) { fail(FREEZE_TEXT.failed, `capture ${shot.why}`); return }
      const encoded = deps.capture.encode(shot.value)
      if (!encoded || encoded.jpeg.byteLength > LIVE_PAGE_FREEZE_MAX_JPEG) { fail(FREEZE_TEXT.failed, 'empty or too large'); return }
      const id = stillIdOf(encoded.jpeg)
      const show: FrozenMessage = {
        v: 1, op: 'show', seq, slideId: report.slideId, url: report.url, id,
        src: `data:image/jpeg;base64,${Buffer.from(encoded.jpeg).toString('base64')}`, width: encoded.width, height: encoded.height, source
      }
      const shown = [frozenCall(show)]
      if (audience && partner) shown.push(partner._frozenShow(show))
      const answers = await withDeadline(Promise.all(shown), deadline, now, timers)
      if (!current()) return
      if (!stillSame()) { fail(FREEZE_TEXT.failed, 'stale before shown'); return }
      if (!answers.ok || !answers.value.every(Boolean)) { fail(FREEZE_TEXT.failed, answers.ok ? 'a window did not show the picture' : `answers ${answers.why}`); return }
      // Every window shows the same picture: now the views go (the audience copy first, which refuses
      // unless it still shows this slide and page), then the tool comes on.
      let held = !audience
      if (audience) { try { held = partner === pairedAtPress && !!partner?._setFrozen(true, { slideId: report.slideId, authored }) } catch { held = false } }
      if (!held) { fail(FREEZE_TEXT.audienceLeft, 'the audience window moved on'); return }
      frozen = true
      applyVisibility()
      freeze = { ...freeze!, phase: 'frozen', id }
      void frozenCall({ v: 1, op: 'on', seq, slideId: report.slideId, url: report.url, id })
      log(`[live-page] froze the page (${source}, ${encoded.width}×${encoded.height}, ${audience ? 'both windows' : 'presenter only'})`)
    } catch (error) {
      log(`[live-page] freeze failed: ${String((error as Error)?.message ?? error).slice(0, 120)}`)
      fail(FREEZE_TEXT.failed, 'error')
    }
  }

  const tick = (): void => {
    if (disposed || polling) return
    if (!deckAlive()) { host.dispose(); return }
    polling = true
    deck.webContents.executeJavaScript(SLOT_SCRIPT, false).then(
      (value) => { polling = false; apply(value) },
      () => { polling = false }
    )
  }
  const pollHandle = timers.setInterval(tick, LIVE_PAGE_POLL_MS)

  // The deck page itself reloaded (⌘R refresh, rebuild) or crashed: its slot is gone.
  const onDeckNavigation = (details: { isMainFrame?: boolean; isSameDocument?: boolean } | undefined, _url?: string, inPlace?: boolean, isMainFrame?: boolean): void => {
    const main = details?.isMainFrame ?? isMainFrame
    const same = details?.isSameDocument ?? inPlace
    if (main && !same) { if (freeze) endFreeze('the deck reloaded'); closeView('the deck reloaded'); failed = null; lastReport = null; lastReloadSeq = null; lastStateKey = ''; viewsSlot = null; viewsTold = ''; lastFreezeSeq = null; audienceAt = null }
  }
  const onDeckGone = (): void => { closeView('the deck crashed'); lastStateKey = '' }
  deck.webContents.on('did-start-navigation', onDeckNavigation)
  deck.webContents.on('render-process-gone', onDeckGone)

  // Presenter → audience following (D10): scroll position as a fraction, read in an isolated world.
  const followTick = (): void => {
    const p = partner
    const r = record
    if (disposed || followReading || frozen || freeze || !p || !r || !r.painted || r.contents.isDestroyed()) return
    const navigationsAtRead = r.navigations
    const url = r.contents.getURL()
    followReading = true
    r.contents.executeJavaScriptInIsolatedWorld(LIVE_PAGE_WORLD_ID, [{ code: READ_SCROLL }], false).then((value) => {
      followReading = false
      if (record !== r || r.navigations !== navigationsAtRead || r.contents.isDestroyed() || r.contents.getURL() !== url) return
      const at = scrollFraction(value)
      if (!at) return
      p._applyScroll(at.fx, at.fy, `${url}\n${at.fx.toFixed(4)},${at.fy.toFixed(4)}`)
    }, () => { followReading = false })
  }

  const host: LivePageHost = {
    role,
    deckId,
    pairWith(audience) {
      if (role !== 'presenter') throw new Error('pairWith is called on the presenter host')
      partner = audience
      galleryKey = '' // the new audience copy is told the presenter's gallery choice on the next poll
      audience._setPartner(host)
      if (!followHandle) followHandle = timers.setInterval(followTick, LIVE_PAGE_FOLLOW_MS)
      return () => {
        if (partner === audience) partner = null
        try { audience._setPartner(null) } catch { /* gone */ }
        if (followHandle) { timers.clearInterval(followHandle); followHandle = null }
      }
    },
    inspect() {
      const r = record
      let zoom: number | null = null
      try { zoom = r ? r.contents.getZoomFactor() : null } catch { zoom = null }
      let url = ''
      try { url = r ? r.contents.getURL() : '' } catch { /* gone */ }
      return { viewId: r ? r.id : null, url, authored: r?.authored ?? '', state: r?.state ?? null, visible: !!r?.visible, bounds: r?.bounds ?? null, interact, zoom }
    },
    closeView,
    dispose() {
      if (disposed) return
      disposed = true
      hosts.delete(host)
      timers.clearInterval(pollHandle)
      if (followHandle) { timers.clearInterval(followHandle); followHandle = null }
      if (freeze) endFreeze('the deck window closed')
      closeView('the deck window closed')
      try { deck.webContents.removeListener('did-start-navigation', onDeckNavigation) } catch { /* gone */ }
      try { deck.webContents.removeListener('render-process-gone', onDeckGone) } catch { /* gone */ }
      const s = session
      session = null
      if (s) { s.clearStorageData().catch(() => {}); s.clearCache().catch(() => {}) }
    },
    _audienceWidth() { return record?.bounds?.width ?? (lastReport?.layoutWidth ?? null) },
    _followNavigation(url) {
      const r = record
      if (!r || r.contents.isDestroyed()) return
      if (!parseLivePageUrl(url, deps.allowance)) return
      let now = ''
      try { now = r.contents.getURL() } catch { return }
      if (now === url) return
      followLast = ''
      r.contents.loadURL(url).catch(() => { /* did-fail-load reports */ })
    },
    _applyScroll(fx, fy, key) {
      const r = record
      if (frozen || !r || !r.painted || r.contents.isDestroyed()) return
      const full = `${generation}\n${key}`
      if (full === followLast) return
      followLast = full
      r.contents.executeJavaScriptInIsolatedWorld(LIVE_PAGE_WORLD_ID, [{ code: scrollToScript(fx, fy) }], false).catch(() => { /* the page went away */ })
    },
    _presenterUrlFor(authored) {
      const r = record
      if (!r || r.authored !== authored || r.contents.isDestroyed()) return null
      try { const now = r.contents.getURL(); return parseLivePageUrl(now, deps.allowance) ? now : null } catch { return null }
    },
    _viewGeneration() { return generation },
    _setPartner(h) { partner = h },
    _setGallery(gallery, url) {
      if (audienceGallery.on !== !!gallery.on) viewSerial++
      audienceGallery = { on: !!gallery.on, index: Math.max(0, Math.min(999, Math.floor(gallery.index) || 0)) }
      deckCall('__twLivePageGallery', { v: 1, url: String(url).slice(0, 2048), on: audienceGallery.on, index: audienceGallery.index })
    },
    _captureSource(authored, slideId) {
      const r = record
      if (slideId !== undefined && lastReport?.slideId !== slideId) return null
      if (!r || r.authored !== authored || !r.painted || !r.visible || !r.bounds || r.contents.isDestroyed() || audienceGallery.on) return null
      if (r.state !== 'live' && r.state !== 'slow') return null
      return { contents: r.contents, bounds: r.bounds, generation: () => viewSerial }
    },
    _addCapture(added) {
      deckCall('__twLivePageCaptured', { v: 1, url: added.url, add: { src: added.src, capturedAt: added.capturedAt, mode: added.mode === 'page' ? 'page' : 'view' } })
    },
    _capturing() { return capturing },
    _freezeState() { return { phase: freeze?.phase ?? 'idle', id: freeze?.id ?? null, frozen } },
    _frozenShow(message) { return frozenCall(message) },
    _frozenClear(message) { void frozenCall(message) },
    _setFrozen(on, identity) {
      if (on) {
        const r = record
        if (!identity || !r || r.contents.isDestroyed() || r.authored !== identity.authored || !host._showsPage(identity.slideId, identity.authored)) return false
        frozenFor = { slideId: identity.slideId, authored: identity.authored }
      } else frozenFor = null
      if (frozen === on) return true
      frozen = on
      followLast = ''
      applyVisibility()
      return true
    },
    _showsPage(slideId, authored) {
      const report = lastReport
      if (!report || report.slideId !== slideId) return false
      return parseLivePageUrl(report.url, deps.allowance)?.href === authored
    },
    _audienceLost() { if (freeze?.audience) endFreeze('the audience window changed', freeze.phase === 'frozen' ? FREEZE_TEXT.audienceLeft : FREEZE_TEXT.failed) },
    refreshSavedViews
  }
  hosts.add(host)
  deck.once('closed', () => host.dispose())
  return host
}

/** Pair a presenter host with its audience host; the unpair function is safe to call more than once. */
export function pairLivePageHosts(presenter: LivePageHost | null | undefined, audience: LivePageHost | null | undefined): () => void {
  if (!presenter || !audience || presenter.role !== 'presenter' || audience.role === 'presenter') return () => {}
  return presenter.pairWith(audience)
}

