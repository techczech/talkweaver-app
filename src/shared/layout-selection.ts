// The Trigger-line layout selection: which registry entries a line names, how a pick toggles the
// selection, and how a selection is written back to the line. One implementation shared by the
// renderer's picker (↵, the Inspector) and the headless layout verbs (src/shared/layout-verbs.ts),
// so a verb writes byte for byte what the picker writes. Pure: no DOM, no Electron.
import type { LayoutDef } from './layout-registry/entries.ts'
import { layoutEntryAcceptsTriggerToken, winningAuthoredLayout } from './layout-registry/vocabulary.ts'
import {
  applyLayoutSelection,
  commitOptionSelection,
  GLOBAL_OPTION_GROUPS,
  parseTriggerLine,
  type OptionCommitContext
} from './trigger-line.ts'

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
