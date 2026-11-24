// SK4. Produce one new outline from the reviewed cuts. Sketch bytes never pass to an outline writer.
import { readSlides } from './insert-section.ts'
import { mintSlideId, planScratchSlides, type ScratchPlace } from './scratchpad-insert.ts'
import { createSection } from './talk-structure.ts'
import { reviewSlides, slideLines, undecidedLines, type SketchReview } from './sketch-review.ts'
import type { SketchSlide } from './sketch-breakdown.ts'

export interface SketchProposal { title: string; markdown: string; sketchProposalKey: string }

const idTokens = /\{id=([A-Za-z0-9_-]+)\}/g
// Sketch language is prose. Only the tokens authored by this operation become TalkWeaver codes.
const authoredText = (text: string): string => text.trim()
  .replace(/\{(?=[^{}\n]*\})/g, '&#123;')
  .replace(/<!--/g, '&lt;!--')
  .replace(/^:::/, '&#58;::')

function slideBlock(slide: SketchSlide, id: string): string {
  const pictures = slide.pictures.map(({ text, ref }) => {
    if (ref) return `![](<${ref.replace(/[<>]/g, encodeURIComponent)}>)`
    const placeholder = /^\[picture:\s*([^\]]+)\]$/i.exec(text)
    return placeholder ? `![](<${placeholder[1].trim().replace(/[<>]/g, encodeURIComponent)}>)` : authoredText(text)
  })
  const points = slide.points.flatMap(point => [
    `- ${authoredText(point.text)}`,
    ...point.details.map(detail => `  - ${authoredText(detail.text)}`),
  ])
  const notes = slide.notes.length ? ['', ':::notes', ...slide.notes.map(line => authoredText(line.text)), ':::'] : []
  return [`### ${authoredText(slide.title)}`, `{id=${id}}`, '', ...points, ...pictures, ...notes].join('\n')
}

function sectionBlock(title: string, id: string): string {
  // Use the same section creation rule as the toolbar. Build on an empty fragment so
  // the section won't take over slides from the destination talk.
  const section = createSection('', { kind: 'section', after: null, id })
  if (!section.ok) throw new Error(section.error)
  return section.text.replace(/^##  \{id=/m, () => `## ${authoredText(title)} {id=`)
}

export function planSketchApply(text: string, place: ScratchPlace, review: SketchReview):
  { ok: true; text: string; ids: string[]; firstSlide: string | null; count: number; proposals: SketchProposal[] } |
  { ok: false; error: string } {
  if (undecidedLines(review).length) return { ok: false, error: 'Decide where the marked lines go before adding slides.' }
  const slides = reviewSlides(review)
  if (slides.some(slide => !slide.title.trim())) return { ok: false, error: 'Give each slide a title.' }
  if (slides.length + review.sections.length > 5000) return { ok: false, error: 'This sketch makes too many slides. Choose a shorter breakdown.' }
  const used = new Set([...text.matchAll(idTokens)].map(match => match[1]))
  const fresh = () => { const id = mintSlideId(used); used.add(id); return id }
  const proposals: SketchProposal[] = []
  const proposalOccurrences = new Map<string, number>()
  const ids: string[] = []
  const bySection = new Map<number, string[]>()
  let firstSlide: string | null = null
  for (const slide of slides) {
    const id = fresh()
    const block = slideBlock(slide, id)
    if (slide.aside) {
      const lines = [...new Set(slideLines(slide))].sort((a, b) => a - b).join(',')
      const occurrence = (proposalOccurrences.get(lines) ?? 0) + 1
      proposalOccurrences.set(lines, occurrence)
      proposals.push({ title: slide.title.trim(), markdown: block, sketchProposalKey: `${lines}:${occurrence}` })
      continue
    }
    firstSlide ??= id
    ids.push(id)
    const blocks = bySection.get(slide.section) ?? []
    blocks.push(block)
    bySection.set(slide.section, blocks)
  }
  const blocks = [...(bySection.get(0) ?? [])]
  let addsSections = false
  for (const section of review.sections) {
    const sectionSlides = bySection.get(section.key)
    if (!sectionSlides) continue
    addsSections = true
    const id = fresh()
    ids.push(id)
    blocks.push([sectionBlock(section.text, id), ...sectionSlides].join('\n\n'))
  }
  if (!blocks.length) return proposals.length
    ? { ok: true, text, ids, firstSlide, count: 0, proposals }
    : { ok: false, error: 'Choose at least one slide to add or keep in the Scratchpad.' }
  const result = planScratchSlides(text, place, blocks, { placement: addsSections ? 'section-boundary' : 'slide' })
  if (!result.ok) return result
  // Verify what the compiler read. Any hidden heading or structural capture is a refusal, never a partial edit.
  const inserted = new Set(ids)
  const before = readSlides(text)
  const after = readSlides(result.text)
  const original = after.slides.filter(slide => !inserted.has(slide.id))
  const present = new Set(after.slides.map(slide => slide.id))
  if (ids.some(id => !present.has(id)) || before.slides.length !== original.length ||
      before.slides.some((slide, index) => {
        const next = original[index]
        return slide.id !== next.id || slide.title !== next.title || slide.level !== next.level ||
          slide.content !== next.content || slide.notes !== next.notes || slide.attrs !== next.attrs ||
          slide.ancestors.some((parent, i) => before.slides[parent]?.id !== after.slides[next.ancestors[i]]?.id) ||
          slide.ancestors.length !== next.ancestors.length
      })) return { ok: false, error: 'The cuts would change existing slides. Nothing was added.' }
  return { ok: true, text: result.text, ids, firstSlide, count: slides.length - proposals.length, proposals }
}
