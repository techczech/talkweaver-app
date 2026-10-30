// What the grid and the outline sidebar share while searching (ticket 2): ONE query string per talk, the slide
// previews the workspace publishes for the outline, and the picture text the search reads.
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { extractImageRefs } from '../../../shared/slide-handling/image-refs'

// ── The query ──
let current = { talk: '', query: '' }
const queryListeners = new Set<() => void>()
const subscribeQuery = (l: () => void): (() => void) => { queryListeners.add(l); return () => { queryListeners.delete(l) } }
const getQuery = (): typeof current => current

export function setSlideQuery(talk: string, query: string): void {
  if (current.talk === talk && current.query === query) return
  current = { talk, query }
  queryListeners.forEach((l) => l())
}

/** The query typed in the outline's or the grid's search box (the same string in both). Another talk starts empty. */
export function useSlideQuery(talk: string): [string, (query: string) => void] {
  const snap = useSyncExternalStore(subscribeQuery, getQuery)
  return [snap.talk === talk ? snap.query : '', (q) => setSlideQuery(talk, q)]
}

// ── Previews for the outline: the compiled slides' thumbnail urls, by compiled index ──
let thumbs: ReadonlyArray<string | null> | null = null
const thumbListeners = new Set<() => void>()
const subscribeThumbs = (l: () => void): (() => void) => { thumbListeners.add(l); return () => { thumbListeners.delete(l) } }

export function publishSlideThumbs(next: ReadonlyArray<string | null> | null): void {
  thumbs = next
  thumbListeners.forEach((l) => l())
}
export function useSlideThumbs(): ReadonlyArray<string | null> | null {
  return useSyncExternalStore(subscribeThumbs, () => thumbs)
}

// ── Picture text, asked for only while a search is active ──
// Keyed on the SET of picture references the blocks name (sorted, unique) and the OCR index generation, not on block
// text: typing in the editor does not re-ask, but a picture read later in the background (generation rises) does.
// One cache and one in-flight request per key, shared by the grid and the outline. A rejected request is not cached.
const pictureCache = new Map<string, Promise<string[]>>()
const pictureKey = (outlinePath: string, blocks: readonly string[]): string => {
  const refs = new Set<string>()
  for (const b of blocks) for (const r of extractImageRefs(b)) refs.add(r.ref)
  return `${outlinePath}\u0000${[...refs].sort().join('\u0001')}`
}
// The answer is one text per picture reference, so a block's text is the join of its references' text.
const readGeneration = (): Promise<number> => {
  const ask = window.tw?.talk?.slidePictureGeneration
  return ask ? ask().then((g) => g, () => 0) : Promise.resolve(0)
}
export async function pictureTextByRef(outlinePath: string, key: string): Promise<Map<string, string>> {
  const refs = key.slice(outlinePath.length + 1).split('\u0001').filter(Boolean)
  const slot = `${key}\u0002${await readGeneration()}`
  let run = pictureCache.get(slot)
  if (!run) {
    const fresh = window.tw.talk.slidePictureText(outlinePath, refs.map((r) => `![](<${r}>)`))
    run = fresh
    pictureCache.set(slot, fresh)
    fresh.catch(() => { if (pictureCache.get(slot) === fresh) pictureCache.delete(slot) })
  }
  const t = await run.then((x) => x, () => refs.map(() => ''))
  return new Map(refs.map((r, i) => [r, t[i] ?? '']))
}
/** The text in each block's pictures (one string per block). Asked for after a short pause while `active`; [] meanwhile. */
export function usePictureText(outlinePath: string | null, blocks: readonly string[], active: boolean): string[] {
  // Drag/selection renders reuse the same blocks; do not rescan the deck on the pointer path.
  const key = useMemo(() => active && outlinePath ? pictureKey(outlinePath, blocks) : '', [active, outlinePath, blocks])
  const [got, setGot] = useState<{ key: string; byRef: Map<string, string> } | null>(null)
  const [generation, setGeneration] = useState(0)
  useEffect(() => {
    if (!key || !outlinePath) return
    let stopped = false
    let last: number | null = null
    const check = (): void => { void readGeneration().then((g) => { if (stopped) return; if (last != null && g !== last) setGeneration((n) => n + 1); last = g }) }
    check()
    const timer = setInterval(check, 2000)
    return () => { stopped = true; clearInterval(timer) }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!key || !outlinePath) { setGot(null); return }
    let cancelled = false
    const timer = setTimeout(() => {
      void pictureTextByRef(outlinePath, key).then((byRef) => { if (!cancelled) setGot({ key, byRef }) })
    }, 200)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [key, generation]) // eslint-disable-line react-hooks/exhaustive-deps
  return useMemo(() => {
    if (!got) return [] // the earlier answer stays until the new one arrives, so hits do not flicker
    return blocks.map((b) => extractImageRefs(b).map((r) => got.byRef.get(r.ref) ?? '').filter(Boolean).join('\n'))
  }, [got, blocks])
}

// ── The surfaces that can take a search command (the grid when it is showing, else the outline) ──
export interface SearchSurface { focus(): void; step(dir: 1 | -1): boolean }
const surfaces = new Map<'grid' | 'outline', SearchSurface>()
export function registerSearchSurface(kind: 'grid' | 'outline', surface: SearchSurface): () => void {
  surfaces.set(kind, surface)
  return () => { if (surfaces.get(kind) === surface) surfaces.delete(kind) }
}
export function searchSurface(prefer: 'grid' | 'outline' | null = null): SearchSurface | null {
  return (prefer ? surfaces.get(prefer) : null) ?? surfaces.get('grid') ?? surfaces.get('outline') ?? null
}
