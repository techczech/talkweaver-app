/**
 * The order one render captures its uncached slides in. Capture stays strictly serial (one shared
 * hidden window); only the choice of the NEXT slide changes: the slides the author is looking at
 * (the active slide, then the strip's visible range, as the renderer last reported them) first, then
 * everything else in deck order. The focus is read again before every pick, so a scroll mid-run
 * reorders only what is not yet captured; a slide already taken is never offered twice.
 */
export interface CapturePlan<T> {
  /** The next slide to capture, or undefined when none is left. */
  next(): T | undefined
  /** How many slides are not yet taken. */
  remaining(): number
}

export function createCapturePlan<T extends { index: number }>(
  items: readonly T[],
  focus?: () => readonly number[] | undefined
): CapturePlan<T> {
  const waiting = new Map<number, T>()
  for (const item of items) if (!waiting.has(item.index)) waiting.set(item.index, item)
  // Deck order, with a cursor past the slides already taken.
  const order = [...waiting.values()].sort((a, b) => a.index - b.index)
  let cursor = 0
  const take = (item: T): T => { waiting.delete(item.index); return item }
  return {
    next() {
      let wanted: readonly number[] | undefined
      try { wanted = focus?.() } catch { wanted = undefined }
      if (wanted) {
        for (const index of wanted) {
          const item = waiting.get(index)
          if (item) return take(item)
        }
      }
      while (cursor < order.length) {
        const item = order[cursor++]
        if (waiting.get(item.index) === item) return take(item)
      }
      return undefined
    },
    remaining: () => waiting.size
  }
}

/** The focus the renderer may report: whole non-negative slide indices, duplicates dropped, order
 *  kept (active slide first), bounded so a bad message cannot make every pick slow. */
export function cleanThumbnailFocus(value: unknown, limit = 200): number[] {
  // An oversized message is refused outright, and at most `limit` entries are ever inspected, so the
  // cost of cleaning is bounded however the array is padded (duplicates, invalid values).
  if (!Array.isArray(value) || value.length > limit * 5) return []
  const seen = new Set<number>()
  for (let i = 0; i < value.length && i < limit; i++) {
    const entry = value[i]
    if (typeof entry === 'number' && Number.isInteger(entry) && entry >= 0 && entry < 100_000) seen.add(entry)
  }
  return [...seen]
}
