// Reuse of an old slide (ticket 12). Two pure pieces, text in and text out, no I/O:
//
//   oldSlideMarkdown(record, assets)       one old slide record -> one TalkWeaver slide as Markdown. It does
//                                           not convert on its own: it builds the importer's one-slide
//                                           source and hands it to the PowerPoint import's own rules
//                                           (main/importer/mapping.ts classifySlide + effectiveSlideMarkdown),
//                                           so a slide imported from a .pptx and a slide reused from the
//                                           archive come out the same way.
//   insertSlideAfterCaret({ text, caret, slide })
//                                           the talk's new text with the slide added after the slide the
//                                           caret is in, as that slide's sibling, and nothing else changed.
//
// What the record holds is what the read-only archive registry can give (ADR-0026): the slide's title,
// its text as lines, its notes when there are any, the pictures that sit on it and the picture of the
// whole slide. It has no layout, no bullet depth and no position of shapes, so the conversion works from
// order and the importer's rules only.

import type { ImportPictureShape, ImportSlideSource, ImportTextShape } from './importer.ts'
import { classifySlide, effectiveSlideMarkdown, markdownText } from '../main/importer/mapping.ts'
import { readOutline, readSlides } from './insert-section.ts'
import { isBareUrl } from '../../compiler/scripts/lib/02-triggers-layout.mjs'

/** One picture on an old slide. `key` is stable within the record; `thumbUrl` is what importImage takes. */
export type OldSlideImage = { key: string; thumbUrl: string; name?: string }

export type OldSlideRecord = {
  title: string
  /** The slide's text, one entry per line, title excluded when the source repeats it. */
  paragraphs: string[]
  notes?: string
  images: OldSlideImage[]
  /** 1-based position in its presentation, 0 when unknown. */
  slideNumber: number
  presentationTitle?: string
}

// --- Archive text as literal text (fix round 1) ---------------------------------------------------
//
// The text comes from the read-only archive and must stay text: it may not start a slide, a code block,
// notes or a comment, and it may not hand the slide an id or a layout. The compiler has NO escape
// character (renderInline and parseOutlineTree never look for a backslash), so "escaping" here means
// changing the one thing each rule tests. What each rule tests, read from the compiler:
//
//   line breaks        the parser splits on \n; every other break (\r, \v, \f, U+0085, U+2028/9) is made a
//                      real line here, so no rule can see a "line" this module did not literalise
//   headings, `#`      /^#{1,6}\s/ at the start of a line                    -> the importer's `\#`
//   backtick fence     /^`{3,}/ on the trimmed line                          -> the importer's `` \` ``
//   tilde fence        /^~{3,}/ on the trimmed line                          -> a leading `\`
//   :::notes, :::      the trimmed line equals the marker                    -> a leading `\`
//   --- (frontmatter)  "\n---" closes a frontmatter left open at the top     -> a leading `\`
//   Trigger line, {…}  the line starts with `{` (TRIGGER_LINE_RE, the id window) -> the importer's `\{`
//   {id=…} anywhere    /\{id=[A-Za-z0-9_-]+\}/ on the heading and its Trigger lines -> `\}` breaks the token
//   trailing {…}       parseHeadingAttrs and the list reader's icon token peel a `{…}` group off the END
//                      of a heading or bullet; a backslash inside the group does not stop them, only a
//                      line that does not end in `}` does                    -> a closing `\` after it
//   <!-- comment       the substring `<!--` anywhere (`\<!--` still holds it) -> `<\!--`
//   [Embed:], [Video:], [QR:], [Action:], ![…](…)   the trimmed line starts with it -> a leading `\`
//   [scale:], [categories:]   a poll directive (poll-authoring pollDirectivesFor): the line makes the slide
//                      an audience poll                                    -> a leading `\`
//   a web address alone  a paragraph that is wholly one http(s) address becomes a live embedded page (the
//                      lexer's auto-embed, isBareUrl); asked of the line as it will be written, with the
//                      compiler's own isBareUrl                              -> a leading `\`, the address stays
//   > quote, | table, **Timeline:**                 the importer's `\>`, `\|`, `\*`
//
// The backslashes are visible on the slide (the compiler prints them); they are there to be deleted by
// hand once the text is where it should be. insertSlideAfterCaret checks the result whatever this did.

