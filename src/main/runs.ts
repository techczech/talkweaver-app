import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { resolvePathways, type Pathway, type PathwaySlideRow } from './pathways.ts'

export type RunStatus = 'planned' | 'delivered'
export type RunSlideSet = { kind: 'full' } | { kind: 'pathway'; pathwayId: string }
export type RunKind = 'delivery' | 'rehearsal' | 'recording'
export type RunMark = { event: string; slideId?: string; tMs: number; hidden?: number; marks?: number }

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
  return {
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
    slideTimeIndex: Array.isArray(raw.slideTimeIndex) ? raw.slideTimeIndex as RunMark[] : []
  }
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
  const slugs = talkSlug ? [talkSlug] : readdirSync(root)
  const runs: RunRecord[] = []
  for (const slug of slugs) {
    const dir = join(root, slug)
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
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

export function persistRun(vaultRoot: string, run: RunRecord): RunRecord {
  const normalised = normaliseRun(run)
  writeRun(runPath(vaultRoot, normalised.talkSlug, normalised.id), normalised)
  return normalised
}
