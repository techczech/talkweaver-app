// Feedback rail (ticket 05): the main-process feedback service. For every share in the registry it
// holds one owner socket, mirrors what arrives into the talk's feedback file (feedback-mirror.ts),
// and answers the rail: the list read from the file, and Done / Dismiss.
//
// Invariants:
//   - The rail reads the file, never the socket: list() is the mirror's index of the file.
//   - The FILE is the only replay position. Every (re)connect asks `?since=` from what is on disk
//     (FeedbackFold.replayFrom). An item whose write fails is not on disk, so the socket is
//     restarted and asks again from before it; the itemId dedupe absorbs the repeats.
//   - Done / Dismiss / Accept / Undo (back to new) append the status line FIRST (the rail greys at
//     once, online or not), then PATCH the Worker; an accepted line carries the splice Accept made
//     (Undo reverses it in the editor, then sets the item back to new); a confirmed PATCH appends a synced line, a 404/410 a failed line (never
//     re-sent). Statuses still owed are re-sent every time the owner socket opens.
//   - A share that has ended (share.closed, or the probe finding 410 or a refused owner token)
//     stops retrying, shows `ended`, and is reported through onEnded so the registry records it.
//   - A talk whose folder is gone gets no socket (its items wait on the Worker) until the share
//     registry is pointed at the folder again.
//   - Holders are keyed by share id, not the talk's identity key: an atomic save re-keys the share
//     registry row (new inode) and must not cost a reconnect.
//   - The owner token stays in main; summaries and lists carry none.
import { existsSync } from 'fs'
import {
  parseWorkerItem, unreadCount,
  type FeedbackConnection, type FeedbackList, type FeedbackListItem, type FeedbackStatus, type FeedbackSummary,
} from '../shared/feedback.ts'
import type { SharedTalkSlide } from '../shared/shared-talk.ts'
import type { AcceptRecord } from '../shared/feedback-accept.ts'

/** A kept revision: its slides, and when it was pushed (for "written against your 22:51 save"). */
export type RevisionSlides = SharedTalkSlide[] | { slides: SharedTalkSlide[]; pushedAt?: string | null }
import { feedbackFilePath, type FeedbackMirror } from './feedback-mirror.ts'
import { createOwnerSocket, type CreateOwnerSocket, type EndedReason, type OwnerSocket } from './shared-talk-owner-socket.ts'

/** What the service needs of one share (main-only: carries the owner token). */
export interface FeedbackShare {
  key: string
  outlinePath: string
  shareId: string
  ownerToken: string
  workerBaseUrl: string
  /** The link as handed out (for "from drafts.handouts.fyi/k7m2"). */
  url: string
  /** The share has ended (recorded in the registry): no socket. */
  ended?: EndedReason | null
}

export interface SharedTalkFeedbackDeps {
  shares(): FeedbackShare[]
  mirror: FeedbackMirror
  fetch: typeof fetch
  /** Slide text at a revision (ticket 03 keeps it); null when not kept. May throw when corrupt. */
  revisionSlides(outlinePath: string, shareId: string, revision: number): RevisionSlides | null
  /** Keyed by share id. */
  onChange?(shareId: string, summary: FeedbackSummary | null): void
  /** The share ended on the Worker (stopped, retired) or refuses the owner token. */
  onEnded?(shareId: string, reason: EndedReason): void
  createSocket?: CreateOwnerSocket
  reconnectDelayMs?: number
  maxDelayMs?: number
  log?(message: string): void
}

export interface SharedTalkFeedback {
  /** Reconcile sockets with the share registry (call after any share change and at start). */
  sync(): void
  summaries(): FeedbackSummary[]
  list(shareId: string): FeedbackList | null
  /** Done / Dismiss / Accept / Undo: the file first, then the Worker. */
  setStatus(shareId: string, itemId: string, status: FeedbackStatus, edit?: AcceptRecord | null): Promise<FeedbackList | null>
  stopAll(): void
  /** Settles once no write or PATCH is in flight (tests). */
  idle(): Promise<void>
}

interface Holder {
  share: FeedbackShare
  path: string
  socket: OwnerSocket | null
  connection: FeedbackConnection
  /** Items whose write failed: the socket asks again from before the earliest. */
  failed: Map<string, number>
}

const sameSocket = (a: FeedbackShare, b: FeedbackShare): boolean =>
  a.outlinePath === b.outlinePath && a.ownerToken === b.ownerToken && a.workerBaseUrl === b.workerBaseUrl && !a.ended === !b.ended

