import type { RunAudioFields } from '../shared/run-audio.ts'
import { AUDIENCE_FEEDBACK_LIMITS, parsePollDefinition, parsePollChoice, parseQuestionInput, parseReactionInput, type InstantSlide, type PollDefinition, type PollChoice } from '../../worker/protocol.ts'
import { preworkWindow } from '../shared/plan-run.ts'
import { reactionCountsBySlide, type RunQuestion, type RunReaction, type SlideReactionCounts } from '../shared/run-feedback.ts'
import { mergeRunBoards, normaliseRunBoards, type RunBoard } from '../shared/run-board.ts'
import { mergeRunPrework, normaliseRunPrework, type PreworkPick, type RunPrework } from '../shared/run-prework.ts'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { resolvePathways, type Pathway, type PathwaySlideRow } from './pathways.ts'
import { pathStaysInside } from './path-containment.ts'
import { readbackSlideTimeIndex } from './run-ink-readback.ts'

export type { RunBoard, RunPrework, RunQuestion, RunReaction, SlideReactionCounts }
export { reactionCountsBySlide, preworkWindow }

export type RunStatus = 'planned' | 'delivered'
export type RunSlideSet = { kind: 'full' } | { kind: 'pathway'; pathwayId: string }
export type RunKind = 'delivery' | 'rehearsal' | 'recording'
export type RunMark = { event: string; slideId?: string; tMs: number; hidden?: number; marks?: number; space?: 'image'; image?: number; ink?: unknown }
export type RunPollType = PollDefinition['type']
export type RunPollVisibility = 'live' | 'held'
export interface RunPoll extends Omit<PollDefinition, 'pollId'> {
  id: string
}
export interface RunPollResponse {
  responseId?: string
  pollId: string
  choice?: PollChoice
  text?: string
  tMs: number
  slideId: string
}

// ADR-0026 / live-presenting ticket 07: an instant slide shown during a live session, stamped on
// the talk's Run. `id` is stable for the show (`<kind>-<shownAt>`) so repeated history flushes never
// duplicate it; `afterSlideId` is the compiled slide id the presenter was on when it was shown
// (null when no slide had been published yet). `added` records a successful "Add to talk".
export type RunInstantSlideKind = 'text' | 'link' | 'time' | 'countdown' | 'image'
export interface RunInstantSlideAdded {
  afterSlideNumber: number
  afterSlideTitle: string
  slideId: string
  at: string
}
export interface RunInstantSlide {
  id: string
  kind: RunInstantSlideKind
  shownAt: number
  afterSlideId: string | null
  text?: string
  url?: string
  /** A web link shown with a text or countdown slide (http(s), no username or password). Never its QR code: that is regenerated. */
  link?: string
  durationMs?: number
  label?: string
  dataUrl?: string
  width?: number
  height?: number
  added?: RunInstantSlideAdded
}

export interface RunRecord {
  id: string
  talkSlug: string
  talkTitle: string
  kind: RunKind
  status: RunStatus
  plannedDate?: string
  eventTitle?: string
  audience?: string
  /** Local start time of a planned Run, `HH:MM` (ADR-0032 point 5). */
  startTime?: string
  /** Optional head count; pre-work progress is counted against it. */
  expectedPeople?: number
  /** Pre-work opening, local `YYYY-MM-DDTHH:MM`. Present exactly when the Run has pre-work. */
  preworkOpens?: string
  /** Pre-work closing, local `YYYY-MM-DDTHH:MM`. Absent = when the talk starts (plannedDate + startTime). */
  preworkCloses?: string
  /**
   * The IANA time zone the pre-work times (and the start time) were entered in, set with them
   * (feedback-boards ticket 09 fix round). Present only with a pre-work window; absent on older Runs,
   * which are read in the machine's own zone.
   */
  timeZone?: string
  slideSet: RunSlideSet
  handoutUrl?: string
  startedAt: string
  endedAt: string
  recordingMs: number
  wallClockMs: number
  timerTargetMin: number
  context: string | null
  pathwayId: string | null
  /** Local audio; segments/gaps/audioMs/partial when the recording lost its input or never reached Stop (run-audio.ts). */
  audio: ({ r2Key: string; bytes: number; uploaded: boolean } & RunAudioFields) | null
  transcript: unknown | null
  trims?: Array<{ start: number; end: number }>
  slideTimeIndex: RunMark[]
  polls: RunPoll[]
  pollResponses: RunPollResponse[]
  instantSlides?: RunInstantSlide[]
  /** Reactions from phones during a live session (ticket 06): taps and their undos, in arrival order. */
  reactions?: RunReaction[]
  /** Questions asked on phones during a live session (ticket 06), oldest first. */
  questions?: RunQuestion[]
  /** Feedback boards from a live session (feedback-boards ticket 06): cards, groups, hidden flags. */
  boards?: RunBoard[]
  /** Pre-work answers mirrored from the Worker (feedback-boards ticket 09): reads, answers, done marks, questions. */
  prework?: RunPrework
}

type PlanFields = 'startTime' | 'expectedPeople' | 'preworkOpens' | 'preworkCloses' | 'timeZone'
export type PlannedRunInput = Pick<RunRecord, 'talkSlug' | 'talkTitle' | 'plannedDate' | 'eventTitle' | 'audience' | 'slideSet'> & Partial<Pick<RunRecord, PlanFields>>
/** A patch clears an optional plan field with `null`. */
export type PlannedRunPatch = Partial<Pick<RunRecord, 'plannedDate' | 'eventTitle' | 'audience' | 'slideSet'>> & { [K in PlanFields]?: RunRecord[K] | null }

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function validDate(value: unknown): string {
  const text = asText(value)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(Date.parse(`${text}T00:00:00Z`))) {
    throw new Error('planned-date-invalid')
  }
  return text
}

function normaliseStartTime(value: unknown): string {
  const match = /^(\d{2}):(\d{2})$/.exec(asText(value))
  return match && Number(match[1]) < 24 && Number(match[2]) < 60 ? `${match[1]}:${match[2]}` : ''
}

