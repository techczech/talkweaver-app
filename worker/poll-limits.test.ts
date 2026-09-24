import { expect, test } from 'bun:test'
import { parsePresenterMessage, parsePresenterServerMessage, type PollChoice, type PollDefinition } from './protocol'
import { createSession, openPoll, closePoll, hidePollResponse, pollStateMessage } from './session-state'
import { acceptSubmission } from './recovery-state'

const session = () => createSession({ sessionId: 'limits-session', shortId: 'abcd', talkSlug: 'limits', createdAt: 1, expiresAt: 999999 })
const definition = (extra = {}): PollDefinition => ({ pollId: 'limits-poll', type: 'open', question: 'Ideas?', options: [], visibility: 'held', ...extra })
const submit = (s: ReturnType<typeof session>, id: string, choice: PollChoice = 'Idea', participant = 'participant-one') =>
  acceptSubmission(s, participant, { type: 'vote.submit', pollId: 'limits-poll', submissionId: id, choice }, 2)

test('free text defaults to one immutable submission', () => {
  const s = session(); openPoll(s, definition())
  expect(submit(s, 'submission-one').ack.status).toBe('confirmed')
  expect(submit(s, 'submission-two').ack.status).toBe('rejected')
})
test('free text accepts the configured allowance and counts retries once across reload and reopening', () => {
  let s = session(); openPoll(s, definition({ maxSubmissions: 2 }))
  expect(submit(s, 'submission-one').ack.status).toBe('confirmed')
  closePoll(s, 'limits-poll')
  expect(submit(s, 'submission-one').ack.status).toBe('confirmed')
  s = JSON.parse(JSON.stringify(s))
  openPoll(s, definition({ maxSubmissions: 50 }))
  expect(pollStateMessage(s.polls['limits-poll'], 'audience').maxSubmissions).toBe(2)
  expect(submit(s, 'submission-two', 'Another idea').ack.status).toBe('confirmed')
  expect(submit(s, 'submission-three').ack.status).toBe('rejected')
  expect(Object.values(s.polls['limits-poll'].votes)).toEqual(['Idea', 'Another idea'])
  expect(submit(s, 'submission-other', 'Other', 'participant-two').ack.status).toBe('confirmed')
})
test('unlimited free text retains separate responses and hiding never refunds an allowance', () => {
  const s = session(); openPoll(s, definition({ maxSubmissions: null }))
  for (let i = 0; i < 5; i++) expect(submit(s, `submission-${i}`).ack.status).toBe('confirmed')
  expect(Object.keys(s.polls['limits-poll'].votes)).toHaveLength(5)
  const limited = session(); openPoll(limited, definition({ maxSubmissions: 1 }))
  submit(limited, 'submission-one')
  hidePollResponse(limited, 'limits-poll', Object.keys(limited.polls['limits-poll'].votes)[0])
  expect(submit(limited, 'submission-two').ack.status).toBe('rejected')
})
test('multiple choice accepts up to N distinct options and rejects excess without consuming allowance', () => {
  const s = session(); openPoll(s, definition({ type: 'multiple', options: ['a','b','c'].map(optionId => ({ optionId, label: optionId })), maxSelections: 2 }))
  expect(submit(s, 'submission-too-many', ['a','b','c']).ack.status).toBe('rejected')
  expect(submit(s, 'submission-valid', ['a','b']).ack.status).toBe('confirmed')
  expect(submit(s, 'submission-edit', ['c']).ack.status).toBe('rejected')
  expect(submit(s, 'submission-other', ['c'], 'participant-two').ack.status).toBe('confirmed')
})
test('poll definition and audience snapshots retain validated limits', () => {
  const poll = definition({ maxSubmissions: null })
  expect(parsePresenterMessage(JSON.stringify({ type: 'poll.open', poll }))).toEqual({ type: 'poll.open', poll })
  const s = session(); openPoll(s, poll)
  const snapshot = pollStateMessage(s.polls[poll.pollId], 'audience')
  expect(parsePresenterServerMessage(JSON.stringify(snapshot))?.maxSubmissions).toBe(null)
  for (const maxSubmissions of [0, -1, 1.5, '3', Number.MAX_SAFE_INTEGER + 1]) {
    expect(parsePresenterMessage(JSON.stringify({ type: 'poll.open', poll: definition({ maxSubmissions }) }))).toBe(null)
  }
  for (const maxSelections of [0, 3, null, '2']) {
    expect(parsePresenterMessage(JSON.stringify({ type: 'poll.open', poll: definition({ type: 'multiple', options: ['a','b'].map(optionId => ({optionId,label:optionId})), maxSelections }) }))).toBe(null)
  }
})

