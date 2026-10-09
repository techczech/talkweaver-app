import { plainInlineText } from '../../../../compiler/scripts/lib/00-inline-render.mjs'
import type { ProjectionRow } from '../../../preload/index.ts'
import type { LayoutDoctorFinding } from '../../../shared/layout-doctor.ts'
import { triggerFindingsForSlide } from '../../../shared/layout-doctor.ts'
import type { LayoutDef } from '../../../shared/layout-registry/entries.ts'
import type { OptionGroup, OptionValue } from '../../../shared/layout-registry/entries.ts'
import {
  groupApplies, slideHasEmbedBesideText, layoutEntryFor, optionGroupsForSlide, sectionedOptionGroups, valuesForGroup,
  type ApplicableOptionGroup, type InspectorOptionSection, type SectionedOptionBinding
} from '../../../shared/layout-registry/options.ts'
import { commitOptionSelection, groupHasSelection, logicalTriggerBlockAfterHeading, reportTriggerMergeWarnings, selectionForGroup } from '../../../shared/trigger-line.ts'
import { DECK_DECIDED_GROUP, deckCommitContext, type DeckListStyle, type DeckStatementToken } from '../../../shared/deck-frame.ts'
import { isStatementOptionGroup, statementSelections } from '../../../shared/statement-options.ts'
import { selectionFromTriggerLine } from './layoutPickerModel.ts'
import { inspectorBoardModel, type InspectorBoardModel } from './inspectorBoardModel.ts'
import { slideBlockEnd } from '../../../../compiler/scripts/lib/board-slide.mjs'
import { preworkKindOf, type InspectorPreworkModel } from './inspectorPreworkModel.ts'

export type PaneState = 'both' | 'editor' | 'strip'

export function migratePaneState(value: unknown): PaneState {
  if (value === 'inspector') return 'strip'
  return value === 'both' || value === 'editor' || value === 'strip' ? value : 'both'
}

export function migrateInspectorMode(paneValue: unknown, modeValue: unknown): boolean {
  if (paneValue === 'inspector') return true
  return modeValue === true || modeValue === 'true'
}

export function navigateInspectorSlide(index: number, direction: -1 | 1, count: number): number {
  if (count <= 0) return 0
  return Math.max(0, Math.min(count - 1, index + direction))
}

export function resolveInspectedSlide(
  rows: readonly Pick<ProjectionRow, 'slide_id'>[] | null,
  inspectedId: string | null,
  previousIndex: number
): { id: string | null; index: number } {
  if (!rows?.length) return { id: null, index: 0 }
  if (inspectedId) {
    const index = rows.findIndex((row) => row.slide_id === inspectedId)
    if (index >= 0) return { id: inspectedId, index }
  }
  const index = Math.max(0, Math.min(rows.length - 1, previousIndex))
  return { id: rows[index]?.slide_id ?? null, index }
}

/** Follow genuine editor navigation while preserving Inspector identity during an option write. */
export function inspectedSlideIdAfterCursorChange(
  rows: readonly Partial<ProjectionRow>[] | null,
  activeIndex: number,
  currentId: string | null,
  commitInProgress: boolean
): string | null {
  if (commitInProgress) return currentId
  return rows?.[activeIndex]?.slide_id ?? currentId
}

export function headingLineForSlideId(
  content: string,
  slideId: string | null
): number | null {
  if (!slideId) return null
  const lines = content.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*(\{[^}]*\}\s*)+$/.test(lines[index])) continue
    const id = [...lines[index].matchAll(/\{id=([^}]+)\}/g)].find((match) => match[1] === slideId)
    if (!id) continue
    for (let heading = index - 1; heading >= 0; heading -= 1) {
      if (/^#{1,6}\s/.test(lines[heading])) return heading + 1
    }
  }
  return null
}