function normaliseLocalDateTime(value: unknown): string {
  const text = asText(value)
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(text)
  if (!match || Number(match[2]) > 23 || Number(match[3]) > 59) return ''
  // Impossible dates (2026-02-31) parse in some engines by rolling over; the components must round-trip.
  const parsed = new Date(`${match[1]}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === match[1] ? text : ''
}

/** The machine's own IANA time zone. */
export function machineTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

/** An IANA time zone name the platform knows, or ''. */
export function normaliseTimeZone(value: unknown): string {
  const text = asText(value)
  if (!text || text.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(text)) return ''
  try { return new Intl.DateTimeFormat('en-GB', { timeZone: text }).resolvedOptions().timeZone ? text : '' } catch { return '' }
}

function normaliseExpectedPeople(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 100000 ? value : 0
}

function normaliseSlideSet(value: unknown, pathwayId?: unknown): RunSlideSet {
  const candidate = value as { kind?: unknown; pathwayId?: unknown } | null
  if (candidate?.kind === 'pathway' && asText(candidate.pathwayId)) {
    return { kind: 'pathway', pathwayId: asText(candidate.pathwayId) }
  }
  if (candidate?.kind === 'full') return { kind: 'full' }
  const legacyPathway = asText(pathwayId)
  return legacyPathway ? { kind: 'pathway', pathwayId: legacyPathway } : { kind: 'full' }
}

function normalisePolls(value: unknown): RunPoll[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return []
    const raw = candidate as Record<string, unknown>
    const id = asText(raw.id)
    const parsed = parsePollDefinition({ ...raw, pollId: id, visibility: raw.visibility === 'held' ? 'held' : 'live' })
    if (!parsed) return []
    const { pollId, ...definition } = parsed
    return [{ id: pollId, ...definition }]
  })
}

function normalisePollResponses(value: unknown): RunPollResponse[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return []
    const raw = candidate as Record<string, unknown>
    const pollId = asText(raw.pollId)
    const slideId = asText(raw.slideId)
    const tMs = Number(raw.tMs)
    if (!pollId || !slideId || !Number.isFinite(tMs)) return []
    const text = asText(raw.text)
    const choice = parsePollChoice(raw.choice)
    if (!text && !choice) return []
    return [{
      pollId,
      ...(asText(raw.responseId) ? { responseId: asText(raw.responseId) } : {}),
      ...(text ? { text } : { choice: choice as PollChoice }),
      tMs: Math.max(0, tMs),
      slideId,
    }]
  })
}

// An instant image slide as it is kept on a Run. A Run file is ordinary JSON in the vault, so its
// image is re-checked wherever it is read (normalisation, below) and again where it is used ("Add to
// talk", instant-slide-insert.ts). Here, without an image library (this module and its tests stay
// light): within the live message cap, and a complete WebP, PNG or JPEG header — the format's own
// frame header with a width and height above zero, and for WebP a RIFF length the bytes actually
// hold. "Add to talk" then requires a full decode before anything is stored (pasted-image-asset.ts).
/** The live cap on an instant image's data URL (same figure as instant-image.ts and the Worker). */
export const MAX_RUN_INSTANT_IMAGE_DATA_URL = 120_000

export type InstantImageFormat = 'webp' | 'png' | 'jpeg'

// The live protocol's only image form. Checked as prefix + body rather than one anchored regex
// literal, which the Metadata Registry scan would read as a frontmatter key.
const DATA_URL_PREFIX = 'data:image/webp;base64,'
const BASE64_BODY_RE = /^[A-Za-z0-9+/]+={0,2}$/

/** The image's format and pixel size read from its header, or null when the header is not a real one. */
export function imageHeader(bytes: Uint8Array): { format: InstantImageFormat; width: number; height: number } | null {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const ascii = (from: number, to: number) => buf.toString('latin1', from, to)
  const sized = (format: InstantImageFormat, width: number, height: number) =>
    width > 0 && height > 0 ? { format, width, height } : null
  if (buf.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
    if (buf.readUInt32LE(4) + 8 > buf.length) return null // truncated
    const chunk = ascii(12, 16)
    if (chunk === 'VP8 ' && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
      return sized('webp', buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff)
    }
    if (chunk === 'VP8L' && buf[20] === 0x2f) {
      const bits = buf.readUInt32LE(21)
      return sized('webp', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
    }
    if (chunk === 'VP8X') return sized('webp', buf.readUIntLE(24, 3) + 1, buf.readUIntLE(27, 3) + 1)
    return null
  }
  if (buf.length >= 33 && buf[0] === 0x89 && ascii(1, 4) === 'PNG' && buf[4] === 0x0d && buf[5] === 0x0a
    && buf[6] === 0x1a && buf[7] === 0x0a) {
    if (buf.readUInt32BE(8) !== 13 || ascii(12, 16) !== 'IHDR') return null
    return sized('png', buf.readUInt32BE(16), buf.readUInt32BE(20))
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    // Walk the marker segments to the frame header (SOFn), which carries the size.
    let at = 2
    while (at + 4 <= buf.length) {
      if (buf[at] !== 0xff) return null
      const marker = buf[at + 1]
      if (marker === 0xff) { at += 1; continue }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue }
      if (marker === 0xd9 || marker === 0xda) return null // end of image / scan data before any frame
      const length = buf.readUInt16BE(at + 2)
      if (length < 2 || at + 2 + length > buf.length) return null
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        if (length < 7) return null
        return sized('jpeg', buf.readUInt16BE(at + 7), buf.readUInt16BE(at + 5))
      }
      at += 2 + length
    }
    return null
  }
  return null
}

/** The image's real format by its header, or null. */
export function sniffImageFormat(bytes: Uint8Array): InstantImageFormat | null {
  return imageHeader(bytes)?.format ?? null
}

/** The image's bytes and real format, or null when it is over the cap or not a real image. */
export function decodeInstantImage(dataUrl: unknown): { bytes: Buffer; format: InstantImageFormat } | null {
  if (typeof dataUrl !== 'string' || dataUrl.length > MAX_RUN_INSTANT_IMAGE_DATA_URL) return null
  if (!dataUrl.startsWith(DATA_URL_PREFIX)) return null
  const body = dataUrl.slice(DATA_URL_PREFIX.length)
  if (!BASE64_BODY_RE.test(body) || body.length % 4 !== 0) return null
  const bytes = Buffer.from(body, 'base64')
  const header = imageHeader(bytes)
  return header ? { bytes, format: header.format } : null
}

const INSTANT_KINDS = new Set<RunInstantSlideKind>(['text', 'link', 'time', 'countdown', 'image'])

function normaliseInstantAdded(value: unknown): RunInstantSlideAdded | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const afterSlideNumber = Number(raw.afterSlideNumber)
  const slideId = asText(raw.slideId)
  if (!Number.isSafeInteger(afterSlideNumber) || afterSlideNumber < 1 || !slideId) return undefined
  return { afterSlideNumber, afterSlideTitle: asText(raw.afterSlideTitle), slideId, at: asText(raw.at) }
}

/**
 * The link a Run keeps with an instant slide, in its canonical form `new URL(value).href` (which percent-encodes
 * < > " and path backticks): http(s) only, no userinfo, nothing left that could open an HTML comment or a
 * Markdown construct. Otherwise undefined.
 */
export function asInstantLink(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048 || !/^https?:\/\/[^\s]+$/i.test(value) || /[\u0000-\u001f\u007f]/.test(value)) return undefined
  try {
    const url = new URL(value)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return undefined
    return url.href.length <= 2048 && !/[<>"`\u0000-\u001f\u007f]/.test(url.href) ? url.href : undefined
  } catch { return undefined }
}

