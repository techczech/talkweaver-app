import { describe, expect, test } from 'bun:test'
import { acceptCard, ensureBoard } from './board-state'
import {
  DAY_MS, closeLateBoards, dueLateBoards, isOpenLateBoard, keepBoardsOpen, lateBoardsOpen, lateBoardsUntil, nextLateAlarm, openLateBoards,
} from './late-boards'
import { parsePollDefinition, type PollDefinition } from './protocol'
import { closePoll, closeSession, createSession, openPoll, type StoredLiveSession } from './session-state'

// A fake clock: every function takes `now`, so days pass without waiting.
const T0 = Date.UTC(2026, 8, 28, 14, 2)

function board(pollId: string, closesAfterDays?: number): PollDefinition {
  const parsed = parsePollDefinition({ pollId, slideId: `slide-${pollId}`, type: 'board', question: 'What should we keep, change, try?',
    visibility: 'live', options: [{ optionId: 'keep', label: 'Keep' }, { optionId: 'try', label: 'Try' }],
    board: closesAfterDays ? { closesAfterDays } : {} })
  if (!parsed) throw new Error('fixture must parse')
  return parsed
}

function session(): StoredLiveSession {
  return createSession({ sessionId: 'session-late', shortId: 'abcd', talkSlug: 'talk', createdAt: T0 - 3_600_000, expiresAt: T0 + 11 * 3_600_000 })
}

function card(s: StoredLiveSession, pollId: string, text: string, now: number) {
  const poll = s.polls[pollId]
  return acceptCard(ensureBoard(s, poll), poll, 'phone-1', { kind: 'card.add', submissionId: `sub-${text}`,
    input: { pollId, column: 'keep', text } }, now)
}

describe('boards left open after End live', () => {
  test('End live keeps each open board open for its own "closes after" setting; a closed board stays closed', () => {
    const s = session()
    openPoll(s, board('early', 1))
    closePoll(s, 'early')
    openPoll(s, board('main'))
    const kept = keepBoardsOpen(s, T0)
    closeSession(s)
    expect(kept).toEqual({ main: T0 + 7 * DAY_MS })
    expect(s.endedAt).toBe(T0)
    expect(openLateBoards(s, T0 + 1)).toEqual({ main: T0 + 7 * DAY_MS })
    expect(isOpenLateBoard(s, 'early', T0 + 1)).toBe(false)
    expect(nextLateAlarm(s)).toBe(T0 + 7 * DAY_MS)
    expect(lateBoardsUntil(s)).toBe(T0 + 7 * DAY_MS)
  })

  test('with no board open, End live keeps nothing and records nothing', () => {
    const s = session()
    openPoll(s, board('main'))
    closePoll(s, 'main')
    expect(keepBoardsOpen(s, T0)).toEqual({})
    expect(s.lateBoards).toBeUndefined()
    expect(s.endedAt).toBeUndefined()
    closeSession(s)
    expect(lateBoardsOpen(s, T0)).toBe(false)
    expect(nextLateAlarm(s)).toBeNull()
  })

  test('a board left open takes late cards until the alarm time, then closes by itself and refuses cards', () => {
    const s = session()
    openPoll(s, board('main', 1))
    keepBoardsOpen(s, T0)
    closeSession(s)
    // The next morning: still open, a late card lands.
    const morning = T0 + 18 * 3_600_000
    expect(isOpenLateBoard(s, 'main', morning)).toBe(true)
    expect(card(s, 'main', 'Recording of the demo, please', morning).ack.status).toBe('confirmed')
    expect(dueLateBoards(s, morning)).toEqual([])
    // A day after the end the alarm fires: the board is due and closes.
    const alarm = nextLateAlarm(s)!
    expect(alarm).toBe(T0 + DAY_MS)
    expect(isOpenLateBoard(s, 'main', alarm)).toBe(false)
    expect(dueLateBoards(s, alarm)).toEqual(['main'])
    const changed = closeLateBoards(s, dueLateBoards(s, alarm), 'expired', alarm)
    expect(changed.map((poll) => poll.pollId)).toEqual(['main'])
    expect(s.polls.main.open).toBe(false)
    expect(s.lateBoards).toBeUndefined()
    expect(s.lateClosed).toEqual({ main: { at: alarm, reason: 'expired' } })
    expect(nextLateAlarm(s)).toBeNull()
    expect(card(s, 'main', 'Too late', alarm + 1).ack.error).toBe('board_closed')
    // Every card is kept for the Run.
    expect(s.boards?.main.cards.map((c) => c.text)).toEqual(['Recording of the demo, please'])
  })

  test('two boards with different settings close one at a time; the alarm moves to the next', () => {
    const s = session()
    openPoll(s, board('short', 1))
    // Keep both open: a second open board (openPoll closes the others, so reopen the first by hand).
    openPoll(s, board('long', 30))
    s.polls.short.open = true
    keepBoardsOpen(s, T0)
    closeSession(s)
    expect(nextLateAlarm(s)).toBe(T0 + DAY_MS)
    closeLateBoards(s, dueLateBoards(s, T0 + DAY_MS))
    expect(Object.keys(openLateBoards(s, T0 + DAY_MS))).toEqual(['long'])
    expect(nextLateAlarm(s)).toBe(T0 + 30 * DAY_MS)
    expect(lateBoardsUntil(s)).toBe(T0 + 30 * DAY_MS)
  })

  test('"Close it now" closes every board left open at once', () => {
    const s = session()
    openPoll(s, board('main', 30))
    keepBoardsOpen(s, T0)
    closeSession(s)
    closeLateBoards(s, undefined, 'closed', T0 + 5)
    expect(s.lateClosed).toEqual({ main: { at: T0 + 5, reason: 'closed' } })
    expect(lateBoardsOpen(s, T0 + 1)).toBe(false)
    expect(s.polls.main.open).toBe(false)
    expect(nextLateAlarm(s)).toBeNull()
  })

  test('a new live session taking the join link closes the boards left open, saying so', () => {
    const s = session()
    openPoll(s, board('main', 30))
    keepBoardsOpen(s, T0)
    closeSession(s)
    const changed = closeLateBoards(s, undefined, 'superseded', T0 + 3_600_000)
    expect(changed.map((poll) => poll.pollId)).toEqual(['main'])
    expect(s.lateClosed).toEqual({ main: { at: T0 + 3_600_000, reason: 'superseded' } })
    expect(lateBoardsOpen(s, T0 + 3_600_001)).toBe(false)
  })

  test('a session that is still live has no late boards, whatever its record says', () => {
    const s = session()
    openPoll(s, board('main'))
    s.lateBoards = { main: T0 + DAY_MS }
    expect(lateBoardsOpen(s, T0)).toBe(false)
  })
})
