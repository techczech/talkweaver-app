import { afterAll, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'

const listeners = new Map<string, (...args: any[]) => void>()
let exposed: any
let copied = ''
let resolveSnapshot: (value: any) => void = () => {}
const snapshot = new Promise((resolve) => { resolveSnapshot = resolve })
const invoke = mock((channel: string) => channel === 'live:snapshot' ? snapshot : channel === 'live:status' ? Promise.resolve('ended') : channel === 'live:go' ? Promise.resolve({ success: true, status: 'live', shortUrl: 'https://example.test/read', qrSvg: '<svg/>' }) : Promise.resolve({ success: true, operationId: 'op-1', status: 'pending' }))
mock.module('electron', () => ({
  contextBridge: { exposeInMainWorld: (_name: string, api: unknown) => { exposed = api } },
  clipboard: { writeText: (value: string) => { copied = value } },
  ipcRenderer: { invoke, on: (channel: string, listener: (...args: any[]) => void) => { listeners.set(channel, listener) } },
}))
const bridge = await import('../src/preload/present-live-bridge')
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

test('go-live panel shows the venue link, Copy, and live screen counts', async () => {
  const dom = new JSDOM('<button id="liveGoButton"></button><aside id="liveGoPanel" hidden><button id="liveGoPanelClose"></button><div id="liveQr"></div><div id="liveShortUrl"></div><span id="liveVenueUrl"></span><button id="liveVenueCopy"></button><div id="liveVenueCount" hidden></div></aside>', { url: 'https://example.test' })
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, location: dom.window.location, HTMLElement: dom.window.HTMLElement })
  listeners.get('live:status')?.(null, 'ended')
  bridge.mountLiveBridge()
  document.getElementById('liveGoButton')!.click()
  await tick(); await tick()
  const venueUrl = document.getElementById('liveVenueUrl')!
  const count = document.getElementById('liveVenueCount')!
  listeners.get('live:presence')?.(null, { presenterConnected: true, venueScreens: 0 })
  expect(count.hidden).toBe(true)
  listeners.get('live:presence')?.(null, { presenterConnected: true, venueScreens: 1 })
  expect(count.textContent).toBe('1 venue screen connected')
  listeners.get('live:presence')?.(null, { presenterConnected: true, venueScreens: 2 })
  expect(count.textContent).toBe('2 venue screens connected')
  expect(venueUrl.textContent).toBe('example.test/read/p') // shown without the scheme (presenter redesign ticket 06)
  document.getElementById('liveVenueCopy')!.click()
  expect(copied).toBe('https://example.test/read/p')
  dom.window.dispatchEvent(new dom.window.Event('beforeunload'))
  dom.window.close()
})
