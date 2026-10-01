import {
  AUDIENCE_FEEDBACK_LIMITS,
  type AudienceQuestion, type AudienceSwitches, type QuestionInput, type ReactionCounts, type ReactionId,
  type ReactionInput, type ReactionRecord,
} from './protocol.ts'
import type { QuestionAck, ReactionAck, ReceiptStatus } from './recovery-protocol'
import type { StoredLiveSession } from './session-state'

// Reactions and questions for one live session (ADR-0027 with its 2026-09-29 amendment).
//
// The reaction log is the truth: it holds only accepted changes, in order, so replaying it gives
// each participant's current meaning reaction and bookmark on each slide, and the Run can net it.
// Participants and receipts are stored as compact hashes to keep the feedback row small.

interface StoredReaction extends ReactionRecord {
  /** Hash of the participant id. Never sent to any client. */
  participant: string
}

interface StoredReceipt {
  fingerprint: string
  status: ReceiptStatus
  error?: string
}

/**
 * Accepted-and-stored submissions of one participant (hashed id), and the receipts stored for them.
 * No-ops and pause refusals store nothing and count nothing.
 */
interface ParticipantSlots {
  reactions: number
  questions: number
  receipts?: number
}

export interface AudienceFeedbackState extends AudienceSwitches {
  reactions: StoredReaction[]
  questions: AudienceQuestion[]
  reactionReceipts: Record<string, StoredReceipt>
  questionReceipts: Record<string, StoredReceipt>
  /** Reaction submissions that changed state, session-wide. */
  storedReactionSubmissions: number
  participantSlots: Record<string, ParticipantSlots>
  /** The reaction log's length when reactions were paused; absent while they are on. */
  reactionsPausedAtSequence?: number
}

export function emptyAudienceFeedback(): AudienceFeedbackState {
  return { questionsAllowed: true, reactionsAllowed: true, reactions: [], questions: [], reactionReceipts: {}, questionReceipts: {},
    storedReactionSubmissions: 0, participantSlots: {} }
}

/** Read back a stored feedback row; anything missing or malformed takes its default. */
export function normaliseAudienceFeedback(value: unknown): AudienceFeedbackState {
  const stored = value && typeof value === 'object' && !Array.isArray(value) ? value as Partial<AudienceFeedbackState> : {}
  const record = (candidate: unknown) => candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? candidate as Record<string, StoredReceipt> : {}
  return {
    questionsAllowed: stored.questionsAllowed !== false,
    reactionsAllowed: stored.reactionsAllowed !== false,
    reactions: Array.isArray(stored.reactions) ? stored.reactions : [],
    questions: Array.isArray(stored.questions) ? stored.questions : [],
    reactionReceipts: record(stored.reactionReceipts),
    questionReceipts: record(stored.questionReceipts),
    storedReactionSubmissions: Number.isSafeInteger(stored.storedReactionSubmissions) ? Number(stored.storedReactionSubmissions) : 0,
    participantSlots: record(stored.participantSlots) as unknown as Record<string, ParticipantSlots>,
    ...(Number.isSafeInteger(stored.reactionsPausedAtSequence) ? { reactionsPausedAtSequence: Number(stored.reactionsPausedAtSequence) } : {}),
  }
}

export function audienceFeedback(session: StoredLiveSession): AudienceFeedbackState {
  return session.feedback ??= emptyAudienceFeedback()
}

export function audienceSwitches(session: StoredLiveSession): AudienceSwitches {
  const { questionsAllowed, reactionsAllowed } = audienceFeedback(session)
  return { questionsAllowed, reactionsAllowed }
}

export function setAudienceSwitches(
  session: StoredLiveSession, patch: Partial<AudienceSwitches>,
): AudienceSwitches {
  ensureOpen(session)
  const feedback = audienceFeedback(session)
  rowBytes.delete(feedback)
  if (typeof patch.questionsAllowed === 'boolean') feedback.questionsAllowed = patch.questionsAllowed
  if (typeof patch.reactionsAllowed === 'boolean' && patch.reactionsAllowed !== feedback.reactionsAllowed) {
    feedback.reactionsAllowed = patch.reactionsAllowed
    if (patch.reactionsAllowed) delete feedback.reactionsPausedAtSequence
    else feedback.reactionsPausedAtSequence = feedback.reactions.length
  }
  return audienceSwitches(session)
}

