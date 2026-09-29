import { readFileSync, statSync } from 'fs'
import { basename, dirname, relative, sep } from 'path'
import { parseFrontmatterPairs } from '../shared/frontmatter-editor.ts'
import {
  TALK_SEARCH_FIELD_ORDER, displayIsoDate, isIgnoredTalkFolder,
  type HighlightRange, type TalkFolderCount, type TalkMatchLine, type TalkQuery, type TalkQueryTerm, type TalkSearchField,
  type TalkSearchHit, type TalkSearchOptions, type TalkSearchResult
} from '../shared/talk-search.ts'
import {
  datePartsMatch, foldText, folderFrom, parseDateQuery, parseLooseDate, prefixDef, tokenizeTalkQuery,
  type DateParts
} from '../shared/talk-query.ts'
import { createDeliverySummaries, type DeliverySummary } from './delivery-summaries.ts'

// Talk search (ADR-0029 §1) — ONE typed headless operation behind the Talks browser, the slide
// picker's "Find a talk" (ticket 05) and any agent: searchTalks(query, { within }) → ranked talks,
// each with the line that says what matched.
//
// A plain word matches the title, file name, folder path, frontmatter details, delivery records
// and slide text. A prefixed term (ADR-0029 §2; the language is shared/talk-query.ts) matches
// one field only: fo: folder, fi: file name, met: details, co: slide text; da: matches the
// talk's own date (frontmatter `date`, `plannedDate`) or any delivery date. Every term must
// match. Ranking: the tier at which every term is matched (title < file < folder < details <
// delivery < slides; a da: term counts as details when the talk's own date matched, else as
// delivery), then the sum of the terms' tiers, then the most recently edited talk, then title
// and path (deterministic).
//
// Inputs come through TalkSearchSource: the vault's talk list (the Talks browser's list), and
// each talk's compiled slide rows (the main process's slide-search cache; null = not read yet).
// This module reads frontmatter (mtime-cached) and delivery summaries (delivery-summaries.ts)
// itself; it never writes anything.

export interface TalkRef {
  name: string
  path: string
  outlinePath: string
  title: string
  slug: string
}

export interface SlideRowLike {
  nav_title?: string
  title?: string
  source_markdown?: string
}

export interface TalkSearchSource {
  vaultRoot(): string | null
  /** The talks the Talks browser lists. */
  talks(): TalkRef[] | Promise<TalkRef[]>
  /** A talk's compiled slide rows, or null while its slide text has not been read. */
  slideRows(outlinePath: string): readonly SlideRowLike[] | null | undefined
  /** Called when a search found talks without slide text (the app starts its warm pass). */
  onSlideTextMissing?(): void
}

// Frontmatter keys searched as "details", in the order a match line prefers them.
const DETAIL_KEYS = [
  'event', 'eventTitle', 'series', 'subtitle', 'audience', 'author', 'tags', 'date', 'plannedDate',
  'status', 'affiliation', 'venue', 'location', 'keywords', 'description'
]
const DETAIL_LABELS: Record<string, string> = { eventTitle: 'event', plannedDate: 'planned' }
// Which field line two names when several explain the words (ranking still uses the field order).
const LINE_ORDER: readonly TalkSearchField[] = ['details', 'delivery', 'folder', 'slides', 'file']
// With a da: term, line two prefers where and when the talk was given (frame L6).
const DATE_LINE_ORDER: readonly TalkSearchField[] = ['delivery', 'details', 'folder', 'slides', 'file']
const DATE_KEYS = new Set(['date', 'plannedDate'])
const FULL_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

// ── folding and highlighting ────────────────────────────────────────────────

/** Case- and accent-insensitive form used for all matching. */
export function fold(value: string): string {
  return foldText(value)
}

