// The selection of slides on every authoring surface. Generalised from slide-browser/useSelection.ts: a Set of keys, an anchor, toggle,
// range, section, clear, and the selected positions in talk order.
//
// `keys[i]` is the stable identity of the slide at position i of the talk (null: not selectable). A key
// survives a move, so the selection does: after a move the same slides are still selected, at their new
// positions. `slideKeys` makes such keys from the compiled rows.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

/** Stable keys for slides in talk order: the slide's id; without one, its content hash and which one of those it is. */
export function slideKeys(rows: ReadonlyArray<{ slide_id?: string | null; content_hash?: string | null }>, selectable: (i: number) => boolean): Array<string | null> {
  const seen = new Map<string, number>()
  return rows.map((row, i) => {
    if (!selectable(i)) return null
    const base = row.slide_id ? `id:${row.slide_id}` : `h:${row.content_hash ?? ''}`
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return row.slide_id && n === 1 ? base : `${base}#${n}`
  })
}

export interface SlideSelection {
  /** Positions (talk order) of the selected slides. */
  indices: number[]
  /** Positions in selection order (Scratchpad compare columns and triage retain their established order). */
  pickedIndices: number[]
  selectedKeys: Set<string>
  setAnchor: (index: number) => void
  addKeys: (keys: readonly string[]) => void
  toggleMany: (indices: readonly number[]) => void
  count: number
  /** Plain-click focus, separate from the tick selection, for surfaces with a one-item inspector. */
  focusedIndex: number | null
  isSelected: (index: number) => boolean
  /** A plain click: nothing selected, and `index` is the anchor a ⇧-click extends from. */
  reset: (index: number) => void
  /** ⌘-click / the tick box: in or out. */
  toggle: (index: number) => void
  /** ⇧-click: everything from the anchor (or `fallbackAnchor`) to `index` that `inRange` accepts, replacing the selection. */
  extendTo: (index: number, fallbackAnchor: number, inRange?: (i: number) => boolean, additive?: boolean) => void
  /** Add these positions ("Select section"). */
  addMany: (indices: readonly number[]) => void
  clear: () => void
}

type FocusRow = { line: number; text: string }
export function useSlideSelection(keys: ReadonlyArray<string | null>, options?: { preserveAnchorOnClear?: boolean; focusRows?: readonly FocusRow[]; focusAfterEdit?: (rows: readonly FocusRow[], line: number, text: string, sameCount: boolean) => number | null }): SlideSelection {
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [focusedKey, setFocusedKey] = useState<string | null>(null)
  const anchorRef = useRef<string | null>(null)
  const anchorPositionRef = useRef<number | null>(null)
  const keysRef = useRef(keys)
  keysRef.current = keys

  // Outline focus also survives an id-less retitle/relevel. Keep its established line/text
  // fallback here, alongside key selection, rather than another surface-owned focus model.
  const previousFocus = useRef<{ row: FocusRow | null; count: number }>({ row: null, count: 0 })
  const focusRows = options?.focusRows
  let focusedIndex = focusedKey == null ? null : keys.indexOf(focusedKey)
  if (focusedIndex === -1) {
    const previous = previousFocus.current
    const line = focusRows && previous.row && options?.focusAfterEdit
      ? options.focusAfterEdit(focusRows, previous.row.line, previous.row.text, previous.count === focusRows.length) : null
    focusedIndex = line == null ? null : focusRows!.findIndex(r => r.line === line)
  }
  if (focusedIndex === -1) focusedIndex = null
  useEffect(() => {
    if (!focusRows) return
    previousFocus.current = { row: focusedIndex == null ? null : focusRows[focusedIndex], count: focusRows.length }
    const nextKey = focusedIndex == null ? null : keys[focusedIndex]
    if (nextKey !== focusedKey) setFocusedKey(nextKey)
  }, [keys, focusRows, focusedKey, focusedIndex])

  const indices = useMemo(() => {
    const out: number[] = []
    keys.forEach((k, i) => { if (k != null && selected.has(k)) out.push(i) })
    return out
  }, [keys, selected])

  const keyAt = (i: number): string | null => keysRef.current[i] ?? null
  const reset = useCallback((index: number) => {
    anchorRef.current = keyAt(index)
    anchorPositionRef.current = index
    setFocusedKey(keyAt(index))
    setSelected((prev) => (prev.size === 0 ? prev : new Set()))
  }, [])
  const toggle = useCallback((index: number) => {
    const k = keyAt(index)
    if (k == null) return
    anchorRef.current = k
    anchorPositionRef.current = index
    setFocusedKey(null)
    setSelected((prev) => { const next = new Set(prev); if (next.has(k)) next.delete(k); else next.add(k); return next })
  }, [])
  const extendTo = useCallback((index: number, fallbackAnchor: number, inRange?: (i: number) => boolean, additive = false) => {
    setFocusedKey(null)
    const anchorKey = anchorRef.current
    // Browser may show one slide twice (result + talk beside). The clicked occurrence is the
    // range anchor; unique keys still follow their slide when it moves.
    const held = anchorPositionRef.current
    const a = anchorKey != null && held != null && keysRef.current[held] === anchorKey ? held
      : anchorKey != null && keysRef.current.includes(anchorKey) ? keysRef.current.indexOf(anchorKey) : fallbackAnchor
    const [lo, hi] = a <= index ? [a, index] : [index, a]
    const next = new Set<string>()
    for (let i = lo; i <= hi; i += 1) {
      const k = keyAt(i)
      if (k != null && (!inRange || inRange(i))) next.add(k)
    }
    if (anchorKey == null) { anchorRef.current = keyAt(a); anchorPositionRef.current = a }
    setSelected(prev => additive ? new Set([...prev, ...next]) : next)
  }, [])
  const addMany = useCallback((list: readonly number[]) => {
    const ks = list.map(keyAt).filter((k): k is string => k != null)
    if (ks.length === 0) return
    anchorRef.current = ks[0]
    anchorPositionRef.current = list[0]
    setSelected((prev) => new Set([...prev, ...ks]))
  }, [])
  const setAnchor = useCallback((index: number) => { anchorRef.current = keyAt(index); anchorPositionRef.current = index }, [])
  const addKeys = useCallback((list: readonly string[]) => { setSelected(prev => new Set([...prev, ...list])) }, [])
  const toggleMany = useCallback((list: readonly number[]) => {
    const ks = list.map(keyAt).filter((k): k is string => k != null)
    setSelected(prev => {
      const next = new Set(prev)
      const all = ks.every(k => next.has(k))
      for (const k of ks) { if (all) next.delete(k); else next.add(k) }
      return next
    })
  }, [])
  const preserveAnchorOnClear = options?.preserveAnchorOnClear ?? false
  const clear = useCallback(() => {
    if (!preserveAnchorOnClear) { anchorRef.current = null; anchorPositionRef.current = null }
    setFocusedKey(null)
    setSelected((prev) => (prev.size === 0 ? prev : new Set()))
  }, [preserveAnchorOnClear])
  const isSelected = useCallback((index: number) => { const k = keysRef.current[index]; return k != null && selected.has(k) }, [selected])

  return { indices, selectedKeys: selected, setAnchor, addKeys, toggleMany, pickedIndices: [...selected].map(key => keys.indexOf(key)).filter(index => index >= 0), count: indices.length, focusedIndex, isSelected, reset, toggle, extendTo, addMany, clear }
}
