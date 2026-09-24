import { describe, expect, test } from 'bun:test'
import {
  closeSession,
  closePoll,
  createSession,
  currentPollStateMessages,
  currentStateMessage,
  hidePollResponse,
  openPoll,
  normaliseStoredSession,
  pollStateMessage,
  publishSlideState,
  revealPoll,
  socketRoleReceivesSlideState,
  voteInPoll,
  type StoredLiveSession,
} from './session-state'
import * as sessionState from './session-state'

describe('LiveSession state', () => {
  test('creates an open session with no current slide', () => {
    const session = createSession({
      sessionId: 'session-1',
      shortId: 'K7M4Q2',
      talkSlug: 'talk-slug',
      createdAt: 1_000,
      expiresAt: 2_000,
    })

    expect(session).toEqual({
      sessionId: 'session-1',
      shortId: 'K7M4Q2',
      talkSlug: 'talk-slug',
      createdAt: 1_000,
      expiresAt: 2_000,
      status: 'open',
      slideState: null,
      revision: 0,
      polls: {},
    })
  })

  test('publishes the current slide and increments its revision', () => {
    const session = openSession()

    const message = publishSlideState(session, {
      slideId: 'slide-3', reveal: 2, focus: { kind: 'reveal', step: 1 },
    })

    expect(message).toEqual({
      type: 'slide.state',
      slideId: 'slide-3',
      reveal: 2,
      focus: { kind: 'reveal', step: 1 },
      revision: 1,
    })
    expect(session.slideState).toEqual({
      slideId: 'slide-3', reveal: 2, focus: { kind: 'reveal', step: 1 },
    })
    expect(session.revision).toBe(1)
  })

  test('sends slide publishes to audience subscribers only', () => {
    expect(socketRoleReceivesSlideState('audience')).toBe(true)
    expect(socketRoleReceivesSlideState('presenter')).toBe(false)
  })

  test('keeps the session open when either socket role disconnects', () => {
    expect(typeof sessionState.socketRoleEndsSession).toBe('function')
    expect(sessionState.socketRoleEndsSession?.('presenter')).toBe(false)
    expect(sessionState.socketRoleEndsSession?.('audience')).toBe(false)
  })

  test('gives a late joiner the latest slide state', () => {
    const session = openSession()
    publishSlideState(session, { slideId: 'slide-8', reveal: 1, focus: { kind: 'focus', step: 3 } })

    expect(currentStateMessage(session)).toEqual({
      type: 'slide.state',
      slideId: 'slide-8',
      reveal: 1,
      focus: { kind: 'focus', step: 3 },
      revision: 1,
    })
  })

  test('closes a session and rejects later publishes', () => {
    const session = openSession()

    expect(closeSession(session)).toEqual({ type: 'session.closed' })
    expect(session.status).toBe('closed')
    expect(() => publishSlideState(session, { slideId: 'slide-2', reveal: 0, focus: null })).toThrow('Session is closed.')
  })

  test('opens a choice poll, tallies votes, and closes it', () => {
    const session = openSession()
    const poll = singlePoll('live')

    expect(openPoll(session, poll)).toEqual({
      type: 'poll.state', pollId: poll.pollId, pollType: poll.type, question: poll.question,
      options: poll.options, visibility: poll.visibility, open: true, revealed: true,
      tallies: { 'option-a': 0, 'option-b': 0 },
    })
    expect(voteInPoll(session, 'connection-1', poll.pollId, 'option-a').tallies).toEqual({
      'option-a': 1, 'option-b': 0,
    })
    expect(closePoll(session, poll.pollId).open).toBe(false)
  })

  test('re-opening a closed poll keeps the votes it already collected', () => {
    const session = openSession()
    const poll = singlePoll('live')
    openPoll(session, poll)
    voteInPoll(session, 'connection-1', poll.pollId, 'option-a')
    closePoll(session, poll.pollId)

    // Mis-click recovery: re-opening must not wipe the room's answers.
    const reopened = openPoll(session, poll)
    expect(reopened.open).toBe(true)
    expect(reopened.tallies).toEqual({ 'option-a': 1, 'option-b': 0 })
  })

  test('opening a poll closes every previously open poll', () => {
    const session = openSession()
    const first = singlePoll('live')
    const second = { ...singlePoll('held'), pollId: 'poll-second' }
    openPoll(session, first)
    openPoll(session, second)
    expect(session.polls[first.pollId].open).toBe(false)
    expect(session.polls[second.pollId].open).toBe(true)
  })

  test('re-voting from one connection replaces its previous choice', () => {
    const session = openSession()
    const poll = singlePoll('live')
    openPoll(session, poll)
    voteInPoll(session, 'connection-1', poll.pollId, 'option-a')

    expect(voteInPoll(session, 'connection-1', poll.pollId, 'option-b').tallies).toEqual({
      'option-a': 0, 'option-b': 1,
    })
  })

  test('tallies each selected option in a multiple-choice vote', () => {
    const session = openSession()
    const poll = { ...singlePoll('live'), type: 'multiple' as const }
    openPoll(session, poll)

    expect(voteInPoll(session, 'connection-1', poll.pollId, ['option-a', 'option-b']).tallies).toEqual({
      'option-a': 1, 'option-b': 1,
    })
  })

  test('tracks open-text responses and replaces a connection response', () => {
    const session = openSession()
    const poll = {
      pollId: 'poll-open', type: 'open' as const, question: 'What matters?', options: [], visibility: 'live' as const,
    }
    openPoll(session, poll)
    voteInPoll(session, 'connection-1', poll.pollId, 'Judgement')

    expect(voteInPoll(session, 'connection-1', poll.pollId, 'Accountability').responses).toEqual([
      { responseId: 'connection-1', text: 'Accountability' },
    ])
  })

  test('hides an open response from the audience while retaining it for the presenter', () => {
    const session = openSession()
    const poll = {
      pollId: 'poll-open', type: 'open' as const, question: 'What matters?', options: [], visibility: 'live' as const,
    }
    openPoll(session, poll)
    voteInPoll(session, 'connection-1', poll.pollId, 'Accountability')
    voteInPoll(session, 'connection-2', poll.pollId, 'Judgement')

    hidePollResponse(session, poll.pollId, 'connection-1')

    expect(pollStateMessage(session.polls[poll.pollId], 'audience').responses).toEqual([
      { responseId: 'connection-2', text: 'Judgement' },
    ])
    expect(pollStateMessage(session.polls[poll.pollId], 'presenter').responses).toEqual([
      { responseId: 'connection-1', text: 'Accountability', hidden: true },
      { responseId: 'connection-2', text: 'Judgement' },
    ])
    expect(session.polls[poll.pollId].votes['connection-1']).toBe('Accountability')

    hidePollResponse(session, poll.pollId, 'connection-1', false)
    expect(pollStateMessage(session.polls[poll.pollId], 'audience').responses).toContainEqual({
      responseId: 'connection-1', text: 'Accountability',
    })
  })

  test('preserves hidden response ids through Durable Object JSON storage', () => {
    const session = openSession()
    const poll = {
      pollId: 'poll-open', type: 'open' as const, question: 'What matters?', options: [], visibility: 'live' as const,
    }
    openPoll(session, poll)
    voteInPoll(session, 'connection-1', poll.pollId, 'Accountability')
    hidePollResponse(session, poll.pollId, 'connection-1')

    const restored = normaliseStoredSession(JSON.parse(JSON.stringify(session)) as StoredLiveSession)

    expect(pollStateMessage(restored.polls[poll.pollId], 'presenter').responses).toEqual([
      { responseId: 'connection-1', text: 'Accountability', hidden: true },
    ])
  })

  test('withholds held results from audiences until reveal while presenters see them', () => {
    const session = openSession()
    const poll = singlePoll('held')
    openPoll(session, poll)
    voteInPoll(session, 'connection-1', poll.pollId, 'option-a')

    expect(pollStateMessage(session.polls[poll.pollId], 'presenter')).toMatchObject({
      tallies: { 'option-a': 1, 'option-b': 0 }, revealed: false,
    })
    expect(pollStateMessage(session.polls[poll.pollId], 'audience', true)).toEqual({
      type: 'poll.state', pollId: poll.pollId, pollType: poll.type, question: poll.question,
      options: poll.options, visibility: poll.visibility, open: true, revealed: false, recorded: true,
    })
    revealPoll(session, poll.pollId)
    expect(pollStateMessage(session.polls[poll.pollId], 'audience')).toMatchObject({
      tallies: { 'option-a': 1, 'option-b': 0 }, revealed: true,
    })
  })

  test('recovers closed and open polls without exposing held results', () => {
    const session = openSession()
    const closed = { ...singlePoll('held'), pollId: 'poll-closed' }
    openPoll(session, closed)
    closePoll(session, closed.pollId)
    openPoll(session, singlePoll('live'))

    const recovered = currentPollStateMessages(session, 'audience')
    expect(recovered).toHaveLength(2)
    expect(recovered[0]).toMatchObject({ pollId: 'poll-closed', open: false, revealed: false })
    expect(recovered[0].tallies).toBeUndefined()
    expect(recovered[1]).toMatchObject({
      pollId: 'poll-choice', open: true, tallies: { 'option-a': 0, 'option-b': 0 },
    })
  })
})

function openSession(): StoredLiveSession {
  return createSession({
    sessionId: 'session-1',
    shortId: 'K7M4Q2',
    talkSlug: 'talk-slug',
    createdAt: 1_000,
    expiresAt: 2_000,
  })
}

function singlePoll(visibility: 'live' | 'held') {
  return {
    pollId: 'poll-choice', type: 'single' as const, question: 'Choose one', visibility,
    options: [
      { optionId: 'option-a', label: 'A' },
      { optionId: 'option-b', label: 'B' },
    ],
  }
}
