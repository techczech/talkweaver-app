// Slide handling, the ONE search rule (spec docs/design/2026-10-28-slide-handling/slide-handling-build-spec.md
// § Shared unit, ticket 2). One parser for what people type, one match, one highlight and one snippet, used by the
// grid, the outline sidebar, the Slide Browser (its main-process scan) and the Scratchpad.
//
// What is typed:
//  - a leading Browser operator, `t:` (title), `s:` (slide text), `i:` (picture text) or `e:` (exact phrase over all
//    fields); the rest of the line is the text (surrounding quotes stripped);
//  - Scratchpad prefixes anywhere: `slide: svg: html: pic:` (type) and `from:<word>` (source talk), the rest plain words
//    (a double-quoted run stays one word).
// The Browser takes operators and no prefixes, the Scratchpad prefixes and no operators (each keeps the vocabulary it
// always had; `opts`), the grid and the outline take both.

export type SlideScope = 'all' | 'title' | 'body' | 'image'
export type SlideType = 'slide' | 'svg' | 'html' | 'pic'

export interface SlideQuery {
  scope: SlideScope
  exact: boolean
  /** Exact: the phrase; otherwise the typed text without prefixes. */
  text: string
  /** Lowercased words that must all appear (in the scope's fields). */
  terms: string[]
  types: SlideType[]
  /** `from:` words; each must appear in the source talk title. */
  from: string[]
}

export interface ParseOptions { operators?: boolean; prefixes?: boolean }

const OPERATOR_RE = /^([tsie]):\s*([\s\S]*)$/i
const OPERATOR_SCOPE: Record<string, SlideScope> = { t: 'title', s: 'body', i: 'image' }
const PREFIX_RE = /^(svg|html|pic|pics|picture|pictures|slide|slides):(.*)$/i
const TYPE_BY_PREFIX: Record<string, SlideType> = {
  svg: 'svg', html: 'html', pic: 'pic', pics: 'pic', picture: 'pic', pictures: 'pic', slide: 'slide', slides: 'slide'
}

