import type { OperationAck, RecoveredVoteRecord, RecoveryClientMessage, VoteAck } from './recovery-protocol'
import { answerQuestion, setAudienceSwitches } from './audience-feedback'
import { applyBoardOperation, ensureBoard } from './board-state'
import type { PresenterBoardMessage } from './board-protocol'
import { closePoll, hidePollResponse, openPoll, revealPoll, setInstantSlide, voteInPoll, type StoredLiveSession } from './session-state'

export interface RecoveryState {
  presenterConnectionId?: string
  operations: Record<string, { fingerprint: string; ack: OperationAck }>
  submissions: Record<string, { fingerprint: string; participantId: string; ack: VoteAck }>
  voteRecords: RecoveredVoteRecord[]
}
export function recoveryState(session: StoredLiveSession): RecoveryState {
  return session.recovery ??= { operations: {}, submissions: {}, voteRecords: [] }
}

/** A compact content digest: a full JSON fingerprint would store big payloads twice in the single session row. */
function digest(text: string): string {
  let first = 2166136261, second = 0x9e3779b9
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    first = Math.imul(first ^ code, 16777619)
    second = Math.imul(second ^ (code + i), 2246822519)
  }
  return `${first >>> 0}:${second >>> 0}`
}

function operationFingerprint(action: Extract<RecoveryClientMessage, {type:'operation'}>['action']): string {
  if (action.type === 'poll.open' && action.poll.seed) {
    // A seeded board's opening cards (pre-work answers) can be large, and every reopen sends them again.
    const { seed, ...poll } = action.poll
    return JSON.stringify({ type: action.type, poll, seed: { cards: seed.length, length: JSON.stringify(seed).length, digest: digest(JSON.stringify(seed)) } })
  }
  if (action.type !== 'instant.show' || action.slide.kind !== 'image') return JSON.stringify(action)
  return JSON.stringify({ type: action.type, kind: 'image', shownAt: action.slide.shownAt,
    width: action.slide.width, height: action.slide.height, length: action.slide.dataUrl.length,
    digest: digest(action.slide.dataUrl) })
}

export function applyPollOperation(session: StoredLiveSession, message: Extract<RecoveryClientMessage, {type:'operation'}>): OperationAck {
  const recovery = recoveryState(session)
  const key = 'op:' + message.operationId
  const fingerprint = operationFingerprint(message.action)
  const prior = recovery.operations[key]
  if (prior) return prior.fingerprint === fingerprint ? prior.ack
    : { type: 'operation.ack', operationId: message.operationId, status: 'rejected', error: 'operation_id_conflict' }
  let ack: OperationAck
  try {
    const action = message.action
    if (action.type === 'poll.open') openPoll(session, action.poll)
    else if (action.type === 'poll.close') closePoll(session, action.pollId)
    else if (action.type === 'poll.reveal') revealPoll(session, action.pollId)
    else if (action.type === 'poll.hide') hidePollResponse(session, action.pollId, action.responseId, action.hidden ?? true)
    else if (action.type === 'instant.show') setInstantSlide(session, action.slide)
    else if (action.type === 'question.answer') answerQuestion(session, action.questionId, action.answered)
    else if (action.type === 'switches.set') setAudienceSwitches(session, action)
    else if (action.type === 'instant.clear') setInstantSlide(session, null)
    else applyBoardAction(session, action)
    ack = { type: 'operation.ack', operationId: message.operationId, status: 'confirmed' }
  } catch (error) {
    ack = { type: 'operation.ack', operationId: message.operationId, status: 'rejected',
      error: error instanceof Error ? error.message : 'invalid_poll_action' }
  }
  recovery.operations[key] = { fingerprint, ack }
  return ack
}

/** A presenter board operation on a board poll of this session; throws the refusal code. */
export function applyBoardAction(session: StoredLiveSession, action: PresenterBoardMessage): void {
  if (session.status !== 'open') throw new Error('Session is closed.')
  const poll = session.polls[action.pollId]
  if (!poll) throw new Error('Poll not found.')
  if (poll.type !== 'board') throw new Error('not_a_board')
  applyBoardOperation(ensureBoard(session, poll), poll, action)
}

export function acceptSubmission(
  session: StoredLiveSession, participantId: string,
  message: Extract<RecoveryClientMessage, {type:'vote.submit'}>, now: number,
): { ack: VoteAck; record?: RecoveredVoteRecord } {
  const recovery = recoveryState(session)
  const key = participantId + ':' + message.submissionId
  const fingerprint = JSON.stringify({ pollId: message.pollId, choice: message.choice })
  const prior = recovery.submissions[key]
  if (prior) return { ack: prior.fingerprint === fingerprint ? prior.ack
    : { type: 'vote.ack', submissionId: message.submissionId, pollId: message.pollId, status: 'rejected', error: 'submission_id_conflict' } }
  let ack: VoteAck
  let record: RecoveredVoteRecord | undefined
  try {
    const definition = session.polls[message.pollId]
    const limit = definition?.type === 'open'
      ? (definition.maxSubmissions === null ? Infinity : definition.maxSubmissions ?? 1) : 1
    const accepted = Object.values(recovery.submissions).filter((r) =>
      r.participantId === participantId && r.ack.pollId === message.pollId && r.ack.status === 'confirmed').length
    if (accepted >= limit) throw new Error(limit === 1 ? 'already_answered' : 'submission_limit_reached')
    // Identity and submission are deliberately distinct: a new socket never creates a new allowance.
    const responseId = 'vote:' + key
    voteInPoll(session, responseId, message.pollId, message.choice)
    const poll = session.polls[message.pollId]
    const choice = poll.votes[responseId]
    record = {
      type: 'poll.vote-record', pollId: message.pollId, choice, submissionId: message.submissionId,
      sequence: recovery.voteRecords.length + 1, acceptedAt: now,
      slideId: poll.slideId ?? session.slideState?.slideId ?? '',
    }
    recovery.voteRecords.push(record)
    ack = { type: 'vote.ack', submissionId: message.submissionId, pollId: message.pollId, status: 'confirmed', choice }
  } catch (error) {
    ack = { type: 'vote.ack', submissionId: message.submissionId, pollId: message.pollId, status: 'rejected',
      error: error instanceof Error ? error.message : 'invalid_poll_vote' }
  }
  recovery.submissions[key] = { fingerprint, participantId, ack }
  return { ack, record }
}
