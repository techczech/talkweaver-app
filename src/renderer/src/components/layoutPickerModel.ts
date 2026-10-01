import type { LayoutDef, OptionGroup, OptionValue } from '../data/layouts'
import { isContainerContext, optionGroupsForSlide } from '../../../shared/layout-registry/options.ts'
import { deckCommitContext } from '../../../shared/deck-frame.ts'
import { isStatementOptionGroup, statementSelections } from '../../../shared/statement-options.ts'
import { LAYOUTS as REGISTRY_LAYOUTS } from '../../../shared/layout-registry/entries.ts'
import { commitLayoutSelection, selectionFromTriggerLine, toggleLayoutSelection } from '../../../shared/layout-selection.ts'
// The selection read/toggle/write lives in src/shared so the headless layout verbs use the same code.
export { commitLayoutSelection, selectionFromTriggerLine, toggleLayoutSelection }
import { readOutlineSlides } from '../../../shared/feedback-accept.ts'
import type { SlideRef } from '../../../shared/layout-verbs.ts'
import {
  commitOptionSelection,
  headingHasChildSlides,
  selectionForGroup,
  type OptionCommitContext
} from '../../../shared/trigger-line.ts'

export type PickerSection = {
  kind: LayoutDef['kind']
  label: 'Layout' | 'Modifiers' | 'Components' | 'Container'
  entries: LayoutDef[]
}

export type LayoutPickerContext = { triggerLine: string; headingLevel: number; hasChildren: boolean }

export type PickerOptionGroup = {
  group: OptionGroup
  selectedToken: string
}

export type InlineOptionRow = {
  digit: number
  value: OptionValue
  selected: boolean
}

export type InlineOptionPickerStep = PickerOptionGroup & {
  entry: LayoutDef
  crumb: ['{', string, 'options']
  query: string
  rows: InlineOptionRow[]
}

const PICKER_SECTIONS: Array<Omit<PickerSection, 'entries'>> = [
  { kind: 'layout', label: 'Layout' },
  { kind: 'modifier', label: 'Modifiers' },
  { kind: 'component', label: 'Components' },
  { kind: 'container', label: 'Container' }
]

