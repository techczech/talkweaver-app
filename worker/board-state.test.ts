import { describe, expect, test } from 'bun:test'
import { BOARD_LIMITS, type BoardSettings, type BoardStateView, type PresenterBoardMessage } from './board-protocol'
import { acceptCard, applyBoardOperation, boardRowSize, boardView, emptyBoard, ensureBoard, normaliseBoard, ownBoardAllowances, ownBoardCards, seedBoard, seedCapacity, type CardSubmission } from './board-state'
import { parsePollDefinition, type PollDefinition } from './protocol'
import { applyPollOperation } from './recovery-state'
import { closePoll, createSession, openPoll, pollStateFor, voteInPoll, type StoredLiveSession } from './session-state'

const COLUMNS = ['keep', 'change', 'try']

function definition(board: Partial<BoardSettings> = {}): PollDefinition {
  const parsed = parsePollDefinition({ pollId: 'poll-board', slideId: 'slide-board', type: 'board', question: 'What should we keep, change, try?',
    visibility: 'live', options: COLUMNS.map((optionId) => ({ optionId, label: optionId[0].toUpperCase() + optionId.slice(1) })), board })
  if (!parsed) throw new Error('fixture definition must parse')
  return parsed
}

function setup(board: Partial<BoardSettings> = {}) {
  const session = createSession({ sessionId: 'session-board', shortId: 'abcd', talkSlug: 'talk', createdAt: 0, expiresAt: 60_000 })
  openPoll(session, definition(board))
  return session
}

const poll = (session: StoredLiveSession) => session.polls['poll-board']
const store = (session: StoredLiveSession) => ensureBoard(session, poll(session))
let counter = 0
function add(session: StoredLiveSession, participant: string, column: string, text: string, extra: { name?: string; submissionId?: string } = {}) {
  const submission: CardSubmission = { kind: 'card.add', submissionId: extra.submissionId ?? `submission-${++counter}`,
    input: { pollId: 'poll-board', column, text, ...(extra.name ? { name: extra.name } : {}) } }
  return acceptCard(store(session), poll(session), participant, submission, 1_000 + counter)
}
function edit(session: StoredLiveSession, participant: string, cardId: string, text: string) {
  return acceptCard(store(session), poll(session), participant, { kind: 'card.edit', submissionId: `submission-${++counter}`,
    input: { pollId: 'poll-board', cardId, text } }, 5_000)
}
function withdraw(session: StoredLiveSession, participant: string, cardId: string) {
  return acceptCard(store(session), poll(session), participant, { kind: 'card.withdraw', submissionId: `submission-${++counter}`,
    input: { pollId: 'poll-board', cardId } }, 5_000)
}
function op(session: StoredLiveSession, action: Record<string, unknown>) {
  applyBoardOperation(store(session), poll(session), { pollId: 'poll-board', ...action } as PresenterBoardMessage)
}
function refusal(session: StoredLiveSession, action: Record<string, unknown>): string {
  try { op(session, action); return 'applied' } catch (error) { return (error as Error).message }
}
const view = (session: StoredLiveSession, role: 'presenter' | 'audience' = 'presenter'): BoardStateView =>
  boardView(store(session), COLUMNS, role)

describe('board definition', () => {
  test('defaults fill every setting; a board takes cards, never votes', () => {
    expect(definition().board).toEqual({ limit: 24, cardChars: 140, cardsPerPhone: 5, names: false, closesAfterDays: 7 })
    expect(definition({ limit: null, cardChars: 60, cardsPerPhone: 1, names: true, closesAfterDays: 30, instructions: ' One idea per card. ',
      example: 'More time for hands-on', hints: { keep: 'What worked' } }).board).toEqual({ limit: null, cardChars: 60, cardsPerPhone: 1,
      names: true, closesAfterDays: 30, instructions: 'One idea per card.', example: 'More time for hands-on', hints: { keep: 'What worked' } })
    const base = { pollId: 'p', type: 'board', question: 'Q', visibility: 'live', options: [{ optionId: 'a', label: 'A' }] }
    expect(parsePollDefinition({ ...base, board: { hints: { unknown: 'x' } } })).toBeNull()
    expect(parsePollDefinition({ ...base, board: { limit: 0 } })).toBeNull()
    expect(parsePollDefinition({ ...base, board: { names: 'yes' } })).toBeNull()
    expect(parsePollDefinition({ ...base, options: [] })).toBeNull()
    expect(parsePollDefinition({ ...base, type: 'single', board: {} })).toBeNull()
    const session = setup()
    expect(() => voteInPoll(session, 'vote:x', 'poll-board', 'keep')).toThrow()
  })
})

