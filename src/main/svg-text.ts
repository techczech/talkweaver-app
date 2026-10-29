// The text an SVG picture shows: the content of its <text> elements (with their <tspan> children),
// read straight from the XML (no Vision pass). One <text> element is one piece; pieces are joined by
// newlines, whitespace collapsed.
//
// A single forward scan (indexOf), linear in the input: no backtracking regex, so a hostile or broken
// file (thousands of <text> openings with no closing, inside a comment) cannot stall the main process.
//  - Comments, processing instructions and <!DOCTYPE ...> are skipped.
//  - CDATA inside a <text> is literal text (not entity-decoded, `<hello>` stays `<hello>`).
//  - Inline children are concatenated as written: `Hel<tspan>lo</tspan>` is "Hello".
//  - A <tspan> with y or dy starts a new line: a space before it, as before.
//  - A <tspan> with only x or dx is ambiguous: design tools emit one per word (`<tspan x=..>Hello</tspan>
//    <tspan x=..>world</tspan>`) but also one per letter group (`Hel<tspan x="20">lo</tspan>`). It gets
//    a space in the main text, and that line is emitted once more (its own piece, after the element)
//    with those x-only joins collapsed, so both "hel lo"-style and "hello" searches match. The extra
//    line is emitted only when it differs.

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decode(s: string): string {
  if (!s.includes('&')) return s
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
      try { return Number.isFinite(code) ? String.fromCodePoint(code) : whole } catch { return whole }
    }
    return ENTITIES[name.toLowerCase()] ?? whole
  })
}

function isNameChar(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95 || c === 58 || c === 46 || c === 45
}

const NEW_LINE = /(?:^|\s)(?:y|dy)\s*=/
const X_ONLY = /(?:^|\s)(?:x|dx)\s*=/

const norm = (t: string): string => t.replace(/\s+/g, ' ').trim()

export function svgText(svg: string): string {
  const s = String(svg || '')
  const n = s.length
  const pieces: string[] = []
  let depth = 0 // how many <text> elements we are inside
  // The current <text> element: finished lines, and the current line spaced and with x-only joins collapsed.
  let lines: string[] = []
  let variants: string[] = []
  let line = ''
  let joined = ''
  let xJoin = false // the current line has an x-only join
  const add = (t: string): void => { line += t; joined += t }
  const endLine = (): void => {
    const spaced = norm(line)
    if (spaced) {
      lines.push(spaced)
      if (xJoin) { const collapsed = norm(joined); if (collapsed && collapsed !== spaced) variants.push(collapsed) }
    }
    line = ''; joined = ''; xJoin = false
  }
  const finish = (): void => {
    endLine()
    const t = lines.join(' ')
    if (t) pieces.push(t, ...variants)
    lines = []; variants = []
  }
  let i = 0
  while (i < n) {
    const lt = s.indexOf('<', i)
    const stop = lt < 0 ? n : lt
    if (depth > 0 && stop > i) add(decode(s.slice(i, stop)))
    if (lt < 0) break
    if (s.startsWith('<!--', lt)) {
      const e = s.indexOf('-->', lt + 4)
      i = e < 0 ? n : e + 3
      continue
    }
    if (s.startsWith('<![CDATA[', lt)) {
      const e = s.indexOf(']]>', lt + 9)
      if (depth > 0) add(s.slice(lt + 9, e < 0 ? n : e))
      i = e < 0 ? n : e + 3
      continue
    }
    if (s.startsWith('<?', lt)) {
      const e = s.indexOf('?>', lt + 2)
      i = e < 0 ? n : e + 2
      continue
    }
    if (s.startsWith('<!', lt)) {
      const e = s.indexOf('>', lt + 2)
      i = e < 0 ? n : e + 1
      continue
    }
    const closing = s.charCodeAt(lt + 1) === 47 // '/'
    const nameStart = lt + (closing ? 2 : 1)
    let k = nameStart
    while (k < n && isNameChar(s.charCodeAt(k))) k++
    if (k === nameStart) {
      // A bare '<' in text (not well-formed XML): keep it as a character.
      if (depth > 0) add('<')
      i = lt + 1
      continue
    }
    // The end of the tag: a '>' outside quoted attribute values.
    let quote = 0
    let m = k
    for (; m < n; m++) {
      const c = s.charCodeAt(m)
      if (quote) { if (c === quote) quote = 0 } else if (c === 34 || c === 39) quote = c
      else if (c === 62) break
    }
    if (m >= n) break // an unterminated tag ends the document
    const qualified = s.slice(nameStart, k).toLowerCase()
    const name = qualified.slice(qualified.lastIndexOf(':') + 1)
    const attrs = s.slice(k, m)
    const selfClosing = attrs.endsWith('/')
    i = m + 1
    if (name === 'text') {
      if (closing) {
        if (depth > 0) { depth -= 1; if (depth === 0) finish() }
      } else if (!selfClosing) {
        if (depth === 0) { lines = []; variants = []; line = ''; joined = ''; xJoin = false } else add(' ')
        depth += 1
      }
    } else if (name === 'tspan' && !closing && depth > 0) {
      if (NEW_LINE.test(attrs)) endLine()
      else if (X_ONLY.test(attrs)) { line += ' '; xJoin = true }
    }
  }
  if (depth > 0) finish()
  return pieces.join('\n')
}