function normaliseInstantSlides(value: unknown): RunInstantSlide[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return []
    const raw = candidate as Record<string, unknown>
    const kind = raw.kind as RunInstantSlideKind
    const shownAt = Number(raw.shownAt)
    if (!INSTANT_KINDS.has(kind) || !Number.isSafeInteger(shownAt) || shownAt < 0) return []
    const id = asText(raw.id) || `${kind}-${shownAt}`
    if (seen.has(id)) return []
    const entry: RunInstantSlide = { id, kind, shownAt, afterSlideId: asText(raw.afterSlideId) || null }
    if (kind === 'text') {
      if (typeof raw.text !== 'string' || !raw.text.trim()) return []
      entry.text = raw.text
      const link = asInstantLink(raw.link)
      if (link) entry.link = link
    } else if (kind === 'link') {
      const url = asInstantLink(asText(raw.url).replace(/\s/g, '%20'))
      if (!url) return []
      entry.url = url
    } else if (kind === 'countdown') {
      const durationMs = Number(raw.durationMs)
      if (!Number.isSafeInteger(durationMs) || durationMs < 1000) return []
      entry.durationMs = durationMs
      if (asText(raw.label)) entry.label = asText(raw.label)
      const link = asInstantLink(raw.link)
      if (link) entry.link = link
    } else if (kind === 'image') {
      const dataUrl = typeof raw.dataUrl === 'string' ? raw.dataUrl : ''
      const width = Number(raw.width)
      const height = Number(raw.height)
      // Within the live cap and a complete WebP/PNG/JPEG header with a real size, or the entry is not kept.
      if (!decodeInstantImage(dataUrl)
        || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) return []
      Object.assign(entry, { dataUrl, width, height })
    }
    const added = normaliseInstantAdded(raw.added)
    if (added) entry.added = added
    seen.add(id)
    return [entry]
  }).sort((a, b) => a.shownAt - b.shownAt)
}

// Reactions and questions (ticket 06). A Run file is JSON anyone can edit, so each entry is checked
// with the live protocol's own rules (worker/protocol.ts) wherever it is read; an entry that fails is
// dropped and the rest of the Run is kept. Times are clamped to whole milliseconds from the start.
function feedbackTime(value: unknown): number | null {
  const tMs = typeof value === 'number' ? value : Number.NaN
  return Number.isFinite(tMs) ? Math.max(0, Math.round(tMs)) : null
}

// An entry's id: absent, or a non-empty string of at most 100 characters. Anything else drops the entry.
function feedbackId(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') return null
  const id = value.trim()
  return id && id.length <= AUDIENCE_FEEDBACK_LIMITS.idChars ? id : null
}

function normaliseRunReactions(value: unknown): RunReaction[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return []
    const raw = candidate as Record<string, unknown>
    const tMs = feedbackTime(raw.tMs)
    const id = feedbackId(raw.id)
    // `withdrawn` is exactly true or absent; any other value is a malformed entry, never coerced.
    if (tMs === null || id === null || (raw.withdrawn !== undefined && raw.withdrawn !== true)) return []
    const parsed = parseReactionInput({ reaction: raw.reaction, slideId: raw.slideId, tMs, withdrawn: raw.withdrawn })
    if ('error' in parsed) return []
    if (id && seen.has(id)) return []
    if (id) seen.add(id)
    return [{ ...(id ? { id } : {}), ...parsed.value }]
  })
}

function normaliseRunQuestions(value: unknown): RunQuestion[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return []
    const raw = candidate as Record<string, unknown>
    const tMs = feedbackTime(raw.tMs)
    const id = feedbackId(raw.id)
    if (tMs === null || id === null) return []
    if (raw.answered !== undefined && typeof raw.answered !== 'boolean') return []
    const parsed = parseQuestionInput({ text: raw.text, name: raw.name, slideId: raw.slideId, tMs })
    if ('error' in parsed) return []
    if (id && seen.has(id)) return []
    if (id) seen.add(id)
    const { text, name, slideId } = parsed.value
    return [{ ...(id ? { id } : {}), text, ...(name ? { name } : {}), slideId, tMs, answered: raw.answered === true }]
  }).sort((a, b) => a.tMs - b.tMs)
}