/** Words split on spaces; a double-quoted run stays one word (`from:"ai in research"`). */
export function words(text: string): string[] {
  const out: string[] = []
  const re = /(?:[^\s"]+:)?"[^"]*"|\S+/g
  for (let m = re.exec(text); m; m = re.exec(text)) out.push(m[0])
  return out
}

function stripWrappingQuotes(s: string): string {
  if (s.length >= 2) {
    const a = s[0]
    const b = s[s.length - 1]
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) return s.slice(1, -1)
  }
  return s
}

export function parseQuery(raw: string, opts: ParseOptions = {}): SlideQuery {
  const operators = opts.operators ?? true
  const prefixes = opts.prefixes ?? true
  const s = String(raw ?? '')
  const q: SlideQuery = { scope: 'all', exact: false, text: s, terms: [], types: [], from: [] }
  const op = operators ? OPERATOR_RE.exec(s) : null
  if (op) {
    const which = op[1].toLowerCase()
    const text = stripWrappingQuotes(op[2].trim())
    q.text = text
    q.terms = text.toLowerCase().split(/\s+/).filter(Boolean)
    if (which === 'e') q.exact = true
    else q.scope = OPERATOR_SCOPE[which]
    return q
  }
  if (!prefixes) { q.terms = s.toLowerCase().split(/\s+/).filter(Boolean); return q }
  const list = words(s.trim())
  const plain: string[] = []
  for (let i = 0; i < list.length; i++) {
    const word = list[i]
    const prefix = prefixes ? PREFIX_RE.exec(word) : null
    if (prefix) {
      const type = TYPE_BY_PREFIX[prefix[1].toLowerCase()]
      if (!q.types.includes(type)) q.types.push(type)
      const rest = prefix[2].replace(/"/g, '').toLowerCase()
      if (rest) q.terms.push(rest)
      continue
    }
    const from = prefixes ? /^from:(.*)$/i.exec(word) : null
    if (from) {
      let value = from[1]
      if (!value && i + 1 < list.length) value = list[++i]
      value = value.replace(/"/g, '').toLowerCase()
      if (value) q.from.push(value)
      continue
    }
    plain.push(word)
    q.terms.push(word.replace(/"/g, '').toLowerCase())
  }
  q.terms = q.terms.filter(Boolean)
  q.text = plain.length === list.length ? s : plain.join(' ')
  return q
}

/** Nothing to look for: no words, no type, no talk. */
export function isEmptyQuery(q: SlideQuery): boolean {
  return q.terms.length === 0 && q.text.trim() === '' && q.types.length === 0 && q.from.length === 0
}

// ── Matching ────────────────────────────────────────────────────────────────────────────────

/** Every term appears (order-independent); no terms matches all. */
export function termsMatch(hayLower: string, terms: readonly string[]): boolean {
  return terms.every((t) => hayLower.includes(t))
}

/** Exact: the phrase appears contiguously; otherwise every term appears. Empty matches all. */
export function matchHay(hayLower: string, q: Pick<SlideQuery, 'exact' | 'text' | 'terms'>): boolean {
  if (q.exact) return hayLower.includes(q.text.toLowerCase())
  return termsMatch(hayLower, q.terms)
}

/** A slide's three searchable strings, lowercased once. */
// `notes` is the presenter's notes: only the presenter view and exported pages carry them (the app's own surfaces
// leave it out, and then nothing below changes). They are searched with the whole slide (scope all, exact), not by `s:`.
export interface PreparedFields { title: string; body: string; image: string; notes?: string }
export interface SlideFields { title: string; body: string; image?: string; notes?: string }

export function prepareFields(f: SlideFields): PreparedFields {
  const prepared: PreparedFields = { title: f.title.toLowerCase(), body: f.body.toLowerCase(), image: (f.image ?? '').toLowerCase() }
  if (f.notes) prepared.notes = f.notes.toLowerCase()
  return prepared
}

/** The scope's test over prepared fields (what the Browser's scan does for each slide). */
export function matchFields(row: PreparedFields, q: Pick<SlideQuery, 'scope' | 'exact' | 'text' | 'terms'>): boolean {
  switch (q.scope) {
    case 'title': return matchHay(row.title, q)
    case 'body': return matchHay(row.body, q)
    case 'image': return matchHay(row.image, q)
    default: {
      // Terms (no whitespace, so no newline) are tested part by part; only a phrase or term that itself holds a
      // newline can span the joins, and then the joined text is the haystack.
      const notes = row.notes ?? ''
      if (q.exact ? q.text.includes('\n') : q.terms.some((t) => t.includes('\n'))) {
        return matchHay(`${row.title}\n${row.body}\n${row.image}${notes ? `\n${notes}` : ''}`, q)
      }
      if (q.exact) {
        const phrase = q.text.toLowerCase()
        return row.title.includes(phrase) || row.body.includes(phrase) || row.image.includes(phrase) || notes.includes(phrase)
      }
      return q.terms.every((t) => row.title.includes(t) || row.body.includes(t) || row.image.includes(t) || notes.includes(t))
    }
  }
}

/**
 * Which slides a talk search counts (the one rule for the grid and the outline): those with a `##`–`######` heading in the
 * talk's text. The cover title (`#`, or the front-matter title card that has no heading line at all) and the closing are
 * not outline slides: the outline has no row to show or jump to for them, so neither view counts them.
 * `level` is the heading depth; 0 = no heading.
 */
export function isSearchedSlide(level: number): boolean { return level >= 2 }

/** The heading depth a card's source starts with (0 when it starts with none). */
export function headingLevelOfSource(markdown: string): number {
  const m = /^(#{1,6})\s/.exec(markdown.trimStart())
  return m ? m[1].length : 0
}

/** A slide in a talk against the whole query: a type prefix other than `slide:` excludes every slide, `from:` looks at the talk title. */
export function matchSlide(row: PreparedFields, q: SlideQuery, talkTitle = ''): boolean {
  if (q.types.length > 0 && !q.types.includes('slide')) return false
  if (q.from.length > 0) {
    const talk = talkTitle.toLowerCase()
    if (!q.from.every((w) => talk.includes(w))) return false
  }
  return matchFields(row, q)
}

/** Where a query hits one slide (the whole query is not tested, only each field). */
export interface FieldHits { title: boolean; text: boolean; picture: boolean }
export function fieldHits(row: PreparedFields, q: SlideQuery): FieldHits {
  const hits = { title: false, text: false, picture: false }
  if (q.terms.length === 0 && !(q.exact && q.text)) return hits
  const hit = (hay: string): boolean => (q.exact ? hay.includes(q.text.toLowerCase()) : hay !== '' && q.terms.some((t) => hay.includes(t)))
  if (q.scope === 'all' || q.scope === 'title') hits.title = hit(row.title)
  if (q.scope === 'all' || q.scope === 'body') hits.text = hit(row.body)
  if (q.scope === 'all' || q.scope === 'image') hits.picture = hit(row.image)
  return hits
}

/** Whether the query hits the presenter notes (whole-slide queries only; the other fields' hits are `fieldHits`). */
export function notesHit(row: PreparedFields, q: SlideQuery): boolean {
  const notes = row.notes ?? ''
  if (notes === '' || q.scope !== 'all') return false
  if (q.terms.length === 0 && !(q.exact && q.text)) return false
  return q.exact ? notes.includes(q.text.toLowerCase()) : q.terms.some((t) => notes.includes(t))
}

// ── Highlight and snippet ───────────────────────────────────────────────────────────────────

/** The strings to mark in shown text: the phrase when exact, else the words. */
export function highlightTerms(q: SlideQuery): string[] {
  return q.exact ? (q.text ? [q.text] : []) : q.terms
}

/** Splits text into runs, marking those that contain one of the terms (terms under 2 letters are ignored). */
export function highlightSegments(text: string, terms: readonly string[]): { text: string; hit: boolean }[] {
  const usable = [...new Set(terms.filter((term) => term.length >= 2))]
  if (usable.length === 0 || text === '') return [{ text, hit: false }]
  const escaped = usable.sort((a, b) => b.length - a.length).map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const re = new RegExp(`(${escaped.join('|')})`, 'ig')
  const out: { text: string; hit: boolean }[] = []
  let last = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), hit: false })
    out.push({ text: m[0], hit: true })
    last = m.index + m[0].length
    if (m[0].length === 0) re.lastIndex++
  }
  if (last < text.length) out.push({ text: text.slice(last), hit: false })
  return out
}

export interface Snippet { label: 'in text' | 'in notes' | 'in picture'; segments: { text: string; hit: boolean }[] }

const SNIPPET_MAX = 90

function lineWithHit(text: string, terms: readonly string[], skipHeading: boolean): string | null {
  const usable = terms.filter((t) => t.length >= 1)
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || (skipHeading && /^#{1,6}\s/.test(line))) continue
    const lower = line.toLowerCase()
    if (usable.some((t) => lower.includes(t.toLowerCase()))) return line
  }
  return null
}

function clip(line: string, terms: readonly string[]): string {
  if (line.length <= SNIPPET_MAX) return line
  const lower = line.toLowerCase()
  let at = -1
  for (const t of terms) { const i = lower.indexOf(t.toLowerCase()); if (i >= 0 && (at < 0 || i < at)) at = i }
  const start = Math.max(0, Math.min(at < 0 ? 0 : at - 25, line.length - SNIPPET_MAX))
  return `${start > 0 ? '…' : ''}${line.slice(start, start + SNIPPET_MAX)}${start + SNIPPET_MAX < line.length ? '…' : ''}`
}

/**
 * The line under a hit row: the title is marked in place, so a title hit needs none; otherwise the first slide-text line
 * that holds a hit ("in text:"), else the picture text ("in picture:"), else the presenter notes ("in notes:"). null when there is nothing to quote.
 */
export function snippet(f: SlideFields, q: SlideQuery): Snippet | null {
  const all = highlightTerms(q)
  if (all.length === 0) return null
  const prepared = prepareFields(f)
  const hits = { ...fieldHits(prepared, q), notes: notesHit(prepared, q) }
  // Words the title already shows marked need no quote; the line quotes the words found elsewhere.
  const title = f.title.toLowerCase()
  const terms = hits.title ? (q.exact ? [] : all.filter((t) => !title.includes(t.toLowerCase()))) : all
  if (terms.length === 0) return null
  const make = (label: Snippet['label'], line: string): Snippet => ({ label, segments: highlightSegments(clip(line, all), all) })
  if (hits.text) {
    const line = lineWithHit(f.body, terms, true)
    if (line) return make('in text', line)
  }
  if (hits.picture && f.image) {
    const line = lineWithHit(f.image, terms, false)
    if (line) return make('in picture', line)
  }
  if (hits.notes && f.notes) {
    const line = lineWithHit(f.notes, terms, false)
    if (line) return make('in notes', line)
  }
  return null
}
