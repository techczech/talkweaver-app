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

export function parseFrontmatterPairs(text: string): FrontmatterPair[] {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fm) return []
  const lines = fm[1].split(/\r?\n/)
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
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fm) {
    const sets = edits.filter((edit) => edit.value !== null)
    if (sets.length === 0) return text
    const block = sets.flatMap((edit) => edit.raw
      ? rawLines(edit.key, edit.value as string, '\n')
      : [`${edit.key}: ${serializeYamlValue(edit.value as string)}`]
    ).join('\n')
    return `---\n${block}\n---\n\n${text}`
  }
  const eol = fm[0].includes('\r\n') ? '\r\n' : '\n'
  let lines = fm[1].split(/\r?\n/)
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
  return text.slice(0, fm.index!) + `---${eol}${lines.join(eol)}${eol}---` + text.slice(fm.index! + fm[0].length)
}
