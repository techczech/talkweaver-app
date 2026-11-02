// The Browser's data: the debounced slide search (request-id guarded, ported from SearchPalette),
// the UNQUERIED index snapshot the rail reads, and the once-per-opening vault reference fetches.
import { useEffect, useRef, useState } from 'react'
import type { RecordingSession, TagCount, TalkInfo, TalkMeta } from '../../../../preload/index'
import type { parseSearchQuery } from '../slideBrowserModel'
import { type BrowserRowsReply, fetchBrowserRows, fetchIndexStamp, heldSetCurrent } from './searchReply'
import type { SearchResult } from './types'

// A token per page load, part of the search's supersede key: request ids start again at 1 after a
// reload, and main must never compare them with the previous load's ids (search-supersede.ts).
const SEARCH_LOAD_TOKEN = Math.random().toString(36).slice(2) + Date.now().toString(36)

const isEmptyQuery = (q: ReturnType<typeof parseSearchQuery>): boolean => q.terms.length === 0 && q.text.trim() === ''

export function useSlideSearch({ isOpen, parsedQuery, refreshNonce, onLanded, vaultIds }: {
  isOpen: boolean
  /** The committed (already debounced) query: the search field debounces typing itself. */
  parsedQuery: ReturnType<typeof parseSearchQuery>
  /** Every open vault (ticket 06): the search covers them all and the chips filter the rows. null
   *  while the vault list loads — the search waits for it. */
  vaultIds: string[] | null
  /** Bumped by the host after a merge — re-runs the search so the cluster shows its new shared id. */
  refreshNonce?: number
  /** A fresh result set landed: the focus returns to its first card. */
  onLanded: () => void
}) {
  const [results, setResults] = useState<SearchResult[]>([])
  // The UNQUERIED index snapshot — captured whenever an empty-query search lands (the open
  // itself runs one). Feeds the Files tree, scope-row counts and facet vocabularies, so
  // browsing structure stays stable while the user types a query. Clearing the search shows it
  // again without a new scan, but only once main says it is still current (its stamp is the one the
  // snapshot was taken under: main/search-index-stamp.ts).
  const [fullRows, setFullRowsState] = useState<SearchResult[]>([])
  const [unavailable, setUnavailable] = useState(false)
  const [loading, setLoading] = useState(false)
  const reqIdRef = useRef(0)
  // What the snapshot was taken against.
  const heldRef = useRef<{ vaultKey: string | null; stamp: string | null }>({ vaultKey: null, stamp: null })

  const vaultKey = vaultIds ? vaultIds.join('\n') : null
  const vaultList = (key: string): string[] => key.split('\n').filter(Boolean)
  function holdFull(rows: SearchResult[], key: string, stamp: string | null): void {
    heldRef.current = { vaultKey: key, stamp }
    setFullRowsState(rows)
  }

  // What changed since the last run: only the query (typing, clearing) may reuse the snapshot; an
  // opening, a merge or a vault change always asks main.
  const prevRef = useRef<{ isOpen: boolean; refreshNonce?: number; vaultKey: string | null } | null>(null)
  const fullRowsRef = useRef(fullRows)
  fullRowsRef.current = fullRows

  // Request-id guarded search (ported from SearchPalette). The search field already debounced the
  // typing; the timer here only coalesces changes that land in the same tick.
  useEffect(() => {
    const prev = prevRef.current
    prevRef.current = { isOpen, refreshNonce, vaultKey }
    if (!isOpen || vaultKey === null) return
    const onlyQueryChanged = prev !== null && prev.isOpen && prev.refreshNonce === refreshNonce && prev.vaultKey === vaultKey
    const reqId = ++reqIdRef.current
    const search = async (): Promise<void> => {
      let reply: BrowserRowsReply | null = null
      try {
        reply = await fetchBrowserRows(parsedQuery, { vaultIds: vaultList(vaultKey), requestId: reqId, supersedeKey: `slide-browser:${SEARCH_LOAD_TOKEN}` })
      } catch { reply = null }
      if (reqId !== reqIdRef.current) return
      setLoading(false)
      if (reply === null) { setUnavailable(true); setResults([]); return }
      setUnavailable(false); setResults(reply.rows); onLanded()
      // An empty query returns the WHOLE index — snapshot it for the rail's stable
      // structure (tree, counts, vocabularies) so typing never reshapes Browse.
      if (isEmptyQuery(parsedQuery)) holdFull(reply.rows, vaultKey, reply.stamp)
    }
    if (onlyQueryChanged && isEmptyQuery(parsedQuery) && heldRef.current.vaultKey === vaultKey && fullRowsRef.current.length > 0) {
      // Clearing the search: the whole set may already be here. Nothing is shown until main says it
      // is current; when it is not, this is an ordinary search (loading state, errors and all).
      const held = heldRef.current
      const heldRows = fullRowsRef.current
      void (async () => {
        const stampNow = await fetchIndexStamp(vaultList(vaultKey))
        if (reqId !== reqIdRef.current) return
        if (heldSetCurrent({ heldVaultKey: held.vaultKey, vaultKey, heldStamp: held.stamp, stampNow })) {
          setLoading(false); setUnavailable(false); setResults(heldRows); onLanded()
          return
        }
        setLoading(true)
        await search()
      })()
      return
    }
    setLoading(true)
    const handle = setTimeout(() => { void search() }, 0)
    return () => clearTimeout(handle)
    // refreshNonce re-runs the search after a merge so the cluster reflects its new shared id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsedQuery, isOpen, refreshNonce, vaultKey])

  /** Fetch the whole index for the snapshot only (the results stay as they are): the talk beside
   *  and Select section need a talk's whole rows when a query superseded the opening's search. */
  async function refetchFull(isStillOpen: () => boolean): Promise<void> {
    if (vaultKey === null) return
    const key = vaultKey
    try {
      const reply = await fetchBrowserRows(parseSearchQueryEmpty, { vaultIds: vaultList(key) })
      if (reply && isStillOpen()) holdFull(reply.rows, key, reply.stamp)
    } catch { /* the live results stand in */ }
  }

  return { results, fullRows, refetchFull, unavailable, setUnavailable, loading }
}

const parseSearchQueryEmpty = { scope: 'all' as const, exact: false, text: '', terms: [] as string[] }

export function useVaultReferences(isOpen: boolean) {
  const [talks, setTalks] = useState<TalkInfo[]>([])
  // Vault folders, empty ones included: the Files tree has every folder the file list has.
  const [vaultFolders, setVaultFolders] = useState<string[]>([])
  const [talkMeta, setTalkMeta] = useState<TalkMeta>({})
  const [tagVocab, setTagVocab] = useState<TagCount[]>([])
  const [deliverySessions, setDeliverySessions] = useState<RecordingSession[]>([])

  // One-time-per-opening reference fetches for the rail (never in the filter hot path):
  // vault talks, per-talk meta (covers, editedMs), the tag vocabulary, delivery sessions.
  useEffect(() => {
    if (!isOpen) return
    window.tw.vault.listTalks().then((t) => setTalks(t || [])).catch(() => setTalks([]))
    try { window.tw.vault.listFolders().then((f) => setVaultFolders(f || [])).catch(() => setVaultFolders([])) } catch { setVaultFolders([]) }
    try { window.tw.vault.talkMeta().then((m) => setTalkMeta(m || {})).catch(() => setTalkMeta({})) } catch { setTalkMeta({}) }
    try { window.tw.tags.vocabulary().then((v) => setTagVocab(v || [])).catch(() => setTagVocab([])) } catch { setTagVocab([]) }
    try {
      window.tw.recording.listAllSessions()
        .then((s) => setDeliverySessions((s || []).filter((x) => x.kind === 'delivery' && x.status !== 'planned')))
        .catch(() => setDeliverySessions([]))
    } catch { setDeliverySessions([]) }
  }, [isOpen])

  return { talks, vaultFolders, talkMeta, tagVocab, deliverySessions }
}