/** Live source for one rendered slide under the heading-is-slide model. */
export function extractInspectorSlideBlock(content: string, headingLine: number | null): string | null {
  if (headingLine == null) return null
  const lines = content.split('\n')
  const start = headingLine - 1
  const match = lines[start]?.match(/^(#{1,6})\s/)
  if (!match) return null
  // The slide ends at the next heading outside a code fence (a `# …` line in a fence is code).
  let end = slideBlockEnd(lines, start)
  while (end > start + 1 && lines[end - 1].trim() === '') end -= 1
  return lines.slice(start, end).join('\n')
}

/** Commit an Inspector option without CodeMirror while preserving all unrelated source bytes. */
export function applyInspectorOptionToOutline(
  content: string,
  headingLine: number | null,
  group: OptionGroup,
  token: string
): string | null {
  if (headingLine == null) return null
  const lines = content.split('\n')
  const headingIndex = headingLine - 1
  if (!/^(#{1,6})\s/.test(lines[headingIndex] ?? '')) return null

  const block = logicalTriggerBlockAfterHeading(lines, headingIndex)
  // T32: the sweep reads the DECIDED list style — the authored token, or the deck's choice for the
  // line being produced — so a treatment on a deck-icons slide stays relevant.
  const committed = commitOptionSelection(block?.line ?? '', group, token, deckCommitContext(content, headingLine))

  if (block) {
    if (committed === block.line && block.end === block.start + 1 && block.warnings.length === 0) return content
    reportTriggerMergeWarnings(block.warnings)
    const carriageReturn = lines[block.start].endsWith('\r') ? '\r' : ''
    lines.splice(block.start, block.end - block.start, committed + carriageReturn)
  } else {
    const headingHasCarriageReturn = lines[headingIndex].endsWith('\r')
    lines.splice(headingIndex + 1, 0, committed + (headingHasCarriageReturn ? '\r' : ''))
  }
  return lines.join('\n')
}

export interface InspectorStepModel {
  count: number
  mode: '' | 'reveal' | 'focus' | 'group' | 'carousel'
}

export function stepModelForSlide(row: Partial<ProjectionRow> | null | undefined): InspectorStepModel {
  if (!row) return { count: 0, mode: '' }
  const source = row.source_markdown ?? ''
  const carousel = row.layout === 'carousel' || row.triggers?.layout === 'carousel' || /\{carousel\}/.test(source)
  if (carousel) {
    const children = source.split('\n').filter((line) => /^####\s/.test(line)).length
    return { count: children, mode: children > 0 ? 'carousel' : '' }
  }
  const authored = String(row.triggers?.mode ?? '')
  const match = source.match(/\{(reveal|focus|group)\}/) || authored.match(/^(reveal|focus|group)$/)
  const mode = (match?.[1] ?? '') as InspectorStepModel['mode']
  if (!mode) return { count: 0, mode: '' }
  const bullets = Number(row.bullet_count) || source.split('\n').filter((line) => /^\s*[-*+]\s+/.test(line)).length
  return { count: bullets, mode: bullets > 0 ? mode : '' }
}

export interface InspectorModel {
  title: string
  layoutName?: string
  unresolved: boolean
  unresolvedFindings: LayoutDoctorFinding[]
  groups: ApplicableOptionGroup[]
  /** The groups of `groups`, sectioned and ordered for the options column (T32, Decision 2A). */
  sections: InspectorSectionModel[]
  /** What an unstyled list on this slide renders as — the deck's List style choice (T32, 1A). */
  deckListStyle: DeckListStyle
  selectedTokens: Record<string, string>
  steps: InspectorStepModel
  /** ADR-0032: a `{poll=board}` slide's Board section (its Poll section, headed "Board"). */
  board?: InspectorBoardModel
  /** Ticket 08: the slide's "Before the session" section (a pre-work step, the section, or a `{results=…}` slide). */
  prework?: InspectorPreworkModel
}

export function inspectorModel(
  rows: readonly Partial<ProjectionRow>[] | null,
  activeIndex: number,
  headingLevel: number,
  triggerLine: string,
  layouts: readonly LayoutDef[],
  sourceMarkdown?: string,
  hasChildren = false,
  triggerFindings: readonly LayoutDoctorFinding[] = [],
  deckListStyle: DeckListStyle = '',
  deckStatementToken: DeckStatementToken = '',
  prework: InspectorPreworkModel | null = null
): InspectorModel {
  const row = rows?.[activeIndex] ?? null
  const layoutName = selectionFromTriggerLine(triggerLine, [...layouts]).find((entry) => entry.kind === 'layout')?.name
    ?? row?.triggers?.layout
    ?? row?.layout
  const unresolvedFindings = triggerFindingsForSlide(row, triggerFindings).filter((finding) =>
    finding.kind === 'unknown-word'
    || finding.kind === 'unregistered-key'
    || finding.kind === 'unregistered-value'
  )
  const unresolved = unresolvedFindings.length > 0
  // ADR-0028 §10: whether the compiled slide paints its title, read from the compiler's own
  // title regime on the row; a row without it (an old cached index row) is "not known".
  const titleLayout = row?.title_layout
  const titlePainted = typeof titleLayout === 'string' ? titleLayout !== 'hidden' && titleLayout !== '' : undefined
  // Ticket 08: a pre-work step's rows (prework-*) are offered only when the slide is a step.
  const preworkKind = preworkKindOf(prework)
  // Ticket 13: the Page width group is offered only on a slide with an embedded page and body text.
  const embedBesideText = slideHasEmbedBesideText(sourceMarkdown ?? row?.source_markdown ?? '')
  const candidates = optionGroupsForSlide({ layoutName, headingLevel, hasChildren, preworkKind, embedBesideText })
  // T32: applicability reads the DECIDED selection — for List style with no authored token that is
  // the deck's choice, so the treatment is offered exactly when the compiled list is an icon list.
  const deckDecided = (key: string): string | undefined => key === DECK_DECIDED_GROUP ? deckListStyle : undefined
  // Ticket 02: each statement control lights what the compiled slide renders — its own token, the
  // older one-word option it is part of ({statement=tint} lights Halo and Left), or the deck's
  // `claim_style: bar`; the sidebar with no token of its own follows the compiled title placement.
  const statementLit = statementSelections(triggerLine, {
    deckClaimStyle: deckStatementToken === 'statement=bar' ? 'bar' : '',
    titleLayout: typeof titleLayout === 'string' ? titleLayout : undefined
  })
  const selectedTokens = Object.fromEntries(candidates.map(({ group }) => {
    if (isStatementOptionGroup(group.key)) return [group.key, statementLit[group.key] ?? '']
    const deck = deckDecided(group.key)
    if (deck !== undefined && !groupHasSelection(triggerLine, group)) return [group.key, deck]
    return [group.key, selectionForGroup(triggerLine, group)]
  }))
  const groups = unresolved
    ? []
    : candidates.filter(({ group }) => groupApplies(group, { headingLevel, hasChildren, layoutName, selectedTokens, preworkKind, embedBesideText }))
  // ADR-0032 (round-3 A2–A6): a board's Poll section is its Board section — the columns, hints,
  // prompt, example and settings, read from the slide's own text.
  const isBoard = !unresolved && selectedTokens['poll-type'] === 'poll=board'
  return {
    title: plainInlineText(row?.nav_title || row?.title) || '(untitled)',
    layoutName,
    unresolved,
    unresolvedFindings,
    groups,
    ...(isBoard ? { board: inspectorBoardModel(sourceMarkdown ?? row?.source_markdown ?? '', triggerLine) } : {}),
    ...(prework && !unresolved ? { prework } : {}),
    sections: withPreworkSection(sectionedOptionGroups(groups, layoutEntryFor(layoutName)?.label), unresolved ? null : prework).map((section) => ({
      ...section,
      heading: isBoard && section.id === 'poll' ? 'Board' : section.id === 'prework' && prework ? prework.heading : section.heading,
      ...(section.id === 'prework' && prework ? { chip: prework.chip } : {}),
      bindings: section.bindings.map((binding) => bindingModel(binding, selectedTokens, deckListStyle, {
        layoutName, headingLevel, hasChildren, selectedTokens, titlePainted, preworkKind, embedBesideText
      }))
    })),
    deckListStyle,
    selectedTokens,
    steps: stepModelForSlide(row ? { ...row, source_markdown: sourceMarkdown ?? row.source_markdown } : null)
  }
}

// ── T32 (Decision 1A): the List style row against a deck default ───────────────────────
//
// Invariant: the lit List style button is always the style the compiled slide renders. An
// authored token wins (the {plainlist} override included — Plain accepts it as an alt token);
// with NO authored token the deck's choice is lit (deck-frame.ts reads it with the compiler's
// own frame code). The button matching the deck's choice carries the "deck" mark, lit or not.
// Clicking it removes the slide's token so the slide follows the deck again — never a copy of
// the deck setting; clicking Plain against an Icons deck writes {plainlist}. Every write still
// goes through commitOptionSelection, so the 09-21 relevance sweep runs on it unchanged.


export interface InspectorBindingModel extends SectionedOptionBinding {
  /** ADR-0032 §1/§7: set when this group is drawn as pictures of the author's own slide. */
  pictures?: OptionPictureSet
  /** The value token whose button is lit. */
  selectedToken: string
  /** The value token the deck decides for this group, when it decides one (the "deck" mark). */
  deckToken?: string
  /** The group's values this slide offers (ADR-0028 §10: a value may declare its own relevance). */
  values: OptionValue[]
}

export interface InspectorSectionModel extends Omit<InspectorOptionSection, 'bindings'> {
  bindings: InspectorBindingModel[]
  /** The jump-row chip when it differs from the heading (ticket 08: "Pre-work" over "Before the session"). */
  chip?: string
}

/** Ticket 08: the "Before the session" section stands even when no registry row applies (the
 *  pre-work section itself, a `{results=…}` slide): its body is the Inspector's own. Last in the run. */
function withPreworkSection(sections: InspectorOptionSection[], prework: InspectorPreworkModel | null): InspectorOptionSection[] {
  if (!prework || sections.some((section) => section.id === 'prework')) return sections
  return [...sections, { id: 'prework', heading: prework.heading, bindings: [] }]
}

function bindingModel(
  binding: SectionedOptionBinding,
  selectedTokens: Readonly<Record<string, string>>,
  deckListStyle: DeckListStyle,
  context: Parameters<typeof valuesForGroup>[1]
): InspectorBindingModel {
  // Ticket 02: the statement's Sidebar row shows its two explicit choices, one of them always lit
  // (the one the slide renders); its Auto value exists for the typed surfaces.
  const values = valuesForGroup(binding.group, context)
    .filter((value) => binding.group.key !== 'statement-sidebar' || value.token !== '')
  const pictures = optionPictureSet(binding.group.key, context.layoutName, values)
  const withPictures = pictures ? { pictures } : {}
  if (binding.group.key !== DECK_DECIDED_GROUP) {
    return { ...binding, ...withPictures, selectedToken: selectedTokens[binding.group.key] ?? '', values }
  }
  return { ...binding, ...withPictures, selectedToken: selectedTokens[binding.group.key] ?? '', deckToken: deckListStyle, values }
}

// ── ADR-0032 §1/§7 (journey 3, adjust): option pictures ────────────────────────────────────
//
// The Inspector draws an option as a picture of the author's own slide with that option only for
// Cards (form, icons, title placement, body size), the list styles (style, icon treatment) and a
// section's container mode — the groups the locked mockup pictures (hifi S0, S4, S8, S11).
// Every other layout keeps its buttons. Scalar title size and sidebar widths stay buttons too:
// a title placement's Width row is the values a picture set leaves out.
//
// `layout` is the registry entry the picture request applies the option to (what the slide is, so
// the request changes one option and keeps the rest of the Trigger line).

interface PictureRule {
  layout: string
  /** Only when the slide's layout is this one (Cards' title placement and body size are the global groups). */
  onLayout?: string
  /** The values that get pictures; others are left to buttons. Absent = every offered value. */
  tokens?: readonly string[]
}

const PICTURE_RULES: Readonly<Record<string, PictureRule>> = {
  form: { layout: 'cards', onLayout: 'cards' },
  'cards-icons': { layout: 'cards', onLayout: 'cards' },
  'title-placement': { layout: 'cards', onLayout: 'cards', tokens: ['', 'titletop', 'notitle', 'sidebar'] },
  'font-body': { layout: 'cards', onLayout: 'cards' },
  'list-style': { layout: 'list' },
  'iconlist-variant': { layout: 'iconlist' },
  'container-mode': { layout: 'carousel' }
}

export interface OptionPictureSet {
  layout: string
  /** Values drawn as pictures, in the group's order. */
  pictured: OptionValue[]
  /** Values left to buttons (a title placement's split widths). */
  rest: OptionValue[]
}

/** How a group is drawn: as pictures (with the entry a request applies them to), or null for buttons. */
export function optionPictureSet(
  groupKey: string,
  layoutName: string | undefined,
  values: readonly OptionValue[]
): OptionPictureSet | null {
  const rule = PICTURE_RULES[groupKey]
  if (!rule || (rule.onLayout && rule.onLayout !== layoutName)) return null
  const pictured = values.filter((value) => !rule.tokens || rule.tokens.includes(value.token))
  if (pictured.length < 2) return null
  return { layout: rule.layout, pictured: [...pictured], rest: values.filter((value) => !pictured.includes(value)) }
}

export interface OptionPictureRequest {
  layout: string
  options: Array<{ group: string; token: string }>
}

/** The `layout:variant-thumbnail` request for one picture: the slide with `commitToken` (what a
 *  click WRITES, see inspectorCommitToken) set on `groupKey`, the rest of its Trigger line kept. */
export function optionPictureRequest(set: OptionPictureSet, groupKey: string, commitToken: string): OptionPictureRequest {
  return { layout: set.layout, options: [{ group: groupKey, token: commitToken }] }
}

/** The token an Inspector click WRITES for a value button: the deck-marked button removes the
 *  group's token, and Plain against an Icons deck writes the {plainlist} override. (A statement's
 *  controls carry no deck mark: their write path rewrites a Bar deck's decision itself, ticket 02.) */
export function inspectorCommitToken(binding: Pick<InspectorBindingModel, 'deckToken'>, clickedToken: string): string {
  const deck = binding.deckToken
  if (deck === undefined) return clickedToken
  if (clickedToken === deck) return ''
  if (clickedToken === '' && deck === 'iconlist') return 'plainlist'
  return clickedToken
}

/** The section currently at the top of the options scroll area: the last section whose top has
 *  reached the reading line (the scroll position plus the sticky jump row that covers it). */
export function sectionIdAtScrollTop(
  sections: readonly { id: string; top: number }[],
  readingLine: number
): string | null {
  let active: string | null = sections[0]?.id ?? null
  for (const section of sections) if (section.top <= readingLine) active = section.id
  return active
}
