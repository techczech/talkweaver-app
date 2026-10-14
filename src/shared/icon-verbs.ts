// Plain view, ticket 13: the verbs behind Command-I. Pure: no DOM, no CodeMirror.
//
//   lineIconState (outline, line)              → what the line carries and whether it can take an icon
//   setLineIcon   (outline, line, icon, known) → { ok, text, change, … } | { ok: false, text, reason, detail }
//   clearLineIcon (outline, line)              → the same
//
// `line` is 0-based, counted on `\n` as the compiler counts (a CRLF line's `\r` is its last
// character and is never touched; a line with a carriage return anywhere else is refused).
//
// WHERE the token goes is the compiler's reading, per kind of line:
//   title       an authored trailing group of the heading line (02-triggers-layout.mjs
//               headingIconGroups). A new token goes after the title's text, before the other
//               trailing groups, as the compiler's own verb writes it (12-outline-edit.mjs
//               headingIconEdit, ported here: with several icon tokens the first is kept).
//   paragraph   the end of the paragraph's LAST line (03-markdown-lexer-core.mjs
//               paragraphIconTokenAt, read on the paragraph's whole text). With the caret on an
//               earlier line of the paragraph that last line is the one written.
//   list item   the end of the item's line (listItemIconTokenAt).
// A new token is one space and `{icon=KEY}` after the last character of the text; a replaced one
// is rewritten in place; a removed one goes with the one space before it. So set then clear on a
// line that had no icon gives back the outline byte for byte.
//
// VERIFY before answering ok, as the layout verbs do (layout-verbs.ts): the new outline is read
// again with the plain view's facts (plain-view-icon-items.ts, the compiler's own tree and lexer)
// and the write is kept only when
//   (a) the line now carries exactly the icon asked for, as a token the compiler consumes (none
//       after a clear), on a top-level row or a paragraph or a title that is a slide of its own;
//   (b) nothing else moved: every other consumed token and hidden span is where it was, every
//       lexer block is the same apart from the one block's icon, the same lines are headings,
//       layout lines, code and notes, every slide is drawn in the same layout, and everything
//       outside the slide is the same;
//   (c) the line's visible text is the same: the slide's title, and the block's text.
// Otherwise the outline comes back unchanged with a reason. If the facts throw, the same.
// (The line edits are icon-verbs-edits.ts; the check is icon-verbs-verify.ts.)
import { listItemIconTokenAt } from '../../compiler/scripts/lib/03-markdown-lexer-core.mjs'
import { headingLineWith, lineWithNewToken, spliceOf, tokenLineWith } from './icon-verbs-edits.ts'
import { isTalkTitle, linesOf, slideOf, verified, type Check, type IconChange, type IconLineKind, type Lines } from './icon-verbs-verify.ts'
import { type LexedBlockFact } from './plain-view-compiler-facts.ts'
import { plainViewFactsOf, type IconItem, type PlainViewFacts } from './plain-view-icon-items.ts'
import { isStructureLine } from './plain-view-outline-lines.ts'

export type { IconChange, IconLineKind }

export type IconVerbRefusal =
  | 'unknown-icon' | 'no-such-line' | 'line-ending' | 'not-here' | 'nested-item' | 'folded-title' | 'section-title'
  | 'ends-in-braces' | 'no-icon' | 'not-verified' | 'facts-failed'

export type IconWrite =
  | {
    ok: true
    /** The new outline (the outline given when `changed` is false). */
    text: string
    changed: boolean
    kind: IconLineKind
    /** 0-based line that holds the token (a paragraph: its last line). */
    line: number
    change: IconChange | null
  }
  | { ok: false; /** The outline as given: nothing is written. */ text: string; reason: IconVerbRefusal; /** What a surface may show. */ detail: string }

export type IconLineState =
  | { ok: true; kind: IconLineKind; /** The icon the line carries, as written; null when none. */ key: string | null }
  | { ok: false; reason: IconVerbRefusal; detail: string }

/** A key the verbs write: a set's prefix and a plain name. Whether the name exists is `known`'s answer. */
export const ICON_KEY_RE = /^(lucide|svgl|tabler):[a-z0-9][a-z0-9-]*$/

const DETAIL: Record<IconVerbRefusal, string> = {
  'unknown-icon': 'That icon is not in the icon sets, so nothing was changed.',
  'no-such-line': 'Nothing was changed.',
  'line-ending': 'This line has an unusual line ending, so nothing was changed.',
  'not-here': 'Nothing was changed.',
  'nested-item': 'Slides show icons on top-level list items only, so nothing was changed.',
  'folded-title': 'This title is drawn inside the slide above it, which shows no title icon. Nothing was changed.',
  'section-title': 'A section title with an icon is drawn as an ordinary slide, so nothing was changed.',
  'ends-in-braces': 'This item has other braces at its end, which the slide may read as an icon. Change it in the Markdown tab.',
  'no-icon': 'This line has no icon.',
  'not-verified': 'The icon could not be placed on this line safely, so nothing was changed.',
  'facts-failed': 'The outline could not be read, so nothing was changed.'
}

