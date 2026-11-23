// SK2 (ADR-0045). Keep source coordinates so review can account for every non-blank line.
export type BreakdownKind = 'main' | 'section' | 'idea' | 'paragraph' | 'sentence' | 'one' | 'marked'
export interface SketchLine { number: number; raw: string }
export interface SketchText { line: number; text: string }
export interface SketchPicture extends SketchText { ref?: string }
export interface SketchPoint extends SketchText { details: SketchText[] }
export interface SketchSection extends SketchText { key: number }
export interface SketchSlide {
  key: number
  section: number
  title: string
  titleLines: number[]
  points: SketchPoint[]
  notes: SketchText[]
  pictures: SketchPicture[]
  aside: boolean
}
export interface UndecidedLine extends SketchText { section: number; reason?: 'missing-picture' }
export interface SketchBreakdown {
  kind: BreakdownKind
  lines: SketchLine[]
  sections: SketchSection[]
  slides: SketchSlide[]
  undecided: UndecidedLine[]
}

export const BREAKDOWNS: Record<BreakdownKind, { label: string; description: string }> = {
  main: { label: 'By main point', description: 'A point with details gets a slide. Short points that sit together share one.' },
  section: { label: 'One slide per section', description: 'Fewest slides. Details stay as small notes under each point.' },
  idea: { label: 'One idea per slide', description: 'Most slides. A point without details becomes a single large sentence.' },
  paragraph: { label: 'One slide per paragraph', description: 'Each paragraph becomes one large sentence on its own slide.' },
  sentence: { label: 'One slide per sentence', description: 'Most slides. Good for a talk you read aloud.' },
  one: { label: 'One slide', description: 'The first line is the title and the rest are its points. Edit it afterwards.' },
  marked: { label: 'As marked', description: 'Read ## as a section and ### as the start of a slide.' },
}

const BULLET = /^([ \t]*)(?:[-*+•–]|\d+[.)])[ \t]+(.+)$/
const HEADING = /^(#{1,6})[ \t]+(.+)$/
const PICTURE = /^!\[[^\]]*\]\(.+\)$|^\[picture:\s*[^\]]+\]$/i
const textOf = (line: SketchLine): SketchText => ({ line: line.number, text: line.raw.trim() })

function sourceLines(text: string): SketchLine[] {
  return text.split(/\r\n?|\n/).flatMap((raw, index) => raw.trim() ? [{ number: index + 1, raw }] : [])
}

