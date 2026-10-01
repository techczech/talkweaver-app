// Pre-work answers on the Run (ADR-0032 amendment point 4; feedback-boards ticket 09), and the public
// form the app sends to the Worker and the handout (amendment points 2–3). Pure: no Electron, no fs.
//
// The Run keeps what the Worker holds for its pre-work: one entry per participant and step for a read,
// an answer and a done mark (the latest wins), and one per question. Entries are merged by id, so a
// pull never duplicates one and a changed answer replaces the old one; nothing already on the Run is
// removed; History's own mark on a question ("Mark answered") survives a pull. The Run file is JSON
// anyone can edit, so every entry is read through the Worker's own parser, and one that fails is
// dropped while the rest of the Run is kept.
//
// The public form never carries the quick check's right answer: it is built from the compiler's
// pre-work definition field by field and checked by the Worker's parser, which refuses a `right` key.
import {
  parsePreworkEntry, parsePreworkForm, type PreworkEntry, type PreworkForm, type PreworkFormStep, type PreworkPoll,
} from '../../worker/prework-protocol.ts'
import { BOARD_SEED_MAX } from '../../worker/board-protocol.ts'
import type { PollOption } from '../../worker/protocol.ts'

export type { PreworkEntry, PreworkForm }

/** An entry as the Run keeps it: no Worker sequence; a question may carry History's `answered`. */
export type RunPreworkEntry = Omit<PreworkEntry, 'seq'> & {
  answered?: true
  /** A question put in the talk's questions (History's "Put in the talk's questions"); `slideId` is where it comes up, null = the slide the presenter is on. */
  inTalk?: { slideId: string | null }
}

/** Which of a step's answers the talk's board slide opens with: the ones starred, or every one. */
export interface PreworkPick {
  mode: 'picked' | 'all'
  /** Entry ids of the starred answers, in the order the board takes them. */
  ids: string[]
}

export interface RunPrework {
  entries: RunPreworkEntry[]
  /** People who took part, as the Worker counted them at the last pull. */
  people?: number
  /** The Worker's last submission or push (ms), for "Last activity". */
  lastActivityAt?: number
  /** When it was closed early from the app ("Close pre-work now"), ms. */
  closedAt?: number
  /** Picked answers, per step id. They belong to the Run, not the outline, and no participant sees them. */
  picks?: Record<string, PreworkPick>
}

/** The longest slide id an entry's `inTalk` keeps. */
export const RUN_PREWORK_MAX_SLIDE_ID = 200

/** The most answers one step's pick keeps: what a board can open with (one constant, in the Worker's board protocol). */
export const RUN_PREWORK_MAX_PICKS = BOARD_SEED_MAX

/** The most entries a Run keeps (2 000 people × every step would exceed it; the Worker caps bytes first). */
export const RUN_PREWORK_MAX_ENTRIES = 50_000

function count(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined
}

function normaliseEntry(value: unknown): RunPreworkEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (raw.answered !== undefined && raw.answered !== true) return null
  const parsed = parsePreworkEntry({ ...raw, seq: 0 })
  if (!parsed) return null
  const { seq: _seq, ...entry } = parsed
  if (entry.kind !== 'question') return entry
  const inTalk = raw.inTalk && typeof raw.inTalk === 'object' && !Array.isArray(raw.inTalk) ? (raw.inTalk as Record<string, unknown>).slideId : undefined
  const slideId = typeof inTalk === 'string' && inTalk && inTalk.length <= RUN_PREWORK_MAX_SLIDE_ID ? inTalk : inTalk === null ? null : undefined
  return { ...entry, ...(raw.answered === true ? { answered: true as const } : {}), ...(slideId !== undefined ? { inTalk: { slideId } } : {}) }
}

function normalisePicks(value: unknown): Record<string, PreworkPick> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const picks: Record<string, PreworkPick> = {}
  for (const [stepId, candidate] of Object.entries(value)) {
    if (!stepId || stepId.length > 200 || !candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const raw = candidate as Record<string, unknown>
    if (raw.mode !== 'picked' && raw.mode !== 'all') continue
    const ids = [...new Set(Array.isArray(raw.ids) ? raw.ids.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 400) : [])].slice(0, RUN_PREWORK_MAX_PICKS)
    picks[stepId] = { mode: raw.mode, ids }
  }
  return Object.keys(picks).length ? picks : undefined
}

