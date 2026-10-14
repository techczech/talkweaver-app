// Layout Doctor, plain view ticket 15: a title's icon left on the layout line. Pure: no DOM, no
// CodeMirror.
//
// Until the save-time tidy-up learned to leave a title's own icon on the heading (outline-normalize.ts
// headingTail), it moved `### Title {icon=lucide:star}` to `### Title` / `{icon=lucide:star}`. The
// compiler draws a title's icon from the heading line only (02-triggers-layout.mjs headingIconGroups,
// 14-outline-tree.mjs node.titleIcon): on the layout line the token sets the slide's `icon` attr,
// which no layout and no renderer reads, so nothing is drawn.
//
//   strandedTitleIcons (outline)              → the titles whose icon is on their layout line
//   restoreTitleIcon   (outline, headingLine) → { ok, text, … } | { ok: false, text, reason, detail }
//   restoreScannedTitleIcon (outline, scanned, finding) → the same, for a surface's click: only on the
//                        exact text the finding was read from, and only when that text is settled
//   applyScannedTitleIconRestore (apply, scan, finding) → the click, through the one-writer seam
//
// `headingLine` is 0-based, counted on `\n` (a CRLF line's `\r` is its last character and is never
// touched).
//
// A title is reported when ALL of this holds, by the compiler's own reading of the outline
// (plain-view-compiler-facts.ts):
//   - the heading is a slide of its own (not a card, a column or a carousel item of the slide above,
//     which draws no title icon), and nothing is written in braces after its title;
//   - the first line under it that is not blank is its layout line, read whole (no HTML comment on
//     either line);
//   - of all the tokens the compiler folds into the slide exactly one sets `icon`, and it stands
//     alone in a group of that layout line, as `icon=KEY` with a KEY the icon verbs write
//     (icon-verbs.ts ICON_KEY_RE). `{icon=}`, `{icon:…}`, a bare name and an icon written with another
//     token in its braces are left alone.
//
// THE MOVE: the token goes after the title's text as the icon verbs write it (icon-verbs-edits.ts
// headingLineWith: one space and `{icon=KEY}`), and its group leaves the layout line with the
// spaces on one side of it; a layout line that held nothing else is removed with its line ending.
//
// VERIFY before answering ok, as the icon verbs do: the outline is read again and the move is kept
// only when the slide's title now has that icon and nothing else changed: the same slides in the
// same layouts with the same other tokens and the same attrs, the same blocks, the same content and
// notes, the same warnings. Otherwise the outline comes back unchanged with a reason.
import { blankHtmlComments } from '../../compiler/scripts/lib/html-comments.mjs'
import { headingBraceGroups } from '../../compiler/scripts/lib/02-triggers-layout.mjs'
import { parseOutlineTree, type OutlineTreeNode } from '../../compiler/scripts/lib/14-outline-tree.mjs'
import { TRIGGER_LINE_RE, tokenizeTriggerBody } from '../../compiler/scripts/lib/trigger-tokenizer.mjs'
import { ICON_KEY_RE } from './icon-verbs.ts'
import { headingLineWith } from './icon-verbs-edits.ts'
import { linesOf, type IconChange, type Lines } from './icon-verbs-verify.ts'
import { outlineSaveChange } from './outline-save-changes.ts'
import { compilerFactsOf, type CompilerFacts, type SlideToken } from './plain-view-compiler-facts.ts'
import { outlineCompilerBody } from './slide-source-text.ts'

export interface StrandedTitleIcon {
  /** 0-based lines of the heading and of its layout line. */
  headingLine: number
  triggerLine: number
  /** The icon, and the title as written. */
  key: string
  title: string
  /** The token's group in the layout line, braces included. */
  groupFrom: number
  groupTo: number
}

export type TitleIconRestoreRefusal = 'nothing-to-move' | 'moved-on' | 'unsettled' | 'not-verified' | 'facts-failed'

export type TitleIconRestore =
  | {
    ok: true
    /** The new outline. */
    text: string
    headingLine: number
    key: string
    /** The two replacements in the outline as it was, the later one first. */
    changes: IconChange[]
  }
  | { ok: false; /** The outline as given: nothing is written. */ text: string; reason: TitleIconRestoreRefusal; /** What a surface may show. */ detail: string }

/** The Doctor's words for the finding, and for its button. */
export const STRANDED_TITLE_ICON_MESSAGE = 'This slide\'s icon is on the layout line, so it is not drawn on the title.'
export const STRANDED_TITLE_ICON_ACTION = 'Move it to the title'

