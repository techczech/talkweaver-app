// The board on the audience page without a browser (ticket 03, ADR-0032): the pure audience board
// module (what a board's poll.state and a phone's snapshot may carry, the tabs and the column's
// list, the box's states, every refusal's sentence) and the follow client's card queue, which is the
// reaction queue's own (first in first out over one socket, one at a time, each waiting for its
// ack; a refusal stores nothing, so it is dropped and shown, never retried by the client; a card
// typed offline waits on the device across a reload). The panel on the real page is
// audience-board-dom.test.mjs; the whole path to a presenter is test-board-cards-live.mjs.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  audienceBoardIcons, audienceBoardRuntimeSource, boardCardsLeft, boardChars, boardClip, boardColumnList, boardColumnTabs,
  boardComposerState, boardRefusal, boardSentNote, normaliseBoardPoll, normaliseCardAck, normaliseOwnBoards,
} from '../compiler/assets/runtime/audience-board.js'
import { createAudienceFollowClient, liveFollowRuntimeSource, normalisePollState, parseServerMessage } from '../compiler/assets/runtime/live-follow.js'

// ── The icons are lucide's own ───────────────────────────────────────────────────────────────
const lucide = JSON.parse(readFileSync(new URL('../compiler/assets/icons/lucide.json', import.meta.url), 'utf8'))
for (const [name, body] of Object.entries(audienceBoardIcons())) assert.equal(body, lucide[name]?.body, `icon ${name} matches the vendored lucide set`)

// ── Length as people count it ────────────────────────────────────────────────────────────────
assert.equal(boardChars('More time'), 9)
assert.equal(boardChars('Great 👍'), 7, 'an emoji is one character')
assert.equal(boardChars(undefined), 0)
assert.equal(boardClip('abcdef', 4), 'abcd')
assert.equal(boardClip('ab👍cd', 3), 'ab👍', 'a cut never splits an emoji')
assert.equal(boardClip('abc', 10), 'abc')

// ── A board's poll.state as the page accepts it ──────────────────────────────────────────────
const settings = { limit: 24, cardChars: 140, cardsPerPhone: 5, names: false, closesAfterDays: 7 }
const state = () => ({
  type: 'poll.state', pollId: 'poll-b', slideId: 'slide-b', pollType: 'board', question: 'What should we keep, change, try?',
  options: [{ optionId: 'keep', label: 'Keep' }, { optionId: 'change', label: 'Change' }, { optionId: 'try', label: 'Try' }],
  visibility: 'live', open: true, revealed: false,
  board: { ...settings, instructions: 'Add one idea per card.', example: 'More time to try things', hints: { keep: 'What worked?', change: 'What should differ?' } },
  boardState: {
    frozen: false, limit: 24, release: { extra: 0, all: false, groupsOnly: false, columns: {} }, entries: 4, shown: 4, waiting: 1, cardCount: 6,
    cards: [
      { cardId: 'card-1', column: 'keep', text: 'More time for hands-on', acceptedAt: 100, group: 1 },
      { cardId: 'card-2', column: 'keep', text: 'Hands-on time', acceptedAt: 110, group: 1 },
      { cardId: 'card-3', column: 'keep', text: 'Small tables', acceptedAt: 120 },
      { cardId: 'card-4', column: 'keep', text: 'Real examples', acceptedAt: 130 },
      { cardId: 'card-5', column: 'keep', text: 'Late idea', acceptedAt: 140, waiting: true },
      { cardId: 'card-6', column: 'change', text: 'Shorter breaks', acceptedAt: 90 },
    ],
    groups: [{ n: 1, column: 'keep', cardIds: ['card-1', 'card-2'], count: 2 }],
    columns: [
      { columnId: 'keep', onScreen: [{ group: 1 }, { cardId: 'card-4' }, { cardId: 'card-3' }], waiting: 1, cards: 5 },
      { columnId: 'change', onScreen: [{ cardId: 'card-6' }], waiting: 0, cards: 1 },
      { columnId: 'try', onScreen: [], waiting: 0, cards: 0 },
    ],
    entries: 4,
  },
})
const viaPage = (m) => { const p = normalisePollState(m); const b = p && normaliseBoardPoll(p); return b ? { ...p, ...b } : null }
const accepted = viaPage(state())
assert.ok(accepted && accepted.pollType === 'board' && accepted.slideId === 'slide-b', 'a board poll.state is accepted (it used to be dropped)')
assert.equal(accepted.board.instructions, 'Add one idea per card.')
assert.deepEqual(accepted.board.hints, { keep: 'What worked?', change: 'What should differ?' })
assert.equal(accepted.boardState.cards.length, 6)
assert.equal('tallies' in accepted || 'responses' in accepted, false, 'a board carries cards, never votes')
assert.equal(JSON.stringify(parseServerMessage(JSON.stringify(state()))).includes('Shorter breaks'), true, 'parseServerMessage carries it')
const bare = state(); delete bare.boardState
assert.ok(viaPage(bare) && !viaPage(bare).boardState, 'a board that has no cards yet is still a board')
assert.equal(normaliseBoardPoll({ ...state(), board: undefined }), null, 'a board with no settings is not a board')
assert.equal(normaliseBoardPoll({ ...state(), board: { ...settings, cardChars: 0 } }), null)
assert.equal(normaliseBoardPoll({ ...state(), board: { ...settings, limit: 0 } }), null)
assert.equal(normaliseBoardPoll({ ...state(), board: { ...settings, names: 'yes' } }), null)
assert.equal(normaliseBoardPoll({ ...state(), board: { ...settings, hints: { keep: 3 } } }), null)
// Nothing presenter-only is ever shown: the whole board is refused, as the worker's own audience parser does.
for (const extra of [{ hidden: true }, { name: 'Sam' }, { fromGroup: 2 }, { touched: true }]) {
  const leaky = state()
  leaky.boardState.cards[2] = { ...leaky.boardState.cards[2], ...extra }
  assert.equal(viaPage(leaky), null, `a card carrying ${Object.keys(extra)[0]} makes the board invalid on an audience page`)
}

