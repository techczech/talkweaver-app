export interface OutlineTreeNode {
  level: number
  title: string
  attrs: Record<string, unknown>
  id: string
  contentLines: string[]
  notesLines: string[]
  children: OutlineTreeNode[]
  /** 1-based line of the heading within the text parseOutlineTree was given (frontmatter excluded). */
  sourceLine: number
  headingLine: string
  triggerLine: string
  /** Plain view ticket 07: the icon NAME written in an authored group on this heading's own line. */
  titleIcon?: string
}
export function parseOutlineTree(text: string): {
  meta: { rawFrontmatter: string; title: string }
  root: OutlineTreeNode
  warnings: string[]
  notesLineIndexes: number[]
  /** 0-based lines folded into a heading's attrs (Trigger block, id-only line). */
  triggerLineIndexes: number[]
  /** Plain view ticket 07: the icon written on the `#` line, when in an authored group. */
  deckTitleIcon: { icon: string; at: 'before' | 'above' } | null
  /** For each node, the 0-based line index of each of its content lines. */
  contentLineIndexes: Map<OutlineTreeNode, number[]>
}
/** A node's content lines as the compiler hands them to the lexer: `stray` is null for a line the lexer sees. */
export function classifyContentLines(contentLines: readonly string[]): Array<{ index: number; line: string; stray: { attrs: Record<string, unknown>; warnings: string[] } | null }>