const LINE_BREAK = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/
// C0 controls except tab (the breaks above are split on first), DEL and the C1 block.
const CONTROL = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g
const LINE_START = /^(?:~{3,}|:::|---|!\[|\[(?:Action|Embed|Simulation|Video|QR):|\[(?:scale|categories)\s*:)/i

/** Text that sits inside a line (a title): the importer's escapes, no comment opener, no trailing group. */
function literalInline(text: string): string {
  let out = markdownText(text.replace(CONTROL, '').replace(/\s+/g, ' ').trim()).replace(/<!--/g, '<\\!--')
  if (out.endsWith('}')) out += '\\'
  return out
}

/** Text that is a whole line (a paragraph, a bullet, a line of the notes). */
function literalLine(text: string): string {
  const out = literalInline(text)
  return LINE_START.test(out) || isBareUrl(out) ? '\\' + out : out
}

/** A picture's name as alt text: one line, nothing that ends the `![…]` or opens a group or a comment. */
function literalAlt(text: string): string {
  return text.replace(CONTROL, '').replace(/[[\]{}<>`\\]/g, ' ').replace(/\s+/g, ' ').trim()
}

/** The title on one line (an archive title may carry a line break). */
const titleOf = (record: Pick<OldSlideRecord, 'title'>): string => record.title.split(LINE_BREAK).join(' ').replace(/\s+/g, ' ').trim()

const clean = (lines: readonly string[]): string[] => lines.flatMap((l) => l.split(LINE_BREAK)).map((l) => l.trim()).filter(Boolean)

/** The record's text lines without a first line that only repeats the title. */
export function bodyLinesOf(record: Pick<OldSlideRecord, 'title' | 'paragraphs'>): string[] {
  const lines = clean(record.paragraphs)
  const title = titleOf(record).toLowerCase()
  const raw = record.title.trim().toLowerCase()
  return lines.length > 0 && (lines[0].toLowerCase() === title || lines[0].toLowerCase() === raw) ? lines.slice(1) : lines
}

/** Can an editable slide be built? It needs text or pictures besides the title. */
export function canBuildEditable(record: OldSlideRecord): boolean {
  return bodyLinesOf(record).length > 0 || record.images.length > 0
}

/** The importer's one-slide source for a record. Pictures are keyed by `image.key`. The body text is
 *  handed over already literal (`markdownParagraphs`), and the notes are left out: oldSlideMarkdown
 *  writes them itself, line by line, because the importer copies notes in as they are. */
export function oldSlideSource(record: OldSlideRecord): ImportSlideSource {
  const body = bodyLinesOf(record)
  const titleText = titleOf(record)
  const shapes: ImportSlideSource['shapes'] = []
  const title: ImportTextShape = {
    kind: 'text', id: 'title', name: 'Title', placeholder: 'title', paragraphs: [titleText], geometry: null, zIndex: 0, hyperlinks: []
  }
  shapes.push(title)
  if (body.length > 0) {
    shapes.push({
      kind: 'text', id: 'body', name: 'Text', placeholder: null, paragraphs: body, markdownParagraphs: body.map(literalLine),
      geometry: null, zIndex: 1, hyperlinks: []
    })
  }
  record.images.forEach((image, i) => {
    // Always a name: without one the importer uses the slide's title as the alt text, unescaped.
    const name = literalAlt(image.name ?? '') || literalAlt(titleText) || 'Picture'
    const picture: ImportPictureShape = {
      kind: 'picture', id: `picture-${i + 1}`, name, placeholder: null, mediaPath: image.key,
      mediaName: name, geometry: null, zIndex: 2 + i, hyperlinks: []
    }
    shapes.push(picture)
  })
  return {
    slideNumber: Math.max(1, record.slideNumber), hidden: false, title: titleText, paragraphs: body,
    notes: '', shapes, warnings: []
  }
}

/** The record's notes as a `:::notes` block of literal lines, or '' with none. */
function notesBlockOf(record: OldSlideRecord): string {
  const lines = (record.notes ?? '').split(LINE_BREAK).map((l) => (l.trim() ? literalLine(l) : ''))
  while (lines.length && !lines[0]) lines.shift()
  while (lines.length && !lines[lines.length - 1]) lines.pop()
  return lines.length ? `\n\n:::notes\n${lines.join('\n')}\n:::` : ''
}

/**
 * The record as one TalkWeaver slide (heading `###`, a layout token when the rules choose one, the text
 * and the pictures). `assets` maps an image key to the reference the talk now holds for it (the
 * `img-<hash>` id importImage returned); a picture without an entry is left out. The slide carries no
 * `{id=…}`: the talk mints its own, so the same old slide can go in twice without clashing.
 */
export function oldSlideMarkdown(record: OldSlideRecord, assets: Record<string, string>): string {
  const source = oldSlideSource(record)
  const decision = classifySlide(source, {
    sourceHash: 'old-slide',
    originalAsset: () => '',
    mediaAssets: assets
  })
  const markdown = effectiveSlideMarkdown({ ...decision, representation: 'candidate', manualOverride: undefined })
  const kept = markdown.split('\n')
  // Line 1 is the heading: written here, because the importer's own escaping leaves a trailing `{…}`
  // readable as the slide's attributes. Line 2 is the importer's Trigger line: its id comes off.
  if (source.title) kept[0] = `### ${literalInline(source.title)}`
  if (kept.length > 1) kept[1] = kept[1].replace(/^\{id=[^}]+\}\s*/, '')
  return (kept.join('\n').trim() + notesBlockOf(record)).replace(/\n{3,}/g, '\n\n').trim()
}

/** Why an editable insert was refused when the new slide would not read as one slide of its own. One
 *  plain sentence; the picture is the way that always works. */
export const OLD_SLIDE_REFUSED = 'This slide’s text would change other slides in the talk if it went in as an editable slide, so use Picture of the slide instead.'

export type InsertAfterResult =
  | { ok: true; text: string; from: number; to: number; level: number; line: number }
  | { ok: false; error: string }

/**
 * Adds `slide` after the slide the caret is in, as that slide's sibling: the same heading level, placed
 * after the slide's text and notes AND after every slide under it (before the next heading at its level
 * or shallower, or the end), so no existing slide ends up under the new one. The exception is a section
 * heading in a talk that has slides under its sections: there the new slide becomes the first slide
 * inside the section, at the level of the slide that was first (one level down in an empty section). A
 * caret above the first slide puts it before the first slide; a talk with no slides takes it at the end.
 * Nothing else in the text changes, and no existing slide changes parents (checked on the result).
 */
export function insertSlideAfterCaret(input: { text: string; caret: number; slide: string }): InsertAfterResult {
  const { text } = input
  if (!Number.isInteger(input.caret) || input.caret < 0 || input.caret > text.length) {
    return { ok: false, error: 'The caret is not in the talk. Nothing was inserted.' }
  }
  const slideLines = input.slide.split(/\r?\n/)
  while (slideLines.length && /^\s*$/.test(slideLines[0])) slideLines.shift()
  while (slideLines.length && /^\s*$/.test(slideLines[slideLines.length - 1])) slideLines.pop()
  if (slideLines.length === 0 || !/^#{2,6}\s/.test(slideLines[0])) {
    return { ok: false, error: 'The slide does not start with a heading. Nothing was inserted.' }
  }
  const read = readOutline(text)
  if (read.openFence || read.openComment) {
    return { ok: false, error: 'The talk has a code fence or comment that is never closed, so the slide could not be placed safely. Nothing was inserted.' }
  }
  const lines = text.split('\n')
  const { levels, bodyStart } = read
  let caretLine = 0
  for (let i = 0, off = 0; i < lines.length; i += 1) {
    if (off > input.caret) break
    caretLine = i
    off += lines[i].length + 1
  }

  let owner = -1
  for (let i = Math.min(caretLine, lines.length - 1); i >= bodyStart; i -= 1) {
    if (levels[i] >= 2) { owner = i; break }
  }
  let sectionLevel = 7
  let deepest = 0
  for (let i = bodyStart; i < levels.length; i += 1) {
    if (levels[i] >= 2) { sectionLevel = Math.min(sectionLevel, levels[i]); deepest = Math.max(deepest, levels[i]) }
  }

  // Where the new slide's lines go: `at` is a line index, lines before it stay, lines from it follow.
  let at: number
  let level: number
  if (owner >= 0) {
    const ownerLevel = levels[owner]
    // The slide's own text and notes end at the next heading or `#` title line.
    let own = owner + 1
    while (own < lines.length && levels[own] === 0) own += 1
    const firstUnder = own < lines.length && levels[own] > ownerLevel ? levels[own] : 0
    let end: number
    if (ownerLevel === sectionLevel && deepest > sectionLevel) {
      // A section heading: the new slide is the section's first slide. It takes the level of the slide
      // that was first (so that slide stays the section's own), one level down when the section is empty.
      end = own
      level = firstUnder || Math.min(ownerLevel + 1, 6)
    } else {
      // Any other slide: after it and every slide under it, before the next heading at its level or
      // shallower, so no slide under it is taken by the new one. `#` title lines closing it stay after.
      end = own
      while (end < lines.length && !(levels[end] >= 2 && levels[end] <= ownerLevel)) end += 1
      while (end > owner + 1 && (levels[end - 1] === 1 || /^\s*$/.test(lines[end - 1]))) end -= 1
      level = ownerLevel
    }
    while (end > owner + 1 && /^\s*$/.test(lines[end - 1])) end -= 1
    at = end
  } else {
    let first = -1
    for (let i = bodyStart; i < lines.length; i += 1) if (levels[i] >= 2) { first = i; break }
    at = first >= 0 ? first : lines.length
    level = first >= 0 ? levels[first] : 3
    while (first < 0 && at > bodyStart && /^\s*$/.test(lines[at - 1])) at -= 1
  }

  slideLines[0] = slideLines[0].replace(/^#+/, '#'.repeat(level))
  const before = lines.slice(0, at).join('\n')
  const after = lines.slice(at).join('\n')
  const lead = before.length > 0 ? before + '\n\n' : ''
  const block = slideLines.join('\n')
  const tail = after.length === 0 ? '\n' : after.startsWith('\n') ? '\n' + after : '\n\n' + after
  const out = lead + block + tail
  const from = lead.length
  const line = out.slice(0, from).split('\n').length
  if (!insertedAsOneSlide(text, out, line - 1, slideLines.length, level)) return { ok: false, error: OLD_SLIDE_REFUSED }
  return { ok: true, text: out, from, to: from + block.length, level, line }
}

/**
 * The check on the result, by the compiler's own parser (parseOutlineTree through readOutline and
 * readSlides): `after` is `before` plus exactly one slide. True only when
 *   - the block's lines `first`..`first + count - 1` hold one heading, on the first line, at `level`,
 *     and no `#` title line;
 *   - that slide has no id, on its heading or its Trigger lines;
 *   - neither the block on its own nor the whole result ends inside a code fence or an HTML comment;
 *   - every slide read from `before` is read from `after` too, in the same order, with the same level,
 *     title, id, attributes, content and notes, on the line it should now be on, and the talk's `#`
 *     title and the text above the first slide read the same;
 *   - every slide read from `before` has the same chain of parents in `after`: the same slides, in the
 *     same order, and never the new one (a flat list of slides reads the same when a slide has moved
 *     under the new slide, so the chains are compared as well).
 * Exported for its test.
 */
export function insertedAsOneSlide(before: string, after: string, first: number, count: number, level: number): boolean {
  const afterLines = after.split('\n')
  const block = readOutline(afterLines.slice(first, first + count).join('\n'))
  if (block.openFence || block.openComment) return false
  const reading = readOutline(after)
  if (reading.openFence || reading.openComment) return false
  for (let i = first; i < first + count; i += 1) {
    if (reading.levels[i] !== (i === first ? level : 0)) return false
  }
  const was = readSlides(before)
  const now = readSlides(after)
  if (was.deckTitle !== now.deckTitle || was.preamble !== now.preamble) return false
  const added = now.slides.filter((s) => s.line >= first && s.line < first + count)
  if (added.length !== 1 || added[0].line !== first || added[0].level !== level) return false
  if (added[0].id !== '' || Object.prototype.hasOwnProperty.call(JSON.parse(added[0].attrs), 'id')) return false
  const rest = now.slides.filter((s) => s !== added[0])
  if (rest.length !== was.slides.length) return false
  const shift = afterLines.length - before.split('\n').length
  // A slide's position in `now` as its position in `was`; the new slide has none (-1).
  const addedAt = now.slides.indexOf(added[0])
  const wasIndex = (i: number): number => (i === addedAt ? -1 : i < addedAt ? i : i - 1)
  return was.slides.every((s, i) => {
    const t = rest[i]
    const chain = t.ancestors.map(wasIndex)
    if (chain.length !== s.ancestors.length || chain.some((a, k) => a !== s.ancestors[k])) return false
    return t.level === s.level && t.title === s.title && t.id === s.id && t.attrs === s.attrs && t.content === s.content &&
      t.notes === s.notes && t.line === (t.line < first ? s.line : s.line + shift)
  })
}
