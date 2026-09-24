import { applyRunPollBuffer, persistRun, readRun } from './runs'
import type { SessionRecoveryRecord } from './live-session-store'

export function flushLiveSessionHistory(record: SessionRecoveryRecord): boolean {
  if (!record.vaultRoot || !record.runId) return false
  const run = readRun(record.vaultRoot, record.talkSlug, record.runId)
  if (!run) return false
  const polls = record.polls.map((poll) => ({ id: poll.pollId, type: poll.pollType,
    question: poll.question, options: poll.options, visibility: poll.visibility,
    ...(poll.rankCount !== undefined ? { rankCount: poll.rankCount } : {}),
    ...(poll.labels ? { labels: poll.labels } : {}),
    ...(poll.allowSkip !== undefined ? { allowSkip: poll.allowSkip } : {}),
    ...(poll.maxSelections !== undefined ? { maxSelections: poll.maxSelections } : {}),
    ...(poll.maxSubmissions !== undefined ? { maxSubmissions: poll.maxSubmissions } : {}) }))
  const responses = record.voteRecords.map((vote) => ({
    responseId: `${record.sessionId}:${vote.sequence}`,
    pollId: vote.pollId, slideId: vote.slideId,
    tMs: Math.max(0, vote.acceptedAt - (Date.parse(run.startedAt) || record.startedAtMs)),
    ...(record.polls.find((poll) => poll.pollId === vote.pollId)?.pollType === 'open' && typeof vote.choice === 'string'
      ? { text: vote.choice } : { choice: vote.choice }),
  }))
  const updated = applyRunPollBuffer(run, { polls, responses })
  if (JSON.stringify(updated) !== JSON.stringify(run)) persistRun(record.vaultRoot, updated)
  return true
}