describe('audience cards', () => {
  test('add, retry, edit and withdraw own cards only, until sorted into a group', () => {
    const session = setup()
    const first = add(session, 'alice', 'keep', '  More time for hands-on  ', { submissionId: 'submission-alice-1' })
    expect(first.ack).toEqual({ type: 'card.ack', submissionId: 'submission-alice-1', pollId: 'poll-board', status: 'confirmed', cardId: 'card-1', cardsUsed: 1 })
    expect(view(session).cards[0].text).toBe('More time for hands-on')
    // A retry repeats the receipt and stores nothing; the same id with a different card is a conflict.
    const retry = add(session, 'alice', 'keep', '  More time for hands-on  ', { submissionId: 'submission-alice-1' })
    expect(retry).toEqual({ fresh: false, stored: false, ack: first.ack })
    expect(add(session, 'alice', 'try', 'Other', { submissionId: 'submission-alice-1' }).ack.error).toBe('submission_id_conflict')
    expect(view(session).cardCount).toBe(1)
    // Another phone may use the same submission id: receipts are per participant.
    expect(add(session, 'bob', 'change', 'Shorter breaks', { submissionId: 'submission-alice-1' }).ack.cardId).toBe('card-2')

    expect(edit(session, 'alice', 'card-1', 'Much more time for hands-on').ack.status).toBe('confirmed')
    expect(view(session).cards[0].text).toBe('Much more time for hands-on')
    expect(edit(session, 'bob', 'card-1', 'Taken over').ack.error).toBe('card_not_found')
    expect(withdraw(session, 'bob', 'card-1').ack.error).toBe('card_not_found')
    op(session, { type: 'board.merge', source: { cardId: 'card-2' }, target: { cardId: 'card-1' } })
    expect(edit(session, 'alice', 'card-1', 'Too late').ack.error).toBe('card_sorted')
    expect(withdraw(session, 'bob', 'card-2').ack.error).toBe('card_sorted')
    add(session, 'carol', 'try', 'Pair work')
    expect(withdraw(session, 'carol', 'card-3').ack).toMatchObject({ status: 'confirmed', cardId: 'card-3' })
    expect(view(session).cards.map((card) => card.cardId)).toEqual(['card-1', 'card-2'])
    // Withdrawn numbers are not reused.
    expect(add(session, 'carol', 'try', 'Pair work again').ack.cardId).toBe('card-4')
  })

  test('length, per-phone, column, closed and frozen limits refuse without storing a receipt', () => {
    const session = setup({ cardChars: 10, cardsPerPhone: 3 })
    expect(add(session, 'alice', 'keep', 'x'.repeat(11)).ack.error).toBe('card_too_long')
    expect(add(session, 'alice', 'keep', '😀'.repeat(10)).ack.status).toBe('confirmed', 'an emoji counts as one character')
    expect(add(session, 'alice', 'nowhere', 'Hello').ack.error).toBe('unknown_column')
    add(session, 'alice', 'keep', 'Two')
    add(session, 'alice', 'keep', 'Three')
    expect(add(session, 'alice', 'keep', 'Four').ack.error).toBe('card_limit_reached')
    expect(add(session, 'bob', 'keep', 'Four').ack.status).toBe('confirmed', 'one phone never uses up another phone’s cards')
    // Hiding keeps the slot used; withdrawing frees it.
    op(session, { type: 'board.hide', target: { cardId: 'card-1' }, hidden: true })
    expect(add(session, 'alice', 'keep', 'Four').ack.error).toBe('card_limit_reached')
    withdraw(session, 'alice', 'card-2')
    const queued = { submissionId: 'submission-queued' }
    closePoll(session, 'poll-board')
    expect(add(session, 'alice', 'keep', 'Four', queued).ack.error).toBe('board_closed')
    expect(edit(session, 'alice', 'card-3', 'Edited').ack.error).toBe('board_closed')
    openPoll(session, definition({ cardChars: 10, cardsPerPhone: 3 }))
    op(session, { type: 'board.freeze', frozen: true })
    expect(add(session, 'alice', 'keep', 'Four', queued).ack.error).toBe('board_frozen')
    op(session, { type: 'board.freeze', frozen: false })
    // A card refused while the board was closed lands when the phone resends it.
    expect(add(session, 'alice', 'keep', 'Four', queued).ack.status).toBe('confirmed')
  })

  test('names are kept only when the board takes them, and only the presenter sees them', () => {
    const off = setup()
    add(off, 'alice', 'keep', 'Card', { name: 'Alice' })
    expect(view(off).cards[0].name).toBeUndefined()
    const on = setup({ names: true })
    add(on, 'alice', 'keep', 'Card', { name: 'Alice' })
    expect(view(on).cards[0].name).toBe('Alice')
    expect(JSON.stringify(view(on, 'audience'))).not.toContain('Alice')
  })

  test('the row never exceeds the byte cap and one phone cannot fill the board for others', () => {
    const session = setup({ cardChars: 1_000, cardsPerPhone: 100, limit: null })
    let refused = ''
    for (let participant = 0; participant < 20 && !refused; participant++) {
      for (let i = 0; i < 100; i++) {
        const outcome = add(session, `participant-${participant}`, COLUMNS[i % 3], 'é'.repeat(1_000))
        if (outcome.ack.status !== 'confirmed') { refused = outcome.ack.error!; break }
      }
    }
    expect(refused).toBe('board_full')
    expect(boardRowSize(store(session))).toBeLessThanOrEqual(BOARD_LIMITS.boardRowBytes - BOARD_LIMITS.presenterReserveBytes)
    // The presenter's reserve still takes operations on a full board.
    op(session, { type: 'board.merge', source: { cardId: 'card-2' }, target: { cardId: 'card-1' } })
    op(session, { type: 'board.split', group: 1 })
    expect(boardRowSize(store(session))).toBeLessThanOrEqual(BOARD_LIMITS.boardRowBytes)

    // Submissions per participant are capped too (adds, edits and withdrawals).
    const edits = setup()
    add(edits, 'alice', 'keep', 'Card')
    let last = ''
    for (let i = 0; i < BOARD_LIMITS.participantSubmissions; i++) last = edit(edits, 'alice', 'card-1', `Edit ${i}`).ack.error ?? 'ok'
    expect(last).toBe('participant_limit_reached')
    expect(add(edits, 'bob', 'keep', 'Card').ack.status).toBe('confirmed')
  })
})

