import { addRunPoll, addRunPollResponse, applyRunAudienceFeedback, applyRunBoards, retimeRunPollResponses, applyRunInstantSlides, persistRun, readRun, type RunPoll, type RunPollResponse, type RunQuestion, type RunReaction } from './runs'
import { runBoardFromPollState, type RunBoard } from '../shared/run-board'
import type { SessionRecoveryRecord } from './live-session-store'
import { parseAudienceQuestion, parsePresenterServerMessage, parseReactionRecord, type AudienceQuestion, type PollStateMessage, type ReactionRecord } from '../../worker/protocol'
import { parseRecoveredVoteRecord, type RecoveredVoteRecord } from '../../worker/recovery-protocol'

/**
 * Reactions and questions from phones as the presenter client holds them (ticket 06). They live in
 * memory only — never in the recovery record, which keeps no question text — and are rebuilt from
 * the worker after a reconnect or restart; every flush merges them onto the Run by id.
 */
export interface LiveAudienceFeedback {
  reactionRecords: ReactionRecord[]
  questions: AudienceQuestion[]
}

/** A device time may be this much earlier than the Run's start (a phone that joined as it began). */
export const DEVICE_CLOCK_LEAD_MS = 60_000

/**
 * When a reaction or question happened, in wall-clock ms. The phone's own clock (`deviceMs`) is the
 * only time a reaction queued offline has (ADR-0027 amendment point 4), however long the phone was
 * offline, so it is kept whenever it is plausible: no earlier than a minute before the Run started
 * and no later than when the worker accepted it. A clock outside that (hours ahead or behind) is not
 * believed, and the worker's acceptance time is used instead.
 */
export function feedbackWallClock(deviceMs: number, acceptedAt: number, runStartMs: number): number {
  if (!Number.isFinite(acceptedAt)) return deviceMs
  if (!Number.isFinite(deviceMs) || deviceMs > acceptedAt || (Number.isFinite(runStartMs) && deviceMs < runStartMs - DEVICE_CLOCK_LEAD_MS)) return acceptedAt
  return deviceMs
}

// The session's lists as the flush reads them: a list that is not an array is empty, and an entry
// that is not an object is skipped, so one bad entry never costs the rest of the flush.
function objects<T>(value: unknown): T[] {
  return Array.isArray(value) ? value.filter((entry) => !!entry && typeof entry === 'object' && !Array.isArray(entry)) as T[] : []
}

export function flushLiveSessionHistory(record: SessionRecoveryRecord, feedback?: LiveAudienceFeedback): boolean {
  if (!record.vaultRoot || !record.runId) return false
  const run = readRun(record.vaultRoot, record.talkSlug, record.runId)
  if (!run) return false
  const sessionPolls = objects<PollStateMessage>(record.polls)
  const polls = sessionPolls.map((poll) => ({ id: poll.pollId, ...(poll.slideId ? { slideId: poll.slideId } : {}), type: poll.pollType,
    question: poll.question, options: poll.options, visibility: poll.visibility,
    ...(poll.rankCount !== undefined ? { rankCount: poll.rankCount } : {}),
    ...(poll.labels ? { labels: poll.labels } : {}),
    ...(poll.allowSkip !== undefined ? { allowSkip: poll.allowSkip } : {}),
    ...(poll.maxSelections !== undefined ? { maxSelections: poll.maxSelections } : {}),
    ...(poll.maxSubmissions !== undefined ? { maxSubmissions: poll.maxSubmissions } : {}),
    ...(poll.board ? { board: poll.board } : {}) }))
  const runStartMs = Date.parse(run.startedAt) || record.startedAtMs
  const responses = objects<RecoveredVoteRecord>(record.voteRecords).map((vote) => ({
    responseId: `${record.sessionId}:${vote.sequence}`,
    pollId: vote.pollId, slideId: vote.slideId,
    tMs: Math.max(0, vote.acceptedAt - runStartMs),
    ...(sessionPolls.find((poll) => poll.pollId === vote.pollId)?.pollType === 'open' && typeof vote.choice === 'string'
      ? { text: vote.choice } : { choice: vote.choice }),
  }))
  // Times are offsets from the Run's start, clamped at 0 (feedbackWallClock bounds the phone's clock).
  // `withdrawn` is passed through as sent: the Run's normaliser keeps only exactly `true`.
  const reactions = objects<ReactionRecord>(feedback?.reactionRecords).map((item) => ({
    id: `${record.sessionId}:r${item.sequence}`, reaction: item.reaction, slideId: item.slideId,
    tMs: Math.max(0, feedbackWallClock(item.tMs, item.acceptedAt, runStartMs) - runStartMs),
    ...(item.withdrawn !== undefined ? { withdrawn: item.withdrawn } : {}),
  })) as RunReaction[]
  const questions: RunQuestion[] = objects<AudienceQuestion>(feedback?.questions).map((item) => ({
    id: `${record.sessionId}:${item.questionId}`, text: item.text, ...(item.name ? { name: item.name } : {}),
    slideId: item.slideId, tMs: Math.max(0, feedbackWallClock(item.tMs, item.acceptedAt, runStartMs) - runStartMs), answered: item.answered,
  }))
  // Polls and answers one at a time: an entry the Run refuses is skipped, never the whole flush.
  const withPolls = polls.reduce((current, poll) => { try { return addRunPoll(current, poll as RunPoll) } catch { return current } }, run)
  const withResponses = retimeRunPollResponses(
    responses.reduce((current, response) => { try { return addRunPollResponse(current, response as RunPollResponse) } catch { return current } }, withPolls),
    responses as RunPollResponse[])
  const updated = applyRunBoards(applyRunAudienceFeedback(applyRunInstantSlides(withResponses, record.instantHistory ?? []), { reactions, questions }),
    liveSessionBoards(record))
  if (JSON.stringify(updated) !== JSON.stringify(run)) persistRun(record.vaultRoot, updated)
  return true
}

