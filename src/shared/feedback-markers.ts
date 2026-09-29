// Markers on slides (shared-talk ticket 06; LOCKED-feedback-rail-and-markers.html frame 2): what the
// vertical slide pane draws for a shared talk's feedback. Pure: items and the slide order in, one
// marker per slide and the ghost rows out.
//
//   - A badge on a slide's thumbnail counts its unhandled items of every kind (note, edit, deletion);
//     it is red when one of them proposes deleting the slide.
//   - Once every item on a slide is handled, a quiet tick replaces the number.
//   - An unhandled proposed new slide is a dashed ghost row where it would go (after the slide it
//     names, or before the first slide), with its own badge. Handled ones leave no ghost: accepted,
//     it is a real slide; dismissed, it is gone.
//   - Items on a slide no longer in the talk, and ghosts after such a slide, have no row to sit on;
//     they stay in the rail.

import type { FeedbackItem } from './feedback.ts'
import { proposedSlidePreview } from './feedback.ts'

export interface SlideMarker {
  /** Unhandled items on the slide. */
  count: number
  /** Every item on it is handled (and there is at least one): the tick. */
  handled: boolean
  /** One of the unhandled items proposes deleting the slide: the red badge. */
  deletion: boolean
}

export interface GhostRow {
  itemId: string
  /** The slide it goes after ('start': before the first slide). */
  afterSlideId: string
  /** 1-based number of that slide (0 for 'start'). */
  afterNumber: number
  title: string
  section: string | null
}

export interface SlideMarkers {
  bySlide: Record<string, SlideMarker>
  /** In the order they are drawn: by the slide they follow, then oldest first. */
  ghosts: GhostRow[]
}

type MarkerItem = Pick<FeedbackItem, 'itemId' | 'kind' | 'slideId' | 'afterSlideId' | 'status' | 'text' | 'section' | 'createdAt' | 'seq'>

export function slideMarkers(items: readonly MarkerItem[], slideIds: readonly string[]): SlideMarkers {
  const order = new Map(slideIds.map((id, i) => [id, i]))
  const bySlide: Record<string, SlideMarker> = {}
  const ghosts: Array<GhostRow & { at: number; createdAt: number; seq: number }> = []
  for (const item of items) {
    const isNew = item.status === 'new'
    if (item.kind === 'insert') {
      if (!isNew) continue
      const after = item.afterSlideId ?? ''
      const at = after === 'start' ? -1 : order.get(after)
      if (at === undefined) continue
      const preview = proposedSlidePreview(item.text ?? '', null, null)
      ghosts.push({
        itemId: item.itemId, afterSlideId: after, afterNumber: at + 1, title: preview?.title ?? 'New slide',
        section: item.section?.trim() || null, at, createdAt: item.createdAt, seq: item.seq,
      })
      continue
    }
    if (!item.slideId || !order.has(item.slideId)) continue
    const marker = bySlide[item.slideId] ?? (bySlide[item.slideId] = { count: 0, handled: true, deletion: false })
    if (isNew) {
      marker.count += 1
      marker.handled = false
      if (item.kind === 'delete') marker.deletion = true
    }
  }
  ghosts.sort((a, b) => (a.at - b.at) || (a.createdAt - b.createdAt) || (a.seq - b.seq))
  return { bySlide, ghosts: ghosts.map(({ at: _at, createdAt: _c, seq: _s, ...ghost }) => ghost) }
}
