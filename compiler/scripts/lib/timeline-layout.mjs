// Ticket 22 — how many timeline stops one slide holds, per presentation mode, and how a longer
// timeline is cut into continuation slides. The source adapter (08) asks `timelineContinuationParts`
// both while reserving ids (continuationSplitForNode) and while emitting slides (flushSlide), so
// the outline, sequencer and every id consumer agree with what renders.
//
// GEOMETRY (mirrors tokens.css, base.css, layouts/timeline.css and skin/timeline.css — change them
// together). The stage is the size container (base.css @order 0008), so every cqw below is a
// fraction of the stage width:
//   content column   min(1180px, stage − 2 × 5.6cqw)                       → 1180px at 1600, 1137px at 1280
//   type floor       1.9375cqw (stage.css)                                  → 31px at 1600, 24.8px at 1280
//   horizontal stop  one 1fr column per stop; text inset by 1em padding-right (skin @order 1435)
//   pills card       width min(190% of the column, clamp(160px, 16cqw, 205px)), padding .75em
//                    (layouts/timeline.css @order 1018) — a card must not be wider than its column
//   spine card       the same width, but cards ALTERNATE above/below, so same-side neighbours
//                    sit two columns apart (layouts/timeline.css @order 1002)
//
// MEASURED (headless Chromium canvas measureText, 2026-09-14, the five showcase stop texts at
// 400 31px "Trebuchet MS"): the average glyph is 0.471em (0.452–0.505); "2022" at 800 weight is
// 2.34em. A line must hold at least MIN_CHARS_PER_LINE = 11 characters at the floor — two average
// English words — for the stop's text to read as prose rather than a word stack (ADR-0005: a box's
// text must fit more than one word per line).
//
// DERIVED CAPS (the tighter of the two reference stages):
//   horizontal  N ≤ W / (11 × 0.471f + f)  → 6.17 at 1600 (6.9 at 1280)  → 6
//   pills       N ≤ W / card(205px)        → 5.75 at 1600 (5.55 at 1280) → 5 (six cards would touch)
//   spine       N ≤ 2W / card(205px)       → 11.5 at 1600 (11.1 at 1280) → 10 (the tuned constant,
//               inside the bound; the 0.66 font ramp keeps the date labels inside their columns)
// Rail, columns, compact and dynamic stack vertically and are not capped here.

const CONTENT_COLUMN_MAX_PX = 1180
const SLIDE_PAD_X_CQW = 5.6
const TYPE_FLOOR_CQW = 1.9375
const GLYPH_WIDTH_EM = 0.471
const MIN_CHARS_PER_LINE = 11
const HORIZONTAL_TEXT_INSET_EM = 1
const CARD_MAX_PX = 205
const CARD_CQW = 16
const CARD_MIN_PX = 160

export const TIMELINE_REFERENCE_VIEWPORTS = Object.freeze([
  Object.freeze({ width: 1600, height: 900 }),
  Object.freeze({ width: 1280, height: 720 })
])

export const SPINE_STOPS_PER_SLIDE = 10
export const PILLS_STOPS_PER_SLIDE = 5
export const HORIZONTAL_STOPS_PER_SLIDE = 6

export const TIMELINE_STOPS_PER_SLIDE = Object.freeze({
  spine: SPINE_STOPS_PER_SLIDE,
  pills: PILLS_STOPS_PER_SLIDE,
  horizontal: HORIZONTAL_STOPS_PER_SLIDE
})

export function timelineStageGeometry(viewport) {
  const { width } = viewport
  const floorPx = (TYPE_FLOOR_CQW / 100) * width
  const contentWidthPx = Math.min(CONTENT_COLUMN_MAX_PX, width - 2 * (SLIDE_PAD_X_CQW / 100) * width)
  const cardWidthPx = Math.min(CARD_MAX_PX, Math.max(CARD_MIN_PX, (CARD_CQW / 100) * width))
  const minLinePx = MIN_CHARS_PER_LINE * GLYPH_WIDTH_EM * floorPx
  return { viewport, floorPx, contentWidthPx, cardWidthPx, minLinePx }
}

// The cap the geometry alone would allow for a mode at one stage — the constants above are the
// floor of these across the reference stages (spine keeps its tuned 10, which sits inside the bound).
export function timelineGeometricCap(mode, viewport) {
  const g = timelineStageGeometry(viewport)
  if (mode === 'horizontal') return Math.floor(g.contentWidthPx / (g.minLinePx + HORIZONTAL_TEXT_INSET_EM * g.floorPx))
  if (mode === 'pills') return Math.floor(g.contentWidthPx / g.cardWidthPx)
  if (mode === 'spine') return Math.floor((2 * g.contentWidthPx) / g.cardWidthPx)
  return Infinity
}

export function timelineStopsPerSlide(mode) {
  return TIMELINE_STOPS_PER_SLIDE[mode] ?? Infinity
}

// Balanced cuts: the fewest parts that respect the cap, each part as equal as the count allows
// (6 stops at cap 5 → 3 + 3, never 5 + 1). Returns null when the timeline fits one slide.
export function timelineStopChunks(stops, cap) {
  const list = Array.isArray(stops) ? stops : []
  if (!Number.isFinite(cap) || cap < 1 || list.length <= cap) return null
  const parts = Math.ceil(list.length / cap)
  const base = Math.floor(list.length / parts)
  const extra = list.length % parts
  const chunks = []
  let at = 0
  for (let i = 0; i < parts; i += 1) {
    const size = base + (i < extra ? 1 : 0)
    chunks.push(list.slice(at, at + size))
    at += size
  }
  return chunks
}

// Single-block timeline slides only (a mixed slide renders its stops uncapped — the cap is a
// legibility default, not a hard constraint). Returns the continuation blocks or null.
export function timelineContinuationParts(blocks, fieldsFromStops) {
  const block = Array.isArray(blocks) && blocks.length === 1 && blocks[0] && blocks[0].type === 'timeline' ? blocks[0] : null
  if (!block) return null
  const stops = Array.isArray(block.stops) ? block.stops : null
  if (!stops) return null
  const chunks = timelineStopChunks(stops, timelineStopsPerSlide(block.mode))
  if (!chunks) return null
  return chunks.map((chunk) => ({ ...block, ...fieldsFromStops(chunk) }))
}
