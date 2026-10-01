import { describe, expect, test } from 'bun:test'
import {
  acceptQuestion, acceptReaction, answerQuestion, audienceFeedback, catchUpOnResume, utf8Length, normaliseAudienceFeedback, questionList,
  reactionCountsBySlide, reactionCountsFor, reactionRecordsAfter, setAudienceSwitches,
} from './audience-feedback'
import { AUDIENCE_FEEDBACK_LIMITS, type ReactionInput } from './protocol'
import { closeSession, createSession } from './session-state'

function session() {
  return createSession({ sessionId: 'session-feedback', shortId: 'abcd', talkSlug: 'talk', createdAt: 0, expiresAt: 60_000 })
}
let counter = 0
function react(s: ReturnType<typeof session>, participant: string, input: Partial<ReactionInput> & { reaction: string }) {
  const full = { slideId: 'slide-1', tMs: 1_000, ...input } as ReactionInput
  return acceptReaction(s, participant, `submission-${++counter}`, full, 5_000)
}

describe('reactions reducer', () => {
  test('one meaning reaction per participant per slide: replace, repeat and withdraw', () => {
    const s = session()
    expect(react(s, 'alice', { reaction: 'puzzled' }).records.map((r) => [r.reaction, r.withdrawn === true])).toEqual([['puzzled', false]])
    expect(reactionCountsFor(s, 'slide-1')).toEqual({ puzzled: 1 })
    // Replacing withdraws the old meaning and adds the new one, so a Run nets correctly.
    const replaced = react(s, 'alice', { reaction: 'helped', tMs: 2_000 })
    expect(replaced.records.map((r) => [r.reaction, r.withdrawn === true, r.tMs])).toEqual([['puzzled', true, 2_000], ['helped', false, 2_000]])
    expect(reactionCountsFor(s, 'slide-1')).toEqual({ helped: 1 })
    // The same reaction again changes nothing and records nothing.
    const repeat = react(s, 'alice', { reaction: 'helped' })
    expect(repeat.ack.status).toBe('confirmed')
    expect(repeat.records).toEqual([])
    // Withdrawing a reaction the participant does not hold is a no-op.
    expect(react(s, 'alice', { reaction: 'puzzled', withdrawn: true }).records).toEqual([])
    expect(reactionCountsFor(s, 'slide-1')).toEqual({ helped: 1 })
    expect(react(s, 'alice', { reaction: 'helped', withdrawn: true }).records).toHaveLength(1)
    expect(reactionCountsFor(s, 'slide-1')).toEqual({})
    // Other participants and other slides are independent.
    react(s, 'alice', { reaction: 'puzzled' })
    react(s, 'bob', { reaction: 'puzzled' })
    react(s, 'bob', { reaction: 'custom:Too fast', slideId: 'slide-2' })
    expect(reactionCountsBySlide(s)).toEqual({ 'slide-1': { puzzled: 2 }, 'slide-2': { 'custom:Too fast': 1 } })
  })

  test('the bookmark is counted independently of the meaning reaction', () => {
    const s = session()
    react(s, 'alice', { reaction: 'puzzled' })
    react(s, 'alice', { reaction: 'bookmark' })
    expect(reactionCountsFor(s, 'slide-1')).toEqual({ puzzled: 1, bookmark: 1 })
    react(s, 'alice', { reaction: 'helped' })
    expect(reactionCountsFor(s, 'slide-1')).toEqual({ helped: 1, bookmark: 1 }, 'replacing a meaning keeps the bookmark')
    expect(react(s, 'alice', { reaction: 'bookmark' }).records).toEqual([], 'a second bookmark is a no-op')
    react(s, 'alice', { reaction: 'helped', withdrawn: true })
    expect(reactionCountsFor(s, 'slide-1')).toEqual({ bookmark: 1 }, 'withdrawing the meaning keeps the bookmark')
    react(s, 'alice', { reaction: 'bookmark', withdrawn: true })
    expect(reactionCountsFor(s, 'slide-1')).toEqual({})
    // Net of the log equals the counts.
    const net: Record<string, number> = {}
    for (const r of reactionRecordsAfter(s)) net[r.reaction] = (net[r.reaction] ?? 0) + (r.withdrawn ? -1 : 1)
    expect(Object.values(net).every((n) => n === 0)).toBe(true)
  })

  test('paused reactions refuse meaning reactions and withdrawals; bookmarks still work', () => {
    const s = session()
    react(s, 'alice', { reaction: 'puzzled' })
    expect(setAudienceSwitches(s, { reactionsAllowed: false })).toEqual({ questionsAllowed: true, reactionsAllowed: false })
    const refused = react(s, 'bob', { reaction: 'helped' })
    expect(refused.ack).toMatchObject({ status: 'rejected', error: 'reactions_paused' })
    expect(react(s, 'alice', { reaction: 'puzzled', withdrawn: true }).ack.error).toBe('reactions_paused')
    expect(react(s, 'bob', { reaction: 'bookmark' }).ack.status).toBe('confirmed')
    expect(reactionCountsFor(s, 'slide-1')).toEqual({ puzzled: 1, bookmark: 1 }, 'counts so far are kept')
    setAudienceSwitches(s, { reactionsAllowed: true })
    expect(react(s, 'bob', { reaction: 'helped' }).ack.status).toBe('confirmed')
  })

  test('a retry with the same submissionId repeats its receipt and counts once', () => {
    const s = session()
    const input = { reaction: 'puzzled', slideId: 'slide-4', tMs: 10 } as const
    const first = acceptReaction(s, 'alice', 'queued-reaction-1', input, 1)
    const retry = acceptReaction(s, 'alice', 'queued-reaction-1', input, 2)
    expect(retry).toEqual({ ack: first.ack, records: [], fresh: false, stored: false })
    expect(reactionRecordsAfter(s)).toHaveLength(1)
    expect(acceptReaction(s, 'alice', 'queued-reaction-1', { ...input, reaction: 'helped' }, 3).ack)
      .toMatchObject({ status: 'rejected', error: 'submission_id_conflict' })
    // Another participant may reuse the same client id.
    expect(acceptReaction(s, 'bob', 'queued-reaction-1', input, 4).fresh).toBe(true)
    // A pause refusal stores no receipt, so the same queued message lands when resent after the resume.
    setAudienceSwitches(s, { reactionsAllowed: false })
    expect(acceptReaction(s, 'carol', 'queued-reaction-2', input, 5).ack.error).toBe('reactions_paused')
    setAudienceSwitches(s, { reactionsAllowed: true })
    const resent = acceptReaction(s, 'carol', 'queued-reaction-2', input, 6)
    expect(resent.ack.status).toBe('confirmed')
    expect(resent.stored).toBe(true)
  })

  test('a late queued reaction keeps its own tMs and slideId', () => {
    const s = session()
    const outcome = acceptReaction(s, 'alice', 'offline-1', { reaction: 'helped', slideId: 'slide-2', tMs: 300 }, 90_000)
    expect(outcome.records).toEqual([{ reaction: 'helped', slideId: 'slide-2', tMs: 300, sequence: 1, acceptedAt: 90_000 }])
    expect(JSON.stringify(s.feedback)).not.toContain('alice')
  })

  test('refuses after the session closes and at the storage limit', () => {
    const s = session()
    closeSession(s)
    expect(react(s, 'alice', { reaction: 'puzzled' }).ack.error).toBe('session_not_live')
    const full = session()
    audienceFeedback(full).storedReactionSubmissions = AUDIENCE_FEEDBACK_LIMITS.reactionSubmissions
    expect(react(full, 'alice', { reaction: 'puzzled' }).ack.error).toBe('reaction_limit_reached')
    expect(react(full, 'alice', { reaction: 'puzzled', withdrawn: true }).ack.status).toBe('confirmed', 'a no-op needs no slot')
  })

  test('the feedback row refuses at its byte limit instead of growing past it', () => {
    const s = session()
    const slideId = 's'.repeat(AUDIENCE_FEEDBACK_LIMITS.slideIdChars)
    const id = (prefix: string, n: number) => (prefix + '-' + n + '-').padEnd(128, 'x')
    const label = (n: number) => 'custom:' + ('é' + n).padEnd(40, 'ü')
    const refusals: Record<string, number> = {}
    let accepted = 0
    // 4,000 alternating custom-label reactions from 20 participants, each within its own 300.
    for (let n = 0; n < 4_000; n++) {
      const participant = id('participant', n % 20)
      const outcome = acceptReaction(s, participant, id('reaction', n), { reaction: label(Math.floor(n / 20) % 2) as any, slideId, tMs: n }, n)
      if (outcome.ack.status === 'confirmed') accepted++
      else refusals[outcome.ack.error!] = (refusals[outcome.ack.error!] ?? 0) + 1
    }
    // 400 maximum-length questions with maximum-length names, in multi-byte text.
    for (let n = 0; n < 400; n++) {
      const outcome = acceptQuestion(s, id('participant', 100 + (n % 20)), id('question', n),
        { text: 'ψ'.repeat(AUDIENCE_FEEDBACK_LIMITS.questionChars), name: 'ñ'.repeat(AUDIENCE_FEEDBACK_LIMITS.nameChars), slideId, tMs: n }, n)
      if (outcome.ack.status !== 'confirmed') refusals[outcome.ack.error!] = (refusals[outcome.ack.error!] ?? 0) + 1
    }
    expect(accepted).toBeGreaterThan(0)
    expect(refusals.reaction_limit_reached).toBeGreaterThan(0)
    expect(refusals.question_limit_reached).toBeGreaterThan(0)
    expect(Object.keys(refusals).sort()).toEqual(['question_limit_reached', 'reaction_limit_reached'])
    expect(utf8Length(JSON.stringify(s.feedback))).toBeLessThanOrEqual(AUDIENCE_FEEDBACK_LIMITS.feedbackRowBytes)
    // Fill with maximum-size reactions from new participants until the first refusal: it changes nothing.
    let refused
    for (let n = 0; n < 1_000 && !refused; n++) {
      const before = JSON.stringify(s.feedback)
      const outcome = acceptReaction(s, id('late', n), id('late-reaction', n), { reaction: label(n) as any, slideId, tMs: n }, n)
      if (outcome.ack.status === 'rejected') {
        refused = outcome.ack.error
        expect(JSON.stringify(s.feedback)).toBe(before)
      }
    }
    expect(refused).toBe('reaction_limit_reached')
    expect(utf8Length(JSON.stringify(s.feedback))).toBeLessThanOrEqual(AUDIENCE_FEEDBACK_LIMITS.feedbackRowBytes)
  })

  test('per-participant caps count only submissions that changed state', () => {
    const s = session()
    // No-ops and refusals are free: the same meaning 400 times, then withdrawals of nothing.
    react(s, 'alice', { reaction: 'puzzled' })
    for (let i = 0; i < 400; i++) expect(react(s, 'alice', { reaction: 'puzzled' }).ack.status).toBe('confirmed')
    setAudienceSwitches(s, { reactionsAllowed: false })
    for (let i = 0; i < 400; i++) expect(react(s, 'alice', { reaction: 'helped' }).ack.error).toBe('reactions_paused')
    setAudienceSwitches(s, { reactionsAllowed: true })
    for (let i = 1; i < AUDIENCE_FEEDBACK_LIMITS.participantReactionSubmissions; i++) {
      expect(react(s, 'alice', { reaction: i % 2 ? 'helped' : 'puzzled' }).ack.status).toBe('confirmed')
    }
    expect(react(s, 'alice', { reaction: 'agree' }).ack.error).toBe('participant_limit_reached')
    expect(react(s, 'bob', { reaction: 'agree' }).ack.status).toBe('confirmed', 'another participant can still react')
    for (let i = 0; i < AUDIENCE_FEEDBACK_LIMITS.participantQuestions; i++) {
      expect(acceptQuestion(s, 'alice', `alice-question-${i}`, { text: `Q${i}`, slideId: 'slide-1', tMs: i }, i).ack.status).toBe('confirmed')
    }
    expect(acceptQuestion(s, 'alice', 'alice-question-over', { text: 'One more', slideId: 'slide-1', tMs: 1 }, 1).ack.error)
      .toBe('participant_limit_reached')
    expect(acceptQuestion(s, 'bob', 'bob-question-1', { text: 'Mine', slideId: 'slide-1', tMs: 1 }, 1).ack.status).toBe('confirmed')
  })

  test('a flood of no-ops and pause refusals from one id stores nothing and blocks nobody', () => {
    const s = session()
    react(s, 'flooder', { reaction: 'puzzled' })
    const bytesAfterFirst = utf8Length(JSON.stringify(s.feedback))
    // 15,000 no-ops with fresh submissionIds: each confirmed, none stored.
    for (let i = 0; i < 15_000; i++) {
      const outcome = react(s, 'flooder', { reaction: 'puzzled' })
      expect(outcome.ack.status).toBe('confirmed')
      expect(outcome.stored).toBe(false)
    }
    // 10,000 refusals during a pause, reactions and questions: each refused, none stored.
    setAudienceSwitches(s, { reactionsAllowed: false, questionsAllowed: false })
    for (let i = 0; i < 5_000; i++) {
      expect(react(s, 'flooder', { reaction: 'helped' }).ack.error).toBe('reactions_paused')
      expect(acceptQuestion(s, 'flooder', `flood-question-${i}`, { text: 'Spam', slideId: 'slide-1', tMs: i }, i).ack.error)
        .toBe('questions_paused')
    }
    setAudienceSwitches(s, { reactionsAllowed: true, questionsAllowed: true })
    expect(utf8Length(JSON.stringify(s.feedback)) - bytesAfterFirst).toBeLessThan(200, 'the row did not grow')
    expect(Object.keys(audienceFeedback(s).reactionReceipts)).toHaveLength(1)
    expect(Object.keys(audienceFeedback(s).questionReceipts)).toHaveLength(0)
    // Changes the flooder can store run into its participant limit; another participant still reacts and asks.
    let limited = false
    for (let i = 0; i < 1_000 && !limited; i++) {
      limited = react(s, 'flooder', { reaction: i % 2 ? 'puzzled' : 'helped' }).ack.error === 'participant_limit_reached'
    }
    expect(limited).toBe(true)
    expect(react(s, 'second', { reaction: 'helped' }).ack.status).toBe('confirmed')
    expect(acceptQuestion(s, 'second', 'second-question-1', { text: 'Mine', slideId: 'slide-1', tMs: 1 }, 1).ack.status).toBe('confirmed')
  })

  test('the per-participant receipt cap refuses without storing a receipt', () => {
    const s = session()
    react(s, 'alice', { reaction: 'puzzled' })
    const participant = Object.keys(audienceFeedback(s).participantSlots)[0]
    audienceFeedback(s).participantSlots[participant].receipts = AUDIENCE_FEEDBACK_LIMITS.participantReceipts
    const receipts = Object.keys(audienceFeedback(s).reactionReceipts).length
    expect(react(s, 'alice', { reaction: 'helped' }).ack.error).toBe('participant_limit_reached')
    expect(acceptQuestion(s, 'alice', 'alice-q', { text: 'Q', slideId: 'slide-1', tMs: 1 }, 1).ack.error).toBe('participant_limit_reached')
    expect(Object.keys(audienceFeedback(s).reactionReceipts)).toHaveLength(receipts)
    expect(Object.keys(audienceFeedback(s).questionReceipts)).toHaveLength(0)
    expect(react(s, 'bob', { reaction: 'helped' }).ack.status).toBe('confirmed')
  })

  test('resuming reactions returns every slide\'s counts and the records made during the pause', () => {
    const s = session()
    react(s, 'alice', { reaction: 'puzzled' })
    expect(catchUpOnResume(s)).toEqual([], 'nothing to catch up while reactions are on')
    setAudienceSwitches(s, { reactionsAllowed: false })
    react(s, 'bob', { reaction: 'bookmark', slideId: 'slide-2' })
    const catchUp = catchUpOnResume(s)
    expect(catchUp.map((slide) => [slide.slideId, slide.counts, slide.records.map((r) => r.reaction)])).toEqual([
      ['slide-1', { puzzled: 1 }, []], ['slide-2', { bookmark: 1 }, ['bookmark']],
    ])
    setAudienceSwitches(s, { reactionsAllowed: true })
    expect(audienceFeedback(s).reactionsPausedAtSequence).toBeUndefined()
  })
})

