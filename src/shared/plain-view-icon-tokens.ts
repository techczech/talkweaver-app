// The Plain view's reading of the icon tokens on a heading line and at the end of a paragraph
// (spec T14). Pure: no DOM, no CodeMirror.
//
// The compiler decides what an icon token is; this file must read every line the same way:
//   heading    compiler/scripts/lib/02-triggers-layout.mjs  headingBraceGroups, headingIconGroups
//   paragraph  compiler/scripts/lib/03-markdown-lexer.mjs   paragraphIconTokenAt
// The tokens INSIDE a group are split by the compiler's own tokeniser (trigger-tokenizer.mjs,
// imported, not copied), so a quoted value that contains `icon=` is one token of another key.
// The two functions that find the groups are ports (their modules pull in the icon sets and the
// trigger dictionary, which the editor does not load); scripts/test-plain-view-icon-token-parity.mjs
// runs one list of lines through both readers and asserts the same key and the same spans.
import { tokenizeTriggerBody } from '../../compiler/scripts/lib/trigger-tokenizer.mjs'

export interface BraceGroup {
  /** Offset of `{` in the line. */
  start: number
  /** Offset after `}`. */
  end: number
  inner: string
  /** Reached from whitespace (or the start), directly or through the groups written right before it. */
  authored: boolean
}

/**
 * The trailing `{…}` groups of a heading line, as the compiler peels them (right to left, each
 * group from the first `{` after the previous `}`). A group written straight after a text
 * character (the tail of a URL, an escaped `\{`) is not authored.
 */
export function headingBraceGroups(line: string): BraceGroup[] {
  let end = line.trimEnd().length
  const groups: BraceGroup[] = []
  while (end > 0 && line[end - 1] === '}') {
    const prevClose = end >= 2 ? line.lastIndexOf('}', end - 2) : -1
    const start = line.indexOf('{', prevClose + 1)
    if (start < 0 || start >= end) break
    groups.unshift({ start, end, inner: line.slice(start + 1, end - 1), authored: false })
    end = start
    while (end > 0 && /\s/.test(line[end - 1])) end -= 1
  }
  groups.forEach((group, index) => {
    const spaced = group.start === 0 || /\s/.test(line[group.start - 1])
    group.authored = spaced || (index > 0 && groups[index - 1].end === group.start && groups[index - 1].authored)
  })
  return groups
}

/** The `icon=VALUE` tokens of one group's body, as the compiler's tokeniser reads them. */
function iconTokens(inner: string): Array<{ raw: string }> {
  return tokenizeTriggerBody(inner).filter((token) => token.raw.startsWith('icon='))
}

/** Whether a group's body holds an `icon=` token (a quoted value that merely contains the text does not). */
export function groupHoldsIcon(inner: string): boolean {
  return iconTokens(inner).length > 0
}

export interface HeadingIcon {
  /** The value of the last `icon=` token in an authored group, as written; null when none or empty. */
  key: string | null
  /** Every authored group that holds an `icon=` token, in line order. */
  groups: Array<{ start: number; end: number }>
}

/** A heading line's own icon: the compiler's headingIconGroups. */
export function headingIcon(line: string): HeadingIcon {
  const groups: Array<{ start: number; end: number }> = []
  let key: string | null = null
  for (const group of headingBraceGroups(line)) {
    if (!group.authored) continue
    const tokens = iconTokens(group.inner)
    if (!tokens.length) continue
    groups.push({ start: group.start, end: group.end })
    key = tokens[tokens.length - 1].raw.slice(5).trim() || null
  }
  return { key, groups }
}

export interface ParagraphIconToken {
  /** Start of the whitespace before the token. */
  from: number
  /** Offset of `{`. */
  tokenFrom: number
  /** Offset after `}`. */
  tokenTo: number
  /** NAME as written. */
  key: string
}

/**
 * The `{icon=NAME}` that ends a paragraph's text: the compiler's paragraphIconTokenAt. It is the
 * brace group that ends the text (only whitespace after it) and follows whitespace or is the whole
 * text; a group written straight after a text character is text.
 */
export function paragraphIconToken(text: string): ParagraphIconToken | null {
  const m = text.match(/\{\s*icon\s*=\s*([^}]+?)\s*\}\s*$/i)
  if (!m || m.index == null) return null
  const tokenFrom = m.index
  if (tokenFrom > 0 && !/\s/.test(text[tokenFrom - 1])) return null
  let from = tokenFrom
  while (from > 0 && /\s/.test(text[from - 1])) from -= 1
  const keyFrom = text.indexOf(m[1], text.indexOf('=', tokenFrom) + 1)
  return { from, tokenFrom, tokenTo: text.indexOf('}', keyFrom + m[1].length) + 1, key: m[1] }
}
