// Shared talk ticket 04: the colleague page's runtime at its seams, with no browser and no
// worker. The client with a fake transport (posting, the offline queue and retry, socket events
// and since-replay), the device store, the diff and preview helpers, and the handout builder's
// injection point.
import assert from 'node:assert/strict'
import {
  createSharedTalkClient, createSharedTalkStore, sharedTalkCompareSlides, sharedTalkLineDiff,
  sharedTalkMarkdownSlide, sharedTalkRelativeTime, sharedTalkSameText,
} from '../compiler/assets/runtime/shared-talk-core.js'
import { sharedTalkRuntimeSource } from '../compiler/assets/runtime/shared-talk-page.js'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'

class MemoryStorage {
  map = new Map()
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null }
  setItem(key, value) { this.map.set(key, String(value)) }
  removeItem(key) { this.map.delete(key) }
}

function fakeTransport() {
  const transport = {
    posts: [],
    sockets: [],
    mode: 'ok', // ok | down | answer-lost | 429 | 400
    stored: new Map(),
    async postItem(body) {
      transport.posts.push(body)
      if (transport.mode === 'down') throw new TypeError('Failed to fetch')
      if (transport.mode === '429') return { status: 429, json: { error: { code: 'rate_limited' } }, retryAfter: '3' }
      if (transport.mode === '400') return { status: 400, json: { error: { code: 'invalid_text' } } }
      const known = transport.stored.get(body.itemId)
      if (known && JSON.stringify(known) !== JSON.stringify(body)) return { status: 409, json: { error: { code: 'item_conflict' } } }
      transport.stored.set(body.itemId, body)
      // The worker stored it, but the answer never reached the page.
      if (transport.mode === 'answer-lost') throw new TypeError('network changed')
      return { status: known ? 200 : 201, json: { item: body } }
    },
    openSocket(since, handlers) {
      const socket = { since, handlers, closed: false, close() { socket.closed = true } }
      transport.sockets.push(socket)
      return socket
    },
  }
  return transport
}

function harness() {
  const storage = new MemoryStorage()
  const store = createSharedTalkStore(storage, 'share123')
  const transport = fakeTransport()
  const timers = new Map()
  let timerId = 0
  let clock = 1_790_000_000_000
  const changes = []
  const updates = []
  const client = createSharedTalkClient({
    store, transport, revision: 1,
    now: () => clock,
    schedule: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id },
    cancel: (id) => timers.delete(id),
    onChange: (reason) => changes.push(reason),
    onTalkUpdated: (revision) => updates.push(revision),
  })
  async function runTimers() {
    const pending = [...timers.entries()]
    timers.clear()
    for (const [, timer] of pending) timer.fn()
    await settle()
  }
  return { storage, store, transport, client, timers, changes, updates, runTimers, tick: (ms) => { clock += ms } }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

// ── helpers ─────────────────────────────────────────────────────────────────────────────────
{
  const diff = sharedTalkLineDiff('## The rubric problem\n- Rubrics reward fluency\n- Markers read structure first\n- Moderation catches drift',
    '## The rubric problem\n- Rubrics reward what a model writes\n- Markers read structure first')
  assert.deepEqual(diff.map((line) => line.op + ' ' + line.text), [
    'same ## The rubric problem',
    'del - Rubrics reward fluency',
    'add - Rubrics reward what a model writes',
    'same - Markers read structure first',
    'del - Moderation catches drift',
  ])
  assert.ok(sharedTalkSameText('a\r\nb  \n', 'a\nb'))
  assert.ok(!sharedTalkSameText('a', 'b'))

  const preview = sharedTalkMarkdownSlide('## Students asked for the rules in writing\n- Most used a chatbot to <start>\n- A **one-page** policy\n\nA closing line', 'What students told us')
  assert.equal(preview.title, 'Students asked for the rules in writing')
  assert.match(preview.html, /<p class="kicker">What students told us<\/p><h1>Students asked for the rules in writing<\/h1>/)
  assert.match(preview.html, /<ul class="feature-list fl-plain"><li><span class="fl-text">Most used a chatbot to &lt;start&gt;<\/span><\/li><li><span class="fl-text">A <strong>one-page<\/strong> policy/)
  assert.match(preview.html, /<p class="content-p">A closing line<\/p>/)

  assert.deepEqual(sharedTalkCompareSlides(
    [{ slideId: 'a', html: '1' }, { slideId: 'b', html: '2' }],
    [{ slideId: 'a', html: '1' }, { slideId: 'b', html: '2*' }]), { structural: false, changed: ['b'] })
  assert.equal(sharedTalkCompareSlides([{ slideId: 'a', html: '1' }], [{ slideId: 'a', html: '1' }, { slideId: 'c', html: '3' }]).structural, true)
  assert.equal(sharedTalkRelativeTime(1000, 20_000), 'just now')
  assert.equal(sharedTalkRelativeTime(0, 5 * 60_000), '5 min ago')
}