const NOT_REMOVED = 'The icon could not be removed from this line safely, so nothing was changed.'
const refuse = (text: string, reason: IconVerbRefusal, detail?: string): IconWrite => ({ ok: false, text, reason, detail: detail ?? DETAIL[reason] })

/** The 0-based line of a document offset, as the verbs count lines. */
export function iconLineAt(text: string, offset: number): number {
  return linesOf(text).at(Math.max(0, Math.min(offset, text.length)))
}

// ── Reading: what is on the line ────────────────────────────────────────────────────────────────

/** The icon item the plain view hides on `line`: a title's or a row's own, or the paragraph's that the line is in. */
function itemOn(facts: PlainViewFacts, lines: Lines, line: number): IconItem | null {
  for (const item of facts.items) {
    const first = lines.at(item.lineFrom)
    if (item.kind !== 'paragraph') { if (first === line) return item; continue }
    if (first <= line && line <= lines.at(item.tokenFrom)) return item
  }
  return null
}

/** The lexer's paragraph and list blocks that were read from `line`. */
function blocksOn(facts: PlainViewFacts, line: number): LexedBlockFact[] {
  return facts.compiler.lexedBlocks().filter((block) => (block.type === 'paragraph' || block.type === 'list') && block.firstLine <= line && line <= block.lastLine)
}

interface Target {
  kind: IconLineKind
  item: IconItem | null
  /** Paragraph and list item with no token yet: the last line a token may be tried on. */
  lastLine: number
}

/** What `line` is for an icon, from the facts of the outline as it stands; or why it takes none. */
function targetOf(facts: PlainViewFacts, lines: Lines, line: number): Target | IconVerbRefusal {
  const { read, compiler } = facts
  if (line < 0 || line >= lines.count) return 'no-such-line'
  const body = lines.body(line)
  if (body.includes('\r')) return 'line-ending'
  if (!body.trim() || read.kinds[line] !== 'outline' || compiler.layoutLines.has(line) || compiler.codeLines.has(line)) return 'not-here'
  if (read.compilerHeading[line]) {
    if (!isStructureLine(read, line)) return 'not-here'
    // A title that is a card, a column or a panel of the slide above draws no icon of its own.
    if (!isTalkTitle(body) && !compiler.slideLayouts.get(line)?.final) return 'folded-title'
    return { kind: 'heading', item: itemOn(facts, lines, line), lastLine: line }
  }
  if (slideOf(facts, line) < 0) return 'not-here'
  const item = itemOn(facts, lines, line)
  if (item) {
    // A row the lexer reads as part of something else (a chart's own rows) is not a list item of the slide.
    if (item.kind === 'heading' || !blocksOn(facts, lines.at(item.tokenFrom)).length) return 'not-here'
    return { kind: item.kind, item, lastLine: lines.at(item.tokenFrom) }
  }
  if (!isStructureLine(read, line)) return 'not-here'
  const blocks = blocksOn(facts, line)
  if (!blocks.length) return 'not-here'
  if (blocks.some((block) => block.type === 'list')) return { kind: 'item', item: null, lastLine: line }
  return { kind: 'paragraph', item: null, lastLine: Math.max(...blocks.map((block) => block.lastLine)) }
}

// ── The verbs ───────────────────────────────────────────────────────────────────────────────────

function facts(text: string): PlainViewFacts | null {
  // Kept by the text (memo-by-text.ts): the editor's own facts for the text as it is, and the facts of the result it then holds.
  try { return plainViewFactsOf(text) } catch { return null }
}

/** Try one line's new text: the outline with it, kept only when it verifies. */
function attempt(text: string, before: PlainViewFacts, lines: Lines, check: Omit<Check, 'change'>, nextBody: string | null): IconWrite | null {
  if (nextBody === null) return null
  const body = lines.body(check.carrier)
  if (nextBody === body) return null
  if (/[\r\n]/.test(nextBody)) return null
  const splice = spliceOf(body, nextBody)
  const base = lines.from(check.carrier)
  const change: IconChange = { from: base + splice.from, to: base + splice.to, insert: splice.insert }
  const next = text.slice(0, change.from) + change.insert + text.slice(change.to)
  const after = facts(next)
  if (!after || !verified(before, after, lines, linesOf(next), { ...check, change })) return null
  return { ok: true, text: next, changed: true, kind: check.kind, line: check.carrier, change }
}

