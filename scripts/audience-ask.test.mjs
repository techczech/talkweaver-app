// Ask the speaker without a browser: the sentence shown for each refusal, and the follow client's
// question queue, which is the reaction queue's own (first in, first out over one socket, one at a
// time, each waiting for its ack; a refusal stores nothing, so it is dropped and shown, never
// retried by the client; a retry by the person keeps its submission id). The box on the real page
// is audience-ask-dom.test.mjs; the whole path to a presenter is test-ask-live.mjs.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { askRefusal, audienceAskRuntimeSource } from '../compiler/assets/runtime/audience-ask.js'
import { liveFollowRuntimeSource, createAudienceFollowClient, normaliseReactionAck } from '../compiler/assets/runtime/live-follow.js'

// ── askRefusal ───────────────────────────────────────────────────────────────────────────────
assert.match(askRefusal('questions_paused').text, /not taking questions/)
assert.equal(askRefusal('questions_paused').retry, true, 'a pause may lift, so the person can try again')
for (const error of ['participant_limit_reached', 'question_limit_reached', 'reaction_limit_reached']) {
  assert.equal(askRefusal(error).retry, false, `${error} is shown plainly and not offered again`)
}
assert.match(askRefusal('participant_limit_reached').text, /most questions allowed/)
assert.equal(askRefusal('storage_failed').retry, true, 'a storage failure may pass')
assert.equal(askRefusal('no_answer').retry, true)
assert.equal(askRefusal('ended').text, 'The live session has ended, so the speaker can no longer receive questions.')
assert.equal(askRefusal(undefined).retry, true)

