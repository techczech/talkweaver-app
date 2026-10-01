// The audience reaction bar's logic without a browser: what one tap does to a slide's marks, what the
// device keeps per talk and slide, and the follow client's reaction queue (first in, first out over
// one socket, one at a time, each waiting for its ack; refusals dropped and shown, never retried).
// The bar on the real page is audience-reactions-dom.test.mjs.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { audienceBarPlan, audienceReactionIcons, audienceReactionsSupported, createReactionMarks, reactionRevert, reactionTap } from '../compiler/assets/runtime/audience-reactions.js'
import { createAudienceFollowClient, normaliseReactionAck, normaliseSwitches } from '../compiler/assets/runtime/live-follow.js'

// ── reactionTap: one meaning reaction per slide, the bookmark on its own ─────────────────────
const none = { r: null, b: false }
assert.deepEqual(reactionTap(none, 'puzzled'), { next: { r: 'puzzled', b: false }, kind: 'select', reaction: 'puzzled', withdrawn: false, replaced: null })
assert.deepEqual(reactionTap({ r: 'puzzled', b: false }, 'helped'), { next: { r: 'helped', b: false }, kind: 'change', reaction: 'helped', withdrawn: false, replaced: 'puzzled' },
  'another reaction replaces the first in one message')
assert.deepEqual(reactionTap({ r: 'helped', b: false }, 'helped'), { next: { r: null, b: false }, kind: 'undo', reaction: 'helped', withdrawn: true, replaced: null }, 'the same reaction again is an undo')
assert.deepEqual(reactionTap({ r: 'puzzled', b: false }, 'bookmark').next, { r: 'puzzled', b: true }, 'a bookmark leaves the meaning reaction alone')
assert.deepEqual(reactionTap({ r: 'puzzled', b: true }, 'bookmark'), { next: { r: 'puzzled', b: false }, kind: 'bookmark-off', reaction: 'bookmark', withdrawn: true, replaced: null })
assert.deepEqual(reactionTap({ r: 'puzzled', b: true }, 'helped').next, { r: 'helped', b: true }, 'a meaning reaction leaves the bookmark alone')
assert.deepEqual(reactionTap(null, 'puzzled').next, { r: 'puzzled', b: false }, 'no marks yet is empty marks')

// ── The icons are lucide's own ───────────────────────────────────────────────────────────────
const lucide = JSON.parse(readFileSync(new URL('../compiler/assets/icons/lucide.json', import.meta.url), 'utf8'))
for (const [name, body] of Object.entries(audienceReactionIcons())) assert.equal(body, lucide[name]?.body, `icon ${name} matches the vendored lucide set`)

