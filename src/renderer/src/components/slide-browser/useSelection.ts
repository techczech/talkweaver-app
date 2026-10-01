// The selection (over the visual order): X toggles, ⇧ extends a range, S / "Select section" take a
// section. Keys are the rows' `selRowKey`, so a slide shown twice is one selection.
import { useRef, useState } from 'react'
import {
  rangeKeys, sectionKeysAt, sectionSelectionKeys, selRowKey
} from '../slideBrowserModel'
import { selectedRowsFor } from '../talkBesideModel'
import { addAllToSet, toggleInSet } from './browserHelpers'
import type { SearchResult } from './types'

export function useSelection({ vRows, activePos, rowsByTalk, fullRows }: {
  vRows: SearchResult[]
  activePos: number
  rowsByTalk: Map<string, SearchResult[]>
  fullRows: SearchResult[]
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const anchorRef = useRef(0)

  function toggleAt(pos: number): void {
    if (!vRows[pos]) return
    const k = selRowKey(vRows, pos)
    setSelected((prev) => toggleInSet(prev, k))
    anchorRef.current = pos
  }
  function extendTo(pos: number): void {
    const keys = rangeKeys(vRows, anchorRef.current, pos)
    setSelected((prev) => addAllToSet(prev, keys))
  }
  function selectActiveSection(): void {
    const keys = sectionKeysAt(vRows, activePos)
    setSelected((prev) => addAllToSet(prev, keys))
    anchorRef.current = activePos
  }
  // "Select section · N slides" on a heading, and ⇧⌘↵ on a slide (Dominik, 0.34.0-preview.8 check,
  // 28 Sep): the WHOLE section — its heading slide and every slide under it, read from the talk's
  // whole index rows, showing or not — joins the selection. Nothing is inserted: single slides can
  // still be taken out (X or a click) before ⌘↵ inserts the selection. The heading's count and this
  // selection come from the same rows, so they always agree.
  function selectWholeSection(talkSlug: string, section: string): number {
    const keys = sectionSelectionKeys(rowsByTalk.get(talkSlug) ?? [], talkSlug, section)
    if (keys.length > 0) setSelected((prev) => addAllToSet(prev, keys))
    return keys.length
  }
  function clearSelection(): void {
    setSelected(new Set())
  }
  // The selected rows in visual order — recomputed per render so the optimistic in-place `tags`
  // mutations are always reflected in the picker states. A slide shown both as a result and in
  // its talk beside is one slide; a selected slide no longer on screen (the talk beside closed)
  // still counts, found in the index snapshot.
  const selectedRows = selectedRowsFor(vRows, (pos) => selRowKey(vRows, pos), selected, fullRows) as SearchResult[]

  return {
    selected, setSelected, anchorRef, toggleAt, extendTo, selectActiveSection, selectWholeSection,
    clearSelection, selectedRows
  }
}