function write(outline: string, line: number, icon: string | null): IconWrite {
  const text = String(outline ?? '')
  const before = facts(text)
  if (!before) return refuse(text, 'facts-failed')
  const lines = linesOf(text)
  const target = targetOf(before, lines, line)
  if (typeof target === 'string') return refuse(text, target)
  const { kind, item } = target
  if (item?.nested) {
    // A nested row's token draws nothing: it can be removed here, not set.
    if (icon) return refuse(text, 'nested-item')
  }
  if (!icon && !item) return refuse(text, 'no-icon')
  const unchanged = (carrier: number): IconWrite => ({ ok: true, text, changed: false, kind, line: carrier, change: null })

  if (kind === 'heading') {
    const next = headingLineWith(lines.body(line), icon)
    if (icon && item?.key === icon && next === lines.body(line)) return unchanged(line)
    const done = attempt(text, before, lines, { kind, line, carrier: line, icon }, next)
    if (done) return done
    // The compiler keeps a heading as a section divider only while it writes no token that
    // decides a slide, and an icon is one: the divider would become a slide of its own.
    if (icon && !item && before.compiler.slideLayouts.get(line)?.divider) return refuse(text, 'section-title')
    return refuse(text, 'not-verified', icon ? undefined : NOT_REMOVED)
  }
  if (item) {
    const carrier = lines.at(item.tokenFrom)
    const body = lines.body(carrier)
    if (body.includes('\r')) return refuse(text, 'line-ending')
    // A nested row is cleared with the checks of a row (its token is the lexer's, drawn or not).
    const next = tokenLineWith(body, item.tokenFrom - lines.from(carrier), icon)
    if (icon && item.key === icon && next === body) return unchanged(carrier)
    if (!icon && next !== null && kind === 'item') {
      // Braces the removed token stood after would end the row: the compiler may then read THEM
      // as the short form of an icon, which the editor cannot tell from text.
      const row = before.compiler.iconTokens.find((token) => token.line === carrier && token.kind === 'item')
      if (!row || listItemIconTokenAt(next.slice(row.indentLength + row.markLength), () => 'any')) return refuse(text, 'ends-in-braces')
    }
    return attempt(text, before, lines, { kind, line, carrier, icon }, next) ?? refuse(text, 'not-verified', icon ? undefined : NOT_REMOVED)
  }
  if (!icon) return refuse(text, 'no-icon')
  // No token yet: after the text of the row, or of the paragraph's last line. The lexer says which
  // line that is; a line it does not end the paragraph on is not written.
  for (let carrier = line; carrier <= target.lastLine; carrier += 1) {
    const body = lines.body(carrier)
    if (!body.trim() || body.includes('\r') || !isStructureLine(before.read, carrier) || before.compiler.layoutLines.has(carrier)) continue
    const next = lineWithNewToken(body, icon)
    if (kind === 'item') {
      // The lexer's own reading of the row with the token on it: where its text starts, and its depth.
      const end = lines.to(carrier)
      const row = facts(text.slice(0, lines.from(carrier)) + next + text.slice(end))?.compiler.iconTokens.find((token) => token.line === carrier && token.kind === 'item')
      if (!row) return refuse(text, 'not-verified')
      if (!row.top) return refuse(text, 'nested-item')
      // A row that already ends in braces: the compiler may read them as the short form of an
      // icon (`{brain}`), which the editor cannot tell from text without the icon sets.
      if (listItemIconTokenAt(body.slice(row.indentLength + row.markLength), () => 'any')) return refuse(text, 'ends-in-braces')
    }
    const done = attempt(text, before, lines, { kind, line, carrier, icon }, next)
    if (done) return done
  }
  return refuse(text, 'not-verified')
}

/**
 * Put `icon` on the line: a new token, or the line's token replaced in place. `known` says whether
 * a key is in the app's icon sets; a key it does not know, or one not of the form `set:name`, is
 * refused, so no free text reaches the outline.
 */
export function setLineIcon(outline: string, line: number, icon: string, known: (key: string) => boolean): IconWrite {
  const text = String(outline ?? '')
  try {
    if (typeof icon !== 'string' || !ICON_KEY_RE.test(icon) || !known(icon)) return refuse(text, 'unknown-icon')
    return write(text, line, icon)
  } catch {
    return refuse(text, 'facts-failed')
  }
}

/** Remove the line's icon token and the one space before it. */
export function clearLineIcon(outline: string, line: number): IconWrite {
  const text = String(outline ?? '')
  try {
    return write(text, line, null)
  } catch {
    return refuse(text, 'facts-failed')
  }
}

const PROBE = 'lucide:circle'
const PROBE_OTHER = 'lucide:square'

/**
 * What Command-I finds on the line: its kind and the icon it carries, or why it takes none. A line
 * "can take" an icon exactly when a set would verify (it is tried, with an icon the line does not
 * carry, and nothing is kept).
 */
export function lineIconState(outline: string, line: number): IconLineState {
  const text = String(outline ?? '')
  try {
    const before = facts(text)
    if (!before) return { ok: false, reason: 'facts-failed', detail: DETAIL['facts-failed'] }
    const target = targetOf(before, linesOf(text), line)
    if (typeof target === 'string') return { ok: false, reason: target, detail: DETAIL[target] }
    const key = target.item?.key ?? null
    const tried = write(text, line, key === PROBE ? PROBE_OTHER : PROBE)
    if (!tried.ok) return { ok: false, reason: tried.reason, detail: tried.detail }
    return { ok: true, kind: target.kind, key }
  } catch {
    return { ok: false, reason: 'facts-failed', detail: DETAIL['facts-failed'] }
  }
}
