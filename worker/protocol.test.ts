import { describe, expect, test } from 'bun:test'
import { parseAudienceMessage, parsePresenterMessage, parsePresenterServerMessage } from './protocol'

describe('presenter message protocol', () => {
  test('accepts a valid slide publish event', () => {
    expect(parsePresenterMessage(JSON.stringify({
      type: 'slide.publish', slideId: 'slide-4', reveal: 3, focus: { kind: 'focus', step: 2 },
    }))).toEqual({
      type: 'slide.publish',
      slideId: 'slide-4',
      reveal: 3,
      focus: { kind: 'focus', step: 2 },
    })
  })

  test('normalises an omitted focus state for an older presenter', () => {
    expect(parsePresenterMessage(JSON.stringify({ type: 'slide.publish', slideId: 'slide-4', reveal: 0 }))).toEqual({
      type: 'slide.publish', slideId: 'slide-4', reveal: 0, focus: null,
    })
  })

  test('accepts presenter poll lifecycle messages', () => {
    const poll = {
      pollId: 'poll-slide-1', type: 'single', question: 'Choose one',
      options: [{ optionId: 'poll-slide-1-option-1', label: 'First' }], visibility: 'held',
    }
    expect(parsePresenterMessage(JSON.stringify({ type: 'poll.open', poll }))).toEqual({ type: 'poll.open', poll })
    expect(parsePresenterMessage(JSON.stringify({ type: 'poll.close', pollId: poll.pollId }))).toEqual({
      type: 'poll.close', pollId: poll.pollId,
    })
    expect(parsePresenterMessage(JSON.stringify({ type: 'poll.reveal', pollId: poll.pollId }))).toEqual({
      type: 'poll.reveal', pollId: poll.pollId,
    })
    expect(parsePresenterMessage(JSON.stringify({
      type: 'poll.hide', pollId: poll.pollId, responseId: 'connection-1', hidden: true,
    }))).toEqual({ type: 'poll.hide', pollId: poll.pollId, responseId: 'connection-1', hidden: true })
    expect(parsePresenterMessage(JSON.stringify({
      type: 'poll.hide', pollId: poll.pollId, responseId: 'connection-1', hidden: 'yes',
    }))).toBeNull()
    expect(parsePresenterMessage(JSON.stringify({
      type: 'poll.hide', pollId: poll.pollId, responseId: '',
    }))).toBeNull()
  })

  test('accepts audience votes for all poll types', () => {
    expect(parseAudienceMessage(JSON.stringify({ type: 'poll.vote', pollId: 'poll-1', choice: 'option-1' }))).toEqual({
      type: 'poll.vote', pollId: 'poll-1', choice: 'option-1',
    })
    expect(parseAudienceMessage(JSON.stringify({ type: 'poll.vote', pollId: 'poll-1', choice: ['option-1', 'option-2'] }))).toEqual({
      type: 'poll.vote', pollId: 'poll-1', choice: ['option-1', 'option-2'],
    })
  })

  test('validates poll state and individual vote records sent to presenters', () => {
    const state = {
      type: 'poll.state', pollId: 'poll-1', pollType: 'single', question: 'Choose one',
      options: [{ optionId: 'option-1', label: 'First' }], visibility: 'held',
      open: true, revealed: false, tallies: { 'option-1': 1 },
    }
    expect(parsePresenterServerMessage(JSON.stringify(state))).toEqual(state)
    expect(parsePresenterServerMessage(JSON.stringify({
      type: 'poll.vote-record', pollId: 'poll-1', choice: ['option-1', 'option-2'],
    }))).toEqual({ type: 'poll.vote-record', pollId: 'poll-1', choice: ['option-1', 'option-2'] })
    expect(parsePresenterServerMessage(JSON.stringify({
      type: 'poll.vote-record', pollId: '', choice: [],
    }))).toBeNull()
    const openState = {
      ...state, pollType: 'open', options: [], responses: [
        { responseId: 'connection-1', text: 'Accountability', hidden: true },
      ],
    }
    delete openState.tallies
    expect(parsePresenterServerMessage(JSON.stringify(openState))).toEqual(openState)
  })

  test('keeps later interaction messages inert', () => {
    expect(parsePresenterMessage(JSON.stringify({ type: 'question.answer', questionId: 'question-1' }))).toBeNull()
    expect(parsePresenterMessage(JSON.stringify({ type: 'reaction.echo', emoji: '👍' }))).toBeNull()
  })

  test('rejects malformed slide events', () => {
    expect(parsePresenterMessage(JSON.stringify({ type: 'slide.publish', slideId: '', reveal: -1 }))).toBeNull()
    expect(parsePresenterMessage(JSON.stringify({
      type: 'slide.publish', slideId: 'slide-4', reveal: 0, focus: { kind: 'blur', step: 1 },
    }))).toBeNull()
    expect(parsePresenterMessage('not json')).toBeNull()
  })
})
