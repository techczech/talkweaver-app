// What a Run's read-only share link shows (feedback-boards ticket 06, R6 and R7), built from the Run.
// Shared by main (the push) and History (the dialog's lines), so it carries no Node or DOM code.
//
// Invariants: a hidden card, a name, or anything that marks a participant is never in the push (the
// Worker refuses a push that carries one); open-answer text is not shared, because a response the
// presenter hid during the talk is not marked on the Run; pre-work is off by default and, until the
// Run keeps pre-work answers, cannot be ticked.
import type { RunSharePush } from '../../worker/run-share-state.ts'
import { isValidShareDomain } from './shared-talk.ts'
import { runBoardState, runBoardView, type RunBoard } from './run-board.ts'
import { runPollSummaries, type RunPollLike, type RunPollResponseLike, type RunPollSummary } from './run-poll-results.ts'

export type RunShareLifetime = '7' | '30' | 'forever'
export const RUN_SHARE_LIFETIMES: RunShareLifetime[] = ['7', '30', 'forever']
export const DEFAULT_RUN_SHARE_LIFETIME: RunShareLifetime = '30'

export interface RunShareInclude {
  board: boolean
  polls: boolean
  prework: boolean
}
export const DEFAULT_RUN_SHARE_INCLUDE: RunShareInclude = { board: true, polls: true, prework: false }

export interface RunLike {
  talkTitle: string
  eventTitle?: string
  audience?: string
  startedAt: string
  plannedDate?: string
  boards?: RunBoard[]
  polls?: RunPollLike[]
  pollResponses?: RunPollResponseLike[]
}

const DAY_MS = 24 * 60 * 60 * 1_000

export function runShareExpiresAt(lifetime: RunShareLifetime, now: number): number | null {
  return lifetime === 'forever' ? null : now + Number(lifetime) * DAY_MS
}

/** The link: on the share-link domain when one is set up (it reaches the same Worker), else the Worker's own address. */
export function runResultsLink(workerBaseUrl: string, shareId: string, linkBase?: string | null): string {
  const base = String(linkBase ?? '').trim().replace(/\/+$/, '')
  let hostname: string | null = null
  try { hostname = base ? new URL(base).hostname : null } catch { hostname = null }
  if (base && hostname && isValidShareDomain(hostname)) return `${base}/results/${shareId}`
  return `${String(workerBaseUrl).replace(/\/+$/, '')}/results/${shareId}`
}

// Date words fixed here ("Sep", never a locale's "Sept"), as the drawings write them; local time.
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function dayMonthYear(ms: number): string {
  const d = new Date(ms)
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}
function weekdayDayMonth(ms: number): string {
  const d = new Date(ms)
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`
}

/** "Mon 28 Sep 2026 · ITSS Briefing, Oxford". */
export function runShareSubtitle(run: RunLike): string {
  const started = Date.parse(run.startedAt)
  const date = Number.isFinite(started) ? `${DAYS[new Date(started).getDay()]} ${dayMonthYear(started)}` : run.plannedDate ?? ''
  return [date, [run.eventTitle, run.audience].filter(Boolean).join(', ')].filter(Boolean).join(' · ')
}

/** The poll results a link can carry: counts only (see the invariant above). */
export function shareablePolls(run: RunLike): RunPollSummary[] {
  return runPollSummaries(run).filter((summary) => summary.kind !== 'text')
}

/** What the Run can put on a link: the dialog's three lines. */
export function runShareOptions(run: RunLike): { boards: number; boardCards: number; polls: RunPollSummary[]; prework: boolean } {
  const boards = run.boards ?? []
  return { boards: boards.length, boardCards: boards.reduce((sum, board) => sum + runBoardView(board).cardCount, 0),
    polls: shareablePolls(run), prework: false }
}

/** The push for the Worker: the Run's boards (no hidden card, no name) and poll counts, as chosen. */
export function runSharePayload(run: RunLike, include: RunShareInclude, expiresAt: number | null, now: number): RunSharePush {
  const boards = include.board ? (run.boards ?? []).map((board) => {
    const view = runBoardView(board)
    const open = runBoardState(board, now) === 'open'
    const closedAt = board.closedAt ?? board.liveEndedAt
    return {
      question: board.question, cardCount: view.cardCount, state: open ? 'open' as const : 'final' as const,
      ...(open && board.openUntil ? { when: weekdayDayMonth(board.openUntil) } : !open && closedAt ? { when: dayMonthYear(closedAt) } : {}),
      columns: view.columns.map((column) => ({
        label: column.label, count: column.count,
        entries: column.entries.map((entry) => entry.kind === 'group'
          ? { text: entry.text, n: entry.n, ...(entry.count > 1 ? { count: entry.count } : {}) }
          : { text: entry.text }),
      })),
    }
  }) : []
  const polls = include.polls ? shareablePolls(run).map((summary) => summary.kind === 'bars'
    ? { kind: 'bars' as const, question: summary.question, people: summary.people, rows: summary.rows }
    : summary.kind === 'scale'
      ? { kind: 'scale' as const, question: summary.question, people: summary.people, labels: summary.labels, rows: summary.rows }
      : null).filter((poll): poll is NonNullable<typeof poll> => poll !== null) : []
  return { expiresAt, title: run.talkTitle || 'Talk', subtitle: runShareSubtitle(run), boards, polls }
}
