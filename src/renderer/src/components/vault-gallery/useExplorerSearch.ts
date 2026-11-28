import { useEffect, useMemo, useRef, useState } from 'react'
import { highlightTerms, isEmptyQuery, matchHay, parseQuery } from '../../../../shared/slide-handling/query'
import { plainTalkTitle } from '../../../../shared/plain-title'
import { rankBySearch } from '../slideBrowserModel'
import { fetchBrowserRows } from '../slide-browser/searchReply'
import type { SearchResult } from '../slide-browser/types'
import { withinPlace, type ExplorerPlace, type ExplorerResult, type ExplorerTalk } from './explorerModel'

export type ExplorerSearchScope = 'titles' | 'slides'
let nextRequest = 0

export function useExplorerSearch(raw: string, talks: ExplorerTalk[], vaultIds: string[], place: ExplorerPlace | null) {
  const query = raw.trim()
  const slideQuery = useMemo(() => parseQuery(query, { operators: true, prefixes: false }), [query])
  const titleQuery = useMemo(() => parseQuery(query, { operators: false, prefixes: false }), [query])
  const vaultKey = (place ? [place.vaultId] : vaultIds).join('\0')
  const request = useMemo(() => ({ vaultKey, slideQuery, talks }), [vaultKey, slideQuery, talks])
  const wantsSlides = !isEmptyQuery(slideQuery) && !!vaultKey
  const [reply, setReply] = useState<{ request: typeof request; rows: SearchResult[] | null }>()
  const latest = useRef(request)
  latest.current = request
  useEffect(() => {
    if (!wantsSlides) return
    let live = true
    const timer = window.setTimeout(() => {
      const settle = (rows: SearchResult[] | null) => { if (live && latest.current === request) setReply({ request, rows }) }
      void fetchBrowserRows(request.slideQuery, { vaultIds: request.vaultKey.split('\0'), requestId: ++nextRequest, supersedeKey: 'vault-explorer', includeMatch: true })
        .then(value => settle(value?.rows ?? null), () => settle(null))
    }, 200)
    return () => { live = false; window.clearTimeout(timer) }
  }, [request, wantsSlides])

  const eligible = useMemo(() => talks.filter(talk => withinPlace(talk, place)), [talks, place])
  const titles = useMemo<ExplorerResult[]>(() => !titleQuery.terms.length ? [] : eligible
    .filter(talk => matchHay(plainTalkTitle(talk.title).toLowerCase(), titleQuery) || matchHay(talk.folder.toLowerCase(), titleQuery))
    .sort((a, b) => Number(plainTalkTitle(b.title).toLowerCase().startsWith(query.toLowerCase())) -
      Number(plainTalkTitle(a.title).toLowerCase().startsWith(query.toLowerCase())))
    .map(talk => ({ talk })), [eligible, query, titleQuery])
  const slides = useMemo<ExplorerResult[]>(() => {
    if (reply?.request !== request || !reply.rows) return []
    const byPath = new Map(eligible.map(talk => [talk.info.outlinePath, talk]))
    const byTalk = new Map<string, ExplorerResult[]>()
    for (const slide of rankBySearch(reply.rows)) {
      const talk = byPath.get(slide.outlinePath)
      if (!talk || slide.vaultId !== talk.vaultId) continue
      const group = byTalk.get(slide.outlinePath)
      if (group) group.push({ talk, slide })
      else byTalk.set(slide.outlinePath, [{ talk, slide }])
    }
    return [...byTalk.values()].flat()
  }, [eligible, request, reply])

  return {
    titles,
    slides,
    pending: wantsSlides && reply?.request !== request,
    unavailable: wantsSlides && reply?.request === request && !reply.rows,
    titleTerms: highlightTerms(titleQuery),
    slideTerms: highlightTerms(slideQuery)
  }
}
