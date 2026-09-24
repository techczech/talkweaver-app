// ADR-0023 §9 — quotes have ONE width and ONE type size; a quote that does not fit its panel is
// split across continuation slides at compile time. This module owns the geometry model, the
// line estimate and the splitter. The renderer (06) reads `block.quotePart`; the source adapter
// (08) asks `quoteSplitCountForBlocks` while reserving ids and `splitQuoteSlideBlocks` when it
// emits slides; the presenter runtime keeps only a soft-fit fallback (type down to the floor,
// never a width change).
//
// GEOMETRY (mirrors layouts/quote.css, base.css and tokens.css — change them together):
//   panel width      min(84cqw, 100%) of the 1180px-capped content column  → 1180px at 1600, 84cqw below
//   panel type       max(31px, 3.4cqw)                                         → 54.4px at 1600
//   panel padding    1.4em 1.6em 1.2em 2.4em, accent rule .22em                → inner width = panel − 4.22em
//   line-height      1.42; paragraph gap .3em (base.css `.slide-content > blockquote p`)
//   cite             margin-top 1.2em, type max(31px, .58em), same line-height
//   fit box          stage − 59px footer band − 2 × 5vh slide padding (T13b, quote.css @order 0718)
//
// CHARACTERS PER LINE: measured in headless Chromium (T20b, 2026-09-13) with canvas measureText
// in the panel's computed font (400 54.4px "Trebuchet MS") over the five sampler quotations: the
// average glyph is 0.4497em (0.444–0.454 across the fixtures). 0.45em is used, so cpl = floor(inner
// ÷ 0.45em) = 38 at 1600×900 (inner 951px) and 45 at 1280×720 (inner 892px). Lines are counted by
// simulating greedy word wrap rather than dividing characters by cpl, because the wrap wastes part
// of every line.
//
// LINES PER PANEL: measured the same way by filling a live panel with N single-word lines and
// reading scrollHeight against the fit box (751px at 1600×900, 589px at 1280×720): 6 lines with
// the cite, 7 without (the continuation mark sits in the padding and costs nothing) — at BOTH
// stages, since padding, cite and line-height all scale with the type. The model below reproduces
// those figures from the CSS constants; the estimate is taken at both stages and the tighter wins.
//
// Runtime metrics that differ from this model are absorbed by the presenter's soft-fit fallback.
// A quote that overflows the measured capacity by ≤ 15% (SOFT_OVERFLOW_RATIO) is deliberately kept
// on ONE slide for that fallback to absorb (type steps down, never below 31px) instead of splitting;
// a one-sentence quote of ~250 characters stays whole that way.

const QUOTE_TYPE_CQW = 3.4
const QUOTE_TYPE_FLOOR_PX = 31
const QUOTE_PANEL_CQW = 84
const CONTENT_COLUMN_MAX_PX = 1180
const QUOTE_LINE_HEIGHT = 1.42
const PANEL_PAD_TOP_EM = 1.4
const PANEL_PAD_BOTTOM_EM = 1.2
const PANEL_PAD_X_EM = 1.6 + 2.4
const PANEL_RULE_EM = 0.22
const PARAGRAPH_GAP_EM = 0.3
const CITE_MARGIN_EM = 1.2
const CITE_TYPE_EM = 0.58
const CHROME_BAND_PX = 59
const SLIDE_PAD_Y_VH = 0.05
const GLYPH_WIDTH_EM = 0.45
// Overflow the runtime fallback absorbs rather than a split (fraction of the text budget).
const SOFT_OVERFLOW_RATIO = 0.15
// A split may not create a part shorter than this fraction of the cite-less capacity, unless it
// is the final remainder; the cutter then takes a clause or word boundary instead.
const MIN_PART_RATIO = 0.4

export const QUOTE_REFERENCE_VIEWPORTS = Object.freeze([
  Object.freeze({ width: 1600, height: 900 }),
  Object.freeze({ width: 1280, height: 720 })
])

// Image quotes keep their own column (layouts/media.css) and are not split. The old ramp's
// conservative signal is retained: past this many characters the column cannot hold the quote
// at the 31px floor beside an image on a 1280×720 stage, and the runtime marks it too-long.
const IMAGE_QUOTE_TOO_LONG_CHARS = 700

