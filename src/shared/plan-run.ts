// Planning a Run from the talk (ADR-0032 point 5, round-3 P1-P5): the pure rules behind the plan
// sheet and the status bar's Run chips. No Electron, no fs; the sheet and the status bar render what
// these functions decide, and scripts/test-plan-run.mjs exercises them.

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

// ── pre-work in the talk ────────────────────────────────────────────────────────────────────────
// Whether the talk has pre-work, and how many steps, is the compiler's pre-work definition
// (compiler/scripts/lib/prework.mjs preworkFromOutline), read by the sheet and the status bar.

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

export interface PlanDraft {
  event: string
  date: string
  startTime: string
  expected: string
  audience: string
  slideSet: string
  preworkOn: boolean
  /** Local `YYYY-MM-DDTHH:MM`. */
  opens: string
  /** null = "When the talk starts". */
  closes: string | null
}

export const DEFAULT_START_TIME = '10:00'

export function localDateTime(now: Date): string {
  return `${localToday(now)}T${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
}

/** A fresh draft: pre-work opens when the plan is saved and closes when the talk starts. */
export function blankDraft(now: Date, hasPrework: boolean): PlanDraft {
  return { event: '', date: localToday(now), startTime: DEFAULT_START_TIME, expected: '', audience: '', slideSet: 'full', preworkOn: hasPrework, opens: localDateTime(now), closes: null }
}

export function draftFromRun(run: PlanRunLike & { slideSet?: { kind: 'full' } | { kind: 'pathway'; pathwayId: string } }, now: Date): PlanDraft {
  return {
    event: run.eventTitle ?? '',
    date: run.plannedDate ?? localToday(now),
    startTime: run.startTime ?? DEFAULT_START_TIME,
    expected: run.expectedPeople ? String(run.expectedPeople) : '',
    audience: run.audience ?? '',
    slideSet: run.slideSet?.kind === 'pathway' ? run.slideSet.pathwayId : 'full',
    preworkOn: Boolean(run.preworkOpens),
    opens: run.preworkOpens ?? localDateTime(now),
    closes: run.preworkCloses ?? null
  }
}

/**
 * What the sheet may save, or the first thing wrong with it (shown under the field).
 * `preworkShown` is true only when the sheet actually detected the talk's pre-work section and so
 * showed the toggle. Otherwise the pre-work fields are OMITTED (an edit keeps the Run's window);
 * they are `null` (cleared) only when the toggle was shown and switched off.
 */
export function planFromDraft(draft: PlanDraft, preworkShown: boolean):
  | { ok: true; fields: { plannedDate: string; eventTitle: string; audience: string; slideSet: { kind: 'full' } | { kind: 'pathway'; pathwayId: string }; startTime: string; expectedPeople: number | null; preworkOpens?: string | null; preworkCloses?: string | null } }
  | { ok: false; error: string } {
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
  const on = preworkShown && draft.preworkOn
  let preworkOpens: string | null | undefined
  let preworkCloses: string | null | undefined
  if (preworkShown && !draft.preworkOn) { preworkOpens = null; preworkCloses = null }
  if (on) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(draft.opens)) return { ok: false, error: 'Choose when pre-work opens.' }
    preworkOpens = draft.opens
    preworkCloses = draft.closes
    if (preworkCloses !== null && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(preworkCloses)) return { ok: false, error: 'Choose when pre-work closes.' }
    const closes = preworkCloses ?? `${draft.date}T${draft.startTime}`
    if (closes <= preworkOpens) return { ok: false, error: 'Pre-work must close after it opens.' }
  }
  return {
    ok: true,
    fields: {
      plannedDate: draft.date,
      eventTitle: draft.event.trim(),
      audience: draft.audience.trim(),
      slideSet: draft.slideSet === 'full' ? { kind: 'full' } : { kind: 'pathway', pathwayId: draft.slideSet },
      startTime: draft.startTime,
      expectedPeople,
      ...(preworkOpens !== undefined ? { preworkOpens } : {}),
      ...(preworkCloses !== undefined ? { preworkCloses } : {})
    }
  }
}
