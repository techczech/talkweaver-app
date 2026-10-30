// Search text from inside an agent's SVG or HTML file, read as data only (never parsed into a live document, never
// executed): SVG gives the text of <text>, <tspan>, <title> and <desc>; HTML gives its visible text (scripts, styles,
// comments and tags dropped, entities decoded). Cached per file by path + mtime + size, so a folder refresh does not
// re-read pages that have not changed. It feeds the search haystack only; no card shows it.
import { lstatSync, readFileSync } from 'node:fs'

export const MAX_CONTENT_CHARS = 20_000
const MAX_READ_BYTES = 5 * 1024 * 1024

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' }
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' '
    }
    return NAMED[body.toLowerCase()] ?? whole
  })
}
const tidy = (text: string): string => decodeEntities(text).replace(/\s+/g, ' ').trim()

// Every step below is a forward scan with indexOf (linear in the file's size): an agent's file is untrusted, and a
// backtracking pattern over an unclosed opener (`<svg ` or `<!--` repeated through 5 MB) would freeze main.

/** Tags replaced by a space; a `<` with no `>` after it is kept as text (and so is everything after it). */
function stripTags(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const lt = text.indexOf('<', i)
    if (lt < 0) { out += text.slice(i); break }
    out += text.slice(i, lt)
    const gt = text.indexOf('>', lt + 1)
    if (gt < 0) { out += text.slice(lt); break }
    out += ' '
    i = gt + 1
  }
  return out
}

/** The end of `</name\s*>` at or after `from` in the lower-cased text, or -1 when there is none. */
function closeEnd(lower: string, name: string, from: number): number {
  const needle = `</${name}`
  for (let at = lower.indexOf(needle, from); at >= 0; at = lower.indexOf(needle, at + 1)) {
    let k = at + needle.length
    while (k < lower.length && /\s/.test(lower[k])) k++
    if (lower[k] === '>') return k + 1
  }
  return -1
}

/** Which of `names` the tag opening at `lt` is (`<name` then not a name character), or null. */
function tagNameAt(lower: string, lt: number, names: readonly string[]): string | null {
  for (const name of names) {
    if (lower.startsWith(name, lt + 1)) {
      const next = lower[lt + 1 + name.length]
      if (next === undefined || !/[a-z0-9_]/.test(next)) return name
    }
  }
  return null
}

/** Comments dropped and CDATA unwrapped; an unclosed comment or CDATA drops the rest of the file. */
function uncomment(source: string): string {
  let out = ''
  let i = 0
  while (i < source.length) {
    const at = source.indexOf('<!', i)
    if (at < 0) { out += source.slice(i); break }
    out += source.slice(i, at)
    if (source.startsWith('<!--', at)) {
      const end = source.indexOf('-->', at + 4)
      if (end < 0) break
      out += ' '
      i = end + 3
    } else if (source.startsWith('<![CDATA[', at)) {
      const end = source.indexOf(']]>', at + 9)
      if (end < 0) break
      out += source.slice(at + 9, end)
      i = end + 3
    } else { out += '<!'; i = at + 2 }
  }
  return out
}

const SVG_TEXT_TAGS = ['tspan', 'title', 'text', 'desc'] as const

export function svgText(source: string): string {
  const cleaned = uncomment(source)
  const lower = cleaned.toLowerCase()
  const parts: string[] = []
  const unclosed = new Set<string>() // no close tag anywhere after: later openers of that name cannot close either
  let i = 0
  while (i < cleaned.length) {
    const lt = cleaned.indexOf('<', i)
    if (lt < 0) break
    const name = tagNameAt(lower, lt, SVG_TEXT_TAGS)
    if (!name || unclosed.has(name)) { i = lt + 1; continue }
    const open = cleaned.indexOf('>', lt + 1)
    if (open < 0) break
    const end = closeEnd(lower, name, open + 1)
    if (end < 0) { unclosed.add(name); i = lt + 1; continue }
    const inner = cleaned.slice(open + 1, lower.lastIndexOf(`</${name}`, end))
    const text = tidy(stripTags(inner))
    if (text) parts.push(text)
    i = end
  }
  return [...new Set(parts)].join(' ').slice(0, MAX_CONTENT_CHARS)
}

const HTML_DROPPED = ['script', 'style', 'noscript', 'template', 'svg'] as const

export function htmlText(source: string): string {
  const lower = source.toLowerCase()
  let kept = ''
  let i = 0
  while (i < source.length) {
    const lt = source.indexOf('<', i)
    if (lt < 0) { kept += source.slice(i); break }
    kept += source.slice(i, lt)
    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4)
      if (end < 0) break // an unclosed comment hides the rest
      kept += ' '
      i = end + 3
      continue
    }
    const name = tagNameAt(lower, lt, HTML_DROPPED)
    if (name) {
      const end = closeEnd(lower, name, lt + 1 + name.length)
      if (end < 0) break // an unclosed script, style or drawing: the rest is not page text
      kept += ' '
      i = end
      continue
    }
    kept += '<'
    i = lt + 1
  }
  return tidy(stripTags(kept)).slice(0, MAX_CONTENT_CHARS)
}

const cache = new Map<string, string>()
const CACHE_LIMIT = 500

/** Text inside the file for search; '' for pictures and anything unreadable. */
export function contentTextFor(path: string, kind: string): string {
  if (kind !== 'svg' && kind !== 'html') return ''
  try {
    const info = lstatSync(path)
    if (!info.isFile() || info.size > MAX_READ_BYTES) return ''
    const key = `${path}\0${Math.round(info.mtimeMs)}\0${info.size}`
    const hit = cache.get(key)
    if (hit !== undefined) return hit
    const text = readFileSync(path, 'utf8')
    const out = kind === 'svg' ? svgText(text) : htmlText(text)
    if (cache.size >= CACHE_LIMIT) cache.clear()
    cache.set(key, out)
    return out
  } catch { return '' }
}
