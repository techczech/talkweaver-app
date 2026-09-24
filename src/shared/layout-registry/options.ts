// =============================================================================
// Which options belong to THIS slide (ADR-0020 §5 — "the Inspector shows only relevant options").
//
// This module decides NOTHING. Every rule is declared as data on the option group itself
// (`OptionGroup.appliesTo`, see entries.ts); `groupApplies` is the interpreter, and the three
// choosing surfaces — Inspector, ⌘L picker, inline `{` palette — read the one resolved set.
// Before ADR-0020 §5 landed, applicability was two `if`s on group NAMES here (the poll limits and
// Container mode), which is why Media placement rendered on a chart and Claim style on a table.
//
// The two rules that predate the declaration are preserved exactly, as data:
//   • poll limits — `pollselections` needs {poll=multiple}, `pollsubmissions` needs {poll=open},
//     and both are judged ONLY once a caller supplies the authored selection (a candidate listing
//     without `selectedTokens` keeps them, which is what the Inspector's two-stage filter wants);
//   • Container mode — a `##` section, or any heading with child slides. The same context gate
//     covers every option group a CONTAINER entry owns, so `{contents}`'s own variants stay hidden
//     on a plain `###`.
// =============================================================================
import { GLOBAL_OPTION_GROUPS, LAYOUTS } from './entries.ts'
import type { InspectorSectionId, LayoutDef, OptionApplicability, OptionGroup, TitleRegime } from './entries.ts'

export interface OptionContext {
  /** The layout's registry name, or a compiled slug/alias the registry can resolve back. */
  layoutName?: string
  headingLevel: number
  hasChildren: boolean
  /** group key → authored token, as parsed from the trigger line. Absent = not yet known. */
  selectedTokens?: Readonly<Record<string, string>>
  /** Overrides the resolved entry's regime when a caller already compiled one. */
  titleRegime?: TitleRegime
}

export interface ApplicableOptionGroup {
  group: OptionGroup
  source: 'entry' | 'global'
  owner?: LayoutDef
}

/**
 * The registry entry a layout name stands for. A projection row carries the COMPILED slug, which
 * is the entry name for most layouts but the resolved target for an alias ({table-outline} →
 * table) and the role slug for a divider ({role=section-title} → section).
 */
export function layoutEntryFor(layoutName?: string): LayoutDef | undefined {
  if (!layoutName) return undefined
  return LAYOUTS.find((entry) => entry.name === layoutName)
    ?? LAYOUTS.find((entry) => entry.resolvesTo?.key === 'layout' && entry.resolvesTo.value === layoutName)
    ?? LAYOUTS.find((entry) => entry.trigger === `{role=${layoutName}}`)
}

/**
 * One clause of an `appliesTo` declaration.
 *
 * Every declared facet must hold. A fact the context does not know never excludes a group: an
 * unresolved layout has no name, kind or regime, and `requiresTokens` waits for a caller that
 * parsed the trigger line.
 */
function clauseHolds(clause: OptionApplicability, context: OptionContext, entry?: LayoutDef): boolean {
  const layoutName = entry?.name ?? context.layoutName
  const titleRegime = context.titleRegime ?? entry?.titleRegime
  if (clause.kinds && entry && !clause.kinds.includes(entry.kind)) return false
  if (clause.layouts && layoutName && !clause.layouts.includes(layoutName)) return false
  if (clause.excludeLayouts && layoutName && clause.excludeLayouts.includes(layoutName)) return false
  if (clause.titleRegimes && titleRegime && !clause.titleRegimes.includes(titleRegime)) return false
  if (clause.headingLevels && !clause.headingLevels.includes(context.headingLevel)) return false
  if (clause.requiresChildren && !context.hasChildren) return false
  if (clause.requiresTokens && context.selectedTokens) {
    for (const [key, accepted] of Object.entries(clause.requiresTokens)) {
      if (!accepted.includes(context.selectedTokens[key] ?? '')) return false
    }
  }
  if (clause.anyOf && !clause.anyOf.some((alternative) => clauseHolds(alternative, context, entry))) return false
  return true
}

