import { describe, expect, test } from 'bun:test'
import { parseBoardStateView, parseCardAck } from './board-protocol'
import { acceptCard, applyBoardOperation, ensureBoard } from './board-state'
import { parsePollDefinition, parsePresenterMessage, parsePresenterServerMessage } from './protocol'
import { parseRecoveryClientMessage, parseRecoveryServerMessage } from './recovery-protocol'
import { createSession, openPoll, pollStateFor } from './session-state'

const pollId = 'poll-slide-board'

describe('presenter board operations', () => {
  test('each operation parses, with defaults for hide, freeze and "Show next"', () => {
    const parse = (message: Record<string, unknown>) => parsePresenterMessage(JSON.stringify({ pollId, ...message }))
    expect(parse({ type: 'board.move', target: { cardId: 'card-1' }, column: 'keep' }))
      .toEqual({ type: 'board.move', pollId, target: { cardId: 'card-1' }, column: 'keep' })
    expect(parse({ type: 'board.move', target: { group: 3 }, column: 'keep' })).toMatchObject({ target: { group: 3 } })
    expect(parse({ type: 'board.merge', source: { group: 2 }, target: { cardId: 'card-9' } }))
      .toEqual({ type: 'board.merge', pollId, source: { group: 2 }, target: { cardId: 'card-9' } })
    expect(parse({ type: 'board.split', group: 4 })).toEqual({ type: 'board.split', pollId, group: 4 })
    expect(parse({ type: 'board.hide', target: { cardId: 'card-1' } })).toMatchObject({ hidden: true })
    expect(parse({ type: 'board.hide', target: { cardId: 'card-1' }, hidden: false })).toMatchObject({ hidden: false })
    expect(parse({ type: 'board.freeze' })).toEqual({ type: 'board.freeze', pollId, frozen: true })
    expect(parse({ type: 'board.release', mode: 'next' })).toEqual({ type: 'board.release', pollId, mode: 'next', count: 12 })
    expect(parse({ type: 'board.release', mode: 'all' })).toEqual({ type: 'board.release', pollId, mode: 'all' })
    expect(parse({ type: 'board.release', mode: 'groupsOnly', column: 'keep' })).toEqual({ type: 'board.release', pollId, mode: 'groupsOnly', column: 'keep' })
    expect(parse({ type: 'board.limit', limit: 36 })).toEqual({ type: 'board.limit', pollId, limit: 36 })
    expect(parse({ type: 'board.limit', limit: null })).toEqual({ type: 'board.limit', pollId, limit: null })
    expect(parse({ type: 'board.relabel', group: 2, text: '  Hands-on time  ' })).toEqual({ type: 'board.relabel', pollId, group: 2, text: 'Hands-on time' })
    expect(parse({ type: 'board.relabel', group: 2, text: '' })).toEqual({ type: 'board.relabel', pollId, group: 2, text: '' })
  })

  test('malformed operations are refused', () => {
    const parse = (message: Record<string, unknown>) => parsePresenterMessage(JSON.stringify(message))
    expect(parse({ type: 'board.split', group: 1 })).toBeNull()
    for (const bad of [
      { type: 'board.move', target: { cardId: 'card-1', group: 1 }, column: 'keep' },
      { type: 'board.move', target: { cardId: 'card-1' } },
      { type: 'board.merge', source: { cardId: '' }, target: { group: 1 } },
      { type: 'board.split', group: 0 },
      { type: 'board.split', group: 1.5 },
      { type: 'board.hide', target: { group: 1 }, hidden: 'yes' },
      { type: 'board.release', mode: 'next', column: 'keep' },
      { type: 'board.release', mode: 'next', count: 0 },
      { type: 'board.release', mode: 'everything' },
      { type: 'board.limit', limit: 0 },
      { type: 'board.limit' },
      { type: 'board.relabel', group: 1 },
      { type: 'board.relabel', group: 0, text: 'x' },
      { type: 'board.relabel', group: 1, text: 7 },
      { type: 'board.relabel', group: 1, text: 'x'.repeat(2_001) },
      { type: 'board.relabel', target: { group: 1 }, text: 'x' },
    ]) expect(parse({ pollId, ...bad })).toBeNull()
  })

  test('operations travel inside the acknowledged operation envelope', () => {
    expect(parseRecoveryClientMessage(JSON.stringify({ type: 'operation', operationId: 'operation-freeze-1',
      action: { type: 'board.freeze', pollId, frozen: true } })))
      .toEqual({ type: 'operation', operationId: 'operation-freeze-1', action: { type: 'board.freeze', pollId, frozen: true } })
  })
})

