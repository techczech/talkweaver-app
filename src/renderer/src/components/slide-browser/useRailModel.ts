// The rail's derived data (all over in-memory rows — no IPC in the hot path): the Files tree
// source, scope-row counts, the collections lenses, and the facet vocabularies with counts.
import { useMemo } from 'react'
import type { RecordingSession, TagCount, TalkInfo, TalkMeta } from '../../../../preload/index'
import { LAYOUTS } from '../../data/layouts'
import {
  type RailFacets, type ScopeEntry, facetKindBases, rowInScope, rowInScopeEntry
} from '../browser-rail/railModel'
import type { BrowserRow } from '../slideBrowserModel'
import type { CollectionRow, ContentItem, FacetItem } from '../browser-rail/railTypes'
import type { FilesTreeSource } from '../browser-rail/filesTreeModel'
import { lastDeliveredBySlug, readSortPreference } from '../talklist/model'
import {
  contentFacetItems, countByTalk, coverUrlOf, deliveryRows, layoutFacetItems, recentEditRows,
  rowTagsOf, sectionFacetItems, tagFacetItems, treeSectionsBySlug
} from './browserHelpers'
import type { SearchResult } from './types'

export function useRailModel({
  fullRows, visibleResults, talks, vaultFolders, vaultRoot, talkMeta, deliverySessions, tagVocab,
  currentTalkSlug, scope, facets, folderBySlug, folderOf, secName, secLabelOf, sectionNames, titleBySlug
}: {
  fullRows: SearchResult[]
  visibleResults: SearchResult[]
  talks: TalkInfo[]
  vaultFolders: string[]
  vaultRoot: string
  talkMeta: TalkMeta
  deliverySessions: RecordingSession[]
  tagVocab: TagCount[]
  currentTalkSlug: string
  scope: ScopeEntry[]
  facets: RailFacets
  folderBySlug: Map<string, string>
  folderOf: (slug: string) => string
  secName: (key: string, fallback: string) => string
  secLabelOf: (r: BrowserRow) => string
  sectionNames: Map<string, string>
  titleBySlug: Map<string, string>
}) {
  const countBySlug = useMemo(() => countByTalk(fullRows), [fullRows])

  // Files tree (ADR-0029 §4; frame K1): the file list's tree with slide counts. Folders and
  // talks are disk truth (the vault talk and folder lists, in the file list's sort); sections are
  // observed from the full index snapshot, in outline order, with authored labels.
  const sectionsBySlug = useMemo(
    () => treeSectionsBySlug(fullRows, secName),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fullRows, sectionNames]
  )
  const filesSource = useMemo<FilesTreeSource>(() => ({
    talks,
    folders: vaultFolders,
    vaultRoot,
    sortKey: readSortPreference(),
    meta: talkMeta,
    delivered: lastDeliveredBySlug(deliverySessions),
    slidesOf: (slug) => countBySlug.get(slug) ?? talkMeta[slug]?.slideCount ?? 0,
    sectionsOf: (slug) => sectionsBySlug.get(slug) ?? [],
    currentTalkSlug
  }), [talks, vaultFolders, vaultRoot, talkMeta, deliverySessions, countBySlug, sectionsBySlug, currentTalkSlug])

  const scopeCounts = useMemo(
    () => scope.map((e) => fullRows.reduce((n, r) => n + (rowInScopeEntry(r, e, folderOf) ? 1 : 0), 0)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scope, fullRows, folderBySlug]
  )
  function coverUrlFor(e: ScopeEntry): string | null {
    return coverUrlOf(e.talk, talkMeta)
  }

  // Collections: lenses over the vault (recently edited via talkMeta; recently delivered
  // via the recording ledger's delivery sessions, latest first).
  const recentEdits = useMemo<CollectionRow[]>(() => recentEditRows(talkMeta, titleBySlug), [talkMeta, titleBySlug])
  const deliveries = useMemo<CollectionRow[]>(
    () => deliveryRows(deliverySessions, titleBySlug),
    [deliverySessions, titleBySlug]
  )

  // Facet vocabularies + counts. Scope + search always condition everything; on top of that
  // (v0.15.2 tweak) each kind's counts are CONDITIONED BY THE OTHER ACTIVE KINDS — leave-one-
  // out, the standard faceted-search law — so combining filters can never dead-end
  // unannounced (layout=list 576 + has-code 60 → zero was exactly this lie). A chip whose
  // conditioned count is 0 renders dimmed (still clickable) with "0". All in-memory: one
  // pass per facet-state change over the already-filtered rows, memoised — no IPC.
  const baseRows = useMemo(
    () => visibleResults.filter((r) => rowInScope(r, scope, folderOf)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visibleResults, scope, folderBySlug]
  )
  const facetBases = useMemo(
    () => facetKindBases(baseRows, facets, secLabelOf, rowTagsOf),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [baseRows, facets, sectionNames]
  )
  const layoutItems = useMemo<FacetItem[]>(
    () => layoutFacetItems(LAYOUTS.filter((l) => l.kind === 'layout').map((l) => l.name), fullRows, facetBases.lay),
    [fullRows, facetBases]
  )
  const contentItems = useMemo<ContentItem[]>(() => contentFacetItems(facetBases.ct), [facetBases])
  const tagItems = useMemo<FacetItem[]>(
    () => tagFacetItems(tagVocab, fullRows, facetBases.tags),
    [tagVocab, fullRows, facetBases]
  )
  const sectionItems = useMemo<FacetItem[]>(
    () => sectionFacetItems(baseRows, facetBases.secs, facets.sectionSet, secLabelOf),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [baseRows, facetBases, facets.sectionSet, sectionNames]
  )

  return {
    filesSource, scopeCounts, coverUrlFor, recentEdits, deliveries,
    layoutItems, contentItems, tagItems, sectionItems
  }
}
