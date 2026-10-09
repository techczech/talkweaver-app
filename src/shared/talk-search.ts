// Talk search (ADR-0029 §1): the shapes that cross IPC, and the small pure helpers both sides
// need. The search itself (matching, ranking, match lines) lives in src/main/talk-search.ts.

/** Where a word can match, in ranking order: title first, slide text last. */
export type TalkSearchField = 'title' | 'file' | 'folder' | 'details' | 'delivery' | 'slides'

export const TALK_SEARCH_FIELD_ORDER: readonly TalkSearchField[] = ['title', 'file', 'folder', 'details', 'delivery', 'slides']

/** One term of a query (the language is src/shared/talk-query.ts). `field` restricts it to one
 *  field (a field prefix: fo: folder, fi: file, met: details, co: slides); `date` is `da:`, which
 *  matches the talk's own date or any delivery date; null — a plain word — matches everywhere. */
export interface TalkQueryTerm {
  /** Folded (case- and accent-insensitive) value, without its prefix. */
  text: string
  field: TalkSearchField | 'date' | null
}

export interface TalkQuery {
  raw: string
  terms: TalkQueryTerm[]
}

/** [start, end) character ranges into a display string. */
export type HighlightRange = [number, number]

/** Line two of a result: which field matched and the fragment that did. `label` is what the
 *  row prints (`event`, `folder`, `series`, `given`, `slides`, …). */
export interface TalkMatchLine {
  field: TalkSearchField
  label: string
  text: string
  highlights: HighlightRange[]
}

export interface TalkSearchHit {
  // The talk, in the vault list's own shape (TalkInfo).
  name: string
  path: string
  outlinePath: string
  title: string
  slug: string
  /** Folder path of the talk, relative to the vault root ('' = at the root), `/`-separated. */
  folder: string
  editedMs: number
  /** Ranking tier: the index in TALK_SEARCH_FIELD_ORDER at which every word was matched. */
  tier: number
  titleHighlights: HighlightRange[]
  /** Null when the title matched every word. */
  match: TalkMatchLine | null
  /** Most recent delivery date (YYYY-MM-DD), or null. */
  lastGiven: string | null
}

/** A folder that holds talks, directly or in its subfolders (the `fo:` completion source).
 *  `talks` counts only the talks directly in it; every ancestor of a talk's folder is listed. */
export interface TalkFolderCount {
  /** Vault-relative, `/`-separated. */
  path: string
  talks: number
}

export interface TalkSearchOptions {
  /** Limit results to this folder (vault-relative, `/`-separated) and its subfolders. */
  within?: string
  /** Search this open vault's talks instead of the first open vault's. */
  vaultId?: string
  /** Search these open vaults, merged in this order; an empty list searches nothing. */
  vaultIds?: string[]
}

export interface TalkSearchResult {
  query: string
  terms: TalkQueryTerm[]
  /** The folder the results are limited to, or null for everywhere. */
  within: string | null
  hits: TalkSearchHit[]
  /** How many talks match with no folder limit (equals hits.length when within is null). */
  everywhereCount: number
  /** Slide text read so far: talks whose slides are searchable, out of all talks. */
  slideText: { read: number; total: number }
}

/** The answer to a search over no vaults (an empty vault list searches nothing; ticket 07). */
export function emptyTalkSearchResult(query: string, within: string | null): TalkSearchResult {
  return { query, terms: [], within: within || null, hits: [], everywhereCount: 0, slideText: { read: 0, total: 0 } }
}

/** One result from several vaults' results: hits in vault order, counts added. */
export function mergeTalkSearchResults(results: TalkSearchResult[]): TalkSearchResult {
  if (results.length === 1) return results[0]
  const [first] = results
  return {
    ...first,
    hits: results.flatMap((r) => r.hits),
    everywhereCount: results.reduce((n, r) => n + r.everywhereCount, 0),
    slideText: {
      read: results.reduce((n, r) => n + r.slideText.read, 0),
      total: results.reduce((n, r) => n + r.slideText.total, 0)
    }
  }
}

/**
 * The options for the renderer's one talks:search call: every vault in a single request (the main
 * process searches them and merges in this order), or no vault list for the first open vault.
 */
export function talkSearchRequestOptions(within: string, vaultIds?: string[]): TalkSearchOptions {
  return { ...(within ? { within } : {}), ...(vaultIds ? { vaultIds } : {}) }
}

// App-infrastructure folders the Talks browser hides; search hides the same talks.
export function isIgnoredTalkFolder(folder: string): boolean {
  return ['cache', 'scripts'].includes(folder.split('/')[0].toLowerCase())
}

/** Split a display string into plain and highlighted runs, for rendering <mark>s. */
export function highlightSegments(text: string, ranges: HighlightRange[]): Array<{ text: string; hit: boolean }> {
  const sorted = ranges
    .filter(([a, b]) => b > a)
    .map(([a, b]) => [Math.max(0, a), Math.min(text.length, b)] as HighlightRange)
    .sort((x, y) => x[0] - y[0])
  const merged: HighlightRange[] = []
  for (const r of sorted) {
    const last = merged[merged.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else merged.push([r[0], r[1]])
  }
  const out: Array<{ text: string; hit: boolean }> = []
  let at = 0
  for (const [a, b] of merged) {
    if (a > at) out.push({ text: text.slice(at, a), hit: false })
    out.push({ text: text.slice(a, b), hit: true })
    at = b
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false })
  return out
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** 2026-07-21 → "21 Jul 2026" (fixed English month names: deterministic in every locale). */
export function displayIsoDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!m) return iso
  const month = MONTHS[Number(m[2]) - 1]
  return month ? `${Number(m[3])} ${month} ${m[1]}` : iso
}

/** The results header (frames L5, L7): count on the left, scope on the right. */
export function resultsHeaderModel(result: TalkSearchResult, shown: number): { count: string; scope: string; everywhere: number | null } {
  const count = `${shown} ${shown === 1 ? 'talk' : 'talks'}`
  if (!result.within) return { count, scope: 'everywhere', everywhere: null }
  const name = result.within.split('/').pop() || result.within
  return { count, scope: `in ${name}`, everywhere: result.everywhereCount }
}

/** The quiet still-reading line (frame L9), or null once every talk's slide text is in. */
export function readingLine(result: TalkSearchResult): string | null {
  const { read, total } = result.slideText
  if (read >= total) return null
  return `Reading slide text · ${read} of ${total} talks. More results may appear.`
}
