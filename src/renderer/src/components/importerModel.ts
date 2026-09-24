import type { ImportSlideFilter, ImportSlideStatus } from '../../../shared/importer.ts'
import { isFlaggedImportStatus } from '../../../shared/importer.ts'

export interface ImporterSlideListItem {
  slideNumber: number
  title: string
  status: ImportSlideStatus
  warnings: string[]
}

export interface ImporterProjectionKey {
  slide_id?: string
  render_hash?: string
  content_hash?: string
}

export function mapThumbnailsBySlideId(
  rows: ImporterProjectionKey[],
  thumbnails: Record<string, string>
): Record<string, string> {
  const mapped: Record<string, string> = {}
  for (const row of rows) {
    const key = row.render_hash || row.content_hash || row.slide_id
    if (row.slide_id && key && thumbnails[key]) mapped[row.slide_id] = thumbnails[key]
  }
  return mapped
}

export function visibleSlides<T extends ImporterSlideListItem>(
  slides: T[],
  query: string,
  filter: ImportSlideFilter
): T[] {
  const needle = query.trim().toLocaleLowerCase()
  return slides.filter((slide) => {
    if (filter === 'flagged' && !isFlaggedImportStatus(slide.status)) return false
    if (filter === 'fallback' && slide.status !== 'fallback') return false
    if (filter === 'failed' && slide.status !== 'failed') return false
    if (!needle) return true
    return `${slide.slideNumber} ${slide.title} ${slide.warnings.join(' ')}`
      .toLocaleLowerCase()
      .includes(needle)
  })
}

export function moveSelection<T extends Pick<ImporterSlideListItem, 'slideNumber'>>(
  slides: T[],
  selectedSlideNumber: number | null,
  direction: -1 | 1
): number | null {
  if (slides.length === 0) return null
  const current = slides.findIndex((slide) => slide.slideNumber === selectedSlideNumber)
  if (current < 0) return slides[0].slideNumber
  const next = Math.min(slides.length - 1, Math.max(0, current + direction))
  return slides[next].slideNumber
}
