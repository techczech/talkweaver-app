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
  parseChartFenceOpeningLine,
  parseMarkdownFenceOpeningLine
} from './03-object-token.mjs'
import { parseOutlineTree } from './14-outline-tree.mjs'
import { blankHtmlComments } from './html-comments.mjs'

// Fence languages the slide renders as a picture rather than as code (06-block-renderers.mjs).
const DIAGRAM_FENCE_LANGS = new Set(['mermaid', 'svg'])

/** @typedef {{type:'list',items:{depth:number,text:string,pair?:string}[]}
 *          | {type:'p'|'quote'|'attrib',text:string}
 *          | {type:'media',alt:string}
 *          | {type:'diagram'}
 *          | {type:'code',text:string}
 *          | {type:'table',rows:string[][]}} ScriptBlock */

/**
 * The audience-visible body lines of one slide's outline source: speaker notes, the heading line,
 * its Trigger line and HTML comments removed.
 *
 * Speaker notes must NEVER reach this payload — it is stamped into every compiled deck and copied
 * into the handout, the share page and the venue page (leak found 2026-09-28). `slide.sourceMarkdown`
 * is the slide's raw source slice, notes included, so notes are removed here by the compiler's own
 * outline parser rather than a second recogniser that could drift from it: the same comment
 * blanking as adaptMarkdownOutlineV2 (blankHtmlComments, html-comments.mjs), then parseOutlineTree
 * (14-outline-tree.mjs), which routes `:::notes` … `:::` to notesLines with fences guarded
 * (backticks and tildes) and an unclosed block running to the end of the slide. Only contentLines
 * are kept. The Links slide reads slide source through this too (collectDeckLinks,
 * 08-source-adapters.mjs), with `headings: true` because a link in a slide title is on the slide.
 *
 * @param {string} sourceMarkdown one slide's outline source, heading line included
 * @param {{headings?: boolean}} [options] headings: also keep each heading line (comment-blanked),
 *   before that node's content; the Trigger line and the `#` deck-title line stay out
 * @returns {string[]}
 */
export function audienceSourceLines(sourceMarkdown, { headings = false } = {}) {
  const out = []
  const visit = (node) => {
    if (headings && node.headingLine) out.push(node.headingLine)
    out.push(...node.contentLines)
    for (const child of node.children) visit(child)
  }
  visit(audienceTree(sourceMarkdown))
  return out
}

/** The outline tree of one slide's source, HTML comments blanked (see audienceSourceLines). */
function audienceTree(sourceMarkdown) {
  return parseOutlineTree(blankHtmlComments(String(sourceMarkdown || ''))).root
}

/**
 * @param {string} sourceMarkdown one slide's outline source, heading line included. For a slide
 *   that folds its `####` children (columns, compare, cards…) this is the wider slice covering
 *   them (`scriptSourceMarkdown`): each child's title is drawn on the slide, so it becomes a
 *   paragraph before that child's text; its notes stay out like any other notes.
 * @returns {ScriptBlock[]}
 */
export function parseSlideScript(sourceMarkdown) {
  const blocks = []
  let chartFenceOpening = null
  // A content code fence is one `code` block, its lines verbatim (dedented by the fence's own
  // indent), never re-read as bullets or paragraphs. A fence the slide draws as a picture
  // (```mermaid, ```svg: 06-block-renderers.mjs) is one `diagram` block instead, never its source.
  let codeFence = null
  const flushCode = () => {
    const text = codeFence.lines.join('\n').replace(/\n+$/, '')
    if (text.trim()) blocks.push(codeFence.diagram ? { type: 'diagram' } : { type: 'code', text })
    codeFence = null
  }

  const addLine = (raw) => {
    const line = raw.trim()
    if (codeFence) {
      if (isMarkdownFenceClosingLine(line, codeFence.opening)) flushCode()
      else codeFence.lines.push(raw.replace(/\r$/, '').replace(codeFence.indent, ''))
      return
    }
    if (!line) return
    if (chartFenceOpening) {
      if (isMarkdownFenceClosingLine(line, chartFenceOpening)) {
        chartFenceOpening = null
        return
      }
    } else {
      const fence = parseChartFenceOpeningLine(line)
      if (fence?.chart) {
        chartFenceOpening = fence
        return
      }
      const opening = parseMarkdownFenceOpeningLine(line)
      if (opening) {
        const indent = raw.match(/^[ \t]*/)[0].length
        codeFence = {
          opening,
          lines: [],
          indent: new RegExp(`^[ \\t]{0,${indent}}`),
          // The lexer's lang is the whole info string, lowercased (03-markdown-lexer.mjs, takeFence).
          diagram: DIAGRAM_FENCE_LANGS.has(opening.info.toLowerCase())
        }
        return
      }
    }
    // A trigger-only line ({list}{reveal}) is authoring syntax, not content.
    if (/^(\{[^}]*\}\s*)+$/.test(line)) return

    const img = line.match(/^!\[([^\]]*)\]\(([^)]*)\)/)
    if (img) { blocks.push({ type: 'media', alt: img[1] || '' }); return }

    if (line.startsWith('>')) { blocks.push({ type: 'quote', text: line.replace(/^>\s?/, '') }); return }

    if (/^[—–-]\s+\S/.test(line) && blocks.at(-1)?.type === 'quote') {
      blocks.push({ type: 'attrib', text: line.replace(/^[—–-]\s+/, '') })
      return
    }

    if (line.startsWith('|')) {
      const cells = line.split('|').map((c) => c.trim()).filter((c) => c.length)
      if (!cells.length || cells.every((c) => /^:?-{2,}:?$/.test(c))) return
      const last = blocks.at(-1)
      if (last?.type === 'table') last.rows.push(cells)
      else blocks.push({ type: 'table', rows: [cells] })
      return
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
      return
    }

    blocks.push({ type: 'p', text: line })
  }

  // Depth 0 is the synthetic root, depth 1 the slide's own heading (its title is the phone
  // view's heading, not script). Deeper nodes appear only in a folded slide's slice.
  const visit = (node, depth) => {
    if (depth >= 2) {
      // Each folded child is its own block on the slide: a fence left open in the text before it
      // ends here, as the lexer ends it, and never swallows the child's title or text.
      if (codeFence) flushCode()
      chartFenceOpening = null
      if (node.title) blocks.push({ type: 'p', text: node.title })
    }
    for (const raw of node.contentLines) addLine(raw)
    for (const child of node.children) visit(child, depth + 1)
  }
  visit(audienceTree(sourceMarkdown), 0)
  if (codeFence) flushCode()

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
    // A slide that folded its `####` children (columns, compare, cards…) carries the wider slice
    // covering them as scriptSourceMarkdown (08-source-adapters.mjs, absorbFoldedChildren).
    const blocks = parseSlideScript(typeof slide.scriptSourceMarkdown === 'string'
      ? slide.scriptSourceMarkdown
      : slide.sourceMarkdown)
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
