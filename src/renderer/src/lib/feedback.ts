import { useCallback, useEffect, useRef, useState } from 'react'
import type { FeedbackList, FeedbackStatus, FeedbackSummary } from '../../../shared/feedback'
import type { AcceptRecord } from '../../../shared/feedback-accept'

// Feedback rail (ticket 05): the renderer's view of each share's feedback. Summaries (unread count,
// owner socket state) for every share live in one module-level store fed by
// `shared-talk:feedback-summaries` once and `shared-talk:feedback-changed` after, so the talk row,
// the toolbar button and the status bar move together. The rail's list is read from main, which
// folds the talk's feedback file; it is re-read whenever that share's summary changes. Keyed by
// share id (a talk's identity key moves on every atomic save; its share id does not).

export type FeedbackByKey = Record<string, FeedbackSummary>

let cache: FeedbackByKey | null = null
const listeners = new Set<(summaries: FeedbackByKey) => void>()
let unsubscribe: (() => void) | null = null

function publish(next: FeedbackByKey): void {
  cache = next
  for (const notify of [...listeners]) notify(next)
}

function subscribe(notify: (summaries: FeedbackByKey) => void): () => void {
  listeners.add(notify)
  const bridge = window.tw?.sharedTalk
  if (!unsubscribe && bridge?.onFeedbackChanged) {
    unsubscribe = bridge.onFeedbackChanged(({ shareId, summary }) => {
      const next = { ...(cache ?? {}) }
      if (summary) next[shareId] = summary
      else delete next[shareId]
      publish(next)
    })
    void bridge.feedbackSummaries().then((list) => {
      const next: FeedbackByKey = {}
      for (const summary of list || []) next[summary.shareId] = summary
      publish({ ...next, ...(cache ?? {}) })
    }).catch(() => {})
  }
  if (cache) notify(cache)
  return () => {
    listeners.delete(notify)
    if (listeners.size === 0 && unsubscribe) {
      unsubscribe()
      unsubscribe = null
      cache = null
    }
  }
}

/** Every share's feedback summary, by share id. */
export function useFeedbackSummaries(): FeedbackByKey {
  const [summaries, setSummaries] = useState<FeedbackByKey>(() => cache ?? {})
  useEffect(() => subscribe(setSummaries), [])
  return summaries
}

/** The talk's feedback list (the rail's items and the slide pane's markers), re-read from main when
 *  its share's summary changes. */
export function useFeedbackList(outlinePath: string | null, summary: FeedbackSummary | null, enabled: boolean): {
  list: FeedbackList | null
  /** Resolves to the error, or null once main recorded it. */
  setStatus: (itemId: string, status: FeedbackStatus, edit?: AcceptRecord | null) => Promise<{ success: boolean; error?: string }>
  setError: (error: string | null) => void
  error: string | null
} {
  const [list, setList] = useState<FeedbackList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const request = useRef(0)
  // Everything that changes when the file changes: a re-read on each.
  const version = summary ? `${summary.shareId}:${summary.total}:${summary.unread}:${summary.connection}` : ''

  useEffect(() => {
    if (!enabled || !outlinePath || !window.tw?.sharedTalk?.feedbackList) { setList(null); return }
    const id = ++request.current
    void window.tw.sharedTalk.feedbackList(outlinePath).then((next) => {
      if (request.current === id) setList(next)
    }).catch(() => {})
  }, [outlinePath, version, enabled])

  const setStatus = useCallback(async (itemId: string, status: FeedbackStatus, edit?: AcceptRecord | null) => {
    if (!outlinePath) return { success: false, error: 'No talk is open.' }
    setError(null)
    const result = await window.tw.sharedTalk.setFeedbackStatus(outlinePath, itemId, status, edit)
    if (!result.success) { setError(result.error || 'That did not work.'); return { success: false, error: result.error || 'That did not work.' } }
    if (result.list) { request.current += 1; setList(result.list) }
    return { success: true }
  }, [outlinePath])

  return { list, setStatus, error, setError }
}
