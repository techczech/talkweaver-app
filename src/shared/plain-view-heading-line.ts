// Plain view, ticket 07 (seventh fix round): the ONE answer to "is this line a heading, at which
// level, and where does its text start". Every plain-view rule reads it: the hidden-text structure
// pass and End (hiddenLines.ts), the tail (headingTail.ts), the Enter rule (guardKeys.ts), the icon
// reader (iconPictures.ts), the margin (margin.ts, plain-view-margin.ts) and the placeholders.
//
// It is the compiler's recognition (compiler/scripts/lib/14-outline-tree.mjs: `^#\s+(.+)` for the
// talk title, `^(#{2,6})\s+(.+)` for the others, on the line as written):
//   - one to six `#` at the very start of the line; a line that starts with a space is not a
//     heading, and neither is one with seven `#`;
//   - then whitespace of any kind and any length: a space, several, a tab;
//   - trailing `#` are part of the text, not a closing mark.
// One difference, on purpose: marks and whitespace with nothing after them (`## `) are a heading
// here, with `empty` set. It is a title being typed (a slide just made, with its layout line
// already under it), and the app treats it as a heading in both modes. The compiler reads such a
// line as a heading only when two or more whitespace characters follow the marks. Marks alone
// (`##`, no whitespace) are a heading for neither.
// The test is scripts/test-plain-view-guarded-keys.mjs (the parity table at its end).

export interface HeadingLine {
  /** The number of `#` marks, 1 to 6. */
  level: number
  /** The offset in the line where its text starts: after the marks and all the whitespace that follows them. */
  textFrom: number
  /** Nothing but whitespace after the marks. */
  empty: boolean
}

const HEADING_LINE_RE = /^(#{1,6})(\s+)/

export function headingLine(text: string): HeadingLine | null {
  const m = text.match(HEADING_LINE_RE)
  if (!m) return null
  const textFrom = m[0].length
  return { level: m[1].length, textFrom, empty: textFrom >= text.length }
}

/** The same question as a matcher (`test`), for code that takes a RegExp (outliner.ts enterFromHeading). */
export const anyHeadingLine: { test(text: string): boolean } = { test: (text) => headingLine(text) !== null }
