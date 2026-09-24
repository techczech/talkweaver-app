// Lifted from WriteFlex src/shared/object-markup.ts (2026-07-25). Framework-free by design — the editor widgets, the compiler previews and the insert builders all hold this one opinion about object bytes.

export type ObjectKind = 'table' | 'mermaid' | 'markmap' | 'svg'
export type TableAlignment = 'left' | 'center' | 'right'
export type TableModel = {
  cells: string[][]
  alignments: TableAlignment[]
  separatorLine?: string
  separatorCells?: Array<string | undefined>
  separatorAlignments?: Array<TableAlignment | undefined>
}

function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/)
    .map((value) => value.trim().replace(/\\\|/g, '|').replace(/<br\s*\/?>/gi, '\n'))
}

export function parseTable(source: string): TableModel | null {
  const lines = source.trim().split('\n')
  if (lines.length < 2) return null
  const all = lines.map(tableCells)
  const separators = all[1]
  if (!separators.length || !separators.every((value) => /^:?-+:?$/.test(value))) return null
  const width = Math.max(...all.map((row) => row.length))
  const pad = (row: string[]): string[] =>
    Array.from({ length: width }, (_, index) => row[index] ?? '')
  const parsedAlignments = separators.map((value) =>
    value.startsWith(':') && value.endsWith(':')
      ? 'center'
      : value.endsWith(':')
        ? 'right'
        : 'left'
  )
  const alignments = Array.from(
    { length: width },
    (_, index): TableAlignment => parsedAlignments[index] ?? 'left'
  )
  return {
    cells: [pad(all[0]), ...all.slice(2).map(pad)],
    alignments,
    separatorLine: separators.length === width ? lines[1] : undefined,
    separatorCells: Array.from({ length: width }, (_, index) => separators[index]),
    separatorAlignments: Array.from(
      { length: width },
      (_, index) => parsedAlignments[index]
    ),
  }
}

function tableCell(value: string): string { return value.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>') }
function explicitSeparator(alignment: TableAlignment): string {
  return alignment === 'center' ? ':---:' : alignment === 'right' ? '---:' : ':---'
}
export function serialiseTable(table: TableModel): string {
  const width = Math.max(
    table.alignments.length,
    ...table.cells.map((row) => row.length),
  )
  const alignments = Array.from(
    { length: width },
    (_, index): TableAlignment => table.alignments[index] ?? 'left'
  )
  const header = table.cells[0] ?? Array(width).fill('')
  const body = table.cells.slice(1)
  const rows = [header, ...body]
  const line = (row: string[]) => `| ${Array.from({ length: width }, (_, index) => tableCell(row[index] ?? '')).join(' | ')} |`
  const untouchedSeparatorLine = table.separatorLine
    && table.separatorAlignments?.length === alignments.length
    && alignments.every((alignment, index) =>
      alignment === table.separatorAlignments?.[index]
    )
    ? table.separatorLine
    : null
  const separators = alignments.map((alignment, index) =>
    alignment === table.separatorAlignments?.[index] && table.separatorCells?.[index]
      ? table.separatorCells[index]
      : explicitSeparator(alignment)
  )
  return [
    line(rows[0]),
    untouchedSeparatorLine ?? line(separators),
    ...rows.slice(1).map(line),
  ].join('\n')
}

// First-token vocabulary from mermaid@11.16.0's vendored detector registry. Keep aliases because
// Mermaid accepts both stable and beta spellings for several families.
const MERMAID_TYPES = new Set([
  'flowchart', 'graph', 'flowchart-elk', 'swimlane-beta',
  'sequenceDiagram', 'classDiagram', 'classDiagram-v2', 'stateDiagram', 'stateDiagram-v2',
  'erDiagram', 'journey', 'gantt', 'pie', 'quadrantChart', 'requirement', 'requirementDiagram',
  'gitGraph', 'C4Context', 'C4Container', 'C4Component', 'C4Dynamic', 'C4Deployment',
  'mindmap', 'timeline', 'kanban', 'sankey', 'sankey-beta', 'xychart', 'xychart-beta',
  'block', 'block-beta', 'packet', 'packet-beta', 'architecture', 'architecture-beta',
  'radar', 'radar-beta', 'treemap', 'treeView-beta', 'eventmodeling', 'ishikawa',
  'ishikawa-beta', 'venn-beta', 'wardley-beta', 'cynefin-beta', 'railroad-beta',
  'railroad-ebnf-beta', 'railroad-abnf-beta', 'railroad-peg-beta',
])

function delimiterError(line: string): string | null {
  let quote = false
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (char === '"' && line[i - 1] !== '\\') quote = !quote
  }
  return quote ? 'quotes' : null
}

export function validateObjectMarkup(kind: ObjectKind, content: string): void {
  const inner = content.trim()
  if (!inner) throw new Error(`${kind} content must not be empty; provide inner markup without fences and retry.`)
  if (kind === 'svg') {
    if (/^```/m.test(inner)) throw new Error('SVG content must be inner markup without fences; remove the fences and retry.')
    if (!/^<svg(?:\s|>)/i.test(inner) || !/(?:<\/svg\s*>|<svg\b[^>]*\/\s*>)$/i.test(inner)) {
      throw new Error('SVG content must be one complete SVG document with an <svg> root; correct the markup and retry.')
    }
    return
  }
  if (kind === 'table') {
    if (!parseTable(inner)) throw new Error('Table content must be a valid pipe table with a header and a GFM dash separator row; correct the table and retry.')
    return
  }
  const lines = inner.split('\n')
  if (kind === 'markmap') {
    let previousLevel = 0
    lines.forEach((line, index) => {
      if (!/^\s*- /.test(line)) throw new Error(`Markmap line ${index + 1} must begin with "- " after optional two-space indentation; correct the list and retry.`)
      const spaces = line.match(/^\s*/)?.[0].length ?? 0
      if (spaces % 2 !== 0) throw new Error(`Markmap line ${index + 1} must use indentation steps of two spaces; correct the indentation and retry.`)
      const level = spaces / 2
      if (level > previousLevel + 1) throw new Error(`Markmap line ${index + 1} jumps more than one level; indent by at most one level at a time and retry.`)
      previousLevel = level
    })
    return
  }
  const meaningful = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.trim())
  const firstWord = meaningful[0]?.line.trim().split(/\s+/)[0] ?? ''
  if (!MERMAID_TYPES.has(firstWord)) throw new Error('Mermaid content must start with a diagram type supported by the vendored Mermaid 11.16 renderer; correct the first line and retry.')
  if (meaningful.length < 2) throw new Error('Mermaid content needs a non-empty diagram body after its type declaration; add at least one statement and retry.')
  for (const { line, index } of meaningful) {
    const problem = delimiterError(line)
    if (problem) throw new Error(`Mermaid content has unbalanced ${problem} on line ${index + 1}; balance them and retry.`)
  }
}

export function objectBlock(kind: ObjectKind, content: string): string {
  const inner = content.trimEnd()
  return kind === 'mermaid' || kind === 'svg' ? `\`\`\`${kind}\n${inner}\n\`\`\`` : inner
}
