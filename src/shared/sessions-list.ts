// The Runs list as a pure model (work-files-and-sessions ticket 09; locked mockup S7; merged with History by
// consistency batch 3, house rule R5). Every planned and delivered Run of every open vault goes in, with the
// time now and the filters; ordered, grouped, filtered rows come out. Each row's status badge and phase come
// from the Run checklist (run-checklist.ts), never re-derived here. No Electron, no fs, no clock.
//
//   Upcoming  planned Runs from today on, and a Run that is live now (soonest first)
//   Past      delivered Runs, and planned Runs whose day has gone (latest first). A delivered Run whose
//             post-work is open stays under Past.
//   Filters   Upcoming | Live now | Past (any of those chosen); Recorded | Published | Responses waiting (all of
//             those chosen); none chosen shows everything. Kinds (Delivery, Rehearsal, Recording) are a
//             separate choice; the default is deliveries (a planned Run is a delivery). Handouts that are
//             still reachable, a search, a sort and a grouping come in as options.
import { dayLabel, localTimeIn, runChecklist, type ChecklistRun, type PillKind, type RunPhase } from './run-checklist.ts'
import type { ToolsRunRef } from './tools-views.ts'
import type { Phase } from './run-work.ts'
import type { RunExtras } from './run-extras.ts'
import { talkTitleText } from './talk-title-text.ts'

export const SESSION_FILTERS = ['upcoming', 'live', 'past', 'recorded', 'published', 'responses'] as const
export type SessionFilter = (typeof SESSION_FILTERS)[number]
export const SESSION_FILTER_LABELS: Record<SessionFilter, string> = { upcoming: 'Upcoming', live: 'Live now', past: 'Past', recorded: 'Recorded', published: 'Published', responses: 'Responses waiting' }
const WHEN_FILTERS: readonly SessionFilter[] = ['upcoming', 'live', 'past']

export type RunKind = 'delivery' | 'rehearsal' | 'recording'
export const RUN_KINDS: readonly RunKind[] = ['delivery', 'rehearsal', 'recording']
export const RUN_KIND_LABELS: Record<RunKind, string> = { delivery: 'Delivery', rehearsal: 'Rehearsal', recording: 'Recording' }
export const DEFAULT_RUN_KINDS: readonly RunKind[] = ['delivery']

export const SESSION_SORTS = ['date', 'talk', 'length'] as const
export type SessionSort = (typeof SESSION_SORTS)[number]
export const SESSION_SORT_LABELS: Record<SessionSort, string> = { date: 'Date', talk: 'Talk', length: 'Length' }
export const SESSION_GROUPS = ['status', 'month', 'talk'] as const
export type SessionGroupBy = (typeof SESSION_GROUPS)[number]
export const SESSION_GROUP_LABELS: Record<SessionGroupBy, string> = { status: 'Upcoming and past', month: 'Month', talk: 'Talk' }

