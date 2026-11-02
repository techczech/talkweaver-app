// "Entire page" saved view of a live web page (owner 2026-10-27: the whole SCROLLABLE page, not only
// what is on screen). Taken from the live view's own contents through Chromium's DevTools protocol on
// that view (`webContents.debugger`, main process only: the page cannot see, start or steer it):
//   Page.getLayoutMetrics  → the page's laid-out width and scrollable height (numbers, checked here)
//   Page.captureScreenshot → { format: 'jpeg', captureBeyondViewport: true, clip } of the page from the top
// Why this and not scroll-and-stitch or resizing the view: captureBeyondViewport paints the page as far
// as it is laid out without scrolling it, resizing the window or running any script in the page, so the
// person's scroll position and the page's state are left as they were (the host checks the scroll
// after and puts it back if it moved). What it cannot do, said in the window: parts of the page that
// load only when scrolled to (lazy pictures, endless feeds) are captured as they are now — blank or
// missing — and nothing is fetched to fill them.
// Bounds: stored at most MAX_CAPTURE_WIDTH wide (scaled down, never up) and MAX_CAPTURE_HEIGHT tall —
// a longer page is cut there and the saved view says so (`truncated`); the picture at most
// MAX_CAPTURE_IMAGE_BYTES; the whole capture at most WHOLE_PAGE_TIMEOUT_MS. The debugger is always
// detached afterwards; one already attached (developer tools open on the page) is refused, never taken over.
// No Electron import: the tests drive it with a fake debugger.
import { MAX_CAPTURE_HEIGHT, MAX_CAPTURE_IMAGE_BYTES, MAX_CAPTURE_WIDTH } from '../../compiler/scripts/lib/live-page-captures.mjs'

export const WHOLE_PAGE_TIMEOUT_MS = 20_000
export const WHOLE_PAGE_JPEG_QUALITY = 82

/** The part of Electron's `webContents.debugger` used here. */
export type CdpDebugger = {
  isAttached(): boolean
  attach(protocolVersion?: string): void
  detach(): void
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>
}

export type WholePageCapture =
  | { ok: true; jpeg: Uint8Array; width: number; height: number; cssWidth: number; cssHeight: number; pageHeight: number; truncated: boolean }
  | { ok: false; message: string }

export const WHOLE_PAGE_TEXT = {
  busy: 'Developer tools are open on this page, so the entire page cannot be captured. Close them, or capture the visible view.',
  unreadable: 'The page did not say how big it is, so the entire page was not captured.',
  slow: 'The entire page took too long to capture, so it was not saved. Try the visible view.',
  tooLarge: 'The entire page is too large to save as one picture. Try the visible view.',
  failed: 'The entire page could not be captured.'
} as const

const num = (v: unknown, min: number, max: number): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {})

/** The size the page is laid out at, from Page.getLayoutMetrics: CSS pixels, and the device pixel ratio. */
export function readLayoutMetrics(raw: unknown): { cssWidth: number; pageHeight: number; dpr: number } | null {
  const m = rec(raw)
  const viewport = rec(m.cssLayoutViewport)
  const content = rec(m.cssContentSize)
  const device = rec(m.contentSize)
  const cssWidth = num(viewport.clientWidth, 1, 16384)
  const pageHeight = num(content.height, 1, 10_000_000)
  const contentCssWidth = num(content.width, 1, 10_000_000)
  if (!cssWidth || !pageHeight || !contentCssWidth) return null
  // contentSize is the same size in device pixels (the deprecated field): their ratio is the DPR.
  const deviceWidth = num(device.width, 1, 40_000_000)
  const dpr = deviceWidth ? Math.min(4, Math.max(1, deviceWidth / contentCssWidth)) : 1
  return { cssWidth: Math.floor(cssWidth), pageHeight: Math.ceil(pageHeight), dpr }
}

/**
 * The clip to ask for: the page's width from the top, scaled so the picture is at most `maxWidth`
 * wide, and as tall as the page or as fits in `maxHeight` stored pixels (then `truncated`).
 */
