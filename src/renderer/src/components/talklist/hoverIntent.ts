// Intent model for the talk preview card (T29): ONE small state machine that decides when the
// card shows and for which row, so TalkList only wires DOM events and renders the target.
//
// Dominik's ruling (2026-09-19): a CLICK on a talk row opens the talk and never shows a card
// (nor leaves one behind); the card appears on HOVER after a short pause (450ms; 150ms when a
// card is already showing, so gliding down the list swaps cards without re-delaying); keyboard
// browsing keeps today's behaviour — ↑↓ move the card at once, Enter/⌘O/Escape hide it; any
// click, Escape, tree scroll or panel blur dismisses it; the row the pointer clicked stays
// suppressed until the pointer leaves and re-enters it.
//
// Pure and DOM-free: events carry timestamps, so tests drive it with fake timers. The owner
// schedules a timer whenever `pendingAt` is set and answers it with a `resolve` event.

/** Pause before a hover card opens (one named constant — Dominik's 450ms). */
export const HOVER_OPEN_MS = 450
/** Shorter re-arm when a card is already showing (or just hid — pointer gliding between rows). */
export const HOVER_SWITCH_MS = 150

export type CardSource = 'hover' | 'keys'
export interface CardTarget {
  key: string
  source: CardSource
}

export type CardEvent =
  | { type: 'enter'; rowKey: string; at: number } // pointer entered a row
  | { type: 'leave'; rowKey: string; at: number } // pointer left that row
  | { type: 'click'; rowKey?: string; at: number } // pointer-down anywhere in the panel; rowKey = talk row under the pointer
  | { type: 'keymove'; rowKey: string; at: number } // keyboard focus moved to a row (↑↓, tab-in)
  | { type: 'open'; at: number } // Enter / ⌘O opened the talk
  | { type: 'escape'; at: number }
  | { type: 'scroll'; at: number } // the tree scrolled
  | { type: 'panelblur'; at: number }
  | { type: 'resolve'; at: number } // the pending hover pause elapsed

export interface CardState {
  target: CardTarget | null
  hoverKey: string | null // row the pointer is over (even when suppressed or not yet open)
  keysKey: string | null // row the keyboard last focused (keyboard episode's target)
  suppressKey: string | null // clicked row — no card until the pointer leaves and re-enters
  pendingKey: string | null
  pendingAt: number | null // absolute time the pending hover pause resolves
  hiddenAt: number | null // when a hover card last hid — makes row-to-row glides take the short pause
}

export function initialCardState(): CardState {
  return { target: null, hoverKey: null, keysKey: null, suppressKey: null, pendingKey: null, pendingAt: null, hiddenAt: null }
}

export function cardStep(state: CardState, e: CardEvent): CardState {
  switch (e.type) {
    case 'enter': {
      if (state.hoverKey === e.rowKey && state.pendingKey === e.rowKey) return state
      // Same row suppressed by an earlier click: nothing shows until leave + re-enter.
      if (e.rowKey === state.suppressKey) return { ...state, hoverKey: e.rowKey, pendingKey: null, pendingAt: null }
      const gliding = state.target != null || (state.hiddenAt != null && e.at - state.hiddenAt <= HOVER_SWITCH_MS)
      return {
        ...state,
        hoverKey: e.rowKey,
        pendingKey: e.rowKey,
        pendingAt: e.at + (gliding ? HOVER_SWITCH_MS : HOVER_OPEN_MS)
      }
    }
    case 'leave': {
      if (state.hoverKey !== e.rowKey) return state // stale leave (e.g. child-element noise)
      const wasHover = state.target?.source === 'hover'
      const suppressKey = state.suppressKey === e.rowKey ? null : state.suppressKey
      // A hover card hides at once (no delay); a keyboard preview comes back — browsing
      // keeps its card — unless that row was the one clicked away.
      const restoreKeys = wasHover && state.keysKey && state.keysKey !== suppressKey
      return {
        ...state,
        hoverKey: null,
        pendingKey: null,
        pendingAt: null,
        suppressKey,
        target: restoreKeys ? { key: state.keysKey!, source: 'keys' } : null,
        hiddenAt: wasHover ? e.at : state.hiddenAt
      }
    }
    case 'click': {
      // Any panel click dismisses the card; a click ON a row also suppresses that row and
      // ends any keyboard-browsing episode (the pointer took over).
      return {
        ...state,
        target: null,
        pendingKey: null,
        pendingAt: null,
        keysKey: null,
        suppressKey: e.rowKey ?? state.suppressKey,
        hiddenAt: state.target?.source === 'hover' ? e.at : state.hiddenAt
      }
    }
    case 'keymove': {
      // Keyboard browsing: the card follows focus at once (today's behaviour). A row clicked
      // away earlier stays hidden until the pointer has left and re-entered it.
      return {
        ...state,
        keysKey: e.rowKey,
        pendingKey: null,
        pendingAt: null,
        target: e.rowKey === state.suppressKey ? null : { key: e.rowKey, source: 'keys' }
      }
    }
    case 'open': {
      // Enter/⌘O opens the talk — the card goes with it and stays gone.
      return { ...state, target: null, pendingKey: null, pendingAt: null, keysKey: null }
    }
    case 'escape': {
      return { ...state, target: null, pendingKey: null, pendingAt: null }
    }
    case 'scroll': {
      // Scrolling moves rows under a stationary pointer (and Chromium sends no enter/leave
      // for it) — drop the card and the pause; the next real enter re-arms.
      return { ...state, target: null, pendingKey: null, pendingAt: null }
    }
    case 'panelblur': {
      // Panel blur ends the whole episode (today's card was focus-bound); hover may start a
      // fresh one later. Suppression is forgotten — a blur is its own kind of leaving.
      return { ...state, target: null, pendingKey: null, pendingAt: null, keysKey: null, suppressKey: null }
    }
    case 'resolve': {
      if (state.pendingKey == null || state.pendingAt == null || e.at < state.pendingAt) return state
      if (state.pendingKey === state.suppressKey) {
        return { ...state, pendingKey: null, pendingAt: null }
      }
      return { ...state, target: { key: state.pendingKey, source: 'hover' }, pendingKey: null, pendingAt: null }
    }
  }
}