// ── The person's own marks: per talk, per run and per slide, on this device ─────────────────
const memory = () => { const map = new Map(); return { getItem: (k) => map.has(k) ? map.get(k) : null, setItem: (k, v) => { map.set(k, String(v)) }, removeItem: (k) => { map.delete(k) }, key: (i) => [...map.keys()][i] ?? null, get length() { return map.size }, map } }
const KEY = 'html-presentations:reactions:talk'
{
  const storage = memory()
  const marks = createReactionMarks({ storage, key: KEY })
  assert.equal(marks.used(), false)
  assert.deepEqual(marks.get('s1', 'A'), none)
  marks.set('s1', 'A', { r: 'puzzled', b: true })
  marks.markUsed()
  const again = createReactionMarks({ storage, key: KEY })
  assert.equal(again.used(), true, 'the first-use flag survives a reload')
  assert.deepEqual(again.get('s1', 'A'), { r: 'puzzled', b: true }, 'marks survive a reload')
  assert.deepEqual(again.get('s1', 'B'), none, 'a later run of the same talk starts with an empty bar')
  // A later run never overwrites or deletes an earlier run's marks.
  again.set('s1', 'B', { r: 'helped' })
  again.set('s1', 'B', { r: null })
  assert.deepEqual(again.all(), { A: { s1: { r: 'puzzled', b: true } } }, 'the earlier run keeps its mark; an emptied slide leaves no entry')
  again.set('s1', 'B', { b: true })
  assert.deepEqual(again.all(), { A: { s1: { r: 'puzzled', b: true } }, B: { s1: { r: null, b: true } } }, 'marks are stored by run, then slide')
  // A write names the half it changes.
  again.set('s1', 'A', { b: false })
  assert.deepEqual(again.get('s1', 'A'), { r: 'puzzled', b: false })
  again.set('s1', 'A', { r: null })
  assert.deepEqual(again.all().A, undefined, 'an emptied run leaves no entry')
  storage.setItem(KEY, '{not json')
  assert.deepEqual(createReactionMarks({ storage, key: KEY }).get('s1', 'A'), none, 'unreadable storage starts empty')
  const blocked = { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') } }
  const kept = createReactionMarks({ storage: blocked, key: KEY })
  kept.set('s2', 'A', { r: 'helped', b: false })
  assert.deepEqual(kept.get('s2', 'A'), { r: 'helped', b: false }, 'blocked storage still works for the page')
}

// Two tabs of one talk on one storage: neither rewrites the other's marks from stale memory.
{
  const storage = memory()
  const tabOne = createReactionMarks({ storage, key: KEY })
  const tabTwo = createReactionMarks({ storage, key: KEY })
  tabOne.set('s1', 'A', { r: 'puzzled' })
  tabTwo.set('s2', 'A', { b: true })
  tabOne.set('s3', 'A', { r: 'helped' })
  tabTwo.markUsed()
  tabOne.set('s2', 'A', { r: 'puzzled' })
  for (const tab of [tabOne, tabTwo]) {
    assert.deepEqual(tab.get('s1', 'A'), { r: 'puzzled', b: false })
    assert.deepEqual(tab.get('s2', 'A'), { r: 'puzzled', b: true }, 'each tab changed its own half of one slide')
    assert.deepEqual(tab.get('s3', 'A'), { r: 'helped', b: false })
    assert.equal(tab.used(), true)
  }
}

// A refused tap puts back only the half it changed, and only if that half has not moved since.
{
  const refused = (reaction, before, after) => ({ reaction, local: { before, after } })
  // Tap Puzzled (refused), then Bookmark: the bookmark stays, Puzzled goes.
  assert.deepEqual(reactionRevert({ r: 'puzzled', b: true }, refused('puzzled', none, { r: 'puzzled', b: false })), { r: null })
  // A refused change Helped -> Puzzled, then Bookmark: back to Helped, bookmark kept.
  assert.deepEqual(reactionRevert({ r: 'puzzled', b: true }, refused('puzzled', { r: 'helped', b: false }, { r: 'puzzled', b: false })), { r: 'helped' })
  // A refused bookmark, then Puzzled: the bookmark goes, Puzzled stays.
  assert.deepEqual(reactionRevert({ r: 'puzzled', b: true }, refused('bookmark', none, { r: null, b: true })), { b: false })
  // A later tap on the same half has moved it: nothing is put back.
  assert.equal(reactionRevert({ r: 'helped', b: false }, refused('puzzled', none, { r: 'puzzled', b: false })), null)
  assert.equal(reactionRevert({ r: null, b: false }, refused('bookmark', none, { r: null, b: true })), null)
  assert.equal(reactionRevert(none, { reaction: 'puzzled' }), null, 'an item with no local record changes nothing')
}

// ── Whether the worker takes reactions ───────────────────────────────────────────────────────
assert.equal(audienceReactionsSupported({ protocol: 2, build: '14-reactions-questions' }), true)
assert.equal(audienceReactionsSupported({ protocol: 2, build: '15-anything' }), true)
assert.equal(audienceReactionsSupported({ protocol: 2, build: '13-instant-images' }), false, 'an older build does not')
assert.equal(audienceReactionsSupported({ protocol: 2 }), false)
assert.equal(audienceReactionsSupported({ protocol: 1, build: '14-x' }), false)
assert.equal(audienceReactionsSupported(null), false)

// ── normaliseReactionAck ─────────────────────────────────────────────────────────────────────
assert.deepEqual(normaliseReactionAck({ type: 'reaction.ack', submissionId: 'sub-12345678', status: 'confirmed' }), { submissionId: 'sub-12345678', status: 'confirmed' })
assert.deepEqual(normaliseReactionAck({ type: 'reaction.ack', submissionId: 'sub-12345678', status: 'rejected', error: 'reactions_paused' }), { submissionId: 'sub-12345678', status: 'rejected', error: 'reactions_paused' })
assert.equal(normaliseReactionAck({ type: 'reaction.ack', submissionId: 'x', status: 'confirmed' }), null)
assert.equal(normaliseReactionAck({ type: 'reaction.ack', submissionId: 'sub-12345678', status: 'maybe' }), null)
assert.equal(normaliseReactionAck({ type: 'vote.ack', submissionId: 'sub-12345678', status: 'confirmed' }), null)

// ── The client's reaction queue ──────────────────────────────────────────────────────────────
class FakeSocket {
  static OPEN = 1
  readyState = 0
  sent = []
  send(value) { this.sent.push(JSON.parse(value)) }
  close() { this.readyState = 3 }
  open() { this.readyState = 1; this.onopen?.() }
  message(value) { this.onmessage?.({ data: JSON.stringify(value) }) }
  drop() { this.readyState = 3; this.onclose?.() }
  reactions() { return this.sent.filter((m) => m.type === 'reaction.send') }
}
function harness(storage = memory(), extra = {}) {
  const sockets = []
  const scheduled = new Map(); let timerId = 0
  const receipts = []
  const client = createAudienceFollowClient({
    baseUrl: 'http://localhost:8787', sessionId: 's1', participantId: 'p1', storage,
    createSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket },
    schedule: (fn, delay) => { const id = ++timerId; scheduled.set(id, { fn, delay }); return id }, cancelSchedule: (id) => scheduled.delete(id),
    onReactionStatus: (receipt) => receipts.push(receipt),
    ...extra,
  })
  const synchronise = (socket) => {
    socket.open()
    socket.message({ type: 'session.hello', protocol: 2, expiresAt: Date.now() + 60000 })
    const sync = socket.sent.find((m) => m.type === 'session.sync')
    socket.message({ type: 'session.snapshot', protocol: 2, syncId: sync.syncId, sessionId: 's1', expiresAt: Date.now() + 60000, slideState: null, polls: [], receipts: [] })
  }
  const timers = () => [...scheduled.values()]
  return { client, sockets, receipts, synchronise, timers, storage }
}
const ack = (socket, message, status = 'confirmed', error) => socket.message({ type: 'reaction.ack', submissionId: message.submissionId, status, ...(error ? { error } : {}) })
const input = (reaction, extra = {}) => ({ reaction, slideId: 'slide-1', tMs: 1000, ...extra })
const QUEUE_KEY = 'talkweaver:live-reactions:s1'
const storedQueue = (storage, key = QUEUE_KEY) => JSON.parse(storage.getItem(key) || 'null')

