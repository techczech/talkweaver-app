// Planning a Run from the talk (ADR-0032 point 5, round-3 P1-P5): the pure rules behind the plan
// sheet and the status bar's Run chips. No Electron, no fs; the sheet and the status bar render what
// these functions decide, and scripts/test-plan-run.mjs exercises them.

import { workClosingError, LEGACY_SECTION_FILE_ID, SESSION_END, type Phase } from './run-work.ts'
import { talkWorkFile, workFileValue, type NameableWorkFile } from './work-file-name.ts'

export interface PlanRunLike {
  id: string
  talkSlug: string
  status?: 'planned' | 'delivered'
  plannedDate?: string
  startTime?: string
  eventTitle?: string
  audience?: string
  expectedPeople?: number
  preworkOpens?: string
  preworkCloses?: string
  handoutUrl?: string
}

/** The pre-work window of a Run, or null when it has none. Closing defaults to the talk's start. */
export function preworkWindow(run: Pick<PlanRunLike, 'plannedDate' | 'startTime' | 'preworkOpens' | 'preworkCloses'>): { opens: string; closes: string } | null {
  if (!run.preworkOpens) return null
  const closes = run.preworkCloses || (run.plannedDate ? `${run.plannedDate}T${run.startTime || '00:00'}` : '')
  return closes ? { opens: run.preworkOpens, closes } : null
}

// ── the next Run ────────────────────────────────────────────────────────────────────────────────

export function localToday(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/** Earliest planned Run of the talk that is not in the past; null when none. */
export function nextPlannedRun<T extends PlanRunLike>(runs: readonly T[], talkSlug: string, today: string): T | null {
  const upcoming = runs
    .filter((run) => run.talkSlug === talkSlug && run.status === 'planned' && run.plannedDate && run.plannedDate >= today)
    .sort((a, b) => (a.plannedDate ?? '').localeCompare(b.plannedDate ?? '') || (a.startTime ?? '').localeCompare(b.startTime ?? '') || a.id.localeCompare(b.id))
  return upcoming[0] ?? null
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function parts(value: string): { y: number; m: number; d: number; time: string } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}:\d{2}))?$/.exec(value)
  return match ? { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]), time: match[4] ?? '' } : null
}

/** `6 Oct` */
export function shortDate(value: string): string {
  const p = parts(value)
  return p ? `${p.d} ${MONTHS[p.m - 1]}` : value
}

/** `Tue 6 Oct 2026` */
export function longDate(value: string): string {
  const p = parts(value)
  if (!p) return value
  return `${DAYS[new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()]} ${p.d} ${MONTHS[p.m - 1]} ${p.y}`
}

/** `Tue 6 Oct, 10:00` (the year is left out; the sheet and popover say it elsewhere). */
export function dayAndTime(value: string): string {
  const p = parts(value)
  if (!p) return value
  const day = `${DAYS[new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()]} ${p.d} ${MONTHS[p.m - 1]}`
  return p.time ? `${day}, ${p.time}` : day
}

export interface RunChips {
  /** "Next run: <event>, <date>" opens the Run popover. */
  run: { text: string; runId: string } | null
  /** "Pre-work opens <date>" (the count arrives with ticket 10) or, without a Run, null. */
  prework: { text: string; runId: string } | null
  /** "No run planned · Plan a run…" when the talk has pre-work and nothing planned. */
  nudge: { text: string } | null
}

/** How far a Run's pre-work has got, from its mirrored answers (ticket 11): people who started and who did every step. */
export interface PreworkProgress { started: number; finished: number }

/**
 * The status bar's chips. Once pre-work is open and the Run has mirrored answers, the pre-work chip
 * counts people: "Pre-work: 14 of 22 started" (of the expected people when the Run has them), else
 * "Pre-work: 14 started". Before it opens it says when it opens.
 */
