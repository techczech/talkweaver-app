// The one renderer adapter for the Browser's search reply (shared/slide-search-reply.ts): asks main
// for the compact form and gives every row its talk fields back, so the rest of the renderer keeps
// its SearchResult row type. No React, no DOM.
import { expandSlideSearchReply, isCompactSlideSearchReply } from '../../../../shared/slide-search-reply'
import type { parseSearchQuery } from '../slideBrowserModel'
import type { SearchResult } from './types'

export interface BrowserRowsReply {
  rows: SearchResult[]
  /** Main's freshness stamp for this reply (taken before its scan); null when main did not stamp it. */
  stamp: string | null
}

/** null = search unavailable (main answered null or the call failed outright). */
export async function fetchBrowserRows(
  query: ReturnType<typeof parseSearchQuery>,
  options: { vaultIds?: string[]; requestId?: number; supersedeKey?: string }
): Promise<BrowserRowsReply | null> {
  const search = window.tw.search
  const reply = typeof search.allSlidesCompact === 'function'
    ? await search.allSlidesCompact(query, options)
    : await search.allSlides(query, options)
  if (reply === null || reply === undefined) return null
  if (isCompactSlideSearchReply(reply)) {
    return { rows: expandSlideSearchReply<SearchResult>(reply), stamp: typeof reply.stamp === 'string' ? reply.stamp : null }
  }
  return { rows: (Array.isArray(reply) ? reply : []) as SearchResult[], stamp: null }
}

/** The stamp a whole-index scan would carry now; null when main cannot say (then nothing held is reused). */
export async function fetchIndexStamp(vaultIds: string[]): Promise<string | null> {
  const probe = window.tw.search.indexStamp
  if (typeof probe !== 'function') return null
  try {
    const stamp = await probe({ vaultIds })
    return typeof stamp === 'string' && stamp !== '' ? stamp : null
  } catch { return null }
}

/** Is a held whole-index snapshot still current? Pure: only when it was taken for these vaults and
 *  main's stamp now is the one it was taken under. Any unknown reads as stale. */
export function heldSetCurrent(s: {
  heldVaultKey: string | null
  vaultKey: string | null
  heldStamp: string | null
  /** Main's stamp now (fetchIndexStamp). */
  stampNow: string | null
}): boolean {
  if (s.heldVaultKey === null || s.heldVaultKey !== s.vaultKey) return false
  if (s.heldStamp === null || s.stampNow === null) return false
  return s.heldStamp === s.stampNow
}
