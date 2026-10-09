// Which web permission each frame of each window gets (embed-sandbox design 4.4, and the security
// review of ticket 11.3). One table, for every window, from app start. Without a handler Electron
// grants every request and answers every check with "granted", to any frame.
//
//   permission                  granted to
//   media                       the main frame of an open presenter window, audio only (the recorder
//                               bridge's getUserMedia({ audio: true }); never the camera)
//   clipboard-sanitized-write   the main frame of any window (navigator.clipboard.writeText: the
//                               editor's copy buttons, the deck's "copy" courtesy)
//   fullscreen                  ANY frame of any window, main frame or embedded: the deck's own
//                               full-screen and "video to the full stage" controls, and the
//                               full-screen button of a video player embedded in a slide. Full screen
//                               exposes no data; a page that covers the window is left with Esc
//   clipboard-read              the main frame of an editor, Tools or Pathways window only
//                               (navigator.clipboard.readText: the editor's Paste command and its
//                               "link from the clipboard"). Never a deck window: until the embed
//                               sandbox lands an embedded page shares the deck's origin and could ask
//                               through `parent.navigator.clipboard`
//   everything else             nobody: notifications, geolocation, display capture, MIDI, pointer
//                               lock, keyboard lock, idle detection, storage access, window
//                               management, speaker selection, file system, openExternal, HID,
//                               serial, USB, the old synchronous clipboard read, anything unknown
//
// "Main frame" means `details.isMainFrame === true` on a request or check that names its window. A
// frame embedded in a slide is never the main frame. A check that arrives with no window (Electron
// passes null for a cross-origin subframe and for some checks, notifications among them) cannot be
// placed, so it is refused — for `fullscreen` too.
//
// What a player's full-screen button needs (observed in Electron 42 with a cross-origin frame,
// 2026-10-07): one `fullscreen` REQUEST, which names its window and has `isMainFrame: false`. No
// `fullscreen` check is made, with or without a window, so the refused no-window check costs
// nothing. Chromium also checks `automatic-fullscreen` (full screen without a press); that stays
// refused and the button works without it. `keyboardLock` and `pointerLock` stay refused.
//
// The same table answers requests (`setPermissionRequestHandler`) and checks
// (`setPermissionCheckHandler`: `navigator.permissions.query`, device labels, synchronous checks).
// One handler of each kind per session: Electron keeps only the last one set, so both are shared and
// the windows are sets (two presenter windows both keep their microphone).

export type WindowKind = 'presenter' | 'app'

export interface PermissionQuestion {
  permission: unknown
  /** `webContents.id` of the asking window; anything else (null: the window is not known) refuses. */
  contentsId: unknown
  isMainFrame: unknown
  /** A request's `details.mediaTypes`, or a check's `details.mediaType` in a one-element array. */
  mediaTypes?: unknown
  /** `webContents.id` of every open presenter window. */
  presenterIds: ReadonlySet<number>
  /** `webContents.id` of every open editor, Tools and Pathways window. */
  appWindowIds: ReadonlySet<number>
}

/** The table above. */
export function decidePermission(question: PermissionQuestion): boolean {
  const { permission, contentsId } = question
  if (typeof contentsId !== 'number' || !Number.isInteger(contentsId)) return false
  if (permission === 'fullscreen') return true // any frame of a known window
  if (question.isMainFrame !== true) return false
  if (permission === 'media') {
    if (!question.presenterIds.has(contentsId)) return false
    const types = question.mediaTypes
    return Array.isArray(types) && types.length > 0 && types.every((type) => type === 'audio')
  }
  if (permission === 'clipboard-sanitized-write') return true
  if (permission === 'clipboard-read') return question.appWindowIds.has(contentsId)
  return false
}

/** May this `media` request have the microphone? (The `media` row of the table.) */
export function decideMicrophoneRequest(request: { permission: unknown; contentsId: unknown; presenterIds: ReadonlySet<number>; isMainFrame: unknown; mediaTypes: unknown }): boolean {
  return request.permission === 'media' && decidePermission({ ...request, appWindowIds: new Set() })
}

type RequestDetails = { isMainFrame?: unknown; mediaTypes?: unknown } | null | undefined
type CheckDetails = { isMainFrame?: unknown; mediaType?: unknown } | null | undefined
type RequestHandler = (contents: { id?: unknown } | null, permission: string, callback: (granted: boolean) => void, details?: RequestDetails) => void
type CheckHandler = (contents: { id?: unknown } | null, permission: string, requestingOrigin?: string, details?: CheckDetails) => boolean

type PermissionSession = {
  setPermissionRequestHandler(handler: RequestHandler): void
  setPermissionCheckHandler(handler: CheckHandler): void
}
type PermissionWindow = { webContents: { id: number }; once(event: 'closed', listener: () => void): unknown }

export interface RecordingPermissions {
  /** The session's permission request handler (exported for the test). */
  handler: RequestHandler
  /** The session's permission check handler (exported for the test). */
  checkHandler: CheckHandler
  /** Sets both handlers on a session. Call once at app start for the default session. */
  install(session: PermissionSession): void
  /** A presenter window opened: its main frame may record. Forgotten when the window closes. */
  addPresenter(window: PermissionWindow): void
  /** An editor, Tools or Pathways window opened: its main frame may read the clipboard. */
  addAppWindow(window: PermissionWindow): void
  presenterIds(): ReadonlySet<number>
  appWindowIds(): ReadonlySet<number>
}

/** `sets.appWindowIds`: the app's one list of editor-kind windows (window-kinds.ts), shared, not copied. */
export function createRecordingPermissions(sets: { appWindowIds?: Set<number> } = {}): RecordingPermissions {
  const presenters = new Set<number>()
  const appWindows = sets.appWindowIds ?? new Set<number>()
  const decide = (contents: { id?: unknown } | null, permission: unknown, isMainFrame: unknown, mediaTypes: unknown): boolean => {
    try {
      return decidePermission({ permission, contentsId: contents?.id, isMainFrame, mediaTypes, presenterIds: presenters, appWindowIds: appWindows }) === true
    } catch { return false }
  }
  const handler: RequestHandler = (contents, permission, callback, details) => {
    let granted = false
    try { granted = decide(contents, permission, details?.isMainFrame, details?.mediaTypes) } catch { granted = false }
    callback(granted)
  }
  const checkHandler: CheckHandler = (contents, permission, _requestingOrigin, details) => {
    try {
      const mediaType = details?.mediaType
      return decide(contents, permission, details?.isMainFrame, mediaType === undefined ? undefined : [mediaType])
    } catch { return false }
  }
  const track = (ids: Set<number>, window: PermissionWindow): void => {
    const id = window.webContents.id
    ids.add(id)
    window.once('closed', () => { ids.delete(id) })
  }
  return {
    handler,
    checkHandler,
    install(session) {
      session.setPermissionRequestHandler(handler)
      session.setPermissionCheckHandler(checkHandler)
    },
    addPresenter(window) { track(presenters, window) },
    addAppWindow(window) { track(appWindows, window) },
    presenterIds: () => presenters,
    appWindowIds: () => appWindows,
  }
}
