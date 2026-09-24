import type { LayoutDef, OptionGroup, OptionValue } from '../data/layouts'
import {
  layoutEntryAcceptsTriggerToken,
  winningAuthoredLayout
} from '../../../shared/layout-registry/vocabulary.ts'
import { isContainerContext, optionGroupsForSlide } from '../../../shared/layout-registry/options.ts'
import { deckCommitContext } from '../../../shared/deck-frame.ts'
import { LAYOUTS as REGISTRY_LAYOUTS } from '../../../shared/layout-registry/entries.ts'
import {
  applyLayoutSelection,
  commitOptionSelection,
  GLOBAL_OPTION_GROUPS,
  headingHasChildSlides,
  parseTriggerLine,
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

// CodeMirror's inline `{` picker and the Command-L picker deliberately consume the same section
// model. Keep this named entry point so parity tests exercise both UI data paths explicitly.
export const inlineLayoutPickerModel = layoutPickerModel

/**
 * A ⌘L / `{` row expands to the option rows of the entry under the cursor, so the picker asks the
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
      selectedToken: selectionForGroup(triggerLine, group)
    }))
}

/**
 * The ⌘L footer's two type-size controls. WHICH groups the strip is made of is a surface
 * composition (ADR-0011 §3 gives the palette a permanent type band); WHETHER they are relevant to
 * this slide is still the resolver's call, so the strip filters the resolved set rather than the
 * raw registry.
 */
export function pickerTypeStripModel(
  triggerLine: string,
  context: Pick<LayoutPickerContext, 'headingLevel' | 'hasChildren'> = NEUTRAL_SLIDE
): PickerOptionGroup[] {
  const applicable = new Set(optionGroupsForSlide(context).map(({ group }) => group))
  return GLOBAL_OPTION_GROUPS
    .filter((group) => applicable.has(group) && (group.key === 'font-body' || group.key === 'font-title'))
    .map((group) => ({ group, selectedToken: selectionForGroup(triggerLine, group) }))
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

export function selectionFromTriggerLine(line: string, items: LayoutDef[]): LayoutDef[] {
  const authored = parseTriggerLine(line).map((token) => token.raw)
  const authoredSet = new Set(authored)
  const authoredLayout = winningAuthoredLayout(line)
  return items.filter((item) =>
    (item.kind === 'layout' || item.kind === 'modifier' || item.kind === 'container') &&
    parseTriggerLine(item.trigger).some((token) =>
      authoredSet.has(token.raw)
      || (
        item.kind === 'layout'
        && authoredLayout?.layout === item.name
        && authored.some((raw) =>
          raw.includes('=') && layoutEntryAcceptsTriggerToken(item, raw)
        )
      )
    )
  )
}

export function commitLayoutSelection(
  line: string,
  initial: LayoutDef[],
  selected: LayoutDef[],
  layoutTokenOverride: string | undefined,
  context: OptionCommitContext
): string {
  if (
    layoutTokenOverride == null
    && initial.length === selected.length
    && initial.every((item, index) => item === selected[index])
  ) return line

  const layout = selected.find((item) => item.kind === 'layout')
  const initialModifiers = initial.filter((item) => item.kind === 'modifier')
  const initialContainers = initial.filter((item) => item.kind === 'container')
  const selectedModifiers = selected.filter((item) => item.kind === 'modifier')
  const selectedContainers = selected.filter((item) => item.kind === 'container')
  const containerMode = GLOBAL_OPTION_GROUPS.find((group) => group.key === 'container-mode')
  const modeTokens = new Set(containerMode?.values.map((value) => value.token).filter(Boolean) ?? [])
  const containerToken = (item: LayoutDef): string => parseTriggerLine(item.trigger)[0]?.raw ?? ''
  const initialModeContainers = initialContainers.filter((item) => modeTokens.has(containerToken(item)))
  const selectedModeContainer = selectedContainers.find((item) => modeTokens.has(containerToken(item)))
  const otherInitialContainers = initialContainers.filter((item) => !modeTokens.has(containerToken(item)))
  const otherSelectedContainers = selectedContainers.filter((item) => !modeTokens.has(containerToken(item)))
  const overrideGroup = layoutTokenOverride
    ? layout?.options?.find((group) =>
      group.values.some((value) => value.token === layoutTokenOverride)
      && group.values.some((value) => value.token === '')
    )
    : undefined
  const sourceLine = overrideGroup
    ? commitOptionSelection(line, overrideGroup, '', context)
    : line
  const result = applyLayoutSelection(sourceLine, {
    layout: layout ? layoutTokenOverride ?? parseTriggerLine(layout.trigger)[0]?.raw : undefined,
    modifiers: [...selectedModifiers, ...otherSelectedContainers]
      .flatMap((item) => parseTriggerLine(item.trigger).map((token) => token.raw)),
    removeModifiers: [...initialModifiers, ...otherInitialContainers]
      .filter((item) => ![...selectedModifiers, ...otherSelectedContainers]
        .some((selectedItem) => selectedItem.name === item.name))
      .flatMap((item) => parseTriggerLine(item.trigger).map((token) => token.raw))
  })
  return containerMode && (initialModeContainers.length > 0 || selectedModeContainer)
    ? commitOptionSelection(result, containerMode, selectedModeContainer ? containerToken(selectedModeContainer) : '', context)
    : result
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

export function toggleLayoutSelection(selected: LayoutDef[], item: LayoutDef): LayoutDef[] {
  const alreadySelected = selected.some((candidate) => candidate.name === item.name)
  if (item.kind !== 'layout' && alreadySelected) {
    return selected.filter((candidate) => candidate.name !== item.name)
  }
  if (item.kind === 'layout' || item.kind === 'container') {
    return [item, ...selected.filter((candidate) => candidate.kind !== item.kind)]
  }
  return alreadySelected ? selected : [...selected, item]
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
