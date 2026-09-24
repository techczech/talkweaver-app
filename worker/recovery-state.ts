import type { OperationAck, RecoveredVoteRecord, RecoveryClientMessage, VoteAck } from './recovery-protocol'
import { closePoll, hidePollResponse, openPoll, revealPoll, voteInPoll, type StoredLiveSession } from './session-state'

export interface RecoveryState {
  presenterConnectionId?: string
  operations: Record<string, { fingerprint: string; ack: OperationAck }>
  submissions: Record<string, { fingerprint: string; participantId: string; ack: VoteAck }>
  voteRecords: RecoveredVoteRecord[]
}
export function recoveryState(session: StoredLiveSession): RecoveryState {
  return session.recovery ??= { operations: {}, submissions: {}, voteRecords: [] }
}

export function applyPollOperation(session: StoredLiveSession, message: Extract<RecoveryClientMessage, {type:'operation'}>): OperationAck {
  const recovery = recoveryState(session)
  const key = 'op:' + message.operationId
  const fingerprint = JSON.stringify(message.action)
  const prior = recovery.operations[key]
  if (prior) return prior.fingerprint === fingerprint ? prior.ack
    : { type: 'operation.ack', operationId: message.operationId, status: 'rejected', error: 'operation_id_conflict' }
  let ack: OperationAck
  try {
    const action = message.action
    if (action.type === 'poll.open') openPoll(session, action.poll)
    else if (action.type === 'poll.close') closePoll(session, action.pollId)
    else if (action.type === 'poll.reveal') revealPoll(session, action.pollId)
    else hidePollResponse(session, action.pollId, action.responseId, action.hidden ?? true)
    ack = { type: 'operation.ack', operationId: message.operationId, status: 'confirmed' }
  } catch (error) {
    ack = { type: 'operation.ack', operationId: message.operationId, status: 'rejected',
      error: error instanceof Error ? error.message : 'invalid_poll_action' }
  }
  recovery.operations[key] = { fingerprint, ack }
  return ack
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
