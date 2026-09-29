// Insert section (ADR-0029 §5; talk search ticket 07; frames K4, K6, K7) — the pure, typed headless
// operation behind the picker's "Insert section · N slides" button, and the verb an agent will call
// (content-verb law, estate ADR-0019). Two functions, text in and text out, no I/O:
//
//   extractSection(sourceText, at)       the section whose heading is at `at`: the heading slide and
//                                         every slide under it, in source order, byte for byte.
//   insertSection({ text, caret, section }) the talk's new text with the section inserted as a sibling
//                                         of the caret's section, re-levelled, and the inserted range.
//
// Structure is read exactly as the compiler reads it (readOutline, below): the frontmatter and every
// closed HTML comment are blanked the way adaptMarkdownOutlineV2 (compiler 08-source-adapters.mjs)
// blanks them, and the compiler's own parser, parseOutlineTree (14-outline-tree.mjs), decides which
// lines are headings. So a heading-shaped line inside a code fence (backticks or tildes, a close at
// least as long as its opener) or a closed `<!-- … -->` comment is not a heading, and a `##`–`######`
// line inside `:::notes` IS one (the compiler ends the notes there and starts a slide). Trigger
// lines, notes and blank lines are ordinary lines of their slide and travel with it untouched.
//
// `#` lines (decided 2026-09-28): the compiler reads every `#` line as the deck title and never makes
// it a slide, so a `#` line is never a section, never a section boundary, and never re-levelled to or
// from. A section carrying one is refused (inserted, it would retitle the talk).
//
// Placement (K6, K7): the caret's section is the section-level heading at or above the caret, through
// the line before the next `##`–`######` heading at that level or shallower; when `#` lines close it
// (a "# Thanks" after its last slide) it ends before the first of them, so they stay last. With
// nothing but blank space between the caret and that end, the section goes in at the caret; otherwise
// it goes in at the end of the caret's section, so no section is split. Above the first section it
// goes in before the first section; in a talk with no sections, at the end. An extracted section
// leaves its trailing blank and `#` lines behind.
//
// Section level: the shallowest `##`–`######` heading level in the talk's body; a talk with none takes
// `##`, the level the picker's sections have.
//
// Re-levelling (K6): the inserted heading takes the section level and every heading inside keeps its
// depth relative to it. A section too deep to keep its depth (a heading would need seven #s) is refused
// with a message, never clamped.
//
// Refusals that keep the rest of the talk intact: a section whose code fence or HTML comment is still
// open at its end (it would swallow the talk after it), and — checked on the result — any insert after
// which the talk's own headings would no longer read as they did.

import { parseOutlineTree, type OutlineTreeNode } from '../../compiler/scripts/lib/14-outline-tree.mjs'
import { reLevelHeadingLines } from './heading-relevel.ts'

/** Where the section's heading is in its talk: the 1-based line the picker's index saw it on, and the
 *  heading line's exact text (so a talk edited since it was indexed is still read correctly). */
export interface SectionLocation {
  line: number
  heading: string
}

export type SectionExtract =
  | { ok: true; markdown: string; level: number; slides: number; line: number }
  | { ok: false; error: string }

export interface InsertSectionInput {
  /** The talk's whole text (the editor's buffer). */
  text: string
  /** The caret's offset in `text`. */
  caret: number
  /** The section's Markdown, heading line first (extractSection's `markdown`). */
  section: string
}

export type InsertSectionResult =
  | {
      ok: true
      /** The talk's new text: `text` with one insertion and nothing else changed. */
      text: string
      /** The inserted section's range in the new text (the section itself, without the blank lines
       *  added around it). */
      from: number
      to: number
      /** The heading level the section arrived at. */
      level: number
      /** 1-based line of the inserted section heading in the new text. */
      line: number
    }
  | { ok: false; error: string }

