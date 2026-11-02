// Why a speaker-notes body cannot be written back as it is (design §4.3), or null when it can. The same
// rules as the reader (`:::notes` … `:::`, a heading ends notes, a fence hides its lines): one line of
// `:::`, a heading line, an unfinished fence or an unclosed `<!--` would end or swallow the block.
// Shared by the notes card editor and the notes agent verbs. Pure.
import {
  isMarkdownFenceClosingLine,
  parseMarkdownFenceOpeningLine
} from '../../../compiler/scripts/lib/03-object-token.mjs'
import { closedHtmlComments } from '../../../compiler/scripts/lib/outline-regions.mjs'

export function notesBodyRefusal(inner: string): string | null {
  const lines = inner.split('\n').map((line) => line.replace(/\r$/, ''))
  if (lines.some((line) => line.trim() === ':::')) return 'a line with only ::: would end the notes. Put a word on it or remove it'
  if (lines.some((line) => /^(#{2,6})\s+(.+)/.test(line))) return 'a line starting with ## would start a new slide. Put text before the #, or remove it'
  if (lines.some((line) => /^#\s+(.+)/.test(line))) return "a line starting with # sets the talk's title, even inside notes"
  let fence: ReturnType<typeof parseMarkdownFenceOpeningLine> = null
  for (const line of lines) {
    if (fence) { if (isMarkdownFenceClosingLine(line, fence)) fence = null; continue }
    fence = parseMarkdownFenceOpeningLine(line)
  }
  if (fence) return 'an unfinished code block would hide the closing :::. Close the code block'
  const lastClose = closedHtmlComments(inner).at(-1)?.to ?? 0
  if (inner.indexOf('<!--', lastClose) >= 0) return 'a <!-- without --> would run past the notes. Close it inside the notes'
  return null
}
