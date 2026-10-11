// Where the keyboard is, for the place chip (onboarding 0.38.1 ticket 02). Reads state only: it
// listens to focus moving between the outline editor, the slide strip (or grid) and the Talks panel,
// and to the Talks panel announcing its focused row. It handles no keystroke.
//
// The editor's own place comes from Editor's onPlace (the caret's line); this hook combines it with
// the focus and the row through placeAt (shared/place.ts, rule 1). Focus anywhere else (a dialog, the
// toolbar, the status bar) keeps the last answer.
import { useCallback, useEffect, useRef, useState } from 'react'
import { chordEventInit } from '../../../shared/chord-event.ts'
import { shortcutById } from '../../../shared/shortcut-registry.ts'
import { placeAt, type Place, type PlaceFocus, type PlaceRow } from '../../../shared/place.ts'
import { effectiveKeys } from '../keymap/store'

/** The Talks panel announces its focused row's kind (detail: 'talk' | 'folder' | 'vault' | null). */
export const PLACE_ROW_EVENT = 'tw-place-row'

export function announcePlaceRow(kind: PlaceRow): void {
  window.dispatchEvent(new CustomEvent<PlaceRow>(PLACE_ROW_EVENT, { detail: kind }))
}

/** The region an element belongs to, or null when it is none of the three. */
export function placeFocusOf(element: Element | null): PlaceFocus | null {
  if (!element) return null
  const region = element.closest('[data-place-region], .tl-panel')
  if (!region) return null
  if (region.classList.contains('tl-panel')) return 'talks'
  const name = region.getAttribute('data-place-region')
  return name === 'editor' || name === 'strip' ? name : null
}

export interface PlaceState {
  place: Place
  /** The focused Talks-panel row's kind (a folder row and a vault row are both "on a vault"). */
  row: PlaceRow
  /** Does what ⌘K does at this moment: sends the context-menu chord to where the keyboard last was. */
  activate: () => void
}

export function usePlace(editorPlace: Place): PlaceState {
  const [focus, setFocus] = useState<PlaceFocus>('editor')
  const [row, setRow] = useState<PlaceRow>(null)
  // The element that last had the keyboard in one of the three regions: the chip sends ⌘K there.
  const lastTargetRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const onFocusIn = (event: FocusEvent): void => {
      const target = event.target instanceof HTMLElement ? event.target : null
      const region = placeFocusOf(target)
      if (!region || !target) return
      lastTargetRef.current = target
      setFocus(region)
    }
    const onRow = (event: Event): void => {
      const detail = (event as CustomEvent<PlaceRow>).detail
      setRow(detail === 'talk' || detail === 'folder' || detail === 'vault' ? detail : null)
    }
    document.addEventListener('focusin', onFocusIn)
    window.addEventListener(PLACE_ROW_EVENT, onRow)
    return () => {
      document.removeEventListener('focusin', onFocusIn)
      window.removeEventListener(PLACE_ROW_EVENT, onRow)
    }
  }, [])

  const activate = useCallback((): void => {
    const keys = effectiveKeys('app.context-menu') || shortcutById('app.context-menu').codes[0] || 'Mod-k'
    let target = lastTargetRef.current
    if (!target || !target.isConnected) target = document.querySelector<HTMLElement>('.cm-content')
    if (!target) return
    target.focus()
    target.dispatchEvent(new KeyboardEvent('keydown', chordEventInit(keys)))
  }, [])

  return { place: placeAt({ focus, row, editorPlace }), row, activate }
}
