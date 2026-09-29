import type { TalkSearchField } from './talk-search.ts'

// The talk query language (ADR-0029 §2): plain words and field prefixes, as typed in the talk
// search box. Shared by the search itself (src/main/talk-search.ts parses queries with it) and
// the box (the hint row, completion and no-results suggestions work on the same tokens).
//
// A token is a run of non-space characters. A token that starts with a known prefix (`fo:`
// `fi:` `met:` `co:` `da:`, any case) is a prefixed term; its value may be quoted to hold spaces
// (`fo:"AI Agent Workshops"`). Any other token is a plain word, including one with an unknown
// prefix (`xx:foo` is the plain word "xx:foo"). The slide picker's own one-letter prefixes
// (`t: s: i: e:`) are a different grammar in a different box and are not read here.

export type TalkFieldPrefix = 'fo' | 'fi' | 'met' | 'co' | 'da'

export interface TalkPrefixDef {
  prefix: TalkFieldPrefix
  /** As typed: `fo:`. */
  token: string
  /** The hint row's word for it. */
  hint: string
  /** What it narrows to: one search field, or `date` (the talk's date or any delivery date). */
  field: TalkSearchField | 'date'
}

export const TALK_FIELD_PREFIXES: readonly TalkPrefixDef[] = [
  { prefix: 'fo', token: 'fo:', hint: 'folder', field: 'folder' },
  { prefix: 'fi', token: 'fi:', hint: 'file name', field: 'file' },
  { prefix: 'met', token: 'met:', hint: 'details', field: 'details' },
  { prefix: 'co', token: 'co:', hint: 'slides', field: 'slides' },
  { prefix: 'da', token: 'da:', hint: 'date', field: 'date' }
]

/** How `da:` reads a date (the ADR left this open; ticket 02 fixed it). Shown as help text. */
export const DATE_FORMS_HELP = 'da: reads 2026 (a year), 2026-07 (a month), 2026-07-22 (a day), or a month name such as jul or july (that month in any year)'

/** The search box's help: every prefix, and how dates read. */
export const TALK_QUERY_HELP =
  'Plain words match everywhere. Narrow with fo: folder · fi: file name · met: details · co: slides · da: date. ' +
  `${DATE_FORMS_HELP}. Quote a value with spaces: fo:"AI Agent Workshops".`

export function prefixDef(prefix: TalkFieldPrefix): TalkPrefixDef {
  return TALK_FIELD_PREFIXES.find((p) => p.prefix === prefix)!
}

/** Case- and accent-insensitive form used for all matching. */
export function foldText(value: string): string {
  return value.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase()
}

// ── tokens ──────────────────────────────────────────────────────────────────

export interface QueryToken {
  /** [start, end) into the raw query. */
  start: number
  end: number
  /** The token as typed. */
  text: string
  prefix: TalkFieldPrefix | null
  /** A prefixed token's value (unquoted), or a plain token's whole text. */
  value: string
}

const PREFIX_RE = /^(fo|fi|met|co|da):/i

export function tokenizeTalkQuery(raw: string): QueryToken[] {
  const out: QueryToken[] = []
  let at = 0
  while (at < raw.length) {
    if (/\s/.test(raw[at])) { at += 1; continue }
    const start = at
    const head = PREFIX_RE.exec(raw.slice(at, at + 5))
    if (head && raw[at + head[0].length] === '"') {
      // A quoted value runs to the closing quote (or the end while it is still being typed).
      const open = at + head[0].length
      const close = raw.indexOf('"', open + 1)
      at = close === -1 ? raw.length : close + 1
      // Anything glued on after the closing quote belongs to the same token.
      while (at < raw.length && !/\s/.test(raw[at])) at += 1
      const inner = raw.slice(open + 1, close === -1 ? raw.length : close)
      out.push({ start, end: at, text: raw.slice(start, at), prefix: head[1].toLowerCase() as TalkFieldPrefix, value: inner + raw.slice(close === -1 ? raw.length : close + 1, at) })
      continue
    }
    while (at < raw.length && !/\s/.test(raw[at])) at += 1
    const text = raw.slice(start, at)
    if (head) out.push({ start, end: at, text, prefix: head[1].toLowerCase() as TalkFieldPrefix, value: text.slice(head[0].length) })
    else out.push({ start, end: at, text, prefix: null, value: text })
  }
  return out
}

/** A prefixed value as it must be typed: quoted when it holds a space. */
export function formatPrefixed(prefix: TalkFieldPrefix, value: string): string {
  return `${prefix}:${/\s/.test(value) ? `"${value.replace(/"/g, '')}"` : value}`
}

