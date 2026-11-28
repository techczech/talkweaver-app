// Slide Scratchpad: the shapes main and renderer share, and the pure parts of the panel (search
// with its typed prefixes, list tabs and counts, arrival-batch headings).
// Spec: docs/design/2026-10-27-slide-scratchpad/slide-scratchpad-spec.md. No I/O here.

import { highlightSegments, parseQuery as parseSlideQuery, termsMatch, words } from './slide-handling/query.ts'

export type ScratchStatus = 'active' | 'kept' | 'rejected'
export type ScratchItemKind = 'slide' | 'file' | 'proposed'
/** What an agent file is, from its extension. */
export type ScratchVisualKind = 'svg' | 'html' | 'pic'
export type ScratchFileKind = ScratchVisualKind | 'sketch'
export const MAX_SKETCH_BYTES = 4 * 1024 * 1024
export interface ScratchSketch { name: string; text: string; revision: string }
/** The four search type filters: Slides, SVG, HTML, Pictures. */
export type ScratchTypeKey = 'slide' | ScratchVisualKind

export interface SketchUse { key: string; at: string; ids: string[]; slideCount?: number }

export interface ScratchGroup { id: string; name: string }
export interface ScratchSource { label: string; url: string }

export interface ScratchSlide {
  /** Vault-relative path of the source talk's outline, as the spec fixes it. */
  talkPath: string
  talkTitle: string
  slideId: string
  title: string
  /** Snapshot of the slide's markdown block at pick time. */
  markdown: string
  /** The source slide's thumbnail key; with talkSlug and vaultId it addresses the picture. */
  thumbKey: string
  talkSlug?: string
  vaultId?: string
  sketchFile?: string
  sketchProposalKey?: string
}

/** One item as the state file stores it (version 1). */
export interface ScratchStateItem {
  id: string
  kind: ScratchItemKind
  addedAt: string
  batch: { source: 'slide-browser' | 'agent' | 'sketch'; at: string }
  group: string | null
  status: ScratchStatus
  file?: string
  slide?: ScratchSlide
  /** When it was last inserted into the talk (ticket 2). Optional: the schema stays version 1. */
  insertedAt?: string
  /** The title of the slide it went into (a new slide's own title, or the slide at the cursor). */
  insertedInto?: string
  sketchUses?: SketchUse[]
  sketchTitle?: string
  sketchOrigin?: 'person'
}

export interface ScratchState {
  order?: string[]
  sort?: 'newest' | 'manual'
  version: 1
  groups: ScratchGroup[]
  items: ScratchStateItem[]
}

/** One item as the panel receives it: state merged with what the folder says about its file. */
export interface ScratchItem extends ScratchStateItem {
  title: string
  description: string
  sources: ScratchSource[]
  fileKind?: ScratchFileKind
  /** The state names a file the folder no longer has ("File missing"). */
  missing: boolean
  /** Where an <img> may load a picture or SVG; absent for HTML, slides and missing files. */
  fileUrl?: string
  /** Text found inside an SVG or HTML file, for search only (never shown on cards). */
  contentText?: string
  sketchLineCount?: number
  sourceSketchTitle?: string
}

export interface ScratchSnapshot {
  order?: string[]
  sort?: 'newest' | 'manual'
  groups: ScratchGroup[]
  items: ScratchItem[]
  /** Said to the user as they are: a state file that could not be read, files that were skipped. */
  notices: string[]
}

/** What a slide pick sends: the renderer builds this from a Slide Browser row. */
export interface ScratchSlideInput {
  talkPath: string
  talkTitle: string
  slideId: string
  title: string
  markdown: string
  thumbKey: string
  talkSlug?: string
  vaultId?: string
}

export type ScratchReply<T = Record<string, never>> = ({ ok: true } & T) | { ok: false; error: string }

/** What an Insert visual only copy answers: the line to put into the talk (`![](img-…)`, `![](assets/….svg)`,
 *  `[Embed: assets/….html]`); for a page, what Insert › HTML page… says after its insert. */
export type ScratchVisualImport = ScratchReply<{ line: string; page?: { embedPath: string; how: 'copied' | 'reused' | 'in-talk'; localReferences: string[]; dependenciesCopied?: number } }>

export const STATE_FILE_NAME = 'scratchpad-state.json'
export const SCRATCH_FOLDER_NAME = 'scratchpad'

export const FILE_KIND_BY_EXTENSION: Readonly<Record<string, ScratchFileKind>> = Object.freeze({
  '.md': 'sketch', '.svg': 'svg', '.html': 'html', '.htm': 'html',
  '.png': 'pic', '.jpg': 'pic', '.jpeg': 'pic', '.webp': 'pic', '.gif': 'pic'
})

export const TYPE_LABEL: Readonly<Record<ScratchTypeKey, string>> = Object.freeze({
  slide: 'Slides', svg: 'SVG', html: 'HTML', pic: 'Pictures'
})
export const TYPE_BADGE: Readonly<Record<ScratchFileKind, string>> = Object.freeze({ svg: 'SVG', html: 'HTML', pic: 'Picture', sketch: 'Sketch' })

