import { useEffect, useState } from 'react'
import { emptyTalkSearchResult, talkSearchRequestOptions, type TalkSearchResult } from '../../../../shared/talk-search'
import { hasSearchTerms } from '../../../../shared/talk-query'

// The one talk-search call of the renderer (ADR-0029 §1): the Talks browser's search box and the
// slide picker's "Find a talk" (ticket talk-search 05) both ask the main process through this
// hook, so the same query gives the same talks in the same order on both surfaces.
//
// One request per settled query: the first keystroke goes at once, later ones coalesce. The last
// result stays up until the next arrives, so typing never flashes an empty list. While slide text
// is still being read, the search is re-run on an interval so late matches appear (frame L9).

const SEARCH_DEBOUNCE_MS = 60
const SEARCH_READING_POLL_MS = 1200

export interface TalkSearchState {
  /** The query holds a real term (a lone `fo:` while typing is not yet a search). */
  searching: boolean
  /** The last result, or null while not searching. */
  result: TalkSearchResult | null
  /** The result on screen answers exactly this query and folder. */
  settled: boolean
}

export function useTalkSearch({ query, within = '', vaultIds, talksVersion }: {
  query: string
  /** Limit to this folder (vault-relative) and its subfolders; '' = everywhere. */
  within?: string
  /** Search these open vaults (results are merged, in this order); omitted = the first open vault;
   *  an empty list searches nothing (every shown vault is unavailable, ticket 07). */
  vaultIds?: string[]
  /** Changes when the vault's talk list does: the search is re-run. */
  talksVersion: unknown
}): TalkSearchState {
  const searching = hasSearchTerms(query)
  const vaultKey = vaultIds ? vaultIds.join('\u001f') : ''
  const noVaults = !!vaultIds && vaultIds.length === 0
  const [result, setResult] = useState<TalkSearchResult | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!searching) { setResult(null); return }
    if (noVaults) { setResult(emptyTalkSearchResult(query, within)); return }
    let cancelled = false
    const id = window.setTimeout(() => {
      // One IPC call for every vault: the main process searches them and merges the results in
      // this order (hits in vault order, counts added), as several calls merged here used to.
      window.tw.talks.search(query, talkSearchRequestOptions(within, vaultKey ? vaultKey.split('\u001f') : undefined))
        .then((merged) => { if (!cancelled && merged) setResult(merged) })
        .catch(() => { /* a failed search leaves the last result up */ })
    }, result ? SEARCH_DEBOUNCE_MS : 0)
    return () => { cancelled = true; window.clearTimeout(id) }
    // result is read only to pick the delay; a new result must not re-run the search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, searching, within, vaultKey, noVaults, talksVersion, tick])
  const stillReading = !!result && result.slideText.read < result.slideText.total
  useEffect(() => {
    if (!searching || !stillReading) return
    const id = window.setInterval(() => setTick((n) => n + 1), SEARCH_READING_POLL_MS)
    return () => window.clearInterval(id)
  }, [searching, stillReading])
  useEffect(() => window.tw.vault.onTalkMetaUpdated(() => setTick((n) => n + 1)), [])
  const settled = !!result && result.query === query && (result.within ?? '') === within
  return { searching, result, settled }
}