const DETAIL: Record<TitleIconRestoreRefusal, string> = {
  'nothing-to-move': 'This title has no icon on its layout line, so nothing was changed.',
  'moved-on': 'The outline changed before the icon was moved, so nothing was changed.',
  'unsettled': 'This talk has tidy-ups waiting for its next save, so nothing was changed. Make any edit to the talk, wait a moment, then try again.',
  'not-verified': 'The icon could not be moved to the title safely, so nothing was changed.',
  'facts-failed': 'The outline could not be read, so nothing was changed.'
}
const refuse = (text: string, reason: TitleIconRestoreRefusal): TitleIconRestore => ({ ok: false, text, reason, detail: DETAIL[reason] })

const setsIcon = (token: Pick<SlideToken, 'raw' | 'attrs'>): boolean => Object.prototype.hasOwnProperty.call(token.attrs, 'icon') || /^icon[=:]/.test(token.raw)

/** The one `icon=KEY` group of a layout line as written, when it holds no other icon token. */
function lonelyIconGroup(body: string): { key: string; groupFrom: number; groupTo: number } | null {
  let found: { key: string; groupFrom: number; groupTo: number } | null = null
  for (const group of body.matchAll(/\{([^}]*)\}/g)) {
    const tokens = tokenizeTriggerBody(group[1]).filter((token) => token.raw)
    const icons = tokens.filter((token) => /^icon[=:]/.test(token.raw))
    if (!icons.length) continue
    if (found || tokens.length !== 1 || !icons[0].raw.startsWith('icon=')) return null
    const key = icons[0].raw.slice(5)
    if (!ICON_KEY_RE.test(key)) return null
    found = { key, groupFrom: group.index, groupTo: group.index + group[0].length }
  }
  return found
}

