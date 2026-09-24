import { describe, expect, test } from 'bun:test'
import { createLivePresenterClient, presenterSocketUrl } from '../src/main/live-presenter-client'

class FakeSocket {
  readyState = 0
  sent: any[] = []
  onopen: (() => void) | null = null
  onclose: ((event?: any) => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  send(value: string) { this.sent.push(JSON.parse(value)) }
  close() { this.readyState = 3 }
  open() { this.readyState = 1; this.onopen?.() }
  drop() { this.readyState = 3; this.onclose?.({ code: 1006, wasClean: false }) }
  receive(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }) }
}
function harness(extra: any = {}) {
  let now = 0, id = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  const sockets: FakeSocket[] = [], statuses: string[] = [], operations: any[] = [], records: any[] = []
  const client = createLivePresenterClient({
    baseUrl: 'https://live.example.test', sessionId: 'session-test', presenterToken: 'token',
    createSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket },
    schedule: (fn: () => void, delay: number) => { const key = ++id; timers.set(key, { at: now + delay, fn }); return key as any },
    cancelSchedule: (key: any) => { timers.delete(key) },
    onStatus: (s: string) => statuses.push(s),
    onOperation: (o: any) => operations.push(o),
    onPollVoteRecord: (r: any) => records.push(r),
    random: () => 0.5,
    ...extra,
  })
  function advance(ms: number) {
    const until = now + ms
    while (true) {
      const next = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a,b) => a[1].at-b[1].at)[0]
      if (!next) break
      now = next[1].at; timers.delete(next[0]); next[1].fn()
    }
    now = until
  }
  function hello(socket = sockets.at(-1)!) {
    socket.open()
    socket.receive({ type: 'session.hello', protocol: 2, expiresAt: Date.now() + 60_000 })
  }
  function snapshot(socket = sockets.at(-1)!, extra: any = {}) {
    const sync = socket.sent.findLast((m) => m.type === 'session.sync')
    socket.receive({ type: 'session.snapshot', protocol: 2, sessionId: 'session-test', syncId: sync?.syncId,
      expiresAt: Date.now() + 60_000, slideState: null, polls: [], voteRecords: [], moreRecords: false, ...extra })
  }
  return { client, sockets, statuses, operations, records, advance, hello, snapshot, timers }
}
describe('live presenter recovery', () => {
  test('negotiates recovery on the authenticated socket', () => {
    const url = new URL(presenterSocketUrl('https://live.example.test/', 'session 1', 'a+b'))
    expect(url.pathname).toBe('/sessions/session%201/presenter')
    expect(url.searchParams.get('token')).toBe('a+b')
    expect(url.searchParams.get('protocol')).toBe('2')
  })
  test('reports live only after the latest slide and full snapshot synchronise', () => {
    const h = harness()
    h.client.publish('slide-a', 2, { kind: 'focus', step: 1 })
    h.hello()
    expect(h.client.status()).toBe('connecting')
    expect(h.sockets[0].sent.at(-1)).toMatchObject({ type: 'session.sync', slideState: { slideId: 'slide-a', reveal: 2 } })
    h.snapshot()
    expect(h.client.status()).toBe('live')
    h.sockets[0].drop()
    h.client.publish('slide-c', 0, null)
    h.advance(750)
    h.hello()
    expect(h.client.status()).toBe('paused-reconnecting')
    expect(h.sockets[1].sent.at(-1).slideState.slideId).toBe('slide-c')
    h.snapshot()
    expect(h.client.status()).toBe('live')
  })
  test('a silent stalled socket is replaced without an internet-offline event', () => {
    const h = harness()
    h.hello(); h.snapshot()
    h.advance(15_000)
    expect(h.sockets[0].sent.at(-1).type).toBe('session.ping')
    h.advance(10_000)
    expect(h.client.status()).toBe('paused-reconnecting')
    expect(h.sockets[0].readyState).toBe(3)
    h.advance(750)
    expect(h.sockets).toHaveLength(2)
  })
  test('an opening or unsynchronised socket times out instead of remaining live', () => {
    const h = harness()
    h.sockets[0].open()
    h.advance(10_000)
    expect(h.client.status()).toBe('paused-reconnecting')
  })
  test('a late close from an obsolete socket cannot affect its replacement', () => {
    const h = harness()
    h.hello(); h.snapshot(); h.sockets[0].drop(); h.advance(750); h.hello(); h.snapshot()
    h.sockets[0].drop()
    expect(h.client.status()).toBe('live')
    expect(h.sockets[1].readyState).toBe(1)
  })
  test('poll controls persist and retry the same operation after an acknowledgement is lost', () => {
    const saved: any[] = []
    const h = harness({ onPendingChange: (pending: any) => saved.push(structuredClone(pending)) })
    const action = { type: 'poll.close' as const, pollId: 'poll-test' }
    const id = h.client.sendPoll(action)
    expect(typeof id).toBe('string')
    expect(saved.at(-1)[0]).toMatchObject({ operationId: id, action })
    expect(h.operations.at(-1)).toMatchObject({ operationId: id, status: 'pending', message: action })
    h.hello(); h.snapshot()
    expect(h.sockets[0].sent.at(-1)).toEqual({ type: 'operation', operationId: id, action })
    h.sockets[0].drop(); h.advance(750); h.hello(); h.snapshot()
    expect(h.sockets[1].sent.at(-1)).toEqual({ type: 'operation', operationId: id, action })
    h.sockets[1].receive({ type: 'operation.ack', operationId: id, status: 'confirmed' })
    expect(saved.at(-1)).toEqual([])
    expect(h.operations.at(-1).status).toBe('confirmed')
  })
  test('commands follow click order and rejection does not block the next command', () => {
    const h = harness()
    const first = h.client.sendPoll({ type: 'poll.close', pollId: 'poll-a' })
    const second = h.client.sendPoll({ type: 'poll.reveal', pollId: 'poll-a' })
    h.hello(); h.snapshot()
    expect(h.sockets[0].sent.filter((m) => m.type === 'operation')).toHaveLength(1)
    h.sockets[0].receive({ type: 'operation.ack', operationId: first, status: 'rejected', error: 'Poll not found.' })
    expect(h.sockets[0].sent.at(-1).operationId).toBe(second)
  })
  test('record replay advances its cursor and never delivers a record twice', () => {
    const cursors: number[] = []
    const h = harness({ onCursorChange: (cursor: number) => cursors.push(cursor) })
    h.hello()
    const record = { type: 'poll.vote-record', sequence: 1, submissionId: 'submission-one',
      pollId: 'poll-test', choice: 'a', acceptedAt: 1000, slideId: 'slide-one' }
    h.snapshot(h.sockets[0], { voteRecords: [record] })
    h.sockets[0].receive(record)
    expect(h.records).toEqual([record])
    expect(cursors).toEqual([1])
  })
  test('live records between replay pages cannot skip earlier answers', () => {
    const h = harness()
    const record = (sequence: number) => ({ type: 'poll.vote-record', sequence,
      submissionId: `submission-${sequence}`, pollId: 'poll-test', choice: 'a', acceptedAt: 1000, slideId: 'slide-one' })
    h.hello()
    h.sockets[0].receive(record(3))
    expect(h.records).toHaveLength(0)
    h.snapshot(h.sockets[0], { voteRecords: [record(1)], moreRecords: true })
    expect(h.records.map((r) => r.sequence)).toEqual([1])
    h.snapshot(h.sockets[0], { voteRecords: [record(2), record(3)] })
    expect(h.records.map((r) => r.sequence)).toEqual([1, 2, 3])
    expect(h.client.status()).toBe('live')
  })
  test('explicit ended, expired and superseded states stop retrying', () => {
    for (const message of [{ type: 'session.closed', reason: 'ended' }, { type: 'session.closed', reason: 'expired' }, { type: 'session.superseded' }]) {
      const h = harness()
      h.hello(); h.snapshot()
      h.sockets[0].receive(message)
      h.advance(100_000)
      expect(h.sockets).toHaveLength(1)
      expect(h.client.status()).toBe(message.type === 'session.superseded' ? 'superseded' : message.reason)
    }
  })
  test('ending cancels all connection and heartbeat timers', () => {
    const h = harness()
    h.hello(); h.snapshot()
    h.client.end()
    h.client.publish('ignored', 0, null)
    h.advance(100_000)
    expect(h.sockets).toHaveLength(1)
    expect(h.client.status()).toBe('ended')
    expect(h.timers.size).toBe(0)
  })
})
