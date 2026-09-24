import { afterAll, expect, mock, test } from 'bun:test'

const listeners = new Map<string, (...args: any[]) => void>()
let exposed: any
let resolveSnapshot: (value: any) => void = () => {}
const snapshot = new Promise((resolve) => { resolveSnapshot = resolve })
const invoke = mock((channel: string) => channel === 'live:snapshot' ? snapshot : Promise.resolve({ success: true, operationId: 'op-1', status: 'pending' }))
mock.module('electron', () => ({
  contextBridge: { exposeInMainWorld: (_name: string, api: unknown) => { exposed = api } },
  ipcRenderer: { invoke, on: (channel: string, listener: (...args: any[]) => void) => { listeners.set(channel, listener) } },
}))
await import('../src/preload/present-live-bridge')
afterAll(() => mock.restore())
const tick = () => new Promise((resolve) => queueMicrotask(resolve))

test('poll actions return pending/confirmed state instead of silently discarding the result', async () => {
  const result = await exposed.action({ type: 'poll.close', pollId: 'reading' })
  expect(result).toEqual({ success: true, operationId: 'op-1', status: 'pending' })
})

test('late presenter subscriptions replay a snapshot and preserve newer pushed states', async () => {
  const stale = { type: 'poll.state', pollId: 'reading', open: true, revealed: false }
  const newer = { ...stale, open: false, revealed: true }
  listeners.get('live:poll-state')?.(null, newer)
  listeners.get('live:status')?.(null, 'paused-reconnecting')
  resolveSnapshot({ status: 'live', shortUrl: 'https://example.test/read', qrSvg: '<svg/>', polls: [stale], pending: [{ operationId: 'restored-close', action: { type: 'poll.close', pollId: 'reading' } }] })
  await tick()
  const received: unknown[] = []
  const joining: unknown[] = []
  const statuses: unknown[] = []
  exposed.onStatus((value: unknown) => statuses.push(value))
  exposed.onState((message: unknown) => received.push(message))
  expect(typeof exposed.onJoin).toBe('function')
  exposed.onJoin((value: unknown) => joining.push(value))
  await tick()
  expect(received.at(-1)).toEqual(newer)
  expect(statuses.at(-1)).toBe('paused-reconnecting')
  expect(joining.at(-1)).toEqual({ shortUrl: 'https://example.test/read', qrSvg: '<svg/>' })
})

test('operation acknowledgements cross context isolation through an explicit callback', async () => {
  const received: unknown[] = []
  expect(typeof exposed.onOperation).toBe('function')
  exposed.onOperation((value: unknown) => received.push(value))
  await tick()
  expect(received).toEqual([{ operationId: 'restored-close', status: 'pending', message: { type: 'poll.close', pollId: 'reading' } }])
  received.length = 0
  const operation = { operationId: 'op-1', status: 'confirmed', message: { type: 'poll.close', pollId: 'reading' } }
  listeners.get('live:poll-operation')?.(null, operation)
  await tick()
  expect(received).toEqual([operation])
})


test('terminal status before mount clears cached polls and joining data for late subscriptions', async () => {
  listeners.get('live:status')?.(null, 'expired')
  const polls: unknown[] = []
  const joins: unknown[] = []
  const statuses: unknown[] = []
  exposed.onState((value: unknown) => polls.push(value))
  exposed.onJoin((value: unknown) => joins.push(value))
  exposed.onStatus((value: unknown) => statuses.push(value))
  await tick()
  expect(polls).toEqual([])
  expect(joins).toEqual([])
  expect(statuses).toEqual(['expired'])
})
