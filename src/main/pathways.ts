import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

export type Pathway = {
  id: string
  name: string
  note?: string
  slideIds: string[]
}

export type PathwaySlideRow = {
  slide_id: string
  [key: string]: unknown
}

export type ResolvedPathway<Row extends PathwaySlideRow = PathwaySlideRow> = Pathway & {
  present: Row[]
  missing: string[]
}

type Manifest = Record<string, unknown> & { pathways?: unknown }

function parseManifest(text: string): Manifest {
  if (!text.trim()) return {}
  const parsed = JSON.parse(text) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Talk manifest must be a JSON object.')
  }
  return parsed as Manifest
}

function indentationOf(text: string): string {
  const match = text.match(/^([ \t]+)"/m)
  return match?.[1] ?? '  '
}

function serialiseLike(text: string, manifest: Manifest): string {
  const trailingNewline = text.endsWith('\n')
  const rendered = JSON.stringify(manifest, null, indentationOf(text))
  return rendered + (trailingNewline || !text ? '\n' : '')
}

function assertPathway(pathway: Pathway): void {
  if (!pathway.id.trim()) throw new Error('Pathway id is required.')
  if (!pathway.name.trim()) throw new Error('Pathway name is required.')
  const seen = new Set<string>()
  for (const slideId of pathway.slideIds) {
    if (!slideId.trim()) throw new Error('Pathway slide ids cannot be empty.')
    if (seen.has(slideId)) throw new Error(`Pathway contains duplicate slide id "${slideId}".`)
    seen.add(slideId)
  }
}

export function normalisePathways(value: unknown): Pathway[] {
  if (!Array.isArray(value)) return []
  const pathways: Pathway[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const candidate = raw as Record<string, unknown>
    if (typeof candidate.id !== 'string' || typeof candidate.name !== 'string' || !Array.isArray(candidate.slideIds)) continue
    const slideIds = candidate.slideIds.filter((id): id is string => typeof id === 'string')
    const pathway: Pathway = {
      id: candidate.id,
      name: candidate.name,
      ...(typeof candidate.note === 'string' && candidate.note ? { note: candidate.note } : {}),
      slideIds
    }
    assertPathway(pathway)
    pathways.push(pathway)
  }
  return pathways
}

function updatePathways(text: string, update: (pathways: Pathway[]) => Pathway[]): string {
  const manifest = parseManifest(text)
  manifest.pathways = update(normalisePathways(manifest.pathways))
  return serialiseLike(text, manifest)
}

export function createPathwayInManifest(text: string, pathway: Pathway): string {
  assertPathway(pathway)
  return updatePathways(text, (pathways) => {
    if (pathways.some((item) => item.id === pathway.id)) throw new Error(`Pathway "${pathway.id}" already exists.`)
    return [...pathways, { ...pathway, slideIds: [...pathway.slideIds] }]
  })
}

export function renamePathwayInManifest(text: string, id: string, name: string): string {
  if (!name.trim()) throw new Error('Pathway name is required.')
  return updatePathways(text, (pathways) => {
    let found = false
    const next = pathways.map((pathway) => {
      if (pathway.id !== id) return pathway
      found = true
      return { ...pathway, name: name.trim() }
    })
    if (!found) throw new Error(`Pathway "${id}" was not found.`)
    return next
  })
}

export function deletePathwayInManifest(text: string, id: string): string {
  return updatePathways(text, (pathways) => {
    const next = pathways.filter((pathway) => pathway.id !== id)
    if (next.length === pathways.length) throw new Error(`Pathway "${id}" was not found.`)
    return next
  })
}

export function setPathwaySlideIdsInManifest(text: string, id: string, slideIds: string[]): string {
  const probe: Pathway = { id, name: 'Pathway', slideIds }
  assertPathway(probe)
  return updatePathways(text, (pathways) => {
    let found = false
    const next = pathways.map((pathway) => {
      if (pathway.id !== id) return pathway
      found = true
      return { ...pathway, slideIds: [...slideIds] }
    })
    if (!found) throw new Error(`Pathway "${id}" was not found.`)
    return next
  })
}

export function resolvePathways<Row extends PathwaySlideRow>(pathways: Pathway[], rows: Row[]): ResolvedPathway<Row>[] {
  const byId = new Map(rows.map((row) => [row.slide_id, row]))
  return pathways.map((pathway) => {
    const present: Row[] = []
    const missing: string[] = []
    for (const id of pathway.slideIds) {
      const row = byId.get(id)
      if (row) present.push(row)
      else missing.push(id)
    }
    return { ...pathway, slideIds: [...pathway.slideIds], present, missing }
  })
}

export function pathwayManifestPath(vaultRoot: string, talkSlug: string): string {
  return join(vaultRoot, '_PRESENTATIONS', talkSlug, 'manifest.json')
}

export function readPathwayManifest(vaultRoot: string, talkSlug: string): { path: string; text: string; pathways: Pathway[] } {
  const path = pathwayManifestPath(vaultRoot, talkSlug)
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '{}\n'
  const manifest = parseManifest(text)
  return { path, text, pathways: normalisePathways(manifest.pathways) }
}

export type PathwaySummary = { count: number; names: string[] }

type PathwaySummaryCacheEntry = PathwaySummary & { mtimeMs: number }

export function createPathwaySummaryReader(
  readManifest: typeof readPathwayManifest = readPathwayManifest
): {
    read: (vaultRoot: string, talkSlug: string) => PathwaySummary
    invalidate: (vaultRoot: string, talkSlug: string) => void
  } {
  const cache = new Map<string, PathwaySummaryCacheEntry>()
  return {
    read(vaultRoot, talkSlug) {
      const path = pathwayManifestPath(vaultRoot, talkSlug)
      if (!existsSync(path)) {
        cache.delete(path)
        return { count: 0, names: [] }
      }
      const mtimeMs = statSync(path).mtimeMs
      const cached = cache.get(path)
      if (cached?.mtimeMs === mtimeMs) return { count: cached.count, names: [...cached.names] }
      const names = readManifest(vaultRoot, talkSlug).pathways.map((pathway) => pathway.name)
      const summary = { mtimeMs, count: names.length, names }
      cache.set(path, summary)
      return { count: summary.count, names: [...summary.names] }
    },
    invalidate(vaultRoot, talkSlug) {
      cache.delete(pathwayManifestPath(vaultRoot, talkSlug))
    }
  }
}

const pathwaySummaryReader = createPathwaySummaryReader()

export const readPathwaySummary = pathwaySummaryReader.read
export const invalidatePathwaySummary = pathwaySummaryReader.invalidate

export function writePathwayManifest(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, 'utf8')
}

