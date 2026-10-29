// The rules for a live web page shown on a slide (design: research/external-url-embed-2026-10-27/
// design-live-web-page-view-and-capture-gallery-2026-10-27.md). Pure: no Electron, unit-tested.
//
// A live page is another site loaded as the TOP-LEVEL document of its own view (live-page-host.ts),
// the way a browser tab shows it. Framing rules (frame-ancestors, X-Frame-Options) govern framing
// only, so a site that refuses to be framed still shows here; no response header is ever read,
// stripped or rewritten to make that happen.
//
// What these rules decide:
//   - which addresses a live page may show (parseLivePageUrl): http(s) only, no user name or
//     password in the address, and never a host that is local as written (loopback, private,
//     link-local, `localhost`, `*.local`, …: classifyHost in local-address-filter.ts). A NAME that
//     resolves to a local address is refused by the view's session filter, at every request;
//   - what the deck may report (validateSlotReport): a strict shape, numbers finite and bounded;
//     anything else is treated as "no live page here";
//   - where the view goes in the window (slotToViewBounds) and how the presenter's copy is scaled
//     so it lays out at the audience's width (presenterZoom);
//   - the one test-only exception: a loopback fixture server, honoured only when the app is not
//     packaged AND runs under the e2e flag (testLoopbackAllowance).
import { classifyHost } from './local-address-filter.ts'
import { validateFreezeRequest, type FreezeRequest } from './live-page-freeze.ts'

export const LIVE_PAGE_URL_MAX = 2048
export const LIVE_PAGE_MIN_SIZE = 40

/** `host:port` entries a test fixture may use on loopback; always empty in a packaged app. */
export type LoopbackAllowance = ReadonlySet<string>
const NO_ALLOWANCE: LoopbackAllowance = new Set()

/** The `host:port` of a URL as the allowance compares it (`127.0.0.1:5173`), lower case; null when unreadable. */
export function hostPortOf(url: URL): string {
  const port = url.port || (url.protocol === 'https:' || url.protocol === 'wss:' ? '443' : '80')
  return `${url.hostname.toLowerCase()}:${port}`
}

/**
 * The address a live page may show, normalised, or null. `allowance`: test-only loopback
 * `host:port`s (testLoopbackAllowance), never anything in a packaged app.
 */
export function parseLivePageUrl(raw: unknown, allowance: LoopbackAllowance = NO_ALLOWANCE): URL | null {
  if (typeof raw !== 'string' || !raw || raw.length > LIVE_PAGE_URL_MAX) return null
  let url: URL
  try { url = new URL(raw) } catch { return null }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username || url.password) return null
  if (!url.hostname) return null
  if (url.href.length > LIVE_PAGE_URL_MAX) return null
  if (classifyHost(url.hostname) === 'local' && !allowance.has(hostPortOf(url))) return null
  return url
}

/**
 * The loopback fixture a hidden e2e run may serve live pages from: `TW_E2E_LIVE_PAGE_ALLOW` =
 * `127.0.0.1:<port>` (comma-separated). Honoured only when the app is NOT packaged and runs under
 * the e2e flag; only literal 127.0.0.1 with an explicit port.
 */
export function testLoopbackAllowance(facts: { isPackaged: boolean; e2e: boolean; value: unknown }): LoopbackAllowance {
  if (facts.isPackaged || !facts.e2e || typeof facts.value !== 'string' || !facts.value) return NO_ALLOWANCE
  const out = new Set<string>()
  for (const part of facts.value.split(',')) {
    const entry = part.trim()
    const m = /^127\.0\.0\.1:(\d{2,5})$/.exec(entry)
    if (m && Number(m[1]) > 0 && Number(m[1]) < 65536) out.add(entry)
  }
  return out
}