describe('questions reducer', () => {
  const question = { text: '<i>Why</i> agents?', name: 'Priya', slideId: 'slide-9', tMs: 700 }

  test('stores questions in order, marks answered, and repeats receipts', () => {
    const s = session()
    const first = acceptQuestion(s, 'alice', 'question-sub-1', question, 1_000)
    expect(first.ack).toEqual({ type: 'question.ack', submissionId: 'question-sub-1', status: 'confirmed' })
    expect(first.question).toEqual({ questionId: 'question-1', ...question, acceptedAt: 1_000, answered: false })
    expect(acceptQuestion(s, 'alice', 'question-sub-1', question, 2_000)).toEqual({ ack: first.ack, fresh: false, stored: false })
    acceptQuestion(s, 'bob', 'question-sub-1', { text: 'Second', slideId: 'slide-10', tMs: 800 }, 3_000)
    expect(questionList(s).map((q) => [q.questionId, q.text, q.name ?? null])).toEqual([
      ['question-1', '<i>Why</i> agents?', 'Priya'], ['question-2', 'Second', null],
    ])
    expect(answerQuestion(s, 'question-2', true).answered).toBe(true)
    expect(answerQuestion(s, 'question-2', false).answered).toBe(false)
    expect(() => answerQuestion(s, 'question-9', true)).toThrow('question_not_found')
  })

  test('paused questions are refused; reactions are unaffected', () => {
    const s = session()
    setAudienceSwitches(s, { questionsAllowed: false })
    expect(acceptQuestion(s, 'alice', 'question-sub-2', question, 1).ack).toMatchObject({ status: 'rejected', error: 'questions_paused' })
    expect(questionList(s)).toEqual([])
    expect(react(s, 'alice', { reaction: 'puzzled' }).ack.status).toBe('confirmed')
    setAudienceSwitches(s, { questionsAllowed: true })
    expect(acceptQuestion(s, 'alice', 'question-sub-3', question, 1).ack.status).toBe('confirmed')
  })
})

test('stored feedback normalises to defaults with switches on', () => {
  expect(normaliseAudienceFeedback(undefined)).toEqual({ questionsAllowed: true, reactionsAllowed: true,
    reactions: [], questions: [], reactionReceipts: {}, questionReceipts: {}, storedReactionSubmissions: 0, participantSlots: {} })
  expect(normaliseAudienceFeedback({ reactionsAllowed: false, reactions: 'bad' })).toMatchObject({ reactionsAllowed: false, reactions: [] })
})