/** The item's type for filtering: slides are 'slide'; a file is its file kind (unknown → 'pic'). */
export function itemTypeKey(item: Pick<ScratchItem, 'kind' | 'fileKind'>): ScratchTypeKey | 'sketch' {
  return item.kind !== 'file' ? 'slide' : (item.fileKind ?? 'pic')
}

// ── Search: typed prefixes and chips are one state (the query text) ────────────────────────────

export interface ParsedQuery {
  types: ScratchTypeKey[]
  /** `from:` words; each must appear in the source talk title. */
  from: string[]
  /** Plain words; each must appear somewhere in the searchable text. */
  terms: string[]
}

/** The Scratchpad's reading of the query: type prefixes, `from:` and plain words (src/shared/slide-handling/query.ts; no Browser operators here). */
export function parseQuery(query: string): ParsedQuery {
  const q = parseSlideQuery(query, { operators: false, prefixes: true })
  return { types: q.types, from: q.from, terms: q.terms }
}

/** What a chip click does to the query text: adds `<type>:` in front, or takes that prefix off. */
export function toggleTypeInQuery(query: string, type: ScratchTypeKey): string {
  const own = new RegExp(`^${type === 'pic' ? '(?:pic|pics|picture|pictures)' : type === 'slide' ? '(?:slide|slides)' : type}:`, 'i')
  const out: string[] = []
  let found = false
  for (const word of words(query.trim())) {
    if (own.test(word)) {
      found = true
      const rest = word.replace(own, '')
      if (rest) out.push(rest)
    } else out.push(word)
  }
  if (!found) out.unshift(`${type}:`)
  return out.join(' ')
}

/** The text a plain word is looked for in: title, description, source talk, slide text, file name. */
export function searchableText(item: ScratchItem): string {
  return [item.title, item.description, item.slide?.talkTitle, item.slide?.markdown, item.file, item.contentText]
    .filter((part): part is string => typeof part === 'string' && part !== '').join(' ').toLowerCase()
}

export function matchesQuery(item: ScratchItem, parsed: ParsedQuery): boolean {
  if (parsed.types.length > 0 && !parsed.types.some(type => type === itemTypeKey(item))) return false
  const talk = (item.slide?.talkTitle ?? '').toLowerCase()
  if (!parsed.from.every((word) => talk.includes(word))) return false
  if (parsed.terms.length === 0) return true
  return termsMatch(searchableText(item), parsed.terms)
}

export { highlightSegments }

// ── Lists, group filter, counts ────────────────────────────────────────────────────────────────

export type ScratchList = 'all' | 'sketches' | 'proposed' | 'slides' | 'visuals' | 'kept' | 'rejected'
/** 'all' = every group, 'ungrouped' = no group, else a group id. */
export type ScratchGroupFilter = 'all' | 'ungrouped' | string

export const LIST_LABEL: Readonly<Record<ScratchList, string>> = Object.freeze({
  all: 'All', sketches: 'Sketches', proposed: 'Proposed slides', slides: 'Picked slides', visuals: 'Agent visuals', kept: 'Kept', rejected: 'Rejected'
})
export const LISTS: readonly ScratchList[] = ['all', 'sketches', 'proposed', 'slides', 'visuals', 'kept', 'rejected']

/** All, Picked slides and Agent visuals show active items only; Kept and Rejected show their status. */
export function inList(item: ScratchItem, list: ScratchList): boolean {
  if (list === 'kept') return item.status === 'kept'
  if (list === 'rejected') return item.status === 'rejected'
  if (item.status !== 'active') return false
  if (list === 'sketches') return item.fileKind === 'sketch'
  if (list === 'proposed') return item.kind === 'proposed'
  if (list === 'slides') return item.kind === 'slide'
  if (list === 'visuals') return item.kind === 'file' && item.fileKind !== 'sketch'
  return true
}

export function inGroup(item: ScratchItem, group: ScratchGroupFilter): boolean {
  if (group === 'all') return true
  if (group === 'ungrouped') return item.group === null
  return item.group === group
}

/** Newest first by the batch time, then by the item's own time. */
export function newestFirst(a: Pick<ScratchStateItem, 'batch' | 'addedAt' | 'id'>, b: Pick<ScratchStateItem, 'batch' | 'addedAt' | 'id'>): number {
  return b.batch.at.localeCompare(a.batch.at) || b.addedAt.localeCompare(a.addedAt)
}

export function visibleItems(items: readonly ScratchItem[], view: { list: ScratchList; group: ScratchGroupFilter; query: string }): ScratchItem[] {
  const parsed = parseQuery(view.query)
  const groupApplies = view.list !== 'kept' && view.list !== 'rejected'
  return items
    .filter((item) => inList(item, view.list) && (!groupApplies || inGroup(item, view.group)) && matchesQuery(item, parsed))
    .sort(newestFirst)
}

export type ScratchCounts = Record<ScratchList, number> & { active: number }

