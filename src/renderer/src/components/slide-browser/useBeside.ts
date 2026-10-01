// A result's talk beside the results (talk search 06; ADR-0029 §4; frame K5): open from a result
// (O, or the card's "In talk"), close on Esc with the results' scroll position and focus restored,
// and the split layout the arrow keys navigate.
import { type Dispatch, type SetStateAction, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { type DisplayCard, selRowKey } from '../slideBrowserModel'
import {
  type BesidePlan, type PickerMain, type ResultsSnapshot, type SplitLayout,
  RESULTS_ONLY, besideAvailable, closeBeside, openBeside
} from '../talkBesideModel'
import type { SearchResult } from './types'

export function useBeside({
  main, setMain, gridMode, besidePlanNow, leftCards, leftCount, vRows, activePos, setActivePos,
  setOpenPop, setPreview
}: {
  main: PickerMain
  setMain: Dispatch<SetStateAction<PickerMain>>
  gridMode: Parameters<typeof besideAvailable>[0]
  besidePlanNow: BesidePlan<SearchResult> | null
  leftCards: DisplayCard[]
  leftCount: number
  vRows: SearchResult[]
  activePos: number
  setActivePos: Dispatch<SetStateAction<number>>
  setOpenPop: (pop: string | null) => void
  setPreview: (open: boolean) => void
}) {
  const tableScrollRef = useRef<HTMLDivElement>(null)
  const restoreRef = useRef<ResultsSnapshot | null>(null)

  // Open from a result (never from the talk beside itself). Another result's talk replaces the right
  // side; the snapshot Esc restores is the one taken at the first open.
  function openBesideAt(pos: number): void {
    if (pos >= leftCount || !besideAvailable(gridMode)) return
    const row = vRows[pos]
    if (!row) return
    setOpenPop(null)
    setPreview(false)
    setMain((m) => openBeside(m, row, {
      scrollTop: tableScrollRef.current?.scrollTop ?? 0,
      activeKey: vRows[activePos] && activePos < leftCount ? selRowKey(vRows, activePos) : null
    }))
    setActivePos(pos)
  }
  // Esc: the right side closes; the results come back with their scroll position and focus, and the
  // selection is left exactly as it is.
  function closeBesideNow(): void {
    const { main: next, restore } = closeBeside(main)
    setMain(next)
    if (!restore) return
    restoreRef.current = restore
    // The results keep their positions whether or not the talk is open, so the focus is found in them.
    const back = restore.activeKey
      ? vRows.findIndex((_r, i) => i < leftCount && selRowKey(vRows, i) === restore.activeKey)
      : -1
    setActivePos(back >= 0 ? back : Math.min(activePos, Math.max(0, leftCount - 1)))
  }
  // The results' scroll position goes back before paint, ahead of the keep-focus-in-view effect.
  useLayoutEffect(() => {
    const restore = restoreRef.current
    if (!restore || main.beside) return
    restoreRef.current = null
    if (tableScrollRef.current) tableScrollRef.current.scrollTop = restore.scrollTop
  }, [main])
  // The talk opened beside is closed by anything that turns the results into columns.
  useEffect(() => {
    if (main.beside && !besideAvailable(gridMode)) setMain(RESULTS_ONLY)
  }, [main.beside, gridMode, setMain])
  const splitLayout = useMemo<SplitLayout | null>(() => (besidePlanNow
    ? {
        left: leftCount,
        leftCols: 2,
        rightChunks: besidePlanNow.chunks.map((c) => c.rows.length),
        rightCols: 3,
        rightEntry: leftCount + besidePlanNow.hl,
        // ← from the talk's left edge goes back to the result it was opened from.
        leftEntry: Math.max(0, leftCards.findIndex((c) =>
          (c.row as SearchResult).talkSlug === besidePlanNow.slug && ((c.row as SearchResult).order ?? 0) === main.beside?.order))
      }
    : null), [besidePlanNow, leftCount, leftCards, main.beside])

  return { tableScrollRef, openBesideAt, closeBesideNow, splitLayout }
}
