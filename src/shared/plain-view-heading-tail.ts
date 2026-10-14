// Plain view, ticket 07 (fourth fix round): the hidden tail of a heading line, read by ONE
// function for everything that hides or protects it.
//
// A heading's trailing `{…}` groups are hidden in Plain: the options and the id by hiddenLines.ts,
// a group that holds an icon token by iconPictures.ts (which draws the picture). They are one
// tail all the same: one end of the visible text (`textEnd`), one stretch the caret keeps out of
// (`(textEnd, lineTo]`), one span a deleting key must not reach into. Both files take those from
// here, so a tail that mixes icon and other groups, in any order, has one answer.
//
// WHICH groups are the tail is the compiler's answer, not a pattern of this file (eighth review):
// parseHeadingAttrs (compiler/scripts/lib/02-triggers-layout.mjs) peels EVERY trailing group off a
// heading, takes it out of the title and reads its tokens as the slide's options. That holds for a
// group glued to text (`### A{reveal}`) and for one after a backslash (`### A \{reveal}`: the
// slide's title is `A \`) as for one after a space, and for a group that holds `icon=` as for any
// other. The groups come from the shared port of the compiler's headingBraceGroups
// (shared/plain-view-icon-tokens.ts), so what Plain hides and protects on a heading line is what
// the compiler consumes on it (test:plain-view-icon-token-parity holds the two together).
//
// "Authored" (reached from whitespace) decides one thing only, as in the compiler: whether a
// group's `icon=` is the TITLE's icon. An authored icon group is iconPictures' (a picture, a chip
// the caret can step into). An icon group that is not authored (`### Use \{icon=lucide:bike}`,
// `### See https://example.org/{icon=lucide:bike}`) draws no picture on the slide and none here,
// but the compiler still takes it off the title: it is hidden like `{reveal}`, by hiddenLines.ts.
// (Before this was read from the shared reader, such a group was marked as an icon group here
// while iconPictures, reading authored groups only, never hid it: text that showed, and that the
// caret and the keys were kept out of.)
import { groupHoldsIcon, headingBraceGroups } from './plain-view-icon-tokens.ts'
import { headingLine } from './plain-view-heading-line.ts'

export interface TailGroup {
  /** The group's `{`. */
  from: number
  /** After its `}`. */
  to: number
  /**
   * An authored group that holds an `icon=` token (read with the compiler's tokeniser): the
   * title's icon, which iconPictures hides and draws. Every other group is hidden by hiddenLines.
   */
  icon: boolean
}

export interface HeadingTail {
  lineFrom: number
  lineTo: number
  /**
   * The end of the title's visible text, before EVERY trailing group: where the caret rests
   * instead of in or after the groups. ONE space is kept after the text when the groups are
   * written after several (so a space typed at the end of a title is not taken back).
   */
  textEnd: number
  groups: readonly TailGroup[]
}

/** The tail of a heading line; null for a line that is not a heading or has no trailing groups. */
export function headingTail(lineFrom: number, text: string): HeadingTail | null {
  const mark = headingLine(text)
  if (!mark) return null
  const groups: TailGroup[] = headingBraceGroups(text)
    .filter((g) => g.start >= mark.textFrom)
    .map((g) => ({ from: lineFrom + g.start, to: lineFrom + g.end, icon: g.authored && groupHoldsIcon(g.inner) }))
  if (!groups.length) return null
  // Walk back over the whitespace before the first group; the last of those spaces is kept out of
  // reach with the groups (it is what separates the text from the tokens).
  const first = groups[0].from - lineFrom
  let before = first
  while (before > mark.textFrom && /\s/.test(text[before - 1])) before -= 1
  return { lineFrom, lineTo: lineFrom + text.length, textEnd: lineFrom + (before < first ? first - 1 : first), groups }
}