export type SlotRect = { x: number; y: number; w: number; h: number }
export type SlotReport = {
  v: 1
  slideId: string
  url: string
  rect: SlotRect
  visible: boolean
  interact: boolean
  reloadSeq: number
  layoutWidth: number | null
  /** Presenter only: bumped by the deck's own Capture button; main saves the page's view once per bump. */
  captureSeq: number
  /** Presenter only: the saved views are shown instead of the live page, and which one. */
  gallery: { on: boolean; index: number }
  /** What Capture takes: the visible view (default) or the entire scrollable page (the Capture embed window's choice). */
  captureMode: 'view' | 'page'
  /** Presenter only: Pointer or Pen pressed on the live page (freeze), or Live asked for (want null). */
  freeze: FreezeRequest
}

const finite = (n: unknown, lo: number, hi: number): n is number => typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi

/** The deck's report, checked; null (no live page here) when anything is missing, extra or out of range. */
export function validateSlotReport(x: unknown): SlotReport | null {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null
  const r = x as Record<string, unknown>
  // The presenter's freeze request (live-page-freeze.ts) is optional on top of any of these.
  const keys = Object.keys(r).filter((k) => k !== 'freeze').sort().join(',')
  // The capture gallery's two fields are optional (a deck compiled before them still reports).
  // captureMode is optional on top of those (decks report none; the Capture embed window reports it).
  if (keys !== 'interact,layoutWidth,rect,reloadSeq,slideId,url,v,visible' && keys !== 'captureSeq,gallery,interact,layoutWidth,rect,reloadSeq,slideId,url,v,visible'
    && keys !== 'captureMode,captureSeq,gallery,interact,layoutWidth,rect,reloadSeq,slideId,url,v,visible') return null
  if ('captureMode' in r && r.captureMode !== 'view' && r.captureMode !== 'page') return null
  if (r.v !== 1) return null
  if (typeof r.slideId !== 'string' || r.slideId.length > 128) return null
  if (typeof r.url !== 'string' || !r.url || r.url.length > LIVE_PAGE_URL_MAX) return null
  if (typeof r.visible !== 'boolean' || typeof r.interact !== 'boolean') return null
  if (!finite(r.reloadSeq, 0, 1e9) || !Number.isInteger(r.reloadSeq)) return null
  if (r.layoutWidth !== null && !finite(r.layoutWidth, 1, 100_000)) return null
  const rect = r.rect as Record<string, unknown> | null
  if (!rect || typeof rect !== 'object' || Array.isArray(rect)) return null
  if (Object.keys(rect).sort().join(',') !== 'h,w,x,y') return null
  if (!finite(rect.x, -100_000, 100_000) || !finite(rect.y, -100_000, 100_000) || !finite(rect.w, 0, 100_000) || !finite(rect.h, 0, 100_000)) return null
  let freeze: FreezeRequest = { seq: 0, want: null }
  if ('freeze' in r) {
    const f = validateFreezeRequest(r.freeze)
    if (!f) return null
    freeze = f
  }
  let captureSeq = 0
  let gallery = { on: false, index: 0 }
  if ('captureSeq' in r) {
    if (!finite(r.captureSeq, 0, 1e9) || !Number.isInteger(r.captureSeq)) return null
    const g = r.gallery as Record<string, unknown> | null
    if (!g || typeof g !== 'object' || Array.isArray(g) || Object.keys(g).sort().join(',') !== 'index,on') return null
    if (typeof g.on !== 'boolean' || !finite(g.index, 0, 999) || !Number.isInteger(g.index)) return null
    captureSeq = r.captureSeq as number
    gallery = { on: g.on, index: g.index as number }
  }
  return {
    v: 1, slideId: r.slideId, url: r.url, visible: r.visible, interact: r.interact, reloadSeq: r.reloadSeq as number,
    layoutWidth: r.layoutWidth as number | null, captureSeq, gallery, captureMode: r.captureMode === 'page' ? 'page' : 'view', freeze,
    rect: { x: rect.x as number, y: rect.y as number, w: rect.w as number, h: rect.h as number }
  }
}

/**
 * The view's bounds in the window (DIP) from the slot's box in the deck (CSS px) and the deck's zoom,
 * clipped to the window's content; null when less than 40 DIP remains either way.
 */
