import type { ProjectionRow } from '../../../preload/index.ts'
import type { LayoutDoctorFinding } from '../../../shared/layout-doctor.ts'
import { triggerFindingsForSlide } from '../../../shared/layout-doctor.ts'
import type { LayoutDef } from '../../../shared/layout-registry/entries.ts'
import type { OptionGroup } from '../../../shared/layout-registry/entries.ts'
import {
  groupApplies, layoutEntryFor, optionGroupsForSlide, sectionedOptionGroups,
  type ApplicableOptionGroup, type InspectorOptionSection, type SectionedOptionBinding
} from '../../../shared/layout-registry/options.ts'
import { commitOptionSelection, groupHasSelection, logicalTriggerBlockAfterHeading, selectionForGroup } from '../../../shared/trigger-line.ts'
import { DECK_DECIDED_GROUP, deckCommitContext, type DeckListStyle } from '../../../shared/deck-frame.ts'
import { selectionFromTriggerLine } from './layoutPickerModel.ts'

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
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    const next = lines[index].match(/^(#{1,6})\s/)
    if (next) { end = index; break }
  }
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
    for (const warning of block.warnings) console.warn(warning)
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
  deckListStyle: DeckListStyle = ''
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
  const candidates = optionGroupsForSlide({ layoutName, headingLevel, hasChildren })
  // T32: applicability reads the DECIDED selection — for List style with no authored token that is
  // the deck's choice, so the treatment is offered exactly when the compiled list is an icon list.
  const selectedTokens = Object.fromEntries(candidates.map(({ group }) => [
    group.key,
    group.key === DECK_DECIDED_GROUP && !groupHasSelection(triggerLine, group) ? deckListStyle : selectionForGroup(triggerLine, group)
  ]))
  const groups = unresolved
    ? []
    : candidates.filter(({ group }) => groupApplies(group, { headingLevel, hasChildren, layoutName, selectedTokens }))
  return {
    title: row?.nav_title || row?.title || '(untitled)',
    layoutName,
    unresolved,
    unresolvedFindings,
    groups,
    sections: sectionedOptionGroups(groups, layoutEntryFor(layoutName)?.label).map((section) => ({
      ...section,
      bindings: section.bindings.map((binding) => bindingModel(binding, selectedTokens, deckListStyle))
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
  /** The value token whose button is lit. */
  selectedToken: string
  /** The value token the deck decides for this group, when it decides one (the "deck" mark). */
  deckToken?: string
}

export interface InspectorSectionModel extends Omit<InspectorOptionSection, 'bindings'> {
  bindings: InspectorBindingModel[]
}

function bindingModel(
  binding: SectionedOptionBinding,
  selectedTokens: Readonly<Record<string, string>>,
  deckListStyle: DeckListStyle
): InspectorBindingModel {
  if (binding.group.key !== DECK_DECIDED_GROUP) {
    return { ...binding, selectedToken: selectedTokens[binding.group.key] ?? '' }
  }
  return { ...binding, selectedToken: selectedTokens[binding.group.key] ?? '', deckToken: deckListStyle }
}

/** The token an Inspector click WRITES for a value button: the deck-marked button removes the
 *  group's token, and Plain against an Icons deck writes the {plainlist} override. */
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
