// Browser adapter for the shared slide-thumbnail route; only UI progress and retry nonces live here.
import { useEffect, useRef, useState } from 'react'
import { sourceThumbnailClient } from '../../lib/slideThumbnails'
import type { SearchResult } from './types'

export function useThumbRegen(isOpen: boolean) {
  const [thumbNonces, setThumbNonces] = useState<Record<string, number>>({})
  const [regenTalk, setRegenTalk] = useState<string | null>(null)
  const isOpenRef = useRef(isOpen)
  isOpenRef.current = isOpen
  const paths = useRef(new Map<string, string>())
  const client = useRef<ReturnType<typeof sourceThumbnailClient> | null>(null)
  useEffect(() => {
    if (!isOpen) return
    client.current = sourceThumbnailClient(path => {
      const slug = paths.current.get(path)
      if (slug && isOpenRef.current) setThumbNonces(n => ({ ...n, [slug]: (n[slug] ?? 0) + 1 }))
    }, path => { if (isOpenRef.current) setRegenTalk(path ? paths.current.get(path) ?? null : null) })
    return () => { client.current?.dispose(); client.current = null; paths.current.clear() }
  }, [isOpen])
  function noteThumbUnavailable(row: SearchResult): void {
    if (!row.outlinePath || !isOpenRef.current) return
    paths.current.set(row.outlinePath, row.talkSlug)
    client.current?.note(row.outlinePath)
  }
  function resetThumbQueue(): void { client.current?.reset() }
  return { thumbNonces, regenTalk, noteThumbUnavailable, resetThumbQueue, isOpenRef }
}