/** The Run's pre-work, read field by field; null when there is nothing to keep. */
export function normaliseRunPrework(value: unknown): RunPrework | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const seen = new Set<string>()
  const entries: RunPreworkEntry[] = []
  for (const candidate of Array.isArray(raw.entries) ? raw.entries : []) {
    if (entries.length >= RUN_PREWORK_MAX_ENTRIES) break
    const entry = normaliseEntry(candidate)
    if (!entry || seen.has(entry.id)) continue
    seen.add(entry.id)
    entries.push(entry)
  }
  const people = count(raw.people)
  const lastActivityAt = count(raw.lastActivityAt)
  const closedAt = count(raw.closedAt)
  const picks = normalisePicks(raw.picks)
  if (!entries.length && people === undefined && lastActivityAt === undefined && closedAt === undefined && !picks) return null
  return {
    entries,
    ...(people !== undefined ? { people } : {}),
    ...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
    ...(closedAt !== undefined ? { closedAt } : {}),
    ...(picks ? { picks } : {}),
  }
}

/**
 * Merge a pull into the Run's pre-work, by entry id. A fresh entry replaces the Run's entry with the
 * same id in place (keeping a question's `answered`); new entries are appended; none is removed.
 * Entries from the Worker that fail its parser are dropped.
 */
export function mergeRunPrework(current: RunPrework | null | undefined, incoming: unknown[], meta: { people?: number; lastActivityAt?: number; closedAt?: number } = {}): RunPrework | null {
  const fresh = new Map<string, RunPreworkEntry>()
  for (const candidate of incoming) {
    const entry = normaliseEntry(candidate)
    if (entry) fresh.set(entry.id, entry)
  }
  const existing = current?.entries ?? []
  const known = new Set(existing.map((entry) => entry.id))
  const entries = [
    ...existing.map((entry) => {
      const next = fresh.get(entry.id)
      if (!next) return entry
      const { answered: _ignored, inTalk: _talk, ...rest } = next
      return { ...rest, ...(entry.answered ? { answered: true as const } : {}), ...(entry.inTalk ? { inTalk: entry.inTalk } : {}) }
    }),
    ...[...fresh.values()].filter((entry) => !known.has(entry.id)).map(({ answered: _a, inTalk: _t, ...entry }) => entry),
  ]
  return normaliseRunPrework({
    picks: current?.picks,
    entries,
    people: meta.people ?? current?.people,
    lastActivityAt: meta.lastActivityAt ?? current?.lastActivityAt,
    closedAt: meta.closedAt ?? current?.closedAt,
  })
}

// ── The public form ─────────────────────────────────────────────────────────────────────────

/** The compiler's pre-work definition (compiler/scripts/lib/prework.mjs), as far as this reads it. */
export interface CompiledPrework {
  title?: unknown
  intro?: unknown
  steps?: unknown
  slideIds?: unknown
}

interface CompiledSlide { id?: unknown; poll?: unknown }

function options(value: unknown): PollOption[] {
  return Array.isArray(value)
    ? value.flatMap((option) => option && typeof option === 'object' && typeof (option as PollOption).optionId === 'string' && typeof (option as PollOption).label === 'string'
      ? [{ optionId: (option as PollOption).optionId, label: (option as PollOption).label }] : [])
    : []
}

/** A step's poll as participants answer it: type, question, options and limits — nothing else. */
function stepPoll(poll: unknown): PreworkPoll | null {
  if (!poll || typeof poll !== 'object') return null
  const raw = poll as Record<string, unknown>
  if (typeof raw.type !== 'string' || raw.type === 'board') return null
  return {
    type: raw.type as PreworkPoll['type'],
    question: typeof raw.question === 'string' ? raw.question : '',
    options: options(raw.options),
    ...(Array.isArray(raw.labels) ? { labels: options(raw.labels) } : {}),
    ...(typeof raw.rankCount === 'number' ? { rankCount: raw.rankCount } : {}),
    ...(typeof raw.allowSkip === 'boolean' ? { allowSkip: raw.allowSkip } : {}),
    ...(typeof raw.maxSelections === 'number' ? { maxSelections: raw.maxSelections } : {}),
  }
}

/**
 * The form participants get, built from the compiler's pre-work definition and the compiled slides'
 * polls. Field by field, so the check's right answer (on the definition's step) is never copied; the
 * result is checked by the Worker's own parser. A step whose poll cannot be answered on the form (a
 * board) is sent as a slide participants read. Null when the talk has no pre-work or it is unreadable.
 */