export function normaliseRun(value: unknown): RunRecord {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const status: RunStatus = raw.status === 'planned' ? 'planned' : 'delivered'
  const slideSet = normaliseSlideSet(raw.slideSet, raw.pathwayId)
  const pathwayId = slideSet.kind === 'pathway' ? slideSet.pathwayId : null
  const plannedDate = asText(raw.plannedDate)
  const eventTitle = asText(raw.eventTitle)
  const audience = asText(raw.audience)
  const handoutUrl = asText(raw.handoutUrl)
  const startTime = normaliseStartTime(raw.startTime)
  const expectedPeople = normaliseExpectedPeople(raw.expectedPeople)
  const preworkOpens = normaliseLocalDateTime(raw.preworkOpens)
  const preworkCloses = preworkOpens ? normaliseLocalDateTime(raw.preworkCloses) : ''
  const timeZone = preworkOpens ? normaliseTimeZone(raw.timeZone) : ''
  const kind: RunKind = raw.kind === 'rehearsal' || raw.kind === 'recording' ? raw.kind : 'delivery'
  const instantSlides = normaliseInstantSlides(raw.instantSlides)
  const reactions = normaliseRunReactions(raw.reactions)
  const questions = normaliseRunQuestions(raw.questions)
  const boards = normaliseRunBoards(raw.boards)
  const prework = normaliseRunPrework(raw.prework)
  const run: RunRecord = {
    ...(raw as Partial<RunRecord>),
    id: asText(raw.id),
    talkSlug: asText(raw.talkSlug),
    talkTitle: asText(raw.talkTitle) || asText(raw.talkSlug),
    kind,
    status,
    ...(plannedDate ? { plannedDate } : {}),
    ...(eventTitle ? { eventTitle } : {}),
    ...(audience ? { audience } : {}),
    slideSet,
    ...(handoutUrl ? { handoutUrl } : {}),
    startedAt: asText(raw.startedAt) || (plannedDate ? `${plannedDate}T00:00:00.000Z` : ''),
    endedAt: asText(raw.endedAt),
    recordingMs: Number.isFinite(Number(raw.recordingMs)) ? Math.max(0, Number(raw.recordingMs)) : 0,
    wallClockMs: Number.isFinite(Number(raw.wallClockMs)) ? Math.max(0, Number(raw.wallClockMs)) : 0,
    timerTargetMin: Number.isFinite(Number(raw.timerTargetMin)) ? Math.max(0, Number(raw.timerTargetMin)) : 0,
    context: typeof raw.context === 'string' && raw.context.trim() ? raw.context.trim() : null,
    pathwayId,
    audio: raw.audio && typeof raw.audio === 'object' ? raw.audio as RunRecord['audio'] : null,
    transcript: raw.transcript ?? null,
    // The Pen's ink in it is checked and capped here, on the way in, before it goes anywhere.
    slideTimeIndex: readbackSlideTimeIndex<RunMark>(raw.slideTimeIndex),
    polls: normalisePolls(raw.polls),
    pollResponses: normalisePollResponses(raw.pollResponses)
  }
  // Omitted when empty so Runs without instant slides stay byte-stable on re-persist.
  if (instantSlides.length) run.instantSlides = instantSlides
  else delete run.instantSlides
  // The same for reactions and questions: a Run from before them re-persists byte for byte.
  if (reactions.length) run.reactions = reactions
  else delete run.reactions
  if (questions.length) run.questions = questions
  else delete run.questions
  // Boards the same way: a Run from before them re-persists byte for byte.
  if (boards.length) run.boards = boards
  else delete run.boards
  // Pre-work the same way: a Run from before it re-persists byte for byte.
  if (prework) run.prework = prework
  else delete run.prework
  // Plan fields (ADR-0032 point 5) are whitelisted and omitted when empty, so Runs without them
  // re-persist byte for byte.
  if (startTime) run.startTime = startTime
  else delete run.startTime
  if (expectedPeople) run.expectedPeople = expectedPeople
  else delete run.expectedPeople
  if (preworkOpens) run.preworkOpens = preworkOpens
  else delete run.preworkOpens
  if (preworkCloses) run.preworkCloses = preworkCloses
  else delete run.preworkCloses
  if (timeZone) run.timeZone = timeZone
  else delete run.timeZone
  return run
}

export function addRunPoll(run: RunRecord, poll: RunPoll): RunRecord {
  const normalised = normalisePolls([poll])[0]
  if (!normalised) throw new Error('poll-definition-invalid')
  return normaliseRun({
    ...run,
    polls: [...run.polls.filter((existing) => existing.id !== normalised.id), normalised]
  })
}

export function addRunPollResponse(run: RunRecord, response: RunPollResponse): RunRecord {
  const normalised = normalisePollResponses([response])[0]
  if (!normalised) throw new Error('poll-response-invalid')
  if (normalised.responseId && run.pollResponses.some((item) => item.responseId === normalised.responseId)) return run
  return normaliseRun({ ...run, pollResponses: [...run.pollResponses, normalised] })
}

/**
 * Re-time poll responses already on the Run from a fresh flush (ticket 06): a response with the same
 * responseId takes the fresh `tMs` (and nothing else), so answers flushed into a planned Run, timed
 * from its midnight start, are re-timed from the true start once the delivery is saved. What a vote
 * says is never changed here. Returns `run` itself when nothing changes.
 */
export function retimeRunPollResponses(run: RunRecord, fresh: RunPollResponse[]): RunRecord {
  const times = new Map(normalisePollResponses(fresh).flatMap((item) => item.responseId ? [[item.responseId, item.tMs] as const] : []))
  let changed = false
  const pollResponses = run.pollResponses.map((item) => {
    const tMs = item.responseId ? times.get(item.responseId) : undefined
    if (tMs === undefined || tMs === item.tMs) return item
    changed = true
    return { ...item, tMs }
  })
  return changed ? normaliseRun({ ...run, pollResponses }) : run
}

export function applyRunPollBuffer(
  run: RunRecord,
  buffer: { polls: RunPoll[]; responses: RunPollResponse[] }
): RunRecord {
  const withPolls = buffer.polls.reduce((current, poll) => addRunPoll(current, poll), run)
  return buffer.responses.reduce((current, response) => addRunPollResponse(current, response), withPolls)
}

// The Run's form of a shown instant slide. A link's QR code is dropped (it is regenerated from the
// URL whenever needed); everything else the audience saw is kept.
export function runInstantSlideFrom(slide: InstantSlide, afterSlideId: string | null): RunInstantSlide {
  const base = { id: `${slide.kind}-${slide.shownAt}`, kind: slide.kind, shownAt: slide.shownAt, afterSlideId: afterSlideId || null }
  if (slide.kind === 'text') return { ...base, text: slide.text, ...(asInstantLink(slide.link) ? { link: asInstantLink(slide.link) } : {}) }
  if (slide.kind === 'link') return { ...base, url: slide.url }
  if (slide.kind === 'countdown') return { ...base, durationMs: slide.durationMs, ...(slide.label ? { label: slide.label } : {}), ...(asInstantLink(slide.link) ? { link: asInstantLink(slide.link) } : {}) }
  if (slide.kind === 'image') return { ...base, dataUrl: slide.dataUrl, width: slide.width, height: slide.height }
  return base
}

