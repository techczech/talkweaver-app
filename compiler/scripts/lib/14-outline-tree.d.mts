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
}
export function parseOutlineTree(text: string): {
  meta: { rawFrontmatter: string; title: string }
  root: OutlineTreeNode
  warnings: string[]
}
