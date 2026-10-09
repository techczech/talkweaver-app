// What a window.open (or a target="_blank" link) may open, decided in main for every window the app
// creates. An Electron child window that is allowed inherits its opener's webPreferences, preload
// included: a remote page opened from the presenter window would run beside the recorder and
// live-poll bridges (sandbox off), one opened from the editor beside the whole window.tw bridge. So
// nothing but the app's own pages opens in-app; a web or mail link goes to the default browser /
// mail app, and anything else is refused.
//
// Deck windows (presenter / presentation window / audience, and the children they open) may open:
//   - the same compiled deck file with another query or hash: F5 / the Audience button in the
//     presenter (?audience=1), the presentation window's Presenter button (?presenter=1) — the
//     runtime builds both from location.href, so they are the opener's own file;
//   - the board window: about:blank under the frame name `tw-board-window` (feedback-boards ticket
//     05; drawn by the presenter window). Any other page under that name is refused outright, never
//     sent to the browser;
//   - a blank page the deck writes itself: about:blank (window.open("")) from a deck file, under any
//     other name — My Notes' Print page (ADR-0033) and the preflight pop-up test write their own
//     HTML into it. Its content is the deck's, and the navigation guard keeps it from being moved
//     to a remote page afterwards.
// Editor, Tools and Pathways windows open nothing in-app (the renderer has no window.open; its deck
// preview iframes do have links).
//
// A deck window hands a web or mail link to the OS only within five seconds of a real key or mouse
// press in THAT window (embed-sandbox design 2.4; main records presses, recent-press.ts). A browser's
// pop-up blocker asks the same of a page; Electron asks nothing, so a page embedded in a slide could
// otherwise open any address in the default browser with no press at all. Without a recent press the
// link is refused and logged. The rule is for deck windows only, where embedded pages run.
// The same press is asked before a BLANK window opens (the board, a blank page): an allowed child
// inherits the opener's preload, and nothing in the deck opens one without a press (the board's
// pop-out button and menu item). The deck's own pages (Audience, Presenter) need none.
//
// What is handed to the OS is also limited (hand-out.ts), on every route — this handler, the
// editor windows' handler below, and the navigation guard's external links for every window that is
// not one of the app's own (index.ts gives the guard `refuseHandOut`):
//   - the link is parsed once and handed out as that parsed object's normalised href, never as the
//     string a page supplied; only http:, https: and mailto:, at most 2,000 characters;
//   - never a web link whose host is local as written: a loopback, private, link-local or
//     carrier-NAT address in any spelling, `localhost`, `*.localhost`, `*.local`. The request filter
//     never sees a link the BROWSER opens, so without this a page in a slide could have the owner's
//     browser send a GET to a service on this Mac. A name is not resolved: a public name that
//     resolves to this Mac is not caught;
//   - nothing at all from a blank page navigating itself (a board or blank child window).
import type { HandlerDetails, WebContents, WindowOpenHandlerResponse } from 'electron'
import { contentHandOutRefusal, handOutLink, type ContentHandOutRefusal } from './hand-out.ts'

export const BOARD_WINDOW_NAME = 'tw-board-window'

export type PresentWindowOpen = 'allow-deck' | 'allow-board' | 'allow-blank' | 'external' | 'deny'
export type AppWindowOpen = 'external' | 'deny'

function parse(url: unknown): URL | null {
  if (typeof url !== 'string' || !url) return null
  try { return new URL(url) } catch { return null }
}

function decodedPath(u: URL): string | null {
  try { return decodeURIComponent(u.pathname) } catch { return null }
}

/** A link the OS should open, in the normalised form that is handed out (hand-out.ts); null otherwise. */
export function externalLinkOf(url: unknown): string | null {
  return handOutLink(url)?.href ?? null
}

/** `url` is the deck file `deckUrl` (a file: URL) itself, whatever its query and hash. */
export function isSameDeckFile(url: unknown, deckUrl: unknown): boolean {
  const a = parse(url)
  const b = parse(deckUrl)
  if (!a || !b || a.protocol !== 'file:' || b.protocol !== 'file:') return false
  if (a.host !== b.host) return false
  const pa = decodedPath(a)
  const pb = decodedPath(b)
  return pa !== null && pa === pb && pa !== '' && pa !== '/'
}

/**
 * The app's own audience page: a compiled deck, which the app always loads from a file: URL, with
 * ?audience=1. A web page, even one carrying ?audience=1, is not. Gates the chime unlock in main.
 */
export function isAppAudienceUrl(url: unknown): boolean {
  const u = parse(url)
  return !!u && u.protocol === 'file:' && u.searchParams.get('audience') === '1'
}

/** `deckUrl`: the opener's current URL (the compiled deck, a file: URL; about:blank for the board). */
export function decidePresentWindowOpen(details: { url: string; frameName?: string; deckUrl: string }): PresentWindowOpen {
  const { url, frameName, deckUrl } = details
  if (frameName === BOARD_WINDOW_NAME) return url === 'about:blank' ? 'allow-board' : 'deny'
  if (isSameDeckFile(url, deckUrl)) return 'allow-deck'
  if (url === 'about:blank' && parse(deckUrl)?.protocol === 'file:') return 'allow-blank'
  return externalLinkOf(url) ? 'external' : 'deny'
}