export function runChips(run: PlanRunLike | null, talkHasPrework: boolean, now: Date = new Date(), progress: PreworkProgress | null = null): RunChips {
  if (!run) return { run: null, prework: null, nudge: talkHasPrework ? { text: 'No run planned · Plan a run…' } : null }
  const event = run.eventTitle || 'Run'
  const window = preworkWindow(run)
  let prework: RunChips['prework'] = null
  if (window) {
    const nowLocal = `${localToday(now)}T${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    const opened = window.opens <= nowLocal
    prework = { runId: run.id, text: opened && progress
      ? `Pre-work: ${progress.started}${run.expectedPeople ? ` of ${run.expectedPeople}` : ''} started`
      : opened ? `Pre-work opened ${shortDate(window.opens)}` : `Pre-work opens ${shortDate(window.opens)}` }
  }
  return { run: { runId: run.id, text: `Next run: ${event}, ${shortDate(run.plannedDate ?? '')}` }, prework, nudge: null }
}

// ── the pre-work time zone ──────────────────────────────────────────────────────────────────────

/** The zone the sheet shows and reads the pre-work times in: the Run's own when editing, else this machine's. */
export function sheetTimeZone(run: { timeZone?: string } | null | undefined, machineZone: string): string {
  return run?.timeZone || machineZone
}

/**
 * The zone the sheet sends with a save, or undefined to leave the Run's alone. A new plan with
 * pre-work sends it; an edit sends it only when the person chose a different zone than the Run has
 * (or the Run had none and pre-work times are now set).
 */
export function zoneToSend(run: { timeZone?: string; preworkOpens?: string } | null | undefined, chosen: string, preworkOn: boolean): string | undefined {
  if (!preworkOn) return undefined
  if (!run) return chosen
  if (run.timeZone) return chosen !== run.timeZone ? chosen : undefined
  return chosen
}

// ── the sheet's draft ───────────────────────────────────────────────────────────────────────────
// Work-files ticket 11: a Run is planned with a slide set and, per phase, a work file with its window.
// Times are local `YYYY-MM-DDTHH:MM` in the sheet's zone; '' is "not chosen yet".

export interface PhaseDraft {
  /** The chosen work file's id; '' = None (the phase is left off the Run). `legacy-section` = a 0.39 `{prework}` window kept as it is. */
  fileId: string
  /** Pre-work: '' or a time. Post-work: `session-end` (default), '' (a set time not yet chosen) or a time. */
  opens: string
  /** '' = not chosen. Pre-work then closes when the session starts; post-work requires one. */
  closes: string
}

export interface PlanDraft {
  event: string
  date: string
  startTime: string
  expected: string
  audience: string
  slideSet: string
  pre: PhaseDraft
  post: PhaseDraft
}

export const NO_WORK_FILE = ''
/** Post-work with no closing time picked is offered this fix: a fortnight after the session, 17:00. */
export const POST_CLOSE_DAYS = 14
export const POST_CLOSE_TIME = '17:00'
/** Pre-work that closes too late is offered this fix: an hour before the session starts. */
export const PRE_CLOSE_LEAD_MINUTES = 60

export function localDateTime(now: Date): string {
  return `${localToday(now)}T${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
}

/** What the talk's `prework:` / `postwork:` metadata name, as work-file ids ('' when they name nothing usable). */
export function workDefaults(names: { prework?: string; postwork?: string }, files: readonly NameableWorkFile[]): { pre: string; post: string } {
  const idOf = (value: string | undefined): string => {
    const named = talkWorkFile(value, files).file
    return named ? workFileValue(named) : NO_WORK_FILE
  }
  return { pre: idOf(names.prework), post: idOf(names.postwork) }
}

/** A fresh draft, as the mockup draws it: date, time and the pre-work times empty; the phases' files from the talk. */
export function blankDraft(defaults: { pre?: string; post?: string } = {}): PlanDraft {
  return {
    event: '', date: '', startTime: '', expected: '', audience: '', slideSet: 'full',
    pre: { fileId: defaults.pre ?? NO_WORK_FILE, opens: '', closes: '' },
    post: { fileId: defaults.post ?? NO_WORK_FILE, opens: SESSION_END, closes: '' }
  }
}

type RunWorkLike = { fileId: string; opens: string; closes: string; problem?: string }
type DraftRun = PlanRunLike & { slideSet?: { kind: 'full' } | { kind: 'pathway'; pathwayId: string }; work?: { pre?: RunWorkLike; post?: RunWorkLike } }

export function draftFromRun(run: DraftRun, now: Date): PlanDraft {
  const pre = run.work?.pre
  const post = run.work?.post
  return {
    event: run.eventTitle ?? '',
    date: run.plannedDate ?? localToday(now),
    startTime: run.startTime ?? '',
    expected: run.expectedPeople ? String(run.expectedPeople) : '',
    audience: run.audience ?? '',
    slideSet: run.slideSet?.kind === 'pathway' ? run.slideSet.pathwayId : 'full',
    pre: pre ? { fileId: pre.fileId, opens: pre.opens, closes: pre.closes } : { fileId: NO_WORK_FILE, opens: '', closes: '' },
    post: post ? { fileId: post.fileId, opens: post.opens, closes: post.closes } : { fileId: NO_WORK_FILE, opens: SESSION_END, closes: '' }
  }
}

// ── plan the next run like this (work-files ticket 26) ──────────────────────────────────────────

function dayNumber(date: string): number | null {
  const p = parts(date)
  return p ? Date.UTC(p.y, p.m - 1, p.d) / 86_400_000 : null
}

/** The draft with its work windows moved by the whole days between two dates (wall-clock times stay as they are). */
export function moveDraftToDate(draft: PlanDraft, fromDate: string, toDate: string): PlanDraft {
  const from = dayNumber(fromDate)
  const to = dayNumber(toDate)
  if (from === null || to === null || from === to) return { ...draft, date: toDate }
  const minutes = (to - from) * 1440
  const move = (value: string): string => (LOCAL_DATE_TIME.test(value) ? addMinutes(value, minutes) : value)
  return {
    ...draft,
    date: toDate,
    pre: { ...draft.pre, opens: move(draft.pre.opens), closes: move(draft.pre.closes) },
    post: { ...draft.post, opens: move(draft.post.opens), closes: move(draft.post.closes) }
  }
}

/**
 * The draft for "Plan the next run like this": the Run's event, audience, expected people, start time,
 * slides and work files with their windows, and nothing the first Run collected or published (answers,
 * pins, handout link, published stamps are not draft fields). The date is left for the presenter; the
 * windows stay where the Run had them until a date is given, then move with it (`moveDraftToDate`).
 * A phase whose attachment is marked `zone-mismatch` is not copied, and neither is a talk's old
 * `{prework}` section (`legacy-section`, ticket 29): the copy has no pre-work, as if none was chosen.
 * With `newDate` the windows are moved at once.
 */
export function copyDraftFromRun(run: DraftRun, newDate = ''): PlanDraft {
  const marked = markedPhases(run)
  const base = draftFromRun(run, new Date(0))
  const dropPre = marked.pre || base.pre.fileId === LEGACY_SECTION_FILE_ID
  const copy: PlanDraft = {
    ...base,
    date: '',
    pre: dropPre ? { fileId: NO_WORK_FILE, opens: '', closes: '' } : base.pre,
    post: marked.post ? { fileId: NO_WORK_FILE, opens: SESSION_END, closes: '' } : base.post
  }
  return newDate ? moveDraftToDate(copy, run.plannedDate ?? '', newDate) : copy
}

/** The phases whose attachment came back marked `problem: zone-mismatch` (ticket 03): shown on the sheet, never planned over. */
export function markedPhases(run: { work?: { pre?: { problem?: string }; post?: { problem?: string } } } | null | undefined): { pre: boolean; post: boolean } {
  return { pre: Boolean(run?.work?.pre?.problem), post: Boolean(run?.work?.post?.problem) }
}

// ── dates for the fixes ─────────────────────────────────────────────────────────────────────────

const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/

function asUtc(value: string): number { return Date.parse(`${value}:00Z`) }
function fromUtc(ms: number): string { return new Date(ms).toISOString().slice(0, 16) }

/** `value` moved by whole minutes, on the same wall clock (no zone is applied; the sheet's zone reads both). */
export function addMinutes(value: string, minutes: number): string { return fromUtc(asUtc(value) + minutes * 60_000) }

/** `Wed 4 Nov 17:00`. */
function dayTime(value: string): string { return dayAndTime(value).replace(',', '') }

export function sessionStartOf(draft: Pick<PlanDraft, 'date' | 'startTime'>): string {
  const value = `${draft.date}T${draft.startTime}`
  return LOCAL_DATE_TIME.test(value) && Number.isFinite(asUtc(value)) ? value : ''
}

// ── the rules ───────────────────────────────────────────────────────────────────────────────────

/** A fix the sheet offers under a message: set these fields of this phase. */
export interface PlanFix { label: string; phase: Phase; set: Partial<PhaseDraft> }

export interface PlanIssue {
  phase: Phase
  code: 'pre-closes-after-start' | 'pre-closes-before-opens' | 'post-closes-before-start' | 'post-opens-before-start' | 'post-closes-before-opens'
  /** The drawn message. */
  message: string
  fix: PlanFix | null
}

export function applyFix(draft: PlanDraft, fix: PlanFix): PlanDraft {
  return { ...draft, [fix.phase]: { ...draft[fix.phase], ...fix.set } }
}

/** Where a phase's window is wrong against the session, in the words drawn on the sheet. Only complete values are judged. */
export function planIssues(draft: PlanDraft, skip: { pre?: boolean; post?: boolean } = {}, options: { delivered?: boolean } = {}): PlanIssue[] {
  const start = sessionStartOf(draft)
  const issues: PlanIssue[] = []
  for (const phase of ['pre', 'post'] as const) {
    const w = draft[phase]
    if (skip[phase] || !w.fileId || !start) continue
    const opens = w.opens
    const closes = w.closes || (phase === 'pre' ? start : '')
    if (!closes || !(opens === SESSION_END || LOCAL_DATE_TIME.test(opens)) || !LOCAL_DATE_TIME.test(closes)) continue
    if (w.fileId === LEGACY_SECTION_FILE_ID) {
      if (opens !== SESSION_END && closes <= opens) issues.push({ phase, code: 'pre-closes-before-opens', message: 'Pre-work must close after it opens', fix: null })
      continue
    }
    const found = workClosingError(phase, { opens, closes }, start, options)
    if (found === 'work-closes-before-opens') {
      issues.push(phase === 'pre'
        ? { phase, code: 'pre-closes-before-opens', message: 'Pre-work must close after it opens', fix: null }
        : { phase, code: 'post-closes-before-opens', message: 'Post-work must close after it opens', fix: null })
    } else if (found === 'work-pre-closes-after-start') {
      const value = addMinutes(start, -PRE_CLOSE_LEAD_MINUTES)
      issues.push({ phase, code: 'pre-closes-after-start', message: 'Pre-work must close before the session starts',
        fix: { phase, label: value.slice(0, 10) === start.slice(0, 10) ? `Close at ${value.slice(11)}` : `Close ${dayTime(value)}`, set: { closes: value } } })
    } else if (found === 'work-post-closes-before-start') {
      const value = `${addMinutes(`${start.slice(0, 10)}T00:00`, POST_CLOSE_DAYS * 1440).slice(0, 10)}T${POST_CLOSE_TIME}`
      issues.push({ phase, code: 'post-closes-before-start', message: 'Post-work must close after the session ends', fix: { phase, label: `Close ${dayTime(value)}`, set: { closes: value } } })
    } else if (found === 'work-post-opens-before-start') {
      issues.push({ phase, code: 'post-opens-before-start', message: 'Post-work must open after the session starts', fix: { phase, label: 'Open when the session ends', set: { opens: SESSION_END } } })
    }
  }
  return issues
}

export interface PlanContext {
  /** True only when the sheet showed the work blocks (the work-file listing arrived). Otherwise work is left alone. */
  phases: boolean
  /** Editing a planned Run: a phase set to None is sent as `null` so it is removed. */
  editing: boolean
  /** Phases whose attachment is marked `zone-mismatch`: left out of the save altogether. */
  marked?: { pre?: boolean; post?: boolean }
  /** Change time on a Run already given (ticket 19): work may close on either side of the session. */
  delivered?: boolean
}

export interface PlannedWorkInput { fileId: string; opens?: string; closes?: string }

export type PlanResult =
  | { ok: true; fields: { plannedDate: string; eventTitle: string; audience: string; slideSet: { kind: 'full' } | { kind: 'pathway'; pathwayId: string }; startTime: string; expectedPeople: number | null; preworkOpens?: string | null; preworkCloses?: string | null; work?: { pre?: PlannedWorkInput | null; post?: PlannedWorkInput | null } }; attached: boolean }
  | { ok: false; error: string }

/**
 * What the sheet may save, or the first thing wrong with it (shown in the footer). Work is sent per
 * phase: a file with its window; None leaves a new Run without it and removes it from a Run being
 * edited. A migrated 0.39 window (`legacy-section`) is saved through the old window fields.
 */
export function planFromDraft(draft: PlanDraft, ctx: PlanContext): PlanResult {
  if (!draft.event.trim()) return { ok: false, error: 'Give the event a name.' }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date)) return { ok: false, error: 'Choose a date.' }
  if (!/^\d{2}:\d{2}$/.test(draft.startTime)) return { ok: false, error: 'Choose a start time.' }
  const expectedText = draft.expected.trim()
  let expectedPeople: number | null = null
  if (expectedText) {
    const n = Number(expectedText)
    if (!Number.isInteger(n) || n < 1 || n > 100000) return { ok: false, error: 'Expected people is a whole number, or leave it empty.' }
    expectedPeople = n
  }
  const marked = ctx.marked ?? {}
  const work: { pre?: PlannedWorkInput | null; post?: PlannedWorkInput | null } = {}
  let preworkOpens: string | null | undefined
  let preworkCloses: string | null | undefined
  let attached = false
  if (ctx.phases) {
    const { pre, post } = draft
    if (!marked.pre) {
      if (!pre.fileId) {
        if (ctx.editing) { work.pre = null; preworkOpens = null; preworkCloses = null }
      } else {
        if (!LOCAL_DATE_TIME.test(pre.opens)) return { ok: false, error: 'Choose when pre-work opens.' }
        if (pre.closes && !LOCAL_DATE_TIME.test(pre.closes)) return { ok: false, error: 'Choose when pre-work closes.' }
        attached = true
        if (pre.fileId === LEGACY_SECTION_FILE_ID) { preworkOpens = pre.opens; preworkCloses = pre.closes || null }
        else work.pre = { fileId: pre.fileId, opens: pre.opens, ...(pre.closes ? { closes: pre.closes } : {}) }
      }
    }
    if (!marked.post) {
      if (!post.fileId) {
        if (ctx.editing) work.post = null
      } else {
        if (post.opens !== SESSION_END && !LOCAL_DATE_TIME.test(post.opens)) return { ok: false, error: 'Choose when post-work opens.' }
        if (!LOCAL_DATE_TIME.test(post.closes)) return { ok: false, error: 'Choose when post-work closes.' }
        attached = true
        work.post = { fileId: post.fileId, opens: post.opens, closes: post.closes }
      }
    }
    const issue = planIssues(draft, marked, { delivered: ctx.delivered })[0]
    if (issue) return { ok: false, error: issue.message }
  }
  return {
    ok: true,
    attached,
    fields: {
      plannedDate: draft.date,
      eventTitle: draft.event.trim(),
      audience: draft.audience.trim(),
      slideSet: draft.slideSet === 'full' ? { kind: 'full' } : { kind: 'pathway', pathwayId: draft.slideSet },
      startTime: draft.startTime,
      expectedPeople,
      ...(preworkOpens !== undefined ? { preworkOpens } : {}),
      ...(preworkCloses !== undefined ? { preworkCloses } : {}),
      ...(Object.keys(work).length ? { work } : {})
    }
  }
}
