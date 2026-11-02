// The whole talk comes from the unqueried index snapshot. A query typed straight after opening
// supersedes the opening's empty search, leaving no snapshot; these fetch it (the whole index,
// once per talk per opening, so a talk the index lacks cannot loop) for the talk beside the
// results and for Select section, which reads each heading's N and slides from the whole talk.
import { type MutableRefObject, useEffect, useRef } from 'react'
import type { SearchResult } from './types'

export function useSnapshotFetch({ isOpen, isOpenRef, beside, fullRows, results, rowsByTalk, refetchFull }: {
  isOpen: boolean
  isOpenRef: MutableRefObject<boolean>
  beside: { slug: string } | null | undefined
  fullRows: SearchResult[]
  results: SearchResult[]
  rowsByTalk: Map<string, SearchResult[]>
  /** Fetches the whole index of every open vault into the snapshot (useSlideSearch). */
  refetchFull: (isStillOpen: () => boolean) => Promise<void>
}) {
  const snapshotTriedRef = useRef(new Set<string>())
  useEffect(() => {
    if (!isOpen) snapshotTriedRef.current.clear()
  }, [isOpen])
  useEffect(() => {
    const slug = beside?.slug
    if (!slug || !isOpen || snapshotTriedRef.current.has(slug) || fullRows.some((r) => r.talkSlug === slug)) return
    snapshotTriedRef.current.add(slug)
    void refetchFull(() => isOpenRef.current) // on failure the live results stand in
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beside, fullRows, isOpen])
  // A talk showing in the results without whole-talk rows gets them the same way.
  useEffect(() => {
    if (!isOpen) return
    const missing = [...new Set(results.map((r) => r.talkSlug))]
      .filter((slug) => !rowsByTalk.has(slug) && !snapshotTriedRef.current.has(slug))
    if (missing.length === 0) return
    for (const slug of missing) snapshotTriedRef.current.add(slug)
    void refetchFull(() => isOpenRef.current) // on failure: no whole-talk rows, no Select section button
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results, rowsByTalk, isOpen])
}
