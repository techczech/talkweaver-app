import {
  parseAudienceFeedbackServerMessage, parseAudienceQuestion, parseAudienceSwitches, parseQuestionInput,
  parseReactionCounts, parseReactionInput, parseReactionRecord,
  type AudienceFeedbackServerMessage, type AudienceQuestion, type AudienceSwitches, type QuestionInput,
  type ReactionCounts, type ReactionInput, type ReactionRecord,
  parseAudienceMessage, parsePresenterMessage, parsePresenterServerMessage,
  type PollChoice, type PollStateMessage, type PollVoteRecordMessage,
  type PresenterMessage, type InstantSlide, type PresenterPollMessage, type SlideState, type SlideStateMessage, parseInstantSlide,
} from './protocol'
import {
  parseCardAck, parseCardAddInput, parseCardEditInput, parseCardWithdrawInput, parseOwnBoardAllowance, parseOwnBoardCard,
  type CardAck, type CardAddInput, type CardEditInput, type CardWithdrawInput, type OwnBoardAllowance, type OwnBoardCard,
} from './board-protocol'

export const LIVE_PROTOCOL_VERSION = 2
export const LIVE_WORKER_BUILD = '19-board-seed'
export interface SessionPresence {
  type: 'session.presence'
  presenterConnected: boolean
  venueScreens: number
}
export function supportsCurrentLiveWorker(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const capabilities = value as { protocol?: unknown; build?: unknown }
  return capabilities.protocol === LIVE_PROTOCOL_VERSION && capabilities.build === LIVE_WORKER_BUILD
}
export type ReceiptStatus = 'confirmed' | 'rejected'
export interface OperationAck {
  type: 'operation.ack'
  operationId: string
  status: ReceiptStatus
  error?: string
}
export interface VoteAck {
  type: 'vote.ack'
  submissionId: string
  pollId: string
  status: ReceiptStatus
  error?: string
  choice?: PollChoice
}
/** Audience only: the sender's receipt for a reaction; retries with the same submissionId repeat it. */
export interface ReactionAck {
  type: 'reaction.ack'
  submissionId: string
  status: ReceiptStatus
  error?: string
}
/** Audience only: the sender's receipt for a question. */
export interface QuestionAck {
  type: 'question.ack'
  submissionId: string
  status: ReceiptStatus
  error?: string
}
export interface RecoveredVoteRecord extends PollVoteRecordMessage {
  sequence: number
  submissionId: string
  acceptedAt: number
  slideId: string
}
export interface SessionSnapshot {
  type: 'session.snapshot'
  protocol: 2
  syncId: string
  sessionId: string
  expiresAt: number
  slideState: SlideStateMessage | null
  instantSlide?: InstantSlide | null
  polls: PollStateMessage[]
  voteRecords?: RecoveredVoteRecord[]
  moreRecords?: boolean
  receipts?: VoteAck[]
  presence?: Omit<SessionPresence, 'type'>
  /** Both roles: the pause switches. */
  switches?: AudienceSwitches
  /** Presenter only: current counts for every slide that has any. */
  reactionCounts?: Record<string, ReactionCounts>
  /** Presenter only: every question. */
  questions?: AudienceQuestion[]
  /** Presenter only: reaction records after `afterReactionSequence`, at most 500. */
  reactionRecords?: ReactionRecord[]
  moreReactionRecords?: boolean
  /** Audience only: the participant's own cards on every board (hidden and withdrawn ones left out). */
  myCards?: OwnBoardCard[]
  /** Audience only: on every board, the participant's cards used (hidden ones included) and the allowance. */
  myBoards?: OwnBoardAllowance[]
}
export type RecoveryClientMessage =
  | { type: 'session.ping'; nonce: string }
  | { type: 'session.sync'; syncId: string; slideState?: SlideState | null; afterSequence?: number; afterReactionSequence?: number }
  | { type: 'operation'; operationId: string; action: Exclude<PresenterMessage, { type: 'slide.publish' }> }
  | { type: 'vote.submit'; submissionId: string; pollId: string; choice: PollChoice }
  | ({ type: 'reaction.send'; submissionId: string } & ReactionInput)
  | ({ type: 'question.submit'; submissionId: string } & QuestionInput)
  /** Board cards: add, edit or withdraw one's own card. */
  | ({ type: 'card.add'; submissionId: string } & CardAddInput)
  | ({ type: 'card.edit'; submissionId: string } & CardEditInput)
  | ({ type: 'card.withdraw'; submissionId: string } & CardWithdrawInput)
  /** A reaction, question or card with a valid submissionId whose body broke a rule: answered with a rejected ack. */
  | { type: 'submission.invalid'; kind: 'reaction.send' | 'question.submit'; submissionId: string; error: string }
  | { type: 'submission.invalid'; kind: 'card.add' | 'card.edit' | 'card.withdraw'; submissionId: string; pollId: string; error: string }