/**
 * The session's boards as the Run keeps them (feedback-boards ticket 06): each board poll's full
 * presenter view (every card, hidden ones marked; groups with their numbers), with where it stands
 * after the talk — when End live happened, whether it was left open and until when, when the app
 * learned it had closed, and the last pull.
 */
export function liveSessionBoards(record: SessionRecoveryRecord): RunBoard[] {
  return objects<PollStateMessage>(record.polls).flatMap((poll) => {
    const openUntil = record.boardsLeftOpen?.[poll.pollId]
    const closedAt = record.boardsClosedAt?.[poll.pollId]
    const board = runBoardFromPollState(poll, {
      sessionId: record.sessionId,
      ...(record.endedAtMs !== undefined ? { liveEndedAt: record.endedAtMs } : {}),
      ...(openUntil !== undefined ? { openUntil } : {}),
      ...(openUntil !== undefined && closedAt !== undefined ? { closedAt } : {}),
      ...(openUntil !== undefined && closedAt !== undefined && record.boardsClosedReason?.[poll.pollId] ? { closedBy: record.boardsClosedReason[poll.pollId] } : {}),
      liveStartedAt: record.startedAtMs,
      ...(openUntil !== undefined && record.boardsRefreshedAt !== undefined ? { refreshedAt: record.boardsRefreshedAt } : {}),
    })
    return board ? [board] : []
  })
}

/** Boards a recovery page says are still open after End live, with when each closes; undefined when it names none. */
function parseLateBoards(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const entries = Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, number] =>
    entry[0].length > 0 && entry[0].length <= 200 && typeof entry[1] === 'number' && Number.isFinite(entry[1]))
  return Object.fromEntries(entries)
}

const CLOSE_REASONS = new Set(['expired', 'closed', 'superseded'])
/** Boards left open that have closed since, with when and why; malformed entries are dropped. */
function parseClosedBoards(value: unknown): Record<string, { at: number; reason: 'expired' | 'closed' | 'superseded' }> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const entries = Object.entries(value as Record<string, unknown>).flatMap(([pollId, entry]) => {
    const item = entry as { at?: unknown; reason?: unknown } | null
    return pollId.length > 0 && pollId.length <= 200 && item && typeof item.at === 'number' && Number.isFinite(item.at) && CLOSE_REASONS.has(String(item.reason))
      ? [[pollId, { at: item.at, reason: item.reason as 'expired' | 'closed' | 'superseded' }] as const] : []
  })
  return Object.fromEntries(entries)
}

/**
 * "Close it now" for boards left open (History, R3): the worker closes them at once. The presenter
 * token is checked as issued, so this works after the 12-hour live window. A 404 means the session
 * is already gone or no board is open any more: nothing is left to close.
 */
