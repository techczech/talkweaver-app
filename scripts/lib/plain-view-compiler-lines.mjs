// The compiler's reading of an outline's lines, for the plain-view parity tests: which lines it
// reads as outline (structure or slide content) and which it skips. Made from the compiler's own
// modules, the way adaptMarkdownOutlineV2 (08-source-adapters.mjs) prepares the text and
// parseOutlineTree (14-outline-tree.mjs) reads it; nothing of src/ is used here.
import { parseOutlineTree } from '../../compiler/scripts/lib/14-outline-tree.mjs'
import { blankHtmlComments } from '../../compiler/scripts/lib/html-comments.mjs'
import { parseMarkdownFenceOpeningLine, isMarkdownFenceClosingLine } from '../../compiler/scripts/lib/03-object-token.mjs'

/**
 * { skipped: boolean[] (one per line), headings: number[] (0-based lines of `##`–`######` nodes) }.
 * Skipped: the front matter; every notes line; every line of a fenced block in a slide's content;
 * a line that had text and has none once comments are blanked.
 */
export function compilerLines(markdown) {
  const raw = markdown.split(/\r?\n/)
  // adaptMarkdownOutlineV2's own preparation of the body.
  let body = markdown
  let frontmatterLines = 0
  if (markdown.startsWith('---')) {
    const end = markdown.indexOf('\n---', 3)
    if (end >= 0) {
      const fmEnd = end + 4
      frontmatterLines = markdown.slice(0, fmEnd).split('\n').length
      body = markdown.slice(0, fmEnd).replace(/[^\n]/g, '') + markdown.slice(fmEnd)
    }
  }
  body = blankHtmlComments(body)
  const read = body.split(/\r?\n/)
  const tree = parseOutlineTree(body)
  const skipped = raw.map((line, i) => i < frontmatterLines || (line.trim() !== '' && read[i].trim() === ''))
  for (const i of tree.notesLineIndexes) skipped[i] = true
  const headings = []
  const walk = (node) => {
    if (node.level >= 2) headings.push(node.sourceLine - 1)
    const indexes = tree.contentLineIndexes.get(node) || []
    let fence = null
    node.contentLines.forEach((line, k) => {
      if (fence) {
        skipped[indexes[k]] = true
        if (isMarkdownFenceClosingLine(line, fence)) fence = null
        return
      }
      fence = parseMarkdownFenceOpeningLine(line)
      if (fence) skipped[indexes[k]] = true
    })
    node.children.forEach(walk)
  }
  walk(tree.root)
  return { skipped, headings: headings.sort((a, b) => a - b) }
}