// ── store: drafts, name, seen marks, and two tabs writing one share ─────────────────────────
{
  const storage = new MemoryStorage()
  const a = createSharedTalkStore(storage, 's1')
  const b = createSharedTalkStore(storage, 's1')
  a.setDraft('note:slide-3', { text: 'Too dense' })
  b.addItem({ itemId: 'x1', kind: 'note', slideId: 'slide-2', text: 'from tab b' })
  a.addItem({ itemId: 'x2', kind: 'note', slideId: 'slide-3', text: 'from tab a' })
  assert.deepEqual(createSharedTalkStore(storage, 's1').items().map((item) => item.itemId), ['x1', 'x2'])
  assert.equal(createSharedTalkStore(storage, 's1').draft('note:slide-3').text, 'Too dense', 'a draft survives a new page load')
  a.setName('Ana')
  assert.equal(storage.getItem('talkweaver:live-name'), 'Ana', 'the name is the live sessions\' remembered name')
  assert.equal(a.hasBaseline(), false)
  a.setBaseline([['slide-2', 'f2'], ['slide-3', 'f3']])
  assert.equal(a.seen('slide-3'), 'f3')
  a.setBaseline([['slide-3', 'changed']])
  assert.equal(a.seen('slide-3'), 'f3', 'a later baseline never overwrites what she saw')
  assert.equal(createSharedTalkStore(storage, 'other').items().length, 0, 'each share keeps its own record')
}

// ── client: every kind posts once with the same idempotency key, and shows as sent ─────────
{
  const h = harness()
  h.store.setName('Ana')
  h.client.start()
  assert.equal(h.transport.sockets[0].since, 0, 'the first socket of a page load replays from 0 so earlier statuses arrive')
  h.transport.sockets[0].handlers.onOpen()
  const note = h.client.send({ kind: 'note', slideId: 'slide-3', text: 'Too dense' })
  const replace = h.client.send({ kind: 'replace', slideId: 'slide-3', baseRevision: 1, text: '## The rubric problem\n- Shorter' })
  const del = h.client.send({ kind: 'delete', slideId: 'slide-4', baseRevision: 1, reason: 'Slide 5 says it' })
  const ins = h.client.send({ kind: 'insert', afterSlideId: 'slide-3', baseRevision: 1, text: '## Students asked', section: 'What students told us' })
  await settle()
  assert.deepEqual(h.transport.posts.map((post) => post.kind), ['note', 'replace', 'delete', 'insert'])
  assert.deepEqual(h.transport.posts[0], { itemId: note.itemId, name: 'Ana', kind: 'note', slideId: 'slide-3', text: 'Too dense' })
  assert.deepEqual(h.transport.posts[3], { itemId: ins.itemId, name: 'Ana', kind: 'insert', afterSlideId: 'slide-3', baseRevision: 1, text: '## Students asked', section: 'What students told us' })
  assert.match(note.itemId, /^[A-Za-z0-9_-]{1,100}$/)
  assert.equal(new Set([note, replace, del, ins].map((item) => item.itemId)).size, 4)
  for (const item of h.store.items()) {
    assert.equal(item.state, 'sent')
    assert.ok(Number.isFinite(item.sentAt), 'a sent item carries its time')
  }
}

// ── offline: items queue on the device, then go once each when the link returns ────────────
{
  const h = harness()
  h.client.start()
  h.transport.sockets[0].handlers.onOpen()
  h.transport.mode = 'down'
  h.client.send({ kind: 'note', slideId: 'slide-3', text: 'first' })
  h.client.send({ kind: 'note', slideId: 'slide-3', text: 'second' })
  await settle()
  assert.equal(h.client.status().offline, true, 'a failed post shows the offline notice')
  assert.equal(h.client.status().queued, 2)
  assert.equal(h.transport.posts.length, 1, 'the queue stops at the first failure instead of hammering')
  assert.equal(h.timers.size, 1, 'a retry is scheduled')
  // The socket drops too; a reconnect is scheduled from the last seq it saw.
  h.transport.sockets[0].handlers.onMessage(JSON.stringify({ type: 'item.status', itemId: 'nope', status: 'accepted', at: 1, seq: 7 }))
  h.transport.sockets[0].handlers.onClose()
  await h.runTimers()
  assert.equal(h.transport.posts.length, 2, 'the retry tried again, still offline')
  assert.equal(h.transport.sockets.length, 2)
  assert.equal(h.transport.sockets[1].since, 7, 'a reconnect replays from the last seq, not from 0')
  // Link back: the worker stores the first item, but the answer is lost on the way.
  h.transport.mode = 'answer-lost'
  h.transport.sockets[1].handlers.onOpen()
  await settle()
  assert.equal(h.store.items()[0].state, 'queued', 'an unanswered post stays queued')
  h.transport.mode = 'ok'
  await h.runTimers()
  const sentIds = h.transport.posts.map((post) => post.itemId)
  assert.equal(h.transport.stored.size, 2, 'the worker holds exactly two items')
  assert.ok(h.store.items().every((item) => item.state === 'sent'))
  assert.equal(new Set(sentIds).size, 2, 'every retry reused its item\'s key')
  assert.equal(h.client.status().offline, false)
}

