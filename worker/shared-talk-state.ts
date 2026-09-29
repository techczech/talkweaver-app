import {
  SHARED_TALK_LIMITS,
  type ItemNewMessage,
  type ItemStatusMessage,
  type ShareClosedMessage,
  type SharedItem,
  type SharedItemPost,
  type SharedItemStatusUpdate,
  type SharedSlide,
  type SharedTalkAudienceMessage,
  type SharedTalkJson,
  type SharedTalkOwnerMessage,
  type TalkUpdatedMessage,
} from './protocol'

/** A share with no push, item or status change for this long is retired (and wiped) by its alarm. */
export const SHARE_IDLE_RETIREMENT_MS = 60 * 24 * 60 * 60 * 1_000
/** After Stop sharing, items stay this long so the owner can still mirror them; then all is purged. */
export const SHARE_CLOSED_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000
/** How soon a failed registry removal is retried. */
export const REGISTRY_RETRY_MS = 60 * 1_000
/** Replay reads items from storage in pages of this size. */
export const REPLAY_PAGE_SIZE = 200

export type SharedTalkSocketRole = 'audience' | 'owner'

/** A rule the request broke. The Worker maps it to `{error:{code,message}, ...details}` at `status`. */
export class SharedTalkError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message)
  }
}

/**
 * Items live in storage, not in memory, so a full share still wakes cheaply. The object gives the
 * state functions this narrow view of its items table.
 */
export interface SharedItemStore {
  get(itemId: string): SharedItem | null
  put(item: SharedItem): void
  /** Items with `seq > since`, ascending by `seq`, at most `limit`. */
  createdAfter(since: number, limit: number): SharedItem[]
  /** Items whose status has changed (`statusSeq > seq`) with `statusSeq > since`, ascending by `statusSeq`, at most `limit`. */
  statusChangedAfter(since: number, limit: number): SharedItem[]
}

/**
 * The share's metadata: everything the object keeps in memory. Slides, items and the handout HTML
 * stay in storage and are read by the routes that need them.
 *
 * `seq` is the share's event sequence: every push, new item and status change takes the next
 * value. Socket messages carry it, and a reconnect with `?since=<seq>` replays what came after.
 */
export interface StoredSharedTalk {
  shareId: string
  talkSlug: string
  title: string
  createdAt: number
  lastActivityAt: number
  status: 'open' | 'closed'
  closedReason?: 'stopped' | 'retired'
  closedAt?: number
  /** The registry entry has been removed (or was never needed again). */
  unregistered: boolean
  /** Slides, items and HTML have been deleted. */
  purged: boolean
  revision: number
  updatedAt: number | null
  talkSeq: number
  seq: number
  itemCount: number
  itemBytes: number
  /** Token bucket for new items. */
  bucket: { tokens: number; at: number }
}

export function createSharedTalk(input: { shareId: string; talkSlug: string; title: string; createdAt: number }): StoredSharedTalk {
  return {
    ...input,
    lastActivityAt: input.createdAt,
    status: 'open',
    unregistered: false,
    purged: false,
    revision: 0,
    updatedAt: null,
    talkSeq: 0,
    seq: 0,
    itemCount: 0,
    itemBytes: 0,
    bucket: { tokens: SHARED_TALK_LIMITS.itemBurst, at: input.createdAt },
  }
}

/** Accept the owner's push only when it is exactly the next revision. The object stores the slides and HTML. */
export function pushTalk(share: StoredSharedTalk, revision: number, now: number): TalkUpdatedMessage {
  requireOpen(share)
  if (revision !== share.revision + 1) {
    throw new SharedTalkError(
      'revision_conflict',
      `Expected revision ${share.revision + 1}; push again from the current revision.`,
      409,
      { revision: share.revision },
    )
  }
  share.revision = revision
  share.updatedAt = now
  share.seq += 1
  share.talkSeq = share.seq
  share.lastActivityAt = now
  return { type: 'talk.updated', revision: share.revision, seq: share.seq }
}

export function talkJson(share: StoredSharedTalk, slides: SharedSlide[]): SharedTalkJson {
  return { shareId: share.shareId, title: share.title, revision: share.revision, updatedAt: share.updatedAt, slides }
}

export function itemByteSize(post: SharedItemPost): number {
  return new TextEncoder().encode(JSON.stringify(post)).byteLength
}

