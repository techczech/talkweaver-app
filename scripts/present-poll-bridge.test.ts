import { afterAll, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'

const pointerSends: any[] = []
const inkSends: any[] = []
const listeners = new Map<string, (...args: any[]) => void>()
let exposed: any
let copied = ''
let resolveSnapshot: (value: any) => void = () => {}
const snapshot = new Promise((resolve) => { resolveSnapshot = resolve })
const invoke = mock((channel: string) => channel === 'live:snapshot' ? snapshot : channel === 'live:status' ? Promise.resolve('ended') : channel === 'live:go' ? Promise.resolve({ success: true, status: 'live', shortUrl: 'https://example.test/read', qrSvg: '<svg/>' }) : Promise.resolve({ success: true, operationId: 'op-1', status: 'pending' }))
mock.module('electron', () => ({
  contextBridge: { exposeInMainWorld: (_name: string, api: unknown) => { exposed = api } },
  clipboard: { writeText: (value: string) => { copied = value } },
  ipcRenderer: { invoke, send: (channel: string, value: unknown) => { if (channel === 'live:pointer') pointerSends.push(value); if (channel === 'live:ink') inkSends.push(value) }, on: (channel: string, listener: (...args: any[]) => void) => { listeners.set(channel, listener) } },
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
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, location: dom.window.location, HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver })
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


test('Pointer crosses isolation on mutations, validates data and disconnects on unload', async () => {
  const dom = new JSDOM('<button id="liveGoButton"></button><aside id="liveGoPanel">'
    + '<div id="liveQr"></div><div id="liveShortUrl"></div></aside>', { url: 'https://example.test' })
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, location: dom.window.location,
    HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver })
  const callbacks = new Map<number, { fn: () => void; ms: number }>()
  let id = 0
  dom.window.setInterval = ((fn: () => void, ms: number) => { callbacks.set(++id, { fn, ms }); return id }) as any
  dom.window.clearInterval = (handle: number) => { callbacks.delete(handle) }
  bridge.mountLiveBridge()
  expect([...callbacks.values()].map(value => value.ms)).toEqual([150])
  const point = { x: 640, y: 360, space: 'slide', slideId: 'text' }
  document.documentElement.dataset.twLivePointer = JSON.stringify(point)
  await tick()
  expect(pointerSends.at(-1)).toEqual({ type: 'pointer.live', pointer: point })
  const count = pointerSends.length
  await tick()
  expect(pointerSends).toHaveLength(count)
  document.documentElement.dataset.twLivePointerTick = '1'
  await tick()
  expect(pointerSends).toHaveLength(count + 1)
  document.documentElement.dataset.twLivePointer = JSON.stringify({ ...point, x: -1 })
  await tick()
  expect(pointerSends).toHaveLength(count + 1)
  document.documentElement.dataset.twLivePointer = JSON.stringify('gone')
  await tick()
  expect(pointerSends.at(-1)).toEqual({ type: 'pointer.live', pointer: 'gone' })
  document.documentElement.dataset.twLivePointer = JSON.stringify(point)
  await tick()
  dom.window.dispatchEvent(new dom.window.Event('pagehide'))
  expect(pointerSends.at(-1)).toEqual({ type: 'pointer.live', pointer: 'gone' })
  const afterHide = pointerSends.length
  document.documentElement.dataset.twLivePointerTick = '2'
  await tick()
  expect(pointerSends).toHaveLength(afterHide)
  dom.window.dispatchEvent(new dom.window.Event('beforeunload'))
  expect(callbacks.size).toBe(0)
  dom.window.close()
})


test('Pen ink crosses isolation on mutations and keep-alive ticks, is validated, and is cleared on unload', async () => {
  const dom = new JSDOM('<button id="liveGoButton"></button><aside id="liveGoPanel">'
    + '<div id="liveQr"></div><div id="liveShortUrl"></div></aside>', { url: 'https://example.test' })
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, location: dom.window.location,
    HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver })
  dom.window.setInterval = (() => 0) as any
  dom.window.clearInterval = (() => {}) as any
  bridge.mountLiveBridge()
  inkSends.length = 0
  const ink = { slideId: 'text', space: 'slide', strokes: [{ tool: 'freehand', ink: 'red', width: 'thin', points: [[1, 2], [3, 4]] }], draft: null }
  document.documentElement.dataset.twLiveInk = JSON.stringify(ink)
  await tick()
  expect(inkSends.at(-1)).toEqual({ type: 'ink.live', ink })
  document.documentElement.dataset.twLiveInkTick = '1'
  await tick()
  expect(inkSends).toHaveLength(2)
  document.documentElement.dataset.twLiveInk = JSON.stringify({ ...ink, strokes: [{ ...ink.strokes[0], ink: 'javascript:alert(1)' }] })
  await tick()
  document.documentElement.dataset.twLiveInk = '{not json'
  await tick()
  expect(inkSends).toHaveLength(2)
  // Over the byte cap within every count cap (six 400-point strokes, long decimals): refused, and a
  // slot longer than the cap is refused before it is parsed.
  const heavy = { ...ink, strokes: Array.from({ length: 6 }, () => ({ ...ink.strokes[0],
    points: Array.from({ length: 400 }, (_, i) => [100 + i / 1000 + 0.1234567890123, 200 + i / 1000 + 0.9876543210987]) })) }
  const parsed: number[] = []
  const realParse = JSON.parse
  JSON.parse = ((text: string, ...rest: any[]) => { parsed.push(String(text).length); return (realParse as any)(text, ...rest) }) as typeof JSON.parse
  try {
    document.documentElement.dataset.twLiveInk = JSON.stringify(heavy)
    await tick()
  } finally { JSON.parse = realParse }
  expect(inkSends).toHaveLength(2)
  expect(parsed.filter((n) => n > 64_000)).toEqual([])
  // A stroke being drawn still goes live.
  document.documentElement.dataset.twLiveInk = JSON.stringify({ ...ink, draft: ink.strokes[0] })
  await tick()
  expect(inkSends.at(-1)).toEqual({ type: 'ink.live', ink: { ...ink, draft: ink.strokes[0] } })
  inkSends.length = 2
  document.documentElement.dataset.twLiveInk = JSON.stringify(ink)
  await tick()
  dom.window.dispatchEvent(new dom.window.Event('pagehide'))
  expect(inkSends.at(-1)).toEqual({ type: 'ink.live', ink: { ...ink, strokes: [], draft: null } })
  const afterHide = inkSends.length
  document.documentElement.dataset.twLiveInkTick = '2'
  await tick()
  expect(inkSends).toHaveLength(afterHide)
  dom.window.dispatchEvent(new dom.window.Event('beforeunload'))
  dom.window.close()
})
