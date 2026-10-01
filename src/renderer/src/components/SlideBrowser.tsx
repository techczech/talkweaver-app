// Slide Browser — the Light Table (ADR-0034, PRD A1/A2/A6). Full-workspace overlay on ⌘S.
// v0.15 wave-1 (ADR-0009): the left side is the UNIFIED RAIL — Search finds · Scope pins
// places · Browse walks them · Filters narrow by property — and the grid answers the scope:
// no scope = grouped by talk·section; one talk = outline order with position badges; 2–3
// talks = side-by-side sticky-headed columns (toggleable to sequential); >3 = sequential.
// The plumbing (insert contract, selection tray, filmstrip, adopt, merge, tags, progressive
// thumbnails) is unchanged from the pre-rail Browser. v0.15.x: the ACTIVE talk's slides are
// never on the table (the grid/strip serves them), and ↵ opens the INSERT-DECISION VIEWER —
// never the editor, never a talk switch.
//
// This file is the thin shell: it owns the state that spans the whole overlay and composes the
// modules in ./slide-browser/ (hooks for the stateful logic, components for the pieces, and
// browserHelpers.ts for the pure derivations).
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { hasSearchTerms } from '../../../shared/talk-query'
import { findChips } from './browser-rail/findTalkModel'
import { agoLabel } from './browser-rail/railModel'
import InsertViewer from './InsertViewer'
import SlidePickerHints from './SlidePickerHints'
import TagPicker from './TagPicker'
import { parseSearchQuery } from './slideBrowserModel'
import { type PickerMain, RESULTS_ONLY, besideAvailable } from './talkBesideModel'
import {
  clampDensity, countLabelFor, expansionPos, readDensity
} from './slide-browser/browserHelpers'
import { LocationsPanel } from './slide-browser/LocationsPanel'
import { PreviewLightbox } from './slide-browser/PreviewLightbox'
import { RailPane } from './slide-browser/RailPane'
import { ResultsPane } from './slide-browser/ResultsPane'
import { SelectionTray } from './slide-browser/SelectionTray'
import { TopBar } from './slide-browser/TopBar'
import {
  DENSITY_STORAGE_KEY, type GridCtx, type SearchResult, type SlideBrowserProps
} from './slide-browser/types'
import { useBeside } from './slide-browser/useBeside'
import { useBrowserModel } from './slide-browser/useBrowserModel'
import { useExpansions } from './slide-browser/useExpansions'
import { useInsert } from './slide-browser/useInsert'
import { usePickerCommands } from './slide-browser/usePickerCommands'
import { useRailModel } from './slide-browser/useRailModel'
import { useRailState } from './slide-browser/useRailState'
import { useSelection } from './slide-browser/useSelection'
import { useSlideBrowserKeys } from './slide-browser/useSlideBrowserKeys'
import { useSlideSearch, useVaultReferences } from './slide-browser/useSlideSearch'
import { useSnapshotFetch } from './slide-browser/useSnapshotFetch'
import { useTagging } from './slide-browser/useTagging'
import { useThumbRegen } from './slide-browser/useThumbRegen'
import { useViewer } from './slide-browser/useViewer'
import { VersionStrip } from './slide-browser/VersionStrip'
import { VaultChips } from './slide-browser/VaultChips'
import {
  type ChipVault, chipVaults, countByVault, currentVaultIdFor, offVaultMatches, rowsInVaults, toggleVault
} from './slide-browser/vaultChipsModel'
import { withoutActiveTalk } from './slide-browser/browserHelpers'
import type { VaultView } from '../../../preload/index'

export type { SearchResult } from './slide-browser/types'

