// Boards left open after the talk (ADR-0032 point 7; feedback-boards ticket 06).
//
// End live can keep the session's open boards taking cards: the session is over (phones stop
// following, the presenter socket is gone), but each board that was open at that moment keeps
// accepting cards on the join link until its "closes after" setting runs out (1, 7 or 30 days from
// the end; the board definition's `closesAfterDays`), or until the app closes it ("Close it now").
// The Durable Object's alarm closes a board when its time is up. Everything here is pure and takes
// the time as an argument, so it can be tested with a fake clock.
import type { StoredLiveSession, StoredPoll } from './session-state'

export const DAY_MS = 24 * 60 * 60 * 1_000

/** When each board left open closes, by pollId (ms since the epoch). Absent: no board is left open. */
export type LateBoards = Record<string, number>

/**
 * Why a board left open closed: its time came (`expired`), "Close it now" (`closed`), or a new live
 * session started for the same talk and took over the join link (`superseded`).
 */
export type LateCloseReason = 'expired' | 'closed' | 'superseded'
export type LateClosed = Record<string, { at: number; reason: LateCloseReason }>

function boardPolls(session: StoredLiveSession): StoredPoll[] {
  return Object.values(session.polls).filter((poll) => poll.type === 'board')
}

/**
 * At End live with "Keep it open for late cards": every board poll that is open now stays open until
 * `now + closesAfterDays`. A board that was already closed stays closed. Returns what was kept open
 * (empty when no board was open, and then nothing is recorded on the session).
 */
export function keepBoardsOpen(session: StoredLiveSession, now: number): LateBoards {
  const kept: LateBoards = {}
  for (const poll of boardPolls(session)) {
    if (!poll.open || !poll.board) continue
    kept[poll.pollId] = now + poll.board.closesAfterDays * DAY_MS
  }
  if (Object.keys(kept).length) {
    session.lateBoards = kept
    session.endedAt = now
  }
  return kept
}

/** The boards still taking late cards at `now` (their close time has not come). */
export function openLateBoards(session: StoredLiveSession, now: number): LateBoards {
  if (session.status !== 'closed' || !session.lateBoards) return {}
  return Object.fromEntries(Object.entries(session.lateBoards)
    .filter(([pollId, closesAt]) => closesAt > now && session.polls[pollId]?.open === true && session.polls[pollId]?.type === 'board'))
}

export function lateBoardsOpen(session: StoredLiveSession, now: number): boolean {
  return Object.keys(openLateBoards(session, now)).length > 0
}

/** Whether a card for this board is taken after the talk: the board was left open and is still open. */
export function isOpenLateBoard(session: StoredLiveSession, pollId: string, now: number): boolean {
  return pollId in openLateBoards(session, now)
}

/** Boards whose close time has come but which are still recorded as left open. */
export function dueLateBoards(session: StoredLiveSession, now: number): string[] {
  return Object.entries(session.lateBoards ?? {}).filter(([, closesAt]) => closesAt <= now).map(([pollId]) => pollId)
}

/**
 * Close the named late boards (all of them when `pollIds` is omitted): each board poll stops taking
 * cards and is no longer left open. Cards, groups and hidden flags are kept for the Run. Returns the
 * polls that changed, so the caller can tell their sockets.
 */
export function closeLateBoards(session: StoredLiveSession, pollIds?: string[], reason: LateCloseReason = 'closed', now = Date.now()): StoredPoll[] {
  const late = session.lateBoards ?? {}
  const closing = pollIds ?? Object.keys(late)
  const changed: StoredPoll[] = []
  for (const pollId of closing) {
    if (!(pollId in late)) continue
    delete late[pollId]
    ;(session.lateClosed ??= {})[pollId] = { at: now, reason }
    const poll = session.polls[pollId]
    if (poll?.open) {
      poll.open = false
      changed.push(poll)
    }
  }
  if (!Object.keys(late).length) delete session.lateBoards
  return changed
}

/** When the alarm should next fire for boards left open, or null when none is. */
export function nextLateAlarm(session: StoredLiveSession): number | null {
  const times = Object.values(session.lateBoards ?? {})
  return times.length ? Math.min(...times) : null
}

/** The last moment any late board is open: how long the join link keeps resolving to this session. */
export function lateBoardsUntil(session: StoredLiveSession): number | null {
  const times = Object.values(session.lateBoards ?? {})
  return times.length ? Math.max(...times) : null
}
