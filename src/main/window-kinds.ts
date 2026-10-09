// The one list of which window is which, for the rules in main that depend on it:
//   - an APP window is the editor, Tools or Pathways: the app's own page with the whole bridge. It
//     may read the clipboard (recording-permissions.ts) and save a download;
//   - a HIDDEN RENDERER is a window nobody sees or presses in (thumbnail capture): it hands nothing
//     to the OS, does not navigate away from the file main loaded into it, and downloads nothing;
//   - every other window (a deck window and the windows opened from it, a board, DevTools, anything
//     added later) needs no entry: the rules for links and local addresses apply to every window by
//     default, so a new kind of deck renderer is covered without being marked.
// Windows are known by `webContents.id` and forgotten when they close.

type KnownWindow = { webContents: { id: number }; once(event: 'closed', listener: () => void): unknown }

/** Editor, Tools and Pathways windows. Filled through recording.ts `registerAppWindowPermissions`. */
export const appWindowIds = new Set<number>()
const hiddenRendererIds = new Set<number>()

export function isAppWindow(contentsId: unknown): boolean {
  return typeof contentsId === 'number' && appWindowIds.has(contentsId)
}

export function markHiddenRenderer(window: KnownWindow): void {
  const id = window.webContents.id
  hiddenRendererIds.add(id)
  window.once('closed', () => { hiddenRendererIds.delete(id) })
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
