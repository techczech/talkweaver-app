import { describe, expect, test } from 'bun:test'
import { SHARED_TALK_LIMITS, type SharedItemPost } from './protocol'
import {
  REGISTRY_RETRY_MS,
  REPLAY_PAGE_SIZE,
  SHARE_CLOSED_RETENTION_MS,
  SHARE_IDLE_RETIREMENT_MS,
  SharedTalkError,
  closeSharedTalk,
  createMemoryItemStore,
  createSharedTalk,
  itemByteSize,
  nextAlarmAt,
  parseSince,
  postItem,
  purgeDueAt,
  pushTalk,
  replayMessages,
  retirementDueAt,
  setItemStatus,
  shouldRetire,
  socketRoleReceives,
  talkJson,
  type StoredSharedTalk,
} from './shared-talk-state'

const slides = [
  { slideId: 'slide-1', title: 'Why assessment breaks first', text: '# Why assessment breaks first' },
  { slideId: 'slide-3', title: 'The rubric problem', text: '# The rubric problem\nCriteria written for humans…' },
]

function openShare(): StoredSharedTalk {
  return createSharedTalk({ shareId: 'k7m2ab9x', talkSlug: 'ai-assessment', title: 'AI and assessment workshop', createdAt: 1_000 })
}

function pushedShare(): StoredSharedTalk {
  const share = openShare()
  pushTalk(share, 1, 2_000)
  return share
}

const note: SharedItemPost = { itemId: 'item-1', kind: 'note', slideId: 'slide-3', text: 'Too dense. Split the bullets?', name: 'Colleague' }

function expectError(action: () => unknown, code: string, status: number): SharedTalkError {
  try {
    action()
  } catch (error) {
    expect(error).toBeInstanceOf(SharedTalkError)
    expect((error as SharedTalkError).code).toBe(code)
    expect((error as SharedTalkError).status).toBe(status)
    return error as SharedTalkError
  }
  throw new Error(`expected ${code}`)
}