/** Every occurrence of every word in `display`, as ranges into `display` itself. */
function highlightsIn(display: string, words: string[]): HighlightRange[] {
  if (!display || words.length === 0) return []
  // Fold per character, remembering which display character each folded unit came from, so
  // ranges land on the original text even where folding changes length (accents, ligatures).
  let folded = ''
  const from: number[] = []
  const to: number[] = []
  let index = 0
  for (const ch of display) {
    const f = fold(ch)
    for (let k = 0; k < f.length; k += 1) { from.push(index); to.push(index + ch.length) }
    folded += f
    index += ch.length
  }
  const out: HighlightRange[] = []
  for (const word of words) {
    if (!word) continue
    let at = folded.indexOf(word)
    while (at !== -1) {
      out.push([from[at], to[at + word.length - 1]])
      at = folded.indexOf(word, at + word.length)
    }
  }
  return out
}

// ── the query ───────────────────────────────────────────────────────────────

/** Plain words and prefixed terms (shared/talk-query.ts). A prefix with nothing after it yet
 *  (`fo:` while typing) is no term; a repeated term counts once. */
export function parseTalkQuery(raw: string): TalkQuery {
  const seen = new Set<string>()
  const terms: TalkQueryTerm[] = []
  for (const token of tokenizeTalkQuery(raw)) {
    const text = fold(token.value).trim()
    if (!text) continue
    const field = token.prefix ? prefixDef(token.prefix).field : null
    const key = `${field ?? ''}\u0000${text}`
    if (seen.has(key)) continue
    seen.add(key)
    terms.push({ text, field })
  }
  return { raw, terms }
}

// ── per-talk documents ──────────────────────────────────────────────────────

type Detail = { key: string; label: string; value: string; folded: string; date: DateParts | null }
type Facts = { mtimeMs: number; details: Detail[]; detailsHay: string }
type Slide = { title: string; titleF: string; bodyF: string; body: string }
type SlideText = { slides: Slide[]; all: string }

/** A frontmatter value as display text: block lists and flow lists read "a, b"; block scalars
 *  (`|`, `>`) and wrapped text read as one line. */
