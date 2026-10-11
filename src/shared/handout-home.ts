// What the handout home page says about the talk (design 2026-10-07, "Handout 4b"): the parts of the navy
// band (day, start time, event, speaker) and, for a planned Run with a start time, when the talk starts,
// so the page shows its "before the talk" layout until then. Pure; the publishers pass the result to the
// compiler's buildHandoutHomePageHtml.
import { zonedLocalToMs } from './run-prework.ts'

export interface HandoutHomeRun {
  status?: string
  plannedDate?: string
  startTime?: string
  timeZone?: string
  eventTitle?: string
}

export interface HandoutHomeDetails {
  /** The Run's planned day without the year ("Tue 6 Oct") and with it ("Tue 6 Oct 2026"); '' without one. */
  day: string
  date: string
  /** The Run's start time ("17:30"); '' without one. */
  startTime: string
  /** The Run's event, else the talk's series; '' without either. */
  event: string
  /** From the talk's frontmatter; '' when it has none. */
  author: string
  subtitle: string
  affiliation: string
  /** When a planned Run starts (ms); null for any other talk. */
  startsAt: number | null
  /** Frontmatter `live_look_ahead`: false keeps people on the live page from stepping past the speaker's slide. */
  lookAhead: boolean
}

export interface HandoutHomePreworkStep {
  label: string
  /** Minutes a pre-task takes; null when the step names none. */
  minutes: number | null
  kind: string
}

export interface HandoutHomePrework {
  /** The form's one-row summary: its title (or "N steps to do before the session") and its length. */
  label: string
  detail: string
  /** The steps' minutes added up; 0 when none names any. */
  minutes: number
  steps: HandoutHomePreworkStep[]
}

// The compiler's flag words (compiler/scripts/lib/deck-settings.mjs DECK_FLAG_OFF); test-handout-home-details pins them equal.
export const LOOK_AHEAD_OFF_WORDS = ['false', 'no', 'off', 'hide', '0']

/** `live_look_ahead` (alias `live-look-ahead`): on unless the frontmatter turns it off with a flag word. */
export function handoutLookAhead(outline: string): boolean {
  const raw = frontmatterField(outline, 'live_look_ahead') || frontmatterField(outline, 'live-look-ahead')
  return !LOOK_AHEAD_OFF_WORDS.includes(raw.trim().toLowerCase())
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function frontmatterField(outline: string, key: string): string {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(outline)?.[1] ?? ''
  const match = new RegExp(`^${key}:\\s*["']?(.+?)["']?\\s*$`, 'm').exec(block)
  return match ? match[1].trim() : ''
}

/** `YYYY-MM-DD` as "Mon 6 Oct 2026" (or "Mon 6 Oct" without the year); '' when it is not a date. */
export function handoutDayLabel(date: string, withYear = true): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''))
  if (!m) return ''
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  if (!Number.isFinite(d.getTime())) return ''
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${withYear ? ` ${d.getUTCFullYear()}` : ''}`
}

export function handoutHomeDetails(opts: { outline: string; run?: HandoutHomeRun | null }): HandoutHomeDetails {
  const run = opts.run ?? null
  const startTime = /^\d{2}:\d{2}$/.test(run?.startTime ?? '') ? run!.startTime! : ''
  const planned = Boolean(run && run.status === 'planned' && run.plannedDate && startTime)
  const startsAt = planned ? zonedLocalToMs(`${run!.plannedDate}T${startTime}`, run!.timeZone) : Number.NaN
  return {
    day: run?.plannedDate ? handoutDayLabel(run.plannedDate, false) : '',
    date: run?.plannedDate ? handoutDayLabel(run.plannedDate) : '',
    startTime,
    event: (run?.eventTitle ?? '').trim() || frontmatterField(opts.outline, 'series'),
    author: frontmatterField(opts.outline, 'author'),
    subtitle: frontmatterField(opts.outline, 'subtitle'),
    affiliation: frontmatterField(opts.outline, 'affiliation'),
    startsAt: Number.isSafeInteger(startsAt) ? startsAt : null,
    lookAhead: handoutLookAhead(opts.outline),
  }
}

/** The home page's "Before the session" card for a Run's pre-work form; null without one. */
export function handoutHomePrework(form: { title?: string; steps?: Array<{ title?: string; minutes?: number; kind?: string }> } | null | undefined): HandoutHomePrework | null {
  const steps = Array.isArray(form?.steps) ? form!.steps! : []
  if (!form || steps.length === 0) return null
  const minutesOf = (step: { minutes?: number }): number => (typeof step.minutes === 'number' && step.minutes > 0 ? step.minutes : 0)
  const minutes = steps.reduce((sum, step) => sum + minutesOf(step), 0)
  const count = `${steps.length} step${steps.length === 1 ? '' : 's'}`
  return {
    label: (form.title ?? '').trim() || `${count} to do before the session`,
    detail: minutes > 0 ? `${minutes} min` : count,
    minutes,
    steps: steps.map((step, index) => ({
      label: (step.title ?? '').trim() || `Step ${index + 1}`,
      minutes: minutesOf(step) || null,
      kind: typeof step.kind === 'string' ? step.kind : '',
    })),
  }
}