/** How the compiler reads a talk's lines (see the header). */
export interface OutlineReading {
  /** One per line of `text.split('\n')`: 0 not a heading, 1 a `#` deck-title line, 2–6 a slide heading. */
  levels: number[]
  /** 0-based index of the first line after the frontmatter (0 with none). */
  bodyStart: number
  /** A code fence is still open at the end of the text. */
  openFence: boolean
  /** A `<!--` with no `-->` after it is left (the compiler hides nothing for it, and a later `-->`
   *  anywhere would pair with it). */
  openComment: boolean
}

// The compiler's deck-title rule (14-outline-tree.mjs): `#`, whitespace, text, and not `##`.
const TITLE_RE = /^#\s+(.+)/
// A level-6 heading stand-in: parseOutlineTree records no line for a `#` title, so each title-shaped
// line is handed to it as this and it reports, through the node's sourceLine, which of them it read
// as structure (a fenced one it keeps as code). The stand-in is not a fence marker, a `:::` marker or
// a Trigger line, so it changes nothing else the parser decides; the parser's heading rule does not
// depend on the `:::notes` state or on a heading's Trigger line.
const STAND_IN = '###### title'

/** The compiler's reading of `text`'s structure: which lines are headings, at what level. */
export function readOutline(text: string): OutlineReading {
  const src = String(text ?? '')
  // Frontmatter and closed HTML comments blanked in place, newlines kept (adaptMarkdownOutlineV2).
  let body = src
  let bodyStart = 0
  if (src.startsWith('---')) {
    const end = src.indexOf('\n---', 3)
    if (end >= 0) {
      const fmEnd = end + 4
      body = src.slice(0, fmEnd).replace(/[^\n]/g, '') + src.slice(fmEnd)
      bodyStart = src.slice(0, end + 1).split('\n').length
    }
  }
  body = body.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ''))
  const openComment = body.includes('<!--')

  const lines = body.split('\n')
  const titleAt = new Set<number>()
  const probe = lines.map((line, i) => {
    const t = line.replace(/\r$/, '')
    if (TITLE_RE.test(t) && !t.startsWith('##')) { titleAt.add(i); return STAND_IN }
    return line
  })
  // One more stand-in after the last line: the parser reads it as a heading unless a fence is open.
  probe.push(STAND_IN)
  const levels = new Array<number>(lines.length + 1).fill(0)
  const walk = (node: OutlineTreeNode): void => {
    for (const child of node.children) {
      const i = child.sourceLine - 1
      levels[i] = titleAt.has(i) ? 1 : child.level
      walk(child)
    }
  }
  walk(parseOutlineTree(probe.join('\n')).root)
  const openFence = levels[lines.length] === 0
  levels.length = lines.length
  return { levels, bodyStart, openFence, openComment }
}

const isBlank = (line: string): boolean => /^\s*$/.test(line)
const isSlideHeading = (level: number): boolean => level >= 2

/** The exclusive end line of the section whose heading is at `start` (level `level`): the next
 *  `##`–`######` heading at that level or shallower, or the end of the text. */
function sectionEnd(levels: readonly number[], start: number, level: number): number {
  for (let j = start + 1; j < levels.length; j += 1) {
    if (isSlideHeading(levels[j]) && levels[j] <= level) return j
  }
  return levels.length
}

/** `end` moved back over the blank and `#` lines that close a section (they are no slide's). */
function contentEnd(lines: readonly string[], levels: readonly number[], start: number, end: number): number {
  while (end > start + 1 && (isBlank(lines[end - 1]) || levels[end - 1] === 1)) end -= 1
  return end
}

