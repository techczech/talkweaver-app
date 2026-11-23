import type { SketchBreakdown, SketchSlide } from './sketch-breakdown.ts'

export type LineFate = 'notes' | 'slide' | 'sketch'
export type SketchReview = SketchBreakdown & { fates: Partial<Record<number, LineFate>> }

export const slideLines = (slide: SketchSlide): number[] => [
  ...slide.titleLines, ...slide.notes.map(x => x.line), ...slide.pictures.map(x => x.line),
  ...slide.points.flatMap(x => [x.line, ...x.details.map(y => y.line)]),
]

function firstLine(slide: SketchSlide): number {
  let first = Infinity
  for (const line of slideLines(slide)) first = Math.min(first, line)
  return first
}

export function precedingSlide(review: SketchReview, line: number, section: number): SketchSlide | undefined {
  return [...review.slides].reverse().find(slide => slide.section === section && firstLine(slide) < line)
}

export function reviewSlides(review: SketchReview): SketchSlide[] {
  const slides = review.slides.map(slide => ({ ...slide, notes: [...slide.notes] }))
  const byKey = new Map(slides.map(slide => [slide.key, slide]))
  for (const line of review.undecided) {
    const fate = review.fates[line.line]
    if (fate === 'notes') {
      const target = precedingSlide(review, line.line, line.section)
      if (target) byKey.get(target.key)?.notes.push(line)
    } else if (fate === 'slide') {
      slides.push({ key: -line.line, section: line.section, title: line.text, titleLines: [line.line], points: [], notes: [], pictures: [], aside: false })
    }
  }
  return slides.map(slide => ({ slide, first: firstLine(slide) })).sort((a, b) => a.first - b.first).map(x => x.slide)
}

export function undecidedLines(review: SketchReview): number[] {
  return review.undecided.filter(line => !review.fates[line.line] ||
    (review.fates[line.line] === 'notes' && !precedingSlide(review, line.line, line.section))).map(line => line.line)
}

export function joinSketchSlide(review: SketchReview, at: number): SketchReview {
  const slide = review.slides[at]
  const previous = review.slides[at - 1]
  if (!slide || !previous || previous.section !== slide.section || previous.aside !== slide.aside) return review
  // Preserve the joined title as a point when it came from the sketch.
  const joinedTitle = slide.titleLines.length || slide.title !== previous.title
    ? [{ line: slide.titleLines[0] ?? 0, text: slide.title, details: [] }]
    : []
  const joined = { ...previous, titleLines: [...previous.titleLines, ...slide.titleLines],
    points: [...previous.points, ...joinedTitle, ...slide.points], notes: [...previous.notes, ...slide.notes],
    pictures: [...previous.pictures, ...slide.pictures] }
  const slides = [...review.slides]
  slides.splice(at - 1, 2, joined)
  return { ...review, slides }
}

export function splitSketchSlide(review: SketchReview, at: number): SketchReview {
  const slide = review.slides[at]
  if (!slide || slide.points.length < 2) return review
  let key = review.slides.reduce((max, candidate) => Math.max(max, candidate.key), 0)
  const parts = slide.points.map((point, index): SketchSlide => {
    if (index === 0 && slide.titleLines.length) return { ...slide, points: [point] }
    return {
      ...slide, key: index === 0 ? slide.key : ++key, title: point.text, titleLines: [point.line],
      points: point.details.map(detail => ({ ...detail, details: [] })),
      notes: index === 0 ? slide.notes : [], pictures: index === 0 ? slide.pictures : [],
    }
  })
  const slides = [...review.slides]
  slides.splice(at, 1, ...parts)
  return { ...review, slides }
}
