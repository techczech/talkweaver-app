// The link-edit rule over a whole outline as it was written first (quote forms, ticket 07): every matched slide is asked
// through the exported one-slide rule, `setFormOnLinkEdit`, which reads both outlines again each time. It is the
// reference `setFormOnLinkEdits` must agree with on every pair (scripts/test-quote-link-form-edits-equivalence.mjs);
// nothing in the app uses it, because its cost is slides × talk (17 s on an 800-slide talk).
//
// Slides WITH an id are handled as when the reference was frozen. Slides with NO id are not: the frozen loop named
// them by the id '' (never reaching the heading line), issue 139 named them by heading line, and two reviews of that
// change (ticket 10) left one rule: a slide with no id is paired only when the edit changed nothing outside it. The
// rule is written out again here, slowly and by comparing the texts themselves (the fast loop compares two lengths
// it computed once), so the fast loop is still compared with a second writing of it; what it must never do is stated
// without either loop in scripts/test-quote-forms-address-under-quote.mjs.
import { setFormOnLinkEdit } from '../../src/shared/layout-verbs.ts'
import { readOutlineSlides } from '../../src/shared/feedback-accept.ts'

/** Where the slide's lines lie in the text they were read from: [start of its heading line, end of its last line). */
function span(read, slide, text) {
  const startOf = (line) => (line >= read.lines.length ? text.length : read.lines.slice(0, line).join('\n').length + (line > 0 ? 1 : 0))
  return [startOf(slide.start), startOf(slide.end)]
}

const ownLines = (read, slide) => read.lines.slice(slide.start, slide.end).join('\n').replace(/[\r\n]+$/, '')

export function setFormOnLinkEditsSlow(before, after, compiledLayoutAt) {
  const readAfter = readOutlineSlides(after)
  const readBefore = readOutlineSlides(before)
  let text = after
  let formSet = null
  for (const slide of [...readAfter.slides].reverse()) {
    let slideBefore = null
    if (slide.id) slideBefore = readBefore.slides.some((candidate) => candidate.id === slide.id) ? slide.id : null
    else {
      // No id: the text before the slide and the text after it are, character for character, the text before and
      // after one slide of `before` that has no id either. Any other case is not certain, and nothing is written.
      const [start, end] = span(readAfter, slide, after)
      const head = after.slice(0, start)
      const tail = after.slice(end)
      if (before.length >= head.length + tail.length && before.slice(0, start) === head && before.slice(before.length - tail.length) === tail) {
        const was = readBefore.slides.find((candidate) => {
          const [from, to] = span(readBefore, candidate, before)
          return from === start && to === before.length - tail.length
        })
        if (was && !was.id && readBefore.slides.find((candidate) => candidate.line === was.line) === was) slideBefore = { headingLine: was.line }
      }
    }
    if (!slideBefore) continue
    const layout = compiledLayoutAt?.(slide.line)
    // No id, and its lines are those of a slide with no id in `before`: a copy put in another slide's place, not an edit.
    if (!slide.id && readBefore.slides.some((candidate) => !candidate.id && ownLines(readBefore, candidate) === ownLines(readAfter, slide))) continue
    const ref = slide.id || { headingLine: slide.line }
    const written = setFormOnLinkEdit(before, text, ref, layout, slideBefore)
    if (written.set) { text = written.outline; formSet = written.form }
  }
  return { outline: text, set: formSet != null, form: formSet }
}