/**
 * Counts and records for the presenter to catch up on when reactions resume: while paused, bookmarks
 * are stored but their counts are not sent (ADR-0027 amendment point 2). Call before the resuming
 * `setAudienceSwitches`; empty when reactions are on. One entry per slide that has counts or a
 * record made during the pause.
 */
export function catchUpOnResume(session: StoredLiveSession): Array<{ slideId: string; counts: ReactionCounts; records: ReactionRecord[] }> {
  const feedback = audienceFeedback(session)
  if (feedback.reactionsAllowed) return []
  const since = reactionRecordsAfter(session, feedback.reactionsPausedAtSequence ?? 0)
  const bySlide = reactionCountsBySlide(session)
  const slideIds = [...new Set([...Object.keys(bySlide), ...since.map((record) => record.slideId)])]
  return slideIds.map((slideId) => ({ slideId, counts: bySlide[slideId] ?? {},
    records: since.filter((record) => record.slideId === slideId) }))
}

export function answerQuestion(session: StoredLiveSession, questionId: string, answered: boolean): AudienceQuestion {
  ensureOpen(session)
  const feedback = audienceFeedback(session)
  const question = feedback.questions.find((candidate) => candidate.questionId === questionId)
  if (!question) throw new Error('question_not_found')
  rowBytes.delete(feedback)
  question.answered = answered
  return { ...question }
}

export function questionList(session: StoredLiveSession): AudienceQuestion[] {
  return audienceFeedback(session).questions.map((question) => ({ ...question }))
}

export function reactionRecordsAfter(session: StoredLiveSession, afterSequence = 0): ReactionRecord[] {
  return audienceFeedback(session).reactions.filter((record) => record.sequence > afterSequence).map(publicRecord)
}

export function reactionCountsFor(session: StoredLiveSession, slideId: string): ReactionCounts {
  return reactionCountsBySlide(session)[slideId] ?? {}
}

/** Counts for every slide someone currently holds a reaction on. */
export function reactionCountsBySlide(session: StoredLiveSession): Record<string, ReactionCounts> {
  const held = new Map<string, { meaning?: ReactionId; bookmark: boolean }>()
  for (const record of audienceFeedback(session).reactions) {
    const key = record.participant + '\u0000' + record.slideId
    const current = held.get(key) ?? { bookmark: false }
    applyToHeld(current, record)
    held.set(key, current)
  }
  const counts: Record<string, ReactionCounts> = {}
  for (const [key, current] of held) {
    const slideId = key.slice(key.indexOf('\u0000') + 1)
    for (const reaction of [current.meaning, current.bookmark ? 'bookmark' : undefined]) {
      if (!reaction) continue
      const slide = counts[slideId] ??= {}
      slide[reaction] = (slide[reaction] ?? 0) + 1
    }
  }
  return counts
}

export interface ReactionOutcome {
  ack: ReactionAck
  /** Records this submission appended (0–2: a replaced meaning is withdrawn, then the new one added). */
  records: ReactionRecord[]
  /** False when the submissionId was seen before; the ack is the original receipt. */
  fresh: boolean
  /** True when this submission changed the stored state (records and a receipt). */
  stored: boolean
}

/**
 * One meaning reaction per participant per slide: a new one replaces the previous, the same one
 * again is a no-op, a withdrawal clears it only while it is held. The bookmark is independent of
 * that rule and of the pause switch. A retry with a known submissionId repeats its receipt.
 */