// ── The phone's own cards from its snapshot ──────────────────────────────────────────────────
assert.deepEqual(normaliseOwnBoards({
  myCards: [{ pollId: 'poll-b', cardId: 'card-3', column: 'keep', text: 'Small tables', sorted: false, waiting: false }, { pollId: 3 }],
  myBoards: [{ pollId: 'poll-b', cardsUsed: 2, cardsPerPhone: 5 }, { pollId: 'poll-x', cardsUsed: -1, cardsPerPhone: 5 }],
}), {
  myCards: [{ pollId: 'poll-b', cardId: 'card-3', column: 'keep', text: 'Small tables', sorted: false, waiting: false }],
  myBoards: [{ pollId: 'poll-b', cardsUsed: 2, cardsPerPhone: 5 }],
}, 'malformed entries are dropped')
assert.deepEqual(normaliseOwnBoards({}), { myCards: [], myBoards: [] })

// ── The ack ──────────────────────────────────────────────────────────────────────────────────
assert.deepEqual(normaliseCardAck({ type: 'card.ack', submissionId: 'sub-12345678', pollId: 'poll-b', status: 'confirmed', cardId: 'card-7', cardsUsed: 3 }),
  { submissionId: 'sub-12345678', pollId: 'poll-b', status: 'confirmed', cardId: 'card-7', cardsUsed: 3 })
assert.deepEqual(normaliseCardAck({ type: 'card.ack', submissionId: 'sub-12345678', pollId: '', status: 'rejected', error: 'board_not_found' }),
  { submissionId: 'sub-12345678', pollId: '', status: 'rejected', error: 'board_not_found' }, 'a refusal for a board that was not named still reads')
assert.equal(normaliseCardAck({ type: 'card.ack', submissionId: 'short', pollId: 'p', status: 'confirmed' }), null)
assert.equal(normaliseCardAck({ type: 'question.ack', submissionId: 'sub-12345678', pollId: 'p', status: 'confirmed' }), null)