describe('audience card messages', () => {
  test('add, edit and withdraw parse with a submission id; text is trimmed and kept as text', () => {
    expect(parseRecoveryClientMessage(JSON.stringify({ type: 'card.add', submissionId: 'submission-card-1', pollId, column: 'keep',
      text: '  <b>More</b> hands-on ', name: ' Sam ' })))
      .toEqual({ type: 'card.add', submissionId: 'submission-card-1', pollId, column: 'keep', text: '<b>More</b> hands-on', name: 'Sam' })
    expect(parseRecoveryClientMessage(JSON.stringify({ type: 'card.edit', submissionId: 'submission-card-2', pollId, cardId: 'card-1', text: 'New' })))
      .toEqual({ type: 'card.edit', submissionId: 'submission-card-2', pollId, cardId: 'card-1', text: 'New' })
    expect(parseRecoveryClientMessage(JSON.stringify({ type: 'card.withdraw', submissionId: 'submission-card-3', pollId, cardId: 'card-1' })))
      .toEqual({ type: 'card.withdraw', submissionId: 'submission-card-3', pollId, cardId: 'card-1' })
  })

  test('a broken card with a valid submission id is answered with a rejected receipt, not dropped', () => {
    expect(parseRecoveryClientMessage(JSON.stringify({ type: 'card.add', submissionId: 'submission-card-4', pollId, column: 'keep', text: '   ' })))
      .toEqual({ type: 'submission.invalid', kind: 'card.add', submissionId: 'submission-card-4', pollId, error: 'empty_card' })
    expect(parseRecoveryClientMessage(JSON.stringify({ type: 'card.edit', submissionId: 'submission-card-5', pollId, text: 'x' })))
      .toMatchObject({ type: 'submission.invalid', error: 'invalid_card_id' })
    expect(parseRecoveryClientMessage(JSON.stringify({ type: 'card.add', submissionId: 'submission-card-6', pollId, column: 'keep', text: 'x', name: 'n'.repeat(61) })))
      .toMatchObject({ type: 'submission.invalid', error: 'name_too_long' })
    expect(parseRecoveryClientMessage(JSON.stringify({ type: 'card.add', submissionId: 'short', pollId, column: 'keep', text: 'x' }))).toBeNull()
  })

  test('receipts parse on the client', () => {
    const ack = { type: 'card.ack', submissionId: 'submission-card-1', pollId, status: 'confirmed', cardId: 'card-1', cardsUsed: 1 }
    expect(parseRecoveryServerMessage(JSON.stringify(ack))).toEqual(ack)
    expect(parseCardAck({ ...ack, cardsUsed: -1 })).toBeNull()
    expect(parseCardAck({ ...ack, status: 'rejected', error: 'card_limit_reached', cardId: undefined, cardsUsed: undefined }))
      .toEqual({ type: 'card.ack', submissionId: 'submission-card-1', pollId, status: 'rejected', error: 'card_limit_reached' })
    expect(parseCardAck({ ...ack, status: 'maybe' })).toBeNull()
  })
})

describe('board state on the wire', () => {
  function liveBoard() {
    const session = createSession({ sessionId: 'session-wire', shortId: 'abcd', talkSlug: 'talk', createdAt: 0, expiresAt: 60_000 })
    const definition = parsePollDefinition({ pollId, type: 'board', question: 'Keep, change, try?', visibility: 'live',
      options: [{ optionId: 'keep', label: 'Keep' }, { optionId: 'change', label: 'Change' }], board: { names: true, hints: { keep: 'What worked' } } })!
    openPoll(session, definition)
    const poll = session.polls[pollId]
    const board = ensureBoard(session, poll)
    for (const [who, text] of [['alice', 'One'], ['bob', 'Two'], ['carol', 'Three']]) {
      acceptCard(board, poll, who, { kind: 'card.add', submissionId: `submission-${who}`, input: { pollId, column: 'keep', text, name: who } }, 1)
    }
    applyBoardOperation(board, poll, { type: 'board.merge', pollId, source: { cardId: 'card-2' }, target: { cardId: 'card-1' } })
    applyBoardOperation(board, poll, { type: 'board.hide', pollId, target: { cardId: 'card-3' }, hidden: true })
    applyBoardOperation(board, poll, { type: 'board.relabel', pollId, group: 1, text: 'One and two' })
    return { session, poll }
  }

  test('presenter and audience poll.state round-trip through the client parsers', () => {
    const { session, poll } = liveBoard()
    const presenter = pollStateFor(session, poll, 'presenter')
    expect(parsePresenterServerMessage(JSON.stringify(presenter))).toEqual(presenter)
    const audience = pollStateFor(session, poll, 'audience')
    expect(parsePresenterServerMessage(JSON.stringify(audience))).toEqual(audience)
    expect(parseBoardStateView(audience.boardState, 'audience')).toEqual(audience.boardState!)
    // The group's wording is public: it reaches the room, with none of the presenter-only fields.
    expect(audience.boardState!.groups[0].label).toBe('One and two')
    expect(JSON.stringify(audience.boardState)).not.toMatch(/"(hidden|name|fromGroup|touched|participant)"/)
    expect(parseBoardStateView({ ...audience.boardState, groups: [{ ...audience.boardState!.groups[0], label: 7 }] }, 'audience')).toBeNull()
    // A board whose public view carries anything presenter-only is refused as a whole.
    expect(parseBoardStateView(presenter.boardState, 'audience')).toBeNull()
    expect(parsePresenterServerMessage(JSON.stringify({ ...presenter, board: undefined }))).toBeNull()
    expect(parsePresenterServerMessage(JSON.stringify({ ...presenter, pollType: 'open', options: [] }))).toBeNull()
  })

  test('snapshots carry board polls and the participant’s own cards', () => {
    const { session, poll } = liveBoard()
    const snapshot = { type: 'session.snapshot', protocol: 2, syncId: 'sync-board-1', sessionId: 'session-wire', expiresAt: 60_000,
      slideState: null, polls: [pollStateFor(session, poll, 'audience')],
      myCards: [{ pollId, cardId: 'card-1', column: 'keep', text: 'One', sorted: true, waiting: false }],
      myBoards: [{ pollId, cardsUsed: 2, cardsPerPhone: 5 }] }
    expect(parseRecoveryServerMessage(JSON.stringify(snapshot))).toMatchObject({ polls: snapshot.polls, myCards: snapshot.myCards, myBoards: snapshot.myBoards })
    expect(parseRecoveryServerMessage(JSON.stringify({ ...snapshot, myBoards: [{ pollId, cardsUsed: 'two', cardsPerPhone: 5 }] }))).toBeNull()
    expect(parseRecoveryServerMessage(JSON.stringify({ ...snapshot, myCards: [{ pollId, cardId: 'card-1' }] }))).toBeNull()
  })
})