export function createSharedTalkFeedback(deps: SharedTalkFeedbackDeps): SharedTalkFeedback {
  const log = deps.log ?? (() => {})
  const holders = new Map<string, Holder>()
  const pending = new Set<Promise<unknown>>()
  const patching = new Set<string>()

  function track<T>(promise: Promise<T>): Promise<T> {
    pending.add(promise)
    void promise.catch(() => {}).finally(() => pending.delete(promise))
    return promise
  }

  function summaryOf(holder: Holder): FeedbackSummary {
    let items: { status: FeedbackStatus }[] = []
    try { items = deps.mirror.read(holder.path).items } catch (error) { log(`[shared-talk] feedback file unreadable: ${(error as Error).message}`) }
    return { key: holder.share.key, shareId: holder.share.shareId, unread: unreadCount(items), total: items.length, connection: holder.connection }
  }

  function emit(holder: Holder): void {
    if (holders.get(holder.share.shareId) !== holder) return
    try { deps.onChange?.(holder.share.shareId, summaryOf(holder)) } catch { /* a closing window */ }
  }

  function ownerHeaders(share: FeedbackShare): Record<string, string> {
    return { authorization: `Bearer ${share.ownerToken}`, 'content-type': 'application/json' }
  }

  async function patch(holder: Holder, itemId: string, status: FeedbackStatus): Promise<void> {
    const { share } = holder
    const flight = `${share.shareId}\0${itemId}\0${status}`
    if (patching.has(flight)) return
    patching.add(flight)
    try {
      const response = await deps.fetch(`${share.workerBaseUrl}/shares/${share.shareId}/items/${encodeURIComponent(itemId)}`, {
        method: 'PATCH', headers: ownerHeaders(share), body: JSON.stringify({ status }), signal: AbortSignal.timeout(15_000),
      })
      const latest = () => deps.mirror.read(holder.path).items.find((item) => item.itemId === itemId)
      if (response.ok) {
        // Only if this is still his latest word on the item (a quick Done then Dismiss).
        if (latest()?.status === status) await deps.mirror.markSynced(holder.path, itemId, status)
        return
      }
      if (response.status === 404 || response.status === 410) {
        // The item or the share is gone on the Worker: kept here, never re-sent.
        if (latest()?.status === status) await deps.mirror.markFailed(holder.path, itemId, status, response.status)
        log(`[shared-talk] status ${status} for ${itemId} refused for good (${response.status})`)
        return
      }
      log(`[shared-talk] status ${status} for ${itemId} refused (${response.status}); kept here, retried on reconnect`)
    } catch (error) {
      log(`[shared-talk] status ${status} for ${itemId} not sent (${(error as Error).message}); retried on reconnect`)
    } finally {
      patching.delete(flight)
    }
  }

  /** Is the share still there for this owner token? A status PATCH for an id no item has: 401/403
   *  = token refused, 410 = stopped or retired, anything else = still there (404, 400) or unknown. */
  async function probe(share: FeedbackShare): Promise<EndedReason | null> {
    const response = await deps.fetch(`${share.workerBaseUrl}/shares/${share.shareId}/items/tw-owner-probe`, {
      method: 'PATCH', headers: ownerHeaders(share), body: JSON.stringify({ status: 'new' }), signal: AbortSignal.timeout(10_000),
    })
    if (response.status === 401 || response.status === 403) return 'refused'
    if (response.status === 410) return 'stopped'
    return null
  }

  function resendOwed(holder: Holder): void {
    let owed: Array<{ itemId: string; status: FeedbackStatus }> = []
    try { owed = deps.mirror.read(holder.path).unsynced } catch { return }
    for (const { itemId, status } of owed) void track(patch(holder, itemId, status))
  }

  /** The replay position: the file's, or before the earliest item whose write failed. */
  function sinceOf(holder: Holder): number {
    let since = 0
    try { since = deps.mirror.read(holder.path).replayFrom } catch { return 0 }
    for (const seq of holder.failed.values()) since = Math.min(since, seq - 1)
    return Math.max(0, since)
  }

  function start(share: FeedbackShare): Holder {
    const holder: Holder = { share, path: feedbackFilePath(share.outlinePath, share.shareId), socket: null, connection: 'connecting', failed: new Map() }
    holders.set(share.shareId, holder)
    if (share.ended) { holder.connection = 'ended'; return holder }
    if (!existsSync(share.outlinePath)) {
      holder.connection = 'paused'
      log(`[shared-talk] ${share.shareId}: the talk is not at ${share.outlinePath}; feedback waits on the Worker`)
      return holder
    }
    holder.socket = createOwnerSocket({
      baseUrl: share.workerBaseUrl,
      shareId: share.shareId,
      ownerToken: share.ownerToken,
      since: () => sinceOf(holder),
      createSocket: deps.createSocket,
      reconnectDelayMs: deps.reconnectDelayMs,
      maxDelayMs: deps.maxDelayMs,
      log,
      probe: () => probe(holder.share),
      onConnection: (connection) => {
        holder.connection = connection
        emit(holder)
      },
      onEnded: (reason) => { try { deps.onEnded?.(holder.share.shareId, reason) } catch (error) { log(`[shared-talk] ${(error as Error).message}`) } },
      onOpen: () => resendOwed(holder),
      onItem: (raw) => {
        const item = parseWorkerItem(raw)
        if (!item) { log(`[shared-talk] ${share.shareId}: ignoring an item the app does not accept`); return }
        void track(deps.mirror.addItems(holder.path, [item]).then((added) => {
          if (holder.failed.delete(item.itemId) || added.length) emit(holder)
        }, (error) => {
          // Not on disk, so not received: ask the Worker again from before it.
          log(`[shared-talk] ${share.shareId}: item ${item.itemId} not mirrored (${(error as Error).message}); asking again`)
          if (!holder.failed.has(item.itemId)) holder.failed.set(item.itemId, item.seq)
          if (holders.get(share.shareId) === holder) holder.socket?.restart()
        }))
      },
    })
    return holder
  }

  function stopHolder(holder: Holder): void {
    holder.socket?.stop()
    holder.socket = null
  }

  function baseOf(item: FeedbackListItem, share: FeedbackShare, cache: Map<number, { slides: SharedTalkSlide[]; pushedAt: string | null } | null>): void {
    if (!Number.isInteger(item.baseRevision) || (item.baseRevision as number) < 1) return
    const revision = item.baseRevision as number
    if (!cache.has(revision)) {
      try {
        const kept = deps.revisionSlides(share.outlinePath, share.shareId, revision)
        cache.set(revision, !kept ? null : Array.isArray(kept) ? { slides: kept, pushedAt: null } : { slides: kept.slides, pushedAt: kept.pushedAt || null })
      } catch (error) {
        log(`[shared-talk] ${(error as Error).message}`)
        cache.set(revision, null)
      }
    }
    const kept = cache.get(revision)
    if (kept) item.baseAt = kept.pushedAt
    const slide = kept?.slides.find((s) => s.slideId === (item.kind === 'insert' ? item.afterSlideId : item.slideId))
    if (slide) { item.baseText = slide.text; item.baseTitle = slide.title }
  }

  function listOf(holder: Holder): FeedbackList {
    const { share } = holder
    const cache = new Map<number, { slides: SharedTalkSlide[]; pushedAt: string | null } | null>()
    const items: FeedbackListItem[] = deps.mirror.read(holder.path).items.map((item) => {
      const listed: FeedbackListItem = { ...item, baseText: null, baseTitle: null, baseAt: null }
      baseOf(listed, share, cache)
      return listed
    })
    return { key: share.key, shareId: share.shareId, link: share.url.replace(/^https?:\/\//, ''), connection: holder.connection, items }
  }

  return {
    sync() {
      let shares: FeedbackShare[] = []
      try { shares = deps.shares() } catch (error) { log(`[shared-talk] feedback sync skipped: ${(error as Error).message}`); return }
      const wanted = new Map(shares.map((share) => [share.shareId, share]))
      for (const [shareId, holder] of [...holders]) {
        const next = wanted.get(shareId)
        if (next && sameSocket(holder.share, next)) {
          const rekeyed = next.key !== holder.share.key
          holder.share = next
          if (rekeyed) emit(holder)
          continue
        }
        if (next?.ended && holder.connection === 'ended') {
          // The registry caught up with an end this socket already saw: nothing to restart.
          holder.share = next
          continue
        }
        stopHolder(holder)
        holders.delete(shareId)
        if (!next) { try { deps.onChange?.(shareId, null) } catch { /* closing window */ } }
      }
      for (const share of shares) {
        if (holders.has(share.shareId)) continue
        try {
          emit(start(share))
        } catch (error) {
          log(`[shared-talk] feedback for ${share.shareId} not started: ${(error as Error).message}`)
        }
      }
    },

    summaries() {
      return [...holders.values()].map(summaryOf)
    },

    list(shareId) {
      const holder = holders.get(shareId)
      return holder ? listOf(holder) : null
    },

    async setStatus(shareId, itemId, status, edit) {
      const holder = holders.get(shareId)
      if (!holder) return null
      const known = await track(deps.mirror.setStatus(holder.path, itemId, status, status === 'accepted' ? edit ?? null : null))
      if (!known) throw new Error('That item is not in this talk\'s feedback.')
      emit(holder)
      if (holder.connection !== 'ended') await track(patch(holder, itemId, status))
      return listOf(holder)
    },

    stopAll() {
      for (const holder of holders.values()) stopHolder(holder)
      holders.clear()
    },

    async idle() {
      while (pending.size) await Promise.all([...pending].map((p) => p.catch(() => {})))
      await deps.mirror.idle()
    },
  }
}
