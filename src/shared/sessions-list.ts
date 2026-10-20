// The Sessions list as a pure model (work-files-and-sessions ticket 09; locked mockup S7).
// Every planned and delivered Run of every open vault goes in, with the time now and the filter;
// ordered, grouped, filtered rows come out. Each row's status pill and phase come from the Run
// checklist (run-checklist.ts), never re-derived here. No Electron, no fs, no clock.
//
//   Upcoming  planned Runs from today on, and a Run that is live now (soonest first)
//   Past      delivered Runs, and planned Runs whose day has gone (latest first). A delivered Run whose
//             post-work is open stays under Past.
//   Filters   Upcoming | Live now | Past | Published only | Responses waiting; none chosen shows both groups.
import { dayLabel, localTimeIn, runChecklist, type ChecklistRun, type PillKind, type RunPhase } from './run-checklist.ts'
import type { ToolsRunRef } from './tools-views.ts'
import type { Phase } from './run-work.ts'
import type { RunExtras } from './run-extras.ts'
import { talkTitleText } from './talk-title-text.ts'

export const SESSION_FILTERS = ['upcoming', 'live', 'past', 'published', 'responses'] as const
export type SessionFilter = (typeof SESSION_FILTERS)[number]
export const SESSION_FILTER_LABELS: Record<SessionFilter, string> = { upcoming: 'Upcoming', live: 'Live now', past: 'Past', published: 'Published only', responses: 'Responses waiting' }

/** What main sends for one Run: plain data, no paths. `answers` is the people who took part, per phase. */
export interface SessionSource extends ChecklistRun {
  vaultId: string
  talkSlug: string
  runId: string
  talkTitle: string
  eventTitle?: string
  kind?: 'delivery' | 'rehearsal' | 'recording'
  /** ISO instant the Run started, for a delivered Run that was never planned. */
  startedAt?: string
  answers?: { pre?: number; post?: number }
  /**
   * The phases Unpublish would withdraw: THE sent set (run-unpublish.ts sentPhases, D1), computed in main
   * from the Run's stamps and the work service's record. The Unpublish confirmation names these pages.
   */
  sent?: Phase[]
  /** Extras for this run (ticket 24): the intro note and links its handout shows. */
  extras?: RunExtras
  /**
   * New responses for the Run (2026-10-19 prework-responses, decision 12): answers and questions waiting on
   * the live service (counted, not pulled) plus those pulled onto the Run and not seen yet. Absent: none.
   */
  responses?: number
}

export type SessionGroupId = 'upcoming' | 'live' | 'past'
export interface SessionRow {
  /** Unique across vaults. */
  key: string
  ref: ToolsRunRef
  vaultId: string
  name: string
  talk: string
  /** "Wed 21 Oct · 14:00" */
  when: string
  pill: { kind: PillKind; label: string }
  /** "pre-work 7/18", "pre-work closed 12/18", "pre-work not open", "post-work 5/18" or ''. */
  progress: string
  phase: RunPhase
  live: boolean
  published: boolean
  /** New responses: the row's "12 new" badge; 0 shows none. */
  responses: number
}
export interface SessionGroup { id: SessionGroupId; label: string; rows: SessionRow[] }
export interface SessionList {
  groups: SessionGroup[]
  rows: SessionRow[]
  total: number
  /** Runs with new responses, whatever the filter: the "Responses waiting · 2" chip and the rail badge. */
  waiting: number
}

/** The row's badge: "12 new", or '' for none. */
export function responsesBadge(row: Pick<SessionRow, 'responses'>): string {
  return row.responses > 0 ? `${row.responses} new` : ''
}

/** Runs with new responses among the sources (the Sessions rail badge). Rehearsals are not counted. */
export function runsWithResponses(sources: readonly Pick<SessionSource, 'kind' | 'responses'>[]): number {
  return sources.filter((source) => isSessionRun(source) && (source.responses ?? 0) > 0).length
}

export interface SessionListOptions {
  filter?: SessionFilter | null
  /** Runs with a live session running, as `sessionLiveKey` (vault id, talk and Run id). */
  live?: ReadonlySet<string>
}

export const sessionRunKey = (ref: ToolsRunRef): string => `${ref.talkSlug}/${ref.runId}`

/** A live Run by its vault, talk and Run id: the same talk and Run id in another vault is another Run (issue 256). */
export const sessionLiveKey = (vaultId: string, ref: Pick<ToolsRunRef, 'talkSlug' | 'runId'>): string => `${vaultId}|${ref.talkSlug}/${ref.runId}`

