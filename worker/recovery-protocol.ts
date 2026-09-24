import {
  parseAudienceMessage, parsePresenterMessage, parsePresenterServerMessage,
  type PollChoice, type PollStateMessage, type PollVoteRecordMessage,
  type PresenterPollMessage, type SlideState, type SlideStateMessage,
} from './protocol'

export const LIVE_PROTOCOL_VERSION = 2
export const LIVE_WORKER_BUILD = '7-integrated-polls'
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
  polls: PollStateMessage[]
  voteRecords?: RecoveredVoteRecord[]
  moreRecords?: boolean
  receipts?: VoteAck[]
}
export type RecoveryClientMessage =
  | { type: 'session.ping'; nonce: string }
  | { type: 'session.sync'; syncId: string; slideState?: SlideState | null; afterSequence?: number }
  | { type: 'operation'; operationId: string; action: PresenterPollMessage }
  | { type: 'vote.submit'; submissionId: string; pollId: string; choice: PollChoice }
export type RecoveryServerMessage =
  | { type: 'session.hello'; protocol: 2; expiresAt: number }
  | { type: 'session.pong'; nonce: string }
  | { type: 'session.closed'; reason?: 'ended' | 'expired' }
  | { type: 'session.superseded' }
  | SessionSnapshot | OperationAck | VoteAck

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
  return { slideId: parsed.slideId, reveal: parsed.reveal, focus: parsed.focus }
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
      return { type: m.type, syncId: m.syncId, slideState: state, afterSequence: m.afterSequence ?? 0 }
    }
    if (m.type === 'operation' && validRecoveryId(m.operationId)) {
      const action = parsePresenterMessage(JSON.stringify(m.action))
      return action && action.type !== 'slide.publish' ? { type: m.type, operationId: m.operationId, action } : null
    }
    if (m.type === 'vote.submit' && validRecoveryId(m.submissionId)) {
      const vote = parseAudienceMessage(JSON.stringify({ ...m, type: 'poll.vote' }))
      return vote ? { type: m.type, submissionId: m.submissionId, pollId: vote.pollId, choice: vote.choice } : null
    }
    return null
  } catch { return null }
}
export function parseVoteAck(m: unknown): VoteAck | null {
  if (!object(m) || m.type !== 'vote.ack' || !validRecoveryId(m.submissionId)
    || typeof m.pollId !== 'string' || !m.pollId
    || (m.status !== 'confirmed' && m.status !== 'rejected')) return null
  const vote = m.choice === undefined ? null : parseAudienceMessage(JSON.stringify({ ...m, type: 'poll.vote' }))
  if (m.status === 'confirmed' && !vote) return null
  return { type: 'vote.ack', submissionId: m.submissionId, pollId: m.pollId, status: m.status,
    ...(typeof m.error === 'string' ? { error: m.error } : {}), ...(vote ? { choice: vote.choice } : {}) }
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
    if (m.type === 'session.hello' && m.protocol === 2 && Number.isFinite(m.expiresAt)) {
      return { type: m.type, protocol: 2, expiresAt: m.expiresAt }
    }
    if (m.type === 'session.pong' && validRecoveryId(m.nonce)) return { type: m.type, nonce: m.nonce }
    if (m.type === 'session.closed') return { type: m.type, reason: m.reason === 'expired' ? 'expired' : 'ended' }
    if (m.type === 'session.superseded') return { type: m.type }
    if (m.type === 'vote.ack') return parseVoteAck(m)
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
    return {
      type: m.type, protocol: 2, syncId: m.syncId, sessionId: m.sessionId, expiresAt: m.expiresAt,
      slideState: state ? { type: 'slide.state', ...state, revision: m.slideState.revision } : null,
      polls: polls as PollStateMessage[],
      ...(records ? { voteRecords: records, moreRecords: m.moreRecords === true } : {}),
      ...(receipts ? { receipts } : {}),
    }
  } catch { return null }
}
