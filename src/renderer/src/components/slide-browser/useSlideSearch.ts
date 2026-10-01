// The Browser's data: the debounced slide search (request-id guarded, ported from SearchPalette),
// the UNQUERIED index snapshot the rail reads, and the once-per-opening vault reference fetches.
import { useEffect, useRef, useState } from 'react'
import type { RecordingSession, TagCount, TalkInfo, TalkMeta } from '../../../../preload/index'
import type { parseSearchQuery } from '../slideBrowserModel'
import { DEBOUNCE_MS, type SearchResult } from './types'

export function useSlideSearch({ isOpen, parsedQuery, refreshNonce, onLanded, vaultIds }: {
  isOpen: boolean
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
  // browsing structure stays stable while the user types a query.
  const [fullRows, setFullRows] = useState<SearchResult[]>([])
  const [unavailable, setUnavailable] = useState(false)
  const [loading, setLoading] = useState(false)
  const reqIdRef = useRef(0)

  // Debounced search with a request-id guard (ported from SearchPalette).
  const vaultKey = vaultIds ? vaultIds.join('\n') : null
  useEffect(() => {
    if (!isOpen || vaultKey === null) return
    const reqId = ++reqIdRef.current
    setLoading(true)
    const handle = setTimeout(async () => {
      const rows = await window.tw.search.allSlides(parsedQuery, { vaultIds: vaultKey.split('\n').filter(Boolean) })
      if (reqId !== reqIdRef.current) return
      setLoading(false)
      if (rows === null) { setUnavailable(true); setResults([]); return }
      setUnavailable(false); setResults(rows as SearchResult[]); onLanded()
      // An empty query returns the WHOLE index — snapshot it for the rail's stable
      // structure (tree, counts, vocabularies) so typing never reshapes Browse.
      if (parsedQuery.terms.length === 0 && parsedQuery.text.trim() === '') {
        setFullRows(rows as SearchResult[])
      }
    }, DEBOUNCE_MS)
    return () => clearTimeout(handle)
    // refreshNonce re-runs the search after a merge so the cluster reflects its new shared id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsedQuery, isOpen, refreshNonce, vaultKey])

  return { results, fullRows, setFullRows, unavailable, setUnavailable, loading }
}

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