/** By the text alone: headings with nothing in braces whose next line that is not blank is a layout line with one icon group. */
function candidates(lines: Lines): StrandedTitleIcon[] {
  const out: StrandedTitleIcon[] = []
  for (let line = 0; line < lines.count; line += 1) {
    const body = lines.body(line)
    const heading = body.match(/^#{2,6}\s+(.+)/)
    if (!heading || body.includes('\r') || headingBraceGroups(heading[1]).length) continue
    let under = line + 1
    while (under < lines.count && !lines.body(under).trim()) under += 1
    if (under >= lines.count) continue
    const layout = lines.body(under)
    if (layout.includes('\r') || !TRIGGER_LINE_RE.test(layout.trim())) continue
    const icon = lonelyIconGroup(layout)
    if (icon) out.push({ headingLine: line, triggerLine: under, title: heading[1].trim(), ...icon })
  }
  return out
}

/** The compiler reads the candidate as the text does: a slide of its own, its layout line, one icon token. */
function holds(facts: CompilerFacts, lines: Lines, at: StrandedTitleIcon): boolean {
  const slide = facts.slideLayouts.get(at.headingLine)
  if (!slide?.final) return false
  if (facts.bodyLines[at.headingLine] !== lines.body(at.headingLine) || facts.bodyLines[at.triggerLine] !== lines.body(at.triggerLine)) return false
  if (!facts.layoutLines.has(at.triggerLine) || facts.layoutLineHeading.get(at.triggerLine) !== at.headingLine) return false
  const icons = slide.tokens.filter(setsIcon)
  return icons.length === 1 && icons[0].line === at.triggerLine && icons[0].raw === `icon=${at.key}`
}

/** Every title whose icon is on its layout line, in line order. Empty when the outline cannot be read. */
export function strandedTitleIcons(outline: string): StrandedTitleIcon[] {
  const text = String(outline ?? '')
  if (!text.includes('icon=')) return []
  try {
    const lines = linesOf(text)
    const found = candidates(lines)
    if (!found.length) return []
    const facts = compilerFactsOf(text)
    return found.filter((at) => holds(facts, lines, at))
  } catch {
    return []
  }
}

// ── The check ───────────────────────────────────────────────────────────────────────────────────

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const sorted = (attrs: Record<string, unknown>): unknown[] => Object.keys(attrs).sort().map((key) => [key, attrs[key]])

interface TreeRead { warnings: string[]; attrs: Map<number, unknown[]> }
/** The compiler's tree of the outline: its warnings, and each heading's folded attrs by its 0-based line. */
function treeRead(text: string): TreeRead {
  const tree = parseOutlineTree(outlineCompilerBody(text, blankHtmlComments).body)
  const attrs = new Map<number, unknown[]>()
  const walk = (node: OutlineTreeNode): void => { attrs.set(node.sourceLine - 1, sorted(node.attrs)); node.children.forEach(walk) }
  tree.root.children.forEach(walk)
  return { warnings: tree.warnings, attrs }
}

/**
 * The move of `at`'s icon from `was` to `now` changed one thing: the slide's title has the icon.
 * `removed`: the layout line went, so every later line is one line up.
 */
export function titleIconMoveVerified(was: string, now: string, at: StrandedTitleIcon, removed: boolean): boolean {
  const b = compilerFactsOf(was)
  const a = compilerFactsOf(now)
  const up = (line: number): number => (removed && line > at.triggerLine ? line - 1 : line)
  const inOrder = (lines: Iterable<number>): number[] => [...lines].sort((x, y) => x - y)
  const ups = (lines: Iterable<number>): number[] => inOrder([...lines].map(up))

  // The same lines are layout lines and code, and the same icons are on paragraphs and list items.
  const layoutWas = [...b.layoutLines].filter((line) => !(removed && line === at.triggerLine))
  if (!same(ups(layoutWas), inOrder(a.layoutLines)) || !same(ups(b.codeLines), inOrder(a.codeLines))) return false
  if (!same(b.iconTokens.map((token) => ({ ...token, line: up(token.line), firstLine: up(token.firstLine) })), a.iconTokens)) return false
  const blocks = (facts: CompilerFacts, map: (line: number) => number): unknown[] => facts.lexedBlocks().map((block) => [block.type, map(block.firstLine), map(block.lastLine), block.json])
  if (!same(blocks(b, (line) => (line < 0 ? line : up(line))), blocks(a, (line) => line))) return false

  // Every slide is drawn as it was, from the same other tokens.
  if (!same(ups(b.slideLayouts.keys()), inOrder(a.slideLayouts.keys()))) return false
  for (const [heading, slideWas] of b.slideLayouts) {
    const slideNow = a.slideLayouts.get(up(heading))
    if (!slideNow) return false
    const drawn = (slide: typeof slideWas, map: (line: number) => number): unknown[] => [map(slide.endLine), slide.level, slide.decision, slide.listStyle, slide.final, slide.children.map(map), slide.keptChildren.map(map), slide.foldKind, slide.authored]
    if (!same(drawn(slideWas, up), drawn(slideNow, (line) => line))) return false
    const mine = heading === at.headingLine
    const others = (tokens: readonly SlideToken[], map: (line: number) => number): unknown[] => tokens.filter((token) => !(mine && setsIcon(token))).map((token) => [map(token.line), token.source, token.onHeading])
    if (!same(others(slideWas.tokens, up), others(slideNow.tokens, (line) => line))) return false
    if (!mine) continue
    const icons = slideNow.tokens.filter(setsIcon)
    if (!slideNow.final || icons.length !== 1 || !icons[0].onHeading || icons[0].raw !== `icon=${at.key}`) return false
  }

  // The slide: the same title, id, content and notes, and now the icon. Everything outside it: the same.
  // (outsideSlide reads the frontmatter's title and deck defaults only: enough here, because the move is two edits inside one slide's heading and layout line and cannot reach the frontmatter.)
  if (b.outsideSlide(at.headingLine) !== a.outsideSlide(at.headingLine)) return false
  // [level, title, title icon, id, content lines, notes]
  const slideWas = JSON.parse(b.slideContent(at.headingLine) || 'null') as unknown[] | null
  const slideNow = JSON.parse(a.slideContent(at.headingLine) || 'null') as unknown[] | null
  if (!slideWas || !slideNow || slideWas[2] !== '' || slideNow[2] !== at.key) return false
  if (!same([slideWas[0], slideWas[1], slideWas[3], slideWas[4], slideWas[5]], [slideNow[0], slideNow[1], slideNow[3], slideNow[4], slideNow[5]])) return false

  // The compiler's tree: every heading's attrs are the same (the slide's `icon` attr is now set from
  // its heading), and so are the warnings (a level gap is named by its line).
  const treeWas = treeRead(was)
  const treeNow = treeRead(now)
  if (!same([...treeWas.attrs].map(([line, attrs]) => [up(line), attrs]), [...treeNow.attrs])) return false
  const warned = (warning: string): string => warning.replace(/^heading-level-gap:(\d+)$/, (_all, line: string) => `heading-level-gap:${up(Number(line) - 1) + 1}`)
  return same(treeWas.warnings.map(warned), treeNow.warnings)
}

// ── The move ────────────────────────────────────────────────────────────────────────────────────

/** A layout line without one of its groups: the group goes with the spaces after it when it is first, before it otherwise. */
function withoutGroup(body: string, groupFrom: number, groupTo: number): string {
  let from = groupFrom
  let to = groupTo
  if (!body.slice(0, groupFrom).trim()) while (to < body.length && /[ \t]/.test(body[to])) to += 1
  else while (from > 0 && /[ \t]/.test(body[from - 1])) from -= 1
  return body.slice(0, from) + body.slice(to)
}

/**
 * Move the icon on the layout line of the title at `headingLine` onto the title. `expect`: the icon
 * and title a surface showed; an outline that has since changed there is refused.
 */
export function restoreTitleIcon(outline: string, headingLine: number, expect?: { key: string; title: string }): TitleIconRestore {
  const text = String(outline ?? '')
  try {
    const at = strandedTitleIcons(text).find((entry) => entry.headingLine === headingLine)
    if (!at) return refuse(text, expect ? 'moved-on' : 'nothing-to-move')
    if (expect && (expect.key !== at.key || expect.title !== at.title)) return refuse(text, 'moved-on')
    const lines = linesOf(text)
    const heading = lines.body(at.headingLine)
    const nextHeading = headingLineWith(heading, at.key)
    if (nextHeading === heading || /[\r\n]/.test(nextHeading)) return refuse(text, 'not-verified')

    const layout = lines.body(at.triggerLine)
    const nextLayout = withoutGroup(layout, at.groupFrom, at.groupTo)
    const removed = !nextLayout.trim()
    let change: IconChange = { from: lines.from(at.triggerLine), to: lines.to(at.triggerLine), insert: nextLayout }
    if (removed) {
      // The whole line with its own line ending; the outline's last line goes with the one before it.
      change = at.triggerLine + 1 < lines.count
        ? { from: lines.from(at.triggerLine), to: lines.from(at.triggerLine + 1), insert: '' }
        : { from: lines.to(at.triggerLine - 1), to: text.length, insert: '' }
    }
    const headingChange: IconChange = { from: lines.from(at.headingLine), to: lines.to(at.headingLine), insert: nextHeading }
    let next = text
    for (const edit of [change, headingChange]) next = next.slice(0, edit.from) + edit.insert + next.slice(edit.to)

    let kept = false
    try { kept = titleIconMoveVerified(text, next, at, removed) } catch { return refuse(text, 'facts-failed') }
    if (!kept) return refuse(text, 'not-verified')
    return { ok: true, text: next, headingLine: at.headingLine, key: at.key, changes: [change, headingChange] }
  } catch {
    return refuse(text, 'facts-failed')
  }
}

// ── The click ───────────────────────────────────────────────────────────────────────────────────

/** What a surface showed, and the exact outline text it was read from. */
export interface ScannedTitleIcon {
  /** 1-based, as a LayoutDoctorFinding carries it. */
  headingLine: number
  /** `icon=KEY`. */
  token: string
  slideTitle: string
}

/**
 * A surface's click on a finding. The move is made only when ALL of this holds:
 *   - `current` (the editor's text at the moment of applying) is exactly `scanned`, the text the
 *     finding was read from. Any difference at all refuses: a line number, title and icon can name
 *     another slide once the outline has changed;
 *   - `current` is settled: a save would write it to the file exactly as it is. The move is saved
 *     at once, and the save changes the whole text where it can: the tidy-up, and `{id=…}` stamped
 *     under every heading without one (outline-save-changes.ts lists every step). On unsettled text
 *     that would write changes to other headings that nothing here has checked. The ordinary
 *     autosave makes those same changes and brings the stamped ids back into the editor, so any
 *     edit followed by its autosave settles the talk;
 *   - the moved outline is settled too, so what is saved is exactly what was verified.
 */
export function restoreScannedTitleIcon(current: string, scanned: string, finding: ScannedTitleIcon): TitleIconRestore {
  const text = String(current ?? '')
  if (typeof scanned !== 'string' || text !== scanned) return refuse(text, 'moved-on')
  try {
    if (outlineSaveChange(text) !== null) return refuse(text, 'unsettled')
    const restored = restoreTitleIcon(text, finding.headingLine - 1, { key: finding.token.replace(/^icon=/, ''), title: finding.slideTitle })
    if (restored.ok && outlineSaveChange(restored.text) !== null) return refuse(text, 'not-verified')
    return restored
  } catch {
    return refuse(text, 'facts-failed')
  }
}

/** The one-writer seam as this needs it (renderer lib/outlineMutation.ts apply, for one talk). */
export type ScannedTitleIconApply = (
  mutate: (current: string) => string,
  options: { base: string }
) => Promise<{ ok: true } | { ok: false; reason: string; error: string; applied: boolean }>

/**
 * The click, through the seam. Null when the icon was moved, else the words to show. The seam is
 * given `scanned` as its base, so it refuses a buffer that is not that text without working anything
 * out; and whatever text it does hand to the callback, on every attempt it makes, is compared again
 * there (restoreScannedTitleIcon). The last attempt's answer is the one reported.
 */
export async function applyScannedTitleIconRestore(apply: ScannedTitleIconApply, scanned: string, finding: ScannedTitleIcon): Promise<string | null> {
  let refusal: string | null = null
  const result = await apply((current) => {
    const restored = restoreScannedTitleIcon(current, scanned, finding)
    refusal = restored.ok ? null : restored.detail
    return restored.text
  }, { base: scanned })
  if (refusal) return refusal
  if (!result.ok && result.reason === 'moved') return DETAIL['moved-on']
  // Moved in the editor although the save failed: the save's own message says so.
  return result.ok || result.applied ? null : result.error
}
