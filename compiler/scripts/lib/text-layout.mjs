// ADR-0033 §1 — the type floor is a hard minimum, so a slide whose text cannot fit at the floor gets
// an editor warning instead of a silent whole-slide shrink. The rendered truth is the presenter
// runtime's `autofitContent` (slide-fit.js, which marks `data-text-fit="too-long"`); this module is
// the compiler's own ESTIMATE of the same condition, so the strip badge, Inspector and Layout Doctor
// can raise `text-too-long` without rendering (as quote-layout.mjs and code-layout.mjs do for their
// blocks). It models text-only list, table and paragraph slides at the floor on the 1280×720 canvas
// and is deliberately low-biased: it warns only when the estimate is clearly taller than the band.
//
// GEOMETRY (canvas px; mirrors layouts/list.css, skin/table.css, stage.css — change them together):
//   type floor       1.9375cqw = 24.8px
//   column, left rail   696px (1280 − 26cqw rail − padding), band 598px
//   column, top title   1137px, band 648px less the title block (94px + 82px per title line)
//   leading          1.18 (list and table), paragraphs 1.35
//   table cell       padding .29em × .8em
// Glyph width is 0.5em (Trebuchet average 0.45-0.5 em; see quote-layout.mjs for the measurement).

const CANVAS_W = 1280
const FLOOR_PX = 0.019375 * CANVAS_W
const GLYPH_EM = 0.5
const LEADING = 1.18
const PARAGRAPH_LEADING = 1.35
const ITEM_GAP_EM = 0.35
const BULLET_INDENT_EM = 1.3
const CELL_PAD_Y_EM = 0.29
const CELL_PAD_X_EM = 0.8
const LEFT = Object.freeze({ width: 696, band: 598 })
const TOP = Object.freeze({ width: 1137, band: 648, titleBase: 94, titleLine: 82, titleCharsPerLine: 38 })
// The estimate is low-biased already; only a clear excess is reported.
export const TEXT_TOO_TALL_THRESHOLD = 0.1

const TEXT_BLOCKS = new Set(['list', 'feature-list', 'table', 'paragraph', 'subheading'])

function plain(value) {
  return String(value ?? '').replace(/\{[^}]*\}/g, '').replace(/[*_`[\]]/g, '').replace(/\(https?:[^)]*\)/g, '').trim()
}

// Greedy word wrap at `chars` characters per line; at least one line.
function wrappedLines(text, chars) {
  const words = plain(text).split(/\s+/).filter(Boolean)
  if (!words.length) return 1
  let lines = 1
  let used = 0
  for (const word of words) {
    const need = used ? word.length + 1 : word.length
    if (used && used + need > chars) { lines += 1; used = word.length } else used += need
  }
  return lines
}

function charsFor(widthPx) {
  return Math.max(6, Math.floor(widthPx / (GLYPH_EM * FLOOR_PX)))
}

function nodeHeight(text, children, width, depth) {
  const indent = BULLET_INDENT_EM * FLOOR_PX * (depth + 1)
  let height = wrappedLines(text, charsFor(width - indent)) * LEADING * FLOOR_PX + ITEM_GAP_EM * FLOOR_PX
  for (const child of children || []) height += nodeHeight(child?.text ?? child, child?.children, width, depth + 1)
  return height
}

function listHeight(items, children, width) {
  return (items || []).reduce((sum, item, index) => sum + nodeHeight(item, children?.[index], width, 0), 0)
}

function tableHeight(block, width) {
  const rows = [block.header, ...(block.rows || [])].filter(Array.isArray)
  const columns = Math.max(0, ...rows.map((row) => row.length))
  if (!columns) return 0
  // Column widths follow the longest cell (min 8 characters), the way an auto table layout does.
  const weights = Array.from({ length: columns }, (_, column) =>
    Math.max(8, ...rows.map((row) => plain(row[column]).length)))
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  const padX = 2 * CELL_PAD_X_EM * FLOOR_PX
  let height = 0
  for (const row of rows) {
    let lines = 1
    row.forEach((cell, column) => {
      const columnWidth = (weights[column] / total) * width - padX
      lines = Math.max(lines, wrappedLines(cell, charsFor(columnWidth)))
    })
    height += lines * LEADING * FLOOR_PX + 2 * CELL_PAD_Y_EM * FLOOR_PX
  }
  return height
}

/**
 * Estimate whether a text-only slide fits at the type floor.
 * @param {{blocks: object[], title?: string, regime: 'left'|'top'}} slide
 * @returns {null | {tooLongAtFloor: boolean, tooTallPercent: number, estimatedPx: number, bandPx: number}}
 *   null when the slide holds anything other than list, table and paragraph text.
 */
export function textLayoutForSlide({ blocks, title = '', regime }) {
  if (regime !== 'left' && regime !== 'top') return null
  const list = Array.isArray(blocks) ? blocks.filter(Boolean) : []
  if (!list.length || list.some((block) => !TEXT_BLOCKS.has(block.type))) return null
  const geometry = regime === 'left' ? LEFT : TOP
  let band = geometry.band
  if (regime === 'top') {
    const titleLines = Math.max(1, Math.ceil(plain(title).length / TOP.titleCharsPerLine))
    band -= TOP.titleBase + TOP.titleLine * titleLines
  }
  let height = 0
  for (const block of list) {
    if (block.type === 'list' || block.type === 'feature-list') height += listHeight(block.items, block.children, geometry.width)
    else if (block.type === 'table') height += tableHeight(block, geometry.width)
    else height += wrappedLines(block.text, charsFor(geometry.width)) * PARAGRAPH_LEADING * FLOOR_PX + 0.6 * FLOOR_PX
  }
  const ratio = height / band
  return {
    tooLongAtFloor: ratio - 1 >= TEXT_TOO_TALL_THRESHOLD,
    tooTallPercent: Math.max(0, Math.round((ratio - 1) * 100)),
    estimatedPx: Math.round(height),
    bandPx: Math.round(band)
  }
}

export function annotateTextLayout({ blocks, layout, regime, title }, slideId, warn) {
  if (layout !== 'list' && layout !== 'table') return
  const result = textLayoutForSlide({ blocks, title, regime })
  if (result?.tooLongAtFloor) warn(`text-too-long:${slideId}:${result.tooTallPercent}`)
}
