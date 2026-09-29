import { useEffect, useState } from 'react'
import type { TalkSearchResult } from '../../../../shared/talk-search'
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

export function useTalkSearch({ query, within = '', talksVersion }: {
  query: string
  /** Limit to this folder (vault-relative) and its subfolders; '' = everywhere. */
  within?: string
  /** Changes when the vault's talk list does: the search is re-run. */
  talksVersion: unknown
}): TalkSearchState {
  const searching = hasSearchTerms(query)
  const [result, setResult] = useState<TalkSearchResult | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!searching) { setResult(null); return }
    let cancelled = false
    const id = window.setTimeout(() => {
      window.tw.talks.search(query, within ? { within } : {})
        .then((next) => { if (!cancelled) setResult(next) })
        .catch(() => { /* a failed search leaves the last result up */ })
    }, result ? SEARCH_DEBOUNCE_MS : 0)
    return () => { cancelled = true; window.clearTimeout(id) }
    // result is read only to pick the delay; a new result must not re-run the search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, searching, within, talksVersion, tick])
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
