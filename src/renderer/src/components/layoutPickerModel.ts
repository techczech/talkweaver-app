import type { LayoutDef, OptionGroup, OptionValue } from '../data/layouts'
import {
  applyLayoutSelection,
  commitOptionSelection,
  GLOBAL_OPTION_GROUPS,
  parseTriggerLine,
  selectionForGroup
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

export function layoutPickerModel(
  items: LayoutDef[],
  context: Pick<LayoutPickerContext, 'headingLevel' | 'hasChildren'>
): PickerSection[] {
  return PICKER_SECTIONS
    .filter((section) => section.kind !== 'container' || context.headingLevel === 2 || context.hasChildren)
    .map((section) => ({ ...section, entries: items.filter((item) => item.kind === section.kind) }))
    .filter((section) => section.entries.length > 0)
}

// CodeMirror's inline `{` picker and the Command-L picker deliberately consume the same section
// model. Keep this named entry point so parity tests exercise both UI data paths explicitly.
export const inlineLayoutPickerModel = layoutPickerModel

export function optionGroupsForPickerEntry(
  entry: LayoutDef,
  triggerLine: string
): PickerOptionGroup[] {
  return (entry.options ?? []).map((group) => ({
    group,
    selectedToken: selectionForGroup(triggerLine, group)
  }))
}

export function pickerTypeStripModel(triggerLine: string): PickerOptionGroup[] {
  return GLOBAL_OPTION_GROUPS
    .filter((group) => group.key === 'font-body' || group.key === 'font-title')
    .map((group) => ({ group, selectedToken: selectionForGroup(triggerLine, group) }))
}

export function inlineOptionPickerStep(
  entry: LayoutDef,
  triggerLine: string,
  query: string
): InlineOptionPickerStep | null {
  const binding = optionGroupsForPickerEntry(entry, triggerLine)[0]
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
export function commitPickerOption(line: string, group: OptionGroup, token: string): string {
  return commitOptionSelection(line, group, token)
}

export function layoutSubmenuEntries(items: LayoutDef[]): LayoutDef[] {
  return items.filter((item) => item.kind === 'layout')
}

export function selectionFromTriggerLine(line: string, items: LayoutDef[]): LayoutDef[] {
  const authored = new Set(parseTriggerLine(line).map((token) => token.raw))
  return items.filter((item) =>
    (item.kind === 'layout' || item.kind === 'modifier' || item.kind === 'container') &&
    parseTriggerLine(item.trigger).some((token) => authored.has(token.raw))
  )
}

export function commitLayoutSelection(
  line: string,
  initial: LayoutDef[],
  selected: LayoutDef[]
): string {
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
  const result = applyLayoutSelection(line, {
    layout: layout ? parseTriggerLine(layout.trigger)[0]?.raw : undefined,
    modifiers: [...selectedModifiers, ...otherSelectedContainers]
      .flatMap((item) => parseTriggerLine(item.trigger).map((token) => token.raw)),
    removeModifiers: [...initialModifiers, ...otherInitialContainers]
      .filter((item) => ![...selectedModifiers, ...otherSelectedContainers]
        .some((selectedItem) => selectedItem.name === item.name))
      .flatMap((item) => parseTriggerLine(item.trigger).map((token) => token.raw))
  })
  return containerMode && (initialModeContainers.length > 0 || selectedModeContainer)
    ? commitOptionSelection(result, containerMode, selectedModeContainer ? containerToken(selectedModeContainer) : '')
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
