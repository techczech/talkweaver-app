import { describe, expect, test } from 'bun:test'
import { parseAudienceMessage, parsePresenterMessage, parsePresenterServerMessage, type PollDefinition } from './protocol'
import { createSession, openPoll, voteInPoll, pollStateMessage, normaliseStoredSession } from './session-state'
import { normaliseRun } from '../src/main/runs'

const options = ['a', 'b', 'c'].map(optionId => ({ optionId, label: optionId.toUpperCase() }))
const labels = ['often', 'sometimes', 'never'].map(optionId => ({ optionId, label: optionId }))
const ranking = { pollId: 'rank', type: 'ranking', question: 'Priorities', options, visibility: 'held' } as PollDefinition
const rating = { ...ranking, pollId: 'rating', type: 'rating', labels, allowSkip: false } as PollDefinition
function session() { return createSession({ sessionId: 's', shortId: 'short', talkSlug: 'talk', createdAt: 1, expiresAt: 99 }) }
function definition(poll: unknown) { return parsePresenterMessage(JSON.stringify({ type: 'poll.open', poll })) }

describe('ranking and matrix ballot contracts', () => {
  test('accepts full/top-N and text scales; rejects invalid definitions', () => {
    expect(definition(ranking)).toEqual({ type: 'poll.open', poll: ranking })
    expect(definition({ ...ranking, rankCount: 2 })?.type).toBe('poll.open')
    expect(definition(rating)).toEqual({ type: 'poll.open', poll: rating })
    expect(definition({ ...rating, type: 'categorisation' })?.type).toBe('poll.open')
    for (const rankCount of [0, -1, 4, 1.5, '2']) expect(definition({ ...ranking, rankCount })).toBeNull()
    for (const patch of [{ labels: [] }, { labels: [labels[0], labels[0]] }, { labels: undefined }, { allowSkip: 'yes' }]) {
      expect(definition({ ...rating, ...patch })).toBeNull()
    }
  })
  test('wire arrays retain order AND duplicates for type-specific validation', () => {
    for (const choice of [['c','a','b'], ['a','a','b'], { a: 'often', b: 'never', c: 'sometimes' }]) {
      expect(parseAudienceMessage(JSON.stringify({ type: 'poll.vote', pollId: 'p', choice }))?.choice).toEqual(choice)
      const record = parsePresenterServerMessage(JSON.stringify({ type: 'poll.vote-record', pollId: 'p', choice }))
      expect(record && 'choice' in record && record.choice).toEqual(choice)
    }
  })
  test('full ranking scores positions, not selections; JSON persistence preserves order', () => {
    const s = session(); openPoll(s, ranking)
    const state = voteInPoll(s, 'one', 'rank', ['c','a','b'])
    expect(state.tallies).toEqual({ a: 2, b: 1, c: 3 })
    expect(state.firstPlaces).toEqual({ a: 0, b: 0, c: 1 })
    expect(state.responseCount).toBe(1)
    const restored = normaliseStoredSession(JSON.parse(JSON.stringify(s)))
    expect(restored.polls.rank.votes.one).toEqual(['c','a','b'])
    expect(pollStateMessage(restored.polls.rank, 'presenter')).toEqual(state)
    expect(parsePresenterServerMessage(JSON.stringify(state))).toEqual(state)
    const audience = pollStateMessage(s.polls.rank, 'audience')
    expect(audience.tallies).toBeUndefined(); expect(audience.firstPlaces).toBeUndefined()
    expect(audience.responseCount).toBeUndefined()
  })
  test('Top N awards N..1, omits zero-point items, and retains overall ties', () => {
    const s = session(); openPoll(s, { ...ranking, rankCount: 2 })
    voteInPoll(s, 'one', 'rank', ['a','b'])
    voteInPoll(s, 'two', 'rank', ['b','a'])
    const state = pollStateMessage(s.polls.rank, 'presenter')
    expect(state.tallies).toEqual({ a: 3, b: 3, c: 0 })
    expect(state.firstPlaces).toEqual({ a: 1, b: 1, c: 0 })
    for (const invalid of [['a'], ['a','a'], ['a','unknown'], ['a','b','c'], 'a', { a: 'b' }]) {
      expect(() => voteInPoll(s, 'bad', 'rank', invalid)).toThrow()
    }
    expect(Object.keys(s.polls.rank.votes)).toHaveLength(2)
  })
  test('matrix validates every row and label, and aggregates each item independently', () => {
    const s = session(); openPoll(s, rating)
    const choice = { a: 'often', b: 'never', c: 'sometimes' }
    const state = voteInPoll(s, 'one', 'rating', choice)
    expect(state.categoryTallies).toEqual({
      a: { often: 1, sometimes: 0, never: 0 }, b: { often: 0, sometimes: 0, never: 1 },
      c: { often: 0, sometimes: 1, never: 0 },
    })
    expect(state.responseCount).toBe(1)
    expect(parsePresenterServerMessage(JSON.stringify(state))).toEqual(state)
    expect(pollStateMessage(s.polls.rating, 'audience').categoryTallies).toBeUndefined()
    for (const invalid of [{ a: 'often' }, { ...choice, d: 'often' }, { ...choice, a: 'invalid' }, ['often'], 'often', {}]) {
      expect(() => voteInPoll(s, 'bad', 'rating', invalid)).toThrow()
    }
    openPoll(s, { ...rating, pollId: 'optional', allowSkip: true })
    expect(voteInPoll(s, 'one', 'optional', { a: 'never' }).responseCount).toBe(1)
    expect(() => voteInPoll(s, 'bad', 'optional', {})).toThrow()
  })
  test('run records retain new definitions and ballot shapes', () => {
    const value = {
      polls: [ranking, rating].map(({ pollId, ...poll }) => ({ ...poll, id: pollId })),
      pollResponses: [
        { pollId: 'rank', choice: ['c','a','b'], tMs: 10, slideId: 'slide' },
        { pollId: 'rating', choice: { a: 'often', b: 'never', c: 'sometimes' }, tMs: 11, slideId: 'slide' },
      ],
    }
    const run = normaliseRun(JSON.parse(JSON.stringify(value)))
    expect(run.polls).toEqual(value.polls); expect(run.pollResponses).toEqual(value.pollResponses)
  })
})