// First in, first out, one at a time, each waiting for its ack.
{
  const h = harness()
  h.synchronise(h.sockets[0])
  const a = h.client.sendReaction(input('puzzled'))
  const b = h.client.sendReaction(input('helped', { tMs: 1100 }))
  const c = h.client.sendReaction(input('helped', { tMs: 1200, withdrawn: true }))
  assert.ok(a && b && c && new Set([a, b, c]).size === 3, 'each reaction gets its own submission id')
  assert.deepEqual(h.sockets[0].reactions().map((m) => m.reaction), ['puzzled'], 'only the first goes until it is acknowledged')
  assert.deepEqual(h.sockets[0].reactions()[0], { type: 'reaction.send', submissionId: a, reaction: 'puzzled', slideId: 'slide-1', tMs: 1000 }, 'the message carries no local bookkeeping')
  ack(h.sockets[0], { submissionId: b })
  assert.equal(h.sockets[0].reactions().length, 1, 'an ack for something else moves nothing')
  ack(h.sockets[0], { submissionId: a })
  assert.deepEqual(h.sockets[0].reactions().map((m) => m.reaction), ['puzzled', 'helped'], 'the second goes after the first is acknowledged')
  ack(h.sockets[0], { submissionId: b })
  assert.deepEqual(h.sockets[0].reactions().map((m) => [m.reaction, m.tMs, m.withdrawn === true]), [['puzzled', 1000, false], ['helped', 1100, false], ['helped', 1200, true]], 'withdrawals keep their own tMs')
  ack(h.sockets[0], { submissionId: c })
  assert.deepEqual(h.receipts.map((r) => [r.submissionId, r.status]), [[a, 'confirmed'], [b, 'confirmed'], [c, 'confirmed']])
  assert.equal(h.storage.getItem(QUEUE_KEY), null, 'a drained queue leaves nothing stored')
}

