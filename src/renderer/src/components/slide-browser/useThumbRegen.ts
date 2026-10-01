// Progressive real-thumbnail fill-in (Gate-4 bug 4, ADR-0034 demands real prints): talks
// whose twthumb:// prints 404 (their thumbnail cache was never built — only talks opened
// in the editor get a tw.talk.thumbnails run) are rendered in the background from the
// Browser, strictly ONE talk at a time (each run opens a hidden window). When a talk's run
// renders something, its nonce bumps and that talk's <img>s remount and retry. Guards: the
// chain runs only while the Browser is open, and a talk has at most one request in flight.
import { useEffect, useRef, useState } from 'react'
import { createThumbRegenQueue } from '../../lib/thumbnailRegenQueue'
import type { SearchResult } from './types'

export function useThumbRegen(isOpen: boolean) {
  const [thumbNonces, setThumbNonces] = useState<Record<string, number>>({})
  const [regenTalk, setRegenTalk] = useState<string | null>(null)
  // The queue rule lives in lib/thumbnailRegenQueue: an empty result is "not now" (deferred, no
  // attempt consumed, no cap), a fault is capped at two attempts, a rendered talk is done.
  const thumbQueueRef = useRef(createThumbRegenQueue())
  const regenRunningRef = useRef(false)
  const isOpenRef = useRef(isOpen)
  useEffect(() => {
    isOpenRef.current = isOpen
    if (!isOpen) thumbQueueRef.current.reset() // stop the chain's queue on close
  }, [isOpen])

  async function runThumbRegenChain(): Promise<void> {
    if (regenRunningRef.current) return
    regenRunningRef.current = true
    try {
      while (isOpenRef.current) {
        const step = thumbQueueRef.current.next(Date.now())
        if (step.kind === 'idle') break
        if (step.kind === 'wait') {
          // A deferred talk is coming back. Sleep in short slices so closing the Browser stops
          // the chain promptly instead of after the full deferral.
          await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(step.ms, 250), 2000)))
          continue
        }
        const { slug, outlinePath } = step
        setRegenTalk(slug)
        // null = a fault (unreadable outline, main returned null, or the call threw) — capped.
        // 0 = main said "not now" — deferred, uncapped. > 0 = prints written.
        let rendered: number | null = null
        try {
          const content = await window.tw.talk.readOutline(outlinePath)
          if (content != null && isOpenRef.current) {
            // Own lane: the editor strip's compile→thumbnails cycle must never supersede this render.
            const map = await window.tw.talk.thumbnails(outlinePath, content, { lane: 'browser' })
            rendered = map ? Object.keys(map).length : null
          } else if (content != null) {
            rendered = 0 // closed mid-run: not a fault, offer the talk again next opening
          }
        } catch { /* one bad talk must not stall the rest of the chain */ }
        const settled = thumbQueueRef.current.settle(slug, { rendered }, Date.now())
        if (settled.bumpNonce && isOpenRef.current) {
          setThumbNonces((n) => ({ ...n, [slug]: (n[slug] ?? 0) + 1 }))
        }
        setRegenTalk(null)
      }
    } finally {
      regenRunningRef.current = false
      setRegenTalk(null)
    }
  }
  function noteThumbUnavailable(row: SearchResult): void {
    if (!row.outlinePath || !isOpenRef.current) return
    if (!thumbQueueRef.current.note(row.talkSlug, row.outlinePath)) return
    void runThumbRegenChain()
  }
  /** A fresh opening looks at every talk again: one rendered by the editor lane since the last
   *  opening, or deferred while the heap was high, gets another chance at a real print rather
   *  than staying on its schematic until the app is relaunched (2026-09-15). */
  function resetThumbQueue(): void {
    thumbQueueRef.current.reset()
  }

  return { thumbNonces, regenTalk, noteThumbUnavailable, resetThumbQueue, isOpenRef }
}