export function decideAppWindowOpen(url: string): AppWindowOpen {
  return externalLinkOf(url) ? 'external' : 'deny'
}

type Opts = {
  /** Hands a web / mail link to the OS. */
  openExternal: (url: string) => unknown
  /** Extra options for the deck windows that are allowed (E2E: keep them hidden). */
  allowOptions?: Pick<WindowOpenHandlerResponse, 'overrideBrowserWindowOptions'>
  log?: (message: string) => void
}

/** A deck window's options: who pressed. Absent, no link is handed to the OS (the rule fails closed). */
type DeckOpts = Opts & {
  /** A real key or mouse press reached this window's page in the last five seconds. */
  pressedRecently?: (contents: { id: number }) => boolean
}

export type DeckHandOutRefusal = ContentHandOutRefusal

/** The content rule (hand-out.ts `contentHandOutRefusal`), under the name the deck handler has used. */
export function deckHandOutRefusal(request: { url: unknown; from?: unknown }): DeckHandOutRefusal | null {
  return contentHandOutRefusal(request)
}

/** Hands a link out: parsed once, judged by the content rule, and passed on as that same normalised href. */
function sendOut(url: string, opts: Opts): void {
  const log = opts.log ?? console.warn
  const link = handOutLink(url)
  const refusal = link ? contentHandOutRefusal({ url: link.href }) : 'not a link that can be handed out'
  if (!link || refusal) { log(`[window-open] refused to hand ${String(link?.href ?? url).slice(0, 200)} to the OS: ${refusal}`); return }
  try {
    void Promise.resolve(opts.openExternal(link.href)).catch((e) => log(`[window-open] could not open ${link.href}: ${String(e)}`))
  } catch (e) { log(`[window-open] could not open ${link.href}: ${String(e)}`) }
}

/**
 * The setWindowOpenHandler for a deck window; `deckUrl()` reads the opener's current URL and
 * `pressedRecently()` says whether a real press reached that window in the last five seconds.
 */
export function presentWindowOpenHandler(deckUrl: () => string, opts: Opts, pressedRecently: () => boolean = () => false): (details: HandlerDetails) => WindowOpenHandlerResponse {
  return (details) => {
    const decision = decidePresentWindowOpen({ url: details.url, frameName: details.frameName, deckUrl: deckUrl() })
    if (decision === 'allow-deck') return { action: 'allow', ...(opts.allowOptions ?? {}) }
    let pressed = false
    try { pressed = pressedRecently() === true } catch { pressed = false }
    if (decision === 'allow-board' || decision === 'allow-blank') {
      if (pressed) return { action: 'allow', ...(opts.allowOptions ?? {}) }
      const log = opts.log ?? console.warn
      log(`[window-open] refused a blank window (${details.frameName || 'no name'}): no key or mouse press in this window in the last five seconds`)
      return { action: 'deny' }
    }
    if (decision === 'external') {
      if (pressed) sendOut(details.url, opts)
      else (opts.log ?? console.warn)(`[window-open] refused ${String(details.url).slice(0, 200)}: no key or mouse press in this window in the last five seconds`)
    } else (opts.log ?? console.warn)(`[window-open] refused ${String(details.url).slice(0, 200)} (${details.frameName || 'no name'})`)
    return { action: 'deny' }
  }
}

/**
 * The setWindowOpenHandler for the editor / Tools / Pathways windows. Nothing opens in-app. The
 * app's own page never calls window.open and has no `target="_blank"` link (its links go through
 * main: `shell:open-external`), so whatever arrives here comes from a talk's content shown in a
 * frame of the window (the slide preview, Studio's replay). It is therefore under the same rules as
 * a deck window: a recent real press in THIS window, the content rule, the normalised href.
 */
export function appWindowOpenHandler(opts: Opts, pressedRecently: () => boolean = () => false): (details: HandlerDetails) => WindowOpenHandlerResponse {
  return (details) => {
    const log = opts.log ?? console.warn
    if (decideAppWindowOpen(details.url) !== 'external') { log(`[window-open] refused ${String(details.url).slice(0, 200)}`); return { action: 'deny' } }
    let pressed = false
    try { pressed = pressedRecently() === true } catch { pressed = false }
    if (pressed) sendOut(details.url, opts)
    else log(`[window-open] refused ${String(details.url).slice(0, 200)}: no key or mouse press in this window in the last five seconds`)
    return { action: 'deny' }
  }
}

type DeckContents = Pick<WebContents, 'setWindowOpenHandler' | 'getURL' | 'id'> & {
  on(event: 'did-create-window', listener: (child: { webContents: DeckContents }) => void): unknown
}

/**
 * Installs the deck handler on a deck window AND on every window it, or any window opened from it,
 * ever creates. A plain presentation opens its Presenter, which opens the Audience: the audience is
 * a grandchild, and a handler set only on direct children would leave it on Electron's default
 * (allow, inheriting the opener's preload). Codex review on PR #7.
 */
export function guardDeckWindowTree(contents: DeckContents, opts: DeckOpts): void {
  const pressed = opts.pressedRecently
  contents.setWindowOpenHandler(presentWindowOpenHandler(() => contents.getURL(), opts, () => !!pressed && pressed(contents) === true))
  contents.on('did-create-window', (child) => guardDeckWindowTree(child.webContents, opts))
}