export function acceptReaction(
  session: StoredLiveSession, participantId: string, submissionId: string, input: ReactionInput, now: number,
): ReactionOutcome {
  const feedback = audienceFeedback(session)
  const reply = (status: ReceiptStatus, error?: string): ReactionAck =>
    ({ type: 'reaction.ack', submissionId, status, ...(error ? { error } : {}) })
  const receiptKey = compactHash('reaction\u0000' + participantId + '\u0000' + submissionId)
  const fingerprint = compactHash(JSON.stringify([input.reaction, input.slideId, input.tMs, input.withdrawn === true]))
  const prior = feedback.reactionReceipts[receiptKey]
  if (prior) {
    return { fresh: false, stored: false, records: [],
      ack: prior.fingerprint === fingerprint ? reply(prior.status, prior.error) : reply('rejected', 'submission_id_conflict') }
  }
  const refuse = (reason: string): ReactionOutcome => ({ fresh: true, stored: false, records: [], ack: reply('rejected', reason) })
  if (session.status !== 'open') return refuse('session_not_live')
  // Decide everything first; state changes only once the submission is known to fit.
  const participant = compactHash('participant\u0000' + participantId)
  const planned: StoredReaction[] = []
  let status: ReceiptStatus = 'confirmed'
  let error: string | undefined
  if (input.reaction !== 'bookmark' && !feedback.reactionsAllowed) {
    status = 'rejected'
    error = 'reactions_paused'
  } else {
    const current = { bookmark: false } as { meaning?: ReactionId; bookmark: boolean }
    for (const record of feedback.reactions) {
      if (record.participant === participant && record.slideId === input.slideId) applyToHeld(current, record)
    }
    const plan = (reaction: ReactionId, withdrawn: boolean) => planned.push({ participant,
      sequence: feedback.reactions.length + planned.length + 1, reaction, slideId: input.slideId, tMs: input.tMs,
      ...(withdrawn ? { withdrawn: true as const } : {}), acceptedAt: now })
    if (input.reaction === 'bookmark') {
      if (current.bookmark === (input.withdrawn === true)) plan('bookmark', input.withdrawn === true)
    } else if (input.withdrawn) {
      if (current.meaning === input.reaction) plan(input.reaction, true)
    } else if (current.meaning !== input.reaction) {
      if (current.meaning) plan(current.meaning, true)
      plan(input.reaction, false)
    }
  }
  // A pause refusal or a no-op stores nothing, not even a receipt: a retry recomputes its answer, so a
  // queued reaction refused during a pause lands when it is resent after the resume.
  if (error) return refuse(error)
  if (!planned.length) return { fresh: true, stored: false, records: [], ack: reply('confirmed') }
  const slots = feedback.participantSlots[participant] ?? { reactions: 0, questions: 0 }
  if (slots.reactions >= AUDIENCE_FEEDBACK_LIMITS.participantReactionSubmissions
    || (slots.receipts ?? 0) >= AUDIENCE_FEEDBACK_LIMITS.participantReceipts) return refuse('participant_limit_reached')
  if (feedback.storedReactionSubmissions >= AUDIENCE_FEEDBACK_LIMITS.reactionSubmissions) return refuse('reaction_limit_reached')
  const receipt: StoredReceipt = { fingerprint, status }
  if (!fitsFeedbackRow(feedback, [planned, receiptKey, receipt, participant, slots])) return refuse('reaction_limit_reached')
  feedback.reactions.push(...planned)
  feedback.storedReactionSubmissions += 1
  feedback.participantSlots[participant] = { ...slots, reactions: slots.reactions + 1, receipts: (slots.receipts ?? 0) + 1 }
  feedback.reactionReceipts[receiptKey] = receipt
  return { fresh: true, stored: true, records: planned.map(publicRecord), ack: reply(status) }
}

export interface QuestionOutcome {
  ack: QuestionAck
  question?: AudienceQuestion
  fresh: boolean
  /** True when the question and its receipt were stored. */
  stored: boolean
}

