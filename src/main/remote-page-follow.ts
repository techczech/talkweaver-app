// A web page on a slide, presented from the presenter window: the audience window's copy follows the
// scrolling the presenter does in the Current pane (Interact / `e`, then the wheel or the trackpad).
//
// Why main does it: the page is another site's, so neither deck window can read or set its scroll
// position (cross-origin), and a page cannot be mirrored the way a local page is (the embed channel
// needs the page's own agent). Main can reach a frame of any site through WebFrameMain, so it reads
// the pane's scroll position and sets the same position, as a fraction of the scrollable length, in
// the audience window's frames that show the same address.
//
// What it runs inside the page, and nothing else: one fixed expression that reads four numbers
// (READ_SCROLL) and one that calls scrollTo with two numbers main formats itself (scrollToScript). No
// text from the page is ever put into a script; what the page answers is used only when it is four
// finite numbers. The page gains nothing: no bridge, no message, no access to the deck. A page can
// lie about its position or ignore scrollTo, which only spoils its own following.
//
// Which frames: only direct child frames of each deck page, on http(s). In the presenter window, the
// frame named `tw-remote-pane` (the deck runtime names the Current pane's frame before it loads); in
// the audience window, every frame whose address is exactly the pane's. A page can rename its own
// frame; the address must still match exactly, so at worst one copy of the same page follows another.
// One read at a time per window pair: a page that does not answer is not asked again until it does.
// A read answers later than it was asked. Its answer is used only if the pane is still the same frame
// at the same address and no frame of the presenter has loaded a document since (a reload at the same
// address included); otherwise it is dropped and the next tick reads the page the pane now shows.
import type { WebContents } from 'electron'

export const PANE_FRAME_NAME = 'tw-remote-pane'
export const FOLLOW_INTERVAL_MS = 200
const READ_TIMEOUT_MS = 1000

/** Read inside the pane's page: [scrollX, scrollY, scrollable width, scrollable height]. */
export const READ_SCROLL = '(() => { const s = document.scrollingElement || document.documentElement; return [scrollX, scrollY, s.scrollWidth - innerWidth, s.scrollHeight - innerHeight] })()'

/** The pane's position as fractions of its scrollable length, or null unless the answer is four finite numbers. */
export function scrollFraction(value: unknown): { fx: number; fy: number } | null {
  if (!Array.isArray(value) || value.length !== 4 || !value.every((v) => typeof v === 'number' && Number.isFinite(v))) return null
  const [x, y, maxX, maxY] = value as number[]
  const part = (at: number, max: number): number => (max > 0 ? Math.min(1, Math.max(0, at / max)) : 0)
  return { fx: part(x, maxX), fy: part(y, maxY) }
}

/** The script that puts a page at the given fractions; the numbers are clamped and formatted here. */
export function scrollToScript(fx: number, fy: number): string {
  const clamp = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)
  const a = clamp(fx).toFixed(5)
  const b = clamp(fy).toFixed(5)
  return `(() => { const s = document.scrollingElement || document.documentElement; scrollTo(Math.round(${a} * (s.scrollWidth - innerWidth)), Math.round(${b} * (s.scrollHeight - innerHeight))) })()`
}

export function isWebPageUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false
  try { const u = new URL(url); return u.protocol === 'https:' || u.protocol === 'http:' } catch { return false }
}

export type FollowFrame = { readonly name: string; readonly url: string; readonly processId?: number; readonly routingId?: number; executeJavaScript(code: string, userGesture?: boolean): Promise<unknown> }
type NavigateListener = (...args: unknown[]) => void
export type FollowContents = {
  isDestroyed(): boolean
  readonly mainFrame: { readonly frames: readonly FollowFrame[] }
  on?(event: 'did-frame-navigate', listener: NavigateListener): unknown
  removeListener?(event: 'did-frame-navigate', listener: NavigateListener): unknown
}

/** The same frame: the same object, or (WebFrameMain) the same process and routing id. */
function sameFrame(a: FollowFrame, b: FollowFrame | undefined): boolean {
  if (!b) return false
  if (a === b) return true
  return typeof a.processId === 'number' && typeof a.routingId === 'number' && a.processId === b.processId && a.routingId === b.routingId
}

function webFrames(contents: FollowContents, keep: (frame: FollowFrame) => boolean): FollowFrame[] {
  try {
    if (contents.isDestroyed()) return []
    return contents.mainFrame.frames.filter((frame) => isWebPageUrl(frame.url) && keep(frame))
  } catch { return [] }
}

export type FollowTimers = { setInterval: (fn: () => void, ms: number) => unknown; clearInterval: (handle: unknown) => void; setTimeout: (fn: () => void, ms: number) => unknown }

/**
 * Makes the audience window's copies of a web page follow the presenter pane's scrolling until either
 * window is gone or the answer is called. Returns the stop function (safe to call more than once).
 */
export function followRemotePages(presenter: FollowContents | WebContents, audience: FollowContents | WebContents, timers: FollowTimers = globalThis as unknown as FollowTimers): () => void {
  const source = presenter as FollowContents
  const target = audience as FollowContents
  let last = ''
  let reading = false
  let stopped = false
  // Counts documents loaded by any frame of the presenter window (did-frame-navigate is cross-document only).
  let loads = 0
  const loaded: NavigateListener = () => { loads++ }
  try { source.on?.('did-frame-navigate', loaded) } catch { /* a window without events: frame and address checks only */ }
  const stop = (): void => {
    if (stopped) return
    stopped = true
    timers.clearInterval(handle)
    try { source.removeListener?.('did-frame-navigate', loaded) } catch { /* already gone */ }
  }
  const paneOf = (): FollowFrame | undefined => webFrames(source, (frame) => frame.name === PANE_FRAME_NAME)[0]
  const tick = async (): Promise<void> => {
    if (stopped || reading) return
    if (source.isDestroyed() || target.isDestroyed()) { stop(); return }
    const pane = paneOf()
    if (!pane) { last = ''; return }
    const url = pane.url
    const loadsAtRead = loads
    // One read outstanding at a time: `reading` clears when this read settles, however late.
    reading = true
    const read = pane.executeJavaScript(READ_SCROLL, false).then((value) => ({ value }), () => null)
    void read.then(() => { reading = false })
    const result = await Promise.race([read, new Promise<null>((resolve) => { timers.setTimeout(() => resolve(null), READ_TIMEOUT_MS) })])
    if (!result || stopped) return
    if (source.isDestroyed() || target.isDestroyed()) { stop(); return }
    // The answer describes the document that was asked; drop it if the pane has moved on since.
    const now = paneOf()
    if (loads !== loadsAtRead || !sameFrame(pane, now) || now?.url !== url) return
    const at = scrollFraction(result.value)
    if (!at) return
    const copies = webFrames(target, (frame) => frame.url === url)
    // Set again when the pane moves, and when a copy (re)appears in the audience window.
    const key = `${url}\n${copies.length}\n${at.fx.toFixed(4)},${at.fy.toFixed(4)}`
    if (key === last) return
    last = key
    const script = scrollToScript(at.fx, at.fy)
    for (const frame of copies) frame.executeJavaScript(script, false).catch(() => { /* the page went away or refused */ })
  }
  const handle = timers.setInterval(() => { void tick() }, FOLLOW_INTERVAL_MS)
  return stop
}
