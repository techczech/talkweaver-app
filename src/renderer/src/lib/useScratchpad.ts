// The Slide Scratchpad's data in the renderer: the snapshot main keeps (src/main/scratchpad-store.ts),
// kept fresh by window.tw.scratchpad.onChanged, and the actions that change it. The renderer never
// touches a file; every action is one call across the bridge and the answer is the new snapshot.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ScratchGroup, ScratchSnapshot, ScratchStatus } from '../../../preload/index'
import { listCounts } from '../../../shared/scratchpad'
import { notify } from './notify'

const EMPTY: ScratchSnapshot = { groups: [], items: [], notices: [] }

export interface ScratchpadData {
  snapshot: ScratchSnapshot
  /** True until the first snapshot for this talk has arrived. */
  loading: boolean
  /** The active-item count the toolbar and the pill show. */
  activeCount: number
  setStatus: (ids: string[], status: ScratchStatus) => Promise<boolean>
  setGroup: (ids: string[], group: string | null) => Promise<boolean>
  createGroup: (name: string) => Promise<ScratchGroup | null>
  removeMissing: (ids: string[]) => Promise<boolean>
}

/** `talkKey` is the open talk's outline path (null: no talk, nothing is read). */
export function useScratchpad(talkKey: string | null): ScratchpadData {
  const [snapshot, setSnapshot] = useState<ScratchSnapshot>(EMPTY)
  const [loading, setLoading] = useState(true)
  const noticeShown = useRef('')

  useEffect(() => {
    setSnapshot(EMPTY)
    setLoading(true)
    if (!talkKey) return undefined
    let live = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const stop = window.tw.scratchpad.onChanged((next) => { if (live) setSnapshot(next) })
    // The window claims the talk a moment after it is opened; until it has, main answers "open a talk first",
    // so the first subscription is tried again a few times.
    const connect = (attempt: number): void => {
      window.tw.scratchpad.subscribe().then((reply) => {
        if (!live) return
        if (reply.ok) { setSnapshot(reply.snapshot); setLoading(false) }
        else if (attempt < 20) timer = setTimeout(() => connect(attempt + 1), 250)
        else setLoading(false)
      }, () => { if (live) setLoading(false) })
    }
    connect(0)
    return () => { live = false; if (timer) clearTimeout(timer); stop(); void window.tw.scratchpad.unsubscribe() }
  }, [talkKey])

  // A state file that could not be read is said once per distinct message, never silently.
  useEffect(() => {
    const text = snapshot.notices.join('\n')
    if (text && text !== noticeShown.current) notify(snapshot.notices.join(' '), 'warning', 'scratchpad-state')
    noticeShown.current = text
  }, [snapshot.notices])

  const apply = useCallback(async <T extends { snapshot: ScratchSnapshot }>(call: Promise<{ ok: true } & T | { ok: false; error: string }>): Promise<T | null> => {
    try {
      const reply = await call
      if (!reply.ok) { notify(reply.error, 'warning', 'scratchpad'); return null }
      setSnapshot(reply.snapshot)
      return reply
    } catch (error) {
      notify(error instanceof Error ? error.message : 'The Slide Scratchpad could not change.', 'warning', 'scratchpad')
      return null
    }
  }, [])

  return useMemo<ScratchpadData>(() => ({
    snapshot,
    loading,
    activeCount: listCounts(snapshot.items).active,
    setStatus: async (ids, status) => (await apply(window.tw.scratchpad.setStatus(ids, status))) !== null,
    setGroup: async (ids, group) => (await apply(window.tw.scratchpad.setGroup(ids, group))) !== null,
    createGroup: async (name) => (await apply(window.tw.scratchpad.createGroup(name)))?.group ?? null,
    removeMissing: async (ids) => (await apply(window.tw.scratchpad.removeMissing(ids))) !== null
  }), [snapshot, loading, apply])
}
