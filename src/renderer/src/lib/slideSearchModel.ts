// The grid's and the outline's search over one query (ticket 2): which slides match, where the hits are, the line
// under each hit and Previous/Next. Pure; the match, highlight and snippet are src/shared/slide-handling/query.ts.
import {
  highlightTerms, isEmptyQuery, isSearchedSlide, matchSlide, parseQuery, prepareFields, snippet, type Snippet, type SlideQuery
} from '../../../shared/slide-handling/query.ts'

/** One slide as the search sees it; `key` names it in the caller's own terms (a source line, a card index). */
export interface SearchItem { key: number; title: string; body: string; image: string
  /** Heading depth when known (isSearchedSlide in query.ts): the cover title and closing are not searched. */
  level?: number }

export interface SearchRun {
  query: SlideQuery
  /** A query with something to look for; false = show everything as usual. */
  active: boolean
  /** Strings to mark in shown text. */
  terms: string[]
  /** Hit keys in talk order. */
  order: number[]
  isHit: ReadonlySet<number>
  snippets: ReadonlyMap<number, Snippet>
}

const NONE: SearchRun = { query: parseQuery(''), active: false, terms: [], order: [], isHit: new Set(), snippets: new Map() }

export function runSearch(items: readonly SearchItem[], raw: string, talkTitle = ''): SearchRun {
  const query = parseQuery(raw)
  if (isEmptyQuery(query)) return { ...NONE, query }
  const order: number[] = []
  const snippets = new Map<number, Snippet>()
  for (const it of items) {
    if (it.level !== undefined && !isSearchedSlide(it.level)) continue
    if (!matchSlide(prepareFields(it), query, talkTitle)) continue
    order.push(it.key)
    const sn = snippet(it, query)
    if (sn) snippets.set(it.key, sn)
  }
  return { query, active: true, terms: highlightTerms(query), order, isHit: new Set(order), snippets }
}

/** Previous / Next through the hits in talk order, wrapping; from nothing, Next is the first and Previous the last. */
export function stepHit(order: readonly number[], current: number | null, dir: 1 | -1): number | null {
  if (order.length === 0) return null
  const at = current == null ? -1 : order.indexOf(current)
  if (at < 0) return order[dir > 0 ? 0 : order.length - 1]
  return order[(at + dir + order.length) % order.length]
}

/** "k of N": k is 1-based, 0 when the current slide is not a hit. */
export function hitPosition(order: readonly number[], current: number | null): { k: number; n: number } {
  const at = current == null ? -1 : order.indexOf(current)
  return { k: at + 1, n: order.length }
}

/** The first hit at or after `from` (talk order), else the first hit: where a typed query lands. */
export function firstHitFrom(order: readonly number[], from: number | null): number | null {
  if (order.length === 0) return null
  if (from == null) return order[0]
  return order.find((k) => k >= from) ?? order[0]
}

/** The outline's rows as search items: a row's body is the lines under its heading up to the next heading. */
export function outlineItems(content: string, rows: ReadonlyArray<{ line: number; text: string; level?: number }>, pictureText: readonly string[] = []): SearchItem[] {
  const lines = content.split('\n')
  return rows.map((r, i) => {
    const end = i + 1 < rows.length ? rows[i + 1].line - 1 : lines.length
    return { key: r.line, level: r.level, title: r.text, body: lines.slice(r.line, end).join('\n').trim(), image: pictureText[i] ?? '' }
  })
}

/** The text of each outline row's block, in row order: what the picture-text lookup is asked about. */
export function outlineBlocks(items: readonly SearchItem[]): string[] {
  return items.map((it) => it.body)
}

/** Hits inside each section row (its descendants, not itself), by line. */
export function sectionHitCounts(rows: ReadonlyArray<{ line: number; level: number }>, isHit: ReadonlySet<number>): Map<number, number> {
  const out = new Map<number, number>()
  rows.forEach((r, i) => {
    let n = 0
    for (let j = i + 1; j < rows.length && rows[j].level > r.level; j++) if (isHit.has(rows[j].line)) n++
    if (i + 1 < rows.length && rows[i + 1].level > r.level) out.set(r.line, n)
  })
  return out
}
