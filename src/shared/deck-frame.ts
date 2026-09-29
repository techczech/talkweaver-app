// =============================================================================
// The deck's List style choice for one slide, read with the compiler's own code (T32, Decision 1A).
//
// The invariant the Inspector builds on: with no list-style token on the slide, the lit List style
// button is the style the COMPILED slide renders. Nothing about that is re-derived here — every
// step is a compiler function:
//   • the frontmatter `defaults:` / `sections:` maps  → parseSimpleYaml   (simple-yaml.mjs)
//   • the slide's attrs and its owning `##` section    → parseOutlineTree  (14-outline-tree.mjs)
//   • slide > section > deck > builtin precedence      → resolveSlideFrame (11-frame.mjs)
//   • "the frame forces icons on an unstyled list"     → plainListForcedIcons (11-frame.mjs), the
//     predicate 06-block-renderers.mjs applies to a feature list with no explicit liststyle.
// =============================================================================
import { parseSimpleYaml } from '../../compiler/scripts/lib/simple-yaml.mjs'
import { parseOutlineTree, type OutlineTreeNode } from '../../compiler/scripts/lib/14-outline-tree.mjs'
import { plainListForcedIcons, resolveSlideFrame } from '../../compiler/scripts/lib/11-frame.mjs'
import { parseHeadingAttrs, parseTriggerLine } from '../../compiler/scripts/lib/02-triggers-layout.mjs'
import type { OptionCommitContext } from './trigger-line.ts'

/** The deck's choice as a list-style option token: Icons (`iconlist`) or Plain (`''`). */
export type DeckListStyle = '' | 'iconlist'

type FrameMap = Record<string, unknown>

function asMap(value: unknown): FrameMap {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as FrameMap : {}
}

/**
 * The frontmatter maps, and the body with the frontmatter blanked IN PLACE (its newlines kept) —
 * the same move the compiler's outline adapter makes — so outline-tree source lines are the real
 * 1-based file lines.
 */
function splitFrontmatter(outline: string): { meta: FrameMap; body: string } {
  if (!outline.startsWith('---')) return { meta: {}, body: outline }
  const end = outline.indexOf('\n---', 3)
  if (end < 0) return { meta: {}, body: outline }
  const fmEnd = end + 4
  return {
    meta: parseSimpleYaml(outline.slice(3, end).trim()),
    body: outline.slice(0, fmEnd).replace(/[^\n]/g, '') + outline.slice(fmEnd)
  }
}

/** The slide node whose heading sits on `headingLine`, with the `##` section that owns it. */
function findSlide(root: OutlineTreeNode, headingLine: number): { node: OutlineTreeNode; section: OutlineTreeNode | null } | null {
  const walk = (node: OutlineTreeNode, section: OutlineTreeNode | null): ReturnType<typeof findSlide> => {
    for (const child of node.children) {
      const owner = child.level === 2 ? child : section
      if (child.sourceLine === headingLine) return { node: child, section: owner }
      const found = walk(child, owner)
      if (found) return found
    }
    return null
  }
  return walk(root, null)
}

/**
 * What a list on this slide renders as when the slide carries NO list-style token, for a given
 * Trigger line: Icons when the slide's resolved frame icon setting forces icons on an unstyled
 * list, Plain otherwise. The frame reads the heading's own attrs plus the line's (the slide's
 * `{icons=…}` takes part, exactly as in the compiler), then the owning section's defaults, then
 * the deck's. A resolver rather than a value, so a commit can re-ask it about the line it is
 * producing (`commitOptionSelection`'s sweep).
 */
