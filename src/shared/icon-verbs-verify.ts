// Plain view, ticket 13: the check the icon verbs (icon-verbs.ts) make before they answer ok.
// The outline is read with the plain view's facts before and after the one edit, and the edit is
// kept only when conditions (a), (b) and (c) of the note in icon-verbs.ts hold. Pure.
import { type CompilerIconToken } from './plain-view-compiler-facts.ts'
import { type IconItem, type PlainViewFacts } from './plain-view-icon-items.ts'

export type IconLineKind = 'heading' | 'paragraph' | 'item'

/** One replacement in the outline, in document offsets: what the editor dispatches. */
export interface IconChange { from: number; to: number; insert: string }

export interface Lines {
  count: number
  /** Offset of the line's first character, and of its end (before a CRLF's `\r`). */
  from: (line: number) => number
  to: (line: number) => number
  body: (line: number) => string
  at: (offset: number) => number
}

export function linesOf(text: string): Lines {
  const starts = [0]
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1)
  const rawEnd = (line: number): number => (line + 1 < starts.length ? starts[line + 1] - 1 : text.length)
  const to = (line: number): number => {
    const end = rawEnd(line)
    return end > starts[line] && text[end - 1] === '\r' ? end - 1 : end
  }
  return {
    count: starts.length,
    from: (line) => starts[line],
    to,
    body: (line) => text.slice(starts[line], to(line)),
    at: (offset) => {
      let lo = 0
      let hi = starts.length - 1
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (starts[mid] <= offset) lo = mid; else hi = mid - 1
      }
      return lo
    }
  }
}

/** The `##`–`######` heading whose slide holds `line` (the heading line itself included), or -1. */
export function slideOf(facts: PlainViewFacts, line: number): number {
  let found = -1
  for (const [heading, slide] of facts.compiler.slideLayouts) {
    if (heading <= line && line < slide.endLine && heading > found) found = heading
  }
  return found
}

export const isTalkTitle = (body: string): boolean => /^#\s/.test(body)

const ICON_FIELDS = new Set(['icon', 'iconOverrides'])
/** A lexer block without the icons it carries. */
function withoutIcons(json: string): string {
  return JSON.stringify(JSON.parse(json), (key, value) => (ICON_FIELDS.has(key) ? undefined : value))
}

const sameSet = (a: ReadonlySet<number>, b: ReadonlySet<number>): boolean => a.size === b.size && [...a].every((value) => b.has(value))
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const tokenFact = (token: CompilerIconToken): unknown[] => [token.kind, token.line, token.firstLine, token.key, token.icon, token.top, token.ordered, token.indentLength, token.markLength]

export interface Check {
  kind: IconLineKind
  /** The line asked about, and the line written. */
  line: number
  carrier: number
  /** The icon the carrier must now carry; null after a clear. */
  icon: string | null
  /** The edit in the outline as it was: [from, to) became `insert`. */
  change: IconChange
}

