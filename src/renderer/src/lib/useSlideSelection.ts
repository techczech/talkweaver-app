// The selection of slides on one surface (slide handling: grid now; Scratchpad, Browser and Organizer move
// onto it in later tickets). Generalised from slide-browser/useSelection.ts: a Set of keys, an anchor, toggle,
// range, section, clear, and the selected positions in talk order.
//
// `keys[i]` is the stable identity of the slide at position i of the talk (null: not selectable). A key
// survives a move, so the selection does: after a move the same slides are still selected, at their new
// positions. `slideKeys` makes such keys from the compiled rows.
import { useCallback, useMemo, useRef, useState } from 'react'

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
  count: number
  /** Plain-click focus, separate from the tick selection, for surfaces with a one-item inspector. */
  focusedIndex: number | null
  isSelected: (index: number) => boolean
  /** A plain click: nothing selected, and `index` is the anchor a ⇧-click extends from. */
  reset: (index: number) => void
  /** ⌘-click / the tick box: in or out. */
  toggle: (index: number) => void
  /** ⇧-click: everything from the anchor (or `fallbackAnchor`) to `index` that `inRange` accepts, replacing the selection. */
  extendTo: (index: number, fallbackAnchor: number, inRange?: (i: number) => boolean) => void
  /** Add these positions ("Select section"). */
  addMany: (indices: readonly number[]) => void
  clear: () => void
}

export function useSlideSelection(keys: ReadonlyArray<string | null>): SlideSelection {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [focusedKey, setFocusedKey] = useState<string | null>(null)
  const anchorRef = useRef<string | null>(null)
  const keysRef = useRef(keys)
  keysRef.current = keys

  const indices = useMemo(() => {
    const out: number[] = []
    keys.forEach((k, i) => { if (k != null && selected.has(k)) out.push(i) })
    return out
  }, [keys, selected])

  const keyAt = (i: number): string | null => keysRef.current[i] ?? null
  const reset = useCallback((index: number) => {
    anchorRef.current = keyAt(index)
    setFocusedKey(keyAt(index))
    setSelected((prev) => (prev.size === 0 ? prev : new Set()))
  }, [])
  const toggle = useCallback((index: number) => {
    const k = keyAt(index)
    if (k == null) return
    anchorRef.current = k
    setFocusedKey(null)
    setSelected((prev) => { const next = new Set(prev); if (next.has(k)) next.delete(k); else next.add(k); return next })
  }, [])
  const extendTo = useCallback((index: number, fallbackAnchor: number, inRange?: (i: number) => boolean) => {
    setFocusedKey(null)
    const anchorKey = anchorRef.current
    const a = anchorKey != null && keysRef.current.includes(anchorKey) ? keysRef.current.indexOf(anchorKey) : fallbackAnchor
    const [lo, hi] = a <= index ? [a, index] : [index, a]
    const next = new Set<string>()
    for (let i = lo; i <= hi; i += 1) {
      const k = keyAt(i)
      if (k != null && (!inRange || inRange(i))) next.add(k)
    }
    if (anchorKey == null) anchorRef.current = keyAt(a)
    setSelected(next)
  }, [])
  const addMany = useCallback((list: readonly number[]) => {
    const ks = list.map(keyAt).filter((k): k is string => k != null)
    if (ks.length === 0) return
    anchorRef.current = ks[0]
    setSelected((prev) => new Set([...prev, ...ks]))
  }, [])
  const clear = useCallback(() => { anchorRef.current = null; setFocusedKey(null); setSelected((prev) => (prev.size === 0 ? prev : new Set())) }, [])
  const isSelected = useCallback((index: number) => { const k = keysRef.current[index]; return k != null && selected.has(k) }, [selected])

  return { indices, pickedIndices: [...selected].map(key => keys.indexOf(key)).filter(index => index >= 0), count: indices.length, focusedIndex: focusedKey != null && keys.includes(focusedKey) ? keys.indexOf(focusedKey) : null, isSelected, reset, toggle, extendTo, addMany, clear }
}
