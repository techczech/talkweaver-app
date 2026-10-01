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
import { parseAudienceMessage, parsePresenterMessage, parsePresenterServerMessage, parseQuestionInput, parseReactionInput, type Parsed } from './protocol'

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

  test('parses answered marks and pause switches, and keeps the old emoji messages inert', () => {
    expect(parsePresenterMessage(JSON.stringify({ type: 'question.answer', questionId: 'question-1' })))
      .toEqual({ type: 'question.answer', questionId: 'question-1', answered: true })
    expect(parsePresenterMessage(JSON.stringify({ type: 'question.answer', questionId: 'question-1', answered: false })))
      .toEqual({ type: 'question.answer', questionId: 'question-1', answered: false })
    expect(parsePresenterMessage(JSON.stringify({ type: 'question.answer', questionId: '' }))).toBeNull()
    expect(parsePresenterMessage(JSON.stringify({ type: 'question.answer', questionId: 'q', answered: 'yes' }))).toBeNull()
    expect(parsePresenterMessage(JSON.stringify({ type: 'switches.set', reactionsAllowed: false })))
      .toEqual({ type: 'switches.set', reactionsAllowed: false })
    expect(parsePresenterMessage(JSON.stringify({ type: 'switches.set', questionsAllowed: true, reactionsAllowed: false })))
      .toEqual({ type: 'switches.set', questionsAllowed: true, reactionsAllowed: false })
    expect(parsePresenterMessage(JSON.stringify({ type: 'switches.set' }))).toBeNull()
    expect(parsePresenterMessage(JSON.stringify({ type: 'switches.set', reactionsAllowed: 'off' }))).toBeNull()
    expect(parsePresenterMessage(JSON.stringify({ type: 'reaction.echo', emoji: '👍' }))).toBeNull()
    expect(parseAudienceMessage(JSON.stringify({ type: 'reaction.send', emoji: '👍' }))).toBeNull()
  })

  test('rejects malformed slide events', () => {
    expect(parsePresenterMessage(JSON.stringify({ type: 'slide.publish', slideId: '', reveal: -1 }))).toBeNull()
    expect(parsePresenterMessage(JSON.stringify({
      type: 'slide.publish', slideId: 'slide-4', reveal: 0, focus: { kind: 'blur', step: 1 },
    }))).toBeNull()
    expect(parsePresenterMessage('not json')).toBeNull()
  })
})