/**
 * Record a colleague's item. Idempotent on `itemId`: the same post again returns the stored item
 * with `created: false` and costs nothing; a different post under a known id is a conflict. New
 * items are limited by count, total bytes and a per-share token bucket.
 */
export function postItem(
  share: StoredSharedTalk,
  store: SharedItemStore,
  post: SharedItemPost,
  now: number,
): { item: SharedItem; created: boolean; message: ItemNewMessage | null } {
  requireOpen(share)
  const existing = store.get(post.itemId)
  if (existing) {
    if (!samePost(existing, post)) throw new SharedTalkError('item_conflict', 'A different item already uses this itemId.', 409)
    return { item: existing, created: false, message: null }
  }
  if (share.revision < 1) throw new SharedTalkError('talk_not_pushed', 'The talk has not been shared yet.', 409)
  if ('baseRevision' in post && post.baseRevision > share.revision) {
    throw new SharedTalkError('invalid_base_revision', 'baseRevision is later than the current revision.', 400, { revision: share.revision })
  }
  const bytes = itemByteSize(post)
  if (share.itemCount >= SHARED_TALK_LIMITS.itemsPerShare || share.itemBytes + bytes > SHARED_TALK_LIMITS.itemBytesPerShare) {
    throw new SharedTalkError('share_full', 'This shared talk has no room for more items.', 429)
  }
  refillBucket(share, now)
  if (share.bucket.tokens < 1) {
    const retryAfterMs = Math.ceil((1 - share.bucket.tokens) * 60_000 / SHARED_TALK_LIMITS.itemsPerMinute)
    throw new SharedTalkError('rate_limited', 'Too many items at once. Try again shortly.', 429, { retryAfterMs })
  }
  share.bucket.tokens -= 1
  share.seq += 1
  share.lastActivityAt = now
  share.itemCount += 1
  share.itemBytes += bytes
  const item: SharedItem = { ...post, createdAt: now, seq: share.seq, status: 'new', statusSeq: share.seq }
  store.put(item)
  return { item, created: true, message: { type: 'item.new', item, seq: item.seq } }
}

/** The owner moves an item to any status. Setting the status it already has is a no-op. */
export function setItemStatus(
  share: StoredSharedTalk,
  store: SharedItemStore,
  itemId: string,
  status: SharedItemStatusUpdate,
  now: number,
): { item: SharedItem; message: ItemStatusMessage | null } {
  requireOpen(share)
  const item = store.get(itemId)
  if (!item) throw new SharedTalkError('item_not_found', 'Item not found.', 404)
  if (item.status === status) return { item, message: null }
  share.seq += 1
  share.lastActivityAt = now
  item.status = status
  item.statusAt = now
  item.statusSeq = share.seq
  store.put(item)
  return { item, message: itemStatusMessage(item) }
}

/**
 * What a socket that last saw `since` has missed, in sequence order, read from storage a page at a
 * time. The audience gets the latest talk.updated (coalesced: one reload covers every missed push)
 * and each changed item status; the owner gets every item that arrived after `since`.
 */
export function replayMessages(share: StoredSharedTalk, store: SharedItemStore, role: 'audience', since: number): Generator<SharedTalkAudienceMessage>
export function replayMessages(share: StoredSharedTalk, store: SharedItemStore, role: 'owner', since: number): Generator<SharedTalkOwnerMessage>
export function replayMessages(share: StoredSharedTalk, store: SharedItemStore, role: SharedTalkSocketRole, since: number): Generator<SharedTalkAudienceMessage | SharedTalkOwnerMessage>
export function* replayMessages(
  share: StoredSharedTalk,
  store: SharedItemStore,
  role: SharedTalkSocketRole,
  since: number,
): Generator<SharedTalkAudienceMessage | SharedTalkOwnerMessage> {
  if (role === 'owner') {
    for (const item of pages((after) => store.createdAfter(after, REPLAY_PAGE_SIZE), (item) => item.seq, since)) {
      yield { type: 'item.new', item, seq: item.seq }
    }
    return
  }
  let talkPending = share.revision >= 1 && share.talkSeq > since
  const talkUpdated: TalkUpdatedMessage = { type: 'talk.updated', revision: share.revision, seq: share.talkSeq }
  for (const item of pages((after) => store.statusChangedAfter(after, REPLAY_PAGE_SIZE), (item) => item.statusSeq, since)) {
    if (talkPending && share.talkSeq < item.statusSeq) {
      talkPending = false
      yield talkUpdated
    }
    yield itemStatusMessage(item)
  }
  if (talkPending) yield talkUpdated
}

