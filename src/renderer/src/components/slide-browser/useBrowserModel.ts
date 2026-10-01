// The Slide Browser's display model: what the grid shows and in what order. Scope + facets AND on
// top of main's query result; the active talk is never on the table; duplicates collapse into
// stacks (or, in the scoped views, every occurrence shows in outline order); an optional talk
// beside the results extends the visual order. Selection, ranges and keyboard nav all run over
// `vRows`, the visual order.
import { useMemo } from 'react'
import type { TalkInfo } from '../../../../preload/index'
import {
  type RailFacets, type ScopeEntry,
  anyFacetActive, gridModeFor, inFolder, passesFacets, rowInScope, scopedTalkSlugs
} from '../browser-rail/railModel'
import {
  type BrowserRow, type DisplayCard, buildDisplayModel, rankBySearch, sectionKey
} from '../slideBrowserModel'
import { type PickerMain, besideAvailable, besidePlan } from '../talkBesideModel'
import {
  buildOutlinePlan, folderMap, mergedSectionNames, rowTagsOf, rowsGroupedByTalk, sectionNumbers, titleMap,
  withoutActiveTalk
} from './browserHelpers'
import { SIDE_MAX, type SearchResult } from './types'
import { currentVaultFirst } from './vaultChipsModel'

export function useBrowserModel({
  results, fullRows, talks, vaultRoot, currentTalkSlug, scope, facets, query, nearExpanded, viewPref,
  main, loading, unavailable, currentVaultId = null
}: {
  results: SearchResult[]
  fullRows: SearchResult[]
  talks: TalkInfo[]
  vaultRoot: string
  currentTalkSlug: string
  scope: ScopeEntry[]
  facets: RailFacets
  query: string
  nearExpanded: Set<string>
  viewPref: 'side' | 'seq'
  main: PickerMain
  loading: boolean
  unavailable: boolean
  /** The open talk's vault (ticket 06): its results come first, each vault in search order. */
  currentVaultId?: string | null
}) {
  // Each talk's vault-relative folder path, nested folders at their real depth (ADR-0029 §4):
  // two folders called `day-3` in different places stay apart. '' = the vault root.
  const folderBySlug = useMemo(() => folderMap(talks, vaultRoot), [talks, vaultRoot])
  const folderOf = (slug: string): string => folderBySlug.get(slug) ?? ''
  // A folder scope takes in its subfolders, as the Files tree's folder total does.
  const talksInFolder = (folder: string): string[] =>
    talks.filter((t) => inFolder(folderBySlug.get(t.slug) ?? '', folder)).map((t) => t.slug)

  // The projection's `section` is a slug — show the AUTHORED section names (from the
  // section-title rows), resolved over the FULL snapshot (stable while a query narrows
  // `results`) with the live results as fallback.
  const sectionNames = useMemo(() => mergedSectionNames(fullRows, results), [fullRows, results])
  const secName = (key: string, fallback: string): string => sectionNames.get(key) ?? fallback
  // Insert section (K4): each heading's source and N come from the WHOLE talk (the unqueried
  // snapshot), never from the slides a search or filter left showing.
  const rowsByTalk = useMemo(() => rowsGroupedByTalk(fullRows), [fullRows])
  // A row's section as the Sections facet sees it — the display label (observed identity,
  // stage-3-lite: the section STRING across the scoped set, not per-talk identity).
  const secLabelOf = (r: BrowserRow): string => secName(sectionKey(r.talkSlug, r.section ?? ''), r.section ?? '')

  // ---------- the active talk is NEVER on the table (v0.15.x decision) ----------
  // The Browser's corpus is every talk EXCEPT the one being edited — its own slides live in
  // the grid/strip and were only ever confusing here. Applies to every result view (grouped,
  // searched, filtered, scoped); the Files tree still lists it (dimmed, non-scoping) because
  // the tree tells disk truth.
  const visibleResults = useMemo(() => withoutActiveTalk(results, currentTalkSlug), [results, currentTalkSlug])

  // ---------- scope + facets + duplicate collapse into the display model ----------
  // The composition law: main's search already applied the query; scope and facets AND on
  // top as a passing-set predicate. Cluster over the FULL unfiltered visible set (occurrence-
  // exactness — engine caveat F3) and collapse byte-identical / near clusters into stacks.
  const passingSet = useMemo(() => {
    const s = new Set<SearchResult>()
    for (const r of visibleResults) {
      if (rowInScope(r, scope, folderOf) && passesFacets(r, facets, secLabelOf, rowTagsOf)) s.add(r)
    }
    return s
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleResults, scope, facets, folderBySlug, sectionNames])
  // Title-priority ordering (only with a query active): float title-hit rows to the front BEFORE
  // grouping/clustering, so within each talk·section group the title matches surface first. Same
  // row objects, reordered — passingSet membership (object identity) is unaffected.
  // Ticket 06: the current talk's vault first, the other open vaults after; inside each, the
  // existing ranking.
  const ranked = useMemo(
    () => currentVaultFirst(query.trim() !== '' ? rankBySearch(visibleResults) : visibleResults, currentVaultId),
    [visibleResults, query, currentVaultId]
  )
  const display = useMemo(
    () => buildDisplayModel(ranked, (r) => passingSet.has(r as SearchResult), nearExpanded),
    [ranked, passingSet, nearExpanded]
  )
  const groupTotals = useMemo(() => {
    const totals = buildDisplayModel(visibleResults, () => true, new Set<string>())
    const m = new Map<string, number>()
    for (const g of totals.groups) m.set(sectionKey(g.talkSlug, g.section), g.units)
    return m
  }, [visibleResults])
  const groups = display.groups

  // ---------- grid mode (ADR-0009): scope decides how the grid reads ----------
  // A saved scope that pins the active talk drops it SILENTLY from the effective scope
  // (folders containing it simply expand without it).
  const scopedSlugs = useMemo(
    () => scopedTalkSlugs(scope, talksInFolder).filter((s) => s !== currentTalkSlug),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scope, talks, folderBySlug, currentTalkSlug]
  )
  const gridMode = gridModeFor(scopedSlugs.length, viewPref === 'side')
  const sideEligible = scopedSlugs.length >= 2 && scopedSlugs.length <= SIDE_MAX

  const outlinePlan = useMemo(
    () => buildOutlinePlan({
      grouped: gridMode === 'grouped', scopedSlugs, visibleResults, passing: (r) => passingSet.has(r), talks, secName
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [gridMode, scopedSlugs, visibleResults, passingSet, talks, sectionNames]
  )

  // The talk beside the results (K5): its whole deck from the index snapshot, section by section,
  // the result's slide highlighted. Only in the grouped and outline views (columns fill the area).
  const besidePlanNow = useMemo(() => {
    if (!main.beside || !besideAvailable(gridMode)) return null
    return besidePlan(
      main.beside, fullRows, results,
      (slug, sec) => secName(sectionKey(slug, sec), sec),
      (slug) => talks.find((t) => t.slug === slug)?.title ?? ''
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [main.beside, gridMode, fullRows, results, talks, sectionNames])
  const besideOn = besidePlanNow !== null

  // The results' VISUAL order (one entry per rendered card; side-by-side flattens column-major).
  const leftCards = useMemo<DisplayCard[]>(
    () => (gridMode === 'grouped'
      ? display.cards
      : outlinePlan.flatMap((t) => t.chunks.flatMap((c) => c.cards))),
    [gridMode, display, outlinePlan]
  )
  const leftCount = leftCards.length
  // The grid's visual order: the results, then (when open) the talk beside them. Selection, ranges
  // and keyboard nav all run over this order; the results keep their positions either way.
  const vCards = useMemo<DisplayCard[]>(
    () => (besidePlanNow
      ? [...leftCards, ...besidePlanNow.deck.map((row) => ({ row, kind: 'single' as const }))]
      : leftCards),
    [leftCards, besidePlanNow]
  )
  const vRows = useMemo(() => vCards.map((c) => c.row) as SearchResult[], [vCards])
  // row → its display card, so an insert can spot a mergeable identical stack (the merge nudge).
  const cardByRow = useMemo(() => {
    const m = new Map<SearchResult, DisplayCard>()
    for (const c of vCards) m.set(c.row as SearchResult, c)
    return m
  }, [vCards])

  // §-numbers for card origins + the locations panel, per talk in first-appearance order.
  const sectionNoByKey = useMemo(() => sectionNumbers(visibleResults), [visibleResults])
  // Display titles: vault list first (covers talks with no matching rows), results fallback.
  const titleBySlug = useMemo(() => titleMap(talks, results), [talks, results])

  const facetsOn = anyFacetActive(facets)
  const scopeOn = scope.length > 0
  const filtersOn = facetsOn || scopeOn
  const vaultEmpty = !loading && !unavailable && results.length === 0 && query.trim() === '' && !facetsOn
  const zeroResults = !loading && !unavailable && !vaultEmpty && leftCount === 0

  return {
    folderBySlug, folderOf, sectionNames, secName, secLabelOf, rowsByTalk, visibleResults,
    display, groupTotals, groups, scopedSlugs, gridMode, sideEligible, outlinePlan,
    besidePlanNow, besideOn, leftCards, leftCount, vCards, vRows, cardByRow,
    sectionNoByKey, titleBySlug, sectionCount: display.sectionCount,
    facetsOn, scopeOn, filtersOn, vaultEmpty, zeroResults
  }
}
