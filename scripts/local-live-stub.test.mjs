// The local preview's stub live service: discovery, the audience socket's replies, and the pushes the
// presenter control page makes. Every pushed message is checked with the page's own parser
// (parseServerMessage), so the stub cannot drift from what the audience client accepts.
import assert from 'node:assert/strict'
import { parseServerMessage } from '../compiler/assets/runtime/live-follow.js'
import { createLiveStub } from './lib/local-live-stub.mjs'

const stub = createLiveStub({ slug: 'talk', slideIds: ['a', 'b', 'c'], build: 'test-build', now: () => 1_000_000 })
assert.deepEqual(stub.discovery(), { live: false })
assert.deepEqual(stub.capabilities(), { protocol: 2, build: 'test-build' })

const got = []
const send = (raw) => got.push(JSON.parse(raw))
stub.connect(send)
assert.equal(got[0].type, 'session.hello')
assert.equal(got[0].protocol, 2)

stub.startLive()
assert.deepEqual(stub.discovery(), { live: true, sessionId: stub.sessionId, protocol: 2 })

// Handshake: ping -> pong; sync -> snapshot carrying the current slide and no polls.
assert.deepEqual(stub.handle(send, JSON.stringify({ type: 'session.ping', nonce: 'nonce-12345' })), [{ type: 'session.pong', nonce: 'nonce-12345' }])
const [snapshot] = stub.handle(send, JSON.stringify({ type: 'session.sync', syncId: 'sync-12345' }))
assert.equal(snapshot.type, 'session.snapshot')
assert.equal(snapshot.syncId, 'sync-12345')
assert.equal(snapshot.sessionId, stub.sessionId)
assert.equal(snapshot.slideState.slideId, 'a')
assert.deepEqual(snapshot.polls, [])
assert.equal(parseServerMessage(JSON.stringify(snapshot.slideState)).type, 'slide.state')

// Pushes reach the connected socket and parse with the page's parser; slides stay in range.
got.length = 0
stub.goToSlide(1); stub.goToSlide(1); stub.goToSlide(1)
assert.deepEqual(got.map((m) => m.slideId), ['b', 'c', 'c'])
assert.ok(got.every((m, i) => parseServerMessage(JSON.stringify(m))?.type === 'slide.state' && (i === 0 || m.revision > got[i - 1].revision)))
stub.goToSlide(-5)
assert.equal(got.at(-1).slideId, 'a')

got.length = 0
stub.openPoll()
assert.equal(got[0].type, 'poll.state')
assert.equal(got[0].open, true)
assert.equal(parseServerMessage(JSON.stringify(got[0]))?.type, 'poll.state')
const openId = got[0].pollId
stub.closePoll()
assert.equal(got.at(-1).open, false)
stub.openPoll()
assert.notEqual(got.at(-1).pollId, openId, 'a second open is a new poll')

got.length = 0
stub.openBoard()
assert.equal(got[0].pollType, 'board')
assert.equal(parseServerMessage(JSON.stringify(got[0]))?.type, 'poll.state')

got.length = 0
stub.showInstant({ text: 'Back at 11:15', link: 'https://example.test/' })
assert.equal(got[0].type, 'instant.state')
assert.deepEqual({ ...got[0].slide, shownAt: 0 }, { kind: 'text', text: 'Back at 11:15', link: 'https://example.test/', shownAt: 0 })
stub.clearInstant()
assert.deepEqual(got.at(-1), { type: 'instant.state', slide: null })

// Audience messages are acknowledged under their own submission id.
const [vote] = stub.handle(send, JSON.stringify({ type: 'vote.submit', submissionId: 'vote-12345', pollId: 'p1', choice: 'o2' }))
assert.deepEqual(vote, { type: 'vote.ack', submissionId: 'vote-12345', pollId: 'p1', status: 'confirmed', choice: 'o2' })
assert.equal(stub.handle(send, JSON.stringify({ type: 'reaction.send', submissionId: 'react-1234', reaction: 'agree', slideId: 'a', tMs: 1 }))[0].type, 'reaction.ack')
assert.equal(stub.handle(send, JSON.stringify({ type: 'question.submit', submissionId: 'quest-1234', text: 'Why?', slideId: 'a', tMs: 1 }))[0].type, 'question.ack')
const [card] = stub.handle(send, JSON.stringify({ type: 'card.add', submissionId: 'card-12345', pollId: 'b1', text: 'Idea', column: 'keep' }))
assert.equal(card.type, 'card.ack'); assert.equal(card.status, 'confirmed'); assert.equal(card.submissionId, 'card-12345')
assert.deepEqual(stub.handle(send, 'not json'), [])
assert.deepEqual(stub.handle(send, JSON.stringify({ type: 'nonsense' })), [])

// A vote on an open poll updates its tallies for every page.
stub.openPoll()
const liveId = got.at(-1).pollId
got.length = 0
stub.handle(send, JSON.stringify({ type: 'vote.submit', submissionId: 'vote-23456', pollId: liveId, choice: ['x1', 'x2'] }))
const tallied = got.find((m) => m.type === 'poll.state')
assert.deepEqual(tallied.tallies, { x1: 1, x2: 1 })
assert.equal(tallied.responseCount, 1)
assert.equal(parseServerMessage(JSON.stringify(tallied))?.type, 'poll.state')

// Ending live closes every socket, clears polls and the instant slide, and discovery says not live.
got.length = 0
stub.endLive()
assert.deepEqual(got, [{ type: 'session.closed', reason: 'ended' }])
assert.deepEqual(stub.discovery(), { live: false })
assert.deepEqual(stub.state().polls, [])

// A disconnected socket gets nothing more.
const lateGot = []
const off = stub.connect((raw) => lateGot.push(raw))
off(); stub.startLive(); stub.goToSlide(1)
assert.equal(lateGot.length, 1, 'only the hello arrived')
console.log('local-live-stub: ok')
