// The writes behind an object card's header actions (ADR-0042 completion, root plan 2026-10-28): Remove
// takes the card's lines out; Replace file puts a new file reference in a page, simulation or clip line,
// keeping every other byte of the line; Place earlier views writes a web page's earlier saved views under it. Each plan is made against the text as it is now and refuses when
// the card's bytes are no longer where the card was read (the card moved or was edited meanwhile); the
// caller writes the one change as one undo step. Open, Reveal and Copy markup write nothing and are not
// planned here. Pure: no DOM.
import { CAPTURE_VIEWS_MARKER, embedLinePageUrl, readCaptureLine } from '../../../compiler/scripts/lib/live-page-capture-markup.mjs'
import { normaliseCaptureUrl } from '../../../compiler/scripts/lib/live-page-captures.mjs'

/** The card as it was read: where it starts and ends, and its bytes then. */
export type CardRef = { from: number; to: number; source: string }

export type CardChangePlan =
  | { ok: true; change: { from: number; to: number; insert: string } }
  | { ok: false; reason: string }

const STALE = 'The card changed since it was read, so nothing was written. Try again.'

/** Where the card is in `text` now: at its old place, else its only exact copy; null when gone or ambiguous. */
export function locateCard(text: string, card: CardRef): CardRef | null {
  if (text.slice(card.from, card.to) === card.source) return card
  const first = text.indexOf(card.source)
  if (first < 0 || text.indexOf(card.source, first + 1) >= 0) return null
  return { from: first, to: first + card.source.length, source: card.source }
}

/**
 * Remove the card's lines: the card, its line ending, and one blank line around it when it stood
 * between blank lines (so no double gap is left). Text on the card's lines outside it is never touched.
 */
export function planCardRemoval(text: string, card: CardRef): CardChangePlan {
  const at = locateCard(text, card)
  if (!at) return { ok: false, reason: STALE }
  let from = at.from
  // A card that runs to its own line ending (a page card does) is measured without it.
  let to = at.to - (at.source.endsWith('\r\n') ? 2 : at.source.endsWith('\n') ? 1 : 0)
  const lineStart = text.lastIndexOf('\n', from - 1) + 1
  const lineEndAt = text.indexOf('\n', to)
  const lineEnd = lineEndAt < 0 ? text.length : lineEndAt
  if (text.slice(lineStart, from).trim() || text.slice(to, lineEnd).replace(/\r$/, '').trim()) {
    return { ok: true, change: { from, to, insert: '' } }
  }
  from = lineStart
  to = lineEndAt < 0 ? text.length : lineEndAt + 1
  const blankAt = (pos: number): number | null => {
    const end = text.indexOf('\n', pos)
    return end >= 0 && /^\r?$/.test(text.slice(pos, end)) ? end + 1 : null
  }
  const before = from > 0 ? text.lastIndexOf('\n', from - 2) + 1 : -1
  const blankBefore = before >= 0 && /^\r?$/.test(text.slice(before, from - 1))
  const afterBlankEnd = blankAt(to)
  if (blankBefore && afterBlankEnd !== null) to = afterBlankEnd
  else if (to >= text.length && blankBefore && from > 0) from = before
  return { ok: true, change: { from, to, insert: '' } }
}

const FILE_LINE_RE = /^(\s*\[(?:Embed|Simulation|Video)\s*:\s*)([^\]]*?)(\s*\].*)$/i

/** Put `nextSrc` in place of the file the card's first line names; every other byte of the line stays. */
export function planCardFileReplace(text: string, card: CardRef, nextSrc: string): CardChangePlan {
  if (!nextSrc || /[\]\r\n]/.test(nextSrc)) return { ok: false, reason: 'That file name cannot go in a page line.' }
  const at = locateCard(text, card)
  if (!at) return { ok: false, reason: STALE }
  const firstEnd = at.source.indexOf('\n')
  const first = (firstEnd < 0 ? at.source : at.source.slice(0, firstEnd)).replace(/\r$/, '')
  const m = FILE_LINE_RE.exec(first)
  if (!m || !m[2].trim()) return { ok: false, reason: 'This card does not name a file to replace.' }
  const from = at.from + m[1].length
  return { ok: true, change: { from, to: from + m[2].length, insert: nextSrc } }
}

/**
 * Place a web page's earlier saved views on its card (the views the deck shows from their records while
 * the page has neither the saved-views marker nor a {capture} line): the marker and one {capture} line
 * per view go directly under the card's page line, with its indentation and the text's line ending, so
 * the deck then shows exactly these lines and each view can be removed on its own. The card is the one
 * that was read (its place or its only exact copy), so two pages on a slide, or one address on two
 * slides, are never confused. Refused when the card has a marker or a {capture} line already, names
 * another address, or `lines` holds anything but saved-view capture lines.
 */
export function planPlaceEarlierViews(text: string, card: CardRef, pageUrl: string, lines: readonly string[]): CardChangePlan {
  const at = locateCard(text, card)
  if (!at) return { ok: false, reason: STALE }
  const cardLines = at.source.replace(/\r?\n$/, '').split(/\r?\n/)
  const first = cardLines[0] ?? ''
  if (embedLinePageUrl(first.trim()) !== normaliseCaptureUrl(pageUrl) || !normaliseCaptureUrl(pageUrl)) {
    return { ok: false, reason: 'This card is not that web page.' }
  }
  if (cardLines.slice(1).some((line) => line.trim())) {
    return { ok: false, reason: 'This page already has saved views in the outline, so nothing was placed.' }
  }
  if (!lines.length || !lines.every((line) => readCaptureLine(line.trim())?.savedView)) {
    return { ok: false, reason: 'There are no earlier saved views to place.' }
  }
  const eol = /\r\n/.test(text) ? '\r\n' : '\n'
  const indent = (first.match(/^\s*/) ?? [''])[0]
  const added = [CAPTURE_VIEWS_MARKER, ...lines.map((line) => line.trim())].map((line) => `${indent}${line}`)
  const firstEnd = at.from + first.length
  return { ok: true, change: { from: firstEnd, to: firstEnd, insert: added.map((line) => `${eol}${line}`).join('') } }
}
