// ADR-0045, FR1 and PA1. These are source operations on one outline shared by all four views.
import { readOutlineObjectRegions } from './objects/outline-object-regions.ts'
import { blockAt, pasteSlides } from './slide-handling/slide-block-ops.ts'
import { slideAround } from './objects/notes-planner.ts'

export function newTalkSource(title: string, slideId: string | null): string {
  return ['---', 'title: ' + JSON.stringify(title), 'outline_version: 2', 'defaults:', '  title: top',
    '---', '', ...(slideId === null ? [] : [`### {id=${slideId}}`, '{list}', '', ''])].join('\n')
}

/** The authoring preview treats the identity, starting layout and an empty point as blank. */
export function isEmptyAuthoringSlide(source: string): boolean {
  return /^#{2,6}[ \t]+\{id=[^}\r\n]+\}\s*(?:\{list\}\s*)?(?:-[ \t]*)?$/u.test(source.trimEnd())
}

/** Add a row of pictures outside notes and fences, before the next heading. */
export function placePictures(
  text: string, line: number | null, newSlide: boolean, refs: readonly string[], newId: string
): string | null {
  return refs.length ? placeContent(text, line, newSlide ? 'Picture' : null, newSlide, refs.map(ref => '![](' + ref + ')'), newId) : null
}

export function placeBlankSlide(text: string, line: number | null, child: boolean, newId: string): string | null {
  return placeContent(text, line, '', child, ['{list}'], newId)
}

/** Finish the typed slide heading in place, preserving the body that follows it. */
export function completeBlankSlide(text: string, from: number, newId: string): string | null {
  const prefix = '### '
  if ((from !== 0 && text[from - 1] !== '\n') || !text.startsWith(prefix, from)) return null
  const end = from + prefix.length
  const tail = text.slice(end)
  if (tail && !/^\r?\n/.test(tail)) return null
  const eol = (tail ? tail.startsWith('\r\n') : text.includes('\r\n')) ? '\r\n' : '\n'
  // Leave a space for the title before the identity chip.
  return text.slice(0, end) + ` {id=${newId}}${eol}{list}` + (tail || eol)
}

function placeContent(text: string, line: number | null, title: string | null, child: boolean, body: readonly string[], newId: string): string | null {
  const regions = readOutlineObjectRegions(text)
  const lines = text.split('\n')
  const slide = line === null ? null : slideAround(text, line - 1, regions)
  if (line !== null && slide?.heading !== line - 1) return null
  const first = slide ? -1 : lines.findIndex((line, i) => regions.kinds[i] === 'outline' && !regions.inFence[i] && /^#{2,6}\s/.test(line))
  const start = slide?.heading ?? regions.frontmatterLines - 1
  const end = slide?.end ?? (first === -1 ? lines.length : first)
  const notes = regions.notes.find(block => block.start > start && block.start < end)
  const siblingEnd = title !== null && !child && line !== null ? blockAt(text, line)?.endLine : undefined
  const boundary = siblingEnd === undefined ? title === null && notes ? notes.start : end : siblingEnd - 1
  let at = boundary
  while (at > start + 1 && !lines[at - 1].trim()) at--
  if (regions.fences.some(fence => fence.start < at && fence.end >= at && !fence.closed)) return null
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const offset = Math.min(regions.lineStarts[at] ?? text.length, text.length)
  const level = slide ? lines[slide.heading].match(/^#+/)?.[0].length ?? 2 : 2
  const depth = slide && level >= 2 ? Math.min(6, level + Number(child)) : 3
  const heading = title === null ? '' : '#'.repeat(depth) +
    ` ${title ? title + ' ' : ''}{id=${newId}}`
  const markdown = [heading, ...(title && body.length ? [''] : []), ...body].filter((line, i) => line || i > 0).join(eol)
  const prefix = offset === 0 || /(?:\r?\n){2}$/.test(text.slice(0, offset)) ? ''
    : text[offset - 1] === '\n' ? eol : eol + eol
  const suffix = text.slice(offset)
  return text.slice(0, offset) + prefix + markdown + eol + (suffix.startsWith(eol) ? '' : eol) + suffix
}

/** The row's paths were minted by the import. Move only that unchanged row, leaving other text and notes in place. */
export function splitPictureRow(
  text: string, refs: readonly string[], keepFirstHere: boolean, mint: () => string
): string | null {
  if (refs.length < 2) return null
  const regions = readOutlineObjectRegions(text)
  const lines = text.split('\n')
  const pictureLines = refs.map(ref => '![](' + ref + ')')
  const matches = lines.flatMap((_, i) => pictureLines.every((line, offset) =>
    regions.kinds[i + offset] === 'outline' && lines[i + offset]?.replace(/\r$/, '') === line
  ) ? [i] : [])
  if (matches.length !== 1) return null
  const start = matches[0]
  const anchor = slideAround(text, start, regions)
  if (!anchor || start + refs.length > anchor.end) return null
  const level = lines[anchor.heading].match(/^#{2,6}(?=\s)/)?.[0]
  if (!level) return null
  const after = Math.min(text.length, regions.lineStarts[start + refs.length])
  const keep = Number(keepFirstHere)
  const stripped = text.slice(0, regions.lineStarts[start + keep]) + text.slice(after)
  const clip = pictureLines.slice(keep).map(line => `${level} Picture {id=${mint()}}\n\n${line}`).join('\n\n')
  return pasteSlides(stripped, clip, { after: anchor.heading + 1 }, mint)?.text ?? null
}