/** Picker context for the heading owning `lineIndex` (0-based) in a plain lines array. */
export function headingContextForDoc(
  lines: readonly string[],
  lineIndex: number
): Pick<LayoutPickerContext, 'headingLevel' | 'hasChildren'> {
  for (let i = lineIndex; i >= 0; i -= 1) {
    const match = lines[i].match(/^(#{2,6})\s/)
    if (match) return { headingLevel: match[1].length, hasChildren: headingHasChildSlides(lines, i) }
  }
  return { headingLevel: 3, hasChildren: false }
}

export function layoutPickerModel(
  items: LayoutDef[],
  context: Pick<LayoutPickerContext, 'headingLevel' | 'hasChildren'>
): PickerSection[] {
  return PICKER_SECTIONS
    .filter((section) => section.kind !== 'container' || isContainerContext(context))
    .map((section) => ({ ...section, entries: items.filter((item) => item.kind === section.kind) }))
    .filter((section) => section.entries.length > 0)
}

// CodeMirror's inline `{` picker consumes the section model; this named entry point keeps its parity
// tests explicit. (The docked ⌘L picker has its own model, layoutPickerColumnModel.ts, ADR-0032.)
export const inlineLayoutPickerModel = layoutPickerModel

/**
 * An inline `{` row expands to the option rows of the entry under the cursor, so the picker asks the
 * ONE resolver (`optionGroupsForSlide`, ADR-0020 §5) and keeps the rows that entry owns. The
 * picker does not judge relevance itself: a container's options disappear on a leaf `###` because
 * the resolver drops them, not because this module re-states the rule.
 *
 * The context is optional only because a caller may have no heading in hand (a bare parity probe);
 * a missing one reads as an ordinary `###` content slide, the same neutral default the ⌘L palette
 * falls back to when it opens outside a heading.
 */
const NEUTRAL_SLIDE: Pick<LayoutPickerContext, 'headingLevel' | 'hasChildren'> =
  { headingLevel: 3, hasChildren: false }

export function optionGroupsForPickerEntry(
  entry: LayoutDef,
  triggerLine: string,
  context: Pick<LayoutPickerContext, 'headingLevel' | 'hasChildren'> = NEUTRAL_SLIDE
): PickerOptionGroup[] {
  return optionGroupsForSlide({ ...context, layoutName: entry.name })
    .filter((applicable) => applicable.source === 'entry' && applicable.owner?.name === entry.name)
    .map(({ group }) => ({
      group,
      // Ticket 02: a statement's choices light what the line means, the older one-word options
      // ({statement=tint} → Halo + Left bar) included.
      selectedToken: isStatementOptionGroup(group.key) ? statementSelections(triggerLine)[group.key] ?? '' : selectionForGroup(triggerLine, group)
    }))
}

export function inlineOptionPickerStep(
  entry: LayoutDef,
  triggerLine: string,
  query: string,
  context: Pick<LayoutPickerContext, 'headingLevel' | 'hasChildren'> = NEUTRAL_SLIDE
): InlineOptionPickerStep | null {
  const bindings = optionGroupsForPickerEntry(entry, triggerLine, context)
  const binding = bindings.find(({ group }) => group.key === `${entry.name}-shape`) ?? bindings[0]
  if (!binding) return null
  const normalisedQuery = query.trim().toLowerCase()
  const values = binding.group.values.filter((value) => !normalisedQuery || [
    value.label,
    value.token,
    value.description ?? ''
  ].some((term) => term.toLowerCase().includes(normalisedQuery)))
  return {
    ...binding,
    entry,
    crumb: ['{', entry.name, 'options'],
    query,
    rows: values.slice(0, 9).map((value, index) => ({
      digit: index + 1,
      value,
      selected: value.token === binding.selectedToken
    }))
  }
}

export function digitPickForOptionStep(
  step: InlineOptionPickerStep,
  digit: number
): OptionValue | undefined {
  return step.rows.find((row) => row.digit === digit)?.value
}

// ADR-0011: ⌘L and inline `{` deliberately share this sole Trigger-line option write path.
// T32: `context` is the slide's `deckCommitContext` (src/shared/deck-frame.ts) — required, so no
// surface's sweep can remove a token the deck keeps live on the compiled slide.
export function commitPickerOption(line: string, group: OptionGroup, token: string, context: OptionCommitContext): string {
  return commitOptionSelection(line, group, token, context)
}

/**
 * One option choice from the ⌘L picker, the mounted-editor Inspector or the inline palette,
 * written to one slide's Trigger line. With an `entry`, the entry is selected first (the picker
 * chooses an entry's option as that entry). The sweep reads the deck's choice for this slide
 * (`deckCommitContext`), so no surface removes a token the deck keeps live on the compiled slide.
 */
export function commitSlideOption(
  doc: string,
  headingLine: number,
  triggerLine: string,
  entry: LayoutDef | undefined,
  group: OptionGroup,
  token: string,
  layoutTokenOverride?: string
): string {
  const context = deckCommitContext(doc, headingLine)
  const initial = selectionFromTriggerLine(triggerLine, [...REGISTRY_LAYOUTS])
  const withEntry = entry
    ? commitLayoutSelection(triggerLine, initial, toggleLayoutSelection(initial, entry), layoutTokenOverride, context)
    : triggerLine
  return commitPickerOption(withEntry, group, token, context)
}

export function layoutSubmenuEntries(items: LayoutDef[]): LayoutDef[] {
  return items.filter((item) => item.kind === 'layout')
}

export function provisionalTriggerAtCursor(
  content: string,
  cursor: number
): { from: number; to: number } | null {
  const lineStart = content.lastIndexOf('\n', Math.max(0, cursor - 1)) + 1
  const beforeCursor = content.slice(lineStart, cursor)
  const match = beforeCursor.match(/^(?:\s*\{[^{}]+\})*\s*(\{[^{}]*)$/)
  if (!match) return null
  const from = cursor - match[1].length
  return { from, to: cursor }
}

export function accumulatedTriggers(selected: LayoutDef[]): string {
  return selected.map((item) => item.trigger).join('')
}

export function filterLayoutPickerEntries(items: LayoutDef[], query: string): LayoutDef[] {
  const q = query.toLowerCase().trim()
  if (!q) return items
  return items.filter((item) => [
    item.name,
    item.label,
    item.description,
    item.trigger,
    ...item.aliases
  ].some((term) => term.toLowerCase().includes(q)))
}

/**
 * The picker's slide, found again after the outline text changed under it. A slide with no `{id=…}`
 * yet is named by its heading LINE, and the save that stamps ids inserts lines above it (a section's
 * `{id=…}` line), which moves every heading down: the old line number then names another slide, or none,
 * and the docked picker closed itself a moment after it opened. This follows the slide by its place
 * among the slides and its heading text, so the reference survives the stamp. An id is already stable
 * and is returned as it was. Null when the slide is gone.
 */
export function reanchorPickerSlide(before: string, after: string, slide: SlideRef): SlideRef | null {
  if (typeof slide === 'string' || before === after) return slide
  const was = readOutlineSlides(before)
  const ordinal = was.slides.findIndex((candidate) => candidate.line === slide.headingLine)
  if (ordinal < 0) return null
  const headingText = (read: ReturnType<typeof readOutlineSlides>, index: number): string => (read.lines[read.slides[index].start] ?? '').replace(/\r$/, '').trim()
  const wanted = headingText(was, ordinal)
  const now = readOutlineSlides(after)
  const same = now.slides.map((_, index) => index).filter((index) => headingText(now, index) === wanted)
  if (!same.length) return null
  const nearest = same.includes(ordinal)
    ? ordinal
    : same.reduce((best, index) => (Math.abs(index - ordinal) < Math.abs(best - ordinal) ? index : best))
  const found = now.slides[nearest]
  return found.line === slide.headingLine ? slide : { headingLine: found.line }
}