describe('SharedTalk state', () => {
  test('creates an open share with nothing pushed and a full item bucket', () => {
    expect(openShare()).toEqual({
      shareId: 'k7m2ab9x', talkSlug: 'ai-assessment', title: 'AI and assessment workshop',
      createdAt: 1_000, lastActivityAt: 1_000, status: 'open', unregistered: false, purged: false,
      revision: 0, updatedAt: null, talkSeq: 0, seq: 0, itemCount: 0, itemBytes: 0,
      bucket: { tokens: SHARED_TALK_LIMITS.itemBurst, at: 1_000 },
    })
  })

  test('accepts pushes only at revision + 1 and reports the current revision on a gap', () => {
    const share = openShare()
    expect(pushTalk(share, 1, 2_000)).toEqual({ type: 'talk.updated', revision: 1, seq: 1 })
    expect(talkJson(share, slides)).toEqual({ shareId: 'k7m2ab9x', title: 'AI and assessment workshop', revision: 1, updatedAt: 2_000, slides })

    const gap = expectError(() => pushTalk(share, 3, 3_000), 'revision_conflict', 409)
    expect(gap.details).toEqual({ revision: 1 })
    expectError(() => pushTalk(share, 1, 3_000), 'revision_conflict', 409)
    expect(share.revision).toBe(1)
    expect(pushTalk(share, 2, 4_000)).toEqual({ type: 'talk.updated', revision: 2, seq: 2 })
  })

  test('refuses items before the first push', () => {
    expectError(() => postItem(openShare(), createMemoryItemStore(), note, 1_500), 'talk_not_pushed', 409)
  })

  test('records items once per itemId and rejects a different item under the same id', () => {
    const share = pushedShare()
    const store = createMemoryItemStore()
    const first = postItem(share, store, note, 3_000)
    expect(first.created).toBe(true)
    expect(first.item).toEqual({ ...note, createdAt: 3_000, seq: 2, status: 'new', statusSeq: 2 })
    expect(first.message).toEqual({ type: 'item.new', item: first.item, seq: 2 })
    expect(share).toMatchObject({ itemCount: 1, itemBytes: itemByteSize(note) })

    const retry = postItem(share, store, { ...note }, 3_500)
    expect(retry).toEqual({ item: first.item, created: false, message: null })
    expect(store.items.size).toBe(1)
    expect(share.seq).toBe(2)

    expectError(() => postItem(share, store, { ...note, text: 'Something else' }, 3_600), 'item_conflict', 409)
  })

  test('stores every proposal kind and refuses a base revision from the future', () => {
    const share = pushedShare()
    const store = createMemoryItemStore()
    postItem(share, store, { itemId: 'r', kind: 'replace', slideId: 'slide-3', baseRevision: 1, text: '# The rubric problem\nShorter.' }, 3_000)
    postItem(share, store, { itemId: 'd', kind: 'delete', slideId: 'slide-1', baseRevision: 1, reason: 'Covered elsewhere' }, 3_001)
    postItem(share, store, { itemId: 'i', kind: 'insert', afterSlideId: 'start', baseRevision: 1, text: '# Welcome', section: 'Opening' }, 3_002)
    expect([...store.items.values()].map((item) => item.kind)).toEqual(['replace', 'delete', 'insert'])

    const future = expectError(
      () => postItem(share, store, { itemId: 'x', kind: 'replace', slideId: 'slide-3', baseRevision: 2, text: 'x' }, 3_003),
      'invalid_base_revision', 400,
    )
    expect(future.details).toEqual({ revision: 1 })
  })

  test('limits new items with a per-share token bucket; retries of known items are free', () => {
    const share = pushedShare()
    const store = createMemoryItemStore()
    for (let index = 0; index < SHARED_TALK_LIMITS.itemBurst; index += 1) postItem(share, store, { ...note, itemId: `n${index}` }, 3_000)
    const limited = expectError(() => postItem(share, store, { ...note, itemId: 'over' }, 3_000), 'rate_limited', 429)
    expect(limited.details.retryAfterMs).toBe(60_000 / SHARED_TALK_LIMITS.itemsPerMinute)
    expect(postItem(share, store, { ...note, itemId: 'n0' }, 3_000).created).toBe(false)
    // One token refills every 2 s at 30 per minute.
    expect(postItem(share, store, { ...note, itemId: 'later' }, 3_000 + 2_000).created).toBe(true)
    expectError(() => postItem(share, store, { ...note, itemId: 'too-soon' }, 3_000 + 2_500), 'rate_limited', 429)
  })

  test('caps the total bytes of item text a share holds', () => {
    const share = pushedShare()
    const store = createMemoryItemStore()
    const big = { ...note, text: 'x'.repeat(SHARED_TALK_LIMITS.itemTextChars) }
    const perItem = itemByteSize({ ...big, itemId: 'b000' })
    const fits = Math.floor(SHARED_TALK_LIMITS.itemBytesPerShare / perItem)
    let now = 3_000
    for (let index = 0; index < fits; index += 1) {
      now += 2_000
      postItem(share, store, { ...big, itemId: `b${String(index).padStart(3, '0')}` }, now)
    }
    expect(share.itemBytes).toBeLessThanOrEqual(SHARED_TALK_LIMITS.itemBytesPerShare)
    expectError(() => postItem(share, store, { ...big, itemId: 'bzzz' }, now + 2_000), 'share_full', 429)
  })

  test('the owner may move an item between any statuses, including done and back to new', () => {
    const share = pushedShare()
    const store = createMemoryItemStore()
    postItem(share, store, note, 3_000)
    const accepted = setItemStatus(share, store, 'item-1', 'accepted', 4_000)
    expect(accepted.message).toEqual({ type: 'item.status', itemId: 'item-1', status: 'accepted', at: 4_000, seq: 3 })
    expect(store.get('item-1')).toMatchObject({ status: 'accepted', statusAt: 4_000, statusSeq: 3 })
    expect(setItemStatus(share, store, 'item-1', 'accepted', 5_000).message).toBeNull()
    expect(setItemStatus(share, store, 'item-1', 'new', 6_000).message).toMatchObject({ status: 'new', seq: 4 })
    expect(setItemStatus(share, store, 'item-1', 'done', 7_000).message).toMatchObject({ status: 'done', seq: 5 })
    expect(setItemStatus(share, store, 'item-1', 'dismissed', 8_000).message).toMatchObject({ status: 'dismissed', seq: 6 })
    expectError(() => setItemStatus(share, store, 'missing', 'accepted', 8_000), 'item_not_found', 404)
  })

  test('replays what each role missed since a sequence number', () => {
    const share = openShare()
    const store = createMemoryItemStore()
    pushTalk(share, 1, 2_000) // seq 1
    postItem(share, store, note, 3_000) // seq 2
    postItem(share, store, { ...note, itemId: 'item-2' }, 3_100) // seq 3
    setItemStatus(share, store, 'item-2', 'done', 3_500) // seq 4
    pushTalk(share, 2, 4_000) // seq 5
    setItemStatus(share, store, 'item-1', 'accepted', 5_000) // seq 6

    expect([...replayMessages(share, store, 'audience', 0)]).toEqual([
      { type: 'item.status', itemId: 'item-2', status: 'done', at: 3_500, seq: 4 },
      { type: 'talk.updated', revision: 2, seq: 5 },
      { type: 'item.status', itemId: 'item-1', status: 'accepted', at: 5_000, seq: 6 },
    ])
    expect([...replayMessages(share, store, 'audience', 5)]).toEqual([
      { type: 'item.status', itemId: 'item-1', status: 'accepted', at: 5_000, seq: 6 },
    ])
    expect([...replayMessages(share, store, 'audience', 6)]).toEqual([])

    expect([...replayMessages(share, store, 'owner', 0)].map((message) => message.type === 'item.new' && message.item.itemId)).toEqual(['item-1', 'item-2'])
    expect([...replayMessages(share, store, 'owner', 2)].map((message) => message.type === 'item.new' && message.item.itemId)).toEqual(['item-2'])
    expect([...replayMessages(share, store, 'owner', 3)]).toEqual([])
  })

  test('replay reads storage a page at a time and still returns every item in order', () => {
    const share = pushedShare()
    const store = createMemoryItemStore()
    const reads: number[] = []
    const createdAfter = store.createdAfter
    store.createdAfter = (since, limit) => { reads.push(since); return createdAfter(since, limit) }
    let now = 3_000
    for (let index = 0; index < REPLAY_PAGE_SIZE + 5; index += 1) {
      now += 2_000
      postItem(share, store, { ...note, itemId: `p${index}` }, now)
    }
    const replayed = [...replayMessages(share, store, 'owner', 0)]
    expect(replayed).toHaveLength(REPLAY_PAGE_SIZE + 5)
    expect(replayed.map((message) => message.seq)).toEqual([...replayed.map((message) => message.seq)].sort((a, b) => a - b))
    expect(reads).toEqual([0, REPLAY_PAGE_SIZE + 1])
  })

  test('audience sockets never receive item content; owner sockets receive only items', () => {
    const share = pushedShare()
    const { message } = postItem(share, createMemoryItemStore(), note, 3_000)
    expect(socketRoleReceives('audience', message!)).toBe(false)
    expect(socketRoleReceives('owner', message!)).toBe(true)
    expect(socketRoleReceives('audience', { type: 'talk.updated', revision: 1, seq: 1 })).toBe(true)
    expect(socketRoleReceives('owner', { type: 'talk.updated', revision: 1, seq: 1 })).toBe(false)
    expect(socketRoleReceives('audience', { type: 'item.status', itemId: 'item-1', status: 'accepted', at: 1, seq: 3 })).toBe(true)
    expect(socketRoleReceives('owner', { type: 'share.closed', reason: 'stopped' })).toBe(true)
  })

  test('retires after 60 idle days counted from the last push, item or status change', () => {
    const share = pushedShare()
    expect(retirementDueAt(share)).toBe(2_000 + SHARE_IDLE_RETIREMENT_MS)
    expect(nextAlarmAt(share, 2_000)).toBe(2_000 + SHARE_IDLE_RETIREMENT_MS)
    postItem(share, createMemoryItemStore(), note, 10_000)
    expect(shouldRetire(share, 10_000 + SHARE_IDLE_RETIREMENT_MS - 1)).toBe(false)
    expect(shouldRetire(share, 10_000 + SHARE_IDLE_RETIREMENT_MS)).toBe(true)
    closeSharedTalk(share, 'retired', 20_000)
    expect(shouldRetire(share, Number.MAX_SAFE_INTEGER)).toBe(false)
  })

  test('Stop sharing keeps content 7 days; retirement purges at once; a failed unregister is retried', () => {
    const stopped = pushedShare()
    closeSharedTalk(stopped, 'stopped', 50_000)
    expect(purgeDueAt(stopped)).toBe(50_000 + SHARE_CLOSED_RETENTION_MS)
    stopped.unregistered = true
    expect(nextAlarmAt(stopped, 50_000)).toBe(50_000 + SHARE_CLOSED_RETENTION_MS)
    stopped.unregistered = false
    expect(nextAlarmAt(stopped, 50_000)).toBe(50_000 + REGISTRY_RETRY_MS)
    stopped.unregistered = true
    stopped.purged = true
    expect(nextAlarmAt(stopped, 50_000)).toBeNull()

    const retired = pushedShare()
    closeSharedTalk(retired, 'retired', 60_000)
    expect(purgeDueAt(retired)).toBe(60_000)
  })

  test('a closed share refuses pushes, items and status changes', () => {
    const share = pushedShare()
    const store = createMemoryItemStore()
    postItem(share, store, note, 3_000)
    expect(closeSharedTalk(share, 'stopped', 3_500)).toEqual({ type: 'share.closed', reason: 'stopped' })
    expect(share).toMatchObject({ status: 'closed', closedReason: 'stopped', closedAt: 3_500 })
    expectError(() => pushTalk(share, 2, 4_000), 'share_closed', 410)
    expectError(() => postItem(share, store, { ...note, itemId: 'late' }, 4_000), 'share_closed', 410)
    expectError(() => setItemStatus(share, store, 'item-1', 'accepted', 4_000), 'share_closed', 410)
  })

  test('parses ?since= as a non-negative integer, defaulting to the start', () => {
    expect(parseSince('7')).toBe(7)
    expect(parseSince(null)).toBe(0)
    expect(parseSince('-1')).toBe(0)
    expect(parseSince('1.5')).toBe(0)
    expect(parseSince('abc')).toBe(0)
  })
})
