// The selection (over the visual order): X toggles, ⇧ extends a range, S / "Select section" take a
// section. Keys are the rows' `selRowKey`, so a slide shown twice is one selection.
import { useSlideSelection } from '../../lib/useSlideSelection'
import {
  sectionKeysAt, sectionSelectionKeys, selRowKey
} from '../slideBrowserModel'
import { selectedRowsFor } from '../talkBesideModel'
import type { SearchResult } from './types'

export function useSelection({ vRows, activePos, rowsByTalk, fullRows }: {
  vRows: SearchResult[]
  activePos: number
  rowsByTalk: Map<string, SearchResult[]>
  fullRows: SearchResult[]
}) {
  // Visible order leads; the full index keeps offscreen picks available to the tray.
  const visibleKeys = vRows.map((_, i) => selRowKey(vRows, i))
  const visible = new Set(visibleKeys)
  const keys = [...visibleKeys, ...fullRows.map((_, i) => selRowKey(fullRows, i)).filter(k => !visible.has(k))]
  const selection = useSlideSelection(keys, { preserveAnchorOnClear: true })
  const selected = selection.selectedKeys
  const toggleAt = selection.toggle
  const extendTo = (pos: number): void => selection.extendTo(pos, 0, i => i < vRows.length, true)
  function selectActiveSection(): void {
    selection.addKeys(sectionKeysAt(vRows, activePos))
    selection.setAnchor(activePos)
  }
  // "Select section · N slides" on a heading, and ⇧⌘↵ on a slide (Dominik, 0.34.0-preview.8 check,
  // 28 Sep): the WHOLE section — its heading slide and every slide under it, read from the talk's
  // whole index rows, showing or not — joins the selection. Nothing is inserted: single slides can
  // still be taken out (X or a click) before ⌘↵ inserts the selection. The heading's count and this
  // selection come from the same rows, so they always agree.
  function selectWholeSection(talkSlug: string, section: string): number {
    const keys = sectionSelectionKeys(rowsByTalk.get(talkSlug) ?? [], talkSlug, section)
    if (keys.length > 0) selection.addKeys(keys)
    return keys.length
  }
  const clearSelection = selection.clear
  // The selected rows in visual order — recomputed per render so the optimistic in-place `tags`
  // mutations are always reflected in the picker states. A slide shown both as a result and in
  // its talk beside is one slide; a selected slide no longer on screen (the talk beside closed)
  // still counts, found in the index snapshot.
  const selectedRows = selectedRowsFor(vRows, (pos) => selRowKey(vRows, pos), selected, fullRows) as SearchResult[]

  return {
    selected, setAnchor: selection.setAnchor, toggleAt, extendTo, selectActiveSection, selectWholeSection,
    clearSelection, selectedRows
  }
}