// Merge instant slides shown in a live session into the Run. An entry already on the Run keeps its
// stored form (including `added`), so a later flush can never undo "Add to talk".
export function applyRunInstantSlides(run: RunRecord, entries: RunInstantSlide[]): RunRecord {
  const existing = run.instantSlides ?? []
  const known = new Set(existing.map((entry) => entry.id))
  const fresh = normaliseInstantSlides(entries).filter((entry) => !known.has(entry.id))
  if (!fresh.length) return run
  return normaliseRun({ ...run, instantSlides: [...existing, ...fresh] })
}

// Entries with an id replace the Run's entry with the same id, in place; new ones are appended;
// entries without an id are always appended. Nothing already on the Run is removed.
function mergeById<T extends { id?: string }>(existing: T[], incoming: T[]): T[] {
  const fresh = new Map(incoming.flatMap((entry) => entry.id ? [[entry.id, entry] as const] : []))
  const known = new Set(existing.flatMap((entry) => entry.id ? [entry.id] : []))
  return [
    ...existing.map((entry) => (entry.id && fresh.get(entry.id)) || entry),
    ...incoming.filter((entry) => !entry.id || !known.has(entry.id)),
  ]
}

/**
 * Merge a live session's reactions and questions into the Run (ticket 06). An entry already on the
 * Run (same id) is replaced by the fresh copy: a later "Mark answered" (or its undo) reaches a
 * question, and a reaction's time recomputed from the Run's true start replaces one computed from a
 * planned Run's midnight start. Nothing already on the Run is ever removed. Returns `run` itself when
 * nothing changes.
 */
export function applyRunAudienceFeedback(run: RunRecord, feedback: { reactions?: RunReaction[]; questions?: RunQuestion[] }): RunRecord {
  const next = normaliseRun({
    ...run,
    reactions: mergeById(run.reactions ?? [], normaliseRunReactions(feedback.reactions ?? [])),
    questions: mergeById(run.questions ?? [], normaliseRunQuestions(feedback.questions ?? [])),
  })
  return JSON.stringify(next) === JSON.stringify(run) ? run : next
}

/**
 * Merge boards from a live session into the Run (feedback-boards ticket 06), by board id. A fresh copy
 * of a board replaces the Run's cards and groups (the worker holds the whole board); History's own
 * "Put back" and times the copy does not name are kept; boards the copy does not name are kept.
 * Returns `run` itself when nothing changes.
 */
export function applyRunBoards(run: RunRecord, boards: RunBoard[]): RunRecord {
  const incoming = normaliseRunBoards(boards)
  if (!incoming.length) return run
  const next = normaliseRun({ ...run, boards: mergeRunBoards(run.boards ?? [], incoming) })
  return JSON.stringify(next) === JSON.stringify(run) ? run : next
}

/**
 * Merge a pull of the Run's pre-work from the Worker (feedback-boards ticket 09), by entry id: a fresh
 * entry replaces the Run's copy (a changed answer, an unticked task), new ones are appended, nothing on
 * the Run is removed, and History's "answered" on a question is kept. Hostile entries are dropped.
 * Returns `run` itself when nothing changes, so an unchanged pull writes nothing.
 */
export function applyRunPrework(run: RunRecord, entries: unknown[], meta: { people?: number; lastActivityAt?: number; closedAt?: number } = {}): RunRecord {
  const merged = mergeRunPrework(run.prework, entries, meta)
  if (!merged) return run
  const next = normaliseRun({ ...run, prework: merged })
  return JSON.stringify(next) === JSON.stringify(run) ? run : next
}

/**
 * Which answers a step's board slide opens with (Run page, R3). Kept on the Run's pre-work; a null
 * pick forgets the choice (back to every answer). Ids that are not answers of that step are dropped.
 */
export function setRunPreworkPick(run: RunRecord, stepId: string, pick: PreworkPick | null): RunRecord {
  const prework = run.prework
  if (!prework) throw new Error('prework-not-found')
  const picks = { ...(prework.picks ?? {}) }
  if (!pick) delete picks[stepId]
  else {
    const answers = new Set(prework.entries.filter((entry) => entry.kind === 'answer' && entry.stepId === stepId).map((entry) => entry.id))
    picks[stepId] = { mode: pick.mode, ids: pick.ids.filter((id) => answers.has(id)) }
  }
  return normaliseRun({ ...run, prework: { ...prework, picks: Object.keys(picks).length ? picks : undefined } })
}

/** History's marks on a question about a step: "Mark answered" and "Put in the talk's questions"; null clears one. */
export function markRunPreworkQuestion(run: RunRecord, entryId: string, patch: { answered?: boolean; inTalk?: { slideId: string | null } | null }): RunRecord {
  const prework = run.prework
  if (!prework?.entries.some((entry) => entry.id === entryId && entry.kind === 'question')) throw new Error('prework-question-not-found')
  const entries = prework.entries.map((entry) => {
    if (entry.id !== entryId) return entry
    const { answered: _a, inTalk: _t, ...rest } = entry
    const answered = patch.answered ?? entry.answered === true
    const inTalk = patch.inTalk === undefined ? entry.inTalk : patch.inTalk ?? undefined
    return { ...rest, ...(answered ? { answered: true as const } : {}), ...(inTalk ? { inTalk } : {}) }
  })
  return normaliseRun({ ...run, prework: { ...prework, entries } })
}

export function markRunInstantSlideAdded(run: RunRecord, entryId: string, added: RunInstantSlideAdded): RunRecord {
  const list = run.instantSlides ?? []
  if (!list.some((entry) => entry.id === entryId)) throw new Error('instant-slide-not-found')
  return normaliseRun({ ...run, instantSlides: list.map((entry) => entry.id === entryId ? { ...entry, added } : entry) })
}

// Every Run path goes through the guarded helper: talkSlug and runId can come from the renderer, and a
// name like '../../escape' or an absolute path must never reach the file system.
function runPath(vaultRoot: string, talkSlug: string, runId: string): string {
  const path = runPathForTalk(vaultRoot, talkSlug, runId)
  if (!path) throw new Error('run-path-unsafe')
  return path
}