export function acceptQuestion(
  session: StoredLiveSession, participantId: string, submissionId: string, input: QuestionInput, now: number,
): QuestionOutcome {
  const feedback = audienceFeedback(session)
  const reply = (status: ReceiptStatus, error?: string): QuestionAck =>
    ({ type: 'question.ack', submissionId, status, ...(error ? { error } : {}) })
  const receiptKey = compactHash('question\u0000' + participantId + '\u0000' + submissionId)
  const fingerprint = compactHash(JSON.stringify([input.text, input.name ?? null, input.slideId, input.tMs]))
  const prior = feedback.questionReceipts[receiptKey]
  if (prior) {
    return { fresh: false, stored: false,
      ack: prior.fingerprint === fingerprint ? reply(prior.status, prior.error) : reply('rejected', 'submission_id_conflict') }
  }
  const refuse = (reason: string): QuestionOutcome => ({ fresh: true, stored: false, ack: reply('rejected', reason) })
  if (session.status !== 'open') return refuse('session_not_live')
  // Paused: no receipt, so the same question resent after the resume is accepted.
  if (!feedback.questionsAllowed) return refuse('questions_paused')
  const participant = compactHash('participant\u0000' + participantId)
  const slots = feedback.participantSlots[participant] ?? { reactions: 0, questions: 0 }
  if (slots.questions >= AUDIENCE_FEEDBACK_LIMITS.participantQuestions
    || (slots.receipts ?? 0) >= AUDIENCE_FEEDBACK_LIMITS.participantReceipts) return refuse('participant_limit_reached')
  if (feedback.questions.length >= AUDIENCE_FEEDBACK_LIMITS.questions) return refuse('question_limit_reached')
  const question: AudienceQuestion = { questionId: `question-${feedback.questions.length + 1}`, text: input.text,
    ...(input.name ? { name: input.name } : {}), slideId: input.slideId, tMs: input.tMs, acceptedAt: now, answered: false }
  const receipt: StoredReceipt = { fingerprint, status: 'confirmed' }
  if (!fitsFeedbackRow(feedback, [question, receiptKey, receipt, participant, slots])) return refuse('question_limit_reached')
  feedback.questions.push(question)
  feedback.participantSlots[participant] = { ...slots, questions: slots.questions + 1, receipts: (slots.receipts ?? 0) + 1 }
  feedback.questionReceipts[receiptKey] = receipt
  return { fresh: true, stored: true, ack: reply('confirmed'), question: { ...question } }
}

/**
 * Whether the row still fits once `additions` are stored. Measured in UTF-8 bytes before any change,
 * so a refusal never leaves memory ahead of storage. The additions' JSON over-counts their share of
 * the row (brackets, key quotes), which errs on the safe side; 256 bytes cover separators.
 */
function fitsFeedbackRow(feedback: AudienceFeedbackState, additions: unknown): boolean {
  const added = utf8Length(JSON.stringify(additions)) + 256
  let size = rowBytes.get(feedback)
  // The running figure over-counts; measure exactly before refusing (at most once per change).
  if (!size || (!size.exact && size.bytes + added > AUDIENCE_FEEDBACK_LIMITS.feedbackRowBytes)) {
    size = { bytes: utf8Length(JSON.stringify(feedback)), exact: true }
    rowBytes.set(feedback, size)
  }
  if (size.bytes + added > AUDIENCE_FEEDBACK_LIMITS.feedbackRowBytes) return false
  // Callers store the additions straight after a true answer; keep an upper bound for the next check.
  rowBytes.set(feedback, { bytes: size.bytes + added, exact: false })
  return true
}

/**
 * An upper bound (or exact size) of each state's serialised row, so a check rarely re-serialises it. Not stored.
 * Any code that mutates an AudienceFeedbackState in place outside this reducer must call
 * `rowBytes.delete(state)` (as setAudienceSwitches and answerQuestion do), or the bound goes stale and
 * the row can outgrow its limit.
 */
const rowBytes = new WeakMap<AudienceFeedbackState, { bytes: number; exact: boolean }>()

export function utf8Length(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) { bytes += 4; i++ }
    else bytes += 3
  }
  return bytes
}

function applyToHeld(current: { meaning?: ReactionId; bookmark: boolean }, record: ReactionRecord): void {
  if (record.reaction === 'bookmark') current.bookmark = !record.withdrawn
  else if (!record.withdrawn) current.meaning = record.reaction
  else if (current.meaning === record.reaction) current.meaning = undefined
}

function publicRecord(record: StoredReaction | ReactionRecord): ReactionRecord {
  return { reaction: record.reaction, slideId: record.slideId, tMs: record.tMs,
    ...(record.withdrawn ? { withdrawn: true as const } : {}), sequence: record.sequence, acceptedAt: record.acceptedAt }
}

function ensureOpen(session: StoredLiveSession): void {
  if (session.status !== 'open') throw new Error('Session is closed.')
}

/** 64-bit FNV-style digest, as hex. Keys stay short whatever length the client's ids are. */
export function compactHash(text: string): string {
  let first = 0x811c9dc5, second = 0x9e3779b9
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    first = Math.imul(first ^ code, 16777619)
    second = Math.imul(second ^ (code + i), 2246822519)
  }
  return (first >>> 0).toString(16).padStart(8, '0') + (second >>> 0).toString(16).padStart(8, '0')
}