test('live service compatibility rejects either uncombined feature build', async () => {
  const { supportsCurrentLiveWorker, LIVE_WORKER_BUILD } = await import('./recovery-protocol')
  for (const build of ['5-session-recovery', '6-extended-polls', '6-poll-response-limits']) {
    expect(supportsCurrentLiveWorker({ protocol: 2, build })).toBe(false)
  }
  expect(supportsCurrentLiveWorker({ protocol: 1, build: LIVE_WORKER_BUILD })).toBe(false)
  expect(supportsCurrentLiveWorker({ protocol: 2, build: LIVE_WORKER_BUILD })).toBe(true)
})


test('mixed poll rounds retain limits and ordered or mapped ballots through receipts, reopening and persistence', () => {
  let s = session()
  const options = ['a', 'b', 'c'].map(optionId => ({ optionId, label: optionId }))
  const labels = ['yes', 'no'].map(optionId => ({ optionId, label: optionId }))
  const cases: Array<{ poll: PollDefinition; choice: PollChoice; changed: Partial<PollDefinition> }> = [
    { poll: definition({ pollId: 'single', type: 'single', options }), choice: 'b', changed: { question: 'Changed' } },
    { poll: definition({ pollId: 'multiple', type: 'multiple', options, maxSelections: 2 }), choice: ['c', 'a'], changed: { maxSelections: 3 } },
    { poll: definition({ pollId: 'ranking-all', type: 'ranking', options }), choice: ['c', 'a', 'b'], changed: { rankCount: 1 } },
    { poll: definition({ pollId: 'ranking-top', type: 'ranking', options, rankCount: 2 }), choice: ['c', 'a'], changed: { rankCount: 3 } },
    { poll: definition({ pollId: 'rating', type: 'rating', options, labels, allowSkip: false }), choice: { a: 'yes', b: 'no', c: 'yes' }, changed: { allowSkip: true } },
    { poll: definition({ pollId: 'categorisation', type: 'categorisation', options, labels, allowSkip: true }), choice: { c: 'no' }, changed: { labels: [{ optionId: 'other', label: 'Other' }] } },
    { poll: definition({ pollId: 'open', maxSubmissions: 2 }), choice: 'An idea', changed: { maxSubmissions: null } },
  ]
  for (const { poll, choice, changed } of cases) {
    const parsed = parsePresenterMessage(JSON.stringify({ type: 'poll.open', poll }))
    expect(parsed).toEqual({ type: 'poll.open', poll })
    openPoll(s, poll)
    const vote = { type: 'vote.submit' as const, pollId: poll.pollId, submissionId: 'submission-' + poll.pollId, choice }
    const first = acceptSubmission(s, 'same-participant', vote, 2)
    expect(first.ack).toMatchObject({ status: 'confirmed', choice })
    expect(first.record?.choice).toEqual(choice)
    closePoll(s, poll.pollId)
    s = JSON.parse(JSON.stringify(s))
    expect(acceptSubmission(s, 'same-participant', vote, 3)).toEqual({ ack: first.ack })
    openPoll(s, { ...poll, ...changed })
    const { open, revealed, votes, hiddenResponseIds, ...storedDefinition } = s.polls[poll.pollId]
    expect(storedDefinition).toEqual(poll)
    const snapshot = pollStateMessage(s.polls[poll.pollId], 'audience')
    expect(parsePresenterServerMessage(JSON.stringify(snapshot))).toEqual(snapshot)
    expect(snapshot).not.toHaveProperty('tallies')
    expect(snapshot).not.toHaveProperty('categoryTallies')
    expect(snapshot).not.toHaveProperty('responses')
    const next = acceptSubmission(s, 'same-participant', { ...vote, submissionId: vote.submissionId + '-next' }, 4)
    expect(next.ack.status).toBe(poll.type === 'open' ? 'confirmed' : 'rejected')
    if (poll.type === 'open') {
      expect(acceptSubmission(s, 'same-participant', { ...vote, submissionId: vote.submissionId + '-excess' }, 5).ack.status).toBe('rejected')
    }
  }
  expect(s.recovery?.voteRecords.map(record => record.choice)).toEqual([...cases.map(item => item.choice), 'An idea'])
  openPoll(s, cases[0].poll)
  for (let i = 0; i < 100; i++) {
    expect(acceptSubmission(s, 'additional-participant-' + i, {
      type: 'vote.submit', pollId: 'single', submissionId: 'submission-one', choice: 'a',
    }, 6).ack.status).toBe('confirmed')
  }
  expect(Object.keys(s.polls.single.votes)).toHaveLength(101)
})
