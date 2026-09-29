import { parsePollDefinition, parsePollChoice, type InstantSlide, type PollDefinition, type PollChoice } from '../../worker/protocol.ts'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { resolvePathways, type Pathway, type PathwaySlideRow } from './pathways.ts'

export type RunStatus = 'planned' | 'delivered'
export type RunSlideSet = { kind: 'full' } | { kind: 'pathway'; pathwayId: string }
export type RunKind = 'delivery' | 'rehearsal' | 'recording'
export type RunMark = { event: string; slideId?: string; tMs: number; hidden?: number; marks?: number }
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
  slideSet: RunSlideSet
  handoutUrl?: string
  startedAt: string
  endedAt: string
  recordingMs: number
  wallClockMs: number
  timerTargetMin: number
  context: string | null
  pathwayId: string | null
  audio: { r2Key: string; bytes: number; uploaded: boolean } | null
  transcript: unknown | null
  trims?: Array<{ start: number; end: number }>
  slideTimeIndex: RunMark[]
  polls: RunPoll[]
  pollResponses: RunPollResponse[]
  instantSlides?: RunInstantSlide[]
}

export type PlannedRunInput = Pick<RunRecord, 'talkSlug' | 'talkTitle' | 'plannedDate' | 'eventTitle' | 'audience' | 'slideSet'>
export type PlannedRunPatch = Partial<Pick<RunRecord, 'plannedDate' | 'eventTitle' | 'audience' | 'slideSet'>>

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
    } else if (kind === 'link') {
      const url = asText(raw.url)
      if (!/^https?:\/\//i.test(url)) return []
      entry.url = url
    } else if (kind === 'countdown') {
      const durationMs = Number(raw.durationMs)
      if (!Number.isSafeInteger(durationMs) || durationMs < 1000) return []
      entry.durationMs = durationMs
      if (asText(raw.label)) entry.label = asText(raw.label)
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

export function normaliseRun(value: unknown): RunRecord {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const status: RunStatus = raw.status === 'planned' ? 'planned' : 'delivered'
  const slideSet = normaliseSlideSet(raw.slideSet, raw.pathwayId)
  const pathwayId = slideSet.kind === 'pathway' ? slideSet.pathwayId : null
  const plannedDate = asText(raw.plannedDate)
  const eventTitle = asText(raw.eventTitle)
  const audience = asText(raw.audience)
  const handoutUrl = asText(raw.handoutUrl)
  const kind: RunKind = raw.kind === 'rehearsal' || raw.kind === 'recording' ? raw.kind : 'delivery'
  const instantSlides = normaliseInstantSlides(raw.instantSlides)
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
    slideTimeIndex: Array.isArray(raw.slideTimeIndex) ? raw.slideTimeIndex as RunMark[] : [],
    polls: normalisePolls(raw.polls),
    pollResponses: normalisePollResponses(raw.pollResponses)
  }
  // Omitted when empty so Runs without instant slides stay byte-stable on re-persist.
  if (instantSlides.length) run.instantSlides = instantSlides
  else delete run.instantSlides
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
  if (slide.kind === 'text') return { ...base, text: slide.text }
  if (slide.kind === 'link') return { ...base, url: slide.url }
  if (slide.kind === 'countdown') return { ...base, durationMs: slide.durationMs, ...(slide.label ? { label: slide.label } : {}) }
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

export function markRunInstantSlideAdded(run: RunRecord, entryId: string, added: RunInstantSlideAdded): RunRecord {
  const list = run.instantSlides ?? []
  if (!list.some((entry) => entry.id === entryId)) throw new Error('instant-slide-not-found')
  return normaliseRun({ ...run, instantSlides: list.map((entry) => entry.id === entryId ? { ...entry, added } : entry) })
}

function runPath(vaultRoot: string, talkSlug: string, runId: string): string {
  return join(vaultRoot, '_PRESENTATIONS', talkSlug, `${runId}.json`)
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
  // Only iterate DIRECTORIES: _PRESENTATIONS routinely picks up a Finder .DS_Store (and other stray
  // files). readdirSync on such a file throws ENOTDIR — if that escaped, History blanked entirely.
  const slugs = talkSlug ? [talkSlug] : readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  const runs: RunRecord[] = []
  for (const slug of slugs) {
    const dir = join(root, slug)
    let names: string[]
    try { names = readdirSync(dir) } catch { continue } // not a directory / unreadable — skip, never throw
    for (const name of names) {
      if (!name.endsWith('.json') || name === 'manifest.json') continue
      try {
        const run = normaliseRun(JSON.parse(readFileSync(join(dir, name), 'utf8')))
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

export function createPlannedRun(vaultRoot: string, input: PlannedRunInput, idFactory: () => string = () => `run-${Date.now().toString(36)}`): RunRecord {
  const plannedDate = validDate(input.plannedDate)
  const eventTitle = asText(input.eventTitle)
  if (!eventTitle) throw new Error('event-title-required')
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
    slideSet,
    pathwayId: slideSet.kind === 'pathway' ? slideSet.pathwayId : null,
    startedAt: `${plannedDate}T00:00:00.000Z`,
    endedAt: '', recordingMs: 0, wallClockMs: 0, timerTargetMin: 0,
    context: null, audio: null, transcript: null, slideTimeIndex: []
  })
  writeRun(runPath(vaultRoot, run.talkSlug, run.id), run)
  return run
}

export function updatePlannedRun(vaultRoot: string, talkSlug: string, runId: string, patch: PlannedRunPatch): RunRecord | null {
  const current = readRun(vaultRoot, talkSlug, runId)
  if (!current || current.status !== 'planned') return null
  const next = normaliseRun({
    ...current,
    ...(patch.plannedDate !== undefined ? { plannedDate: validDate(patch.plannedDate) } : {}),
    ...(patch.eventTitle !== undefined ? { eventTitle: asText(patch.eventTitle) } : {}),
    ...(patch.audience !== undefined ? { audience: asText(patch.audience) } : {}),
    ...(patch.slideSet !== undefined ? { slideSet: normaliseSlideSet(patch.slideSet) } : {})
  })
  if (!next.eventTitle) throw new Error('event-title-required')
  next.startedAt = `${next.plannedDate}T00:00:00.000Z`
  writeRun(runPath(vaultRoot, talkSlug, runId), next)
  return next
}

export function deletePlannedRun(vaultRoot: string, talkSlug: string, runId: string): boolean {
  const current = readRun(vaultRoot, talkSlug, runId)
  if (!current || current.status !== 'planned') return false
  rmSync(runPath(vaultRoot, talkSlug, runId))
  return true
}

export function attachDeliveryToPlanned(planned: RunRecord, delivery: RunRecord): RunRecord {
  if (planned.status !== 'planned') throw new Error('run-not-planned')
  if (planned.talkSlug !== delivery.talkSlug) throw new Error('run-talk-mismatch')
  return normaliseRun({
    ...delivery,
    id: planned.id,
    status: 'delivered',
    plannedDate: planned.plannedDate,
    eventTitle: planned.eventTitle,
    audience: planned.audience,
    slideSet: planned.slideSet,
    pathwayId: planned.slideSet.kind === 'pathway' ? planned.slideSet.pathwayId : null,
    handoutUrl: planned.handoutUrl
  })
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

export function isSafeRunId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_RUN_ID_RE.test(value)
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
