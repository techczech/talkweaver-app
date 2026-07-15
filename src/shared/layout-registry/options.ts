import { GLOBAL_OPTION_GROUPS, LAYOUTS } from './entries.ts'
import type { LayoutDef, OptionGroup } from './entries.ts'

export interface OptionContext {
  layoutName?: string
  headingLevel: number
  hasChildren: boolean
  selectedTokens?: Readonly<Record<string, string>>
}

export interface ApplicableOptionGroup {
  group: OptionGroup
  source: 'entry' | 'global'
  owner?: LayoutDef
}

export function groupApplies(group: OptionGroup, context: OptionContext): boolean {
  if (group.key === 'container-mode') return context.headingLevel === 2 || context.hasChildren
  const containerOwner = LAYOUTS.find((entry) =>
    entry.kind === 'container' && entry.options?.includes(group)
  )
  return !containerOwner || context.headingLevel === 2 || context.hasChildren
}

export function optionGroupsForSlide(
  context: Pick<OptionContext, 'layoutName' | 'headingLevel' | 'hasChildren'>
): ApplicableOptionGroup[] {
  const entry = LAYOUTS.find((candidate) => candidate.name === context.layoutName)
  const entryGroups = (entry?.options ?? [])
    .filter((group) => groupApplies(group, context))
    .map((group) => ({ group, source: 'entry' as const, owner: entry }))
  const sectionModifierGroups = context.headingLevel === 2
    ? LAYOUTS.filter((candidate) => candidate !== entry && candidate.kind === 'modifier' && candidate.sectionOnly)
      .flatMap((candidate) => (candidate.options ?? []).map((group) => ({ group, source: 'entry' as const, owner: candidate })))
    : []
  const globalGroups = GLOBAL_OPTION_GROUPS
    .filter((group) => groupApplies(group, context))
    .map((group) => ({ group, source: 'global' as const }))
  return [...entryGroups, ...sectionModifierGroups, ...globalGroups]
}