export type RecoveryServerMessage =
  | { type: 'session.hello'; protocol: 2; expiresAt: number }
  | { type: 'session.pong'; nonce: string }
  | { type: 'session.closed'; reason?: 'ended' | 'expired' }
  | { type: 'session.superseded' }
  | SessionSnapshot | SessionPresence | OperationAck | VoteAck | ReactionAck | QuestionAck | CardAck | AudienceFeedbackServerMessage

export function validRecoveryId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(value)
}
function object(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
function slide(value: unknown): SlideState | null {
  if (!object(value)) return null
  const parsed = parsePresenterMessage(JSON.stringify({ ...value, type: 'slide.publish' }))
  if (parsed?.type !== 'slide.publish') return null
  return { slideId: parsed.slideId, reveal: parsed.reveal, focus: parsed.focus,
    ...(parsed.lightbox ? { lightbox: parsed.lightbox } : {}), ...(parsed.talkQr ? { talkQr: true } : {}) }
}
export function parseRecoveryClientMessage(value: string): RecoveryClientMessage | null {
  try {
    if (value.length > 128_000) return null
    const m = JSON.parse(value)
    if (!object(m)) return null
    if (m.type === 'session.ping' && validRecoveryId(m.nonce)) return { type: m.type, nonce: m.nonce }
    if (m.type === 'session.sync' && validRecoveryId(m.syncId)) {
      const state = m.slideState == null ? null : slide(m.slideState)
      if (m.slideState != null && !state) return null
      if (m.afterSequence !== undefined && (!Number.isSafeInteger(m.afterSequence) || m.afterSequence < 0)) return null
      if (m.afterReactionSequence !== undefined && (!Number.isSafeInteger(m.afterReactionSequence) || m.afterReactionSequence < 0)) return null
      return { type: m.type, syncId: m.syncId, slideState: state, afterSequence: m.afterSequence ?? 0,
        afterReactionSequence: m.afterReactionSequence ?? 0 }
    }
    if (m.type === 'operation' && validRecoveryId(m.operationId)) {
      const action = parsePresenterMessage(JSON.stringify(m.action))
      return action && action.type !== 'slide.publish' ? { type: m.type, operationId: m.operationId, action } : null
    }
    if (m.type === 'vote.submit' && validRecoveryId(m.submissionId)) {
      const vote = parseAudienceMessage(JSON.stringify({ ...m, type: 'poll.vote' }))
      return vote?.type === 'poll.vote' ? { type: m.type, submissionId: m.submissionId, pollId: vote.pollId, choice: vote.choice } : null
    }
    if ((m.type === 'reaction.send' || m.type === 'question.submit') && validRecoveryId(m.submissionId)) {
      const parsed = m.type === 'reaction.send' ? parseReactionInput(m) : parseQuestionInput(m)
      if ('error' in parsed) return { type: 'submission.invalid', kind: m.type, submissionId: m.submissionId, error: parsed.error.code }
      return { type: m.type, submissionId: m.submissionId, ...parsed.value } as RecoveryClientMessage
    }
    if ((m.type === 'card.add' || m.type === 'card.edit' || m.type === 'card.withdraw') && validRecoveryId(m.submissionId)) {
      const parsed = m.type === 'card.add' ? parseCardAddInput(m) : m.type === 'card.edit' ? parseCardEditInput(m) : parseCardWithdrawInput(m)
      if ('error' in parsed) {
        return { type: 'submission.invalid', kind: m.type, submissionId: m.submissionId,
          pollId: typeof m.pollId === 'string' ? m.pollId.slice(0, 200) : '', error: parsed.error.code }
      }
      return { type: m.type, submissionId: m.submissionId, ...parsed.value } as RecoveryClientMessage
    }
    return null
  } catch { return null }
}
export function parseVoteAck(m: unknown): VoteAck | null {
  if (!object(m) || m.type !== 'vote.ack' || !validRecoveryId(m.submissionId)
    || typeof m.pollId !== 'string' || !m.pollId
    || (m.status !== 'confirmed' && m.status !== 'rejected')) return null
  const parsed = m.choice === undefined ? null : parseAudienceMessage(JSON.stringify({ ...m, type: 'poll.vote' }))
  const vote = parsed?.type === 'poll.vote' ? parsed : null
  if (m.status === 'confirmed' && !vote) return null
  return { type: 'vote.ack', submissionId: m.submissionId, pollId: m.pollId, status: m.status,
    ...(typeof m.error === 'string' ? { error: m.error } : {}), ...(vote ? { choice: vote.choice } : {}) }
}
function parseFeedbackAck(m: Record<string, any>): ReactionAck | QuestionAck | null {
  if ((m.type !== 'reaction.ack' && m.type !== 'question.ack') || !validRecoveryId(m.submissionId)
    || (m.status !== 'confirmed' && m.status !== 'rejected') || (m.error !== undefined && typeof m.error !== 'string')) return null
  return { type: m.type, submissionId: m.submissionId, status: m.status, ...(typeof m.error === 'string' ? { error: m.error } : {}) }
}
export function parseRecoveredVoteRecord(m: unknown): RecoveredVoteRecord | null {
  if (!object(m)) return null
  const record = parsePresenterServerMessage(JSON.stringify(m))
  if (record?.type !== 'poll.vote-record' || !Number.isSafeInteger(m.sequence) || m.sequence < 1
    || !validRecoveryId(m.submissionId) || !Number.isFinite(m.acceptedAt) || typeof m.slideId !== 'string') return null
  return { ...record, sequence: m.sequence, submissionId: m.submissionId, acceptedAt: m.acceptedAt, slideId: m.slideId }
}
export function parseRecoveryServerMessage(value: string): RecoveryServerMessage | null {
  try {
    const m = JSON.parse(value)
    if (!object(m)) return null
    if (m.type === 'session.presence' && typeof m.presenterConnected === 'boolean'
      && Number.isSafeInteger(m.venueScreens) && m.venueScreens >= 0) {
      return { type: m.type, presenterConnected: m.presenterConnected, venueScreens: m.venueScreens }
    }
    if (m.type === 'session.hello' && m.protocol === 2 && Number.isFinite(m.expiresAt)) {
      return { type: m.type, protocol: 2, expiresAt: m.expiresAt }
    }
    if (m.type === 'session.pong' && validRecoveryId(m.nonce)) return { type: m.type, nonce: m.nonce }
    if (m.type === 'session.closed') return { type: m.type, reason: m.reason === 'expired' ? 'expired' : 'ended' }
    if (m.type === 'session.superseded') return { type: m.type }
    if (m.type === 'vote.ack') return parseVoteAck(m)
    if (m.type === 'reaction.ack' || m.type === 'question.ack') return parseFeedbackAck(m)
    if (m.type === 'card.ack') return parseCardAck(m)
    if (m.type === 'reaction.counts' || m.type === 'questions.state' || m.type === 'switches.state') return parseAudienceFeedbackServerMessage(m)
    if (m.type === 'operation.ack' && validRecoveryId(m.operationId) && (m.status === 'confirmed' || m.status === 'rejected')) {
      return { type: m.type, operationId: m.operationId, status: m.status, ...(typeof m.error === 'string' ? { error: m.error } : {}) }
    }
    if (m.type !== 'session.snapshot' || m.protocol !== 2 || !validRecoveryId(m.syncId)
      || typeof m.sessionId !== 'string' || !Number.isFinite(m.expiresAt) || !Array.isArray(m.polls)) return null
    const state = m.slideState == null ? null : slide(m.slideState)
    if (m.slideState != null && (!state || !Number.isSafeInteger(m.slideState.revision) || m.slideState.revision < 0)) return null
    const polls = m.polls.map((p: unknown) => parsePresenterServerMessage(JSON.stringify(p)))
    if (polls.some((p: any) => p?.type !== 'poll.state')) return null
    if (m.voteRecords !== undefined && !Array.isArray(m.voteRecords)) return null
    const records = m.voteRecords?.map(parseRecoveredVoteRecord)
    if (records?.some((r: any) => !r)) return null
    if (m.receipts !== undefined && !Array.isArray(m.receipts)) return null
    const receipts = m.receipts?.map(parseVoteAck)
    if (receipts?.some((r: any) => !r)) return null
    if (m.presence !== undefined && (!object(m.presence) || typeof m.presence.presenterConnected !== 'boolean'
      || !Number.isSafeInteger(m.presence.venueScreens) || m.presence.venueScreens < 0)) return null
    const instantSlide = m.instantSlide == null ? null : parseInstantSlide(m.instantSlide)
    if (m.instantSlide != null && !instantSlide) return null
    const switches = m.switches === undefined ? undefined : parseAudienceSwitches(m.switches)
    if (switches === null) return null
    let reactionCounts: Record<string, ReactionCounts> | undefined
    if (m.reactionCounts !== undefined) {
      if (!object(m.reactionCounts)) return null
      const entries = Object.entries(m.reactionCounts).map(([slideId, counts]) => [slideId, parseReactionCounts(counts)] as const)
      if (entries.some(([slideId, counts]) => !slideId || !counts)) return null
      reactionCounts = Object.fromEntries(entries) as Record<string, ReactionCounts>
    }
    if (m.questions !== undefined && !Array.isArray(m.questions)) return null
    const questions = m.questions?.map(parseAudienceQuestion)
    if (questions?.some((q: unknown) => !q)) return null
    if (m.reactionRecords !== undefined && !Array.isArray(m.reactionRecords)) return null
    const reactionRecords = m.reactionRecords?.map(parseReactionRecord)
    if (reactionRecords?.some((r: unknown) => !r)) return null
    if (m.myCards !== undefined && !Array.isArray(m.myCards)) return null
    const myCards = m.myCards?.map(parseOwnBoardCard)
    if (myCards?.some((c: unknown) => !c)) return null
    if (m.myBoards !== undefined && !Array.isArray(m.myBoards)) return null
    const myBoards = m.myBoards?.map(parseOwnBoardAllowance)
    if (myBoards?.some((b: unknown) => !b)) return null
    return {
      type: m.type, protocol: 2, syncId: m.syncId, sessionId: m.sessionId, expiresAt: m.expiresAt,
      slideState: state ? { type: 'slide.state', ...state, revision: m.slideState.revision } : null,
      polls: polls as PollStateMessage[],
      instantSlide,
      ...(records ? { voteRecords: records, moreRecords: m.moreRecords === true } : {}),
      ...(receipts ? { receipts } : {}),
      ...(m.presence ? { presence: { presenterConnected: m.presence.presenterConnected, venueScreens: m.presence.venueScreens } } : {}),
      ...(switches ? { switches } : {}),
      ...(reactionCounts ? { reactionCounts } : {}),
      ...(questions ? { questions } : {}),
      ...(reactionRecords ? { reactionRecords, moreReactionRecords: m.moreReactionRecords === true } : {}),
      ...(myCards ? { myCards } : {}),
      ...(myBoards ? { myBoards } : {}),
    }
  } catch { return null }
}