/** The row a Run reference selects: by vault, talk and Run id. A reference without a vault selects a
 *  row only when exactly one open vault holds that talk and Run id; never the first of several. */
export function selectSessionRow<T extends Pick<SessionRow, 'ref' | 'vaultId'>>(rows: readonly T[], ref: ToolsRunRef | null | undefined): T | null {
  if (!ref) return null
  const matches = rows.filter((row) => sessionRunKey(row.ref) === sessionRunKey(ref) && (!ref.vaultId || row.vaultId === ref.vaultId))
  return matches.length === 1 ? matches[0] : null
}

/** A rehearsal is not a session with people in it; planned and delivered Runs are. */
export function isSessionRun(source: Pick<SessionSource, 'kind'>): boolean {
  return source.kind !== 'rehearsal'
}

function startLocal(source: SessionSource): string {
  if (source.plannedDate) return `${source.plannedDate}T${source.startTime || '00:00'}`
  const started = source.startedAt ? new Date(source.startedAt) : null
  return started && Number.isFinite(started.getTime()) ? localTimeIn(started, source.timeZone) : ''
}

function progressText(phase: RunPhase, source: SessionSource): string {
  const expected = source.expectedPeople
  const count = (n: number | undefined) => `${n ?? 0}${expected ? `/${expected}` : ''}`
  if (phase === 'post-open') return `post-work ${count(source.answers?.post)}`
  if (phase === 'post-closed') return `post-work closed ${count(source.answers?.post)}`
  if (!source.work?.pre) return ''
  if (phase === 'planned' || phase === 'publishing') return 'pre-work not open'
  const closed = phase === 'pre-closed' || phase === 'live' || phase === 'delivered'
  return `pre-work ${closed ? 'closed ' : ''}${count(source.answers?.pre)}`
}

/** One Run as a row, with the group it sits in. */
export function sessionRow(source: SessionSource, now: Date, live: boolean): { row: SessionRow; group: 'upcoming' | 'past'; sortKey: string } {
  const check = runChecklist(source, now, { live, answers: source.answers })
  const start = startLocal(source)
  const delivered = source.status === 'delivered'
  const today = localTimeIn(now, source.timeZone).slice(0, 10)
  const group = !live && (delivered || (!!start && start.slice(0, 10) < today)) ? 'past' : 'upcoming'
  const when = start ? `${dayLabel(start.slice(0, 10))}${source.plannedDate && !source.startTime ? '' : ` · ${start.slice(11, 16)}`}` : 'No date'
  // The reference names the Run's vault: two open vaults may hold the same talk slug and Run id.
  const ref = { vaultId: source.vaultId, talkSlug: source.talkSlug, runId: source.runId }
  return {
    group,
    sortKey: start || '9999',
    row: {
      key: `${source.vaultId}|${sessionRunKey(ref)}`, ref, vaultId: source.vaultId,
      name: talkTitleText(source.eventTitle || source.talkTitle), talk: talkTitleText(source.talkTitle), when,
      pill: check.pill, progress: progressText(check.phase, source), phase: check.phase,
      live, published: check.publication === 'published',
      responses: source.responses && source.responses > 0 ? source.responses : 0
    }
  }
}

export function sessionList(sources: readonly SessionSource[], now: Date, options: SessionListOptions = {}): SessionList {
  const filter = options.filter ?? null
  const all = sources.filter(isSessionRun).map((source) => sessionRow(source, now, options.live?.has(sessionLiveKey(source.vaultId, source)) === true))
  const keep = all.filter(({ row, group }) => {
    if (filter === 'live') return row.live
    if (filter === 'upcoming') return group === 'upcoming'
    if (filter === 'past') return group === 'past'
    if (filter === 'published') return row.published
    if (filter === 'responses') return row.responses > 0
    return true
  })
  const rowsOf = (group: 'upcoming' | 'past') => keep.filter((item) => item.group === group)
    .sort((a, b) => (group === 'upcoming' ? a.sortKey.localeCompare(b.sortKey) : b.sortKey.localeCompare(a.sortKey)) || a.row.key.localeCompare(b.row.key))
    .map((item) => item.row)
  const upcoming = rowsOf('upcoming')
  const past = rowsOf('past')
  const groups: SessionGroup[] = []
  if (upcoming.length) groups.push({ id: filter === 'live' ? 'live' : 'upcoming', label: filter === 'live' ? 'Live now' : 'Upcoming', rows: upcoming })
  if (past.length) groups.push({ id: 'past', label: 'Past', rows: past })
  return { groups, rows: [...upcoming, ...past], total: all.length, waiting: all.filter(({ row }) => row.responses > 0).length }
}
