// The Slide Browser's keyboard (capture; ⌘S + ? are handled by the workspace's global handler).
// The scripts/test-shortcut-registry.mjs "key truth" check reads this file's handleKey region:
// every key comparison in it is claimed there by a registry id, and every key the registry lists
// for the slide picker is bound here.
import { type Dispatch, type MutableRefObject, type RefObject, type SetStateAction, useEffect } from 'react'
import { notify } from '../../lib/notify'
import { isTypingKey, surfaceKey } from '../../keymap/surfaceKeys'
import { findBoxOwnsKey } from '../browser-rail/findTalkModel'
import { type DisplayCard, gridNavigate } from '../slideBrowserModel'
import { type PickerMain, type SplitLayout, splitNavigate } from '../talkBesideModel'
import type { PickerCommandOutcome } from '../slidePickerCommands'
import type { OpenLoc, OpenStrip, SearchResult } from './types'

export interface SlideBrowserKeyState {
  isOpen: boolean
  suspendKeys?: boolean
  tagPickerOpen: boolean
  viewer: { slug: string; order: number } | null
  vCards: DisplayCard[]
  vRows: SearchResult[]
  activePos: number
  density: number
  gridMode: 'grouped' | 'outline' | 'side'
  scope: unknown[]
  preview: boolean
  openPop: string | null
  openStrip: OpenStrip | null
  openLoc: OpenLoc | null
  query: string
  selected: Set<string>
  onClose: () => void
  main: PickerMain
  splitLayout: SplitLayout | null
  leftCount: number
  fullRows: SearchResult[]
  besideOn: boolean
  inputRef: RefObject<HTMLInputElement | null>
  rootRef: RefObject<HTMLDivElement | null>
  anchorRef: MutableRefObject<number>
  setOpenPop: Dispatch<SetStateAction<string | null>>
  setPreview: Dispatch<SetStateAction<boolean>>
  setQuery: Dispatch<SetStateAction<string>>
  setSelected: Dispatch<SetStateAction<Set<string>>>
  setActivePos: Dispatch<SetStateAction<number>>
  setRailCollapsed: Dispatch<SetStateAction<boolean>>
  setDensity: (d: number) => void
  closeBesideNow: () => void
  closeStrip: () => void
  closeLoc: () => void
  clearScope: () => void
  selectWholeSectionAt: (pos: number) => PickerCommandOutcome
  openBesideAt: (pos: number) => void
  doInsert: () => void
  extendTo: (pos: number) => void
  toggleAt: (pos: number) => void
  selectActiveSection: () => void
  openTagPicker: () => void
  toggleLocations: (pos: number) => void
  toggleStrip: (pos: number) => Promise<void>
  toggleNear: (pos: number) => void
  openViewer: (row: SearchResult) => void
}