/** Writes a Run file atomically (temporary file, then rename). */
export function writeRunFile(path: string, run: RunRecord): void {
  writeRun(path, run)
}

function writeRun(path: string, run: RunRecord): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temp, `${JSON.stringify(run, null, 2)}\n`, 'utf8')
  renameSync(temp, path)
}

export function readRun(vaultRoot: string, talkSlug: string, runId: string): RunRecord | null {
  try { return normaliseRun(JSON.parse(readFileSync(runPath(vaultRoot, talkSlug, runId), 'utf8'))) } catch { return null }
}

export function listRuns(vaultRoot: string, talkSlug?: string): RunRecord[] {
  const root = join(vaultRoot, '_PRESENTATIONS')
  if (!existsSync(root)) return []
  // A named talk comes from the renderer (history:list-runs): list only its guarded folder.
  if (talkSlug !== undefined && !talkRunFolderForTalk(vaultRoot, talkSlug)) return []
  // Only iterate DIRECTORIES: _PRESENTATIONS routinely picks up a Finder .DS_Store (and other stray
  // files). readdirSync on such a file throws ENOTDIR — if that escaped, History blanked entirely.
  const slugs = talkSlug ? [talkSlug] : readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  const runs: RunRecord[] = []
  for (const slug of slugs) {
    const dir = join(root, slug)
    // A Run file that is a link resolving outside the vault is skipped, never read. (A talk folder
    // that is a link is never reached: the Dirent filter above skips links, and a named talk went
    // through talkRunFolderForTalk.)
    let names: string[]
    try { names = readdirSync(dir) } catch { continue } // not a directory / unreadable — skip, never throw
    for (const name of names) {
      if (!name.endsWith('.json') || name === 'manifest.json') continue
      const file = join(dir, name)
      if (!pathStaysInside(vaultRoot, file)) continue
      try {
        const run = normaliseRun(JSON.parse(readFileSync(file, 'utf8')))
        if (run.id && run.talkSlug) runs.push(run)
      } catch { /* one malformed Run must not blank History */ }
    }
  }
  return runs.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'planned' ? -1 : 1
    if (a.status === 'planned') return (a.plannedDate ?? '').localeCompare(b.plannedDate ?? '')
    return b.startedAt.localeCompare(a.startedAt)
  })
}

// A plan field that is present but unreadable is refused, not silently dropped: the sheet would
// otherwise report "Run planned" for a Run that lost its pre-work window.
function assertPlanFields(fields: Partial<Record<PlanFields, unknown>>): void {
  const present = (value: unknown): boolean => value !== undefined && value !== null && value !== ''
  if (present(fields.startTime) && !normaliseStartTime(fields.startTime)) throw new Error('start-time-invalid')
  if (present(fields.expectedPeople) && !normaliseExpectedPeople(fields.expectedPeople)) throw new Error('expected-people-invalid')
  if (present(fields.preworkOpens) && !normaliseLocalDateTime(fields.preworkOpens)) throw new Error('prework-opens-invalid')
  if (present(fields.preworkCloses) && !normaliseLocalDateTime(fields.preworkCloses)) throw new Error('prework-closes-invalid')
  if (present(fields.timeZone) && !normaliseTimeZone(fields.timeZone)) throw new Error('time-zone-invalid')
}

// A closing time without an opening is refused, not silently dropped by the normaliser.
function assertClosesHaveOpens(closes: unknown, opens: unknown): void {
  if (asText(closes) && !asText(opens)) throw new Error('prework-closes-without-opens')
}

function assertPreworkOrder(run: RunRecord): void {
  const window = preworkWindow(run)
  if (window && window.closes <= window.opens) throw new Error('prework-closes-before-opens')
}

export function createPlannedRun(vaultRoot: string, input: PlannedRunInput, idFactory: () => string = () => `run-${Date.now().toString(36)}`): RunRecord {
  const plannedDate = validDate(input.plannedDate)
  const eventTitle = asText(input.eventTitle)
  if (!eventTitle) throw new Error('event-title-required')
  assertPlanFields(input)
  assertClosesHaveOpens(input.preworkCloses, input.preworkOpens)
  if (!isSafeTalkSlug(input.talkSlug)) throw new Error('run-path-unsafe')
  const id = asText(idFactory())
  if (!id || existsSync(runPath(vaultRoot, input.talkSlug, id))) throw new Error('run-id-collision')
  const slideSet = normaliseSlideSet(input.slideSet)
  const run = normaliseRun({
    id,
    talkSlug: input.talkSlug,
    talkTitle: input.talkTitle,
    kind: 'delivery',
    status: 'planned',
    plannedDate,
    eventTitle,
    audience: asText(input.audience),
    startTime: input.startTime,
    expectedPeople: input.expectedPeople,
    preworkOpens: input.preworkOpens,
    preworkCloses: input.preworkCloses,
    // The zone the pre-work times were entered in: the one sent, else this machine's.
    timeZone: input.preworkOpens ? (input.timeZone || machineTimeZone()) : undefined,
    slideSet,
    pathwayId: slideSet.kind === 'pathway' ? slideSet.pathwayId : null,
    startedAt: `${plannedDate}T00:00:00.000Z`,
    endedAt: '', recordingMs: 0, wallClockMs: 0, timerTargetMin: 0,
    context: null, audio: null, transcript: null, slideTimeIndex: []
  })
  assertPreworkOrder(run)
  writeRun(runPath(vaultRoot, run.talkSlug, run.id), run)
  return run
}