// ── a page reload keeps the queue and sends it on the next start ─────────────────────────────
{
  const h = harness()
  h.transport.mode = 'down'
  h.client.start()
  h.client.send({ kind: 'note', slideId: 'slide-1', text: 'kept while the tab was closed' })
  await settle()
  h.client.stop()
  const store = createSharedTalkStore(h.storage, 'share123')
  const transport = fakeTransport()
  const client = createSharedTalkClient({ store, transport, revision: 1, schedule: () => 0, cancel: () => {} })
  client.start()
  await settle()
  assert.deepEqual(transport.posts.map((post) => post.text), ['kept while the tab was closed'])
  assert.equal(store.items()[0].state, 'sent')
}

// ── refusals: rate limit waits, a bad item is marked and the queue moves on ─────────────────
{
  const h = harness()
  h.client.start()
  h.transport.sockets[0].handlers.onOpen()
  h.transport.mode = '429'
  h.client.send({ kind: 'note', slideId: 'slide-1', text: 'a' })
  await settle()
  assert.equal([...h.timers.values()][0].ms, 3000, 'Retry-After is honoured')
  assert.equal(h.client.status().offline, false, 'a rate limit is not offline')
  h.transport.mode = '400'
  await h.runTimers()
  assert.equal(h.store.items()[0].state, 'failed')
  assert.equal(h.store.items()[0].error, 'invalid_text')
  h.transport.mode = 'ok'
  h.client.send({ kind: 'note', slideId: 'slide-1', text: 'b' })
  await settle()
  assert.equal(h.store.items()[1].state, 'sent')
}

// ── socket events: statuses on her items, talk.updated, share.closed ────────────────────────
{
  const h = harness()
  h.client.start()
  const socket = h.transport.sockets[0]
  socket.handlers.onOpen()
  const note = h.client.send({ kind: 'note', slideId: 'slide-3', text: 'x' })
  await settle()
  socket.handlers.onMessage(JSON.stringify({ type: 'talk.updated', revision: 1, seq: 1 }))
  assert.deepEqual(h.updates, [], 'the replayed revision the page already shows is ignored')
  socket.handlers.onMessage(JSON.stringify({ type: 'item.status', itemId: note.itemId, status: 'accepted', at: 5, seq: 4 }))
  socket.handlers.onMessage(JSON.stringify({ type: 'item.status', itemId: note.itemId, status: 'new', at: 4, seq: 3 }))
  assert.equal(h.store.item(note.itemId).status, 'accepted', 'an older status in a replay does not undo a newer one')
  socket.handlers.onMessage(JSON.stringify({ type: 'item.status', itemId: 'someone-else', status: 'dismissed', at: 6, seq: 5 }))
  assert.equal(h.store.items().length, 1, 'statuses on items that are not hers are ignored')
  socket.handlers.onMessage(JSON.stringify({ type: 'talk.updated', revision: 2, seq: 6 }))
  assert.deepEqual(h.updates, [2])
  assert.equal(h.client.status().lastSeq, 6)
  socket.handlers.onMessage(JSON.stringify({ type: 'share.closed', reason: 'stopped' }))
  assert.equal(h.client.status().closed, true)
  assert.ok(socket.closed)
  socket.handlers.onClose()
  assert.equal(h.timers.size, 0, 'no reconnect after Stop sharing')
}

// ── the builder's injection point ───────────────────────────────────────────────────────────
{
  const base = {
    title: 'Injection', slug: 'injection', includeNotes: false, license: null, styles: '',
    slides: [{ html: '<section class="slide" data-id="slide-a" data-nav-title="A"><div class="slide-content"><h1>A</h1></div></section>', notes: '' }],
  }
  const plain = buildShareHtml(base)
  assert.ok(!plain.includes('function createSharedTalkPage('), 'an ordinary handout carries no comments runtime')
  assert.ok(!plain.includes('.tw-st-rail'))
  const shared = buildShareHtml({ ...base, sharedTalk: { ownerName: 'Dominik', proposals: false } })
  assert.ok(shared.includes('function createSharedTalkPage('))
  assert.ok(shared.includes('.tw-st-rail'))
  assert.ok(shared.includes('const SHARED_TALK_OPTIONS = {"proposals":false,"ownerName":"Dominik"};'))
  assert.ok(shared.includes('initialiseSharedTalk();\n})();'))
  const venue = buildShareHtml({ ...base, venue: true, sharedTalk: true })
  assert.ok(!venue.includes('function createSharedTalkPage('), 'the venue screen never carries it')
  // The injected source is valid script on its own (it is spliced inside the handout IIFE).
  assert.doesNotThrow(() => new Function(sharedTalkRuntimeSource()))
  const script = shared.match(/<script>\n\(\(\) => \{[\s\S]*?\n\}\)\(\);\n<\/script>/)
  assert.ok(script, 'the handout runtime script is present')
  assert.doesNotThrow(() => new Function(script[0].replace(/^<script>|<\/script>$/g, '')), 'the whole handout runtime still parses')
}

console.log('shared-talk runtime tests passed')