describe('presenter operations', () => {
  test('merge numbers groups; split retires the number; numbers are never reused', () => {
    const session = setup()
    for (const [who, column, text] of [['a', 'keep', 'One'], ['b', 'keep', 'Two'], ['c', 'change', 'Three'], ['d', 'try', 'Four'], ['e', 'try', 'Five']]) add(session, who, column, text)
    op(session, { type: 'board.merge', source: { cardId: 'card-2' }, target: { cardId: 'card-1' } })
    op(session, { type: 'board.merge', source: { cardId: 'card-3' }, target: { cardId: 'card-1' } })
    expect(view(session).groups).toEqual([{ n: 1, column: 'keep', cardIds: ['card-1', 'card-2', 'card-3'], count: 3 }])
    expect(view(session).cards.find((card) => card.cardId === 'card-3')?.column).toBe('keep', 'a merged card joins the group’s column')
    // Dropping onto a card inside a group merges into that group.
    op(session, { type: 'board.merge', source: { cardId: 'card-4' }, target: { cardId: 'card-2' } })
    expect(view(session).groups[0].count).toBe(4)
    expect(refusal(session, { type: 'board.merge', source: { cardId: 'card-4' }, target: { group: 1 } })).toBe('already_merged')
    op(session, { type: 'board.split', group: 1 })
    expect(view(session).groups).toEqual([])
    expect(view(session).cards.filter((card) => card.fromGroup === 1).map((card) => card.cardId)).toEqual(['card-1', 'card-2', 'card-3', 'card-4'])
    op(session, { type: 'board.merge', source: { cardId: 'card-5' }, target: { cardId: 'card-4' } })
    expect(view(session).groups.map((group) => group.n)).toEqual([2])
    // A group dragged onto another group joins it; its number retires.
    op(session, { type: 'board.merge', source: { cardId: 'card-2' }, target: { cardId: 'card-1' } })
    op(session, { type: 'board.merge', source: { group: 3 }, target: { group: 2 } })
    expect(view(session).groups).toEqual([{ n: 2, column: 'keep', cardIds: ['card-4', 'card-5', 'card-1', 'card-2'], count: 4 }])
    // A card taken out of its group by a move.
    op(session, { type: 'board.merge', source: { cardId: 'card-3' }, target: { group: 2 } })
    op(session, { type: 'board.move', target: { cardId: 'card-3' }, column: 'change' })
    expect(view(session).cards.find((card) => card.cardId === 'card-3')).toMatchObject({ column: 'change', touched: true })
    expect(view(session).cards.find((card) => card.cardId === 'card-3')?.group).toBeUndefined()
    // Moving a whole group keeps its number and count.
    op(session, { type: 'board.move', target: { group: 2 }, column: 'try' })
    expect(view(session).groups).toEqual([{ n: 2, column: 'try', cardIds: ['card-4', 'card-5', 'card-1', 'card-2'], count: 4 }])
    expect(view(session).cards.filter((card) => card.group === 2).every((card) => card.column === 'try')).toBe(true)
    op(session, { type: 'board.merge', source: { cardId: 'card-3' }, target: { cardId: 'card-4' } })
    expect(view(session).groups.map((group) => group.n)).toEqual([2])
    op(session, { type: 'board.split', group: 2 })
    op(session, { type: 'board.merge', source: { cardId: 'card-1' }, target: { cardId: 'card-2' } })
    expect(view(session).groups.map((group) => group.n)).toEqual([4], 'after 1, 2 and 3 retired, the next group is 4')
    // A stored row read back never lowers the counter.
    const reread = normaliseBoard(JSON.parse(JSON.stringify({ ...store(session), nextGroup: 1 })), poll(session).board)
    expect(reread.nextGroup).toBe(5)
  })

  test('refusals change nothing', () => {
    const session = setup()
    add(session, 'a', 'keep', 'One')
    const before = JSON.stringify(store(session))
    expect(refusal(session, { type: 'board.move', target: { cardId: 'card-9' }, column: 'keep' })).toBe('card_not_found')
    expect(refusal(session, { type: 'board.move', target: { cardId: 'card-1' }, column: 'nowhere' })).toBe('unknown_column')
    expect(refusal(session, { type: 'board.split', group: 7 })).toBe('group_not_found')
    expect(refusal(session, { type: 'board.merge', source: { cardId: 'card-1' }, target: { cardId: 'card-1' } })).toBe('already_merged')
    expect(JSON.stringify(store(session))).toBe(before)
    op(session, { type: 'board.freeze', frozen: true })
    expect(refusal(session, { type: 'board.merge', source: { cardId: 'card-1' }, target: { cardId: 'card-2' } })).toBe('board_frozen')
    expect(refusal(session, { type: 'board.move', target: { cardId: 'card-1' }, column: 'try' })).toBe('board_frozen')
    // Hiding is moderation: a rude card noticed after freezing is hidden without unfreezing.
    expect(refusal(session, { type: 'board.hide', target: { cardId: 'card-1' }, hidden: true })).toBe('applied')
    expect(view(session, 'audience').cardCount).toBe(0)
    expect(refusal(session, { type: 'board.hide', target: { cardId: 'card-1' }, hidden: false })).toBe('applied')
    expect(refusal(session, { type: 'board.release', mode: 'all' })).toBe('applied', 'what the screen shows can still change on a frozen board')
  })

  test('hide and put back: hidden cards leave every public view and are kept for the presenter', () => {
    const session = setup({ names: true })
    add(session, 'alice', 'keep', 'Kind card', { name: 'Alice' })
    add(session, 'bob', 'change', 'Unkind card', { name: 'Bob' })
    add(session, 'carol', 'change', 'Another', { name: 'Carol' })
    op(session, { type: 'board.merge', source: { cardId: 'card-3' }, target: { cardId: 'card-2' } })
    op(session, { type: 'board.hide', target: { cardId: 'card-2' }, hidden: true })
    const audience = view(session, 'audience')
    expect(audience.cards.map((card) => card.cardId)).toEqual(['card-1', 'card-3'])
    expect(audience.groups).toEqual([{ n: 1, column: 'change', cardIds: ['card-3'], count: 1 }])
    const text = JSON.stringify(audience)
    for (const secret of ['Unkind', 'Alice', 'Bob', 'Carol', 'participant', 'hidden', 'touched', 'fromGroup']) expect(text).not.toContain(secret)
    expect(view(session).cards.find((card) => card.cardId === 'card-2')).toMatchObject({ hidden: true, name: 'Bob', text: 'Unkind card' })
    expect(ownBoardCards(session, 'bob')).toEqual([], 'a hidden own card leaves the phone silently')
    // Hiding the whole group hides it from the room; putting it back returns both cards.
    op(session, { type: 'board.hide', target: { group: 1 }, hidden: true })
    expect(view(session, 'audience').groups).toEqual([])
    expect(view(session).groups[0]).toEqual({ n: 1, column: 'change', cardIds: ['card-2', 'card-3'], count: 0 })
    // Putting the group back restores only what the group hide took: card 2, hidden on its own, stays hidden.
    op(session, { type: 'board.hide', target: { group: 1 }, hidden: false })
    expect(view(session, 'audience').groups[0]).toEqual({ n: 1, column: 'change', cardIds: ['card-3'], count: 1 })
    expect(ownBoardCards(session, 'bob')).toEqual([])
    // Putting the card back from its own menu shows it.
    op(session, { type: 'board.hide', target: { cardId: 'card-2' }, hidden: false })
    expect(view(session, 'audience').groups[0].count).toBe(2)
    expect(ownBoardCards(session, 'bob')).toEqual([{ pollId: 'poll-board', cardId: 'card-2', column: 'change', text: 'Unkind card', sorted: true, waiting: false }])
    // A card hidden with its group comes back when put back on its own.
    op(session, { type: 'board.hide', target: { group: 1 }, hidden: true })
    op(session, { type: 'board.hide', target: { cardId: 'card-3' }, hidden: false })
    expect(view(session, 'audience').groups[0].cardIds).toEqual(['card-3'])
  })

  test('a merged card takes the target group’s hide: into a hidden group it hides, out of one into a shown group it shows', () => {
    const session = setup()
    for (const [who, text] of [['a', 'One'], ['b', 'Two'], ['c', 'Three'], ['d', 'Four'], ['e', 'Five'], ['f', 'Six']]) add(session, who, 'keep', text)
    op(session, { type: 'board.merge', source: { cardId: 'card-2' }, target: { cardId: 'card-1' } })
    op(session, { type: 'board.hide', target: { group: 1 }, hidden: true })
    // F1: a visible card dropped into the hidden group does not bring the group back to the room.
    op(session, { type: 'board.merge', source: { cardId: 'card-3' }, target: { cardId: 'card-2' } })
    expect(view(session, 'audience').groups).toEqual([])
    expect(view(session, 'audience').cards.map((card) => card.cardId)).toEqual(['card-4', 'card-5', 'card-6'])
    expect(view(session).groups[0]).toEqual({ n: 1, column: 'keep', cardIds: ['card-1', 'card-2', 'card-3'], count: 0 })
    // Putting the group back shows all three.
    op(session, { type: 'board.hide', target: { group: 1 }, hidden: false })
    expect(view(session, 'audience').groups[0].count).toBe(3)
    // F2: a card merged out of a hidden group into a shown group is shown with it.
    op(session, { type: 'board.hide', target: { group: 1 }, hidden: true })
    op(session, { type: 'board.merge', source: { cardId: 'card-5' }, target: { cardId: 'card-4' } })
    op(session, { type: 'board.merge', source: { cardId: 'card-3' }, target: { cardId: 'card-4' } })
    expect(view(session, 'audience').groups).toEqual([{ n: 2, column: 'keep', cardIds: ['card-4', 'card-5', 'card-3'], count: 3 }])
    // A card hidden on its own stays hidden wherever it is merged.
    op(session, { type: 'board.hide', target: { cardId: 'card-6' }, hidden: true })
    op(session, { type: 'board.merge', source: { cardId: 'card-6' }, target: { group: 2 } })
    expect(view(session, 'audience').groups[0].count).toBe(3)
    expect(view(session).cards.find((card) => card.cardId === 'card-6')?.hidden).toBe(true)
  })

  test('merging two groups where one is hidden: the merged cards take the target’s state', () => {
    const shownIntoHidden = setup()
    for (const [who, text] of [['a', 'One'], ['b', 'Two'], ['c', 'Three'], ['d', 'Four']]) add(shownIntoHidden, who, 'keep', text)
    op(shownIntoHidden, { type: 'board.merge', source: { cardId: 'card-2' }, target: { cardId: 'card-1' } })
    op(shownIntoHidden, { type: 'board.merge', source: { cardId: 'card-4' }, target: { cardId: 'card-3' } })
    op(shownIntoHidden, { type: 'board.hide', target: { group: 1 }, hidden: true })
    op(shownIntoHidden, { type: 'board.merge', source: { group: 2 }, target: { group: 1 } })
    expect(view(shownIntoHidden, 'audience').groups).toEqual([])
    expect(view(shownIntoHidden, 'audience').cardCount).toBe(0)
    op(shownIntoHidden, { type: 'board.hide', target: { group: 1 }, hidden: false })
    expect(view(shownIntoHidden, 'audience').groups).toEqual([{ n: 1, column: 'keep', cardIds: ['card-1', 'card-2', 'card-3', 'card-4'], count: 4 }])

    const hiddenIntoShown = setup()
    for (const [who, text] of [['a', 'One'], ['b', 'Two'], ['c', 'Three'], ['d', 'Four']]) add(hiddenIntoShown, who, 'keep', text)
    op(hiddenIntoShown, { type: 'board.merge', source: { cardId: 'card-2' }, target: { cardId: 'card-1' } })
    op(hiddenIntoShown, { type: 'board.merge', source: { cardId: 'card-4' }, target: { cardId: 'card-3' } })
    op(hiddenIntoShown, { type: 'board.hide', target: { group: 2 }, hidden: true })
    op(hiddenIntoShown, { type: 'board.merge', source: { group: 2 }, target: { group: 1 } })
    expect(view(hiddenIntoShown, 'audience').groups).toEqual([{ n: 1, column: 'keep', cardIds: ['card-1', 'card-2', 'card-3', 'card-4'], count: 4 }])
  })

  test('a hidden card still counts towards its phone’s cards, and the phone is told how many it has used', () => {
    const session = setup({ cardsPerPhone: 2 })
    add(session, 'alice', 'keep', 'One')
    expect(add(session, 'alice', 'keep', 'Two').ack.cardsUsed).toBe(2)
    op(session, { type: 'board.hide', target: { cardId: 'card-2' }, hidden: true })
    // The phone's own view: one card listed, two used of two, so its box stays closed.
    expect(ownBoardCards(session, 'alice').map((card) => card.cardId)).toEqual(['card-1'])
    expect(ownBoardAllowances(session, 'alice')).toEqual([{ pollId: 'poll-board', cardsUsed: 2, cardsPerPhone: 2 }])
    expect(JSON.stringify(ownBoardAllowances(session, 'alice'))).not.toContain('hidden')
    expect(add(session, 'alice', 'keep', 'Three').ack.error).toBe('card_limit_reached')
    expect(withdraw(session, 'alice', 'card-1').ack.cardsUsed).toBe(1)
    expect(ownBoardAllowances(session, 'bob')).toEqual([{ pollId: 'poll-board', cardsUsed: 0, cardsPerPhone: 2 }])
  })

  test('a board row read back takes the definition’s limit when it has none of its own', () => {
    for (const limit of [12, null]) {
      const session = setup({ limit })
      expect(store(session).limit).toBe(limit)
      expect(emptyBoard(poll(session).board).limit).toBe(limit)
      const { limit: _dropped, ...row } = JSON.parse(JSON.stringify(store(session)))
      expect(normaliseBoard(row, poll(session).board).limit).toBe(limit)
    }
  })
})

