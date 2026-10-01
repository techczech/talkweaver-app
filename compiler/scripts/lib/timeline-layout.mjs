// Ticket 22 — how many timeline stops one slide holds, per presentation mode, and how a longer
// timeline is cut into continuation slides. The source adapter (08) asks `timelineContinuationParts`
// both while reserving ids (continuationSplitForNode) and while emitting slides (flushSlide), so
// the outline, sequencer and every id consumer agree with what renders.
//
// GEOMETRY (mirrors tokens.css, base.css, layouts/timeline.css and skin/timeline.css — change them
// together; test:timeline-stop-limit reads the stylesheets and the rendered track and fails when
// they part). The stage is the size container (base.css @order 0008), so every cqw below is a
// fraction of the stage width:
//   content column   min(1180px, stage − 2 × 5.6cqw)                       → 1180px at 1600, 1137px at 1280
//   type floor       1.9375cqw (stage.css)                                  → 31px at 1600, 24.8px at 1280
//   horizontal entry the body step, --fs-body = max(floor, 3.2cqw) (ADR-0033 §8) (skin/base.css; the track takes it
//                    at skin @order 1434 and each entry max(floor, 1em) of it at @order 2068)
//                                                                           → 51.2px at 1600, 40.96px at 1280
//   horizontal stop  one 1fr column per stop, no column gap on the track (skin @order 1434); the text is
//                    inset by padding-right 1.4em at the entry size (skin @order 1435, ADR-0028 §3)
//   pills card       width min(190% of the column, clamp(160px, 16cqw, 205px)), padding .75em
//                    (layouts/timeline.css @order 1018) — a card must not be wider than its column
//   spine card       the same width, but cards ALTERNATE above/below, so same-side neighbours
//                    sit two columns apart (layouts/timeline.css @order 1002)
//
// MEASURED (headless Chromium canvas measureText, 2026-09-14, the five showcase stop texts at
// 400 31px "Trebuchet MS"; re-measured 2026-09-25 over the sampler and design-round stop texts:
// 0.470em at 400, 0.49em at the last stop's 600): the average glyph is 0.471em (0.452–0.505);
// "2022" at 800 weight is 2.34em. A line must hold at least MIN_CHARS_PER_LINE = 11 characters —
// two average English words — for the stop's text to read as prose rather than a word stack
// (ADR-0005: a box's text must fit more than one word per line).
//
// DERIVED CAPS (the tighter of the two reference stages):
//   horizontal  N ≤ (W + gap) / (11 × 0.471e + 1.4e + gap), e = entry size
//                                          → 3.50 at 1600 (4.22 at 1280) → 3 (computed, not a constant:
//                                            HORIZONTAL_STOPS_PER_SLIDE below; was 4 on the dense step, 6 at the floor and a 1em inset)
//   pills       N ≤ W / card(205px)        → 5.75 at 1600 (5.55 at 1280) → 5 (six cards would touch)
//   spine       N ≤ 2W / card(205px)       → 11.5 at 1600 (11.1 at 1280) → 10 (the tuned constant,
//               inside the bound; the 0.66 font ramp keeps the date labels inside their columns)
// Rail, columns, compact and dynamic stack vertically and are not capped here.

const CONTENT_COLUMN_MAX_PX = 1180
const SLIDE_PAD_X_CQW = 5.6
const TYPE_FLOOR_CQW = 1.9375
const GLYPH_WIDTH_EM = 0.471
const MIN_CHARS_PER_LINE = 11
const CARD_MAX_PX = 205
const CARD_CQW = 16
const CARD_MIN_PX = 160

// The horizontal track's type and spacing tokens, as the stylesheets set them (see GEOMETRY).
export const HORIZONTAL_TRACK_TOKENS = Object.freeze({
  entryBodyCqw: 3.2, // --fs-body: max(var(--type-floor), 3.2cqw) — skin/base.css
  textInsetEm: 1.4, // .timeline-horizontal .tl-group { padding: 0 1.4em 0 0 } — skin @order 1435
  columnGapPx: 0 // the track grid sets no column-gap — skin @order 1434
})

export const TIMELINE_REFERENCE_VIEWPORTS = Object.freeze([
  Object.freeze({ width: 1600, height: 900 }),
  Object.freeze({ width: 1280, height: 720 })
])

export function timelineStageGeometry(viewport) {
  const { width } = viewport
  const floorPx = (TYPE_FLOOR_CQW / 100) * width
  const contentWidthPx = Math.min(CONTENT_COLUMN_MAX_PX, width - 2 * (SLIDE_PAD_X_CQW / 100) * width)
  const cardWidthPx = Math.min(CARD_MAX_PX, Math.max(CARD_MIN_PX, (CARD_CQW / 100) * width))
  const entryPx = Math.max(floorPx, (HORIZONTAL_TRACK_TOKENS.entryBodyCqw / 100) * width)
  const insetPx = HORIZONTAL_TRACK_TOKENS.textInsetEm * entryPx
  const gapPx = HORIZONTAL_TRACK_TOKENS.columnGapPx
  const glyphPx = GLYPH_WIDTH_EM * entryPx
  const minLinePx = MIN_CHARS_PER_LINE * glyphPx
  return { viewport, floorPx, contentWidthPx, cardWidthPx, entryPx, insetPx, gapPx, glyphPx, minLinePx }
}

// How many average characters one horizontal stop's text line holds when `stops` stops share the
// track at this stage — the measure the cap keeps at or above MIN_CHARS_PER_LINE.
export function timelineHorizontalMeasure(stops, viewport) {
  const g = timelineStageGeometry(viewport)
  const n = Math.max(1, Math.floor(stops))
  const columnPx = (g.contentWidthPx - (n - 1) * g.gapPx) / n
  return (columnPx - g.insetPx) / g.glyphPx
}

// The cap the geometry alone would allow for a mode at one stage — the constants below are the
// floor of these across the reference stages (spine keeps its tuned 10, which sits inside the bound).
export function timelineGeometricCap(mode, viewport) {
  const g = timelineStageGeometry(viewport)
  if (mode === 'horizontal') return Math.floor((g.contentWidthPx + g.gapPx) / (g.minLinePx + g.insetPx + g.gapPx))
  if (mode === 'pills') return Math.floor(g.contentWidthPx / g.cardWidthPx)
  if (mode === 'spine') return Math.floor((2 * g.contentWidthPx) / g.cardWidthPx)
  return Infinity
}

export const SPINE_STOPS_PER_SLIDE = 10
export const PILLS_STOPS_PER_SLIDE = 5
export const HORIZONTAL_STOPS_PER_SLIDE = Math.min(...TIMELINE_REFERENCE_VIEWPORTS.map((viewport) => timelineGeometricCap('horizontal', viewport)))
export const TIMELINE_TEXT_METRICS = Object.freeze({ glyphWidthEm: GLYPH_WIDTH_EM, minCharsPerLine: MIN_CHARS_PER_LINE })

export const TIMELINE_STOPS_PER_SLIDE = Object.freeze({
  spine: SPINE_STOPS_PER_SLIDE,
  pills: PILLS_STOPS_PER_SLIDE,
  horizontal: HORIZONTAL_STOPS_PER_SLIDE
})

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