// ── The tabs and the chosen column's list ────────────────────────────────────────────────────
assert.deepEqual(boardColumnTabs(accepted), [
  { id: 'keep', label: 'Keep', hint: 'What worked?', count: 5 },
  { id: 'change', label: 'Change', hint: 'What should differ?', count: 1 },
  { id: 'try', label: 'Try', hint: '', count: 0 },
], 'a tab per column with its hint and its count')
assert.equal(boardColumnTabs(bare).every((tab) => tab.count === 0), true)
const keep = boardColumnList(accepted, 'keep', new Set(['card-3']))
assert.equal(keep.total, 5)
assert.deepEqual(keep.entries.map((entry) => entry.key), ['group-1', 'card-5', 'card-4', 'card-3'], 'groups first, then singles newest first; a waiting card is on the phone all the same')
assert.deepEqual(keep.entries[0], { key: 'group-1', group: 1, count: 2, text: 'More time for hands-on', cardId: null, mine: false, sorted: true, waiting: false }, 'a group shows its number, count and the card the others were merged onto')
assert.equal(keep.entries.find((entry) => entry.key === 'card-3').mine, true, 'the phone marks its own card')
assert.equal(keep.entries.find((entry) => entry.key === 'card-5').waiting, true)
assert.equal(boardColumnList(accepted, 'keep', ['card-1']).entries[0].mine, true, 'a group holding your card is yours, and sorted (not editable)')
assert.deepEqual(boardColumnList(accepted, 'try', []).entries, [])
{
  // Ticket 05 (D13): the presenter's wording for a group shows on the phone in place of its first card.
  const worded = state(); worded.boardState.groups[0].label = 'Hands-on time'
  const wordedPoll = normaliseBoardPoll(worded)
  assert.equal(boardColumnList(wordedPoll, 'keep', []).entries[0].text, 'Hands-on time', 'a group shows its wording on the phone')
  const badLabel = state(); badLabel.boardState.groups[0].label = 7
  assert.equal(normaliseBoardPoll(badLabel), null, 'a wording that is not text makes the board unreadable, as any other bad field')
}
assert.deepEqual(boardColumnList(bare, 'keep', []), { total: 0, entries: [] })
{
  const many = state()
  many.boardState.groups = [{ n: 2, column: 'keep', cardIds: ['card-3'], count: 1 }, { n: 1, column: 'keep', cardIds: ['card-1', 'card-2', 'card-4'], count: 3 }, { n: 3, column: 'keep', cardIds: ['card-5', 'card-6'], count: 2 }]
  many.boardState.cards = many.boardState.cards.map((card) => ({ ...card, ...(card.group ? { group: undefined } : {}) })).map(({ group, ...rest }) => rest)
  const list = boardColumnList(viaPage(many), 'keep', [])
  assert.deepEqual(list.entries.filter((entry) => entry.group !== null).map((entry) => entry.group), [1, 3, 2], 'the largest group first, ties by number')
}

// ── What the box offers ──────────────────────────────────────────────────────────────────────
assert.equal(boardCardsLeft(settings, 2, 1), 2)
assert.equal(boardCardsLeft(settings, 9, 0), 0, 'never below none')
assert.equal(boardComposerState(accepted, { cardsUsed: 0, queued: 0 }), 'open')
assert.equal(boardComposerState(accepted, { cardsUsed: 5, queued: 0 }), 'maxcards', 'a hidden card counts: the box closes at the cap')
assert.equal(boardComposerState(accepted, { cardsUsed: 3, queued: 2 }), 'maxcards', 'cards waiting in the queue count too')
assert.equal(boardComposerState(accepted, { cardsUsed: 5, queued: 0, editing: true }), 'open', 'changing a card you have is not adding one')
assert.equal(boardComposerState({ ...accepted, open: false }, { cardsUsed: 0 }), 'closed')
assert.equal(boardComposerState({ ...accepted, boardState: { ...accepted.boardState, frozen: true } }, { cardsUsed: 0 }), 'frozen')
assert.equal(boardComposerState({ ...accepted, open: false, boardState: { ...accepted.boardState, frozen: true } }, { cardsUsed: 0 }), 'frozen', 'a final board says final')
assert.equal(boardComposerState({ ...accepted, open: false }, { cardsUsed: 0, editing: true }), 'closed', 'nothing is changed on a closed board')