// The drawn busy board (round 2 S3–S7, D6–D12): 61 cards, 10 groups (31 cards) and 30 singles
// arriving Keep, Change, Try in turn, so each column's singles interleave by age.
function busyBoard() {
  const session = setup()
  let phone = 0
  const card = (column: string, text: string) => add(session, `phone-${phone++}`, column, text).ack.cardId!
  const groups: Array<[string, number]> = [['keep', 6], ['change', 4], ['try', 4], ['keep', 3], ['change', 3], ['try', 3], ['keep', 2], ['change', 2], ['try', 2], ['keep', 2]]
  for (const [column, size] of groups) {
    const ids = Array.from({ length: size }, (_, i) => card(column, `${column} group card ${i}`))
    for (const id of ids.slice(1)) op(session, { type: 'board.merge', source: { cardId: id }, target: { cardId: ids[0] } })
  }
  const singles: Record<string, number> = { keep: 12, change: 10, try: 8 }
  for (let i = 0; i < 12; i++) for (const column of COLUMNS) if (i < singles[column]) card(column, `${column} single ${i}`)
  return session
}
const waitingBy = (v: BoardStateView) => Object.fromEntries(v.columns.map((column) => [column.columnId, column.waiting]))

describe('the big-screen view', () => {
  test('limit and waiting as drawn: 24 of 40, next 12, a column groups only, all, back to the limit', () => {
    const session = busyBoard()
    let v = view(session)
    expect([v.cardCount, v.entries, v.shown, v.waiting]).toEqual([61, 40, 24, 16])
    expect(waitingBy(v)).toEqual({ keep: 7, change: 5, try: 4 }, 'D7: “Keep 25 · 7 waiting”')
    expect(v.columns[0].cards).toBe(25)
    // Groups never wait and come first, largest first; then singles, newest first.
    const keep = v.columns[0].onScreen
    expect(keep.slice(0, 4)).toEqual([{ group: 1 }, { group: 4 }, { group: 7 }, { group: 10 }])
    const keepSingles = keep.slice(4).map((entry) => v.cards.find((card) => card.cardId === (entry as { cardId: string }).cardId)!.text)
    expect(keepSingles).toEqual(['keep single 4', 'keep single 3', 'keep single 2', 'keep single 1', 'keep single 0'])
    expect(v.cards.filter((card) => card.waiting).every((card) => card.group === undefined)).toBe(true)

    op(session, { type: 'board.release', mode: 'next', count: 12 })
    v = view(session)
    expect([v.shown, v.waiting]).toEqual([36, 4])
    expect(waitingBy(v)).toEqual({ keep: 3, change: 1, try: 0 })
    op(session, { type: 'board.release', mode: 'groupsOnly', column: 'keep' })
    expect(view(session).shown).toBe(27, 'S7: Keep’s singles leave; nothing else is promoted')
    expect(view(session).columns[0].waiting).toBe(12)
    op(session, { type: 'board.release', mode: 'limit', column: 'keep' })
    op(session, { type: 'board.release', mode: 'all' })
    expect([view(session).shown, view(session).waiting]).toEqual([40, 0])
    op(session, { type: 'board.release', mode: 'limit' })
    expect([view(session).shown, view(session).waiting]).toEqual([24, 16])
    op(session, { type: 'board.release', mode: 'groupsOnly' })
    expect(view(session).shown).toBe(10)
    op(session, { type: 'board.release', mode: 'all', column: 'try' })
    expect(view(session).shown).toBe(18, 'a column’s own “every card” wins over the board’s “groups only”')
  })

  test('“Show next” releases only cards waiting now; new cards wait; oldest waiting go first', () => {
    const session = busyBoard()
    op(session, { type: 'board.release', mode: 'next', count: 12 })
    op(session, { type: 'board.release', mode: 'next', count: 12 })
    expect([view(session).shown, view(session).waiting]).toEqual([40, 0])
    add(session, 'late-phone', 'try', 'A late card')
    const v = view(session)
    expect([v.shown, v.waiting]).toEqual([40, 1], 'the screen never shows more than was released')
    expect(v.cards.at(-1)).toMatchObject({ text: 'A late card', waiting: true })
    // Phones see every card, waiting or not, with the same marks.
    expect(view(session, 'audience').cards.filter((card) => card.waiting).map((card) => card.text)).toEqual(['A late card'])
    expect(ownBoardCards(session, 'late-phone')).toEqual([{ pollId: 'poll-board', cardId: v.cards.at(-1)!.cardId, column: 'try', text: 'A late card', sorted: false, waiting: true }])
  })

  test('a group counts once, and groups are on the screen even past the limit', () => {
    const session = busyBoard()
    op(session, { type: 'board.limit', limit: 12 })
    const v = view(session)
    expect([v.limit, v.shown, v.waiting]).toEqual([12, 12, 28])
    op(session, { type: 'board.limit', limit: 6 })
    expect(view(session).shown).toBe(10, 'ten groups, none waiting, no singles')
    op(session, { type: 'board.limit', limit: null })
    expect(view(session).shown).toBe(40)
  })

  test('poll.state carries the settings and the board: full for the presenter, public for the room', () => {
    const session = setup({ instructions: 'One idea per card.' })
    add(session, 'alice', 'keep', 'Visible')
    add(session, 'bob', 'keep', 'Hidden')
    op(session, { type: 'board.hide', target: { cardId: 'card-2' }, hidden: true })
    const presenter = pollStateFor(session, poll(session), 'presenter')
    const audience = pollStateFor(session, poll(session), 'audience')
    expect(presenter.board?.instructions).toBe('One idea per card.')
    expect(presenter.boardState?.cards.map((card) => card.cardId)).toEqual(['card-1', 'card-2'])
    expect(audience.boardState?.cards.map((card) => card.cardId)).toEqual(['card-1'])
    expect(audience.tallies).toBeUndefined()
  })

  test('operations go through the acknowledged path, idempotent by operation id', () => {
    const session = setup()
    add(session, 'a', 'keep', 'One')
    add(session, 'b', 'keep', 'Two')
    const merge = { type: 'operation' as const, operationId: 'operation-merge-1',
      action: { type: 'board.merge' as const, pollId: 'poll-board', source: { cardId: 'card-2' }, target: { cardId: 'card-1' } } }
    expect(applyPollOperation(session, merge).status).toBe('confirmed')
    expect(applyPollOperation(session, merge)).toEqual({ type: 'operation.ack', operationId: 'operation-merge-1', status: 'confirmed' })
    expect(view(session).groups.map((group) => group.n)).toEqual([1], 'a replayed merge makes no second group')
    const split = { type: 'operation' as const, operationId: 'operation-split-1', action: { type: 'board.split' as const, pollId: 'poll-board', group: 1 } }
    applyPollOperation(session, split)
    expect(applyPollOperation(session, split).status).toBe('confirmed')
    expect(applyPollOperation(session, { type: 'operation', operationId: 'operation-split-2', action: { type: 'board.split', pollId: 'poll-board', group: 1 } }))
      .toMatchObject({ status: 'rejected', error: 'group_not_found' })
    expect(applyPollOperation(session, { type: 'operation', operationId: 'operation-split-1', action: { type: 'board.freeze', pollId: 'poll-board', frozen: true } }))
      .toMatchObject({ status: 'rejected', error: 'operation_id_conflict' })
    expect(applyPollOperation(session, { type: 'operation', operationId: 'operation-no-board', action: { type: 'board.freeze', pollId: 'poll-none', frozen: true } }).status).toBe('rejected')
  })

  test('relabel (D13): the group reads the presenter’s wording on every view; the cards keep theirs; empty clears it', () => {
    const session = setup({ cardChars: 20 })
    add(session, 'a', 'keep', 'More hands-on')
    add(session, 'b', 'keep', 'Hands-on, please')
    op(session, { type: 'board.merge', source: { cardId: 'card-2' }, target: { cardId: 'card-1' } })
    op(session, { type: 'board.relabel', group: 1, text: 'Hands-on time' })
    expect(view(session).groups[0]).toMatchObject({ n: 1, label: 'Hands-on time' })
    expect(view(session, 'audience').groups[0]).toMatchObject({ n: 1, label: 'Hands-on time', count: 2 })
    expect(view(session).cards.map((card) => card.text)).toEqual(['More hands-on', 'Hands-on, please'])
    expect(refusal(session, { type: 'board.relabel', group: 1, text: 'x'.repeat(21) })).toBe('card_too_long')
    expect(refusal(session, { type: 'board.relabel', group: 9, text: 'Nope' })).toBe('group_not_found')
    op(session, { type: 'board.freeze', frozen: true })
    expect(refusal(session, { type: 'board.relabel', group: 1, text: 'Frozen words' })).toBe('board_frozen')
    op(session, { type: 'board.freeze', frozen: false })
    expect(view(session).groups[0].label).toBe('Hands-on time')
    op(session, { type: 'board.relabel', group: 1, text: '' })
    expect(view(session).groups[0].label).toBeUndefined()
    // The wording goes with the number: split retires both.
    op(session, { type: 'board.relabel', group: 1, text: 'Hands-on time' })
    op(session, { type: 'board.split', group: 1 })
    op(session, { type: 'board.merge', source: { cardId: 'card-2' }, target: { cardId: 'card-1' } })
    expect(view(session).groups).toEqual([expect.objectContaining({ n: 2 })])
    expect(view(session).groups[0].label).toBeUndefined()
  })

  test('relabel is idempotent by operation id on the acknowledged path', () => {
    const session = setup()
    add(session, 'a', 'keep', 'One')
    add(session, 'b', 'keep', 'Two')
    op(session, { type: 'board.merge', source: { cardId: 'card-2' }, target: { cardId: 'card-1' } })
    const relabel = { type: 'operation' as const, operationId: 'operation-relabel-1', action: { type: 'board.relabel' as const, pollId: 'poll-board', group: 1, text: 'Both' } }
    expect(applyPollOperation(session, relabel).status).toBe('confirmed')
    op(session, { type: 'board.relabel', group: 1, text: 'Changed since' })
    expect(applyPollOperation(session, relabel)).toEqual({ type: 'operation.ack', operationId: 'operation-relabel-1', status: 'confirmed' })
    expect(view(session).groups[0].label).toBe('Changed since')
    expect(applyPollOperation(session, { ...relabel, action: { ...relabel.action, text: 'Other' } })).toMatchObject({ status: 'rejected', error: 'operation_id_conflict' })
  })

  test('reopening a board keeps its cards, groups and numbers', () => {
    const session = setup()
    add(session, 'a', 'keep', 'One')
    add(session, 'b', 'keep', 'Two')
    op(session, { type: 'board.merge', source: { cardId: 'card-2' }, target: { cardId: 'card-1' } })
    closePoll(session, 'poll-board')
    openPoll(session, definition())
    expect(view(session).groups).toHaveLength(1)
    expect(poll(session).open).toBe(true)
  })
})