/** Any option group a CONTAINER entry owns is a container-context choice, Container mode included. */
function containerContextOnly(group: OptionGroup): boolean {
  return LAYOUTS.some((entry) => entry.kind === 'container' && entry.options?.includes(group))
}

/**
 * A heading that can hold child slides: a `##` section by construction, or any heading that
 * already has them. The ⌘L picker hides its Container section by the same test, so the rule lives
 * here once rather than being restated on each surface.
 */
export function isContainerContext(context: Pick<OptionContext, 'headingLevel' | 'hasChildren'>): boolean {
  return context.headingLevel === 2 || context.hasChildren
}

export function groupApplies(group: OptionGroup, context: OptionContext): boolean {
  if (containerContextOnly(group) && !isContainerContext(context)) return false
  const entry = layoutEntryFor(context.layoutName)
  // A group declared inside a layout's own `options` applies to that layout by construction.
  if (entry?.options?.includes(group)) return true
  return group.appliesTo ? clauseHolds(group.appliesTo, context, entry) : true
}

/** Every option group the registry declares, deduplicated by identity: the global groups plus
 *  each layout entry's own (iconlist-variant is both global and adopted by the iconlist entry).
 *  Registry order, so consumers iterate deterministically. */
export function registryOptionGroups(): OptionGroup[] {
  const seen = new Set<OptionGroup>()
  for (const group of GLOBAL_OPTION_GROUPS) seen.add(group)
  for (const entry of LAYOUTS) for (const group of entry.options ?? []) seen.add(group)
  return [...seen]
}

function tokenClauseHolds(clause: OptionApplicability | undefined, selectedTokens: Readonly<Record<string, string>>): boolean {
  if (!clause) return true
  if (clause.requiresTokens) {
    for (const [key, accepted] of Object.entries(clause.requiresTokens)) {
      if (!accepted.includes(selectedTokens[key] ?? '')) return false
    }
  }
  if (clause.anyOf) return clause.anyOf.some((alternative) => tokenClauseHolds(alternative, selectedTokens))
  return true
}

/**
 * The token-decidable half of an `appliesTo` declaration — what a Trigger line alone can answer
 * about a group's relevance. `requiresTokens` clauses (and `anyOf` over them) are evaluated
 * against the authored selections; every other facet (layout, heading level, children) is a fact
 * the line does not carry, and by the interpreter's own rule an unknown fact never excludes, so
 * such clauses count as holding. `commitOptionSelection` sweeps with this, so the commit-side
 * cleanup reads the same declared relevance the Inspector shows — never group-name `if`s.
 */
export function appliesToHoldsOnTokens(group: OptionGroup, selectedTokens: Readonly<Record<string, string>>): boolean {
  return tokenClauseHolds(group.appliesTo, selectedTokens)
}

export function optionGroupsForSlide(
  context: Pick<OptionContext, 'layoutName' | 'headingLevel' | 'hasChildren' | 'titleRegime'>
): ApplicableOptionGroup[] {
  const entry = layoutEntryFor(context.layoutName)
  const entryGroups = (entry?.options ?? [])
    .filter((group) => groupApplies(group, context))
    .map((group) => ({ group, source: 'entry' as const, owner: entry }))
  const entryGroupSet = new Set(entryGroups.map(({ group }) => group))
  const sectionModifierGroups = context.headingLevel === 2
    ? LAYOUTS.filter((candidate) => candidate !== entry && candidate.kind === 'modifier' && candidate.sectionOnly)
      .flatMap((candidate) => (candidate.options ?? []).map((group) => ({ group, source: 'entry' as const, owner: candidate })))
    : []
  const globalGroups = GLOBAL_OPTION_GROUPS
    // A layout that adopts a global group as its own (table → Media placement) must not render it
    // twice; the entry copy already carries the layout's own ordering.
    .filter((group) => !entryGroupSet.has(group) && groupApplies(group, context))
    .map((group) => ({ group, source: 'global' as const }))
  return [...entryGroups, ...sectionModifierGroups, ...globalGroups]
}

