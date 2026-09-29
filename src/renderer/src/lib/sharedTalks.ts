import { useEffect, useState } from 'react'
import type { SharedTalkState } from '../../../shared/shared-talk'

// Share for comments (ticket 03): which talks are shared, for the talk row's "Shared" badge and the
// status bar. Keyed by the talk's identity (main's outlineIdentity key); a talk-list row finds its
// share by path (shareForTalk), never by file name — same-named talks are different talks. One module-level store fed by `shared-talk:list` once and `shared-talk:changed` after,
// so every surface updates together when a share is created, pushed or stopped.

export type SharedTalksByKey = Record<string, SharedTalkState>

let cache: SharedTalksByKey | null = null
const listeners = new Set<(shares: SharedTalksByKey) => void>()
let unsubscribeChanged: (() => void) | null = null

function publish(next: SharedTalksByKey): void {
  cache = next
  for (const notify of [...listeners]) notify(next)
}

function subscribe(notify: (shares: SharedTalksByKey) => void): () => void {
  listeners.add(notify)
  if (!unsubscribeChanged && window.tw?.sharedTalk) {
    unsubscribeChanged = window.tw.sharedTalk.onChanged(({ key, state, previousKey }) => {
      const next = { ...(cache ?? {}) }
      // A re-key replaces the entry in ONE publish: no surface sees the share gone for a moment.
      if (previousKey && previousKey !== key) delete next[previousKey]
      if (state) next[key] = state
      else delete next[key]
      publish(next)
    })
    void window.tw.sharedTalk.list().then((list) => {
      const next: SharedTalksByKey = { ...(cache ?? {}) }
      for (const share of list || []) next[share.key] = { ...share, ...(next[share.key] ?? {}) }
      publish(next)
    }).catch(() => {})
  }
  if (cache) notify(cache)
  return () => {
    listeners.delete(notify)
    if (listeners.size === 0 && unsubscribeChanged) {
      unsubscribeChanged()
      unsubscribeChanged = null
      cache = null
    }
  }
}

/** Every shared talk, by identity key. */
export function useSharedTalks(): SharedTalksByKey {
  const [shares, setShares] = useState<SharedTalksByKey>(() => cache ?? {})
  useEffect(() => subscribe(setShares), [])
  return shares
}

/** The share for a talk-list talk: matched on its outline path (as opened, or its real path). */
export function shareForTalk(shares: SharedTalksByKey, outlinePath: string | null | undefined): SharedTalkState | null {
  if (!outlinePath) return null
  for (const share of Object.values(shares)) if (share.outlinePath === outlinePath || share.realPath === outlinePath) return share
  return null
}