export function updatePlannedRun(vaultRoot: string, talkSlug: string, runId: string, patch: PlannedRunPatch): RunRecord | null {
  // Called only for its throw: an unsafe name is refused as run-path-unsafe, not reported as not found.
  runPath(vaultRoot, talkSlug, runId)
  const current = readRun(vaultRoot, talkSlug, runId)
  if (!current || current.status !== 'planned') return null
  assertPlanFields(patch)
  // Switching pre-work off (opens: null) clears the closing time with it; naming a closing time
  // while there is no opening is refused.
  const opensAfter = patch.preworkOpens !== undefined ? patch.preworkOpens : current.preworkOpens
  if (patch.preworkOpens !== null) assertClosesHaveOpens(patch.preworkCloses !== undefined ? patch.preworkCloses : current.preworkCloses, opensAfter)
  const next = normaliseRun({
    ...current,
    ...(patch.startTime !== undefined ? { startTime: patch.startTime ?? undefined } : {}),
    ...(patch.expectedPeople !== undefined ? { expectedPeople: patch.expectedPeople ?? undefined } : {}),
    ...(patch.preworkOpens !== undefined ? { preworkOpens: patch.preworkOpens ?? undefined } : {}),
    ...(patch.preworkOpens === null ? { preworkCloses: undefined } : patch.preworkCloses !== undefined ? { preworkCloses: patch.preworkCloses ?? undefined } : {}),
    // The zone is the Run's: kept on every edit unless the sheet sends a different one (a Run planned
    // for Prague stays Prague when edited from Oxford). A window set for the first time without one
    // takes this machine's; switching pre-work off drops it.
    ...(patch.preworkOpens === null ? { timeZone: undefined }
      : patch.timeZone ? { timeZone: patch.timeZone }
        : patch.preworkOpens !== undefined && !current.preworkOpens ? { timeZone: machineTimeZone() } : {}),
    ...(patch.plannedDate !== undefined ? { plannedDate: validDate(patch.plannedDate) } : {}),
    ...(patch.eventTitle !== undefined ? { eventTitle: asText(patch.eventTitle) } : {}),
    ...(patch.audience !== undefined ? { audience: asText(patch.audience) } : {}),
    ...(patch.slideSet !== undefined ? { slideSet: normaliseSlideSet(patch.slideSet) } : {})
  })
  if (!next.eventTitle) throw new Error('event-title-required')
  next.startedAt = `${next.plannedDate}T00:00:00.000Z`
  assertPreworkOrder(next)
  writeRun(runPath(vaultRoot, talkSlug, runId), next)
  return next
}

export function deletePlannedRun(vaultRoot: string, talkSlug: string, runId: string): boolean {
  // Called only for its throw: an unsafe name is refused as run-path-unsafe, not reported as not found.
  runPath(vaultRoot, talkSlug, runId)
  const current = readRun(vaultRoot, talkSlug, runId)
  if (!current || current.status !== 'planned') return false
  rmSync(runPath(vaultRoot, talkSlug, runId))
  return true
}

export function attachDeliveryToPlanned(planned: RunRecord, delivery: RunRecord): RunRecord {
  if (planned.status !== 'planned') throw new Error('run-not-planned')
  if (planned.talkSlug !== delivery.talkSlug) throw new Error('run-talk-mismatch')
  const attached = normaliseRun({
    ...delivery,
    id: planned.id,
    status: 'delivered',
    plannedDate: planned.plannedDate,
    eventTitle: planned.eventTitle,
    audience: planned.audience,
    startTime: planned.startTime,
    expectedPeople: planned.expectedPeople,
    preworkOpens: planned.preworkOpens,
    preworkCloses: planned.preworkCloses,
    timeZone: planned.timeZone,
    slideSet: planned.slideSet,
    pathwayId: planned.slideSet.kind === 'pathway' ? planned.slideSet.pathwayId : null,
    handoutUrl: planned.handoutUrl,
    // Pre-work answered before the day belongs to the Run it was planned as (with History's marks).
    prework: planned.prework
  })
  // A live session may already have flushed polls, answers, instant slides, reactions and questions
  // into the planned Run before the delivery is saved; they are kept (ticket 06 fix round).
  const withPolls = planned.polls.reduce((current, poll) => { try { return addRunPoll(current, poll) } catch { return current } }, attached)
  const withResponses = planned.pollResponses.reduce((current, response) => { try { return addRunPollResponse(current, response) } catch { return current } }, withPolls)
  const withInstant = applyRunInstantSlides(withResponses, planned.instantSlides ?? [])
  // The delivery's own entries (none today) win over the planned Run's copies of the same id.
  const withFeedback = applyRunAudienceFeedback(applyRunAudienceFeedback(withInstant, { reactions: planned.reactions, questions: planned.questions }),
    { reactions: attached.reactions, questions: attached.questions })
  // Boards flushed into the planned Run are kept; the delivery's own copy of a board wins.
  return applyRunBoards(applyRunBoards(withFeedback, planned.boards ?? []), attached.boards ?? [])
}

export function plannedRunCandidates(runs: RunRecord[], pathwayId: string | null): RunRecord[] {
  return runs
    .filter((run) => run.status === 'planned')
    .sort((a, b) => (a.plannedDate ?? '').localeCompare(b.plannedDate ?? '') || a.eventTitle!.localeCompare(b.eventTitle!))
}

export function resolveRunSlideSet<Row extends PathwaySlideRow>(slideSet: RunSlideSet, pathways: Pathway[], rows: Row[]): { rows: Row[]; missing: string[] } {
  if (slideSet.kind === 'full') return { rows, missing: [] }
  const resolved = resolvePathways(pathways, rows).find((pathway) => pathway.id === slideSet.pathwayId)
  return resolved ? { rows: resolved.present, missing: resolved.missing } : { rows: [], missing: [slideSet.pathwayId] }
}

