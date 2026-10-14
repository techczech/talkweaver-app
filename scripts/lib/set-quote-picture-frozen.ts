// `setQuotePicture` (src/shared/layout-verbs.ts) as it stood at 054ae093, before the fourth review round of quote
// forms ticket 10 made it read the slide's body as the compiler does. Kept so the test can state: on a slide with
// no Trigger line among its content, the verb returns what it returned then, byte for byte
// (scripts/test-quote-forms-address-under-quote.mjs, section E).
//
// `quoteBodyLines` and the body of the function are copied as they were. `locate` and `requireQuoteSlide` are
// module-private there, so the parts of them this function reads are restated below from exported pieces: the
// slide, the end of its Trigger block, its line ending and its authored layout. Not for use outside the test.
import { winningAuthoredLayout } from '../../src/shared/layout-registry/vocabulary.ts'
import { readOutlineSlides, type OutlineSlide, type OutlineSlides } from '../../src/shared/feedback-accept.ts'
import { logicalTriggerBlockAfterHeading } from '../../src/shared/trigger-line.ts'
import { LayoutVerbError, type SlideRef } from '../../src/shared/layout-verbs.ts'
import { readQuoteSlideLines } from '../../compiler/scripts/lib/quote-forms.mjs'

interface Located { read: OutlineSlides; slide: OutlineSlide; blockEnd: number; oldLine: string; eol: string }

function locate(outline: string, ref: SlideRef): Located {
  const read = readOutlineSlides(outline)
  const slide = typeof ref === 'string'
    ? read.slides.find((candidate) => candidate.id === ref)
    : read.slides.find((candidate) => candidate.line === ref.headingLine)
  if (!slide) throw new LayoutVerbError('slide-not-found', 'slide not found')
  const block = logicalTriggerBlockAfterHeading(read.lines, slide.start)
  const eol = /\r$/.test(read.lines[slide.start] ?? '') ? '\r' : ''
  return { read, slide, blockEnd: block?.end ?? -1, oldLine: block?.line ?? '', eol }
}

function requireQuoteSlide(at: Located, compiledLayout?: string): void {
  const layout = winningAuthoredLayout(at.oldLine)?.layout ?? compiledLayout ?? null
  if (layout !== 'quote') throw new LayoutVerbError('option-not-applicable', 'the slide is not a quote slide')
}

const NO_BREAK = /[\r\n]/

/** The slide's lines after its Trigger block, as written but for comments and speaker notes (blank). */
function quoteBodyLines(at: Located): string[] {
  const from = at.blockEnd >= 0 ? at.blockEnd : at.slide.start + 1
  const lines: string[] = []
  for (let index = from; index < at.slide.end; index += 1) lines.push(at.read.notes.has(index) ? '' : (at.read.blanked[index] ?? ''))
  return lines
}

const IMAGE_MARKUP = /!\[[^\]]*\]\([^)]*\)/

/** Write the quote slide's picture line (spec 11 `set-quote-picture`): `path` adds the line before the
 *  quotation, or replaces the path of the first image line (its alt text is kept unless `alt` is given);
 *  `null` removes the picture. The picture decides between the player and the left panel (spec 2.5). */
export function setQuotePictureFrozen(outline: string, slide: SlideRef, path: string | null, alt?: string, compiledLayout?: string): { outline: string } {
  const at = locate(outline, slide)
  requireQuoteSlide(at, compiledLayout)
  for (const value of [path, alt]) {
    if (value != null && NO_BREAK.test(value)) throw new LayoutVerbError('bad-option-token', 'a picture line is one line')
  }
  if (path != null && (!path.trim() || path.includes(')'))) throw new LayoutVerbError('bad-option-token', 'a picture path is not empty and has no ")"')
  const cleanAlt = alt == null ? null : alt.replace(/[\[\]]/g, '').trim()
  const from = at.blockEnd >= 0 ? at.blockEnd : at.slide.start + 1
  // The picture is the first image line as written: a Trigger line among the content is never one and hides none.
  const body = readQuoteSlideLines(quoteBodyLines(at))
  const lines = [...at.read.lines]
  const eol = at.eol
  if (body.picture && body.pictureIndex >= 0) {
    const index = from + body.pictureIndex
    const old = lines[index].replace(/\r$/, '')
    const existing = IMAGE_MARKUP.exec(old)?.[0] ?? ''
    if (path == null) {
      const rest = old.replace(IMAGE_MARKUP, '').trim()
      if (rest) lines[index] = `${rest}${eol}`
      else {
        lines.splice(index, 1)
        // The blank line that separated the picture from what follows goes with it.
        if (index < lines.length && lines[index].trim() === '' && (index === 0 || lines[index - 1].trim() === '')) lines.splice(index, 1)
      }
    } else {
      const keptAlt = cleanAlt ?? (/^!\[([^\]]*)\]/.exec(existing)?.[1] ?? '')
      lines[index] = `${old.replace(IMAGE_MARKUP, `![${keptAlt}](${path.trim()})`)}${eol}`
    }
    return { outline: lines.join('\n') }
  }
  if (path == null) return { outline }
  const line = `![${cleanAlt ?? ''}](${path.trim()})${eol}`
  const content = quoteBodyLines(at).findIndex((text) => text.trim() !== '')
  if (content >= 0) lines.splice(from + content, 0, line, eol)
  else lines.splice(at.slide.end, 0, line)
  return { outline: lines.join('\n') }
}