export function slotToViewBounds(rect: SlotRect, deckZoom: number, content: { width: number; height: number }): { x: number; y: number; width: number; height: number } | null {
  const z = Number.isFinite(deckZoom) && deckZoom > 0 ? deckZoom : 1
  let x = Math.round(rect.x * z)
  let y = Math.round(rect.y * z)
  let right = Math.round((rect.x + rect.w) * z)
  let bottom = Math.round((rect.y + rect.h) * z)
  x = Math.max(0, x); y = Math.max(0, y)
  right = Math.min(Math.max(0, Math.floor(content.width)), right)
  bottom = Math.min(Math.max(0, Math.floor(content.height)), bottom)
  const width = right - x
  const height = bottom - y
  if (width < LIVE_PAGE_MIN_SIZE || height < LIVE_PAGE_MIN_SIZE) return null
  return { x, y, width, height }
}

/** The presenter view's zoom, so the page lays out at the audience's width: presenter slot / audience width, 0.25–1. */
export function presenterZoom(presenterSlotWidthDip: number, audienceLayoutWidthCss: number | null): number {
  const a = typeof audienceLayoutWidthCss === 'number' && Number.isFinite(audienceLayoutWidthCss) && audienceLayoutWidthCss > 0 ? audienceLayoutWidthCss : 1280
  const p = Number.isFinite(presenterSlotWidthDip) && presenterSlotWidthDip > 0 ? presenterSlotWidthDip : a
  return Math.min(1, Math.max(0.25, p / a))
}

/** The schemes a live page's session lets through at all; every other is cancelled. */
export const LIVE_PAGE_REQUEST_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:', 'data:', 'blob:'])

export type LivePageRequestScheme = 'cancel' | 'web' | 'pass'

/** First cut for a request of a live page's session: cancel any scheme not listed; web schemes go on to the local-address rule. */
export function livePageRequestScheme(url: unknown): LivePageRequestScheme {
  if (typeof url !== 'string') return 'cancel'
  let u: URL
  try { u = new URL(url) } catch { return 'cancel' }
  if (!LIVE_PAGE_REQUEST_SCHEMES.has(u.protocol)) return 'cancel'
  return u.protocol === 'data:' || u.protocol === 'blob:' ? 'pass' : 'web'
}

/** The view session's user agent: the app's, without the `Electron/…` and app tokens (some sites refuse those). */
export function livePageUserAgent(ua: string): string {
  return String(ua || '')
    .replace(/\s+Electron\/\S+/gi, '')
    .replace(/\s+(?:talk-weaver|TalkWeaver)\/\S+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export type LivePageStateName = 'loading' | 'live' | 'slow' | 'failed' | 'blocked'
export type LivePageState = { v: 1; slideId: string; state: LivePageStateName; host: string; httpStatus?: number; message?: string }

/** The state main sends the deck, as a JSON string literal safe to put inside a script. */
export function livePageStateScript(state: LivePageState): string {
  const clean: LivePageState = {
    v: 1,
    slideId: String(state.slideId).slice(0, 128),
    state: state.state,
    host: String(state.host).slice(0, 255),
    ...(typeof state.httpStatus === 'number' && Number.isInteger(state.httpStatus) ? { httpStatus: state.httpStatus } : {}),
    ...(typeof state.message === 'string' ? { message: state.message.slice(0, 200) } : {})
  }
  // JSON.stringify twice: the deck receives a string it parses itself; nothing is evaluated from page text.
  // Line and paragraph separators are legal inside a JS string literal (ES2019); `<` is escaped so no `</script>` can form.
  const json = JSON.stringify(JSON.stringify(clean)).replace(/</g, '\\u003c')
  return `window.__twLivePageState && window.__twLivePageState(${json})`
}

/** A call into the deck with one JSON value, as a string the deck parses itself (never evaluated page text). */
export function deckCallScript(fn: '__twLivePageGallery' | '__twLivePageCaptured' | '__twLivePageViews', value: unknown): string {
  const json = JSON.stringify(JSON.stringify(value)).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
  return `window.${fn} && window.${fn}(${json})`
}
