// Where a page may navigate its own window (a link without target, location.href = …, a form, a
// server redirect). Every window here loads one of the app's own pages with a preload behind it —
// the editor / Tools / Pathways windows the whole window.tw bridge, the presenter window the recorder
// and live-poll bridges — so a top-level navigation to anything else would hand that bridge to a
// page the app does not own. Installed once for every webContents (app 'web-contents-created').
//
// A main-frame navigation is allowed only within the page's own origin:
//   - file: the same file it is showing, with any query or hash (the renderer index with ?view=,
//     the compiled deck with ?presenter=1 / ?audience=1 / a slide hash);
//   - an http(s) page's own origin, from a page already on it (the dev server, ELECTRON_RENDERER_URL,
//     in development; a page main itself loaded over http);
//   - an app scheme (twpresent:, twasset:, …), from a page on the same scheme and host;
// A web or mail link goes to the OS instead (shell.openExternal) and the window stays put. Anything
// else — another file, a data:/javascript: URL, an app scheme from another page — is refused.
// Server redirects use the same rule, but a refused one is never handed to the OS. Before a window
// has shown its first page, its first load (started by main, or let through by the opener's
// window-open handler) may go to a local page and its redirects are not judged.
//
// WHO starts the navigation matters as much as where it goes. A navigation of a window's main frame
// goes on to the destination rule above only when its starter is one of these (Electron names the
// starter on `will-navigate` and `will-redirect`: `initiator`, a WebFrameMain):
//   - nobody (`initiator` absent or null);
//   - the window's own page: `initiator` IS `contents.mainFrame` (a link, a form, `location = …`,
//     `location.reload()`, `history.back()` on the page itself);
//   - the page of the window that OPENED this one, and then only to the opener's own deck file
//     with any query or hash: the presenter's Audience button and the plain deck's Presenter button
//     call `window.open(<the deck>?audience=1 | ?presenter=1, <name>)`, and Electron reports that
//     load, in the new window and again when the named window is reused, as started by the
//     opener's main frame.
// ANY other starter is refused wherever the navigation points — never handed to the OS, never
// opened — and logged: a frame inside the page (`top.location`, `parent.location`, a `_top` link or
// form in an embedded page), the page of another window (a pop-up moving its opener, an opener
// moving a pop-up anywhere but to its own deck), and a starter that cannot be read.
// Observed in Electron 42 (hidden-window run, 2026-10-07): loadFile / loadURL, webContents.reload(),
// goBack() and a hash change raise no `will-navigate` at all; a blank window being created raises
// none either. No page of the app moves a window from a frame or from another window otherwise.
// (`will-frame-navigate` carries the same field; its main-frame case is left to `will-navigate`,
// and for a subframe the frame rule below does not depend on who started it. `did-start-navigation`
// carries it too but cannot be prevented.)
//
// Handing a link to the OS can be vetoed (`opts.refuseHandOut`): index.ts uses it for EVERY window,
// so no window hands out a local address or anything from a blank page (hand-out.ts). What is handed out is always the normalised
// href of the parsed link, never the string the page supplied.
//
// A HIDDEN RENDERER (`opts.isHiddenRenderer`: the thumbnail capture window) has nobody in front of
// it, so there is no click to honour: its main frame may go only to the file it is showing (another
// query or hash); every other navigation is refused, nothing is handed to the OS and no sibling
// page is opened.
//
// Programmatic loads from main (loadFile / loadURL, ⌘R refresh), reload, back/forward and in-page
// hash changes never reach these events. window.open is left to each window's own handler.
//
// FRAMES (deck previews over twpresent://preview/<id>, replay iframes, embeds) are not judged by the
// rule above, but they are not free either (ADR-0036): a frame inside any of the app's windows may
// go only to a page that carries its own content or lives on the web or in an app scheme —
// about:blank / about:srcdoc, blob:, data:, http(s):, twpresent: and the other app schemes. A frame
// navigation to a `file:` address (an embedded page sending its own frame, or a frame it added, to
// a file on this Mac) is refused; so is any scheme not on that list. Nothing the app itself puts in
// a frame is a file: address (embeds are http(s), local simulations are srcdoc then blob:, previews
// and replays are twpresent:). Judged on `will-frame-navigate`, for every webContents.
// One more scheme, for one kind of window: a frame inside a DevTools window (a webContents whose own
// page is `devtools:`) may go to a `devtools:` page. No app window can be on `devtools:` (the rule
// above refuses that navigation), so this opens nothing to a deck, the editor or an embedded page.
//
// This frame rule is the BACKSTOP, not the main defence (embed-sandbox design, decision 9): a
// sandboxed embedded page has an opaque origin and Chromium refuses its `file:` navigation before
// this event is raised. The rule is what holds for a frame that is not sandboxed: a deck compiled
// by an older version, a frame added by a later feature.
// Verified at run time on 2026-10-07 in the packaged app (0.38.0-preview.3): the event is raised for
// a frame's own navigation and for a frame added by script, and preventing it is honoured. In
// presenter, audience, plain deck and thumbnail windows every subframe `file:` navigation was refused
// (19 refusals per run across the four window kinds) and nothing legitimate was refused.
import type { App, WebContents } from 'electron'
import { fileURLToPath } from 'url'
import { isSameDeckFile } from './present-window-open.ts'
import { handOutLink } from './hand-out.ts'

