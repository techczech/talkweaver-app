// Folding for the outline editor: collapse a heading's whole section, or a list item's
// sub-items. Drives the fold gutter arrows + the fold keymap (Ctrl-Shift-[ / ]).
import { foldService } from '@codemirror/language'
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
