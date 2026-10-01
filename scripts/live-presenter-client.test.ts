import { describe, expect, test } from 'bun:test'
import { createLivePresenterClient, presenterSocketUrl } from '../src/main/live-presenter-client'

describe('live presenter boundaries', () => {
  test('builds an authenticated recovery socket URL', () => {
    expect(presenterSocketUrl('https://live.example.test/', 'session 1', 'a+b')).toBe(
      'wss://live.example.test/sessions/session%201/presenter?token=a%2Bb&protocol=2')
  })
  test('transport opening alone cannot announce live or send queued poll controls', () => {
    const sent: string[] = []
    const socket = { readyState: 0, onopen: null as any, onclose: null as any, onerror: null as any,
      onmessage: null as any, send: (v: string) => sent.push(v), close() {} }
    const client = createLivePresenterClient({ baseUrl: 'https://live.example.test', sessionId: 'session-test',
      presenterToken: 'token', createSocket: () => socket, schedule: () => 1 as any, cancelSchedule() {} })
    client.sendPoll({ type: 'poll.close', pollId: 'poll-test' })
    socket.readyState = 1; socket.onopen()
    expect(client.status()).toBe('connecting')
    expect(sent).toEqual([])
    client.disconnect()
  })
  test('reaction counts and questions reach the presenter callbacks, from pushes and from every snapshot', () => {
    const socket = { readyState: 0, onopen: null as any, onclose: null as any, onerror: null as any,
      onmessage: null as any, sent: [] as any[], send(v: string) { this.sent.push(JSON.parse(v)) }, close() {} }
    const seen: any[] = []
    const client = createLivePresenterClient({ baseUrl: 'https://live.example.test', sessionId: 'session-test',
      presenterToken: 'token', createSocket: () => socket as any, schedule: () => 1 as any, cancelSchedule() {},
      onReactionCounts: (slideId, counts) => seen.push(['counts', slideId, counts]),
      onReactionSnapshot: (counts) => seen.push(['snapshot', counts]),
      onQuestions: (questions) => seen.push(['questions', questions.map((q) => q.text)]) })
    socket.readyState = 1; socket.onopen()
    const message = (value: unknown) => socket.onmessage({ data: JSON.stringify(value) })
    message({ type: 'session.hello', protocol: 2, expiresAt: Date.now() + 60_000 })
    const sync = socket.sent.find((m) => m.type === 'session.sync')
    message({ type: 'session.snapshot', protocol: 2, sessionId: 'session-test', syncId: sync.syncId, expiresAt: Date.now() + 60_000,
      slideState: null, polls: [], reactionCounts: { 'slide-1': { puzzled: 2, bookmark: 1 } },
      questions: [{ questionId: 'q1', text: 'Why?', slideId: 'slide-1', tMs: 5, acceptedAt: 6, answered: false }] })
    expect(seen).toEqual([['snapshot', { 'slide-1': { puzzled: 2, bookmark: 1 } }], ['questions', ['Why?']]])
    expect(client.status()).toBe('live')
    seen.length = 0
    message({ type: 'reaction.counts', slideId: 'slide-2', counts: { helped: 3 }, records: [] })
    expect(seen).toEqual([['counts', 'slide-2', { helped: 3 }]])
    seen.length = 0
    message({ type: 'reaction.counts', slideId: 'slide-2', counts: { helped: 0 }, records: [] })
    expect(seen).toEqual([])
    message({ type: 'questions.state', questions: [] })
    expect(seen).toEqual([['questions', []]])
    client.disconnect()
  })
  test('reaction records for the Run arrive in sequence, once each, from snapshot pages and pushes (ticket 06)', () => {
    const socket = { readyState: 0, onopen: null as any, onclose: null as any, onerror: null as any,
      onmessage: null as any, sent: [] as any[], send(v: string) { this.sent.push(JSON.parse(v)) }, close() {} }
    const got: number[][] = []
    const client = createLivePresenterClient({ baseUrl: 'https://live.example.test', sessionId: 'session-test',
      presenterToken: 'token', createSocket: () => socket as any, schedule: () => 1 as any, cancelSchedule() {},
      afterReactionSequence: 2, onReactionRecords: (records) => got.push(records.map((r) => r.sequence)) })
    socket.readyState = 1; socket.onopen()
    const message = (value: unknown) => socket.onmessage({ data: JSON.stringify(value) })
    const rec = (sequence: number, withdrawn = false) => ({ reaction: 'puzzled', slideId: 'slide-1', tMs: 1000 + sequence,
      ...(withdrawn ? { withdrawn: true } : {}), sequence, acceptedAt: 2000 + sequence })
    const snapshot = (syncId: string, records: unknown[], more: boolean) => message({ type: 'session.snapshot', protocol: 2,
      sessionId: 'session-test', syncId, expiresAt: Date.now() + 60_000, slideState: null, polls: [],
      reactionCounts: {}, questions: [], reactionRecords: records, moreReactionRecords: more })
    message({ type: 'session.hello', protocol: 2, expiresAt: Date.now() + 60_000 })
    const first = socket.sent.filter((m) => m.type === 'session.sync').at(-1)
    expect(first.afterReactionSequence).toBe(2)
    // A live push ahead of the replay is held until the gap before it is filled.
    message({ type: 'reaction.counts', slideId: 'slide-1', counts: { puzzled: 1 }, records: [rec(5)] })
    expect(got).toEqual([])
    snapshot(first.syncId, [rec(3)], true)
    expect(got).toEqual([[3]])
    expect(client.status()).toBe('connecting') // more pages: asks again from the new cursor
    const second = socket.sent.filter((m) => m.type === 'session.sync').at(-1)
    expect(second.afterReactionSequence).toBe(3)
    snapshot(second.syncId, [rec(4, true)], false)
    expect(got).toEqual([[3], [4, 5]])
    expect(client.status()).toBe('live')
    // A repeat of a record already delivered is ignored.
    message({ type: 'reaction.counts', slideId: 'slide-1', counts: { puzzled: 1 }, records: [rec(5), rec(6)] })
    expect(got).toEqual([[3], [4, 5], [6]])
    client.disconnect()
  })
  test('Mark answered goes to the worker as a durable operation and reports its outcome', () => {
    const socket = { readyState: 0, onopen: null as any, onclose: null as any, onerror: null as any,
      onmessage: null as any, sent: [] as any[], send(v: string) { this.sent.push(JSON.parse(v)) }, close() {} }
    const updates: any[] = []
    const stored: any[] = []
    const client = createLivePresenterClient({ baseUrl: 'https://live.example.test', sessionId: 'session-test',
      presenterToken: 'token', createSocket: () => socket as any, schedule: () => 1 as any, cancelSchedule() {},
      onPendingChange: (pending) => stored.push(pending.map((p) => p.action.type)), onOperation: (update) => updates.push([update.status, update.message.type]) })
    const operationId = client.sendPoll({ type: 'question.answer', questionId: 'q1', answered: true })
    expect(typeof operationId).toBe('string')
    expect(stored).toEqual([['question.answer']])
    socket.readyState = 1; socket.onopen()
    const message = (value: unknown) => socket.onmessage({ data: JSON.stringify(value) })
    message({ type: 'session.hello', protocol: 2, expiresAt: Date.now() + 60_000 })
    const sync = socket.sent.find((m) => m.type === 'session.sync')
    message({ type: 'session.snapshot', protocol: 2, sessionId: 'session-test', syncId: sync.syncId, expiresAt: Date.now() + 60_000, slideState: null, polls: [] })
    const operation = socket.sent.find((m) => m.type === 'operation')
    expect(operation.action).toEqual({ type: 'question.answer', questionId: 'q1', answered: true })
    message({ type: 'operation.ack', operationId: operation.operationId, status: 'confirmed' })
    expect(updates).toEqual([['pending', 'question.answer'], ['confirmed', 'question.answer']])
    client.disconnect()
  })
})
