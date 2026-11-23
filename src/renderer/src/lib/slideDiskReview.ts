import { readOutlineSlides } from '../../../shared/feedback-accept.ts'
import { normalizeOutlineMergeText, resolveOutlineMerge } from '../../../shared/outline-merge.ts'
import type { OutlineMergeReview } from './outlineReconcile.ts'

export interface SlideDiskReview {
  id: string
  title: string
  before: string
  after: string
  proposedOutline: string
}

function parts(text: string) {
  const { slides, lines } = readOutlineSlides(normalizeOutlineMergeText(text))
  const head = lines.slice(0, slides[0]?.start ?? lines.length).join('\n')
  return { head, slides: slides.map(slide => ({
    id: slide.id, folded: slide.folded,
    title: lines[slide.start].replace(/^#{1,6}\s+/, '').replace(/\s*(?:\{[^}]+\}\s*)+$/, ''),
    text: lines.slice(slide.start, slide.end).join('\n')
  })) }
}

/** Prove the external edit replaces the contents of one existing audience-visible slide. */
export function singleSlideDiskReview(review: OutlineMergeReview): SlideDiskReview | null {
  if (review.merge.conflicts.length > 0) return null
  const base = parts(review.base)
  const disk = parts(review.disk)
  if (base.head !== disk.head || base.slides.length !== disk.slides.length) return null
  if (base.slides.some((slide, index) => slide.id !== disk.slides[index].id)) return null
  const edits = disk.slides.filter((slide, index) => slide.text !== base.slides[index].text)
  if (edits.length !== 1 || !edits[0].id || edits[0].folded) return null
  const id = edits[0].id
  const proposedOutline = resolveOutlineMerge(review.merge, {})
  if (proposedOutline == null) return null
  const before = parts(review.mine).slides.filter(slide => slide.id === id)
  const after = parts(proposedOutline).slides.filter(slide => slide.id === id)
  if (before.length !== 1 || after.length !== 1 || before[0].folded || after[0].folded) return null
  return { id, title: before[0].title, before: before[0].text, after: after[0].text, proposedOutline }
}