describe('reactions and questions', () => {
  const reaction = { reaction: 'puzzled', slideId: 'slide-3', tMs: 41_000 }
  const code = (parsed: Parsed<unknown>) => 'error' in parsed ? parsed.error.code : 'ok'

  test('accepts registered identifiers, custom labels, bookmarks and withdrawals', () => {
    for (const id of ['puzzled', 'helped', 'bookmark', 'agree', 'disagree', 'yes', 'no', 'more', 'slower']) {
      expect(parseReactionInput({ ...reaction, reaction: id })).toEqual({ value: { ...reaction, reaction: id } })
    }
    expect(parseReactionInput({ ...reaction, reaction: 'custom:  Too fast ' })).toEqual({ value: { ...reaction, reaction: 'custom:Too fast' } })
    expect(parseReactionInput({ ...reaction, reaction: 'custom:' + 'x'.repeat(40) })).toMatchObject({ value: {} })
    expect(parseReactionInput({ ...reaction, withdrawn: true })).toEqual({ value: { ...reaction, withdrawn: true } })
    expect(parseReactionInput({ ...reaction, withdrawn: false })).toEqual({ value: reaction })
    expect(parseAudienceMessage(JSON.stringify({ type: 'reaction.send', ...reaction, reaction: 'bookmark' })))
      .toEqual({ type: 'reaction.send', ...reaction, reaction: 'bookmark' })
  })

  test('rejects bad reactions with a reason', () => {
    expect(code(parseReactionInput({ ...reaction, reaction: 'thumbs-up' }))).toBe('unknown_reaction')
    expect(code(parseReactionInput({ ...reaction, reaction: '👍' }))).toBe('unknown_reaction')
    expect(code(parseReactionInput({ ...reaction, reaction: 'Puzzled' }))).toBe('unknown_reaction')
    expect(code(parseReactionInput({ ...reaction, reaction: 'custom:' + 'x'.repeat(41) }))).toBe('invalid_custom_label')
    expect(code(parseReactionInput({ ...reaction, reaction: 'custom:   ' }))).toBe('invalid_custom_label')
    expect(code(parseReactionInput({ reaction: 'puzzled', tMs: 1 }))).toBe('missing_slide_id')
    expect(code(parseReactionInput({ ...reaction, slideId: '' }))).toBe('missing_slide_id')
    expect(code(parseReactionInput({ ...reaction, slideId: 's'.repeat(101) }))).toBe('invalid_slide_id')
    expect(code(parseReactionInput({ ...reaction, tMs: -1 }))).toBe('invalid_time')
    expect(code(parseReactionInput({ ...reaction, tMs: 1.5 }))).toBe('invalid_time')
    expect(code(parseReactionInput({ ...reaction, withdrawn: 'yes' }))).toBe('invalid_withdrawn')
    expect(parseAudienceMessage(JSON.stringify({ type: 'reaction.send', ...reaction, reaction: 'nope' }))).toBeNull()
  })

  test('questions are trimmed untrusted text with bounded name, HTML kept as text', () => {
    const question = { text: '  <b>Why</b> <script>alert(1)</script>?  ', name: ' Priya ', slideId: 'slide-9', tMs: 5 }
    expect(parseQuestionInput(question)).toEqual({ value: {
      text: '<b>Why</b> <script>alert(1)</script>?', name: 'Priya', slideId: 'slide-9', tMs: 5 } })
    expect(parseQuestionInput({ ...question, name: '   ' })).toEqual({ value: {
      text: '<b>Why</b> <script>alert(1)</script>?', slideId: 'slide-9', tMs: 5 } })
    expect(parseQuestionInput({ ...question, text: 'q'.repeat(500) })).toMatchObject({ value: { text: 'q'.repeat(500) } })
    expect(code(parseQuestionInput({ ...question, text: 'q'.repeat(501) }))).toBe('question_too_long')
    expect(code(parseQuestionInput({ ...question, text: '   ' }))).toBe('empty_question')
    expect(code(parseQuestionInput({ ...question, text: 42 }))).toBe('empty_question')
    expect(code(parseQuestionInput({ ...question, name: 'n'.repeat(61) }))).toBe('name_too_long')
    expect(code(parseQuestionInput({ ...question, name: 7 }))).toBe('invalid_name')
    expect(code(parseQuestionInput({ ...question, slideId: undefined }))).toBe('missing_slide_id')
    expect(code(parseQuestionInput({ ...question, tMs: 'now' }))).toBe('invalid_time')
  })

  test('recovery client messages carry a submissionId; a bad body becomes a rejectable invalid submission', () => {
    expect(parseRecoveryClientMessage(JSON.stringify({ type: 'reaction.send', submissionId: 'reaction-0001', ...reaction })))
      .toEqual({ type: 'reaction.send', submissionId: 'reaction-0001', ...reaction })
    expect(parseRecoveryClientMessage(JSON.stringify({ type: 'question.submit', submissionId: 'question-0001',
      text: ' Hi ', slideId: 'slide-1', tMs: 0 })))
      .toEqual({ type: 'question.submit', submissionId: 'question-0001', text: 'Hi', slideId: 'slide-1', tMs: 0 })
    expect(parseRecoveryClientMessage(JSON.stringify({ type: 'reaction.send', submissionId: 'reaction-0002', ...reaction, reaction: 'wow' })))
      .toEqual({ type: 'submission.invalid', kind: 'reaction.send', submissionId: 'reaction-0002', error: 'unknown_reaction' })
    expect(parseRecoveryClientMessage(JSON.stringify({ type: 'question.submit', submissionId: 'question-0002', text: 'x'.repeat(501), slideId: 's', tMs: 0 })))
      .toEqual({ type: 'submission.invalid', kind: 'question.submit', submissionId: 'question-0002', error: 'question_too_long' })
    expect(parseRecoveryClientMessage(JSON.stringify({ type: 'reaction.send', submissionId: 'short', ...reaction }))).toBeNull()
    expect(parseRecoveryClientMessage(JSON.stringify({ type: 'session.sync', syncId: 'sync-reactions', afterReactionSequence: 3 })))
      .toMatchObject({ afterReactionSequence: 3 })
    expect(parseRecoveryClientMessage(JSON.stringify({ type: 'session.sync', syncId: 'sync-reactions', afterReactionSequence: -1 }))).toBeNull()
  })

  test('recovery server messages: acks, presenter counts and questions, switches, snapshot fields', () => {
    const ack = { type: 'reaction.ack', submissionId: 'reaction-0001', status: 'rejected', error: 'reactions_paused' }
    expect(parseRecoveryServerMessage(JSON.stringify(ack))).toEqual(ack)
    expect(parseRecoveryServerMessage(JSON.stringify({ type: 'question.ack', submissionId: 'question-0001', status: 'confirmed' })))
      .toEqual({ type: 'question.ack', submissionId: 'question-0001', status: 'confirmed' })
    const record = { ...reaction, sequence: 1, acceptedAt: 99 }
    const counts = { type: 'reaction.counts', slideId: 'slide-3', counts: { puzzled: 2, bookmark: 1 }, records: [record] }
    expect(parseRecoveryServerMessage(JSON.stringify(counts))).toEqual(counts)
    expect(parseRecoveryServerMessage(JSON.stringify({ ...counts, counts: { puzzled: 0 } }))).toBeNull()
    expect(parseRecoveryServerMessage(JSON.stringify({ ...counts, counts: { '👍': 1 } }))).toBeNull()
    const question = { questionId: 'question-1', text: 'Why?', slideId: 'slide-3', tMs: 4, acceptedAt: 5, answered: false }
    expect(parseRecoveryServerMessage(JSON.stringify({ type: 'questions.state', questions: [question] })))
      .toEqual({ type: 'questions.state', questions: [question] })
    expect(parseRecoveryServerMessage(JSON.stringify({ type: 'switches.state', questionsAllowed: false, reactionsAllowed: true })))
      .toEqual({ type: 'switches.state', questionsAllowed: false, reactionsAllowed: true })
    const snapshot = { type: 'session.snapshot', protocol: 2, syncId: 'sync-feedback', sessionId: 'session-one',
      expiresAt: 1, slideState: null, polls: [], switches: { questionsAllowed: true, reactionsAllowed: false },
      reactionCounts: { 'slide-3': { puzzled: 1 } }, questions: [question], reactionRecords: [record], moreReactionRecords: false }
    expect(parseRecoveryServerMessage(JSON.stringify(snapshot))).toMatchObject(snapshot)
    expect(parseRecoveryServerMessage(JSON.stringify({ ...snapshot, questions: [{ ...question, answered: 'no' }] }))).toBeNull()
  })
})