export function publicPreworkForm(prework: CompiledPrework | null | undefined, slides: CompiledSlide[]): PreworkForm | null {
  if (!prework || !Array.isArray(prework.steps)) return null
  const polls = new Map(slides.flatMap((slide) => typeof slide?.id === 'string' && slide.poll ? [[slide.id, slide.poll] as const] : []))
  const steps: PreworkFormStep[] = prework.steps.flatMap((candidate, index): PreworkFormStep[] => {
    if (!candidate || typeof candidate !== 'object') return []
    const raw = candidate as Record<string, unknown>
    if (typeof raw.id !== 'string') return []
    const base = { id: raw.id, n: index + 1, title: typeof raw.title === 'string' ? raw.title : '', questions: raw.questions !== false }
    if (raw.kind === 'task') {
      return [{ ...base, kind: 'task' as const, done: raw.done !== false, ...(typeof raw.minutes === 'number' ? { minutes: raw.minutes } : {}) }]
    }
    if (raw.kind === 'check' || raw.kind === 'question') {
      const poll = stepPoll(polls.get(raw.id))
      if (poll && (raw.kind === 'question' || poll.type === 'single')) return [{ ...base, kind: raw.kind, poll }]
    }
    return [{ ...base, kind: 'slide' as const }]
  })
  const parsed = parsePreworkForm({ title: typeof prework.title === 'string' ? prework.title : '', intro: typeof prework.intro === 'string' ? prework.intro : '', steps })
  return 'value' in parsed ? parsed.value : null
}

/** The UTC offset (ms) of `timeZone` at the instant `ms`. */
function zoneOffset(ms: number, timeZone: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms)).map((part) => [part.type, part.value]))
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second)) - Math.floor(ms / 1000) * 1000
}

/**
 * A wall-clock time (`YYYY-MM-DDTHH:MM`) in an IANA zone as ms, or NaN. Without a zone (or with one
 * the platform does not know) it is read in the machine's own zone. A time a clock change skips is
 * moved forward by the change; a time it repeats takes the first.
 */
export function zonedLocalToMs(local: string, timeZone?: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local)
  if (!match) return Number.NaN
  const [y, mo, d, h, mi] = match.slice(1).map(Number)
  if (timeZone) {
    try {
      const wall = Date.UTC(y, mo - 1, d, h, mi)
      // The offsets a day either side bracket any clock change on the day.
      const candidates = [...new Set([zoneOffset(wall - 86_400_000, timeZone), zoneOffset(wall + 86_400_000, timeZone)])].map((offset) => wall - offset)
      const valid = candidates.filter((ms) => ms + zoneOffset(ms, timeZone) === wall)
      // Repeated (clocks back): the first. Skipped (clocks forward): read with the offset before the change.
      return valid.length ? Math.min(...valid) : wall - zoneOffset(wall - 86_400_000, timeZone)
    } catch { /* an unknown zone: the machine's own */ }
  }
  return new Date(y, mo - 1, d, h, mi).getTime()
}

/**
 * A Run's pre-work window as the Worker takes it (ms). The Run's times are wall-clock
 * (`YYYY-MM-DDTHH:MM`) in the zone they were entered in (`timeZone` on the Run; older Runs have
 * none and are read in the machine's zone); closing defaults to when the talk starts. Null without
 * a window, or when it closes before it opens.
 */
export function preworkWindowMs(window: { opens: string; closes: string } | null, timeZone?: string): { opensAt: number; closesAt: number } | null {
  if (!window) return null
  const opensAt = zonedLocalToMs(window.opens, timeZone), closesAt = zonedLocalToMs(window.closes, timeZone)
  return Number.isSafeInteger(opensAt) && Number.isSafeInteger(closesAt) && closesAt > opensAt ? { opensAt, closesAt } : null
}

/**
 * The talk's slides without its pre-work steps (the section slide and every step): what every
 * handout lists. Pre-work is answered on the form of a planned Run's handout, never read as slides.
 */
export function withoutPreworkSlides<T extends { id?: unknown }>(slides: T[], prework: CompiledPrework | null | undefined): T[] {
  const ids = new Set(Array.isArray(prework?.slideIds) ? prework!.slideIds.filter((id): id is string => typeof id === 'string') : [])
  return ids.size ? slides.filter((slide) => !(typeof slide.id === 'string' && ids.has(slide.id))) : slides
}

/** What the published handout carries to ask the Worker about its pre-work and show the form. */
export interface HandoutPreworkConfig {
  preworkId: string
  workerBaseUrl: string
  form: PreworkForm
}