/** Tab counts do not move with the search or the group filter; they are what each list holds. */
export function listCounts(items: readonly ScratchItem[]): ScratchCounts {
  const counts: ScratchCounts = { all: 0, sketches: 0, proposed: 0, slides: 0, visuals: 0, kept: 0, rejected: 0, active: 0 }
  for (const list of LISTS) counts[list] = items.filter((item) => inList(item, list)).length
  counts.active = counts.all
  return counts
}

/** The Show only chips' counts: active items per type. */
export function typeCounts(items: readonly ScratchItem[]): Record<ScratchTypeKey, number> {
  const out: Record<ScratchTypeKey, number> = { slide: 0, svg: 0, html: 0, pic: 0 }
  for (const item of items) {
    const type = itemTypeKey(item)
    if (item.status === 'active' && type !== 'sketch') out[type]++
  }
  return out
}

export function groupCounts(items: readonly ScratchItem[], groups: readonly ScratchGroup[]): { all: number; ungrouped: number; byId: Record<string, number> } {
  const active = items.filter((item) => item.status === 'active')
  const byId: Record<string, number> = {}
  for (const group of groups) byId[group.id] = active.filter((item) => item.group === group.id).length
  return { all: active.length, ungrouped: active.filter((item) => item.group === null).length, byId }
}

// ── Arrival-batch headings ─────────────────────────────────────────────────────────────────────

export interface BatchSection { key: string; day: string; label: string; items: ScratchItem[] }

const pad = (n: number): string => String(n).padStart(2, '0')
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** "Added today", "Added yesterday", "Added Monday" (this week), else "Added Thursday 23 October". */
export function dayHeading(at: Date, now: Date): string {
  const startOf = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((startOf(now) - startOf(at)) / 86_400_000)
  if (days <= 0) return 'Added today'
  if (days === 1) return 'Added yesterday'
  if (days < 7) return `Added ${WEEKDAYS[at.getDay()]}`
  return `Added ${WEEKDAYS[at.getDay()]} ${at.getDate()} ${MONTHS[at.getMonth()]}`
}

/** One section per arrival batch (same source and same batch time), newest first, items newest first inside. */
export function batchSections(items: readonly ScratchItem[], now: Date = new Date()): BatchSection[] {
  const sorted = [...items].sort(newestFirst)
  const out: BatchSection[] = []
  for (const item of sorted) {
    const source = item.fileKind === 'sketch'
      ? item.sketchOrigin === 'person' ? 'Written here' : 'Added from scratch folder'
      : item.batch.source === 'agent' ? 'Made by agent' : item.batch.source === 'sketch' ? 'From a sketch' : 'Picked from Slide Browser'
    const key = `${source}|${item.batch.at}`
    let section = out.find((s) => s.key === key)
    if (!section) {
      const at = new Date(item.batch.at)
      const valid = !Number.isNaN(at.getTime())
      section = {
        key,
        day: valid ? dayHeading(at, now) : 'Added earlier',
        label: `${source}${valid ? ` ${pad(at.getHours())}:${pad(at.getMinutes())}` : ''}`,
        items: []
      }
      out.push(section)
    }
    section.items.push(item)
  }
  return out
}

/** A readable title from an agent's file name when it has no sidecar title: "slide-deep-research-history.svg"
 *  reads "Deep research history". Drops the extension and a leading "slide-", turns hyphens and underscores
 *  into spaces, capitalises the first letter. A name that is nothing but "slide" keeps that word. */
export function sketchTitleFromText(text: string): string {
  const first = text.split(/\r?\n/).find(line => line.trim())
  return first?.trim().replace(/^(?:#{1,6}|[-*+•–]|\d+[.)])[ \t]+/, '').slice(0, 120) || ''
}

export function titleFromFileName(name: string): string {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const trimmed = stem.replace(/^slide[-_ ]+(?=\S)/i, '')
  const words = trimmed.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (words === '') return stem
  const sentence = words.charAt(0).toUpperCase() + words.slice(1)
  return sentence.split(' ').map((word) => (KNOWN_ACRONYMS.has(word.toLowerCase()) ? word.toUpperCase() : word)).join(' ')
}
const KNOWN_ACRONYMS = new Set(['ai', 'llm', 'llms', 'html', 'svg', 'gpqa', 'mmlu', 'uk', 'us', 'api', 'pdf', 'csv', 'json', 'url', 'gpu', 'ocr', 'rag'])

/** Authoritative candidates resolved for one originating talk; never renderer-supplied source. */
export type ScratchPreparedInsert = { id: string; title: string } & (
  { markdown: string; sourceOutlinePath: string } | { line: string }
)
export interface ScratchInsertedRecord { id: string; title: string }


/** Keep saved positions; append arrivals in the store's source order. Removed IDs disappear. */
export function scratchOrder(items: readonly { id: string }[], saved: readonly string[] = []): string[] {
  const known = new Set(items.map(item => item.id))
  return [...new Set([...saved.filter(id => known.has(id)), ...items.map(item => item.id)])]
}
