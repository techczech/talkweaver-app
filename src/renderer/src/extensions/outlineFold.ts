// Folding for the outline editor: collapse a heading's whole section, or a list item's
// sub-items. Drives the fold gutter arrows + the fold keymap (Ctrl-Shift-[ / ]).
import { foldNodeProp, foldService } from '@codemirror/language'
import { isImageBlockLine } from '../../../../compiler/scripts/lib/image-line-rules.mjs'
import type { MarkdownConfig } from '@lezer/markdown'
import type { EditorState } from '@codemirror/state'
import { headingLevel, listMatch, leadingWidth, isBlank } from './outliner'

export const outlineFoldService = foldService.of(
  (state: EditorState, lineStart: number, lineEnd: number) => {
    const line = state.doc.lineAt(lineStart)

    // Heading → fold everything until the next heading of the same or higher rank.
    const hl = headingLevel(line.text)
    if (hl > 0) {
      let endLine = line.number
      for (let n = line.number + 1; n <= state.doc.lines; n += 1) {
        const t = state.doc.line(n).text
        const h = headingLevel(t)
        if (h > 0 && h <= hl) break
        endLine = n
      }
      return endLine > line.number ? { from: lineEnd, to: state.doc.line(endLine).to } : null
    }

    // List item → fold its deeper-indented sub-items.
    const lm = listMatch(line.text)
    if (lm) {
      let endLine = line.number
      for (let n = line.number + 1; n <= state.doc.lines; n += 1) {
        const t = state.doc.line(n).text
        if (isBlank(t)) break
        const elm = listMatch(t)
        const ind = elm ? elm.indent : leadingWidth(t)
        if (ind <= lm.indent) break
        endLine = n
      }
      return endLine > line.number ? { from: lineEnd, to: state.doc.line(endLine).to } : null
    }

    return null
  }
)

// Markdown folds every multi-line paragraph from its first line, so a run of image lines (or a
// trigger line such as {image-grid} above them) grew a second collapse arrow beside the pictures,
// under the slide heading's own. The heading already collapses those lines; a paragraph that
// holds an image line gets no fold of its own. Other paragraphs keep markdown's default fold.

export const imageParagraphNoFold: MarkdownConfig = {
  props: [
    foldNodeProp.add({
      Paragraph: (node, state) => {
        const first = state.doc.lineAt(node.from)
        const last = state.doc.lineAt(node.to)
        for (let n = first.number; n <= last.number; n += 1) {
          if (isImageBlockLine(state.doc.line(n).text.trim())) return null
        }
        return { from: first.to, to: node.to }
      }
    })
  ]
}