type RuntimeBeat = {
  slideId?: unknown
  context?: {
    container?: unknown
    sectionId?: unknown
  }
}

type SlideChunk = {
  id: string
  html: string
  start: number
  end: number
}

function outerSlideChunks(html: string, stageStart: number, stageEnd: number): SlideChunk[] {
  const chunks: SlideChunk[] = []
  const sectionTag = /<\/?section\b[^>]*>/gi
  sectionTag.lastIndex = stageStart
  let depth = 0
  let slideStart = -1
  let slideId = ''
  let match: RegExpExecArray | null
  while ((match = sectionTag.exec(html)) && match.index < stageEnd) {
    const tag = match[0]
    const closing = tag.startsWith('</')
    if (!closing) {
      if (depth === 0) {
        const classes = tag.match(/\bclass=(?:"([^"]*)"|'([^']*)')/i)
        const id = tag.match(/\bdata-id=(?:"([^"]*)"|'([^']*)')/i)
        const classNames = (classes?.[1] ?? classes?.[2] ?? '').split(/\s+/)
        if (classNames.includes('slide') && (id?.[1] ?? id?.[2])) {
          slideStart = match.index
          slideId = id?.[1] ?? id?.[2] ?? ''
        }
      }
      depth += 1
      continue
    }
    if (depth === 0) throw new Error('Outer slide stage contains an unmatched closing section.')
    depth -= 1
    if (depth === 0 && slideStart >= 0) {
      chunks.push({
        id: slideId,
        html: html.slice(slideStart, sectionTag.lastIndex),
        start: slideStart,
        end: sectionTag.lastIndex
      })
      slideStart = -1
      slideId = ''
    }
  }
  if (depth !== 0 || slideStart >= 0) throw new Error('Outer slide stage contains an unbalanced section.')
  if (!chunks.length) throw new Error('Outer slide stage did not contain any slides.')
  return chunks
}