export function useSlideBrowserKeys(k: SlideBrowserKeyState): void {
  const {
    isOpen, suspendKeys, tagPickerOpen, viewer, vCards, vRows, activePos, density, gridMode, scope,
    preview, openPop, openStrip, openLoc, query, selected, onClose, main, splitLayout, leftCount,
    fullRows, besideOn, inputRef, rootRef, anchorRef, setOpenPop, setPreview, setQuery, setSelected,
    setActivePos, setRailCollapsed, setDensity, closeBesideNow, closeStrip, closeLoc, clearScope,
    selectWholeSectionAt, openBesideAt, doInsert, extendTo, toggleAt, selectActiveSection,
    openTagPicker, toggleLocations, toggleStrip, toggleNear, openViewer
  } = k
  useEffect(() => {
    if (!isOpen) return
    function handleKey(e: KeyboardEvent): void {
      // The cheat-sheet (or another overlay) sits above the Browser: hand it EVERY key,
      // including Esc and Tab — otherwise Esc would run both close paths at once.
      if (suspendKeys) return
      // The tag picker owns every key while open (its own capture handler registered after
      // this one takes ↑↓ ↵ ⎋; everything else is typing in its filter input).
      if (tagPickerOpen) return
      // The insert-decision viewer owns EVERY key while open (its own capture handler,
      // registered on mount, handles Esc/arrows/⌘↵ and traps Tab inside itself).
      if (viewer) return
      const el = document.activeElement
      const inSearch = el === inputRef.current
      // "Find a talk" keeps its own keys while it lists talks or completes (↑↓ move its list, ↵
      // shows a talk, ⌘↵ adds it beside, Esc clears its words); the grid keys leave them alone.
      if (el instanceof HTMLInputElement && el.dataset.findTalk === '1' && findBoxOwnsKey(e.key, {
        value: el.value, listing: el.dataset.listing === '1', completing: el.dataset.completing === '1'
      })) return
      const inField = el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement
      // Keyboard parity (Gate-5): a Tab-focused BUTTON (rail chip, scope ×, tree row, tray
      // action) must keep its own ↵/Space activation — the grid never steals those from the
      // control the keyboard user just reached.
      const onButton = el instanceof HTMLButtonElement
      const mod = e.metaKey || e.ctrlKey

      // Basic focus trap: Tab cycles within the overlay (visible controls only —
      // closed .lt-pop popovers are focusable in the DOM but hidden).
      if (e.key === 'Tab' && rootRef.current) {
        const focusables = [...rootRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input, [tabindex]:not([tabindex="-1"])'
        )].filter((f) => {
          const style = window.getComputedStyle(f)
          return style.visibility !== 'hidden' && style.display !== 'none' && f.offsetParent !== null
        })
        if (focusables.length > 0) {
          const first = focusables[0]
          const last = focusables[focusables.length - 1]
          if (e.shiftKey && el === first) { e.preventDefault(); last.focus() }
          else if (!e.shiftKey && el === last) { e.preventDefault(); first.focus() }
          else if (!el || !rootRef.current.contains(el)) { e.preventDefault(); first.focus() }
        }
        return
      }

      // The rail's inline vocabulary inputs own their Esc (clear the query first, THEN blur —
      // taste rule): let the event through untouched so their own handler runs.
      if (e.key === 'Escape' && el instanceof HTMLInputElement && el.dataset.railEsc === '1') return

      // The picker's rebindable talk-search keys (talk search 08). A plain-letter key never fires
      // from a text field; a chord fires from anywhere in the picker.
      const keyFree = !inField || !isTypingKey(e)
      // Close the talk beside, when rebound off Esc (Esc itself closes it as a step of the ladder).
      if (e.key !== 'Escape' && besideOn && keyFree && surfaceKey(e, 'close-beside')) {
        e.preventDefault(); e.stopPropagation(); closeBesideNow(); return
      }
      // Esc ladder: popover → preview → filmstrip → locations → clear search (typing) → selection → close.
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation()
        if (openPop) { setOpenPop(null); return }
        if (preview) { setPreview(false); return }
        if (openStrip) { closeStrip(); return }
        if (openLoc) { closeLoc(); return }
        // The talk beside the results closes before anything else of the results changes (K5).
        if (besideOn) { closeBesideNow(); return }
        if (inSearch && query) { setQuery(''); return }
        if (selected.size > 0) { setSelected(new Set()); return }
        onClose(); return
      }
      // ⇧⌘↵ selects the focused slide's whole section; ⌘↵ inserts the selected slides.
      if (keyFree && surfaceKey(e, 'select-whole-section')) {
        e.preventDefault(); e.stopPropagation()
        const outcome = selectWholeSectionAt(activePos)
        if (outcome !== true) notify(outcome, 'info', 'select-whole-section')
        return
      }
      if (keyFree && surfaceKey(e, 'talk-beside')) {
        e.preventDefault(); e.stopPropagation(); openBesideAt(activePos); return
      }
      if (mod && !e.shiftKey && e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); doInsert(); return }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        // ←/→ keep moving the caret while typing; only ↑↓ pull focus into the grid.
        if (inField && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return
        e.preventDefault(); e.stopPropagation()
        if (inField) (el as HTMLElement).blur()
        setActivePos((p) => {
          // Side-by-side columns are 2 cards across — ↑↓ must step by the REAL row width. With a talk
          // beside the results, arrows move on their side and ←→ cross at the edges.
          const next = splitLayout
            ? splitNavigate(p, e.key, splitLayout)
            : gridNavigate(p, e.key, gridMode === 'side' ? 2 : density, vRows.length)
          if (e.shiftKey) extendTo(next)
          else anchorRef.current = next
          return next
        })
        return
      }
      if (inField) return // the rest are grid-only — never hijack typing
      // ⌫ clears the scope (the rail's key — mirrors the Clear-scope row).
      if (e.key === 'Backspace' && !mod && !e.altKey) {
        if (scope.length > 0) { e.preventDefault(); e.stopPropagation(); clearScope() }
        return
      }
      if (['2', '3', '4', '5', '6'].includes(e.key) && !mod && !e.altKey) {
        e.preventDefault(); e.stopPropagation(); setDensity(Number(e.key)); return
      }
      // Letter/plain keys never fire with a modifier held — ⌘I (icon picker), ⌘E etc. belong
      // to the workspace's own bindings.
      const plain = !mod && !e.altKey
      if (plain && (e.key === 'x' || e.key === 'X')) { e.preventDefault(); e.stopPropagation(); toggleAt(activePos); return }
      if (plain && (e.key === 's' || e.key === 'S')) { e.preventDefault(); e.stopPropagation(); selectActiveSection(); return }
      // T: tag the selection (ADR-0037) — opens the tray-anchored picker.
      if (plain && (e.key === 't' || e.key === 'T')) { e.preventDefault(); e.stopPropagation(); openTagPicker(); return }
      // Space previews, with P as its SearchPalette-parity alias (⌘Y deliberately dropped — redundant).
      // Space on a focused button is that button's click — leave it alone.
      if (plain && e.key === ' ' && onButton) return
      if (plain && (e.key === ' ' || e.key === 'p' || e.key === 'P')) { e.preventDefault(); e.stopPropagation(); setPreview((p) => !p); return }
      if (plain && (e.key === 'i' || e.key === 'I')) { e.preventDefault(); e.stopPropagation(); setRailCollapsed((c) => !c); return }
      // E: an identical stack opens its locations panel; any other stamped card opens its versions
      // filmstrip; a collapsed near stack ignores E (U is its key).
      if (plain && (e.key === 'e' || e.key === 'E')) {
        e.preventDefault(); e.stopPropagation()
        const card = vCards[activePos]
        if (card?.kind === 'identical') toggleLocations(activePos)
        else if (card?.kind !== 'near') void toggleStrip(activePos)
        return
      }
      // U: uncollapse / re-collapse a near cluster (from its collapsed card or any of its variants).
      // [Task 12: fold E=versions/locations and U=uncollapse into the app-wide cheat-sheet.]
      if (plain && (e.key === 'u' || e.key === 'U')) {
        e.preventDefault(); e.stopPropagation()
        toggleNear(activePos)
        return
      }
      // ↵ opens the INSERT-DECISION VIEWER for the slide under the cursor — never the
      // editor, never a talk switch (v0.15.x decision).
      if (plain && e.key === 'Enter') {
        if (onButton) return // ↵ on a focused button is that button's click — leave it alone
        e.preventDefault(); e.stopPropagation()
        if (vRows[activePos]) openViewer(vRows[activePos])
        return
      }
    }
    window.addEventListener('keydown', handleKey, { capture: true })
    return () => window.removeEventListener('keydown', handleKey, { capture: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, suspendKeys, tagPickerOpen, viewer, vCards, vRows, activePos, density, gridMode, scope, preview, openPop, openStrip, openLoc, query, selected, onClose, main, splitLayout, leftCount, fullRows])
}
