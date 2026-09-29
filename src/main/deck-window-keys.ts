/**
 * Which app-owned key a deck window (presenter, audience or plain presentation window) handles
 * in the main process, before the page and the application menu see it.
 *
 * The deck window's `before-input-event` asks this function; a non-null answer means the main
 * process takes the key (preventDefault, which also keeps the menu's F5 "Present from the top"
 * accelerator from firing) and runs the action.
 *
 * - F5 in a PRESENTER window opens the audience view: the same action as the presenter's Audience
 *   button (`presenter.audience` in the shortcut registry). 2026-07-08 (28ed6ca) made F5 refresh
 *   every deck window, which left the registry's presenter F5 unreachable in the app; Dominik's
 *   0.34.0-preview.3 check: "pressing F5 in presenter view does not open Audience view".
 * - ⇧F5 in a presenter window, and F5 / ⇧F5 in the audience or plain window, refresh the deck in
 *   place from the editor, as ⌘R does.
 * - ⌘R / ⌃R refresh the deck in place in every deck window (preempting the menu's Reload).
 *
 * The editor window is not a deck window: there F5 presents from the top and ⇧F5 from the current
 * slide (`app.present`, `app.present-current`), handled by the renderer and the menu.
 */
export type DeckWindowMode = 'presenter' | 'audience' | 'window'

/** The fields of Electron's `Input` (before-input-event) this decision reads. */
export interface DeckKeyInput {
  type: string
  key: string
  shift: boolean
  meta: boolean
  control: boolean
  alt: boolean
}

export type DeckKeyAction = 'open-audience' | 'refresh'

export function deckWindowKeyAction(mode: DeckWindowMode, input: DeckKeyInput): DeckKeyAction | null {
  if (input.type !== 'keyDown') return null
  if (input.key === 'F5' && !input.meta && !input.control && !input.alt) {
    return mode === 'presenter' && !input.shift ? 'open-audience' : 'refresh'
  }
  if (input.shift || input.alt) return null
  if ((input.meta || input.control) && input.key.toLowerCase() === 'r') return 'refresh'
  return null
}

/** The deck window's mode as the present handler names it ('presenter' | 'audience' | other). */
export function deckWindowMode(mode: string | undefined | null): DeckWindowMode {
  return mode === 'presenter' ? 'presenter' : mode === 'audience' ? 'audience' : 'window'
}

/**
 * Script run in a presenter window to open the audience view: a click on its Audience button,
 * so F5 and the button can never drift apart. Run with userGesture so window.open is allowed.
 */
export const OPEN_AUDIENCE_SCRIPT = 'void document.getElementById("presenterAudienceApp")?.click()'