/** Conditions (a), (b) and (c) of the note at the top, between the facts before and after one edit. */
export function verified(before: PlainViewFacts, after: PlainViewFacts, linesBefore: Lines, linesAfter: Lines, check: Check): boolean {
  const { kind, line, carrier, icon, change } = check
  const b = before.compiler
  const a = after.compiler
  // The same lines are outline, headings, layout lines and code.
  if (!same(before.read.kinds, after.read.kinds) || !same(before.read.partial, after.read.partial) || !same(before.read.compilerHeading, after.read.compilerHeading)) return false
  if (!sameSet(b.layoutLines, a.layoutLines) || !sameSet(b.codeLines, a.codeLines) || !same(before.unlocated, after.unlocated)) return false

  // (a) and (b) on the tokens the lexer strips.
  const elsewhere = (tokens: readonly CompilerIconToken[]): unknown[] => tokens.filter((token) => token.line !== carrier).map(tokenFact)
  if (!same(elsewhere(b.iconTokens), elsewhere(a.iconTokens))) return false
  const here = a.iconTokens.filter((token) => token.line === carrier)
  if (kind === 'heading' || !icon) { if (here.length) return false }
  else if (here.length !== 1 || here[0].kind !== kind || here[0].key !== icon || here[0].icon !== icon || !here[0].top || here[0].firstLine > line) return false

  // (a) and (b) on what the plain view hides: every other item is where it was, moved by the edit's length.
  const shift = change.insert.length - (change.to - change.from)
  const moved = (at: number): number => (at >= change.to ? at + shift : at)
  const carrierFrom = linesBefore.from(carrier)
  const onCarrier = (item: IconItem, lines: Lines): boolean => lines.at(item.tokenFrom) === carrier && (kind === 'heading') === (item.kind === 'heading')
  const others = (items: readonly IconItem[], lines: Lines, map: (at: number) => number): unknown[] => items.filter((item) => !onCarrier(item, lines)).map((item) => ({
    ...item, lineFrom: map(item.lineFrom), textFrom: map(item.textFrom), from: map(item.from), to: map(item.to), textEnd: map(item.textEnd), tokenFrom: map(item.tokenFrom), markFrom: map(item.markFrom),
    spans: item.spans.map((span) => ({ from: map(span.from), tokenFrom: map(span.tokenFrom), to: map(span.to) }))
  }))
  if (!same(others(before.items, linesBefore, moved), others(after.items, linesAfter, (at) => at))) return false
  const mine = after.items.filter((item) => onCarrier(item, linesAfter))
  if (!icon) { if (mine.length) return false }
  else {
    if (mine.length !== 1 || mine[0].kind !== kind || mine[0].key !== icon || mine[0].nested || mine[0].spans.length !== 1) return false
    if (kind === 'heading' ? mine[0].lineFrom !== carrierFrom : linesAfter.at(mine[0].lineFrom) > line) return false
  }

  // (b) and (c) on the lexer's blocks: the same blocks from the same lines; one block's icon changed, or none.
  const blocksBefore = b.lexedBlocks()
  const blocksAfter = a.lexedBlocks()
  if (blocksBefore.length !== blocksAfter.length) return false
  let differing = 0
  for (let k = 0; k < blocksBefore.length; k += 1) {
    const was = blocksBefore[k]
    const now = blocksAfter[k]
    if (was.type !== now.type || was.firstLine !== now.firstLine || was.lastLine !== now.lastLine) return false
    if (was.json === now.json) continue
    differing += 1
    if (kind === 'heading' || differing > 1) return false
    if (was.type !== (kind === 'item' ? 'list' : 'paragraph') || was.firstLine > line || was.lastLine < carrier) return false
    if (withoutIcons(was.json) !== withoutIcons(now.json)) return false
  }

  // (b) every slide is drawn as it was and its other tokens are the same; (c) the title is the same.
  if (b.slideLayouts.size !== a.slideLayouts.size) return false
  for (const [heading, was] of b.slideLayouts) {
    const now = a.slideLayouts.get(heading)
    if (!now || !same([was.endLine, was.level, was.decision, was.listStyle, was.final, was.children, was.keptChildren, was.foldKind], [now.endLine, now.level, now.decision, now.listStyle, now.final, now.children, now.keptChildren, now.foldKind])) return false
    const plain = (tokens: typeof was.tokens): unknown[] => tokens.filter((token) => !(token.line === carrier && token.raw.startsWith('icon='))).map((token) => [token.line, token.source])
    if (!same(plain(was.tokens), plain(now.tokens))) return false
  }
  if (kind === 'heading' && isTalkTitle(linesBefore.body(carrier))) {
    // [title, title icon, …]: everything but the talk title's icon.
    const was = JSON.parse(b.outsideSlide(-1)) as unknown[]
    const now = JSON.parse(a.outsideSlide(-1)) as unknown[]
    const titleIcon = (now[1] as { icon?: string } | null)?.icon ?? null
    return titleIcon === icon && same([was[0], ...was.slice(2)], [now[0], ...now.slice(2)])
  }
  const slide = slideOf(before, carrier)
  if (slide < 0 || slideOf(after, carrier) !== slide || b.outsideSlide(slide) !== a.outsideSlide(slide)) return false
  // [level, title, title icon, id, content lines, notes]
  const was = JSON.parse(b.slideContent(slide)) as unknown[]
  const now = JSON.parse(a.slideContent(slide)) as unknown[]
  if (!same([was[0], was[1], was[3], was[5]], [now[0], now[1], now[3], now[5]])) return false
  const wasLines = was[4] as string[]
  const nowLines = now[4] as string[]
  if (wasLines.length !== nowLines.length) return false
  const changedLines = wasLines.filter((value, k) => value !== nowLines[k]).length
  if (kind === 'heading') return changedLines === 0 && now[2] === (icon ?? '')
  return changedLines === 1 && was[2] === now[2]
}