/** The talk's section level from its reading: the shallowest `##`–`######` level in the body, else 2. */
function levelOfReading({ levels, bodyStart }: OutlineReading): number {
  let min = 7
  for (let i = bodyStart; i < levels.length; i += 1) if (isSlideHeading(levels[i]) && levels[i] < min) min = levels[i]
  return min === 7 ? 2 : min
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
const titleOf = (heading: string): string => heading.replace(/^#+\s*/, '').replace(/\s+$/, '')

/** The section headed at `at` in `sourceText`: its heading slide and every slide under it, trailing
 *  blank and `#` lines dropped; `slides` counts its headings (every heading is a slide). */
export function extractSection(sourceText: string, at: SectionLocation): SectionExtract {
  const lines = sourceText.split('\n')
  const { levels, bodyStart } = readOutline(sourceText)
  const want = at.heading.replace(/\s+$/, '')
  const title = titleOf(want)
  const isTheHeading = (i: number): boolean =>
    i >= bodyStart && i < lines.length && isSlideHeading(levels[i]) && lines[i].replace(/\s+$/, '') === want
  let start = at.line - 1
  if (!isTheHeading(start)) {
    const found: number[] = []
    for (let i = bodyStart; i < lines.length; i += 1) if (isTheHeading(i)) found.push(i)
    if (found.length !== 1) {
      const isTitle = found.length === 0 && lines.some((l, i) => levels[i] === 1 && l.replace(/\s+$/, '') === want)
      return {
        ok: false,
        error: isTitle
          ? `“${title}” is its talk’s title line (a single #), not a section. Nothing was inserted.`
          : found.length === 0
            ? `The section “${title}” is no longer in its talk as the picker saw it. Nothing was inserted; reopen the picker and try again.`
            : `The talk has more than one section headed “${title}”, and it has changed since the picker read it. Nothing was inserted; reopen the picker and try again.`,
      }
    }
    start = found[0]
  }
  const level = levels[start]
  const end = contentEnd(lines, levels, start, sectionEnd(levels, start, level))
  let slides = 0
  for (let i = start; i < end; i += 1) if (isSlideHeading(levels[i])) slides += 1
  return { ok: true, markdown: lines.slice(start, end).join('\n'), level, slides, line: start + 1 }
}

/** The talk's section level (see the header): the shallowest `##`–`######` level in its body, else 2. */
export function sectionLevelOf(text: string): number {
  return levelOfReading(readOutline(text))
}

/** Every heading of a reading, in order, as level + line text (a `\r` ending dropped). */
function headingsOf(lines: readonly string[], levels: readonly number[], from = 0, to = lines.length): string[] {
  const out: string[] = []
  for (let i = from; i < to; i += 1) if (levels[i] > 0) out.push(`${levels[i]}:${lines[i].replace(/\r$/, '')}`)
  return out
}

/** Inserts `section` into `text` as a sibling of the caret's section (see the header). */
export function insertSection(input: InsertSectionInput): InsertSectionResult {
  const { text, section } = input
  if (!Number.isInteger(input.caret) || input.caret < 0 || input.caret > text.length) {
    return { ok: false, error: 'The caret is not in the talk. Nothing was inserted.' }
  }
  const caret = input.caret

  // The section: its lines (line endings as the editor holds them) without surrounding blank lines,
  // its heading first, read on its own.
  const sLines = section.split(/\r?\n/)
  while (sLines.length > 0 && isBlank(sLines[0])) sLines.shift()
  while (sLines.length > 0 && isBlank(sLines[sLines.length - 1])) sLines.pop()
  const sRead = readOutline(sLines.join('\n'))
  const srcLevel = sLines.length > 0 ? sRead.levels[0] : 0
  if (srcLevel === 0) return { ok: false, error: 'The section does not start with a heading. Nothing was inserted.' }
  const name = titleOf(sLines[0])
  if (srcLevel === 1) {
    return { ok: false, error: `“${name}” is a talk title line (a single #), not a section: a # line is the deck title, never a slide. Nothing was inserted.` }
  }
  const titleLine = sRead.levels.indexOf(1)
  if (titleLine >= 0) {
    return { ok: false, error: `The section “${name}” has a talk title line in it (“${sLines[titleLine].trim()}”); inserted, it would change this talk’s title. Nothing was inserted.` }
  }
  if (sRead.openFence) {
    return { ok: false, error: `The section “${name}” ends inside a code fence that is never closed, so inserted it would turn the rest of this talk into code. Nothing was inserted; close the fence in its talk first.` }
  }
  if (sRead.openComment) {
    return { ok: false, error: `The section “${name}” has an HTML comment (<!--) that is never closed, so inserted it would hide the rest of this talk. Nothing was inserted; close the comment in its talk first.` }
  }

  // The talk: its section level and the caret's section.
  const lines = text.split('\n')
  const read = readOutline(text)
  const { levels, bodyStart } = read
  const level = levelOfReading(read)
  const lineStart: number[] = []
  for (let i = 0, off = 0; i < lines.length; i += 1) { lineStart.push(off); off += lines[i].length + 1 }
  const offsetOfLine = (i: number): number => (i >= lines.length ? text.length : lineStart[i])
  let caretLine = 0
  while (caretLine + 1 < lines.length && lineStart[caretLine + 1] <= caret) caretLine += 1

  let owner = -1 // the caret's section heading
  for (let i = Math.min(caretLine, lines.length - 1); i >= bodyStart; i -= 1) {
    if (isSlideHeading(levels[i]) && levels[i] <= level) { owner = levels[i] === level ? i : -1; break }
  }
  let at: number
  if (owner >= 0) {
    // The section's end; when `#` lines close it (a "# Thanks" after the last slide), before the
    // first of them, so they stay after the inserted section.
    let endLine = sectionEnd(levels, owner, level)
    const tail = contentEnd(lines, levels, owner, endLine)
    for (let j = tail; j < endLine; j += 1) if (levels[j] === 1) { endLine = j; break }
    const end = offsetOfLine(endLine)
    at = caret <= end && /^\s*$/.test(text.slice(caret, end)) ? caret : end
  } else {
    let first = -1
    for (let i = Math.max(bodyStart, caretLine); i < lines.length; i += 1) {
      if (levels[i] === level) { first = i; break }
    }
    at = first >= 0 ? offsetOfLine(first) : text.length
  }

  // Re-level: the heading to the section level, depth inside kept. Only the compiler's headings move.
  const delta = level - srcLevel
  let min = 7, max = 0
  for (const l of sRead.levels) if (isSlideHeading(l)) { min = Math.min(min, l); max = Math.max(max, l) }
  if (max + delta > 6) {
    const deepest = max - min
    return {
      ok: false,
      error: `This section has headings ${plural(deepest, 'level')} below its own, so inserted at level ${level} (${'#'.repeat(level)}) its deepest slide would need ${'#'.repeat(max + delta)}, which Markdown does not have. Nothing was inserted; put the caret in a shallower section.`,
    }
  }
  if (min + delta < 2) {
    return { ok: false, error: `The section “${name}” has a heading shallower than its own, which inserted at level ${level} would become a talk title line (#). Nothing was inserted.` }
  }
  const block = reLevelHeadingLines(sLines, delta, sRead.levels.map((l) => !isSlideHeading(l))).join('\n')

  // One insertion, a blank line on each side, nothing else changed; a final newline stays final.
  const before = text.slice(0, at)
  const after = text.slice(at)
  const lead = before === '' || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n'
  const trail = after === '' ? (before.endsWith('\n') ? '\n' : '')
    : /^\s*$/.test(after) ? '' : after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n'
  const from = at + lead.length
  const next = before + lead + block + trail + after
  const line = next.slice(0, from).split('\n').length

  // The result must read as the talk's own headings with the section's spliced in, nothing else.
  let split = 0
  while (split < lines.length && lineStart[split] < at) split += 1
  const blockLines = block.split('\n')
  const expected = [
    ...headingsOf(lines, levels, 0, split),
    ...headingsOf(blockLines, sRead.levels.map((l) => (isSlideHeading(l) ? l + delta : l))),
    ...headingsOf(lines, levels, split),
  ]
  const nextLines = next.split('\n')
  const got = headingsOf(nextLines, readOutline(next).levels)
  if (got.length !== expected.length || got.some((h, i) => h !== expected[i])) {
    return { ok: false, error: `Inserted here, “${name}” would change how the rest of this talk reads (a code fence or HTML comment in the talk is open where it would go). Nothing was inserted.` }
  }
  return { ok: true, text: next, from, to: from + block.length, level, line }
}
