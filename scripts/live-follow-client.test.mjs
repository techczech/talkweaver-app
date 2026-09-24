import assert from 'node:assert/strict'
import {
  audienceSocketUrl,
  createAudienceFollowClient,
  parseServerMessage,
  reconnectDelay,
} from '../compiler/assets/runtime/live-follow.js'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'

assert.equal(audienceSocketUrl('https://live.example.test/', 's 1'), 'wss://live.example.test/sessions/s%201/audience')
assert.deepEqual(parseServerMessage('{"type":"slide.state","slideId":"a","reveal":2,"focus":{"kind":"focus","step":1},"revision":3}'), {
  type: 'slide.state', slideId: 'a', reveal: 2, focus: { kind: 'focus', step: 1 }, revision: 3,
})
assert.equal(parseServerMessage('{"type":"slide.state","slideId":"","reveal":2,"revision":3}'), null)
assert.deepEqual(parseServerMessage('{"type":"session.closed"}'), { type: 'session.closed' })
assert.equal(reconnectDelay(0), 500)
assert.equal(reconnectDelay(9), 8000)

class FakeSocket {
  static OPEN = 1
  readyState = 0
  sent = []
  send(value) { this.sent.push(value) }
  close() { this.readyState = 3 }
  open() { this.readyState = 1; this.onopen?.() }
  message(value) { this.onmessage?.({ data: JSON.stringify(value) }) }
  drop() { this.readyState = 3; this.onclose?.() }
}

const sockets = []
const scheduled = new Map(); let timerId = 0
const states = []
const statuses = []
const client = createAudienceFollowClient({
  baseUrl: 'http://localhost:8787', sessionId: 's1',
  createSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket },
  schedule: (fn, delay) => { const id = ++timerId; scheduled.set(id, { fn, delay }); return id }, cancelSchedule: (id) => scheduled.delete(id),
  onSlideState: (state) => states.push(state), onStatus: (status) => statuses.push(status),
})
function synchronise(socket, slideState = null) {
  socket.open()
  socket.message({ type: 'session.hello', protocol: 2, expiresAt: Date.now() + 60000 })
  const sync = JSON.parse(socket.sent.at(-1))
  socket.message({ type: 'session.snapshot', protocol: 2, syncId: sync.syncId, sessionId: 's1',
    expiresAt: Date.now() + 60000, slideState, polls: [], receipts: [] })
}
synchronise(sockets[0])
sockets[0].message({ type: 'slide.state', slideId: 'a', reveal: 0, focus: { kind: 'reveal', step: 2 }, revision: 2 })
sockets[0].message({ type: 'slide.state', slideId: 'old', reveal: 0, focus: null, revision: 1 })
assert.deepEqual(states.map((state) => state.slideId), ['a'])
sockets[0].drop()
assert.equal(statuses.at(-1), 'paused-reconnecting')
const retry = [...scheduled.values()].sort((a,b) => a.delay-b.delay)[0]; retry.fn()
assert.equal(sockets.length, 2)
synchronise(sockets[1], { type: 'slide.state', slideId: 'a', reveal: 0, focus: { kind: 'reveal', step: 2 }, revision: 2 })
sockets[1].message({ type: 'slide.state', slideId: 'a', reveal: 0, focus: { kind: 'reveal', step: 2 }, revision: 2 })
assert.deepEqual(states.map((state) => state.slideId), ['a', 'a'], 'first replay on a new socket re-syncs even at the same revision')
sockets[1].message({ type: 'session.closed' })
assert.equal(client.status(), 'ended')

const html = buildShareHtml({
  title: 'Live test', slug: 'published-file', liveTalkSlug: 'canonical-talk',
  workerBaseUrl: 'https://live.example.test/', includeNotes: false, styles: '', license: null,
  slides: [{ html: '<section class="slide" data-id="slide-a"><h1>A</h1></section>', notes: '' }],
})
assert.match(html, /id="followLiveBtn"/)
assert.match(html, /id="returnToPresenterBtn"/)
assert.match(html, /id="nowLiveBadge"/)
assert.match(html, /id="overviewNowLiveBadge"/)
assert.match(html, /applyLiveSlideState/)
assert.doesNotMatch(html, /applyAudienceReveal/)
assert.match(html, /Stop following/)
assert.match(html, /the live session has ended/i)
assert.match(html, /"workerBaseUrl":"https:\/\/live\.example\.test"/)
assert.match(html, /"talkSlug":"canonical-talk"/)
assert.match(html, /createAudienceFollowClient/)
const emittedScript = [...html.matchAll(/<script>\s*([\s\S]*?)<\/script>/g)].at(-1)?.[1]
assert.ok(emittedScript, 'share handout emits its runtime script')
assert.doesNotThrow(() => new Function(emittedScript), 'share handout runtime parses after live injection')

console.log('live-follow-client: all checks passed')
