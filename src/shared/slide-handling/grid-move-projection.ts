// Presentation cache only. The editor buffer remains canonical; compilation replaces these rows.
import { slideRows } from './slide-outline.ts'

interface GridMoveRow { source_line?: number | null; section?: string; subsection?: string; role?: string; order?: number }

/** Reuse existing cards immediately for an EXACT permutation of source blocks. Never infer artwork
 * from titles/ids alone: edits, insertions, ambiguous twins and changed document context fall back
 * to compilation. The shared heading reader excludes fences, comments and frontmatter. */
export function projectGridMove<T extends GridMoveRow>(rows: readonly T[], before: string, after: string): T[] | null {
  if (before === after) return [...rows]
  if (rows.some(row => row.subsection)) return null // nested navigation needs compiler context
  const split = (text: string) => {
    const lines = text.split('\n'), headings = slideRows(text)
    return {
      prefix: lines.slice(0, (headings[0]?.line ?? lines.length + 1) - 1).join('\n'),
      blocks: headings.map((heading, i) => ({
        line: heading.line,
        level: heading.level,
        text: lines.slice(heading.line - 1, headings[i + 1] ? headings[i + 1].line - 1 : lines.length).join('\n').replace(/(?:\n[ \t]*)+$/, '')
      }))
    }
  }
  const old = split(before), next = split(after)
  if (old.prefix !== next.prefix || !old.blocks.length || old.blocks.length !== next.blocks.length) return null
  const destinations = new Map(next.blocks.map(block => [block.text, block.line]))
  const hadChildren = new Map(old.blocks.map((block, i) => [block.text, (old.blocks[i + 1]?.level ?? 0) > block.level]))
  // Losing/gaining the last child can change compiler role and artwork, not just order.
  if (next.blocks.some((block, i) => hadChildren.get(block.text) !== ((next.blocks[i + 1]?.level ?? 0) > block.level))) return null
  if (destinations.size !== next.blocks.length || new Set(old.blocks.map(block => block.text)).size !== old.blocks.length) return null // unstamped identical blocks: no safe identity
  const byOldLine = new Map<number, number>()
  for (const block of old.blocks) {
    const line = destinations.get(block.text)
    if (line == null) return null
    byOldLine.set(block.line, line)
  }
  const first = rows.findIndex(row => typeof row.source_line === 'number')
  let last = rows.length - 1
  while (last >= 0 && typeof rows[last].source_line !== 'number') last -= 1
  if (first < 0) return null
  const real = rows.slice(first, last + 1)
  // Only leading/trailing generated cards are position-independent. Folded/generated interior
  // rows need the compiler's contextual ordering, so do not guess where they belong.
  if (real.some(row => typeof row.source_line !== 'number' || !byOldLine.has(row.source_line))) return null
  const projectedLines = new Set(real.map(row => row.source_line))
  // Unprojected child headings can be folded into a parent's artwork (carousel/container).
  // Moving those changes that artwork: leave contextual layouts to the compiler.
  if (old.blocks.some(block => block.level >= 2 && !projectedLines.has(block.line))) return null
  // Leaf sections carry compiler-specific grouping. Only project the grouping already
  // represented by preceding section-title rows; otherwise wait for the compiler.
  let oldSection: string | undefined = ''
  for (const row of real) {
    if (row.role === 'section-title') oldSection = row.section
    else if ((row.section ?? '') !== (oldSection ?? '')) return null
  }
  const ordered = real.map(row => ({ ...row, source_line: byOldLine.get(row.source_line!)! }))
    .sort((a, b) => a.source_line - b.source_line)
  let section: string | undefined = ''
  for (const row of ordered) {
    if (row.role === 'section-title') section = row.section
    else row.section = section
  }
  return [...rows.slice(0, first), ...ordered, ...rows.slice(last + 1)]
    .map((row, order) => row.order === undefined ? row : { ...row, order })
}