/** Which live events a socket of `role` receives. */
export function socketRoleReceives(role: SharedTalkSocketRole, message: SharedTalkAudienceMessage | SharedTalkOwnerMessage): boolean {
  if (message.type === 'share.closed') return true
  if (role === 'owner') return message.type === 'item.new'
  return message.type === 'talk.updated' || message.type === 'item.status'
}

export function closeSharedTalk(share: StoredSharedTalk, reason: 'stopped' | 'retired', now: number): ShareClosedMessage {
  share.status = 'closed'
  share.closedReason = reason
  share.closedAt = now
  return { type: 'share.closed', reason }
}

export function retirementDueAt(share: StoredSharedTalk): number {
  return share.lastActivityAt + SHARE_IDLE_RETIREMENT_MS
}

export function shouldRetire(share: StoredSharedTalk, now: number): boolean {
  return share.status === 'open' && now >= retirementDueAt(share)
}

/** Retirement wipes at once; Stop sharing keeps items for the retention window. */
export function purgeDueAt(share: StoredSharedTalk): number {
  const closedAt = share.closedAt ?? 0
  return share.closedReason === 'retired' ? closedAt : closedAt + SHARE_CLOSED_RETENTION_MS
}

/** When the object's alarm must next fire, or null when nothing is left to do (the share can be deleted). */
export function nextAlarmAt(share: StoredSharedTalk, now: number): number | null {
  if (share.status === 'open') return retirementDueAt(share)
  const due: number[] = []
  if (!share.unregistered) due.push(now + REGISTRY_RETRY_MS)
  if (!share.purged) due.push(purgeDueAt(share))
  return due.length ? Math.min(...due) : null
}

/** `?since=` as a non-negative integer; anything else means "from the start". */
export function parseSince(value: string | null): number {
  if (value === null || !/^\d{1,15}$/.test(value)) return 0
  return Number(value)
}

/** In-memory item store for tests and tools; the object uses SQLite. */
export function createMemoryItemStore(): SharedItemStore & { items: Map<string, SharedItem> } {
  const items = new Map<string, SharedItem>()
  return {
    items,
    get: (itemId) => {
      const item = items.get(itemId)
      return item ? structuredClone(item) : null
    },
    put: (item) => { items.set(item.itemId, structuredClone(item)) },
    createdAfter: (since, limit) => [...items.values()].filter((item) => item.seq > since)
      .sort((a, b) => a.seq - b.seq).slice(0, limit).map((item) => structuredClone(item)),
    statusChangedAfter: (since, limit) => [...items.values()].filter((item) => item.statusSeq > item.seq && item.statusSeq > since)
      .sort((a, b) => a.statusSeq - b.statusSeq).slice(0, limit).map((item) => structuredClone(item)),
  }
}

function* pages(read: (after: number) => SharedItem[], cursor: (item: SharedItem) => number, since: number): Generator<SharedItem> {
  let after = since
  for (;;) {
    const page = read(after)
    yield* page
    if (page.length < REPLAY_PAGE_SIZE) return
    after = cursor(page[page.length - 1])
  }
}

function refillBucket(share: StoredSharedTalk, now: number): void {
  const elapsed = Math.max(0, now - share.bucket.at)
  share.bucket.tokens = Math.min(SHARED_TALK_LIMITS.itemBurst, share.bucket.tokens + elapsed * SHARED_TALK_LIMITS.itemsPerMinute / 60_000)
  share.bucket.at = now
}

function requireOpen(share: StoredSharedTalk): void {
  if (share.status !== 'open') throw new SharedTalkError('share_closed', 'Sharing has stopped for this talk.', 410)
}

function itemStatusMessage(item: SharedItem): ItemStatusMessage {
  return { type: 'item.status', itemId: item.itemId, status: item.status, at: item.statusAt ?? item.createdAt, seq: item.statusSeq }
}

const POST_FIELDS = ['itemId', 'name', 'kind', 'slideId', 'afterSlideId', 'baseRevision', 'text', 'reason', 'section'] as const

function samePost(item: SharedItem, post: SharedItemPost): boolean {
  const a = item as Record<string, unknown>
  const b = post as Record<string, unknown>
  return POST_FIELDS.every((field) => a[field] === b[field])
}
