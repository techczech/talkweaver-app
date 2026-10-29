// The two writes that create or close a speaker-notes block (design §4.5, review F1 and F5 of
// 2026-10-28): "Insert speaker notes" and "Add closing :::". Both the editor commands and the notes agent
// verbs plan through here, and neither guesses where a block ends: each proposes the new text, then
// asks the compiler's own tree parse (parseOutlineTree over outlineCompilerBody, exactly what
// adaptMarkdownOutlineV2 reads) whether every line of the block is a notes line in it, and whether any
// line that was private before would become slide content. A proposal that fails either test is refused;
// nothing is written. An unfinished code block is never closed for the author.
// Pure: no DOM, no CodeMirror.
import { parseOutlineTree } from '../../../compiler/scripts/lib/14-outline-tree.mjs'
import { outlineCompilerBody } from '../slide-source-text.ts'
import { readOutlineObjectRegions, type OutlineObjectRegions } from './outline-object-regions.ts'
import { notesBodyRefusal } from './notes-body.ts'

const HEADING_RE = /^#{1,6}\s/

/** The 0-based lines the compiler reads as notes (markers included). */
export function compilerNotesLines(text: string): Set<number> {
  return new Set(parseOutlineTree(outlineCompilerBody(text).body).notesLineIndexes)
}

export type NotesPlan =
  | { ok: true; text: string; from: number; to: number; insert: string; start: number; close: number }
  | { ok: false; code: 'not-found' | 'refused' | 'exists'; message: string; open?: number }

const lineOf = (regions: OutlineObjectRegions, text: string, line: number): string =>
  text.slice(regions.lineStarts[line], regions.lineStarts[line + 1] - 1)

function isHeadingLine(regions: OutlineObjectRegions, text: string, line: number): boolean {
  return regions.kinds[line] === 'outline' && !regions.inFence[line] && HEADING_RE.test(lineOf(regions, text, line))
}

/** The slide the 0-based `line` lies in: its heading line and the line its next heading is on. */
export function slideAround(text: string, line: number, regions = readOutlineObjectRegions(text)): { heading: number; end: number } | null {
  let heading = -1
  for (let i = Math.min(line, regions.kinds.length - 1); i >= regions.frontmatterLines; i -= 1) {
    if (isHeadingLine(regions, text, i)) { heading = i; break }
  }
  if (heading < 0) return null
  let end = regions.kinds.length
  for (let i = heading + 1; i < regions.kinds.length; i += 1) {
    if (isHeadingLine(regions, text, i)) { end = i; break }
  }
  return { heading, end }
}

/**
 * The proposal holds when the compiler reads lines start..close of `next` as notes, and every line that
 * was a notes line in `before` (shifted by `shift` lines from `at` on) is still one.
 */
function holdsPrivate(before: string, next: string, start: number, close: number, at: number, shift: number): boolean {
  const regions = readOutlineObjectRegions(next)
  if (!regions.notes.some((n) => n.closed && n.start === start && n.close === close)) return false
  const after = compilerNotesLines(next)
  for (let i = start; i <= close; i += 1) if (!after.has(i)) return false
  for (const i of compilerNotesLines(before)) if (!after.has(i >= at ? i + shift : i)) return false
  return true
}

/**
 * Insert speaker notes after the last text line of the slide the 0-based `line` is in. Refused when the
 * slide already has notes (`exists`, `open` = the first block's line, for the editor to open it), when
 * the body would break the block, and when the compiler would not read the new block as private notes
 * (the slide ends inside an unfinished code block, for one).
 */
export function planNotesInsert(text: string, line: number, body = ''): NotesPlan {
  const regions = readOutlineObjectRegions(text)
  const slide = slideAround(text, line, regions)
  if (!slide) return { ok: false, code: 'not-found', message: 'Put the caret on a slide to add its speaker notes.' }
  const inSlide = regions.notes.filter((n) => n.start > slide.heading && n.start < slide.end)
  if (inSlide.length) {
    return {
      ok: false,
      code: 'exists',
      open: inSlide[0].start,
      message: inSlide.some((n) => !n.closed)
        ? 'This slide’s speaker notes are not closed. Use “Add closing :::” on the warning first.'
        : 'This slide already has speaker notes.'
    }
  }
  const refusal = notesBodyRefusal(body)
  if (refusal) return { ok: false, code: 'refused', message: `Not written: ${refusal}.` }
  let last = slide.end - 1
  while (last > slide.heading && lineOf(regions, text, last).trim() === '') last -= 1
  const raw = lineOf(regions, text, last)
  const eol = raw.endsWith('\r') ? '\r\n' : '\n'
  const at = regions.lineStarts[last] + raw.replace(/\r$/, '').length
  const bodyLines = body.split(/\r?\n/)
  // Inserted before the last line's own ending, which then ends the `:::` line.
  const insert = `${eol}${eol}:::notes${eol}${bodyLines.join(eol)}${eol}:::`
  const next = text.slice(0, at) + insert + text.slice(at)
  const start = last + 2
  const close = start + bodyLines.length + 1
  if (!holdsPrivate(text, next, start, close, last + 1, close - last)) {
    const openFence = regions.fences.find((f) => !f.closed && f.start > slide.heading && f.start <= last)
    return {
      ok: false,
      code: 'refused',
      message: openFence
        ? 'Not written: the slide ends inside a code block that is not closed, so the notes would show on the slide. Close the code block first.'
        : 'Not written: the slide would not read these lines as speaker notes.'
    }
  }
  return { ok: true, text: next, from: at, to: at, insert, start, close }
}

/**
 * Close the unclosed notes block that opens on the 0-based line `start`: a `:::` line after its last
 * line. Refused when the compiler would not read the result as one closed notes block that keeps every
 * private line private (an unfinished code block inside the notes, for one).
 */
export function planNotesClose(text: string, start: number): NotesPlan {
  const regions = readOutlineObjectRegions(text)
  const notes = regions.notes.find((n) => n.start === start && !n.closed)
  if (!notes) return { ok: false, code: 'not-found', message: 'These notes are already closed or were changed.' }
  // The line ending of the notes' last written line (a trailing empty line has none of its own).
  let probe = notes.end - 1
  while (probe > start && lineOf(regions, text, probe) === '') probe -= 1
  const eol = lineOf(regions, text, probe).endsWith('\r') ? '\r\n' : '\n'
  let at: number
  let insert: string
  let close: number
  if (notes.end < regions.kinds.length) {
    // Ended by a heading: the closer goes on its own line before it, and everything after moves down one.
    at = regions.lineStarts[notes.end]
    insert = `:::${eol}`
    close = notes.end
  } else if (text.endsWith('\n')) {
    // Runs to the end of a text that ends with a line ending: the closer fills the last, empty line.
    at = text.length
    insert = ':::'
    close = notes.end - 1
  } else {
    at = text.length
    insert = `${eol}:::`
    close = notes.end
  }
  const next = text.slice(0, at) + insert + text.slice(at)
  if (!holdsPrivate(text, next, start, close, notes.end, 1)) {
    const fence = regions.fences.find((f) => !f.closed && f.start > start && f.start < notes.end)
    return {
      ok: false,
      code: 'refused',
      message: fence
        ? 'Not closed: these notes contain a code block that is not closed, so a closing ::: would be read as code. Close the code block inside the notes first.'
        : 'Not closed: the slide would not read the result as closed speaker notes. Edit the source to close them.'
    }
  }
  return { ok: true, text: next, from: at, to: at, insert, start, close }
}
