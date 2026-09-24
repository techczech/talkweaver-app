import { parseTable } from './object-markup.ts'

// These builders duplicate the registry skeletons because entries.ts must stay import-free for
// compiler parity harnesses; scripts/test-object-blocks.mjs:38-41 pins byte equality.
export function buildEmptyTable(): string {
  return '|  |  |  |\n| :--- | :--- | :--- |\n|  |  |  |\n|  |  |  |\n|  |  |  |'
}

export function buildMermaid(): string {
  return '```mermaid\nflowchart LR\n  A[Start] --> B[Next]\n```'
}

export function buildMindmapList(): string {
  return '- Central idea\n  - First branch\n  - Second branch'
}

export function buildTriggerListObjectSource(token: string, skeleton: string): string {
  return `${token.trim()}\n${skeleton.replace(/^\n+|\n+$/g, '')}`
}

export function buildFencedObjectSource(info: string, skeleton: string): string {
  return `\`\`\`${info.trim()}\n${skeleton.replace(/^\n+|\n+$/g, '')}\n\`\`\``
}

export interface ObjectBlockSplicePlan {
  from: number
  to: number
  insert: string
  blockFrom: number
  blockTo: number
  openFrom: number
  openTo: number
}

export interface ObjectInsertRequest {
  triggerToken?: string
  replace?: { from: number; to: number }
}

/**
 * Plan the single document splice shared by object insertion doors.
 * `openOffset` keeps the widget editor on the object's editable body rather than its token line.
 */
export function planObjectBlockSplice(
  _doc: string,
  at: number,
  blockSource: string,
  openOffset = 0
): ObjectBlockSplicePlan {
  const source = blockSource.replace(/^\n+|\n+$/g, '')
  const sourceFrom = at + 2
  const openFrom = sourceFrom + openOffset
  return {
    from: at,
    to: at,
    insert: `\n\n${source}\n`,
    blockFrom: sourceFrom,
    blockTo: sourceFrom + source.length,
    openFrom,
    openTo: openFrom + Math.max(0, source.length - openOffset)
  }
}

export function buildSvg(): string {
  return '```svg\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180">\n  <rect width="320" height="180" rx="12" fill="#f2f0ea"/>\n</svg>\n```'
}

export function isSvgText(text: string): boolean {
  return /^\s*<svg(?:\s|>)[\s\S]*<\/svg\s*>\s*$/i.test(text)
}

export function isSvgFile(file: Pick<File, 'name' | 'type'>): boolean {
  return file.type.toLowerCase() === 'image/svg+xml' || /\.svg$/i.test(file.name)
}

export function parseTablePaste(text: string): string[][] {
  const parsed = parseTable(text)
  if (parsed) return parsed.cells
  return text.replace(/\r/g, '').split('\n').map((row) => row.split('\t'))
}

export function tablePasteKind(text: string): 'pipe' | 'tsv' | null {
  const lines = text.replace(/\r/g, '').split('\n')
  const nonEmpty = lines.filter((line) => line.trim().length > 0)
  const firstContent = lines.findIndex((line) => line.trim().length > 0)

  // Mirror the compiler lexer: a pipe table starts with a leading-pipe row and its next line is
  // the leading-pipe delimiter row. A setext underline or thematic break cannot satisfy this.
  if (
    firstContent >= 0
    && firstContent + 1 < lines.length
    && lines[firstContent].trim().startsWith('|')
    && /^\|[\s:|-]+\|?$/.test(lines[firstContent + 1].trim())
  ) {
    return 'pipe'
  }

  // Rectangular TSV needs two or more rows with one shared column count. Reject the Markdown
  // tab-indented-code shape explicitly; optional spaces before its tab are still indentation,
  // not an empty first cell in real TSV.
  if (nonEmpty.length < 2 || nonEmpty.some((line) => /^[ ]*\t/.test(line))) return null
  const columnCounts = nonEmpty.map((line) => line.split('\t').length)
  const columns = columnCounts[0]
  return columns >= 2 && columnCounts.every((count) => count === columns) ? 'tsv' : null
}