// ── The runtime source embeds and defines what the page calls ───────────────────────────────
const embedded = liveFollowRuntimeSource()
assert.ok(embedded.includes('function createAudienceAsk') && embedded.includes('function askRefusal'), 'the page script carries the question box')
assert.ok(audienceAskRuntimeSource().includes('createAudienceAsk'))
assert.doesNotMatch(readFileSync(new URL('../compiler/assets/runtime/audience-ask.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, ''), /(^|[^.\w])(eval|Function)\(|document\.write/, 'no dynamic code')

// ── The ack ──────────────────────────────────────────────────────────────────────────────────
assert.deepEqual(normaliseReactionAck({ type: 'question.ack', submissionId: 'sub-12345678', status: 'confirmed' }), { submissionId: 'sub-12345678', status: 'confirmed' })
assert.deepEqual(normaliseReactionAck({ type: 'question.ack', submissionId: 'sub-12345678', status: 'rejected', error: 'questions_paused' }), { submissionId: 'sub-12345678', status: 'rejected', error: 'questions_paused' })
assert.equal(normaliseReactionAck({ type: 'question.ack', submissionId: 'short', status: 'confirmed' }), null)

// ── The client's queue, with questions in it ─────────────────────────────────────────────────
const memory = () => { const map = new Map(); return { getItem: (k) => map.has(k) ? map.get(k) : null, setItem: (k, v) => { map.set(k, String(v)) }, removeItem: (k) => { map.delete(k) }, key: (i) => [...map.keys()][i] ?? null, get length() { return map.size }, map } }
class FakeSocket {
  static OPEN = 1
  readyState = 0
  sent = []
  send(value) { this.sent.push(JSON.parse(value)) }
  close() { this.readyState = 3 }
  open() { this.readyState = 1; this.onopen?.() }
  message(value) { this.onmessage?.({ data: JSON.stringify(value) }) }
  drop() { this.readyState = 3; this.onclose?.() }
  feedback() { return this.sent.filter((m) => m.type === 'reaction.send' || m.type === 'question.submit') }
}
function harness(storage = memory()) {
  const sockets = []
  const scheduled = new Map(); let timerId = 0
  const reactions = [], questions = []
  const client = createAudienceFollowClient({
    baseUrl: 'http://localhost:8787', sessionId: 's1', participantId: 'p1', storage,
    createSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket },
    schedule: (fn, delay) => { const id = ++timerId; scheduled.set(id, { fn, delay }); return id }, cancelSchedule: (id) => scheduled.delete(id),
    onReactionStatus: (receipt) => reactions.push(receipt),
    onQuestionStatus: (receipt) => questions.push(receipt),
  })
  const synchronise = (socket) => {
    socket.open()
    socket.message({ type: 'session.hello', protocol: 2, expiresAt: Date.now() + 60000 })
    const sync = socket.sent.find((m) => m.type === 'session.sync')
    socket.message({ type: 'session.snapshot', protocol: 2, syncId: sync.syncId, sessionId: 's1', expiresAt: Date.now() + 60000, slideState: null, polls: [], receipts: [] })
  }
  return { client, sockets, reactions, questions, synchronise, timers: () => [...scheduled.values()], storage }
}
const ackOf = (type) => (socket, message, status = 'confirmed', error) => socket.message({ type, submissionId: message.submissionId, status, ...(error ? { error } : {}) })
const qack = ackOf('question.ack'), rack = ackOf('reaction.ack')
const ask = (extra = {}) => ({ text: 'Why?', name: 'Priya', slideId: 'slide-1', tMs: 2000, ...extra })
const QUEUE_KEY = 'talkweaver:live-reactions:s1'

// The message the worker gets, and that it waits for the ack; reactions and questions share one order.
{
  const h = harness()
  h.synchronise(h.sockets[0])
  const r = h.client.sendReaction({ reaction: 'puzzled', slideId: 'slide-1', tMs: 1000 })
  const q = h.client.sendQuestion(ask({ text: '  Why did it ask?  ', name: '  Priya  ' }))
  const r2 = h.client.sendReaction({ reaction: 'helped', slideId: 'slide-1', tMs: 3000 })
  assert.ok(r && q && r2 && new Set([r, q, r2]).size === 3)
  assert.deepEqual(h.sockets[0].feedback().map((m) => m.type), ['reaction.send'], 'one at a time: only the first goes')
  rack(h.sockets[0], { submissionId: r })
  assert.deepEqual(h.sockets[0].feedback()[1], { type: 'question.submit', submissionId: q, text: 'Why did it ask?', name: 'Priya', slideId: 'slide-1', tMs: 2000 }, 'the question is trimmed and carries no local bookkeeping')
  qack(h.sockets[0], { submissionId: r2 })
  assert.equal(h.sockets[0].feedback().length, 2, 'an ack for something else moves nothing')
  qack(h.sockets[0], { submissionId: q })
  assert.deepEqual(h.sockets[0].feedback().map((m) => m.type), ['reaction.send', 'question.submit', 'reaction.send'], 'first in, first out across both kinds')
  rack(h.sockets[0], { submissionId: r2 })
  assert.deepEqual(h.reactions.map((x) => x.submissionId), [r, r2], 'reaction receipts go to the reaction bar')
  assert.deepEqual(h.questions.map((x) => [x.submissionId, x.status, x.item.text]), [[q, 'confirmed', 'Why did it ask?']], 'the question receipt goes to the box, carrying the item')
  assert.equal(h.storage.getItem(QUEUE_KEY), null, 'a drained queue leaves nothing stored')
}

// No name is no name field; the name is capped by the worker, not silently changed here.
{
  const h = harness()
  h.synchronise(h.sockets[0])
  h.client.sendQuestion(ask({ name: '   ' }))
  h.client.sendQuestion(ask({ name: undefined }))
  assert.equal('name' in h.sockets[0].feedback()[0], false, 'a blank name is left out')
}

// Offline: kept on the device, sent once on reconnect, first in first out, and a reload keeps them.
{
  const storage = memory()
  const h = harness(storage)
  const a = h.client.sendQuestion(ask({ text: 'First' }))
  const b = h.client.sendQuestion(ask({ text: 'Second', tMs: 2100 }))
  assert.ok(a && b)
  assert.equal(h.sockets[0].feedback().length, 0, 'nothing is sent before the socket is live')
  assert.equal(JSON.parse(storage.getItem(QUEUE_KEY)).items.length, 2, 'both are kept on the device')
  assert.equal(JSON.parse(storage.getItem(QUEUE_KEY)).items[0].kind, 'question')
  const reloaded = harness(storage)
  reloaded.synchronise(reloaded.sockets[0])
  assert.deepEqual(reloaded.sockets[0].feedback().map((m) => m.text), ['First'], 'the reloaded page sends the kept question first')
  qack(reloaded.sockets[0], { submissionId: a })
  qack(reloaded.sockets[0], { submissionId: b })
  assert.deepEqual(reloaded.sockets[0].feedback().map((m) => m.text), ['First', 'Second'])
  assert.equal(storage.getItem(QUEUE_KEY), null)
}

// A retry with the id it had is the same question: queued once, resent under its own id.
{
  const h = harness()
  h.synchronise(h.sockets[0])
  const a = h.client.sendQuestion(ask())
  assert.equal(h.client.sendQuestion(ask({ submissionId: a })), a, 'the same id while it is still queued returns it and adds nothing')
  assert.equal(h.sockets[0].feedback().length, 1)
  qack(h.sockets[0], { submissionId: a }, 'rejected', 'storage_failed')
  assert.equal(h.questions[0].error, 'storage_failed')
  const again = h.client.sendQuestion(ask({ submissionId: a }))
  assert.equal(again, a, 'after a refusal the person can send the same id again')
  assert.deepEqual(h.sockets[0].feedback().map((m) => m.submissionId), [a, a])
  assert.equal(h.client.sendQuestion(ask({ submissionId: 'no' })) === 'no', false, 'an id that is not well formed is replaced, not trusted')
}

// A dropped socket before the ack: the same submission id goes again on the next socket, once.
{
  const h = harness()
  h.synchronise(h.sockets[0])
  const a = h.client.sendQuestion(ask())
  h.sockets[0].drop()
  h.timers().sort((x, y) => x.delay - y.delay)[0].fn()
  h.synchronise(h.sockets[1])
  assert.deepEqual(h.sockets[1].feedback().map((m) => m.submissionId), [a], 'the unacknowledged question is resent with its own id')
  qack(h.sockets[1], { submissionId: a })
  assert.equal(h.questions.length, 1)
}

// A pause refusal (and every other) stores nothing at the worker: the item is dropped from the queue
// and the device, so it cannot land after a resume; the queue moves on; limits are not retried.
{
  const h = harness()
  h.synchronise(h.sockets[0])
  const a = h.client.sendQuestion(ask({ text: 'During the pause' }))
  const b = h.client.sendQuestion(ask({ text: 'After' }))
  qack(h.sockets[0], { submissionId: a }, 'rejected', 'questions_paused')
  assert.deepEqual(h.questions.map((x) => [x.status, x.error, x.item.text]), [['rejected', 'questions_paused', 'During the pause']])
  assert.deepEqual(h.sockets[0].feedback().map((m) => m.text), ['During the pause', 'After'], 'the queue moves on after a refusal')
  qack(h.sockets[0], { submissionId: b }, 'rejected', 'question_limit_reached')
  assert.equal(h.questions[1].error, 'question_limit_reached')
  assert.equal(h.sockets[0].feedback().length, 2, 'a limit refusal is not retried')
  assert.equal(h.storage.getItem(QUEUE_KEY), null, 'refused questions are not kept for a later resend')
  h.sockets[0].drop()
  h.timers().sort((x, y) => x.delay - y.delay)[0].fn()
  h.synchronise(h.sockets[1])
  assert.equal(h.sockets[1].feedback().length, 0, 'a refused question does not come back after a reconnect or a resume')
}

// A worker that does not take questions: a protocol error settles the item as a refusal.
{
  const h = harness()
  h.synchronise(h.sockets[0])
  const a = h.client.sendQuestion(ask())
  h.sockets[0].message({ type: 'protocol.error', code: 'invalid_or_inert_message' })
  assert.deepEqual(h.questions.map((x) => [x.submissionId, x.status, x.error]), [[a, 'rejected', 'protocol_error']])
}

// Bad input and limits.
{
  const h = harness()
  assert.equal(h.client.sendQuestion(null), false)
  assert.equal(h.client.sendQuestion({ text: '   ', slideId: 'a', tMs: 1 }), false, 'no text is no question')
  assert.equal(h.client.sendQuestion({ text: 'x', slideId: 'a', tMs: -1.5 }), false)
  assert.equal(h.client.sendQuestion({ text: 'x', tMs: 1 }), false)
  assert.equal(harness(null).client.sendQuestion(ask()), false, 'a question that cannot be kept is refused, not pretended')
  for (let i = 0; i < 200; i++) assert.ok(h.client.sendQuestion(ask({ text: 'q' + i })))
  assert.equal(h.client.sendQuestion(ask()), false, 'the queue is bounded')
  h.client.end()
  assert.equal(h.client.sendQuestion(ask()), false, 'nothing is queued after the session ends')
}

// A question that cannot be kept says so, and is not "ended".
{
  const full = harness(memory())
  full.synchronise(full.sockets[0])
  for (let i = 0; i < 200; i++) full.client.sendQuestion(ask({ text: 'q' + i }))
  assert.equal(full.client.sendQuestion(ask()), false)
  assert.equal(full.client.questionRefusal(), 'not_kept', 'a full queue is not an ended session')
  full.client.end()
  full.client.sendQuestion(ask())
  assert.equal(full.client.questionRefusal(), 'ended')
  assert.match(askRefusal('not_kept').text, /Could not keep your question on this device\. Copy it, then try again\./)
  const blocked = harness(null)
  assert.equal(blocked.client.sendQuestion(ask()), false)
  assert.equal(blocked.client.questionRefusal(), 'not_kept', 'blocked storage is not an ended session')
}

// Two tabs on one stored queue: a tab skips an item the other has already settled.
{
  const storage = memory()
  const one = harness(storage), two = harness(storage)
  const a = one.client.sendQuestion(ask({ text: 'From tab one' }))
  const b = two.client.sendQuestion(ask({ text: 'From tab two' }))
  one.synchronise(one.sockets[0]); two.synchronise(two.sockets[0])
  assert.deepEqual(one.sockets[0].feedback().map((m) => m.submissionId), [a], 'tab one sends the head')
  qack(one.sockets[0], { submissionId: a })
  // Tab two still holds a in memory; a is settled in storage, so it must not be sent again.
  assert.deepEqual(two.sockets[0].feedback().map((m) => m.submissionId), [b], 'tab two skips the item tab one settled and sends its own')
}

// The receipt carries the stored item, so a result with nothing in memory (after a reload) still has its text.
{
  const storage = memory()
  const first = harness(storage)
  const a = first.client.sendQuestion(ask({ text: 'Before the reload', name: 'Sam' }))
  const reloaded = harness(storage)
  reloaded.synchronise(reloaded.sockets[0])
  qack(reloaded.sockets[0], { submissionId: a }, 'rejected', 'questions_paused')
  assert.deepEqual([reloaded.questions[0].item.text, reloaded.questions[0].item.name, reloaded.questions[0].item.slideId], ['Before the reload', 'Sam', 'slide-1'])
}

console.log('audience-ask: refusal sentences, the question ack, and the question queue (order with reactions, offline, retry id, refusals dropped) passed')