/** What main sends for one Run: plain data, no paths. `answers` is the people who took part, per phase. */
export interface SessionSource extends ChecklistRun {
  sourceOutline?: string
  vaultId: string
  talkSlug: string
  runId: string
  talkTitle: string
  eventTitle?: string
  /** Who it was for, and the free line a delivered Run was saved with (both searched). */
  audience?: string
  context?: string | null
  kind?: RunKind
  /** ISO instant the Run started, for a delivered Run that was never planned. */
  startedAt?: string
  /** The Run carries audio (the Recorded filter; Studio's list). Absent: no audio. */
  recorded?: boolean
  /** How long the Run was delivered, in ms: the audio less its trims, else the wall clock (the Length sort). */
  lengthMs?: number
  /** Its feedback boards, as far as the list needs them (Board open · n late cards). */
  boards?: SessionBoardMark[]
  /** A Run kept in this computer's app data because no vault could hold it (it has a ledger entry but no Run page). */
  kept?: 'app-data'
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

/** What the list needs of a Run's feedback board to say it is still open (R9): its times and how many cards came late. */
export interface SessionBoardMark { openUntil?: number; closedAt?: number; liveEndedAt?: number; late: number }

/** "Board open · 4 late cards" for a row, or null when no board of the Run is left open (the same words the old History row used). */
export function boardOpenBadge(boards: readonly SessionBoardMark[] | undefined, now: number): string | null {
  const open = (boards ?? []).filter((board) => board.openUntil !== undefined && board.closedAt === undefined && board.openUntil > now)
  if (!open.length) return null
  const late = open.reduce((sum, board) => sum + board.late, 0)
  return `Board open${late ? ` · ${late} late card${late === 1 ? '' : 's'}` : ''}`
}

export type SessionGroupId = 'upcoming' | 'live' | 'past' | `month:${string}` | `talk:${string}`
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
  kind: RunKind
  /** Carries audio. */
  recorded: boolean
  /** Delivered length in ms (0: unknown). */
  lengthMs: number
  /** Kept in app data: shown with its ledger entry only. */
  kept: boolean
  /** "Board open · 1 late card" while a board of the Run is left open. */
  boardBadge: string | null
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
  /** One filter (the older shape), or none. */
  filter?: SessionFilter | null
  /** Several filters: the "when" ones (upcoming, live, past) add up; Recorded, Published and Responses each narrow. */
  filters?: readonly SessionFilter[]
  /** The kinds shown; the default is deliveries. */
  kinds?: readonly RunKind[]
  /** Only Runs whose handout page is still reachable, as `sessionLiveKey`... checked by the caller: the Runs' own keys. */
  reachable?: ReadonlySet<string> | null
  /** Text the Run's name, talk, event, audience or date must contain. */
  query?: string
  sort?: SessionSort
  group?: SessionGroupBy
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

/** A rehearsal is not a live session with people in it; planned and delivered Runs are. (The rail badge counts only these.) */
export function isSessionRun(source: Pick<SessionSource, 'kind'>): boolean {
  return source.kind !== 'rehearsal'
}

const kindOf = (source: Pick<SessionSource, 'kind'>): RunKind => (source.kind === 'rehearsal' || source.kind === 'recording' ? source.kind : 'delivery')

/**
 * The title and date of a Run as the Runs view names them: the event title (else the talk's), and "Fri 6 Nov · 14:00". Studio's
 * recorded Runs read these too, so one Run has one name and one date wherever it is listed (R5).
 */
export function runTitleAndWhen(source: Pick<SessionSource, 'eventTitle' | 'talkTitle' | 'plannedDate' | 'startTime' | 'startedAt' | 'timeZone'>): { name: string; when: string } {
  const start = startLocal(source)
  return {
    name: talkTitleText(source.eventTitle || source.talkTitle),
    when: start ? `${dayLabel(start.slice(0, 10))}${source.plannedDate && !source.startTime ? '' : ` · ${start.slice(11, 16)}`}` : 'No date'
  }
}

function startLocal(source: Pick<SessionSource, 'plannedDate' | 'startTime' | 'startedAt' | 'timeZone'>): string {
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
  const { name, when } = runTitleAndWhen(source)
  // The reference names the Run's vault: two open vaults may hold the same talk slug and Run id.
  const ref = { vaultId: source.vaultId, talkSlug: source.talkSlug, runId: source.runId }
  return {
    group,
    sortKey: start || (delivered ? '0000' : '9999'),
    row: {
      key: `${source.vaultId}|${sessionRunKey(ref)}`, ref, vaultId: source.vaultId,
      name, talk: talkTitleText(source.talkTitle), when,
      pill: check.pill, progress: progressText(check.phase, source), phase: check.phase,
      live, published: check.publication === 'published',
      responses: source.responses && source.responses > 0 ? source.responses : 0,
      kind: kindOf(source), recorded: source.recorded === true, lengthMs: source.lengthMs ?? 0, kept: source.kept === 'app-data', boardBadge: boardOpenBadge(source.boards, now.getTime())
    }
  }
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const monthLabel = (key: string): string => /^\d{4}-\d{2}/.test(key) ? `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}` : 'No date'

/** What the query is matched against: the row's own words, and the day, month and year it names. */
function searchText(row: SessionRow, sortKey: string, source: SessionSource): string {
  const month = /^\d{4}-\d{2}/.test(sortKey) ? `${monthLabel(sortKey)} ${sortKey.slice(0, 10)}` : ''
  return [row.name, row.talk, source.audience ?? '', source.context ?? '', RUN_KIND_LABELS[row.kind], row.when, month].join(' ').toLowerCase()
}

export function sessionList(sources: readonly SessionSource[], now: Date, options: SessionListOptions = {}): SessionList {
  const filters = [...new Set([...(options.filters ?? []), ...(options.filter ? [options.filter] : [])])]
  const when = filters.filter((id) => WHEN_FILTERS.includes(id))
  const kinds = options.kinds ?? DEFAULT_RUN_KINDS
  const query = (options.query ?? '').trim().toLowerCase()
  const sort = options.sort ?? 'date'
  const groupBy = options.group ?? 'status'
  const everything = sources.map((source) => ({ source, ...sessionRow(source, now, options.live?.has(sessionLiveKey(source.vaultId, source)) === true) }))
  // What counts as a Run in the list at all: the chosen kinds. (`total` and the waiting count follow the same rule.)
  const all = everything.filter(({ row }) => kinds.includes(row.kind))
  const keep = all.filter(({ row, group, source, sortKey }) => {
    if (when.length && !(when.includes('live') && row.live) && !(when.includes('upcoming') && group === 'upcoming') && !(when.includes('past') && group === 'past')) return false
    if (filters.includes('recorded') && !row.recorded) return false
    if (filters.includes('published') && !row.published) return false
    if (filters.includes('responses') && row.responses <= 0) return false
    if (options.reachable && !options.reachable.has(row.key)) return false
    if (query && !searchText(row, sortKey, source).includes(query)) return false
    return true
  })
  const byDate = (a: (typeof keep)[number], b: (typeof keep)[number]): number => a.group === b.group
    ? (a.group === 'upcoming' ? a.sortKey.localeCompare(b.sortKey) : b.sortKey.localeCompare(a.sortKey))
    : (a.group === 'upcoming' ? -1 : 1)
  const ordered = [...keep].sort((a, b) => {
    if (sort === 'talk') return a.row.talk.localeCompare(b.row.talk) || b.sortKey.localeCompare(a.sortKey) || a.row.key.localeCompare(b.row.key)
    if (sort === 'length') return b.row.lengthMs - a.row.lengthMs || b.sortKey.localeCompare(a.sortKey) || a.row.key.localeCompare(b.row.key)
    return byDate(a, b) || a.row.key.localeCompare(b.row.key)
  })
  const groups: SessionGroup[] = []
  const add = (id: SessionGroupId, label: string, row: SessionRow): void => {
    const existing = groups.find((group) => group.id === id)
    if (existing) existing.rows.push(row)
    else groups.push({ id, label, rows: [row] })
  }
  const liveLabel = filters.includes('live') && !filters.includes('upcoming')
  for (const item of ordered) {
    if (groupBy === 'month') add(`month:${item.sortKey.slice(0, 7)}`, monthLabel(item.sortKey), item.row)
    else if (groupBy === 'talk') add(`talk:${item.row.talk}`, item.row.talk, item.row)
    else if (item.group === 'upcoming') add(liveLabel ? 'live' : 'upcoming', liveLabel ? 'Live now' : 'Upcoming', item.row)
    else add('past', 'Past', item.row)
  }
  return { groups, rows: groups.flatMap((group) => group.rows), total: all.length, waiting: all.filter(({ row }) => row.responses > 0).length }
}
