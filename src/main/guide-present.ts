// The Guide in the presenter, main's side (onboarding 0.38.1 ticket 10). Three things a presenter
// window may ask, and nothing more:
//
//   guide:present-chapter  (no argument) → { view, open }: the Present chapter as the column draws it
//                          (src/shared/guide-present.ts), or view null while the Guide button is off;
//                          `open` says the column was open before the page reloaded.
//   guide:present-column   (true | false) → { open }: records that the column is open or closed, so a
//                          reload (⌘R) brings it back as it was. Nothing else: the column takes its
//                          room inside the page and never resizes or moves the window (review round 1).
//   guide:command-ran      (ticket 08's channel) from a deck window: a presenter command id only
//                          (`acceptCommandRan`).
//
//   guide:present-all-chapters (no argument) → boolean: asks main to bring the TalkWeaver window forward
//                          with the Guide open on the chapter list. A one-way request: it carries no
//                          payload and no chapter data goes back, so the presenter still receives only
//                          the Present view (ticket 10's data boundary).
//   guide:present-hide-button (no argument) → boolean: the × on the Guide button in the presenter's
//                          bottom bar. Turns off the same Settings switch ("Show the Guide button in
//                          the sidebar"); the one switch governs both windows.
//
// Who may ask: only a presenter window main opened (`isPresenter` is false for every other sender:
// editor windows, plain presentation and audience windows, a presenter a deck opened on its own, a
// board window). The frame rule is the app's: ipcMain is wrapped by applyMainFrameOnly
// (ipc-main-frame-only.ts) before any handler is registered, so a subframe of the presenter (a slide
// preview, an embedded page) is refused before these handlers run.
//
// Main pushes `guide:present-chapter-changed` ({ view, open }) to presenter windows when progress
// or the Guide button switch changes. The learn record itself goes only to app windows.
import { isPresenterCommandId, type PresentGuideView } from '../shared/guide-present.ts'

/**
 * May this sender report this command? An app window (editor, Tools, Pathways) may report any id
 * (ticket 08). A deck window main opened may report only a presenter command id from the registries.
 * Anyone else: nothing.
 */
export function acceptCommandRan(sender: { appWindow: boolean; deckWindow: boolean }, id: unknown): boolean {
  if (sender.appWindow) return true
  return sender.deckWindow && isPresenterCommandId(id)
}

export interface PresenterGuideDeps {
  /** Is this sender (webContents id) a presenter window main opened? False for any other sender. */
  isPresenter(senderId: number): boolean
  /** The Present chapter for this presenter, or null while the Guide button is off. */
  view(senderId: number): PresentGuideView | null
  /** Bring the editor window forward with the Guide open on the chapter list (nothing is sent back). */
  showChapterList(senderId: number): boolean
  /** Turn the Guide button switch off (the one Settings switch). */
  hideButton(): void
}

export interface PresentChapterReply { view: PresentGuideView | null; open: boolean }
export interface PresentColumnReply { open: boolean }

export class PresenterGuideHost {
  readonly #deps: PresenterGuideDeps
  readonly #open = new Set<number>()

  constructor(deps: PresenterGuideDeps) {
    this.#deps = deps
  }

  /** The read path. Null for a sender that is not a presenter main opened. */
  chapter(senderId: number): PresentChapterReply | null {
    if (!this.#deps.isPresenter(senderId)) return null
    const view = this.#deps.view(senderId)
    return { view, open: view !== null && this.#open.has(senderId) }
  }

  /** Record the column open (true) or closed (false). Null for any other sender or any other argument. */
  column(senderId: number, open: unknown): PresentColumnReply | null {
    if (typeof open !== 'boolean') return null
    if (!this.#deps.isPresenter(senderId)) return null
    if (open) this.#open.add(senderId)
    else this.#open.delete(senderId)
    return { open }
  }

  /** "All chapters" in the presenter's column. False for any sender that is not a presenter, and while the Guide button is off. */
  allChapters(senderId: number): boolean {
    if (!this.#deps.isPresenter(senderId)) return false
    if (this.#deps.view(senderId) === null) return false
    return this.#deps.showChapterList(senderId)
  }

  /** The × on the presenter's Guide button. False for any sender that is not a presenter, and while the button is already off. */
  hideButton(senderId: number): boolean {
    if (!this.#deps.isPresenter(senderId)) return false
    if (this.#deps.view(senderId) === null) return false
    this.#deps.hideButton()
    return true
  }

  /** The window closed: forget it. */
  forget(senderId: number): void {
    this.#open.delete(senderId)
  }

  /** Is this presenter's column open? */
  isOpen(senderId: number): boolean {
    return this.#open.has(senderId)
  }
}

type Handler = (event: { sender: { id: number } }, ...args: unknown[]) => unknown
export const PRESENT_ALL_CHAPTERS_CHANNEL = 'guide:present-all-chapters'
export const PRESENT_HIDE_BUTTON_CHANNEL = 'guide:present-hide-button'
/** What main sends the editor window: show the Guide on the chapter list. No payload. */
export const SHOW_CHAPTER_LIST_CHANNEL = 'guide:show-chapter-list'

/** Registers the presenter channels on (the frame-guarded) ipcMain. The two requests take no argument: one given is refused. */
export function registerPresenterGuideIpc(ipc: { handle(channel: string, listener: Handler): void }, host: PresenterGuideHost): void {
  ipc.handle('guide:present-chapter', (event) => host.chapter(event.sender.id))
  ipc.handle('guide:present-column', (event, open) => host.column(event.sender.id, open))
  ipc.handle(PRESENT_ALL_CHAPTERS_CHANNEL, (event, ...args) => (args.length === 0 ? host.allChapters(event.sender.id) : false))
  ipc.handle(PRESENT_HIDE_BUTTON_CHANNEL, (event, ...args) => (args.length === 0 ? host.hideButton(event.sender.id) : false))
}