function selectPathwayBeats(beats: RuntimeBeat[], slideIds: string[]): { beats: RuntimeBeat[]; runtimeIds: string[] } {
  const selected: RuntimeBeat[] = []
  const runtimeIds: string[] = []
  for (const id of slideIds) {
    let matches = beats.filter((beat) => beat?.slideId === id)
    if (!matches.length) {
      matches = beats.filter((beat) =>
        beat?.context?.container === 'carousel' && beat.context.sectionId === id
      )
    }
    selected.push(...matches)
    const first = matches[0]
    const runtimeId = first?.context?.container === 'carousel' && typeof first.context.sectionId === 'string'
      ? first.context.sectionId
      : id
    if (matches.length && !runtimeIds.includes(runtimeId)) runtimeIds.push(runtimeId)
  }
  return { beats: selected, runtimeIds }
}

export function injectPathwayRuntime(fullHtml: string, slideIds: string[], pathwayId: string): string {
  if (fullHtml.includes('__talkWeaverPathway')) throw new Error('Presenter HTML already contains a pathway lens.')
  const config = JSON.stringify({ id: pathwayId, slideIds }).replace(/</g, '\\u003c')
  const stageMarker = fullHtml.indexOf('id="stage"')
  const beatsMarker = '<script>window.__deckBeats='
  const beatsStart = fullHtml.indexOf(beatsMarker, stageMarker)
  if (stageMarker < 0 || beatsStart < 0) throw new Error('Outer presenter stage or beat payload was not found.')
  const beatsJsonStart = beatsStart + beatsMarker.length
  const beatsEnd = fullHtml.indexOf(';</script>', beatsJsonStart)
  if (beatsEnd < 0) throw new Error('Outer presenter beat payload was not terminated.')
  const parsedBeats = JSON.parse(fullHtml.slice(beatsJsonStart, beatsEnd)) as unknown
  if (!Array.isArray(parsedBeats)) throw new Error('Outer presenter beat payload must be an array.')

  const { beats, runtimeIds } = selectPathwayBeats(parsedBeats as RuntimeBeat[], slideIds)
  const chunks = outerSlideChunks(fullHtml, stageMarker, beatsStart)
  const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]))
  const selectedChunks = runtimeIds.flatMap((id) => {
    const chunk = byId.get(id)
    return chunk ? [chunk.html] : []
  })
  const firstSlide = chunks[0]
  const lastSlide = chunks[chunks.length - 1]
  const filteredStage = fullHtml.slice(0, firstSlide.start)
    + selectedChunks.join('\n\n')
    + fullHtml.slice(lastSlide.end, beatsJsonStart)
    + JSON.stringify(beats).replace(/</g, '\\u003c')
    + fullHtml.slice(beatsEnd)

  const bodyEnd = filteredStage.lastIndexOf('</body>')
  if (bodyEnd < 0) throw new Error('Real presenter document body tail was not found.')
  const lens = `<script>window.__talkWeaverPathway=${config};</script>\n`
  return filteredStage.slice(0, bodyEnd) + lens + filteredStage.slice(bodyEnd)
}