export function quotePanelGeometry(viewport, { typePx = null } = {}) {
  const { width, height } = viewport
  const fontPx = typePx ?? Math.max(QUOTE_TYPE_FLOOR_PX, (QUOTE_TYPE_CQW / 100) * width)
  const panelWidthPx = Math.min((QUOTE_PANEL_CQW / 100) * width, CONTENT_COLUMN_MAX_PX)
  const innerWidthPx = panelWidthPx - (PANEL_PAD_X_EM + PANEL_RULE_EM) * fontPx
  const charsPerLine = Math.max(8, Math.floor(innerWidthPx / (GLYPH_WIDTH_EM * fontPx)))
  const availableHeightPx = height - CHROME_BAND_PX - 2 * SLIDE_PAD_Y_VH * height
  const linePx = QUOTE_LINE_HEIGHT * fontPx
  const citePx = CITE_MARGIN_EM * fontPx + QUOTE_LINE_HEIGHT * Math.max(QUOTE_TYPE_FLOOR_PX, CITE_TYPE_EM * fontPx)
  const textBudgetPx = availableHeightPx - (PANEL_PAD_TOP_EM + PANEL_PAD_BOTTOM_EM) * fontPx
  return {
    viewport,
    fontPx,
    panelWidthPx,
    innerWidthPx,
    charsPerLine,
    availableHeightPx,
    linePx,
    paragraphGapPx: PARAGRAPH_GAP_EM * fontPx,
    // Line budgets are expressed as px so paragraph gaps can be charged exactly.
    textBudgetPx: { withCite: textBudgetPx - citePx, withoutCite: textBudgetPx }
  }
}

// One capacity for the compiler: the tightest of the reference stages. `atFloor` is the same
// panel with type at the 31px floor — what the runtime fallback can still recover.
export function quoteCapacity(viewports = QUOTE_REFERENCE_VIEWPORTS) {
  const base = viewports.map((viewport) => quotePanelGeometry(viewport))
  const floor = viewports.map((viewport) => quotePanelGeometry(viewport, { typePx: QUOTE_TYPE_FLOOR_PX }))
  return { base, floor }
}

const DEFAULT_CAPACITY = quoteCapacity()

// ---------------------------------------------------------------------------------------------
// Text measurement
// ---------------------------------------------------------------------------------------------

