// What the handout home page says about the talk (design 2026-10-02, direction B): the line under the
// title (date · event · speaker) and, for a planned Run with a start time, when the talk starts, so the
// page can say "Not live yet" until then. Pure; the publishers pass the result to the compiler's
// buildHandoutHomePageHtml.
import { zonedLocalToMs } from './run-prework.ts'

export interface HandoutHomeRun {
  status?: string
  plannedDate?: string
  startTime?: string
  timeZone?: string
  eventTitle?: string
}

export interface HandoutHomeDetails {
  meta: string
  startsAt: number | null
  notLive: { today: string; later: string } | null
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
  const author = frontmatterField(opts.outline, 'author')
  const event = (run?.eventTitle ?? '').trim() || frontmatterField(opts.outline, 'series')
  const meta = [run?.plannedDate ? handoutDayLabel(run.plannedDate) : '', event, author].filter(Boolean).join(' · ')
  const time = /^\d{2}:\d{2}$/.test(run?.startTime ?? '') ? run!.startTime! : ''
  const planned = Boolean(run && run.status === 'planned' && run.plannedDate && time)
  const startsAt = planned ? zonedLocalToMs(`${run!.plannedDate}T${time}`, run!.timeZone) : Number.NaN
  if (!Number.isSafeInteger(startsAt)) return { meta, startsAt: null, notLive: null }
  const tail = ' Polls, questions and reactions appear on this page when it does.'
  return {
    meta,
    startsAt,
    notLive: {
      today: `Not live yet. The talk starts at ${time}.${tail}`,
      later: `Not live yet. The talk starts on ${handoutDayLabel(run!.plannedDate!, false)} at ${time}.${tail}`,
    },
  }
}

/** The home page's "Before the session" row for a Run's pre-work form; null without one. */
export function handoutHomePrework(form: { title?: string; steps?: Array<{ minutes?: number }> } | null | undefined): { label: string; detail: string } | null {
  const steps = Array.isArray(form?.steps) ? form!.steps! : []
  if (!form || steps.length === 0) return null
  const minutes = steps.reduce((sum, step) => sum + (typeof step.minutes === 'number' && step.minutes > 0 ? step.minutes : 0), 0)
  const count = `${steps.length} step${steps.length === 1 ? '' : 's'}`
  return {
    label: (form.title ?? '').trim() || `${count} to do before the session`,
    detail: minutes > 0 ? `${minutes} min` : count,
  }
}