export function breakdownChoices(text: string): BreakdownKind[] {
  const lines = sourceLines(text)
  const choices: BreakdownKind[] = lines.some(line => BULLET.test(line.raw)) ? ['main', 'section', 'idea'] : ['paragraph', 'sentence', 'one']
  if (lines.some(line => /^#{2,3}[ \t]+\S/.test(line.raw.trim()))) choices.push('marked')
  return choices
}

function plainHeading(line: SketchLine, next: SketchLine | undefined): boolean {
  const text = line.raw.trim()
  if (PICTURE.test(text) || BULLET.test(line.raw)) return false
  return Boolean(next && BULLET.test(next.raw)) || (!/[.!?]$/.test(text) && text.split(/\s+/).length <= 6)
}

function pointOf(part: SketchText): SketchPoint {
  return { ...part, details: [] }
}

export function sketchPictureReferences(text: string): string[] {
  return sourceLines(text).map(line => line.raw.trim()).filter(line => PICTURE.test(line))
}

export function planSketch(text: string, kind: BreakdownKind, knownPictures?: ReadonlyMap<string, string>): SketchBreakdown {
  const plan: SketchBreakdown = { kind, lines: sourceLines(text), sections: [], slides: [], undecided: [] }
  let section = 0
  let key = 0
  const add = (title: string, titleLines: number[], points: SketchPoint[] = []): SketchSlide => {
    const slide = { key: ++key, section, title, titleLines, points, notes: [], pictures: [], aside: false }
    plan.slides.push(slide)
    return slide
  }
  const heading = (line: number, title: string) => {
    section = line
    plan.sections.push({ key: section, line, text: title })
  }
  const undecided = (line: SketchLine) => plan.undecided.push({ ...textOf(line), section })
  const pictureOf = (part: SketchText): SketchPicture | null => {
    if (!knownPictures) return part
    const ref = knownPictures.get(part.text)
    if (ref) return { ...part, ref }
    plan.undecided.push({ ...part, section, reason: 'missing-picture' })
    return null
  }

  if (kind === 'marked') {
    let current: SketchSlide | undefined
    for (const line of plan.lines) {
      const part = textOf(line)
      const mark = HEADING.exec(part.text)
      if (mark?.[1] === '##') { heading(part.line, mark[2]); current = undefined }
      else if (mark?.[1] === '###') current = add(mark[2], [part.line])
      else if (PICTURE.test(part.text)) {
        const picture = pictureOf(part)
        if (picture && current) current.pictures.push(picture)
        else if (picture) undecided(line)
      } else if (!current) undecided(line)
      else {
        const bullet = BULLET.exec(line.raw)
        const point = { line: part.line, text: bullet?.[2] ?? part.text }
        const prior = current.points.at(-1)
        if (bullet?.[1] && prior) prior.details.push(point)
        else current.points.push(pointOf(point))
      }
    }
    return plan
  }

  if (kind === 'one' || kind === 'paragraph' || kind === 'sentence') {
    const lines = plan.lines.map(textOf)
    if (kind === 'one') {
      const words = lines.filter(line => !PICTURE.test(line.text))
      const pictures = lines.filter(line => PICTURE.test(line.text)).map(pictureOf).filter(picture => picture !== null)
      if (words.length) add(words[0].text, [words[0].line], words.slice(1).map(pointOf)).pictures = pictures
      else plan.undecided.push(...pictures.map(picture => ({ ...picture, section })))
      return plan
    }
    const segmenter = kind === 'sentence' ? new Intl.Segmenter(undefined, { granularity: 'sentence' }) : null
    let paragraph: SketchText[] = []
    const flush = () => {
      const text = paragraph.map(line => line.text).join(' ')
      if (text && segmenter) {
        let cursor = 0
        const offsets = paragraph.map(line => {
          const start = cursor
          cursor += line.text.length + 1
          return { line: line.line, start, end: cursor - 1 }
        })
        let first = 0
        for (const sentence of segmenter.segment(text)) {
          while (offsets[first] && offsets[first].end <= sentence.index) first++
          const lines: number[] = []
          const end = sentence.index + sentence.segment.trimEnd().length
          for (let i = first; offsets[i] && offsets[i].start < end; i++) lines.push(offsets[i].line)
          add(sentence.segment.trim(), lines)
        }
      } else if (text) add(text, paragraph.map(line => line.line))
      paragraph = []
    }
    for (const line of lines) {
      if (PICTURE.test(line.text)) {
        flush()
        if (pictureOf(line)) plan.undecided.push({ ...line, section })
      } else {
        const mark = HEADING.exec(line.text)
        if (mark?.[1] === '##') { flush(); heading(line.line, mark[2]); continue }
        if (paragraph.length && paragraph.at(-1)!.line + 1 !== line.line) flush()
        paragraph.push(line)
      }
    }
    flush()
    return plan
  }

  let points: SketchPoint[] = []
  let pictures: SketchPicture[] = []
  let title = ''
  const flush = () => {
    if (kind === 'section' && points.length) add(title || points[0].text, [], points)
    else if (kind === 'idea') {
      for (const point of points) add(point.text, [point.line], point.details.map(pointOf))
    } else {
      let short: SketchPoint[] = []
      const run = () => { if (short.length) add(title || 'Points', [], short); short = [] }
      for (const point of points) {
        if (point.details.length) { run(); add(point.text, [point.line], point.details.map(pointOf)) }
        else short.push(point)
      }
      run()
    }
    for (const picture of pictures) {
      const first = (slide: SketchSlide) => slide.titleLines[0] ?? slide.points[0]?.line ?? 0
      const own = plan.slides.filter(slide => slide.section === section)
      const target = [...own].reverse().find(slide => first(slide) < picture.line) ?? own[0]
      if (target) target.pictures.push(picture)
      else plan.undecided.push({ ...picture, section })
    }
    points = []
    pictures = []
  }
  plan.lines.forEach((line, index) => {
    const part = textOf(line)
    const bullet = BULLET.exec(line.raw)
    const mark = HEADING.exec(part.text)
    if (bullet) {
      const point = { line: part.line, text: bullet[2] }
      const previous = points.at(-1)
      if (bullet[1] && previous) previous.details.push(point)
      else points.push(pointOf(point))
    } else if (PICTURE.test(part.text)) {
      const picture = pictureOf(part)
      if (picture) pictures.push(picture)
    } else if (mark || plainHeading(line, plan.lines[index + 1])) {
      flush()
      title = mark?.[2] ?? part.text
      heading(part.line, title)
    } else undecided(line)
  })
  flush()
  return plan
}