export async function closeLiveBoardsLeftOpen(record: SessionRecoveryRecord, fetchImpl: typeof fetch = fetch): Promise<void> {
  const response = await fetchImpl(`${record.baseUrl}/sessions/${encodeURIComponent(record.sessionId)}/close`, {
    method: 'POST', headers: { authorization: `Bearer ${record.presenterToken}` }, signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok && response.status !== 404) throw new Error('The board could not be closed. Try again.')
}

/** The worker answered that it will never serve this session's history (HTTP 401 or 404). */
export class LiveHistoryGoneError extends Error {
  readonly final = true
  constructor(readonly status: number) { super(`The live session's history is no longer available (HTTP ${status}).`) }
}

/**
 * The ended session's final history from the worker's recovery endpoint, paged to the end: polls,
 * every vote after the record's cursor, every reaction record after `afterReactionSequence`, and the
 * questions (ticket 06). A page that skips a sequence or holds a malformed entry fails the whole
 * recovery, and the manager retries it later. A worker without reactions sends neither field.
 */
export async function recoverFinalLiveHistory(record: SessionRecoveryRecord, afterReactionSequence: number, fetchImpl: typeof fetch = fetch):
  Promise<Pick<SessionRecoveryRecord, 'polls' | 'voteRecords' | 'cursor'> & { reactionRecords: ReactionRecord[]; questions?: AudienceQuestion[]
    lateBoards?: Record<string, number>; endedAt?: number; closedBoards?: Record<string, { at: number; reason: 'expired' | 'closed' | 'superseded' }> }> {
  let cursor = record.cursor
  let reactionCursor = afterReactionSequence
  const voteRecords = [...record.voteRecords]
  const reactionRecords: ReactionRecord[] = []
  while (true) {
    const response = await fetchImpl(`${record.baseUrl}/sessions/${encodeURIComponent(record.sessionId)}/recovery?afterSequence=${cursor}&afterReactionSequence=${reactionCursor}`, {
      headers: { authorization: `Bearer ${record.presenterToken}` }, signal: AbortSignal.timeout(10_000),
    })
    // 401/404: the worker will never serve this session's history (secret rotated, service moved,
    // session gone). That is final; anything else is worth retrying.
    if (response.status === 401 || response.status === 404) throw new LiveHistoryGoneError(response.status)
    if (!response.ok) throw new Error('Final answers could not be recovered yet.')
    const page = await response.json() as { polls: unknown[]; voteRecords: unknown[]; moreRecords: boolean
      questions?: unknown; reactionRecords?: unknown; moreReactionRecords?: boolean; lateBoards?: unknown; endedAt?: unknown; closedBoards?: unknown }
    if (!Array.isArray(page.polls) || !Array.isArray(page.voteRecords)) throw new Error('Invalid final history.')
    const polls = page.polls.map((poll) => parsePresenterServerMessage(JSON.stringify(poll)))
    if (polls.some((poll) => poll?.type !== 'poll.state')) throw new Error('Invalid final polls.')
    for (const value of page.voteRecords) {
      const vote = parseRecoveredVoteRecord(value)
      if (!vote || vote.sequence !== cursor + 1) throw new Error('Incomplete final answer history.')
      if (!voteRecords.some((item) => item.sequence === vote.sequence)) voteRecords.push(vote)
      cursor = vote.sequence
    }
    const pageReactions = Array.isArray(page.reactionRecords) ? page.reactionRecords : []
    for (const value of pageReactions) {
      const reaction = parseReactionRecord(value)
      if (!reaction || reaction.sequence !== reactionCursor + 1) throw new Error('Incomplete final reaction history.')
      reactionRecords.push(reaction)
      reactionCursor = reaction.sequence
    }
    const questions = Array.isArray(page.questions) ? page.questions.map(parseAudienceQuestion) : undefined
    if (questions?.some((question) => !question)) throw new Error('Invalid final questions.')
    const moreVotes = page.moreRecords === true, moreReactions = page.moreReactionRecords === true
    if (!moreVotes && !moreReactions) {
      const lateBoards = parseLateBoards(page.lateBoards)
      const closedBoards = parseClosedBoards(page.closedBoards)
      return { polls: polls as PollStateMessage[], voteRecords, cursor, reactionRecords,
        ...(questions ? { questions: questions as AudienceQuestion[] } : {}),
        ...(lateBoards ? { lateBoards } : {}),
        ...(closedBoards ? { closedBoards } : {}),
        ...(typeof page.endedAt === 'number' && Number.isFinite(page.endedAt) ? { endedAt: page.endedAt } : {}) }
    }
    if ((moreVotes && !page.voteRecords.length) || (moreReactions && !pageReactions.length)) throw new Error('Final history cursor did not advance.')
  }
}