// ── Refusals are said plainly; nothing says a card was hidden ─────────────────────────────────
assert.match(boardRefusal('card_too_long', { max: 100 }).text, /100 characters/)
assert.match(boardRefusal('card_limit_reached').text, /most cards one phone can add/)
assert.match(boardRefusal('board_closed').text, /closed to new cards/)
assert.match(boardRefusal('board_frozen').text, /final/)
assert.match(boardRefusal('card_sorted').text, /sorted this card into a group/)
assert.equal(boardRefusal('card_not_found').text, 'That card is no longer on the board.')
for (const error of ['board_closed', 'board_frozen', 'card_limit_reached', 'card_sorted', 'card_not_found', 'board_full', 'card_too_long']) {
  assert.equal(boardRefusal(error).retry, false, `${error} is shown and not offered again`)
  assert.doesNotMatch(boardRefusal(error).text, /hid|hidden|moderat/i, `${error} never says a card was hidden`)
}
for (const error of ['storage_failed', 'no_answer', 'protocol_error', 'not_kept', undefined]) assert.equal(boardRefusal(error).retry, true)
assert.match(boardRefusal('not_kept', { phone: true }).text, /phone/)
assert.equal(boardSentNote('add', 'Keep', false), 'Sent to Keep. It is on the screen now.')
assert.equal(boardSentNote('add', 'Keep', true), 'Sent to Keep. It is on the board soon.', 'a card the speaker has not released is on the board soon')
assert.match(boardSentNote('edit', 'Keep', false), /Saved/)
assert.match(boardSentNote('withdraw', 'Keep', false), /Withdrawn/)