// Offline: taps queue and are kept; on reconnect they send once, in order.
{
  const storage = memory()
  const h = harness(storage)
  const a = h.client.sendReaction(input('puzzled'))
  const b = h.client.sendReaction(input('bookmark', { tMs: 1500 }))
  assert.ok(a && b)
  assert.equal(h.sockets[0].reactions().length, 0, 'nothing is sent before the socket is live')
  assert.equal(storedQueue(storage).items.length, 2, 'the queue is kept on the device, stamped')
  assert.ok(Number.isSafeInteger(storedQueue(storage).at), 'with the time it was written')
  // The page is reloaded while still offline: a new client on the same storage picks the queue up.
  const reloaded = harness(storage)
  reloaded.synchronise(reloaded.sockets[0])
  assert.deepEqual(reloaded.sockets[0].reactions().map((m) => m.submissionId), [a], 'the reloaded page sends the kept reaction first')
  ack(reloaded.sockets[0], { submissionId: a })
  assert.deepEqual(reloaded.sockets[0].reactions().map((m) => m.submissionId), [a, b])
  ack(reloaded.sockets[0], { submissionId: b })
  assert.deepEqual(reloaded.receipts.map((r) => r.item.reaction), ['puzzled', 'bookmark'], 'the receipts carry the queued item back to the bar')
  assert.equal(storage.getItem(QUEUE_KEY), null)
}

// A dropped socket before the ack: the same submission id goes again on the next socket, once.
{
  const h = harness()
  h.synchronise(h.sockets[0])
  const a = h.client.sendReaction(input('puzzled'))
  h.sockets[0].drop()
  h.timers().sort((x, y) => x.delay - y.delay)[0].fn()
  assert.equal(h.sockets.length, 2)
  h.synchronise(h.sockets[1])
  assert.deepEqual(h.sockets[1].reactions().map((m) => m.submissionId), [a], 'the unacknowledged reaction is resent with its own id')
  ack(h.sockets[1], { submissionId: a })
  assert.equal(h.receipts.length, 1)
  assert.equal(h.sockets[1].reactions().length, 1, 'and only once')
}

// Refusals settle the item: dropped, reported, never retried, and the queue moves on.
{
  const h = harness()
  h.synchronise(h.sockets[0])
  const a = h.client.sendReaction(input('puzzled'))
  const b = h.client.sendReaction(input('helped'))
  ack(h.sockets[0], { submissionId: a }, 'rejected', 'reactions_paused')
  assert.equal(h.receipts[0].status, 'rejected')
  assert.equal(h.receipts[0].error, 'reactions_paused')
  assert.equal(h.receipts[0].item.reaction, 'puzzled')
  assert.deepEqual(h.sockets[0].reactions().map((m) => m.submissionId), [a, b], 'the queue moves on to the next after a refusal')
  ack(h.sockets[0], { submissionId: b }, 'rejected', 'participant_limit_reached')
  assert.equal(h.receipts[1].error, 'participant_limit_reached')
  assert.equal(h.sockets[0].reactions().length, 2, 'a limit refusal is not retried')
  assert.equal(h.storage.getItem(QUEUE_KEY), null, 'refused items are not kept for a later resend')
  h.sockets[0].drop()
  h.timers().sort((x, y) => x.delay - y.delay)[0].fn()
  h.synchronise(h.sockets[1])
  assert.equal(h.sockets[1].reactions().length, 0, 'a refused reaction does not come back after a reconnect (or after a resume)')
}

// Bad input and limits.
{
  const h = harness()
  assert.equal(h.client.sendReaction(null), false)
  assert.equal(h.client.sendReaction({ reaction: 'puzzled', slideId: 'a', tMs: -1.5 }), false)
  assert.equal(h.client.sendReaction({ reaction: 5, slideId: 'a', tMs: 1 }), false)
  for (let i = 0; i < 200; i++) assert.ok(h.client.sendReaction(input('puzzled', { tMs: i })))
  assert.equal(h.client.sendReaction(input('puzzled')), false, 'the queue is bounded')
  const noStorage = harness(null)
  assert.equal(noStorage.client.sendReaction(input('puzzled')), false, 'a reaction that cannot be kept is refused, not pretended')
  h.client.end()
  assert.equal(h.client.sendReaction(input('puzzled')), false, 'nothing is queued after the session ends')
}

