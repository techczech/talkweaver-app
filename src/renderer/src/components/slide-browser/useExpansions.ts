// What expands under a card: the version filmstrip (A3 — the signature), the identical-stack
// locations panel, and the near-cluster uncollapse; plus the version-badge counts they share.
// One expansion is open at a time (the filmstrip and the locations panel share one slot).
import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from 'react'
import type { LedgerVersion } from '../../../../preload/index'
import { notify } from '../../lib/notify'
import { type DisplayCard, selRowKey, stampedIdOf } from '../slideBrowserModel'
import { toggleInSet, versionSourceOutline } from './browserHelpers'
import type { OpenLoc, OpenStrip, SearchResult, VersionCounts } from './types'

export function useExpansions({ isOpen, vRows, vCards, vaultRoot, onInsert, setNearExpanded }: {
  isOpen: boolean
  vRows: SearchResult[]
  vCards: DisplayCard[]
  vaultRoot: string
  onInsert: (markdown: string, fromSlug: string, sourceOutlinePath: string) => void
  /** The near-cluster keys the user has UNcollapsed live in the shell: the display model reads them. */
  setNearExpanded: Dispatch<SetStateAction<Set<string>>>
}) {
  const [openStrip, setOpenStrip] = useState<OpenStrip | null>(null)
  // Which version print just inserted — its button reads 'Inserted ✓' for 900ms (mockup 2159-2165).
  const [flashFile, setFlashFile] = useState<string | null>(null)
  // Duplicate collapse (Task 9): the ONE open identical-stack locations panel (keyed by the stack
  // card's rowKey), sharing the expansion slot with the version filmstrip so only one thing
  // expands at a time.
  const [openLoc, setOpenLoc] = useState<OpenLoc | null>(null)
  // Badge counts cache: id → {versions, talks}. Fills LAZILY (on expansion + an idle
  // background sweep) — NEVER one ledger IPC per card per keystroke. Shared across
  // searches and across openings (the component stays mounted while closed).
  const countsRef = useRef(new Map<string, VersionCounts>())
  const countsFetchingRef = useRef(new Set<string>())
  const [, setCountsNonce] = useState(0)

  /** A fresh opening: nothing expanded, and the badge counts refetch — an adoption/save between
   *  openings changes the version/talk counts, so a cache carried across would show stale badges. */
  function resetExpansions(): void {
    setOpenStrip(null); setFlashFile(null); setNearExpanded(new Set()); setOpenLoc(null)
    countsRef.current.clear()
  }

  // Fetch versions+whereUsed counts for ONE id and cache them. Used by the strip expansion
  // and the idle background sweep; never called per-card-per-render.
  async function fetchCounts(id: string): Promise<VersionCounts | null> {
    const cached = countsRef.current.get(id)
    if (cached) return cached
    if (countsFetchingRef.current.has(id)) return null
    countsFetchingRef.current.add(id)
    try {
      const [vers, used] = await Promise.all([window.tw.ledger.versions(id), window.tw.ledger.whereUsed(id)])
      const c = { versions: (vers ?? []).length, talks: new Set((used ?? []).map((u) => u.talk)).size }
      countsRef.current.set(id, c)
      setCountsNonce((n) => n + 1)
      return c
    } catch {
      return null
    } finally {
      countsFetchingRef.current.delete(id)
    }
  }

  // Opportunistic badge fill: one uncached id at a time on a 300ms timer, so badges ripen
  // without a burst of IPC on search. NOT requestIdleCallback: verified live that rIC never
  // fires in this Electron renderer window (Chromium idle-period starvation), so the timer
  // is the real path, not the fallback.
  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    let handle: number | undefined
    const cancel = (h: number): void => window.clearTimeout(h)
    const schedule = (fn: () => void): void => { handle = window.setTimeout(fn, 300) }
    const step = (): void => {
      if (cancelled) return
      const next = vRows
        .map((r) => stampedIdOf(r.source_markdown))
        .find((id): id is string => Boolean(id && !countsRef.current.has(id) && !countsFetchingRef.current.has(id)))
      if (!next) return
      fetchCounts(next).finally(() => { if (!cancelled) schedule(step) })
    }
    schedule(step)
    return () => { cancelled = true; if (handle !== undefined) cancel(handle) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, vRows])

  function closeStrip(): void {
    setOpenStrip(null)
  }
  function closeLoc(): void {
    setOpenLoc(null)
  }

  // Expand/collapse the identical-stack LOCATIONS panel (the "in N talks" pill or E on an identical
  // stack). Shares the expansion slot with the filmstrip, so only one thing is open at a time.
  function toggleLocations(pos: number): void {
    const card = vCards[pos]
    if (!card || card.kind !== 'identical' || !card.cluster) return
    const rowKey = selRowKey(vRows, pos)
    setOpenStrip(null)
    setOpenLoc((cur) => (cur?.rowKey === rowKey ? null : { rowKey, cluster: card.cluster! }))
  }
  // Uncollapse / re-collapse a near cluster (the Uncollapse control or U on a near card/variant).
  function toggleNear(pos: number): void {
    const key = vCards[pos]?.nearKey
    if (!key) return
    setNearExpanded((prev) => toggleInSet(prev, key))
  }

  // Expand/collapse the filmstrip for the card at `pos` (badge click or E). One strip open
  // at a time; expanding another card replaces the first. Thumbnails render in ONE hidden-
  // window batch per id (content-cached server-side), fired once per expansion.
  async function toggleStrip(pos: number): Promise<void> {
    const row = vRows[pos]
    if (!row) return
    const id = stampedIdOf(row.source_markdown)
    if (!id) return // unstamped — no badge, nothing to expand
    const rowKey = selRowKey(vRows, pos)
    if (openStrip?.rowKey === rowKey) { closeStrip(); return }
    setOpenLoc(null)
    setOpenStrip({ id, rowKey, versions: null, thumbs: null })
    try {
      const [vers, used] = await Promise.all([window.tw.ledger.versions(id), window.tw.ledger.whereUsed(id)])
      const list = vers ?? []
      countsRef.current.set(id, { versions: list.length, talks: new Set((used ?? []).map((u) => u.talk)).size })
      setCountsNonce((n) => n + 1)
      if (list.length === 0) {
        setOpenStrip((s) => (s?.rowKey === rowKey ? null : s))
        notify('No versions yet — versions appear when you save changes.', 'info')
        return
      }
      setOpenStrip((s) => (s?.rowKey === rowKey ? { ...s, versions: list } : s))
      window.tw.ledger.versionThumbnails(id)
        .then((t) => setOpenStrip((s) => (s?.rowKey === rowKey ? { ...s, thumbs: t ?? {} } : s)))
        .catch(() => setOpenStrip((s) => (s?.rowKey === rowKey ? { ...s, thumbs: {} } : s)))
    } catch {
      setOpenStrip((s) => (s?.rowKey === rowKey ? null : s))
    }
  }

  // Insert ONE recorded version at the caret. The version's own vault-relative `outline`
  // (its source talk) resolves against vaultRoot for asset materialisation — an old
  // version's relative images live in ITS talk, not the card's current one; the card's
  // outlinePath is only the fallback for pre-outline ledger records. Mockup behaviour:
  // the button flashes 'Inserted ✓' and the Browser STAYS OPEN (unlike the tray insert).
  function insertVersion(v: LedgerVersion, row: SearchResult): void {
    onInsert(v.markdown, v.talk ?? row.talkSlug, versionSourceOutline(v, vaultRoot, row.outlinePath))
    setFlashFile(v.file)
    window.setTimeout(() => setFlashFile((f) => (f === v.file ? null : f)), 900)
  }

  return {
    openStrip, openLoc, flashFile, countsRef,
    resetExpansions, fetchCounts, closeStrip, closeLoc, toggleLocations, toggleNear, toggleStrip, insertVersion
  }
}
