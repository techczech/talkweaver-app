import type { LayoutDef } from './entries.ts'
import { readOutlineSlides } from '../feedback-accept.ts'

/** Authored examples keep their child groups and split at the next peer heading. */
export function layoutAuthoringExamples(entry: LayoutDef): string[] {
  const read = readOutlineSlides(entry.sample)
  const first = read.slides[0]
  if (!first) return [entry.sample.trim()]
  const peers = read.slides.filter((slide) => slide.level <= first.level)
  return peers.map((slide, index) => read.lines
    .slice(slide.start, peers[index + 1]?.start ?? read.lines.length).join('\n').trim())
}

export function layoutAuthoringExample(entry: LayoutDef): string {
  return layoutAuthoringExamples(entry)[0]
}