// A worker that does not take reactions: a protocol error settles the item as a refusal.
{
  const h = harness()
  h.synchronise(h.sockets[0])
  const a = h.client.sendReaction(input('puzzled'))
  const b = h.client.sendReaction(input('helped'))
  h.sockets[0].message({ type: 'protocol.error', code: 'invalid_or_inert_message' })
  assert.deepEqual(h.receipts.map((r) => [r.submissionId, r.status, r.error]), [[a, 'rejected', 'protocol_error']], 'a protocol error while a reaction is in flight refuses that reaction')
  assert.deepEqual(h.sockets[0].reactions().map((m) => m.submissionId), [a, b], 'and the queue moves on')
  assert.equal(storedQueue(h.storage).items.length, 1, 'only the settled item left the stored queue')
  h.sockets[0].message({ type: 'protocol.error', code: 'invalid_or_inert_message' })
  h.sockets[0].message({ type: 'protocol.error', code: 'invalid_or_inert_message' })
  assert.equal(h.receipts.length, 2, 'a protocol error with nothing in flight is not a reaction refusal')
}

// An item that never gets an answer is dropped on the third silent try, and the count survives a reload.
{
  const storage = memory()
  const h = harness(storage)
  h.synchronise(h.sockets[0])
  const a = h.client.sendReaction(input('puzzled'))
  const b = h.client.sendReaction(input('helped'))
  // Timer 1 (reaction): reconnect and resend.
  const trigger = (hh) => { const t = hh.timers().filter((x) => x.delay === 10_000); t.at(-1).fn() }
  trigger(h)
  assert.equal(h.receipts.length, 0, 'the first silent try only reconnects')
  assert.equal(storedQueue(storage).items[0].tries, 1, 'and counts the try with the stored item')
  const reloaded = harness(storage)
  reloaded.synchronise(reloaded.sockets[0])
  assert.deepEqual(reloaded.sockets[0].reactions().map((m) => m.submissionId), [a], 'the reloaded page resends it')
  trigger(reloaded)
  assert.equal(reloaded.receipts.length, 0)
  assert.equal(storedQueue(storage).items[0].tries, 2)
  reloaded.timers().sort((x, y) => x.delay - y.delay)[0].fn()
  reloaded.synchronise(reloaded.sockets[1])
  trigger(reloaded)
  assert.deepEqual(reloaded.receipts.map((r) => [r.submissionId, r.status, r.error]), [[a, 'rejected', 'no_answer']], 'the third silent try drops it')
  assert.deepEqual(reloaded.sockets[1].reactions().map((m) => m.submissionId), [a, b], 'so it cannot block the next item')
  assert.equal(storedQueue(storage).items.some((i) => i.submissionId === a), false)
}

// Two tabs of one talk and session: each removes only the item it finished, and adds without losing the other's.
{
  const storage = memory()
  const tabOne = harness(storage)
  const tabTwo = harness(storage)
  const a = tabOne.client.sendReaction(input('puzzled'))
  const b = tabTwo.client.sendReaction(input('helped', { tMs: 1100 }))
  assert.deepEqual(storedQueue(storage).items.map((i) => i.submissionId), [a, b], 'both items are stored, neither tab overwrote the other')
  tabOne.synchronise(tabOne.sockets[0])
  ack(tabOne.sockets[0], { submissionId: a })
  assert.deepEqual(storedQueue(storage).items.map((i) => i.submissionId), [b], 'a tab removes only the item it finished')
  const c = tabOne.client.sendReaction(input('bookmark', { tMs: 1200 }))
  assert.deepEqual(storedQueue(storage).items.map((i) => i.submissionId), [b, c])
}

// Queues left by other sessions are swept after 7 days, only those.
{
  const storage = memory()
  const day = 24 * 60 * 60 * 1000
  const t0 = 1_800_000_000_000
  const queue = (at) => JSON.stringify({ at, items: [{ submissionId: 'sub-12345678', reaction: 'puzzled', slideId: 'a', tMs: 1 }] })
  storage.setItem('talkweaver:live-reactions:old', queue(t0 - 8 * day))
  storage.setItem('talkweaver:live-reactions:recent', queue(t0 - 6 * day))
  storage.setItem('talkweaver:live-reactions:garbled', '{nope')
  storage.setItem('talkweaver:live-reactions:s1', queue(t0 - 30 * day))
  storage.setItem('html-presentations:reactions:talk', '{"v":2}')
  harness(storage, { now: () => t0 })
  const left = [...storage.map.keys()].sort()
  assert.deepEqual(left, ['html-presentations:reactions:talk', 'talkweaver:live-reactions:recent', 'talkweaver:live-reactions:s1'], 'old and unreadable queues of other sessions go; this session\'s own and other keys stay')
}