export default function SlideBrowser({
  isOpen, onClose, onInsert, onInsertMany, currentTalkSlug, vaultRoot, onOpenHelp, suspendKeys,
  onAdoptVersion, registerFocusSearch, registerCommands, onRequestMerge, refreshNonce,
  currentOutlinePath, currentTalkVaultId
}: SlideBrowserProps) {
  const [query, setQuery] = useState('')
  const [activePos, setActivePos] = useState(0)
  const [preview, setPreview] = useState(false)
  const [density, setDensityState] = useState<number>(readDensity)
  const [railCollapsed, setRailCollapsed] = useState(false)
  const [openPop, setOpenPop] = useState<string | null>(null)
  // settings-glimpse local state (real settings land in Task 11)
  const [glimpseDensity, setGlimpseDensity] = useState<number>(readDensity)
  const [glimpseLastFilters, setGlimpseLastFilters] = useState(true)
  const [glimpseScoped, setGlimpseScoped] = useState(false)
  // Near-cluster keys the user has UNcollapsed (variants shown inline) — the display model reads them.
  const [nearExpanded, setNearExpanded] = useState<Set<string>>(() => new Set())
  // A result's talk beside the results (talk search 06; ADR-0029 §4; frame K5): results only, or
  // results plus one talk on the right; and what Esc restores (see talkBesideModel).
  const [main, setMain] = useState<PickerMain>(RESULTS_ONLY)

  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const prevFocusRef = useRef<HTMLElement | null>(null)

  // The query parsed into scope/exact/terms — sent to main (scoped matching) and read by the
  // zero-results copy (which field the empty search looked in).
  const parsedQuery = useMemo(() => parseSearchQuery(query), [query])

  // Vault chips (ticket 06): every open vault is searched; a chip leaves its vault out of THIS
  // opening only. The vault list is read each time the Browser opens.
  const [vaultList, setVaultList] = useState<VaultView[] | null>(null)
  const [offVaults, setOffVaults] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    if (!isOpen) { setVaultList(null); return }
    let live = true
    setOffVaults(new Set())
    window.tw.vault.list()
      .then((list) => { if (live) setVaultList(list || []) })
      .catch(() => { if (live) setVaultList([]) })
    return () => { live = false }
  }, [isOpen])
  const currentVaultId = useMemo(
    () => currentVaultIdFor(vaultList ?? [], currentOutlinePath, currentTalkVaultId),
    [vaultList, currentOutlinePath, currentTalkVaultId]
  )
  const chips = useMemo(() => chipVaults(vaultList ?? [], currentVaultId), [vaultList, currentVaultId])
  const openVaultIds = useMemo(() => (vaultList === null ? null : chips.filter((c) => !c.unavailable).map((c) => c.id)), [vaultList, chips])
  const vaultById = useMemo(() => new Map<string, ChipVault>(chips.map((c) => [c.id, c])), [chips])
  const severalVaults = chips.length > 1

  const thumbs = useThumbRegen(isOpen)
  const vault = useVaultReferences(isOpen)
  const search = useSlideSearch({ isOpen, parsedQuery, refreshNonce, onLanded: () => setActivePos(0), vaultIds: openVaultIds })
  const { fullRows } = search
  // What each chip counts: the matches its vault has on the table (the open talk is never on it).
  const vaultCounts = useMemo(() => countByVault(withoutActiveTalk(search.results, currentTalkSlug)), [search.results, currentTalkSlug])
  const results = useMemo(() => rowsInVaults(search.results, offVaults), [search.results, offVaults])
  const hiddenInOff = offVaultMatches(chips, vaultCounts, offVaults)
  const rail = useRailState(currentTalkSlug)

  const model = useBrowserModel({
    results, fullRows, talks: vault.talks, vaultRoot, currentTalkSlug, scope: rail.scope,
    facets: rail.facets, query, nearExpanded, viewPref: rail.viewPref, main,
    loading: search.loading, unavailable: search.unavailable, currentVaultId
  })
  const { vRows, vCards, gridMode, leftCount, rowsByTalk } = model
  const railModel = useRailModel({
    fullRows, visibleResults: model.visibleResults, talks: vault.talks, vaultFolders: vault.vaultFolders,
    vaultRoot, talkMeta: vault.talkMeta, deliverySessions: vault.deliverySessions, tagVocab: vault.tagVocab,
    currentTalkSlug, scope: rail.scope, facets: rail.facets, folderBySlug: model.folderBySlug,
    folderOf: model.folderOf, secName: model.secName, secLabelOf: model.secLabelOf,
    sectionNames: model.sectionNames, titleBySlug: model.titleBySlug
  })

  const selection = useSelection({ vRows, activePos, rowsByTalk, fullRows })
  const { selected } = selection
  const tagging = useTagging({ selected, selectedRows: selection.selectedRows })
  const ex = useExpansions({
    isOpen, vRows, vCards, vaultRoot, onInsert, setNearExpanded
  })
  const insert = useInsert({
    vRows, activePos, selected, fullRows, cardByRow: model.cardByRow, titleBySlug: model.titleBySlug,
    onInsert, onInsertMany, onClose, onRequestMerge
  })
  const viewer = useViewer({ fullRows, results, setOpenPop, setPreview, insertRows: insert.insertRows })
  const beside = useBeside({
    main, setMain, gridMode, besidePlanNow: model.besidePlanNow, leftCards: model.leftCards, leftCount,
    vRows, activePos, setActivePos, setOpenPop, setPreview
  })
  useSnapshotFetch({
    isOpen, isOpenRef: thumbs.isOpenRef, beside: main.beside, fullRows, results, rowsByTalk,
    setFullRows: search.setFullRows
  })
  const { selectWholeSectionAt } = usePickerCommands({
    registerCommands, gridMode, besideOn: model.besideOn, activePos, leftCount, vRows, rowsByTalk,
    findCmdRef: rail.findCmdRef, selectWholeSection: selection.selectWholeSection,
    openBesideAt: beside.openBesideAt, closeBesideNow: beside.closeBesideNow,
    setRailCollapsed, setFindFocusReq: rail.setFindFocusReq
  })

  function setDensity(d: number): void {
    setDensityState(clampDensity(d))
  }

  // Reset on open (SearchPalette semantics); density + rail UI state persist across openings,
  // scope and facets do NOT (a fresh opening starts from the whole vault).
  useEffect(() => {
    if (!isOpen) return
    prevFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setQuery(''); search.setUnavailable(false); selection.clearSelection(); setActivePos(0)
    setPreview(false); setOpenPop(null); rail.resetRail(); selection.anchorRef.current = 0
    ex.resetExpansions(); setNearExpanded(new Set())
    tagging.setTagPickerOpen(false)
    viewer.setViewer(null)
    setMain(RESULTS_ONLY)
    thumbs.resetThumbQueue()
    requestAnimationFrame(() => inputRef.current?.focus())
    return () => { prevFocusRef.current?.focus?.() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  // ⌘S while the Browser is already open re-focuses + selects the search field (the workspace's
  // global handler calls this via the registered fn) instead of toggling the overlay closed —
  // Esc stays the only close path. Reads inputRef lazily so it always targets the live input.
  useEffect(() => {
    registerFocusSearch?.(() => {
      // The search field lives in the rail now — a collapsed rail must reopen first.
      setRailCollapsed(false)
      const input = inputRef.current
      if (!input) return
      input.focus()
      input.select()
    })
  }, [registerFocusSearch])
  // Scheduled after the open-focus frame above, so a picker opened for Find a talk lands there.
  useEffect(() => {
    if (rail.findFocusReq === 0) return
    const frame = requestAnimationFrame(() => { if (thumbs.isOpenRef.current) rail.findCmdRef.current?.focus() })
    return () => cancelAnimationFrame(frame)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rail.findFocusReq])

  useEffect(() => {
    try { window.localStorage.setItem(DENSITY_STORAGE_KEY, String(density)) } catch { /* ignore */ }
  }, [density])

  useEffect(() => {
    if (activePos > vRows.length - 1) setActivePos(Math.max(0, vRows.length - 1))
  }, [vRows.length, activePos])
  useEffect(() => {
    rootRef.current?.querySelector<HTMLElement>(`[data-pos="${activePos}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [activePos, vRows])

  useSlideBrowserKeys({
    isOpen, suspendKeys, tagPickerOpen: tagging.tagPickerOpen, viewer: viewer.viewer, vCards, vRows,
    activePos, density, gridMode, scope: rail.scope, preview, openPop, openStrip: ex.openStrip,
    openLoc: ex.openLoc, query, selected, onClose, main, splitLayout: beside.splitLayout, leftCount,
    fullRows, besideOn: model.besideOn, inputRef, rootRef, anchorRef: selection.anchorRef,
    setOpenPop, setPreview, setQuery, setSelected: selection.setSelected, setActivePos, setRailCollapsed,
    setDensity, closeBesideNow: beside.closeBesideNow, closeStrip: ex.closeStrip, closeLoc: ex.closeLoc,
    clearScope: rail.clearScope, selectWholeSectionAt, openBesideAt: beside.openBesideAt,
    doInsert: insert.doInsert, extendTo: selection.extendTo, toggleAt: selection.toggleAt,
    selectActiveSection: selection.selectActiveSection, openTagPicker: tagging.openTagPicker,
    toggleLocations: ex.toggleLocations, toggleStrip: ex.toggleStrip, toggleNear: ex.toggleNear,
    openViewer: viewer.openViewer
  })

  if (!isOpen) return null
  const activeRow = vRows[activePos]

  // Where the open expansion (version filmstrip OR identical-stack locations) sits in the
  // visual order (or -1: the card was filtered away, so the panel just doesn't render).
  const expandedRowKey = ex.openStrip?.rowKey ?? ex.openLoc?.rowKey ?? null
  // Whichever expansion is open (versions filmstrip or identical-stack locations) fills the slot.
  function renderExpansion(anchor: number, row: SearchResult): React.ReactElement | null {
    if (ex.openStrip) {
      if (!row) return null
      return (
        <VersionStrip
          key={`strip:${ex.openStrip.rowKey}`}
          anchor={anchor}
          row={row}
          openStrip={ex.openStrip}
          titleBySlug={model.titleBySlug}
          flashFile={ex.flashFile}
          onClose={ex.closeStrip}
          onInsertVersion={ex.insertVersion}
          onAdoptVersion={onAdoptVersion}
        />
      )
    }
    if (ex.openLoc) {
      return (
        <LocationsPanel
          key={`loc:${ex.openLoc.rowKey}`}
          anchor={anchor}
          openLoc={ex.openLoc}
          sectionNoByKey={model.sectionNoByKey}
          secName={model.secName}
          thumbNonces={thumbs.thumbNonces}
          regenTalk={thumbs.regenTalk}
          noteThumbUnavailable={thumbs.noteThumbUnavailable}
          canMerge={Boolean(onRequestMerge)}
          onClose={ex.closeLoc}
          onInsertRow={(r) => insert.insertRows([r])}
          onMerge={insert.requestMerge}
        />
      )
    }
    return null
  }

  const ctx: GridCtx = {
    vRows,
    selected,
    activePos,
    expandedRowKey,
    expandedPos: expansionPos(vRows, expandedRowKey),
    leftCount,
    hlPos: model.besidePlanNow ? leftCount + model.besidePlanNow.hl : null,
    besideOk: besideAvailable(gridMode),
    sectionNoByKey: model.sectionNoByKey,
    thumbNonces: thumbs.thumbNonces,
    regenTalk: thumbs.regenTalk,
    noteThumbUnavailable: thumbs.noteThumbUnavailable,
    getCounts: (id) => ex.countsRef.current.get(id),
    rowsByTalk,
    onCardClick: (p, shift) => {
      if (shift) { setActivePos(p); selection.extendTo(p) } else selection.toggleAt(p)
      setActivePos(p)
    },
    onCardEnter: (p) => setActivePos(p),
    openBesideAt: beside.openBesideAt,
    toggleStrip: ex.toggleStrip,
    toggleLocations: ex.toggleLocations,
    toggleNear: ex.toggleNear,
    selectWholeSection: selection.selectWholeSection,
    renderExpansion,
    vaultOf: severalVaults ? (id: string | undefined) => (id ? vaultById.get(id) : undefined) : undefined
  }

  const countLabel = countLabelFor({
    unavailable: search.unavailable,
    loading: search.loading,
    grouped: gridMode === 'grouped',
    slideCount: model.display.slideCount,
    sectionCount: model.sectionCount,
    leftCount,
    talkCount: new Set(model.leftCards.map((c) => c.row.talkSlug)).size
  })
  const findChipList = findChips({ scope: rail.scope, picked: rail.findPicked })
  const viewerTalkMeta = viewer.viewer ? vault.talkMeta[viewer.viewer.slug] : undefined

  return (
    <div
      ref={rootRef}
      className="lt lt-browser-root"
      role="dialog"
      aria-modal="true"
      aria-label="Slide Browser"
      onClick={() => setOpenPop(null)}
    >
      {/* ================= top chrome ================= */}
      <TopBar
        countLabel={countLabel}
        density={density}
        onDensity={setDensity}
        openPop={openPop}
        setOpenPop={setOpenPop}
        glimpse={{
          density: glimpseDensity, setDensity: setGlimpseDensity,
          lastFilters: glimpseLastFilters, setLastFilters: setGlimpseLastFilters,
          scoped: glimpseScoped, setScoped: setGlimpseScoped
        }}
        onOpenHelp={onOpenHelp}
      />

      {/* ================= browser view ================= */}
      <section className="lt-view">
        <div className="lt-browser-body">
          <button
            type="button"
            className={`lt-rail-reopen${railCollapsed ? ' show' : ''}`}
            title="Show rail (I)"
            onClick={() => setRailCollapsed(false)}
          >
            <ChevronRight className="lt-icon" />
          </button>

          {/* ---------- the unified rail (ADR-0009) ---------- */}
          <RailPane
            collapsed={railCollapsed}
            onCollapse={() => setRailCollapsed(true)}
            railProps={{
              inputRef,
              query,
              onQueryChange: setQuery,
              find: {
                query: rail.findQuery,
                onQueryChange: rail.setFindQuery,
                talks: vault.talks,
                currentTalkSlug,
                slidesOf: railModel.filesSource.slidesOf,
                chips: findChipList,
                onPick: rail.pickFromFind,
                onAddBeside: rail.addBesideFromFind,
                commandRef: rail.findCmdRef,
                onRemoveChip: rail.removeFindChipKey
              },
              findActive: hasSearchTerms(rail.findQuery) || findChipList.length > 0,
              currentTalkSlug,
              scope: rail.scope,
              scopeCounts: railModel.scopeCounts,
              coverUrlFor: railModel.coverUrlFor,
              onScope: rail.handleScope,
              onRemoveScope: rail.removeScopeAt,
              onClearScope: rail.clearScope,
              filesSource: railModel.filesSource,
              recentEdits: railModel.recentEdits,
              deliveries: railModel.deliveries,
              facets: rail.facets,
              layoutItems: railModel.layoutItems,
              contentItems: railModel.contentItems,
              tagItems: railModel.tagItems,
              sectionItems: railModel.sectionItems,
              onToggleFacet: rail.toggleFacet,
              onClearFacets: rail.clearFacets,
              anyFacetOn: model.facetsOn,
              vaultChips: severalVaults
                ? (
                  <VaultChips
                    chips={chips}
                    currentVaultId={currentVaultId}
                    counts={vaultCounts}
                    off={offVaults}
                    showCounts={query.trim() !== ''}
                    onToggle={(id) => setOffVaults((prev) => toggleVault(prev, id))}
                  />
                )
                : null
            }}
          />

          {/* ---------- the results (echo → grid tools → grid or columns) ---------- */}
          <ResultsPane
            ctx={ctx}
            facets={rail.facets}
            onToggleFacet={rail.toggleFacet}
            onClearFacets={rail.clearFacets}
            sideEligible={model.sideEligible}
            scopedCount={model.scopedSlugs.length}
            viewPref={rail.viewPref}
            onSetView={rail.setView}
            gridMode={gridMode}
            outlinePlan={model.outlinePlan}
            groups={model.groups}
            groupTotals={model.groupTotals}
            secName={model.secName}
            density={density}
            loading={search.loading}
            resultCount={results.length}
            unavailable={search.unavailable}
            query={query}
            leftCards={model.leftCards}
            besidePlanNow={model.besidePlanNow}
            besideOrder={main.beside?.order ?? 0}
            onCloseBeside={beside.closeBesideNow}
            tableScrollRef={beside.tableScrollRef}
            empty={{
              zeroResults: model.zeroResults,
              vaultEmpty: model.vaultEmpty,
              unavailable: search.unavailable,
              query,
              parsedQuery,
              filtersOn: model.filtersOn,
              offVaults: severalVaults
                ? {
                  onNames: chips.filter((c) => !c.unavailable && !offVaults.has(c.id)).map((c) => c.name),
                  hidden: hiddenInOff,
                  onSwitchOn: (id: string) => setOffVaults((prev) => toggleVault(prev, id))
                }
                : null,
              onClearSearch: () => { setQuery(''); inputRef.current?.focus() },
              onClearFilters: () => { rail.clearFacets(); rail.clearScope(); setQuery('') },
              onClose
            }}
          />

          {/* ---------- action tray (A4, insert context; mockup 545-561/1506-1516) ---------- */}
          {selected.size > 0 && (
            <SelectionTray
              count={selected.size}
              onClear={selection.clearSelection}
              onTag={tagging.openTagPicker}
              onInsert={insert.doInsert}
            />
          )}

          {/* ---------- tag picker (ADR-0037) — anchored above the tray it came from ---------- */}
          <TagPicker
            isOpen={tagging.tagPickerOpen && selected.size > 0}
            count={selection.selectedRows.length}
            tagLists={tagging.selectedTagLists}
            onToggle={(tag, action) => void tagging.applyTag(tag, action)}
            onClose={() => tagging.setTagPickerOpen(false)}
            anchor="tray"
            busy={tagging.tagBusy}
          />
        </div>

        {/* ---------- keyboard hint footer (mockup 1532-1542), keys from the registry ---------- */}
        <SlidePickerHints />
      </section>

      {/* Insert-decision viewer (↵ on a card): a self-contained layer inside the Browser —
          Esc returns here exactly as it was. Keyed per opening so its index/selection reset. */}
      {viewer.viewer && viewer.viewerDeck.length > 0 && (
        <InsertViewer
          key={`${viewer.viewer.slug}#${viewer.viewer.order}`}
          deck={viewer.viewerDeck}
          initialIndex={viewer.viewerIndex}
          talkTitle={model.titleBySlug.get(viewer.viewer.slug) ?? viewer.viewer.slug}
          sectionLabel={model.secLabelOf}
          editedLabel={
            viewerTalkMeta?.editedMs
              ? agoLabel(viewerTalkMeta.editedMs)
              : viewer.viewerDeck[0]?.talkMtimeMs
                ? agoLabel(viewer.viewerDeck[0].talkMtimeMs)
                : null
          }
          fetchCounts={ex.fetchCounts}
          onInsert={viewer.viewerInsert}
          onClose={() => viewer.setViewer(null)}
          regenNonce={thumbs.thumbNonces[viewer.viewer.slug] ?? 0}
          regenerating={thumbs.regenTalk === viewer.viewer.slug}
          onThumbUnavailable={thumbs.noteThumbUnavailable}
          suspendKeys={suspendKeys}
        />
      )}

      {preview && activeRow && activeRow.content_hash && (
        <PreviewLightbox row={activeRow} onClose={() => setPreview(false)} />
      )}
    </div>
  )
}
