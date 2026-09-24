export type NotesInline =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; children: NotesInline[] }
  | { kind: 'slide-ref'; className: 'sref'; slideNumber: number; label: string }
  | { kind: 'added'; className: 'added'; title: 'Added in Notes — not said aloud.'; children: NotesInline[] }

export type NotesBlock =
  | { kind: 'key-points'; className: 'narr'; label: 'Key points:'; items: NotesInline[][] }
  | { kind: 'list'; className: 'narr'; items: NotesInline[][] }
  | { kind: 'heading'; level: 3; className: 'mid-head'; text: string }
  | { kind: 'heading'; level: 4; className: 'leaf-head'; slideNumber?: number; text: string }
  | { kind: 'paragraph'; className: 'narr'; children: NotesInline[] }

const ADDED_TITLE = 'Added in Notes — not said aloud.' as const
const ADDED_OPEN = '<!-- added -->'
const ADDED_CLOSE = '<!-- /added -->'

function sentenceLabel(value: string): string {
  return value.replace(/^([a-z])/, (letter) => letter.toUpperCase()).replace(/(\d)\s*-\s*(\d)/g, '$1–$2')
}

function parseInline(value: string, allowAdded = true): NotesInline[] {
  const result: NotesInline[] = []
  let cursor = 0

  const pushText = (text: string): void => {
    if (!text) return
    const previous = result.at(-1)
    if (previous?.kind === 'text') previous.text += text
    else result.push({ kind: 'text', text })
  }

  while (cursor < value.length) {
    if (allowAdded && value.startsWith(ADDED_OPEN, cursor)) {
      const contentStart = cursor + ADDED_OPEN.length
      const closeAt = value.indexOf(ADDED_CLOSE, contentStart)
      const contentEnd = closeAt === -1 ? value.length : closeAt
      result.push({
        kind: 'added',
        className: 'added',
        title: ADDED_TITLE,
        children: parseInline(value.slice(contentStart, contentEnd), false)
      })
      cursor = closeAt === -1 ? value.length : closeAt + ADDED_CLOSE.length
      continue
    }

    if (value.startsWith(ADDED_CLOSE, cursor)) {
      cursor += ADDED_CLOSE.length
      continue
    }

    if (value.startsWith('**', cursor)) {
      const closeAt = value.indexOf('**', cursor + 2)
      if (closeAt !== -1) {
        result.push({ kind: 'strong', children: parseInline(value.slice(cursor + 2, closeAt), allowAdded) })
        cursor = closeAt + 2
        continue
      }
    }

    const slide = value.slice(cursor).match(/^\[(slides?\s+\d+(?:\s*[-–]\s*\d+)?)\]\(\/slides\/(\d+)\)/i)
    if (slide) {
      result.push({
        kind: 'slide-ref',
        className: 'sref',
        slideNumber: Number(slide[2]),
        label: sentenceLabel(slide[1])
      })
      cursor += slide[0].length
      continue
    }

    const slideOffset = value.slice(cursor + 1).search(/\[slides?\s+\d+(?:\s*[-–]\s*\d+)?\]\(\/slides\/\d+\)/i)
    const candidates = [
      allowAdded ? value.indexOf(ADDED_OPEN, cursor + 1) : -1,
      value.indexOf(ADDED_CLOSE, cursor + 1),
      value.indexOf('**', cursor + 1),
      slideOffset === -1 ? -1 : cursor + 1 + slideOffset
    ].filter((index) => index >= 0)
    const next = candidates.length ? Math.min(...candidates) : value.length
    pushText(value.slice(cursor, Math.max(cursor + 1, next)))
    cursor = Math.max(cursor + 1, next)
  }

  return result
}

function leafHeading(value: string): { slideNumber?: number; text: string } {
  const linked = value.match(/^\[slide\s+(\d+)\]\(\/slides\/\d+\)(?:\s*[—:.-]\s*|\s+)(.*)$/i)
  const plain = value.match(/^slide\s+(\d+)(?:\s*[—:.-]\s*|\s+)(.*)$/i)
  const match = linked ?? plain
  return match ? { slideNumber: Number(match[1]), text: match[2].trim() } : { text: value }
}

export function parseNotesMarkdown(markdown: string): NotesBlock[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const blocks: NotesBlock[] = []
  let index = 0

  const skipBlanks = (): void => {
    while (index < lines.length && !lines[index].trim()) index += 1
  }
  const readList = (): NotesInline[][] => {
    const items: NotesInline[][] = []
    while (index < lines.length) {
      const item = lines[index].match(/^\s*[-*+]\s+(.+)$/)
      if (!item) break
      items.push(parseInline(item[1].trim()))
      index += 1
    }
    return items
  }

  while (index < lines.length) {
    skipBlanks()
    if (index >= lines.length) break
    const line = lines[index].trim()

    if (/^\*\*Key points:\*\*$/i.test(line)) {
      index += 1
      skipBlanks()
      blocks.push({ kind: 'key-points', className: 'narr', label: 'Key points:', items: readList() })
      continue
    }

    const heading = line.match(/^(#{3,4})\s+(.+)$/)
    if (heading) {
      index += 1
      if (heading[1].length === 3) {
        blocks.push({ kind: 'heading', level: 3, className: 'mid-head', text: heading[2].trim() })
      } else {
        blocks.push({ kind: 'heading', level: 4, className: 'leaf-head', ...leafHeading(heading[2].trim()) })
      }
      continue
    }

    if (/^\s*[-*+]\s+/.test(lines[index])) {
      blocks.push({ kind: 'list', className: 'narr', items: readList() })
      continue
    }

    const paragraph: string[] = []
    while (index < lines.length && lines[index].trim()) {
      if (paragraph.length && /^(?:#{3,4}\s+|\*\*Key points:\*\*$|\s*[-*+]\s+)/i.test(lines[index].trim())) break
      paragraph.push(lines[index].trim())
      index += 1
    }
    if (paragraph.length) blocks.push({ kind: 'paragraph', className: 'narr', children: parseInline(paragraph.join(' ')) })
  }

  return blocks
}
