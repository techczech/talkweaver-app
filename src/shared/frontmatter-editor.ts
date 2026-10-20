export interface FrontmatterPair {
  key: string
  /** Unquoted scalar text, or raw continuation text beginning with a newline for maps. */
  value: string
}

export interface FrontmatterEdit {
  key: string
  value: string | null
  aliases?: string[]
  /** Write structured YAML verbatim after the key instead of scalar-quoting it. */
  raw?: boolean
}

/** Where the front-matter block sits in a text. Offsets are into the text. */
export interface FrontmatterBlock {
  /** First byte after the opening delimiter line's line break. */
  contentFrom: number
  /** Start of the closing delimiter line; contentFrom when the block is empty (`---` then `---`). */
  contentTo: number
  /** End of the closing delimiter line, before its line break. */
  to: number
  /** The block's line break: CRLF when the block holds one, else LF. */
  eol: '\n' | '\r\n'
}

/**
 * The one definition of the block, shared by the reader, the writer and the editor's Metadata table
 * (frontmatterTable.ts parseFrontmatter): the first line is `---` and the block ends at the next line
 * that is `---`, each compared with surrounding white space ignored (so `--- ` and an empty block
 * `---\n---` are blocks). Null when the text does not open with one.
 */
/** A front-matter delimiter line: `---`, white space around it ignored. */
export const isFrontmatterDelimiter = (line: string): boolean => line.trim() === '---'

export function locateFrontmatter(text: string): FrontmatterBlock | null {
  const firstBreak = text.indexOf('\n')
  if (firstBreak < 0 || !isFrontmatterDelimiter(text.slice(0, firstBreak))) return null
  const contentFrom = firstBreak + 1
  let lineStart = contentFrom
  while (lineStart <= text.length) {
    const lineBreak = text.indexOf('\n', lineStart)
    const lineEnd = lineBreak < 0 ? text.length : lineBreak
    const line = text.slice(lineStart, lineEnd)
    if (isFrontmatterDelimiter(line)) {
      const to = line.endsWith('\r') ? lineEnd - 1 : lineEnd
      return { contentFrom, contentTo: lineStart, to, eol: text.slice(0, to).includes('\r\n') ? '\r\n' : '\n' }
    }
    if (lineBreak < 0) return null
    lineStart = lineBreak + 1
  }
  return null
}

/** The block's lines, without line breaks; [] for an empty block. */
function blockLines(text: string, block: FrontmatterBlock): string[] {
  const content = text.slice(block.contentFrom, block.contentTo)
  return content === '' ? [] : content.replace(/\r?\n$/, '').split(/\r?\n/)
}

export function parseFrontmatterPairs(text: string): FrontmatterPair[] {
  const block = locateFrontmatter(text)
  if (!block) return []
  const lines = blockLines(text, block)
  const pairs: FrontmatterPair[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^([A-Za-z0-9_-]+):[ \t]*(.*)$/)
    if (!match) continue
    const continuation: string[] = []
    let end = index + 1
    while (end < lines.length && /^[ \t]/.test(lines[end])) {
      continuation.push(lines[end])
      end += 1
    }
    const scalar = match[2].trim().replace(/^["']|["']$/g, '').trim()
    pairs.push({
      key: match[1],
      value: continuation.length > 0 ? `${match[2] ? match[2] : ''}\n${continuation.join('\n')}` : scalar
    })
    index = end - 1
  }
  return pairs
}

function serializeYamlValue(value: string): string {
  if (value === 'true' || value === 'false' || /^-?\d+(\.\d+)?$/.test(value)) return value
  if (value === '') return '""'
  if (/[:#"'{}[\]]/.test(value) || /^\s|\s$/.test(value)) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }
  return value
}

function rawLines(key: string, value: string, eol: string): string[] {
  const normalised = value.replace(/\r\n/g, '\n')
  const [first = '', ...continuation] = normalised.split('\n')
  return [`${key}: ${first}`.trimEnd(), ...continuation].map((line) => line.replace(/\n/g, eol))
}

/**
 * Set or remove top-level frontmatter keys while preserving unrelated bytes, comments, key order,
 * body text and line endings. This is the single editor used by metadata and deck settings.
 */
export function editFrontmatterText(text: string, edits: FrontmatterEdit[]): string {
  const block = locateFrontmatter(text)
  if (!block) {
    const sets = edits.filter((edit) => edit.value !== null)
    if (sets.length === 0) return text
    const block = sets.flatMap((edit) => edit.raw
      ? rawLines(edit.key, edit.value as string, '\n')
      : [`${edit.key}: ${serializeYamlValue(edit.value as string)}`]
    ).join('\n')
    return `---\n${block}\n---\n\n${text}`
  }
  const eol = block.eol
  const original = blockLines(text, block)
  let lines = original
  for (const edit of edits) {
    const spellings = [edit.key, ...(edit.aliases ?? [])]
    const index = lines.findIndex((line) => {
      const match = line.match(/^([A-Za-z0-9_-]+):/)
      return match !== null && spellings.includes(match[1])
    })
    let end = index + 1
    while (index >= 0 && end < lines.length && /^[ \t]/.test(lines[end])) end += 1
    if (edit.value === null) {
      if (index >= 0) lines = [...lines.slice(0, index), ...lines.slice(end)]
      continue
    }
    const spelledKey = index >= 0
      ? (lines[index].match(/^([A-Za-z0-9_-]+):/) as RegExpMatchArray)[1]
      : edit.key
    const replacement = edit.raw
      ? rawLines(spelledKey, edit.value, eol)
      : [`${spelledKey}: ${serializeYamlValue(edit.value)}`]
    if (index >= 0) lines = [...lines.slice(0, index), ...replacement, ...lines.slice(end)]
    else lines.push(...replacement)
  }
  // Both delimiter lines are kept as written (a trailing space included); only the lines between change.
  // An empty block stays empty when nothing is set; a block emptied by removals keeps one blank line, as before.
  if (original.length === 0 && lines.length === 0) return text
  const content = lines.length > 0 ? `${lines.join(eol)}${eol}` : eol
  return text.slice(0, block.contentFrom) + content + text.slice(block.contentTo)
}
