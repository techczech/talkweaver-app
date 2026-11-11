// Manifest id lists have their own order; these operations never edit slide text or outline order.
export function insertPathwaySlides(ids: readonly string[], incoming: readonly string[], at: number): string[] {
  const picked = [...new Set(incoming)]
  const moving = new Set(picked)
  const boundary = Math.max(0, Math.min(ids.length, at))
  const before = ids.slice(0, boundary).filter(id => !moving.has(id)).length
  const next = ids.filter(id => !moving.has(id))
  next.splice(before, 0, ...picked)
  return next
}

export function addPathwaySlides(ids: readonly string[], selected: readonly string[], talkOrder: readonly string[]): string[] {
  const wanted = new Set(selected)
  const existing = new Set(ids)
  return [...ids, ...talkOrder.filter(id => wanted.has(id) && !existing.has(id) && (existing.add(id), true))]
}

export function movePathwaySlide(ids: readonly string[], id: string, delta: -1 | 1): string[] {
  const from = ids.indexOf(id)
  const to = from + delta
  if (from < 0 || to < 0 || to >= ids.length) return [...ids]
  return insertPathwaySlides(ids, [id], delta < 0 ? to : to + 1)
}

export function removePathwaySlides(ids: readonly string[], removed: readonly string[]): string[] {
  const unwanted = new Set(removed)
  return ids.filter(id => !unwanted.has(id))
}

export function dropMissingPathwaySlides(ids: readonly string[], talkOrder: readonly string[]): string[] {
  const present = new Set(talkOrder)
  return ids.filter(id => present.has(id))
}