function listValue(raw: string): string {
  if (raw.includes('\n')) {
    const [head, ...rest] = raw.split('\n')
    const lines = rest.map((l) => l.trim()).filter(Boolean)
    const isList = lines.length > 0 && lines.every((l) => l === '-' || l.startsWith('- '))
    const items = lines.map((l) => l.replace(/^-\s*/, '').replace(/^["']|["']$/g, '')).filter(Boolean)
    const lead = /^[|>][+-]?$/.test(head.trim()) ? '' : head.trim()
    return [lead, items.join(isList ? ', ' : ' ')].filter(Boolean).join(' ')
  }
  const value = raw.trim()
  if (/^\[.*\]$/.test(value)) {
    return value.slice(1, -1).split(',').map((v) => v.trim().replace(/^["']|["']$/g, '')).filter(Boolean).join(', ')
  }
  return value
}

/** Frontmatter details via the shared key/value parser (whole frontmatter block, not a head). */
export function readDetails(text: string): Detail[] {
  const byKey = new Map<string, string>()
  for (const pair of parseFrontmatterPairs(text)) byKey.set(pair.key, pair.value)
  const out: Detail[] = []
  for (const key of DETAIL_KEYS) {
    const raw = byKey.get(key)
    if (raw == null) continue
    const value = listValue(raw)
    if (!value) continue
    const date = DATE_KEYS.has(key) ? parseLooseDate(value) : null
    out.push({ key, label: DETAIL_LABELS[key] ?? key, value, folded: fold(value), date })
  }
  return out
}

function cleanSlideBody(markdown: string): string {
  return markdown
    .split(/\r?\n/)
    .filter((line) => !/^\s*#{1,6}\s/.test(line))
    .map((line) => line.replace(/^\s*(?:[-*+>]|\d+[.)])\s+/, '').replace(/\{[^}]*\}/g, '').replace(/[*_`[\]]/g, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const slideTextCache = new WeakMap<readonly SlideRowLike[], SlideText>()
function slideTextOf(rows: readonly SlideRowLike[]): SlideText {
  const hit = slideTextCache.get(rows)
  if (hit) return hit
  const slides: Slide[] = rows.map((row) => {
    const title = String(row.nav_title || row.title || '').trim()
    const markdown = String(row.source_markdown || '')
    const second = row.title && row.title !== row.nav_title ? `\n${row.title}` : ''
    return { title, titleF: fold(title + second), bodyF: fold(markdown), body: cleanSlideBody(markdown) }
  })
  const text = { slides, all: slides.map((s) => `${s.titleF}\n${s.bodyF}`).join('\n') }
  slideTextCache.set(rows, text)
  return text
}

type Doc = {
  talk: TalkRef
  folder: string
  fileName: string
  talkDir: string
  titleF: string
  fileF: string
  folderF: string
  facts: Facts
  deliveries: Array<DeliverySummary & { hay: string; parts: DateParts | null }>
  slides: SlideText | null
}

function deliveryHay(d: DeliverySummary): string {
  const month = Number(d.date.slice(5, 7))
  return fold(`${d.date} ${displayIsoDate(d.date)} ${FULL_MONTHS[month - 1] ?? ''} ${d.eventTitle} ${d.context} ${d.audience}`)
}

function haystack(doc: Doc, field: TalkSearchField): string {
  switch (field) {
    case 'title': return doc.titleF
    case 'file': return doc.fileF
    case 'folder': return doc.folderF
    case 'details': return doc.facts.detailsHay
    case 'delivery': return doc.deliveries.map((d) => d.hay).join('\n')
    case 'slides': return doc.slides?.all ?? ''
  }
}

// ── match lines ─────────────────────────────────────────────────────────────

const count = (hay: string, words: string[]): number => words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0)

function snippet(body: string, words: string[]): string {
  const f = fold(body)
  const at = words.map((w) => f.indexOf(w)).filter((i) => i >= 0).sort((a, b) => a - b)[0]
  if (at == null) return ''
  const start = Math.max(0, at - 24)
  const end = Math.min(body.length, at + 56)
  return `${start > 0 ? '…' : ''}${body.slice(start, end).trim()}${end < body.length ? '…' : ''}`
}

/** What line two has to explain: the plain words the title did not match, the prefixed terms
 *  (each in its own field) and the da: dates. */
type LineNeeds = {
  words: string[]
  fielded: Map<TalkSearchField, string[]>
  dates: DateParts[]
  /** fo: terms: a date line says where by folder when the query names one (frame L6). */
  folderTerms: string[]
}

const datesMatch = (dates: DateParts[], parts: DateParts | null): boolean =>
  dates.length > 0 && !!parts && dates.every((q) => datePartsMatch(q, parts))

function lineFor(doc: Doc, field: TalkSearchField, needs: LineNeeds, all: string[]): TalkMatchLine | null {
  const needed = [...needs.words, ...(needs.fielded.get(field) ?? [])]
  let label: string = field
  let text = ''
  let dateSpan: HighlightRange | null = null
  if (field === 'file') {
    const options = [doc.fileName, `${basename(doc.talkDir)}/`]
    text = options.reduce((best, o) => (count(fold(o), needed) > count(fold(best), needed) ? o : best), options[0])
  } else if (field === 'folder') {
    text = doc.folder.split('/').join(' / ')
  } else if (field === 'details') {
    let best: Detail | null = null
    let bestScore = -1
    for (const d of doc.facts.details) {
      const s = (datesMatch(needs.dates, d.date) ? 1000 : 0) + count(d.folded, needed)
      if (s > bestScore) { best = d; bestScore = s }
    }
    if (!best) return null
    label = best.label
    text = best.value
    if (datesMatch(needs.dates, best.date)) dateSpan = [0, text.length]
  } else if (field === 'delivery') {
    let best: (typeof doc.deliveries)[number] | null = null
    let bestScore = -1
    for (const d of doc.deliveries) {
      const s = (datesMatch(needs.dates, d.parts) ? 1000 : 0) + count(d.hay, needed)
      if (s > bestScore) { best = d; bestScore = s }
    }
    if (!best) return null
    label = best.status === 'planned' ? 'planned' : 'given'
    const dated = datesMatch(needs.dates, best.parts)
    const parts = [best.eventTitle, best.context, best.audience].filter(Boolean)
    const byFolder = dated && needs.folderTerms.length > 0 ? folderFrom(doc.folder, needs.folderTerms[0]) : null
    const where = parts.find((p) => count(fold(p), needed) > 0) ?? (byFolder ? byFolder.split('/').join(' / ') : parts[0])
    const when = best.date ? displayIsoDate(best.date) : ''
    text = [when, where ?? ''].filter(Boolean).join(' · ')
    if (dated && when) dateSpan = [0, when.length]
  } else if (field === 'slides') {
    const slides = doc.slides?.slides ?? []
    const ranked = slides
      .map((s, i) => ({ s, i, n: count(`${s.titleF}\n${s.bodyF}`, needed), t: count(s.titleF, needed) }))
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n || b.t - a.t || a.i - b.i)
      .slice(0, 2)
    if (ranked.length === 0) return null
    text = ranked.map(({ s, t }, k) => {
      const quoted = s.title ? `“${s.title}”` : ''
      if (t > 0 || k > 0) return quoted
      const bit = snippet(s.body, needed)
      return bit ? (quoted ? `${quoted}: ${bit}` : bit) : quoted
    }).filter(Boolean).join(' · ')
  } else {
    return null
  }
  const highlights = highlightsIn(text, all)
  if (dateSpan) highlights.unshift(dateSpan)
  return { field, label, text, highlights }
}

// ── the search ──────────────────────────────────────────────────────────────

type Scored = { doc: Doc; tier: number; sum: number; titleWords: string[]; match: TalkMatchLine | null }
type TermHit = { best: TalkSearchField; fields: ReadonlySet<TalkSearchField> | null }

/** Where one term matches this talk: its best (lowest-tier) field, and — for a prefixed or date
 *  term — the fields it may explain on line two (null: a plain word, checked per field). */
function matchTerm(doc: Doc, term: TalkQueryTerm): TermHit | null {
  if (term.field === 'date') {
    const q = parseDateQuery(term.text)
    if (!q) return null
    const inDetails = doc.facts.details.some((d) => datesMatch([q], d.date))
    const inDelivery = doc.deliveries.some((d) => datesMatch([q], d.parts))
    if (!inDetails && !inDelivery) return null
    const fields = new Set<TalkSearchField>()
    if (inDetails) fields.add('details')
    if (inDelivery) fields.add('delivery')
    return { best: inDetails ? 'details' : 'delivery', fields }
  }
  const fields = term.field ? [term.field] : TALK_SEARCH_FIELD_ORDER
  const best = fields.find((f) => haystack(doc, f).includes(term.text))
  if (!best) return null
  return { best, fields: term.field ? new Set([term.field]) : null }
}

function score(doc: Doc, terms: TalkQueryTerm[]): Scored | null {
  // Words to mark in the title and line two; a date is marked as a whole span instead.
  const all = terms.filter((t) => t.field !== 'date').map((t) => t.text)
  let tier = 0
  let sum = 0
  const notInTitle: Array<{ term: TalkQueryTerm; hit: TermHit }> = []
  const titleWords: string[] = []
  for (const term of terms) {
    const hit = matchTerm(doc, term)
    if (!hit) return null
    const t = TALK_SEARCH_FIELD_ORDER.indexOf(hit.best)
    tier = Math.max(tier, t)
    sum += t
    if (hit.best === 'title') titleWords.push(term.text)
    else notInTitle.push({ term, hit })
  }
  let match: TalkMatchLine | null = null
  if (notInTitle.length > 0) {
    // The line shows the field that explains most of the terms the title did not; ties go by
    // LINE_ORDER, which puts the file name last: it mostly repeats the title (frame L5 shows
    // `event` for talks whose file names also say "jersey"). With a date, where and when the
    // talk was given comes first (frame L6).
    const order = notInTitle.some((x) => x.term.field === 'date') ? DATE_LINE_ORDER : LINE_ORDER
    let bestField: TalkSearchField | null = null
    let bestCount = 0
    for (const f of order) {
      const n = notInTitle.filter(({ term, hit }) => (hit.fields ? hit.fields.has(f) : haystack(doc, f).includes(term.text))).length
      if (n > bestCount) { bestField = f; bestCount = n }
    }
    const needs: LineNeeds = { words: [], fielded: new Map(), dates: [], folderTerms: terms.filter((t) => t.field === 'folder').map((t) => t.text) }
    for (const { term } of notInTitle) {
      if (term.field === 'date') { const q = parseDateQuery(term.text); if (q) needs.dates.push(q) }
      else if (term.field) needs.fielded.set(term.field, [...(needs.fielded.get(term.field) ?? []), term.text])
      else needs.words.push(term.text)
    }
    if (bestField) match = lineFor(doc, bestField, needs, all)
  }
  return { doc, tier, sum, titleWords, match }
}

function normaliseWithin(within: string | undefined): string | null {
  const value = (within ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  return value || null
}

export function createTalkSearch(source: TalkSearchSource, options: { revalidateMs?: number; now?: () => number } = {}) {
  const revalidateMs = options.revalidateMs ?? 1000
  const now = options.now ?? Date.now
  const deliveries = createDeliverySummaries({ vaultRoot: () => source.vaultRoot(), revalidateMs, now })
  const facts = new Map<string, Facts>()
  let statsCheckedAt = -Infinity

  function factsFor(outlinePath: string, restat: boolean): Facts {
    const prior = facts.get(outlinePath)
    if (prior && !restat) return prior
    let mtimeMs = 0
    try { mtimeMs = statSync(outlinePath).mtimeMs } catch { /* gone mid-search */ }
    if (prior && prior.mtimeMs === mtimeMs) return prior
    let details: Detail[] = []
    try { details = readDetails(readFileSync(outlinePath, 'utf8')) } catch { /* unreadable: no details */ }
    const next = { mtimeMs, details, detailsHay: details.map((d) => d.folded).join('\n') }
    facts.set(outlinePath, next)
    return next
  }

  async function docs(): Promise<{ root: string; list: Doc[] } | null> {
    const root = source.vaultRoot()
    if (!root) return null
    const talks = await source.talks()
    const t = now()
    const restat = t - statsCheckedAt >= revalidateMs
    if (restat) statsCheckedAt = t
    const bySlug = deliveries.bySlug()
    const list: Doc[] = []
    for (const talk of talks) {
      const talkDir = talk.path || dirname(talk.outlinePath)
      const rel = relative(root, dirname(talkDir)).split(sep).join('/')
      const folder = rel === '.' || rel.startsWith('..') ? '' : rel
      if (isIgnoredTalkFolder(folder)) continue
      const fileName = basename(talk.outlinePath)
      const rows = source.slideRows(talk.outlinePath)
      list.push({
        talk, folder, fileName, talkDir,
        titleF: fold(talk.title),
        fileF: fold(`${fileName}\n${basename(talkDir)}`),
        folderF: fold(folder),
        facts: factsFor(talk.outlinePath, restat),
        deliveries: (bySlug.get(talk.slug) ?? []).map((d) => ({ ...d, hay: deliveryHay(d), parts: d.date ? parseLooseDate(d.date) : null })),
        slides: rows ? slideTextOf(rows) : null
      })
    }
    return { root, list }
  }

  /** The typed headless operation: ranked talks for a query, optionally within one folder. */
  async function searchTalks(query: string, opts: TalkSearchOptions = {}): Promise<TalkSearchResult> {
    const parsed = parseTalkQuery(query)
    const within = normaliseWithin(opts.within)
    const loaded = await docs()
    const list = loaded?.list ?? []
    const read = list.filter((d) => d.slides).length
    if (read < list.length) source.onSlideTextMissing?.()
    const empty: TalkSearchResult = {
      query, terms: parsed.terms, within, hits: [], everywhereCount: 0, slideText: { read, total: list.length }
    }
    if (parsed.terms.length === 0) return empty

    const scored: Scored[] = []
    for (const doc of list) {
      const s = score(doc, parsed.terms)
      if (s) scored.push(s)
    }
    const inScope = (folder: string): boolean => !within || folder === within || folder.startsWith(`${within}/`)
    const hits = scored
      .filter((s) => inScope(s.doc.folder))
      .sort((a, b) =>
        a.tier - b.tier ||
        a.sum - b.sum ||
        b.doc.facts.mtimeMs - a.doc.facts.mtimeMs ||
        a.doc.talk.title.localeCompare(b.doc.talk.title) ||
        a.doc.talk.outlinePath.localeCompare(b.doc.talk.outlinePath))
      .map((s): TalkSearchHit => {
        const { talk } = s.doc
        const given = s.doc.deliveries.find((d) => d.status === 'delivered' && d.date)
        return {
          name: talk.name, path: talk.path, outlinePath: talk.outlinePath, title: talk.title, slug: talk.slug,
          folder: s.doc.folder,
          editedMs: s.doc.facts.mtimeMs,
          tier: s.tier,
          titleHighlights: highlightsIn(talk.title, s.titleWords),
          match: s.match,
          lastGiven: given?.date ?? null
        }
      })
    return { ...empty, hits, everywhereCount: scored.length }
  }

  /** The `fo:` completion source: every folder that holds talks at any depth (the same talk scan
   *  the search uses), with the talks directly in it; ancestors of a talk's folder are listed
   *  with 0 of their own. Sorted by path. */
  async function folders(): Promise<TalkFolderCount[]> {
    const loaded = await docs()
    const direct = new Map<string, number>()
    for (const doc of loaded?.list ?? []) {
      if (!doc.folder) continue
      const segments = doc.folder.split('/')
      for (let i = 1; i < segments.length; i += 1) {
        const ancestor = segments.slice(0, i).join('/')
        if (!direct.has(ancestor)) direct.set(ancestor, 0)
      }
      direct.set(doc.folder, (direct.get(doc.folder) ?? 0) + 1)
    }
    return [...direct].map(([path, talks]) => ({ path, talks })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  }

  return {
    searchTalks,
    folders,
    /** Read frontmatter details and delivery summaries ahead of the first keystroke. */
    async warm(): Promise<void> { await docs() },
    /** Drop cached stats so the next search re-reads what changed (vault switch, Run written). */
    invalidate(): void {
      statsCheckedAt = -Infinity
      deliveries.invalidate()
    },
    deliveryParsedCount: (): number => deliveries.parsedCount()
  }
}

export type TalkSearch = ReturnType<typeof createTalkSearch>

const MAX_QUERY_LENGTH = 500

/** The IPC handler's body: arguments arrive from the renderer untyped, so anything that is not a
 *  string query / string folder is dropped rather than trusted. */
export function handleTalkSearchRequest(
  search: Pick<TalkSearch, 'searchTalks'>,
  query: unknown,
  options: unknown
): Promise<TalkSearchResult> {
  const text = typeof query === 'string' ? query.slice(0, MAX_QUERY_LENGTH) : ''
  const raw = options && typeof options === 'object' ? (options as { within?: unknown }).within : undefined
  const within = typeof raw === 'string' ? raw : undefined
  return search.searchTalks(text, within ? { within } : {})
}