export function deckListStyleResolver(outline: string, headingLine: number | null): (triggerLine: string) => DeckListStyle {
  if (headingLine == null) return () => ''
  const { meta, body } = splitFrontmatter(outline)
  const slide = findSlide(parseOutlineTree(body).root, headingLine)
  if (!slide) return () => ''
  const headingText = slide.node.headingLine.replace(/^#{1,6}\s+/, '')
  const headingAttrs = parseHeadingAttrs(headingText).attrs
  const sectionDefaults = asMap(slide.section ? asMap(meta.sections)[slide.section.title] : undefined)
  const deckDefaults = asMap(meta.defaults)
  return (triggerLine) => {
    const lineAttrs = parseTriggerLine(triggerLine)?.attrs ?? {}
    const frame = resolveSlideFrame({ ...headingAttrs, ...lineAttrs }, sectionDefaults, deckDefaults)
    return plainListForcedIcons(frame.icons) ? 'iconlist' : ''
  }
}

/** The one option group whose unwritten value the deck decides (T32, Decision 1A). */
export const DECK_DECIDED_GROUP = 'list-style'

/**
 * The context EVERY Trigger-line option commit for a slide passes to `commitOptionSelection`
 * (Inspector, ⌘L picker, inline palette): the sweep reads the deck's List style choice for any
 * line with no list-style token, so no surface can sweep a token that is live on the compiled
 * slide (a treatment on a `defaults: { icons: on }` slide).
 */
export function deckCommitContext(outline: string, headingLine: number | null): OptionCommitContext {
  const deckListStyleFor = deckListStyleResolver(outline, headingLine)
  return {
    unwrittenSelections: (line) => ({ [DECK_DECIDED_GROUP]: deckListStyleFor(line) }),
    statement: { deckClaimStyle: deckClaimStyleForOutline(outline), titleHidden: statementTitleHidden(outline, headingLine) }
  }
}

/**
 * Ticket 02: whether a statement slide paints no title, read from the outline — the case the older
 * {statement=centred} centres (07-assembly: the heading is the statement when the slide has no
 * body, or {notitle}/{title=off}; an explicit rail, top title or {title=show} paints it). Unknown
 * (no slide at that line) is `undefined`.
 */
export function statementTitleHidden(outline: string, headingLine: number | null): boolean | undefined {
  if (headingLine == null) return undefined
  const { body } = splitFrontmatter(outline)
  const slide = findSlide(parseOutlineTree(body).root, headingLine)
  if (!slide) return undefined
  const line = slide.node.triggerLine ?? ''
  const has = (pattern: RegExp): boolean => pattern.test(line)
  const paintsTitle = has(/(?<![\w-])(titletop|sidebar|title=side|title=top|title=show|split=\d+)(?![\w-])/)
  if (has(/(?<![\w-])(notitle|title=off)(?![\w-])/) && !has(/(?<![\w-])(title=show|title=side|titletop)(?![\w-])/)) return true
  const hasBody = slide.node.contentLines.some((text) => text.trim() !== '' && !/^\s*(\{[^}]*\}\s*)+$/.test(text))
  return !hasBody && !paintsTitle
}

/** The deck's List style choice for the slide as the outline stands. */
export function deckListStyleForSlide(outline: string, headingLine: number | null): DeckListStyle {
  if (headingLine == null) return ''
  const { body } = splitFrontmatter(outline)
  const slide = findSlide(parseOutlineTree(body).root, headingLine)
  return slide ? deckListStyleResolver(outline, headingLine)(slide.node.triggerLine) : ''
}

/**
 * ADR-0028 §10, preview.9 fix: the Statement treatment the DECK decides. The compiler maps the
 * older deck-wide claim treatment onto the statement options (statement-options.mjs: a deck
 * `claim_style: bar` makes every statement slide with no statement or claim token of its own the
 * Bar preset — no colour, left bar), so the Inspector lights those values exactly then. `''` = the
 * deck decides nothing (the Default).
 */
export type DeckStatementToken = '' | 'statement=bar'

export function deckStatementTokenForOutline(outline: string): DeckStatementToken {
  return deckClaimStyleForOutline(outline) === 'bar' ? 'statement=bar' : ''
}

/** The deck's `claim_style:` as written ('' when absent). */
export function deckClaimStyleForOutline(outline: string): string {
  const { meta } = splitFrontmatter(outline)
  return String(meta.claim_style ?? meta['claim-style'] ?? '').trim().toLowerCase()
}