describe('a board that opens with seed cards (pre-work answers)', () => {
  const seeded = (seed: unknown, board: Partial<BoardSettings> = {}) => {
    const parsed = parsePollDefinition({ pollId: 'poll-board', slideId: 'slide-board', type: 'board', question: 'Hopes', visibility: 'live', board, seed,
      options: COLUMNS.map((optionId) => ({ optionId, label: optionId })) })
    if (!parsed) throw new Error('fixture definition must parse')
    const session = createSession({ sessionId: 'session-seed', shortId: 'wxyz', talkSlug: 'talk', createdAt: 0, expiresAt: 60_000 })
    openPoll(session, parsed)
    return session
  }
  const texts = (session: StoredLiveSession) => store(session).cards.map((card) => card.text)

  test('the cards are on the board in order, in their column, for the presenter and the audience', () => {
    const session = seeded([{ column: 'keep', text: 'First answer' }, { column: 'try', text: '  Second answer  ' }])
    expect(texts(session)).toEqual(['First answer', 'Second answer'])
    expect(store(session).cards.map((card) => card.column)).toEqual(['keep', 'try'])
    const view = boardView(store(session), COLUMNS, 'audience')
    expect(view.cardCount).toBe(2)
    expect(view.cards.map((card) => card.text)).toEqual(['First answer', 'Second answer'])
  })

  test('the seed is not kept on the stored poll, and nobody owns a seeded card', () => {
    const session = seeded([{ column: 'keep', text: 'Kept once' }])
    expect('seed' in poll(session)).toBe(false)
    expect(ownBoardCards(session, 'someone-else-entirely')).toEqual([])
    const outcome = withdraw(session, 'someone-else-entirely', store(session).cards[0].cardId)
    expect(outcome.stored).toBe(false)
    expect(texts(session)).toEqual(['Kept once'])
  })

  test('a reopened board does not take its seed twice, and cards added later come after', () => {
    const session = seeded([{ column: 'keep', text: 'One' }])
    closePoll(session, 'poll-board')
    openPoll(session, definition())
    add(session, 'p-one', 'keep', 'From the room')
    expect(texts(session)).toEqual(['One', 'From the room'])
  })

  test('text is cut to the card length; unknown columns and blank text are dropped', () => {
    const session = seeded([{ column: 'keep', text: 'x'.repeat(200) }, { column: 'nowhere', text: 'Lost' }, { column: 'keep', text: '   ' }], { cardChars: 60 })
    expect(texts(session)).toEqual(['x'.repeat(60)])
  })

  test('a seed on anything but a board, or one that is not a list, is refused', () => {
    expect(parsePollDefinition({ pollId: 'p', type: 'open', question: 'q', visibility: 'live', options: [], seed: [{ column: 'a', text: 'b' }] })).toBeNull()
    expect(parsePollDefinition({ pollId: 'p', type: 'board', question: 'q', visibility: 'live', options: [{ optionId: 'a', label: 'A' }], seed: 'nope' })).toBeNull()
  })

  test('a board that never held a card takes a seed on a later open (its first open was not saved); one that has held a card does not', () => {
    const session = seeded([])
    expect(texts(session)).toEqual([])
    const again = parsePollDefinition({ pollId: 'poll-board', slideId: 'slide-board', type: 'board', question: 'Hopes', visibility: 'live', seed: [{ column: 'keep', text: 'Late seed' }],
      options: COLUMNS.map((optionId) => ({ optionId, label: optionId })) })
    closePoll(session, 'poll-board')
    openPoll(session, again!)
    expect(texts(session)).toEqual(['Late seed'])
    closePoll(session, 'poll-board')
    openPoll(session, again!)
    expect(texts(session)).toEqual(['Late seed'])
    // A board a card was once added to (then withdrawn) is never seeded.
    const used = seeded([])
    const withdrawn = add(used, 'p-once', 'keep', 'Then withdrawn')
    withdraw(used, 'p-once', withdrawn.ack.cardId)
    closePoll(used, 'poll-board')
    openPoll(used, again!)
    expect(texts(used)).toEqual([])
  })

  test('the operation fingerprint of a seeded poll.open is compact, and a retry with the same id is answered from it', () => {
    const session = createSession({ sessionId: 'session-fp', shortId: 'fpfp', talkSlug: 'talk', createdAt: 0, expiresAt: 60_000 })
    const seed = Array.from({ length: 400 }, (_, index) => ({ column: 'keep', text: `Answer ${index} `.repeat(6) }))
    const poll = parsePollDefinition({ pollId: 'poll-board', slideId: 'slide-board', type: 'board', question: 'Hopes', visibility: 'live', seed,
      options: COLUMNS.map((optionId) => ({ optionId, label: optionId })) })!
    const open = { type: 'operation' as const, operationId: 'operation-open-1', action: { type: 'poll.open' as const, poll } }
    const first = applyPollOperation(session, open)
    expect(first.status).toBe('confirmed')
    const stored = session.recovery!.operations['op:operation-open-1'].fingerprint
    expect(stored.length).toBeLessThan(1500)
    expect(stored).not.toContain('Answer 1 ')
    expect(applyPollOperation(session, open)).toEqual(first)
    const changed = { ...open, action: { type: 'poll.open' as const, poll: { ...poll, seed: seed.slice(1) } } }
    expect(applyPollOperation(session, changed).status).toBe('rejected')
    expect(texts(session).length).toBe(400)
  })

  test('seedCapacity counts what a board can hold: 500 cards at most (500 cards of the longest text still fit the row)', () => {
    expect(seedCapacity(Array.from({ length: 700 }, () => ({ column: 'keep', text: 'x' })))).toBe(500)
    expect(seedCapacity([{ column: 'keep', text: 'a' }, { column: 'keep', text: 'b' }])).toBe(2)
    const big = Array.from({ length: 500 }, () => ({ column: 'keep', text: 'y'.repeat(1_000) }))
    const fits = seedCapacity(big)
    expect(fits).toBe(500)
    const board = emptyBoard(undefined)
    seedBoard(board, big, 1)
    expect(board.cards.length).toBe(fits)
  })
})
