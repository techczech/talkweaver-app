import type { TableModel } from './object-markup.ts'

type Column = { header: string; children: string[] }

function listItem(line: string): { depth: number; text: string } | null {
  const match = /^(\s*)(?:[-*]|\d+[.)])\s+(.*)$/.exec(line)
  if (!match) return null
  const spaces = match[1].replace(/\t/g, '  ').length
  if (spaces % 2 !== 0) return null
  return { depth: spaces / 2, text: match[2] }
}

/**
 * Parse the compiler's trigger-table list form. Depth-zero items are column headers and their
 * direct children become cells down that column. Deeper trees fail closed: a grid cannot preserve
 * that hierarchy without dropping information.
 */
export function parseTriggerTable(listSource: string): TableModel | null {
  const columns: Column[] = []
  for (const line of listSource.trimEnd().split('\n')) {
    const item = listItem(line)
    if (!item) return null
    if (item.depth === 0) {
      columns.push({ header: item.text, children: [] })
    } else if (item.depth === 1 && columns.length > 0) {
      columns.at(-1)?.children.push(item.text)
    } else {
      return null
    }
  }
  if (columns.length === 0) return null
  const height = Math.max(0, ...columns.map((column) => column.children.length))
  return {
    cells: [
      columns.map((column) => column.header),
      ...Array.from({ length: height }, (_, row) =>
        columns.map((column) => column.children[row] ?? '')
      ),
    ],
    alignments: columns.map(() => 'left'),
  }
}

/**
 * Serialise a table model to the trigger form. Alignments are deliberately dropped because nested
 * list storage has no alignment syntax. Trailing empty cells are omitted per column.
 */
export function serialiseTriggerTable(table: TableModel): string {
  const width = table.cells[0]?.length ?? table.alignments.length
  const lines: string[] = []
  for (let column = 0; column < width; column += 1) {
    lines.push(`- ${table.cells[0]?.[column] ?? ''}`)
    let last = table.cells.length - 1
    while (last > 0 && !(table.cells[last]?.[column] ?? '').trim()) last -= 1
    for (let row = 1; row <= last; row += 1) {
      lines.push(`  - ${table.cells[row]?.[column] ?? ''}`)
    }
  }
  return lines.join('\n')
}
