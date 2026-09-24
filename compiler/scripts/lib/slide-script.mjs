/**
 * Slide script companion — the readable text shown beneath a slide on a phone (ADR-0018).
 *
 * Parsed from the slide's OWN OUTLINE SOURCE (`slide.sourceMarkdown`), never scraped from rendered
 * DOM. Scraping was tried first and produced a flat dump of text fragments — author, date and
 * kicker mixed into the body — because the structure only exists in the outline. Here indents stay
 * indents, prose stays prose, quotes stay quotes, and media is named rather than silently dropped.
 *
 * Parsing happens at COMPILE time so the handout runtime ships data, not a markdown parser.
 *
 * NOTE: a Run's Script render (transcript) is a SEPARATE view and never replaces this (ADR-0018 §4).
 */
import {
  isMarkdownFenceClosingLine,
  parseChartFenceOpeningLine
} from './03-object-token.mjs'

/** @typedef {{type:'list',items:{depth:number,text:string,pair?:string}[]}
 *          | {type:'p'|'quote'|'attrib',text:string}
 *          | {type:'media',alt:string}
 *          | {type:'table',rows:string[][]}} ScriptBlock */

/**
 * @param {string} sourceMarkdown one slide's outline source, heading line included
 * @returns {ScriptBlock[]}
 */
export function parseSlideScript(sourceMarkdown) {
  const blocks = []
  const lines = String(sourceMarkdown || '').split('\n')
  let started = false
  let chartFenceOpening = null

  for (const raw of lines) {
    const line = raw.trim()

    // Skip the heading line itself — the title is rendered as the heading of this text.
    if (!started && /^#{1,6}\s/.test(line)) { started = true; continue }
    started = true
    if (!line) continue
    if (chartFenceOpening) {
      if (isMarkdownFenceClosingLine(line, chartFenceOpening)) {
        chartFenceOpening = null
        continue
      }
    } else {
      const fence = parseChartFenceOpeningLine(line)
      if (fence?.chart) {
        chartFenceOpening = fence
        continue
      }
    }
    // A trigger-only line ({list}{reveal}) is authoring syntax, not content.
    if (/^(\{[^}]*\}\s*)+$/.test(line)) continue

    const img = line.match(/^!\[([^\]]*)\]\(([^)]*)\)/)
    if (img) { blocks.push({ type: 'media', alt: img[1] || '' }); continue }

    if (line.startsWith('>')) { blocks.push({ type: 'quote', text: line.replace(/^>\s?/, '') }); continue }

    if (/^[—–-]\s+\S/.test(line) && blocks.at(-1)?.type === 'quote') {
      blocks.push({ type: 'attrib', text: line.replace(/^[—–-]\s+/, '') })
      continue
    }

    if (line.startsWith('|')) {
      const cells = line.split('|').map((c) => c.trim()).filter((c) => c.length)
      if (!cells.length || cells.every((c) => /^:?-{2,}:?$/.test(c))) continue
      const last = blocks.at(-1)
      if (last?.type === 'table') last.rows.push(cells)
      else blocks.push({ type: 'table', rows: [cells] })
      continue
    }

    const bullet = raw.match(/^(\s*)[-*+]\s+(.*)$/)
    if (bullet) {
      const depth = Math.floor(bullet[1].replace(/\t/g, '  ').length / 2)
      const body = bullet[2].trim()
      // `a :: b` is an authored pair (contrast rows, chart values) — keep both sides.
      const parts = body.split('::').map((s) => s.trim())
      const item = parts.length === 2 && parts[1]
        ? { depth, text: parts[0], pair: parts[1] }
        : { depth, text: body }
      const last = blocks.at(-1)
      if (last?.type === 'list') last.items.push(item)
      else blocks.push({ type: 'list', items: [item] })
      continue
    }

    blocks.push({ type: 'p', text: line })
  }

  return blocks
}

/**
 * Build the `{ slideId: ScriptBlock[] }` payload embedded in the compiled deck.
 * Slides whose outline carried no body are omitted — an empty section beats apology copy.
 */
export function buildSlideScriptPayload(slides) {
  const out = {}
  for (const slide of slides || []) {
    if (!slide?.id) continue
    const blocks = parseSlideScript(slide.sourceMarkdown)
    if (blocks.length) out[slide.id] = blocks
  }
  return out
}

export const SLIDE_SCRIPT_ELEMENT_ID = 'twSlideScript'

/** Serialise the payload into a script tag safe to sit inside an HTML document. */
export function renderSlideScriptTag(payload) {
  const json = JSON.stringify(payload).replace(/</g, '\\u003c')
  return `<script type="application/json" id="${SLIDE_SCRIPT_ELEMENT_ID}">${json}<\/script>`
}