export function wholePageClip(metrics: { cssWidth: number; pageHeight: number; dpr: number }, maxWidth = MAX_CAPTURE_WIDTH, maxHeight = MAX_CAPTURE_HEIGHT): { x: 0; y: 0; width: number; height: number; scale: number; truncated: boolean } {
  const scale = Math.min(1, maxWidth / (metrics.cssWidth * metrics.dpr))
  const fits = Math.floor(maxHeight / (metrics.dpr * scale))
  const height = Math.max(1, Math.min(metrics.pageHeight, fits))
  return { x: 0, y: 0, width: metrics.cssWidth, height, scale: Math.round(scale * 10000) / 10000, truncated: metrics.pageHeight > height }
}

/** A JPEG's pixel size from its frame header (SOF0–SOF15 but DHT/JPG/DAC), bounded; null if none. */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let at = 2
  for (let steps = 0; at + 9 < bytes.length && steps < 4096; steps++) {
    if (bytes[at] !== 0xff) return null
    const marker = bytes[at + 1]
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue }
    const length = (bytes[at + 2] << 8) | bytes[at + 3]
    if (length < 2) return null
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = (bytes[at + 5] << 8) | bytes[at + 6]
      const width = (bytes[at + 7] << 8) | bytes[at + 8]
      return width > 0 && height > 0 ? { width, height } : null
    }
    at += 2 + length
  }
  return null
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/** The entire scrollable page (as loaded) of the view whose debugger this is, as one bounded JPEG. */
export async function captureWholePage(dbg: CdpDebugger, timeoutMs = WHOLE_PAGE_TIMEOUT_MS): Promise<WholePageCapture> {
  let attached = false
  try { if (dbg.isAttached()) return { ok: false, message: WHOLE_PAGE_TEXT.busy } } catch { return { ok: false, message: WHOLE_PAGE_TEXT.failed } }
  try { dbg.attach('1.3'); attached = true } catch { return { ok: false, message: WHOLE_PAGE_TEXT.busy } }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs) })
  const work = (async (): Promise<WholePageCapture> => {
    const metrics = readLayoutMetrics(await dbg.sendCommand('Page.getLayoutMetrics'))
    if (!metrics) return { ok: false, message: WHOLE_PAGE_TEXT.unreadable }
    const clip = wholePageClip(metrics)
    const shot = rec(await dbg.sendCommand('Page.captureScreenshot', {
      format: 'jpeg', quality: WHOLE_PAGE_JPEG_QUALITY, captureBeyondViewport: true, fromSurface: true,
      clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: clip.scale }
    }))
    const data = typeof shot.data === 'string' ? shot.data : ''
    // Checked before it is decoded: base64 of at most the picture limit.
    if (!data || data.length > Math.ceil(MAX_CAPTURE_IMAGE_BYTES / 3) * 4 || !BASE64.test(data)) return { ok: false, message: data ? WHOLE_PAGE_TEXT.tooLarge : WHOLE_PAGE_TEXT.failed }
    const jpeg = new Uint8Array(Buffer.from(data, 'base64'))
    const size = jpegSize(jpeg)
    if (!size || jpeg[2] !== 0xff) return { ok: false, message: WHOLE_PAGE_TEXT.failed }
    // The stored size is checked as it came back (the protocol's own rounding allowed one pixel).
    if (size.width > MAX_CAPTURE_WIDTH + 1 || size.height > MAX_CAPTURE_HEIGHT + 1 || jpeg.length > MAX_CAPTURE_IMAGE_BYTES) return { ok: false, message: WHOLE_PAGE_TEXT.tooLarge }
    return {
      ok: true, jpeg, width: Math.min(size.width, MAX_CAPTURE_WIDTH), height: Math.min(size.height, MAX_CAPTURE_HEIGHT),
      cssWidth: clip.width, cssHeight: clip.height, pageHeight: metrics.pageHeight, truncated: clip.truncated
    }
  })()
  try {
    const result = await Promise.race([work.catch((): WholePageCapture => ({ ok: false, message: WHOLE_PAGE_TEXT.failed })), timeout])
    return result === 'timeout' ? { ok: false, message: WHOLE_PAGE_TEXT.slow } : result
  } finally {
    if (timer) clearTimeout(timer)
    if (attached) { try { dbg.detach() } catch { /* already gone */ } }
    work.catch(() => { /* settled after a timeout: ignored */ })
  }
}