// ── The runtime source embeds and defines what the page calls ─────────────────────────────────
const embedded = liveFollowRuntimeSource()
assert.ok(embedded.includes('function createAudienceBoard') && embedded.includes('function boardColumnList') && embedded.includes('function normaliseCardAck'), 'the page script carries the panel')
assert.ok(audienceBoardRuntimeSource().includes('createAudienceBoard'))
assert.doesNotThrow(() => new Function(embedded), 'the embedded runtime parses')
assert.doesNotMatch(readFileSync(new URL('../compiler/assets/runtime/audience-board.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, ''), /(^|[^.\w])(eval|Function)\(|document\.write|insertAdjacentHTML/, 'no dynamic code')

// ── The client's queue, with cards in it ─────────────────────────────────────────────────────
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
  feedback() { return this.sent.filter((m) => /^(reaction\.send|question\.submit|card\.)/.test(m.type)) }
}
function harness(storage = memory(), snapshot = {}) {
  const sockets = []
  const cards = [], questions = [], own = []
  const client = createAudienceFollowClient({
    baseUrl: 'http://localhost:8787', sessionId: 's1', participantId: 'p1', storage,
    createSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket },
    schedule: () => 1, cancelSchedule: () => {},
    onCardStatus: (receipt) => cards.push(receipt), onQuestionStatus: (receipt) => questions.push(receipt),
    onBoardSnapshot: (value) => own.push(value),
  })
  const synchronise = (socket) => {
    socket.open()
    socket.message({ type: 'session.hello', protocol: 2, expiresAt: Date.now() + 60000 })
    const sync = socket.sent.find((m) => m.type === 'session.sync')
    socket.message({ type: 'session.snapshot', protocol: 2, syncId: sync.syncId, sessionId: 's1', expiresAt: Date.now() + 60000, slideState: null, polls: [state()], receipts: [], ...snapshot })
  }
  return { client, sockets, cards, questions, own, synchronise, storage }
}
const cack = (socket, message, status = 'confirmed', extra = {}) => socket.message({ type: 'card.ack', submissionId: message.submissionId, pollId: message.pollId, status, ...extra })
const QUEUE_KEY = 'talkweaver:live-reactions:s1'
const add = (extra = {}) => ({ op: 'add', pollId: 'poll-b', column: 'keep', text: 'More time to try things', slideId: 'slide-b', tMs: 5000, ...extra })

// The messages the worker gets, one at a time, each waiting for its ack; the receipt carries the card and the allowance.
{
  const h = harness(memory(), { myCards: [{ pollId: 'poll-b', cardId: 'card-3', column: 'keep', text: 'Small tables', sorted: false, waiting: false }], myBoards: [{ pollId: 'poll-b', cardsUsed: 1, cardsPerPhone: 5 }] })
  h.synchronise(h.sockets[0])
  assert.deepEqual(h.own[0], { myCards: [{ pollId: 'poll-b', cardId: 'card-3', column: 'keep', text: 'Small tables', sorted: false, waiting: false }], myBoards: [{ pollId: 'poll-b', cardsUsed: 1, cardsPerPhone: 5 }] }, 'the snapshot hands over the phone\'s own cards and allowance')
  const a = h.client.sendCard(add({ text: '  More time to try things  ', name: '  Sam  ' }))
  const b = h.client.sendCard({ op: 'edit', pollId: 'poll-b', cardId: 'card-3', text: 'Small tables, please', slideId: 'slide-b', tMs: 5100 })
  const c = h.client.sendCard({ op: 'withdraw', pollId: 'poll-b', cardId: 'card-3', slideId: 'slide-b', tMs: 5200 })
  assert.ok(a && b && c && new Set([a, b, c]).size === 3)
  assert.equal(h.client.pendingCards().length, 3, 'the queue lists the cards it holds')
  assert.deepEqual(h.sockets[0].feedback(), [{ type: 'card.add', submissionId: a, pollId: 'poll-b', column: 'keep', text: 'More time to try things', name: 'Sam' }], 'one at a time; trimmed; no local bookkeeping')
  cack(h.sockets[0], { submissionId: b, pollId: 'poll-b' })
  assert.equal(h.sockets[0].feedback().length, 1, 'an ack for something else moves nothing')
  cack(h.sockets[0], { submissionId: a, pollId: 'poll-b' }, 'confirmed', { cardId: 'card-9', cardsUsed: 2 })
  assert.deepEqual(h.sockets[0].feedback().slice(1), [{ type: 'card.edit', submissionId: b, pollId: 'poll-b', cardId: 'card-3', text: 'Small tables, please' }])
  cack(h.sockets[0], { submissionId: b, pollId: 'poll-b' }, 'confirmed', { cardId: 'card-3', cardsUsed: 2 })
  assert.deepEqual(h.sockets[0].feedback().slice(2), [{ type: 'card.withdraw', submissionId: c, pollId: 'poll-b', cardId: 'card-3' }], 'first in, first out')
  cack(h.sockets[0], { submissionId: c, pollId: 'poll-b' }, 'confirmed', { cardId: 'card-3', cardsUsed: 2 })
  assert.deepEqual(h.cards.map((x) => [x.submissionId, x.status, x.item.op, x.cardId ?? null, x.cardsUsed ?? null]), [[a, 'confirmed', 'add', 'card-9', 2], [b, 'confirmed', 'edit', 'card-3', 2], [c, 'confirmed', 'withdraw', 'card-3', 2]], 'the receipts go to the panel with the item, the card and the allowance')
  assert.equal(h.questions.length, 0, 'and not to the question box')
  assert.equal(h.storage.getItem(QUEUE_KEY), null, 'a drained queue leaves nothing stored')
  assert.equal(h.client.pendingCards().length, 0)
}

// A card that cannot be a card is not queued.
{
  const h = harness()
  h.synchronise(h.sockets[0])
  for (const bad of [null, {}, add({ text: '   ' }), add({ column: '' }), add({ pollId: '' }), add({ op: 'shout' }), { op: 'edit', pollId: 'poll-b', cardId: '', text: 'x', slideId: 's', tMs: 1 },
    { op: 'edit', pollId: 'poll-b', cardId: 'card-1', text: ' ', slideId: 's', tMs: 1 }, { op: 'withdraw', pollId: 'poll-b', slideId: 's', tMs: 1 }, add({ tMs: 'now' })]) {
    assert.equal(h.client.sendCard(bad), false, JSON.stringify(bad))
  }
  assert.equal(h.sockets[0].feedback().length, 0)
  h.client.sendCard(add({ name: '   ' }))
  assert.equal('name' in h.sockets[0].feedback()[0], false, 'a blank name is left out')
}

// A refusal stores nothing: it is shown, dropped from the queue, and the next item goes.
{
  const h = harness()
  h.synchronise(h.sockets[0])
  const a = h.client.sendCard(add())
  const b = h.client.sendCard(add({ text: 'Second' }))
  cack(h.sockets[0], { submissionId: a, pollId: 'poll-b' }, 'rejected', { error: 'board_closed' })
  assert.deepEqual([h.cards[0].status, h.cards[0].error, h.cards[0].item.text], ['rejected', 'board_closed', 'More time to try things'])
  assert.deepEqual(h.sockets[0].feedback().map((m) => m.submissionId), [a, b], 'the refusal is not retried by the client; the next card goes')
  assert.equal(h.client.pendingCards().length, 1)
}

// Offline: kept on the device, sent once on reconnect, first in first out, and a reload keeps them.
{
  const storage = memory()
  const h = harness(storage)
  const a = h.client.sendCard(add({ text: 'First' }))
  const b = h.client.sendCard(add({ text: 'Second', tMs: 5100 }))
  assert.ok(a && b)
  assert.equal(h.sockets[0].feedback().length, 0, 'nothing is sent before the socket is live')
  assert.equal(JSON.parse(storage.getItem(QUEUE_KEY)).items.length, 2, 'both are kept on the device')
  assert.equal(JSON.parse(storage.getItem(QUEUE_KEY)).items[0].kind, 'card')
  const reloaded = harness(storage)
  reloaded.synchronise(reloaded.sockets[0])
  assert.deepEqual(reloaded.client.pendingCards().map((item) => item.text), ['First', 'Second'], 'the reloaded page knows what waits')
  assert.deepEqual(reloaded.sockets[0].feedback().map((m) => m.text), ['First'], 'the reloaded page sends the kept card first')
  cack(reloaded.sockets[0], { submissionId: a, pollId: 'poll-b' }, 'confirmed', { cardId: 'card-1', cardsUsed: 1 })
  cack(reloaded.sockets[0], { submissionId: b, pollId: 'poll-b' }, 'confirmed', { cardId: 'card-2', cardsUsed: 2 })
  assert.deepEqual(reloaded.sockets[0].feedback().map((m) => m.text), ['First', 'Second'])
  assert.deepEqual(reloaded.cards.map((x) => x.item.text), ['First', 'Second'], 'a card sent before a reload is answered to the reloaded page')
  assert.equal(storage.getItem(QUEUE_KEY), null)
}

// Cards, reactions and questions share one order.
{
  const h = harness()
  h.synchronise(h.sockets[0])
  const r = h.client.sendReaction({ reaction: 'puzzled', slideId: 'slide-a', tMs: 1000 })
  const c = h.client.sendCard(add())
  const q = h.client.sendQuestion({ text: 'Why?', slideId: 'slide-b', tMs: 6000 })
  assert.deepEqual(h.sockets[0].feedback().map((m) => m.type), ['reaction.send'])
  h.sockets[0].message({ type: 'reaction.ack', submissionId: r, status: 'confirmed' })
  assert.deepEqual(h.sockets[0].feedback().map((m) => m.type), ['reaction.send', 'card.add'])
  cack(h.sockets[0], { submissionId: c, pollId: 'poll-b' })
  h.sockets[0].message({ type: 'question.ack', submissionId: q, status: 'confirmed' })
  assert.deepEqual(h.sockets[0].feedback().map((m) => m.type), ['reaction.send', 'card.add', 'question.submit'], 'first in, first out across all three kinds')
}

// A dropped socket before the ack: the same submission id goes again on the next socket (the worker answers from its receipt).
{
  const h = harness()
  h.synchronise(h.sockets[0])
  h.client.sendCard(add())
  h.sockets[0].drop()
  assert.equal(h.cards.length, 0, 'a dropped socket is not an answer')
  assert.equal(h.client.pendingCards().length, 1, 'the card is still waiting')
}

// A worker that does not take cards answers with a protocol error: the item is dropped with that reason, never blocks the queue.
{
  const h = harness()
  h.synchronise(h.sockets[0])
  const a = h.client.sendCard(add())
  h.sockets[0].message({ type: 'protocol.error', error: 'invalid_or_inert_message' })
  assert.deepEqual([h.cards[0].submissionId, h.cards[0].status, h.cards[0].error], [a, 'rejected', 'protocol_error'])
}

console.log('audience-board: all checks passed')