function slugPart(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

export function runHandoutSlug(talkSlug: string, eventTitle: string, plannedDate: string, existingSlugs: Iterable<string>): string {
  const base = [slugPart(talkSlug), slugPart(eventTitle), slugPart(plannedDate)].filter(Boolean).join('-')
  const used = new Set(existingSlugs)
  if (!used.has(base)) return base
  let n = 2
  while (used.has(`${base}-${n}`)) n += 1
  return `${base}-${n}`
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function displayRunDate(value: string): string {
  const date = new Date(`${value}T12:00:00Z`)
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date)
    : value
}

export function injectRunCoverMetadata(html: string, eventTitle: string, plannedDate: string): string {
  const meta = `<p class="run-cover-meta">${escapeHtml(eventTitle)} · ${escapeHtml(displayRunDate(plannedDate))}</p>`
  const firstHeading = /(<h1\b[^>]*>[\s\S]*?<\/h1>)/i
  if (firstHeading.test(html)) return html.replace(firstHeading, `$1${meta}`)
  const firstContent = /(<div\b[^>]*class="[^"]*\bslide-content\b[^"]*"[^>]*>)/i
  if (firstContent.test(html)) return html.replace(firstContent, `$1${meta}`)
  const firstSlide = /(<(?:section|article|div)\b[^>]*class="[^"]*\bslide\b[^"]*"[^>]*>)/i
  return firstSlide.test(html) ? html.replace(firstSlide, `$1${meta}`) : `${meta}${html}`
}

export function setRunHandoutUrl(run: RunRecord, url: string): RunRecord {
  return normaliseRun({ ...run, handoutUrl: asText(url) })
}

export function clearRunHandoutUrl(run: RunRecord): RunRecord {
  const next = { ...run }
  delete next.handoutUrl
  return normaliseRun(next)
}

// ── Run paths chosen from outside (ticket 07 "Add to talk") ────────────────────────────────────
// A renderer or agent names a Run by talk slug + run id; both become path components, and a Run
// file's own `id` / `talkSlug` are JSON anyone can edit. So: both names must be single safe path
// segments, the Run is loaded only from `<vault>/_PRESENTATIONS/<slug>/<runId>.json`, it must say
// it belongs there, and it is written back only to that same resolved path, inside the vault.
const SAFE_RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
// Talk slugs are outline file names (`<slug>-outline.md`), so letters beyond ASCII and spaces are
// legitimate; separators, control characters and a leading dot (`.`, `..`, hidden) are not.
const SAFE_TALK_SLUG_RE = /^(?!\.)[^/\\\u0000-\u001f\u007f]{1,200}$/u

// A Run file shares its talk folder with other files the app writes there. The only other JSON is
// the pathway manifest (`manifest.json`); an id that names it would let a Run edit or delete it.
// Compared case-insensitively: the macOS file system treats `Manifest.json` as the same file.
const RESERVED_RUN_IDS = new Set(['manifest'])

export function isSafeRunId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_RUN_ID_RE.test(value) && !RESERVED_RUN_IDS.has(value.toLowerCase())
}

export function isSafeTalkSlug(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && SAFE_TALK_SLUG_RE.test(value)
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..')
}

function realpathOrNull(path: string): string | null {
  try { return realpathSync(path) } catch { return null }
}

function lexists(path: string): boolean {
  try { lstatSync(path); return true } catch { return false }
}

function insideOrSame(parent: string, child: string): boolean {
  return parent === child || inside(parent, child)
}

/**
 * True when `path` — which may not exist yet — stays inside the vault once symlinks are resolved:
 * the nearest ancestor that exists (as a file, folder or link) must resolve inside the vault's real
 * path, and so must `path` itself when it exists. A symlinked `_PRESENTATIONS` or talk folder that
 * points elsewhere, a dangling link, or a Run file linked to a file elsewhere all fail.
 */
function staysInVault(realVault: string, path: string): boolean {
  let probe = path
  while (!lexists(probe)) {
    const parent = dirname(probe)
    if (parent === probe) return false
    probe = parent
  }
  const real = realpathOrNull(probe)
  return !!real && insideOrSame(realVault, real)
}

/**
 * The Run file for `talkSlug` / `runId`, or null when either name is unsafe or the path would leave
 * the vault — lexically, or once symlinks are resolved (a folder that does not exist yet is judged by
 * its nearest existing ancestor; an existing Run file must itself resolve inside the vault).
 */
export function runPathForTalk(vaultRoot: string, talkSlug: string, runId: string): string | null {
  if (!vaultRoot || !isSafeTalkSlug(talkSlug) || !isSafeRunId(runId)) return null
  const vault = resolve(vaultRoot)
  const folder = resolve(vault, '_PRESENTATIONS', talkSlug)
  const path = join(folder, `${runId}.json`)
  if (!inside(vault, path) || dirname(path) !== folder) return null
  const realVault = realpathOrNull(vault)
  if (!realVault || !staysInVault(realVault, path)) return null
  return path
}

/**
 * The talk's Run folder `<vault>/_PRESENTATIONS/<talkSlug>`, or null when the slug is unsafe or the
 * folder would leave the vault — lexically, or once symlinks are resolved (same rule as
 * `runPathForTalk`; a folder that does not exist yet is judged by its nearest existing ancestor).
 */
export function talkRunFolderForTalk(vaultRoot: string, talkSlug: string): string | null {
  if (!vaultRoot || !isSafeTalkSlug(talkSlug)) return null
  const vault = resolve(vaultRoot)
  const presentations = join(vault, '_PRESENTATIONS')
  const folder = resolve(presentations, talkSlug)
  if (!inside(vault, folder) || dirname(folder) !== presentations) return null
  const realVault = realpathOrNull(vault)
  if (!realVault || !staysInVault(realVault, folder)) return null
  return folder
}

/** Reads a Run only from its talk's folder, and only if the Run says it is that talk's Run. */
export function readRunForTalk(vaultRoot: string, talkSlug: string, runId: string): RunRecord | null {
  const path = runPathForTalk(vaultRoot, talkSlug, runId)
  if (!path) return null
  let run: RunRecord
  try { run = normaliseRun(JSON.parse(readFileSync(path, 'utf8'))) } catch { return null }
  return run.id === runId && run.talkSlug === talkSlug ? run : null
}

/** Writes `run` back to exactly `<vault>/_PRESENTATIONS/<talkSlug>/<runId>.json`; throws otherwise. */
export function persistRunForTalk(vaultRoot: string, talkSlug: string, runId: string, run: RunRecord): RunRecord {
  const normalised = normaliseRun(run)
  if (normalised.id !== runId || normalised.talkSlug !== talkSlug) throw new Error('run-identity-mismatch')
  const path = runPathForTalk(vaultRoot, talkSlug, runId)
  if (!path) throw new Error('run-path-unsafe')
  mkdirSync(dirname(path), { recursive: true })
  // Checked again once the folder exists: it must be the vault's own folder, not one reached
  // through a link swapped in meanwhile. The rename below replaces the Run file itself (a link
  // there is replaced, never followed).
  const realVault = realpathOrNull(resolve(vaultRoot))
  const realFolder = realpathOrNull(dirname(path))
  if (!realVault || !realFolder || !inside(realVault, realFolder)) throw new Error('run-path-unsafe')
  writeRun(path, normalised)
  return normalised
}

export function persistRun(vaultRoot: string, run: RunRecord): RunRecord {
  const normalised = normaliseRun(run)
  writeRun(runPath(vaultRoot, normalised.talkSlug, normalised.id), normalised)
  return normalised
}
