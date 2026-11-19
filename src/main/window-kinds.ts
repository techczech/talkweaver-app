// The one list of which window is which, for the rules in main that depend on it:
//   - an APP window is the editor (including its Pathways dock) or Tools: the app's own page with the whole bridge. It
//     may read the clipboard (recording-permissions.ts) and save a download;
//   - a HIDDEN RENDERER is a window nobody sees or presses in (thumbnail capture): it hands nothing
//     to the OS, does not navigate away from the file main loaded into it, and downloads nothing;
//   - every other window (a deck window and the windows opened from it, a board, DevTools, anything
//     added later) needs no entry for those rules: the rules for links and local addresses apply to every window by
//     default, so a new kind of deck renderer is covered without being marked.
// Windows are known by `webContents.id` and forgotten when they close.
//
// WINDOW KINDS (ADR-0044 §6, rule A). Every BrowserWindow main creates is registered with its kind where it is created
// (`registerWindowKind`, or `markHiddenRenderer` for a hidden one). An update's restart closes only editor windows
// (and stops hidden helpers); any other window that can hold or run work is a blocker the person closes first; a
// window of no known kind is a blocker too. scripts/test-window-kinds.mjs fails for a `new BrowserWindow` in src/main
// without a registration, and for a kind missing from the table in ADR-0044 §6.
import type { RestartBlocker } from '../shared/update-install.ts'

/** What an update's restart does with a window of each kind. */
export type WindowClass = 'editor' | 'blocker' | 'helper'
export const WINDOW_KINDS = {
  editor: { class: 'editor', blocker: null, what: 'an editor window (one per talk)' },
  tools: { class: 'blocker', blocker: 'tools', what: 'the Tools window (Notes and script, Studio, recordings, the recording editor, video)' },
  settings: { class: 'blocker', blocker: 'settings', what: 'the Settings window' },
  'capture-embed': { class: 'blocker', blocker: 'capture', what: 'the Capture embed window' },
  deck: { class: 'blocker', blocker: 'presenting', what: 'a presenter, presentation or audience deck window' },
  'deck-child': { class: 'blocker', blocker: 'presenting', what: 'a window a deck window opened (Audience, Presenter, board)' },
  thumbnail: { class: 'helper', blocker: null, what: 'the hidden thumbnail renderer' },
  'scratchpad-capture': { class: 'helper', blocker: null, what: 'the hidden Scratchpad page capture' },
  'offline-page-capture': { class: 'helper', blocker: null, what: 'the hidden offline page capture' },
  'embed-preview-artwork': { class: 'helper', blocker: null, what: 'the hidden embed preview artwork renderer' },
  'presenter-layers-source': { class: 'helper', blocker: null, what: 'the hidden presenter layers audience source' },
} as const satisfies Record<string, { class: WindowClass; blocker: RestartBlocker | null; what: string }>
export type WindowKind = keyof typeof WINDOW_KINDS
export type HelperKind = { [K in WindowKind]: (typeof WINDOW_KINDS)[K]['class'] extends 'helper' ? K : never }[WindowKind]
export const WINDOW_KIND_NAMES = Object.keys(WINDOW_KINDS) as WindowKind[]

type KnownWindow = { webContents: { id: number }; once(event: 'closed', listener: () => void): unknown }
type HelperWindow = KnownWindow & { isDestroyed(): boolean; destroy(): void }

/** Editor and Tools windows. Filled through recording.ts `registerAppWindowPermissions`. */
export const appWindowIds = new Set<number>()
const hiddenRendererIds = new Set<number>()
const hiddenRenderers = new Map<number, HelperWindow>()
let helperHolds = 0
const helperResumed = new Set<() => void>()
const kinds = new Map<number, WindowKind>()

/** Checked immediately before creating a helper, including after asynchronous preparation. */
export function helperWindowsAllowed(): boolean { return helperHolds === 0 }

/** One-shot recovery after the last shutdown hold is released; returns an unsubscribe. */
export function whenHelperWindowsAllowed(resume: () => void): () => void {
  if (helperWindowsAllowed()) { resume(); return () => {} }
  helperResumed.add(resume)
  return () => { helperResumed.delete(resume) }
}

/** Quit and update restart share this gate. Helpers hold no work: destroy them without waiting for
 *  close/unload. Keep the gate held through asynchronous editor saves and the native install call;
 *  release only if that quit/restart is called off. Overlapping routes release independently. */
export function holdHelperWindows(): () => void {
  helperHolds++
  for (const window of hiddenRenderers.values()) if (!window.isDestroyed()) window.destroy()
  let released = false
  return () => {
    if (released) return
    released = true; helperHolds--
    if (helperHolds === 0) {
      const callbacks = [...helperResumed]; helperResumed.clear()
      for (const resume of callbacks) resume()
    }
  }
}

/** Records the window's kind until it closes. */
export function registerWindowKind(window: KnownWindow, kind: WindowKind): void {
  const id = window.webContents.id
  kinds.set(id, kind)
  window.once('closed', () => { if (kinds.get(id) === kind) kinds.delete(id) })
}

/** The window's kind, or null for a window nobody registered. */
export function windowKindOf(contentsId: unknown): WindowKind | null {
  return typeof contentsId === 'number' ? kinds.get(contentsId) ?? null : null
}

/** What an update's restart does with the window: a window of no known kind is a blocker. */
export function windowClassOf(kind: WindowKind | null): WindowClass {
  return kind ? WINDOW_KINDS[kind].class : 'blocker'
}

/** The restart blocker a window of this kind raises while open (null for editors and hidden helpers). */
export function windowBlockerOf(kind: WindowKind | null): RestartBlocker | null {
  return kind ? WINDOW_KINDS[kind].blocker : 'window'
}

export function isAppWindow(contentsId: unknown): boolean {
  return typeof contentsId === 'number' && appWindowIds.has(contentsId)
}

export function markHiddenRenderer(window: HelperWindow, kind: HelperKind): void {
  const id = window.webContents.id
  hiddenRendererIds.add(id)
  hiddenRenderers.set(id, window)
  registerWindowKind(window, kind)
  window.once('closed', () => { hiddenRendererIds.delete(id); hiddenRenderers.delete(id) })
  // Also refuse a late registration: a helper never survives a shutdown already under way.
  if (!helperWindowsAllowed() && !window.isDestroyed()) window.destroy()
}

export function isHiddenRenderer(contentsId: unknown): boolean {
  return typeof contentsId === 'number' && hiddenRendererIds.has(contentsId)
}

/**
 * A download (`session` 'will-download'). Only an app window saves one (the editor's "download the
 * script" button); a deck window, a hidden renderer and a request with no window are cancelled.
 * The deck has no download of its own, and before this a page in a slide could raise the Save
 * dialog with no press.
 */
export function decideDownload(contentsId: unknown): 'allow' | 'cancel' {
  return isAppWindow(contentsId) ? 'allow' : 'cancel'
}