/** The app's custom schemes (registered as privileged in index.ts; a test keeps the lists in step). */
export const APP_SCHEMES = ['twasset', 'twthumb', 'twarchive', 'twfile', 'twrec', 'twpresent'] as const

export type NavigationDecision = 'allow' | 'external' | 'open-local' | 'deny'

const LOCAL_PAGE = /\.html?$/i

function dirOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut < 0 ? '' : path.slice(0, cut + 1)
}

function parse(url: unknown): URL | null {
  if (typeof url !== 'string' || !url) return null
  try { return new URL(url) } catch { return null }
}

function decodedPath(u: URL): string | null {
  try { return decodeURIComponent(u.pathname) } catch { return null }
}

function isAppScheme(u: URL): boolean {
  return (APP_SCHEMES as readonly string[]).includes(u.protocol.slice(0, -1))
}

/** A link the OS should open, in the normalised form that is handed out (hand-out.ts); null otherwise. */
export function externalLinkOf(url: unknown): string | null {
  return handOutLink(url)?.href ?? null
}

const isWeb = (u: URL): boolean => (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname

/**
 * `from`: the page's current URL; `to`: where it wants to go; `initial`: the window has not shown a
 * page yet — its first load was started by main or let through by the opener's window-open handler
 * (a deck's audience window: the deck file; the board window: about:blank), so a local page
 * (file:, about:blank, an app scheme) is allowed. A web page still goes to the OS.
 */
export function decideNavigation({ from, to, initial = false }: { from: string; to: string; initial?: boolean }): NavigationDecision {
  const target = parse(to)
  if (!target) return 'deny'
  if (initial && (target.protocol === 'file:' || target.href === 'about:blank' || isAppScheme(target))) return 'allow'
  const here = parse(from)
  if (here) {
    if (target.protocol === 'file:' && here.protocol === 'file:') {
      const a = decodedPath(target)
      const b = decodedPath(here)
      if (a !== null && a === b && target.host === here.host && a !== '' && a !== '/') return 'allow'
      // A deck's action button to a sibling page ([Action: More → further-reading.html]) is a relative
      // link with no target. The page is the author's, beside the deck in the talk folder, but it is
      // not the app's: it opens in the default browser rather than in this window with its bridges.
      if (a !== null && b !== null && target.host === here.host && LOCAL_PAGE.test(a) && dirOf(a) !== '' && dirOf(a) === dirOf(b)) return 'open-local'
    }
    if (isWeb(here) && isWeb(target) && here.origin === target.origin) return 'allow'
    if (isAppScheme(target) && target.protocol === here.protocol && target.host === here.host && target.host !== '') return 'allow'
  }
  return externalLinkOf(target.href) ? 'external' : 'deny'
}

export type NavigationStarter = 'page' | 'opener-page' | 'other'

type FrameRef = { parent?: unknown } | null | undefined

/**
 * Who started a main-frame navigation. `initiator`: the event's field. `mainFrame`: this window's
 * main frame now. `openerFrames`: the main frame(s) of the window that opened this one (as Electron
 * records it, and as the guard tracked it; either may be absent).
 */
export function navigationStarter(who: { initiator: unknown; mainFrame?: unknown; openerFrames?: readonly unknown[] }): NavigationStarter {
  const { initiator } = who
  if (initiator === null || initiator === undefined) return 'page'
  if (typeof initiator !== 'object') return 'other'
  if (who.mainFrame !== null && who.mainFrame !== undefined && initiator === who.mainFrame) return 'page'
  for (const opener of who.openerFrames ?? []) {
    if (opener === null || opener === undefined || initiator !== opener) continue
    try { if ((opener as FrameRef)?.parent === null) return 'opener-page' } catch { return 'other' }
  }
  return 'other'
}

/**
 * A main-frame navigation: whether its starter may move the window at all, then where it may go.
 * `openerUrl`: the page the opener is showing (for 'opener-page': only its own deck file is allowed).
 */
export function decideStartedNavigation(request: { from: string; to: string; initial?: boolean; starter: NavigationStarter; openerUrl?: string }): NavigationDecision {
  if (request.starter === 'other') return 'deny'
  if (request.starter === 'opener-page' && !isSameDeckFile(request.to, request.openerUrl)) return 'deny'
  if (request.starter !== 'page' && request.starter !== 'opener-page') return 'deny'
  return decideNavigation({ from: request.from, to: request.to, initial: request.initial })
}

export type FrameNavigationDecision = 'allow' | 'deny'

/**
 * May a frame go to `to`? `isMainFrame`: the navigation is the window's own page (judged by
 * decideNavigation, so always 'allow' here). `top` is the window's own page URL; it does not widen
 * anything for an app window — a frame may not load a file even when it is the very file the window
 * shows. Its one use: a frame of a DevTools window (`top` on `devtools:`) may go to `devtools:`.
 */
export function decideFrameNavigation({ to, isMainFrame, top }: { to: string; isMainFrame: boolean; top?: string }): FrameNavigationDecision {
  if (isMainFrame) return 'allow'
  const target = parse(to)
  if (!target) return 'deny'
  if (target.protocol === 'about:') return target.href === 'about:blank' || target.href === 'about:srcdoc' ? 'allow' : 'deny'
  if (target.protocol === 'blob:' || target.protocol === 'data:') return 'allow'
  if (target.protocol === 'http:' || target.protocol === 'https:') return target.hostname ? 'allow' : 'deny'
  if (isAppScheme(target)) return 'allow'
  if (target.protocol === 'devtools:') return parse(top)?.protocol === 'devtools:' ? 'allow' : 'deny'
  return 'deny' // file:, javascript:, filesystem:, anything else
}

type GuardOpts = {
  openExternal: (url: string) => unknown
  /** Opens a local page (a deck's sibling HTML file) in the default app; refused when absent. */
  openPath?: (path: string) => unknown
  log?: (message: string) => void
  /**
   * Asked before a web or mail link is handed to the OS: a reason refuses it (logged), null lets it
   * go. `from` is the page the window shows.
   */
  refuseHandOut?: (contents: unknown, link: string, from: string) => string | null
  /** A window nobody sees or presses in: it navigates nowhere and hands nothing out. */
  isHiddenRenderer?: (contents: unknown) => boolean
}

type GuardedContents = Pick<WebContents, 'on' | 'getURL'> & { mainFrame?: unknown; opener?: unknown }
type OpenerContents = { mainFrame?: unknown; getURL?: () => string } | null | undefined

type NavEvent = { preventDefault: () => void; url?: string; isMainFrame?: boolean; initiator?: unknown }
type FrameNavEvent = NavEvent & { frame?: { parent?: unknown } | null }

/** The will-navigate / will-redirect / will-frame-navigate listeners for one webContents (exported for the test). */
export function guardWebContents(contents: GuardedContents, opts: GuardOpts, openerContents: () => OpenerContents = () => null): void {
  const log = opts.log ?? console.warn
  let shown = false // a main-frame page has committed (did-navigate)
  let firstUrl = '' // where the first main-frame load (started by main or the open handler) was going
  const check = (kind: 'navigate' | 'redirect', event: NavEvent, url: string, isMainFrame: boolean | undefined): void => {
    const to = typeof event.url === 'string' ? event.url : url
    if ((event.isMainFrame ?? isMainFrame) === false) return
    let from = ''
    try { from = contents.getURL() } catch { /* destroyed: judged with no page */ }
    // A redirect during the first load is judged against where that load was going (the dev
    // server's own origin, the deck's own file), never let through blindly: a misbehaving dev server
    // must not hand the preload to another site (Codex review on PR #8). Never sent to the OS.
    let initiator: unknown
    try { initiator = event.initiator } catch { initiator = 'unreadable' }
    // Who started it: nobody, this page, or the opener's page going to its own deck. Anyone else is
    // refused wherever it points, never sent to the OS.
    let starter: NavigationStarter = 'other'
    let openerUrl = ''
    try {
      const opener = openerContents()
      const recorded = contents.opener as { url?: unknown } | null | undefined
      starter = navigationStarter({ initiator, mainFrame: contents.mainFrame, openerFrames: [recorded, opener?.mainFrame] })
      if (starter === 'opener-page') {
        openerUrl = initiator === recorded && typeof recorded?.url === 'string' ? recorded.url : String(opener?.getURL?.() ?? '')
      }
    } catch { starter = 'other' }
    if (starter === 'other' || (starter === 'opener-page' && !isSameDeckFile(to, openerUrl))) {
      event.preventDefault()
      const who = starter === 'opener-page' ? 'the window that opened it, to a page that is not its own deck' : 'a frame inside the page or another window'
      log(`[navigation] refused ${kind} of the window to ${String(to).slice(0, 200)} started by ${who} (the window shows ${from.slice(0, 200) || 'no page yet'})`)
      return
    }
    let hidden = false
    try { hidden = !!opts.isHiddenRenderer && opts.isHiddenRenderer(contents) === true } catch { hidden = true }
    if (hidden) {
      // Main loads this window with loadFile, which raises no event: anything here was started by the page.
      if (decideNavigation({ from, to }) === 'allow') return
      event.preventDefault()
      log(`[navigation] refused ${kind} of a hidden renderer to ${String(to).slice(0, 200)} from ${from.slice(0, 200)}`)
      return
    }
    const decision = kind === 'redirect' && !shown
      ? (firstUrl ? decideNavigation({ from: firstUrl, to }) : decideNavigation({ from, to, initial: true }))
      : decideNavigation({ from, to, initial: !shown })
    if (decision === 'allow') return
    event.preventDefault()
    if (kind === 'navigate' && decision === 'open-local' && opts.openPath) {
      let path = ''
      try { path = fileURLToPath(to) } catch { /* unparseable: refused below */ }
      if (path) {
        try {
          void Promise.resolve(opts.openPath(path)).catch((e) => log(`[navigation] could not open ${path}: ${String(e)}`))
        } catch (e) { log(`[navigation] could not open ${path}: ${String(e)}`) }
        return
      }
    }
    const link = kind === 'navigate' && decision === 'external' ? externalLinkOf(to) : null
    if (link) {
      let refusal: string | null = null
      try { refusal = opts.refuseHandOut ? opts.refuseHandOut(contents, link, from) : null } catch { refusal = 'the hand-out rule could not be asked' }
      if (refusal) { log(`[navigation] refused to hand ${link.slice(0, 200)} to the OS from ${from.slice(0, 200)}: ${refusal}`); return }
      try {
        void Promise.resolve(opts.openExternal(link)).catch((e) => log(`[navigation] could not open ${link}: ${String(e)}`))
      } catch (e) { log(`[navigation] could not open ${link}: ${String(e)}`) }
      return
    }
    log(`[navigation] refused ${kind} to ${String(to).slice(0, 200)} from ${from.slice(0, 200)}`)
  }
  const on = contents.on.bind(contents) as (event: string, listener: (...args: any[]) => void) => unknown
  on('did-navigate', () => { shown = true })
  on('did-start-navigation', (details: { url?: string; isMainFrame?: boolean } | undefined, url?: string, _inPlace?: boolean, isMainFrame?: boolean) => {
    if (shown || firstUrl) return
    if ((details?.isMainFrame ?? isMainFrame) === false) return
    const start = typeof details?.url === 'string' ? details.url : url
    if (typeof start === 'string') firstUrl = start
  })
  on('will-navigate', (event: NavEvent, url: string, _inPlace?: boolean, isMainFrame?: boolean) => check('navigate', event, url, isMainFrame))
  on('will-redirect', (event: NavEvent, url: string, _inPlace?: boolean, isMainFrame?: boolean) => check('redirect', event, url, isMainFrame))
  // Frames: fired for the main frame too, which the listeners above already judge.
  on('will-frame-navigate', (event: FrameNavEvent) => {
    const isMainFrame = event?.isMainFrame ?? (event?.frame ? event.frame.parent == null : true)
    if (isMainFrame) return
    const to = typeof event.url === 'string' ? event.url : ''
    let top = ''
    try { top = contents.getURL() } catch { /* destroyed */ }
    if (decideFrameNavigation({ to, isMainFrame: false, top }) === 'allow') return
    event.preventDefault()
    log(`[navigation] refused frame navigation to ${to.slice(0, 200)} in ${top.slice(0, 200)}`)
  })
}

/** Install once, before the first window: guards every webContents the app ever creates. */
export function installNavigationGuard(app: Pick<App, 'on'>, opts: GuardOpts): void {
  // Which window opened which (window.open): the opener's main frame NOW is what a later navigation
  // of the child is compared with, so a refreshed presenter still reaches its audience window.
  const openers = new WeakMap<object, OpenerContents & object>()
  app.on('web-contents-created', (_event, contents) => {
    guardWebContents(contents, opts, () => openers.get(contents) ?? null)
    const on = contents.on.bind(contents) as (event: string, listener: (...args: any[]) => void) => unknown
    on('did-create-window', (child: { webContents?: object } | undefined) => {
      if (child?.webContents) openers.set(child.webContents, contents as unknown as OpenerContents & object)
    })
  })
}