// ── T32 (Decision 2A): the Inspector's sections ────────────────────────────────────────────
//
// Two ordering rules from the locked sheet, both read from the registry's own declarations — no
// group is named here:
//   1. The slide's own layout comes first: every group its entry owns, and every global group a
//      MODIFIER entry adopts (iconlist → iconlist-variant). Then Title, Slide (the catch-all for an
//      undeclared global group), Steps and Poll, by `OptionGroup.section`. Empty sections drop out.
//   2. A group that only applies because of another group's value sits directly under that group,
//      nested, in that group's section. "Because of" is the group's `appliesTo.requiresTokens`:
//      the parent is the FIRST group those clauses name (in declaration order, `anyOf` included)
//      that this slide offers. iconlist-variant's rule reads list-style first, so the treatment
//      nests under List style however the icons were switched on.

export interface SectionedOptionBinding extends ApplicableOptionGroup {
  /** The key of the group this one nests under, when rule 2 places it. */
  nestedUnder?: string
}

export interface InspectorOptionSection {
  id: InspectorSectionId
  heading: string
  bindings: SectionedOptionBinding[]
}

const SECTION_RUN: ReadonlyArray<{ id: InspectorSectionId; heading: string }> = [
  { id: 'layout', heading: 'Layout' },
  { id: 'title', heading: 'Title' },
  { id: 'slide', heading: 'Slide' },
  { id: 'steps', heading: 'Steps' },
  { id: 'poll', heading: 'Poll' }
]

/** The group keys an `appliesTo` declaration's token clauses read, in declaration order. */
function tokenDependencies(clause: OptionApplicability | undefined): string[] {
  if (!clause) return []
  const keys = Object.keys(clause.requiresTokens ?? {})
  for (const alternative of clause.anyOf ?? []) keys.push(...tokenDependencies(alternative))
  return [...new Set(keys)]
}

function adoptedByModifier(group: OptionGroup): boolean {
  return LAYOUTS.some((entry) => entry.kind === 'modifier' && entry.options?.includes(group))
}

function ownSection(binding: ApplicableOptionGroup): InspectorSectionId {
  if (binding.source === 'entry' || adoptedByModifier(binding.group)) return 'layout'
  return binding.group.section ?? 'slide'
}

/**
 * The groups a slide already resolved (`optionGroupsForSlide`, re-filtered by `groupApplies`),
 * sectioned and ordered for the Inspector's options column. The layout section is headed by the
 * layout's own label.
 */
export function sectionedOptionGroups(
  bindings: readonly ApplicableOptionGroup[],
  layoutLabel?: string
): InspectorOptionSection[] {
  const offered = new Map(bindings.map((binding) => [binding.group.key, binding]))
  const parentOf = new Map<ApplicableOptionGroup, ApplicableOptionGroup>()
  for (const binding of bindings) {
    const parentKey = tokenDependencies(binding.group.appliesTo)
      .find((key) => key !== binding.group.key && offered.has(key))
    const parent = parentKey ? offered.get(parentKey) : undefined
    // One level only: a parent that is itself nested keeps its child at top level of the section.
    if (parent) parentOf.set(binding, parent)
  }
  for (const [child, parent] of [...parentOf]) if (parentOf.has(parent)) parentOf.delete(child)

  const childrenOf = new Map<ApplicableOptionGroup, ApplicableOptionGroup[]>()
  for (const [child, parent] of parentOf) childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), child])

  const buckets = new Map<InspectorSectionId, SectionedOptionBinding[]>()
  for (const binding of bindings) {
    if (parentOf.has(binding)) continue
    const bucket = buckets.get(ownSection(binding)) ?? []
    bucket.push(binding)
    for (const child of childrenOf.get(binding) ?? []) bucket.push({ ...child, nestedUnder: binding.group.key })
    buckets.set(ownSection(binding), bucket)
  }
  return SECTION_RUN
    .map(({ id, heading }) => ({
      id,
      heading: id === 'layout' ? (layoutLabel ?? heading) : heading,
      bindings: buckets.get(id) ?? []
    }))
    .filter((section) => section.bindings.length > 0)
}