/** True when the query holds anything to search for (a lone `fo:` is not yet a term). */
export function hasSearchTerms(raw: string): boolean {
  return tokenizeTalkQuery(raw).some((t) => t.value.trim().length > 0)
}

/** The query with one token replaced (null removes it), spaces tidied. */
export function replaceToken(raw: string, token: QueryToken, next: string | null): string {
  const before = raw.slice(0, token.start)
  const after = raw.slice(token.end)
  if (next != null) return `${before}${next}${after}`
  return `${before.replace(/\s+$/, '')}${before.trim() && after.trim() ? ' ' : ''}${after.replace(/^\s+/, '')}`.trim()
}

// ── dates ───────────────────────────────────────────────────────────────────

/** A date, or a part of one: a year, a month in a year, a day, or a month in any year. */
export interface DateParts {
  year?: number
  month?: number
  day?: number
}

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

/** `jul`, `july`, `sept` → 7, 7, 9 (three letters at least, a prefix of the month's name). */
function monthOf(word: string): number | null {
  const w = foldText(word).replace(/\.$/, '')
  if (w.length < 3) return null
  const index = MONTH_NAMES.findIndex((m) => m.startsWith(w))
  return index === -1 ? null : index + 1
}

const validMonth = (m: number): boolean => m >= 1 && m <= 12
const validDay = (d: number): boolean => d >= 1 && d <= 31

/** What `da:` reads: `2026`, `2026-07`, `2026-07-22` (one-digit months and days too), or a
 *  month name meaning that month in any year. Null for anything else. */
export function parseDateQuery(value: string): DateParts | null {
  const v = value.trim()
  let m = /^(\d{4})$/.exec(v)
  if (m) return { year: Number(m[1]) }
  m = /^(\d{4})-(\d{1,2})$/.exec(v)
  if (m) return validMonth(Number(m[2])) ? { year: Number(m[1]), month: Number(m[2]) } : null
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v)
  if (m) return validMonth(Number(m[2])) && validDay(Number(m[3])) ? { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) } : null
  if (/^\p{L}+\.?$/u.test(v)) {
    const month = monthOf(v)
    return month ? { month } : null
  }
  return null
}

/** A talk's own date as written in its frontmatter: `2026-07-22` (a time may follow), `2026-07`,
 *  `2026`, `22 July 2026`, `July 22, 2026`, `July 2026`. Null when it is not a date. */
export function parseLooseDate(value: string): DateParts | null {
  const v = value.trim().replace(/^["']|["']$/g, '')
  let m = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?(?:$|[T\s])/.exec(v)
  if (m) {
    const out: DateParts = { year: Number(m[1]) }
    if (m[2] && validMonth(Number(m[2]))) out.month = Number(m[2])
    if (out.month && m[3] && validDay(Number(m[3]))) out.day = Number(m[3])
    return out
  }
  m = /^(\d{1,2})(?:st|nd|rd|th)?\s+(\p{L}+)\.?,?\s+(\d{4})$/u.exec(v)
  if (m) {
    const month = monthOf(m[2])
    return month && validDay(Number(m[1])) ? { year: Number(m[3]), month, day: Number(m[1]) } : null
  }
  m = /^(\p{L}+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/u.exec(v)
  if (m) {
    const month = monthOf(m[1])
    return month && validDay(Number(m[2])) ? { year: Number(m[3]), month, day: Number(m[2]) } : null
  }
  m = /^(\p{L}+)\.?,?\s+(\d{4})$/u.exec(v)
  if (m) {
    const month = monthOf(m[1])
    return month ? { year: Number(m[2]), month } : null
  }
  return null
}

/** Every part the query names must be present in the date and equal. */
export function datePartsMatch(query: DateParts, date: DateParts): boolean {
  if (query.year == null && query.month == null && query.day == null) return false
  if (query.year != null && date.year !== query.year) return false
  if (query.month != null && date.month !== query.month) return false
  if (query.day != null && date.day !== query.day) return false
  return true
}

// ── folders ─────────────────────────────────────────────────────────────────

/** Where in a folder path a `fo:` term matched, as the path from the deepest segment at which
 *  the term still matches: `external-workshops/York-July-2026/day-3` with `york` →
 *  `York-July-2026/day-3`. Null when the term is not in the path. */
export function folderFrom(folder: string, term: string): string | null {
  const t = foldText(term)
  if (!t || !foldText(folder).includes(t)) return null
  const segments = folder.split('/')
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const tail = segments.slice(i).join('/')
    if (foldText(tail).includes(t)) return tail
  }
  return folder
}