// ── The speaker's switches (ADR-0027 amendment, ticket 05): what stays on the bar, and how the client hears of them ──
{
  const full = { meaning: true, bookmark: true, ask: true, note: '' }
  assert.deepEqual(audienceBarPlan(null), full, 'no switches heard yet means both on')
  assert.deepEqual(audienceBarPlan({ questionsAllowed: true, reactionsAllowed: true }), full)
  assert.deepEqual(audienceBarPlan({ questionsAllowed: true, reactionsAllowed: false }),
    { meaning: false, bookmark: true, ask: true, note: 'The speaker has paused reactions' }, 'reactions paused: Ask and Bookmark stay, the meaning reactions go')
  assert.deepEqual(audienceBarPlan({ questionsAllowed: false, reactionsAllowed: true }),
    { meaning: true, bookmark: true, ask: false, note: 'The speaker is not taking questions right now' }, 'questions paused: Ask goes, the reactions stay')
  const both = audienceBarPlan({ questionsAllowed: false, reactionsAllowed: false })
  assert.equal(both.bookmark, true, 'both paused: Bookmark stays (ADR-0027 amendment point 2)')
  assert.equal(both.meaning, false)
  assert.equal(both.ask, false)
  assert.equal(audienceBarPlan({ reactionsAllowed: 'no' }).meaning, true, 'only a real false pauses')
  assert.deepEqual(normaliseSwitches({ type: 'switches.state', questionsAllowed: false, reactionsAllowed: true }), { questionsAllowed: false, reactionsAllowed: true })
  assert.equal(normaliseSwitches({ questionsAllowed: false }), null)
  assert.equal(normaliseSwitches({ questionsAllowed: 'no', reactionsAllowed: true }), null)
  assert.equal(normaliseSwitches(undefined), null)
  // The client passes on switches.state at any time and the snapshot's switches on synchronising.
  const heard = []
  const h = harness(memory(), { onSwitches: (value) => heard.push(value) })
  const socket = h.sockets[0]
  socket.open()
  socket.message({ type: 'session.hello', protocol: 2, expiresAt: Date.now() + 60000 })
  const sync = socket.sent.find((m) => m.type === 'session.sync')
  socket.message({ type: 'session.snapshot', protocol: 2, syncId: sync.syncId, sessionId: 's1', expiresAt: Date.now() + 60000, slideState: null, polls: [], receipts: [], switches: { questionsAllowed: true, reactionsAllowed: false } })
  assert.deepEqual(heard, [{ questionsAllowed: true, reactionsAllowed: false }], 'the snapshot carries the switches')
  socket.message({ type: 'switches.state', questionsAllowed: false, reactionsAllowed: true })
  assert.deepEqual(heard.at(-1), { questionsAllowed: false, reactionsAllowed: true }, 'a switches.state is passed on')
  socket.message({ type: 'switches.state', questionsAllowed: 1 })
  assert.equal(heard.length, 2, 'a malformed one is ignored')
  // A queued reaction refused during a pause is dropped from the queue and the device, not kept for the resume.
  const paused = harness()
  paused.synchronise(paused.sockets[0])
  const held = paused.client.sendReaction({ reaction: 'puzzled', slideId: 'slide-1', tMs: 1 })
  const marked = paused.client.sendReaction({ reaction: 'bookmark', slideId: 'slide-1', tMs: 2 })
  ack(paused.sockets[0], { submissionId: held }, 'rejected', 'reactions_paused')
  assert.deepEqual(paused.receipts.map((r) => [r.status, r.error]), [['rejected', 'reactions_paused']])
  assert.deepEqual(paused.sockets[0].reactions().map((m) => m.reaction), ['puzzled', 'bookmark'], 'the bookmark behind it is sent next')
  ack(paused.sockets[0], { submissionId: marked })
  assert.equal(paused.storage.getItem('talkweaver:live-reactions:s1'), null, 'the refused item is not stored for resending after the resume')
}

console.log('audience-reactions: tap rules, icons, device marks and the reaction queue passed')
