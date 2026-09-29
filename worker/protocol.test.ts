import { describe, expect, test } from 'bun:test'
import { parseRecoveryServerMessage, parseRecoveryClientMessage } from './recovery-protocol'

test('presence validates counts while older recovery snapshots remain readable', () => {
  expect(parseRecoveryServerMessage('{"type":"session.presence","presenterConnected":false,"venueScreens":2}'))
    .toEqual({ type: 'session.presence', presenterConnected: false, venueScreens: 2 })
  expect(parseRecoveryServerMessage('{"type":"session.presence","presenterConnected":false,"venueScreens":-1}')).toBeNull()
  const old = { type: 'session.snapshot', protocol: 2, syncId: 'sync-old-client', sessionId: 'session-one',
    expiresAt: 12345, slideState: null, polls: [] }
  expect(parseRecoveryServerMessage(JSON.stringify(old))).toMatchObject(old)
})

test('recovery preserves gallery state in presenter sync and venue snapshot', () => {
  const slideState = { slideId: 'gallery', reveal: 0, focus: null, lightbox: { open: true, index: 1 } }
  expect(parseRecoveryClientMessage(JSON.stringify({ type: 'session.sync', syncId: 'gallery-sync-1', slideState })))
    .toMatchObject({ slideState })
  expect(parseRecoveryServerMessage(JSON.stringify({ type: 'session.snapshot', protocol: 2,
    syncId: 'gallery-sync-1', sessionId: 'session-one', expiresAt: 12345,
    slideState: { type: 'slide.state', ...slideState, revision: 4 }, polls: [] })))
    .toMatchObject({ slideState: { ...slideState, revision: 4 } })
})
test('recovery preserves the talk QR overlay in presenter sync and venue snapshot', () => {
  const slideState = { slideId: 'slide-2', reveal: 0, focus: null, talkQr: true }
  expect(parseRecoveryClientMessage(JSON.stringify({ type: 'session.sync', syncId: 'qr-sync-1', slideState })))
    .toMatchObject({ slideState })
  expect(parseRecoveryServerMessage(JSON.stringify({ type: 'session.snapshot', protocol: 2,
    syncId: 'qr-sync-1', sessionId: 'session-one', expiresAt: 12345,
    slideState: { type: 'slide.state', ...slideState, revision: 5 }, polls: [] })))
    .toMatchObject({ slideState: { ...slideState, revision: 5 } })
})
import { parseAudienceMessage, parsePresenterMessage, parsePresenterServerMessage } from './protocol'

describe('presenter message protocol', () => {
  test('validates instant slides and clear without accepting an unbounded payload', () => {
    const slide = { kind: 'countdown', shownAt: 1000, startedAt: 1000, durationMs: 300000, label: 'Discussion' }
    expect(parsePresenterMessage(JSON.stringify({ type: 'instant.show', slide }))).toEqual({ type: 'instant.show', slide })
    expect(parsePresenterMessage('{"type":"instant.clear"}')).toEqual({ type: 'instant.clear' })
    expect(parsePresenterMessage(JSON.stringify({ type: 'instant.show', slide: { ...slide, durationMs: -1 } }))).toBeNull()
    expect(parsePresenterMessage(JSON.stringify({ type: 'instant.show', slide: { kind: 'text', text: 'a'.repeat(2001), shownAt: 1 } }))).toBeNull()
    expect(parsePresenterMessage(JSON.stringify({ type: 'instant.show', slide: { kind: 'link', url: 'javascript:alert(1)', qrSvg: '<svg/>', shownAt: 1 } }))).toBeNull()
  })
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

  test('validates gallery state on slide publish', () => {
    const base = { type: 'slide.publish', slideId: 'slide-4', reveal: 0, focus: null }
    expect(parsePresenterMessage(JSON.stringify({ ...base, lightbox: { open: true, index: 1 } })))
      .toEqual({ ...base, lightbox: { open: true, index: 1 } })
    expect(parsePresenterMessage(JSON.stringify({ ...base, lightbox: { open: true, index: -1 } }))).toBeNull()
    expect(parsePresenterMessage(JSON.stringify({ ...base, lightbox: { open: 'yes', index: 0 } }))).toBeNull()
  })

  test('validates the talk QR overlay flag on slide publish', () => {
    const base = { type: 'slide.publish', slideId: 'slide-4', reveal: 0, focus: null }
    expect(parsePresenterMessage(JSON.stringify({ ...base, talkQr: true }))).toEqual({ ...base, talkQr: true })
    expect(parsePresenterMessage(JSON.stringify({ ...base, talkQr: false }))).toEqual(base)
    expect(parsePresenterMessage(JSON.stringify({ ...base, talkQr: 'yes' }))).toBeNull()
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