// Visible characters of a markdown inline run: emphasis markers and inline tags are not glyphs.
export function visibleQuoteText(text) {
  return String(text ?? '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<\/?(?:em|strong|b|i)>/g, '')
    .replace(/\*\*|__/g, '')
    .replace(/(^|[^\w])[*_](?=\S)/g, '$1')
    .replace(/(\S)[*_](?=$|[^\w])/g, '$1')
}

// Greedy word wrap of one paragraph into lines of at most `charsPerLine` visible characters.
export function wrappedLineCount(paragraph, charsPerLine) {
  const words = visibleQuoteText(paragraph).split(/\s+/).filter(Boolean)
  if (!words.length) return 0
  let lines = 1
  let used = 0
  for (const word of words) {
    const next = used === 0 ? word.length : used + 1 + word.length
    if (next <= charsPerLine) {
      used = next
      continue
    }
    // A word longer than the measure wraps mid-word in the browser (overflow-wrap) or overflows;
    // charge it its full share of lines either way.
    lines += used === 0 ? Math.ceil(word.length / charsPerLine) - 1 : Math.ceil(word.length / charsPerLine)
    used = word.length % charsPerLine || charsPerLine
    if (used === charsPerLine) used = 0
  }
  return lines
}

// Height in px of the text block for a set of paragraphs under one geometry.
function textHeightPx(paragraphs, geometry) {
  const lines = paragraphs.reduce((sum, p) => sum + wrappedLineCount(p, geometry.charsPerLine), 0)
  const gaps = Math.max(0, paragraphs.length - 1)
  return lines * geometry.linePx + gaps * geometry.paragraphGapPx
}

export function estimateQuoteLines(paragraphs, geometry = DEFAULT_CAPACITY.base[0]) {
  return paragraphs.reduce((sum, p) => sum + wrappedLineCount(p, geometry.charsPerLine), 0)
}

// Does this set of paragraphs fit the panel at every reference stage?
function fitsEverywhere(paragraphs, geometries, withCite) {
  return geometries.every((geometry) => textHeightPx(paragraphs, geometry) <= geometry.textBudgetPx[withCite ? 'withCite' : 'withoutCite'] + 0.5)
}

// ---------------------------------------------------------------------------------------------
// Boundaries
// ---------------------------------------------------------------------------------------------

// Emphasis spans that must never be split: `**…**`, `__…__`, `*…*`, `_…_`, `<em>`, `<strong>`.
// Returns true when a split at `index` of `text` falls inside an open span.
export function insideProtectedSpan(text, index) {
  const head = text.slice(0, index)
  let bold = 0
  let em = 0
  let tagEm = 0
  let tagStrong = 0
  for (let i = 0; i < head.length; i += 1) {
    const ch = head[i]
    if (ch === '<') {
      const tag = head.slice(i).match(/^<(\/?)(em|strong)>/)
      if (tag) {
        const delta = tag[1] ? -1 : 1
        if (tag[2] === 'em') tagEm += delta
        else tagStrong += delta
        i += tag[0].length - 1
      }
      continue
    }
    if (ch === '*' || ch === '_') {
      if (head[i + 1] === ch) {
        bold += 1
        i += 1
        continue
      }
      const prev = head[i - 1] ?? ' '
      const next = head[i + 1] ?? ' '
      // A single marker is emphasis only at a word edge; `snake_case` is not a span.
      if (ch === '_' && /\w/.test(prev) && /\w/.test(next)) continue
      em += 1
    }
  }
  return bold % 2 === 1 || em % 2 === 1 || tagEm > 0 || tagStrong > 0
}

// Candidate split positions (character index AFTER the boundary, whitespace consumed) at one
// strength: 'sentence' (. ! ? then space), 'clause' (; : , then space) or 'word' (any space).
export function boundaryIndices(text, strength) {
  const pattern = strength === 'sentence'
    ? /[.!?]["”’)\]]*\s+/g
    : strength === 'clause'
      ? /[;:,]["”’)\]]*\s+/g
      : /\s+/g
  const out = []
  for (const match of text.matchAll(pattern)) {
    const index = match.index + match[0].length
    if (index >= text.length) continue
    if (insideProtectedSpan(text, index)) continue
    out.push(index)
  }
  return out
}

function splitAt(text, indices) {
  const pieces = []
  let start = 0
  for (const index of indices) {
    pieces.push(text.slice(start, index).trim())
    start = index
  }
  pieces.push(text.slice(start).trim())
  return pieces.filter(Boolean)
}

// ---------------------------------------------------------------------------------------------
// Splitter
// ---------------------------------------------------------------------------------------------

const STRENGTH_RANK = { paragraph: 4, sentence: 3, clause: 2, word: 1 }

// Atoms: the words of every paragraph, each tagged with the strength of the boundary AFTER it
// (paragraph > sentence > clause > word; null when a cut there would break a protected span).
function atomise(paragraphs) {
  const atoms = []
  paragraphs.forEach((paragraph, paragraphIndex) => {
    const sentence = new Set(boundaryIndices(paragraph, 'sentence'))
    const clause = new Set(boundaryIndices(paragraph, 'clause'))
    const word = new Set(boundaryIndices(paragraph, 'word'))
    const pattern = /\S+\s*/g
    for (const match of paragraph.matchAll(pattern)) {
      const after = match.index + match[0].length
      const text = match[0].trim()
      let boundary = null
      if (after >= paragraph.length) boundary = 'paragraph'
      else if (sentence.has(after)) boundary = 'sentence'
      else if (clause.has(after)) boundary = 'clause'
      else if (word.has(after)) boundary = 'word'
      atoms.push({ text, paragraphIndex, boundary, chars: visibleQuoteText(text).length })
    }
  })
  return atoms
}

// Paragraph strings for an atom range [from, to).
function paragraphsOf(atoms, from, to) {
  const out = []
  let current = null
  for (let i = from; i < to; i += 1) {
    const atom = atoms[i]
    if (!current || current.paragraphIndex !== atom.paragraphIndex) {
      current = { paragraphIndex: atom.paragraphIndex, words: [] }
      out.push(current)
    }
    current.words.push(atom.text)
  }
  return out.map((p) => p.words.join(' '))
}

const heightRatio = (paragraphs, geometry, withCite) =>
  textHeightPx(paragraphs, geometry) / geometry.textBudgetPx[withCite ? 'withCite' : 'withoutCite']

// The largest height-to-budget ratio across the reference stages (> 1 means it overflows somewhere).
function worstRatio(paragraphs, geometries, withCite) {
  return Math.max(...geometries.map((geometry) => heightRatio(paragraphs, geometry, withCite)))
}

// Cut positions (exclusive atom index) after `from` where a boundary exists, with their strength.
function cutsAfter(atoms, from) {
  const cuts = []
  for (let i = from; i < atoms.length - 1; i += 1) if (atoms[i].boundary) cuts.push({ at: i + 1, strength: atoms[i].boundary })
  return cuts
}

// Furthest cut whose part still fits the cite-less budget everywhere.
function furthestFittingCut(atoms, from, geometries, withCite) {
  let best = null
  for (const cut of cutsAfter(atoms, from)) {
    if (worstRatio(paragraphsOf(atoms, from, cut.at), geometries, withCite) <= 1) best = cut
    else if (best) break
  }
  return best
}

function greedyCutPoints(atoms, geometries, hasCite) {
  const cuts = []
  let from = 0
  while (from < atoms.length) {
    const rest = paragraphsOf(atoms, from, atoms.length)
    if (worstRatio(rest, geometries, hasCite) <= 1) break
    const cut = furthestFittingCut(atoms, from, geometries, false)
    if (!cut || cut.at <= from) {
      // An unbreakable run: it overflows on its own; keep it whole and move on.
      const next = cutsAfter(atoms, from)[0]
      if (!next) break
      cuts.push(next.at)
      from = next.at
      continue
    }
    cuts.push(cut.at)
    from = cut.at
  }
  return cuts
}

// Balanced cut points for exactly `count` parts: each non-final part aims at an equal share of the
// characters and takes the boundary nearest its target among those that fit and satisfy the minimum
// part rule — sentence boundaries first, then clause, then word. Returns null when `count` parts
// cannot be made this way (the last part must still fit the cite budget).
function balancedCutPoints(atoms, geometries, hasCite, count, { minRatio, mutantEarliest = false }) {
  const totalChars = atoms.reduce((sum, atom) => sum + atom.chars + 1, 0)
  const reference = geometries[0]
  const cuts = []
  let from = 0
  let consumed = 0
  for (let part = 0; part < count - 1; part += 1) {
    const target = consumed + (totalChars - consumed) / (count - part)
    const candidates = cutsAfter(atoms, from)
      .map((cut) => {
        const paragraphs = paragraphsOf(atoms, from, cut.at)
        const chars = atoms.slice(from, cut.at).reduce((sum, atom) => sum + atom.chars + 1, 0)
        return { ...cut, paragraphs, chars, fits: worstRatio(paragraphs, geometries, false) <= 1, ratio: heightRatio(paragraphs, reference, false) }
      })
      .filter((cut) => cut.fits)
    if (!candidates.length) return null
    const large = candidates.filter((cut) => cut.ratio >= minRatio)
    const pool = large.length ? large : candidates
    let chosen = null
    if (mutantEarliest) {
      chosen = candidates.find((cut) => cut.strength === 'sentence' || cut.strength === 'paragraph') || candidates[0]
    } else {
      for (const rank of [4, 3, 2, 1]) {
        const atRank = pool.filter((cut) => STRENGTH_RANK[cut.strength] === rank)
        if (!atRank.length) continue
        chosen = atRank.reduce((best, cut) => (
          Math.abs(consumed + cut.chars - target) < Math.abs(consumed + best.chars - target) ? cut : best
        ))
        // A weaker boundary is taken only when the strongest available lands far from the target
        // (more than a fifth of a share away) — otherwise a sentence end wins over balance.
        const share = (totalChars - consumed) / (count - part)
        if (Math.abs(consumed + chosen.chars - target) <= share * 0.2 || rank === 1) break
        chosen = null
      }
      if (!chosen) {
        chosen = pool.reduce((best, cut) => (
          Math.abs(consumed + cut.chars - target) < Math.abs(consumed + best.chars - target) ? cut : best
        ))
      }
    }
    cuts.push(chosen.at)
    consumed += chosen.chars
    from = chosen.at
  }
  const last = paragraphsOf(atoms, from, atoms.length)
  if (!last.length || worstRatio(last, geometries, hasCite) > 1) return null
  return cuts
}

function partsFromCuts(atoms, cuts) {
  const parts = []
  let from = 0
  for (const at of [...cuts, atoms.length]) {
    if (at > from) parts.push(paragraphsOf(atoms, from, at))
    from = at
  }
  return parts
}

/**
 * Split quote paragraphs into parts, each a paragraphs[] that fits the panel.
 *   • fits, or overflows by ≤ 15% (the runtime fallback absorbs it) → one part;
 *   • otherwise the greedy count is the fewest parts that fit; the cuts are then balanced around
 *     equal shares, sentence boundaries first, then clause, then word — never inside a protected
 *     span — and no non-final part may be shorter than 40% of the cite-less capacity;
 *   • the last part must also hold the cite when `hasCite`; if the balanced cut cannot, one more
 *     part is tried, and the greedy cuts are the final fallback.
 */
export function splitQuoteParagraphs(paragraphs, { hasCite = false, capacity = DEFAULT_CAPACITY } = {}) {
  const geometries = capacity.base
  const clean = paragraphs.map((p) => String(p ?? '').trim()).filter(Boolean)
  if (!clean.length) return [[]]
  if (worstRatio(clean, geometries, hasCite) <= 1 + SOFT_OVERFLOW_RATIO) return [clean]
  const atoms = atomise(clean)
  const greedy = greedyCutPoints(atoms, geometries, hasCite)
  const options = {
    minRatio: process.env.TW_REINSTATE_QUOTE_MIN_PART_DEFECT === '1' ? 0 : MIN_PART_RATIO,
    mutantEarliest: process.env.TW_REINSTATE_QUOTE_MIN_PART_DEFECT === '1'
  }
  for (let count = greedy.length + 1; count <= greedy.length + 3; count += 1) {
    const cuts = balancedCutPoints(atoms, geometries, hasCite, count, options)
    if (cuts) return partsFromCuts(atoms, cuts)
  }
  return partsFromCuts(atoms, greedy)
}

// Does a part satisfy the minimum-size rule (final parts are exempt)? Exported for the gate.
export function partSizeRatio(paragraphs, capacity = DEFAULT_CAPACITY) {
  return heightRatio(paragraphs, capacity.base[0], false)
}

export const QUOTE_MIN_PART_RATIO = MIN_PART_RATIO
export const QUOTE_SOFT_OVERFLOW_RATIO = SOFT_OVERFLOW_RATIO

// ---------------------------------------------------------------------------------------------
// Block-level API
// ---------------------------------------------------------------------------------------------

export function quoteParagraphs(block) {
  return Array.isArray(block?.paragraphs) && block.paragraphs.length
    ? block.paragraphs.map((p) => String(p ?? ''))
    : [String(block?.text ?? '')]
}

// G1: the panel's decorative mark supplies the quotation marks, so a single wrapping pair of
// literal double quotes is stripped off the body (curly or straight). Marks INSIDE stay.
export function stripWrappingQuoteMarks(paragraphs) {
  if (!paragraphs.length) return paragraphs
  const first = paragraphs[0]
  const last = paragraphs[paragraphs.length - 1]
  if (!(/^\s*["“]/.test(first) && /["”]\s*$/.test(last))) return paragraphs
  const out = paragraphs.slice()
  out[0] = out[0].replace(/^\s*["“]\s*/, '')
  out[out.length - 1] = out[out.length - 1].replace(/\s*["”]\s*$/, '')
  return out
}

function quoteBlockOnQuoteSlide(blocks, layout) {
  if (layout !== 'quote') return null
  const quotes = (blocks || []).filter((b) => b && b.type === 'quote')
  if (quotes.length !== 1) return null
  // Only a quote-only slide splits: a quote beside a figure renders flat on paper and keeps its
  // own composition (base.css `.layout-quote:has(> .slide-figure)`).
  if ((blocks || []).some((b) => b && b !== quotes[0])) return null
  return quotes[0]
}

/**
 * Parts for one quote block: [{ paragraphs, chars }] — one entry when the quote fits.
 */
export function quotePartsForBlock(block, capacity = DEFAULT_CAPACITY) {
  const paragraphs = stripWrappingQuoteMarks(quoteParagraphs(block))
  const hasCite = Boolean(String(block?.cite ?? '').trim())
  // Mutation switch for scripts/test-quote-sizing.mjs: reinstate the unsplit quote so the gate
  // can prove it fails when the splitter is silenced. Never set in production.
  const parts = process.env.TW_REINSTATE_QUOTE_DEFECT === '1'
    ? [paragraphs]
    : splitQuoteParagraphs(paragraphs, { hasCite, capacity })
  return parts.map((part) => ({
    paragraphs: part,
    chars: part.join(' ').length
  }))
}

export function quoteSplitCountForBlocks(blocks, layout) {
  const quote = quoteBlockOnQuoteSlide(blocks, layout)
  if (!quote) return 1
  return quotePartsForBlock(quote).length
}

/**
 * Blocks for each continuation slide of a quote-only slide, or null when the slide is not split.
 * Every part is a full quote block with the same panel; the cite lives on the LAST part only, and
 * `quotePart` records position, count and the whole quote's cite (so the title regime — hidden
 * when the cite equals the title — holds on every part).
 */
export function splitQuoteSlideBlocks(blocks, layout) {
  const quote = quoteBlockOnQuoteSlide(blocks, layout)
  if (!quote) return null
  const parts = quotePartsForBlock(quote)
  if (parts.length < 2) return null
  const cite = quote.cite ?? ''
  return parts.map((part, index) => {
    const isLast = index === parts.length - 1
    return [{
      ...quote,
      paragraphs: part.paragraphs,
      text: part.paragraphs.join(' '),
      cite: isLast ? cite : '',
      quotePart: { index: index + 1, count: parts.length, cite },
      quoteLayout: { ...(quote.quoteLayout ?? {}), chars: part.chars }
    }]
  })
}

// A part (or an unsplit quote) that still cannot fit with type at the 31px floor: only an
// unbreakable run (one word, one protected span) gets here — the splitter breaks everything else.
function tooLongAtFloor(paragraphs, hasCite, capacity = DEFAULT_CAPACITY) {
  return !fitsEverywhere(paragraphs, capacity.floor, hasCite)
}

export function annotateQuoteLayout(blocks, layout, slideId, warn) {
  for (const block of blocks || []) {
    if (layout === 'quote' && block?.type === 'quote') {
      const paragraphs = stripWrappingQuoteMarks(quoteParagraphs(block))
      const hasCite = Boolean(String(block.cite ?? '').trim())
      const parts = quoteBlockOnQuoteSlide(blocks, layout) === block
        ? quotePartsForBlock(block)
        : [{ paragraphs, chars: paragraphs.join(' ').length }]
      const geometry = DEFAULT_CAPACITY.base[0]
      block.quoteLayout = {
        chars: paragraphs.join(' ').length,
        parts: parts.length,
        linesEstimate: estimateQuoteLines(paragraphs, geometry),
        charsPerLine: geometry.charsPerLine,
        typeFloorPx: QUOTE_TYPE_FLOOR_PX
      }
      const overflowing = parts.some((part, index) => tooLongAtFloor(part.paragraphs, hasCite && index === parts.length - 1))
      if (overflowing) warn(`quote-too-long:${slideId}`)
    }
    if (block?.type === 'image-quote' && block.quote) {
      const paragraphs = quoteParagraphs(block.quote)
      const chars = paragraphs.join(' ').length
      block.quote.quoteLayout = { chars, parts: 1, typeFloorPx: QUOTE_TYPE_FLOOR_PX }
      if (chars >= IMAGE_QUOTE_TOO_LONG_CHARS) warn(`quote-too-long:${slideId}`)
    }
  }
}

export const QUOTE_LAYOUT_CONSTANTS = Object.freeze({
  typeCqw: QUOTE_TYPE_CQW,
  typeFloorPx: QUOTE_TYPE_FLOOR_PX,
  panelCqw: QUOTE_PANEL_CQW,
  contentColumnMaxPx: CONTENT_COLUMN_MAX_PX,
  lineHeight: QUOTE_LINE_HEIGHT,
  glyphWidthEm: GLYPH_WIDTH_EM,
  imageQuoteTooLongChars: IMAGE_QUOTE_TOO_LONG_CHARS,
  softOverflowRatio: SOFT_OVERFLOW_RATIO,
  minPartRatio: MIN_PART_RATIO
})
