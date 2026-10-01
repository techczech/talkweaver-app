import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { TalkInfo, VaultView } from '../../../../preload/index'
import { type TreeNode, topicOf, focusNode } from '../talkTreeNav'
import {
  type ViewMode, type TalkSortKey, type NamingMode, type PubState, type RowRef,
  type FolderOpenState, collapseId,
  VIEW_STORAGE_KEY, SORT_STORAGE_KEY, NAMING_STORAGE_KEY,
  readViewPreference, readSortPreference, readNamingPreference,
  sortTalks, isIgnoredPath, flattenTree, flattenSearchHits,
  allMoveTopics, folderKey,
  collapsedFrom, folderChoices, secondLines, talkTree
} from './model'
import { useFolderMemory } from './folderMemory'
import { useTalkFacts } from '../../lib/talkFacts'
import { shareForTalk, useSharedTalks } from '../../lib/sharedTalks'
import { useFeedbackSummaries } from '../../lib/feedback'
import { cardStep, initialCardState } from './hoverIntent'
import {
  buildLayout, mergeRowHeights, mountedIndices, scrollTargetFor, windowRange, type RowHeights
} from './window'
import { useTalkActions, type Prompt, type Confirm } from './actions'
import { makePanelKeyHandler, slashFocusesFileListSearch } from './useKeyboard'
import PanelHeader from './PanelHeader'
import { SearchHead } from './SearchLine'
import { CompletionPop, PrefixHints, useSearchAssist } from './SearchAssist'
import { noResultSuggestions } from './prefixAssist'
import { useTalkSearch } from './useTalkSearch'
import { IcFile, IcPlus } from './icons'
import Tree, { type TreeCallbacks } from './Tree'
import Flyout from './Flyout'
import { SortPopover, TalkContextMenu, FolderContextMenu, MoveMenu, VaultContextMenu, type VaultAction } from './menus'
import { VaultBadge } from './VaultRows'
import ShowFilter from './ShowFilter'
import { SHOW_STORE_KEY, effectiveShow, showFilterVisible, talksInShow } from './vaultFilter'
import {
  type VaultFocus, decodeFocus, drilledRows, encodeFocus, rowVaultId, sectionRows, talksByVault, vaultIdOfTalk
} from './vaultSections'
import { notify } from '../../lib/notify'
import { PromptModal, ConfirmModal } from './modals'

export { PromptModal, ConfirmModal }

interface Props {
  /** The talks of every open vault, each stamped with its vaultId. */
  talks: TalkInfo[]
  /** Category folders (vault-relative) of each open vault, by vault id. */
  foldersByVault?: Record<string, string[]>
  /** Every vault, open or closed, in order. */
  vaults: VaultView[]
  activeTalk: TalkInfo | null
  onSelectTalk: (talk: TalkInfo) => void
  onDeletedTalk?: (outlinePath: string) => void
  onRefresh: () => void
  onChangeVault: () => void
  /** Open the New Talk dialog, optionally pre-selecting a vault and a subfolder in it (vault-rel path). */
  onNewTalk?: (topic?: string, vaultId?: string) => void
  /** Pick a folder and add it as a vault. */
  onAddVault?: () => void
  /** Open or close a vault. */
  onSetVaultOpen?: (vaultId: string, open: boolean) => void
  /** ⋯ › Edit this vault… */
  onEditVault?: (vaultId: string) => void
  /** Open the per-talk Metadata panel (ADR-0036) for this talk. */
  onOpenMetadata?: (talk: TalkInfo) => void
  /** Await the App-level editor flush before renaming the ACTIVE talk (rename moves its folder). */
  flushActive?: () => Promise<void>
  /** The external-change guard's leave check for the active talk (see talklist/actions.ts). */
  leaveActive?: () => Promise<boolean>
  /** Drill-in folder to restore on mount — the panel unmounts on sidebar-tab switch (perf),
   *  so App holds this so switching to Slide outline and back doesn't dump you to the vault root. */
  initialFocusPath?: string
  onFocusPathChange?: (path: string) => void
}

// viaKeyboard: opened by ⌘K — the menu starts with its first item highlighted (right-click starts blank).
type Menu =
  | { kind: 'talk'; talk: TalkInfo; x: number; y: number; viaKeyboard?: boolean }
  | { kind: 'folder'; topic: string; vaultId?: string; x: number; y: number; viaKeyboard?: boolean }
  | { kind: 'vault'; vaultId: string; x: number; y: number; viaKeyboard?: boolean }

// Handout liveness, cached per app session — checked lazily and NEVER blocking a render.
const liveCache = new Map<string, 'live' | 'offline'>()
const liveInFlight = new Set<string>()
const FALLBACK_ROW_HEIGHTS: RowHeights = { ledger: 26, shelf: 55, fhead: 24, ledgerTwo: 36, shelfTwo: 69 }
// A pointer click focuses the panel microseconds after its mousedown; only a LONGER gap
// since the last pointer-down means focus arrived from the keyboard (tab-in) and may re-show
// the keyboard preview (a click must never leave a card behind — T29).
const CLICK_FOCUS_GRACE_MS = 200

const NO_FOLDERS: string[] = []

export default function TalkList({
  talks, foldersByVault, vaults, activeTalk,
  onSelectTalk, onDeletedTalk, onRefresh, onChangeVault, onNewTalk, onAddVault, onSetVaultOpen, onEditVault, onOpenMetadata, flushActive, leaveActive,
  initialFocusPath, onFocusPathChange
}: Props) {
  // Vaults whose talks the panel lists: open, and their folder is there (ticket 07).
  const openVaults = useMemo(() => vaults.filter((v) => v.open && !v.unavailable), [vaults])
  // "Show: All vaults ▾" (ticket 07): remembered until changed. It scopes the sections, Recent and search.
  const [showStored, setShowStored] = useState<string | null>(() => { try { return localStorage.getItem(SHOW_STORE_KEY) } catch { return null } })
  const showVaultId = effectiveShow(showStored, vaults)
  function setShow(vaultId: string | null): void {
    setShowStored(vaultId)
    try { if (vaultId) localStorage.setItem(SHOW_STORE_KEY, vaultId); else localStorage.removeItem(SHOW_STORE_KEY) } catch { /* not remembered */ }
    setFocus(null)
  }
  const primary = openVaults[0]
  const vaultById = useMemo(() => new Map(vaults.map((v) => [v.id, v])), [vaults])
  const rootOfTalk = (talk: TalkInfo): string => vaultById.get(vaultIdOfTalk(talk, vaults) ?? '')?.root ?? primary?.root ?? ''
  const [viewMode, setViewMode] = useState<ViewMode>(readViewPreference)
  const [naming, setNaming] = useState<NamingMode>(readNamingPreference)
  const [sortKey, setSortKey] = useState<TalkSortKey>(readSortPreference)
  const [query, setQuery] = useState('')
  // Only the user's choices (path → open); `collapsed` below derives the rest from defaults
  // (every folder starts closed), so a folder that appears later still gets its default.
  // Shared with the slide picker's Files tree (ADR-0029 §4) and persisted across restarts.
  // The first open vault's choices persist (the same store the slide picker's Files tab reads); other
  // vaults' choices last for the session.
  const [primaryFolderOpen, choosePrimaryFolders] = useFolderMemory(primary?.root ?? '')
  const [otherFolderOpen, setOtherFolderOpen] = useState<Record<string, FolderOpenState>>({})
  const folderOpenOf = (vaultId: string): FolderOpenState => (vaultId === primary?.id ? primaryFolderOpen : otherFolderOpen[vaultId] ?? {})
  function chooseFoldersIn(vaultId: string, changes: FolderOpenState): void {
    if (vaultId === primary?.id) choosePrimaryFolders(changes)
    else setOtherFolderOpen((all) => ({ ...all, [vaultId]: { ...all[vaultId], ...changes } }))
  }
  const [focus, setFocus] = useState<VaultFocus | null>(() => decodeFocus(initialFocusPath)) // drill-in (null = every vault)
  const focusPath = focus?.path ?? ''
  const setFocusPath = (path: string, vaultId?: string): void => {
    const id = vaultId ?? focus?.vaultId ?? primary?.id
    setFocus(path && id ? { vaultId: id, path } : null)
  }
  const [sectionCollapsed, setSectionCollapsed] = useState<Set<string>>(() => new Set())
  const [selectedFolder, setSelectedFolder] = useState('')
  const [focusKey, setFocusKey] = useState<string | null>(null) // keyboard focus row
  const { meta: talkMeta, lastDelivered, handouts, reload } = useTalkFacts()
  const [card, dispatchCard] = useReducer(cardStep, undefined, initialCardState) // preview-card intent (T29)
  const [, setLiveTick] = useState(0) // bumped when a lazy liveness probe lands
  const [menu, setMenu] = useState<Menu | null>(null)
  const [moveMenu, setMoveMenu] = useState<{ talk: TalkInfo; x: number; y: number } | null>(null)
  const [sortPop, setSortPop] = useState<{ x: number; y: number } | null>(null)
  const [prompt, setPrompt] = useState<Prompt | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [dragTopic, setDragTopic] = useState<string | null>(null)
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [rowHeights, setRowHeights] = useState<RowHeights>(FALLBACK_ROW_HEIGHTS)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(0)
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)
  // The last geometry written to state. Measurement compares against these and writes only a
  // change, as a plain value (see the measuring layout effect).
  const rowHeightsRef = useRef<RowHeights>(FALLBACK_ROW_HEIGHTS)
  const viewportHRef = useRef(0)
  const [panelFocused, setPanelFocused] = useState(false) // flyout shows only while we own the keyboard
  const draggingRef = useRef<TalkInfo | null>(null)
  const pointerDownAtRef = useRef(0)
  const panelRef = useRef<HTMLElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const sortBtnRef = useRef<HTMLButtonElement>(null)
  const treeRef = useRef<HTMLDivElement>(null)
  const scrollRafRef = useRef<number | null>(null)
  const pendingScrollTopRef = useRef(0)
  const rowRefs = useRef(new Map<string, HTMLDivElement>())

  // Recent talks (collapsible, top of the panel): the 5 most-recently-edited talks across the WHOLE
  // vault, so a talk buried deep in a folder hierarchy is one click away and never needs browsing to
  // (Dominik 2026-07-20). Ordered by editedMs desc; hidden while searching (the search IS the filter).
  const [recentOpen, setRecentOpen] = useState<boolean>(() => localStorage.getItem('tw-recent-open') !== '0')
  useEffect(() => { localStorage.setItem('tw-recent-open', recentOpen ? '1' : '0') }, [recentOpen])
  const recentTalks = useMemo(() => {
    return talksInShow(talks, showVaultId, primary?.id ?? null)
      .filter((t) => !isIgnoredPath(topicOf(t, rootOfTalk(t))) && (talkMeta[t.slug]?.editedMs ?? 0) > 0)
      .slice()
      .sort((a, b) => (talkMeta[b.slug]?.editedMs ?? 0) - (talkMeta[a.slug]?.editedMs ?? 0))
      .slice(0, 5)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [talks, talkMeta, vaults, showVaultId])

  const assist = useSearchAssist({ query, setQuery, searchRef, talksVersion: talks })
  const talksInVault = useMemo(() => talksByVault(talks, vaults), [talks, vaults])
  // Talk search (ADR-0029 §1): the one renderer call shared with the picker's "Find a talk",
  // scoped to the drilled-in folder. A lone prefix (`fo:` while typing) is not yet a search: the
  // tree stays under the completion.
  // Only vaults whose folders are there are searched; none left means nothing is searched (ticket 07).
  const searchVaultIds = useMemo(() => {
    const wanted = focus ? focus.vaultId : showVaultId
    return wanted ? openVaults.filter((v) => v.id === wanted).map((v) => v.id) : openVaults.map((v) => v.id)
  }, [focus, openVaults, showVaultId])
  const { searching, result: searchResult, settled: searchSettled } = useTalkSearch({ query, within: focusPath, vaultIds: searchVaultIds, talksVersion: talks })
  // No results (L8): the nearest folder to a mistyped fo: term, "Drop <term>", slide text.
  const suggestions = useMemo(
    () => (searchSettled && searchResult && searchResult.hits.length === 0 ? noResultSuggestions(query, assist.folders) : []),
    [searchSettled, searchResult, query, assist.folders]
  )
  const talksByPath = useMemo(() => new Map(talks.map((t) => [t.outlinePath, t])), [talks])
  const searchRows = useMemo(
    () => (searchResult ? flattenSearchHits(searchResult.hits, talksByPath) : []),
    [searchResult, talksByPath]
  )
  // One folder tree per open vault (a vault's paths are relative to its own root).
  const trees = useMemo(() => {
    const out = new Map<string, TreeNode>()
    for (const v of openVaults) out.set(v.id, talkTree(sortTalks(talksInVault.get(v.id) ?? [], sortKey, talkMeta, lastDelivered), foldersByVault?.[v.id] ?? NO_FOLDERS, v.root))
    return out
  }, [openVaults, talksInVault, sortKey, talkMeta, lastDelivered, foldersByVault])
  // Folders start closed; a remembered choice wins (defaultFolderOpen). Ids are per vault.
  const collapsed = useMemo(() => {
    const out = new Set<string>()
    for (const v of openVaults) {
      const tree = trees.get(v.id)
      if (!tree) continue
      const closed = collapsedFrom(tree, folderOpenOf(v.id))
      for (const path of closed) out.add(collapseId(v.id, path))
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openVaults, trees, primaryFolderOpen, otherFolderOpen])
  // Line two of every talk row at rest (ADR-0029 §3): event or folder, last delivery; the
  // file name where two same-titled talks would otherwise read alike. Ledger draws it.
  const lines = useMemo(() => {
    const out = new Map<string, string>()
    for (const v of openVaults) {
      const mine = (talksInVault.get(v.id) ?? []).filter((t) => !isIgnoredPath(topicOf(t, v.root)))
      for (const [path, line] of secondLines(mine, { vaultRoot: v.root, meta: talkMeta, lastDelivered, currentYear: new Date().getFullYear() })) out.set(path, line)
    }
    return out
  }, [openVaults, talksInVault, talkMeta, lastDelivered])
  const rows: RowRef[] = useMemo(
    () => (searching
      ? searchRows
      : focus
        ? drilledRows({ focus, trees, collapsed, lines })
        : sectionRows({ vaults, trees, collapsed, sectionCollapsed, lines, showVaultId })),
    [searching, searchRows, focus, trees, collapsed, vaults, sectionCollapsed, lines, showVaultId]
  )
  const rowIndexByKey = useMemo(() => new Map(rows.map((row, index) => [row.key, index])), [rows])
  const layout = useMemo(() => buildLayout(rows, viewMode, rowHeights), [rows, viewMode, rowHeights])
  const overscanPx = 10 * (viewMode === 'ledger' ? rowHeights.ledger : rowHeights.shelf)
  const range = useMemo(
    () => windowRange(layout, scrollTop, viewportH, overscanPx),
    [layout, scrollTop, viewportH, overscanPx]
  )
  // Focus is pinned for the commit that scrolls it into view; the drag source stays pinned
  // because Chromium cancels a native drag when that DOM node is virtualised away.
  const pinned = useMemo(() => {
    const indices = new Set<number>()
    const focusIndex = focusKey ? rowIndexByKey.get(focusKey) : undefined
    const dragIndex = dragKey ? rowIndexByKey.get(dragKey) : undefined
    if (focusIndex != null) indices.add(focusIndex)
    if (dragIndex != null) indices.add(dragIndex)
    return indices
  }, [focusKey, dragKey, rowIndexByKey])
  const mounted = useMemo(() => mountedIndices(layout, range, pinned), [layout, range, pinned])
  const topicsForMove = (talk: TalkInfo): string[] => {
    const id = vaultIdOfTalk(talk, vaults) ?? ''
    return allMoveTopics(talksInVault.get(id) ?? [], foldersByVault?.[id] ?? NO_FOLDERS, vaultById.get(id)?.root ?? '')
  }
  const focusedRow = useMemo(() => rows.find((r) => r.key === focusKey) ?? null, [rows, focusKey])
  const focusedTalk = focusedRow?.kind === 'talk' ? focusedRow.talk : null

  const sharedTalks = useSharedTalks()
  const sharedFor = (talk: TalkInfo): boolean => Boolean(shareForTalk(sharedTalks, talk.outlinePath))
  // Feedback rail (ticket 05): the talk row carries the count of unread items.
  const feedbackSummaries = useFeedbackSummaries()
  const feedbackCountFor = (talk: TalkInfo): number => {
    const share = shareForTalk(sharedTalks, talk.outlinePath)
    return share ? feedbackSummaries[share.shareId]?.unread ?? 0 : 0
  }
  const pubFor = (slug: string): PubState => {
    const url = handouts[slug]?.handoutUrl
    if (!url) return 'none'
    return liveCache.get(url) === 'offline' ? 'dead' : 'live'
  }

  const actions = useTalkActions({
    talks, vaults, activeTalk, onSelectTalk, onDeletedTalk, onRefresh, onNewTalk,
    onOpenMetadata, flushActive, leaveActive, setPrompt, setConfirm, setMenu, setMoveMenu, setFocusKey
  })

  // ── data plumbing ──
  // Facts (meta/delivered/handouts) come from the shared useTalkFacts store — one fetch for the
  // panel AND the status bar, refreshed by main via onTalkMetaUpdated and saved delivery runs.
  // What remains here: re-fetch whenever the vault's talk list changes (new/rename/move).
  useEffect(() => { void reload() }, [talks, reload])

  // The hover-card model: keyboard focus moves preview the card at once (below); the pending
  // hover pause is owned by `card.pendingAt` — one timer answers it with `resolve`.
  useEffect(() => {
    if (card.pendingAt == null) return
    const id = window.setTimeout(
      () => dispatchCard({ type: 'resolve', at: Date.now() }),
      Math.max(0, card.pendingAt - Date.now())
    )
    return () => window.clearTimeout(id)
  }, [card.pendingAt])
  useEffect(() => {
    if (focusKey) dispatchCard({ type: 'keymove', rowKey: focusKey, at: Date.now() })
  }, [focusKey])

  // Lazy liveness probes: fire once per unknown URL per session; never block rendering.
  useEffect(() => {
    for (const { handoutUrl } of Object.values(handouts)) {
      if (!handoutUrl || liveCache.has(handoutUrl) || liveInFlight.has(handoutUrl)) continue
      liveInFlight.add(handoutUrl)
      window.tw.history.checkLive(handoutUrl)
        .then((res) => { liveCache.set(handoutUrl, res.status === 'live' ? 'live' : 'offline') })
        .catch(() => { /* stay optimistic — an unprobeable link is not a dead one */ })
        .finally(() => { liveInFlight.delete(handoutUrl); setLiveTick((n) => n + 1) })
    }
  }, [handouts])

  useEffect(() => { try { window.localStorage.setItem(VIEW_STORAGE_KEY, viewMode) } catch { /* ignore */ } }, [viewMode])
  useEffect(() => { try { window.localStorage.setItem(SORT_STORAGE_KEY, sortKey) } catch { /* ignore */ } }, [sortKey])
  useEffect(() => { try { window.localStorage.setItem(NAMING_STORAGE_KEY, naming) } catch { /* ignore */ } }, [naming])

  // Report the drill-in outward so App can restore it after this panel unmounts on a tab switch.
  useEffect(() => { onFocusPathChange?.(encodeFocus(focus)) }, [focus, onFocusPathChange])

  // If the drilled-into / selected folder disappears (deleted or renamed, or its vault closed), pop back out.
  useEffect(() => {
    if (focus) {
      const tree = trees.get(focus.vaultId)
      if (!tree || focusNode(tree, focus.path) === tree) setFocus(null)
    }
    if (selectedFolder) {
      const tree = trees.get(selectedFolder.split('\u001f')[0])
      const path = selectedFolder.split('\u001f')[1] ?? ''
      if (!tree || (path && focusNode(tree, path) === tree)) setSelectedFolder('')
    }
  }, [trees, focus, selectedFolder])

  // Keyboard focus starts on the first talk; while searching it snaps to a visible match.
  // A dangling focus (row briefly gone mid-refresh, e.g. after rename/move) is left alone so
  // the focus can land on the row's NEW key when the refreshed list arrives.
  useEffect(() => {
    // The first talk, else the first folder (a vault header is where you go by choice, not by default).
    const first = (): string | null => (rows.find((r) => r.kind === 'talk') ?? rows.find((r) => r.kind === 'folder') ?? rows[0])?.key ?? null
    if (!focusKey) { setFocusKey(first()); return }
    if (searching && !rows.some((r) => r.key === focusKey)) {
      setFocusKey(first())
    }
  }, [rows, focusKey, searching])

  // Measure one mounted sample of each available row kind, using a single observer rather
  // than one observer per row. CSS-derived fallbacks make first paint viable; real geometry
  // replaces each estimate after mount and whenever zoom/font metrics resize a sample.
  // Writes only a real change, and as a plain value, never an updater (ticket 09): the observer
  // fires outside React events, so an unchanged write there still queued a low-priority update.
  // A later sync render (the Shelf click) skipped it and re-ran every later heights updater from
  // the old base state, minting a new, equal heights object per render — a new `layout` each
  // time, which re-ran the scroll effect below, whose state write rendered again: React #185.
  useLayoutEffect(() => {
    const container = treeRef.current
    if (!container) return

    const measure = (): void => {
      const height = container.clientHeight
      if (height !== viewportHRef.current) {
        viewportHRef.current = height
        setViewportH(height)
      }
      const next = mergeRowHeights(rowHeightsRef.current, {
        ledger: container.querySelector<HTMLElement>('.tl-row:not(.tl-row--two)')?.offsetHeight,
        shelf: container.querySelector<HTMLElement>('.tl-shrow:not(.tl-shrow--two)')?.offsetHeight,
        fhead: container.querySelector<HTMLElement>('.tl-fhead')?.offsetHeight,
        ledgerTwo: container.querySelector<HTMLElement>('.tl-row--two')?.offsetHeight,
        shelfTwo: container.querySelector<HTMLElement>('.tl-shrow--two')?.offsetHeight
      })
      if (next !== rowHeightsRef.current) {
        rowHeightsRef.current = next
        setRowHeights(next)
      }
    }

    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    const samples = [
      container.querySelector<HTMLElement>('.tl-fhead'),
      container.querySelector<HTMLElement>('.tl-row'),
      container.querySelector<HTMLElement>('.tl-shrow'),
      container.querySelector<HTMLElement>('.tl-row--two'),
      container.querySelector<HTMLElement>('.tl-shrow--two')
    ].filter((sample): sample is HTMLElement => sample != null)
    for (const sample of samples) observer.observe(sample)
    return () => observer.disconnect()
  }, [viewMode, rows, focusKey])

  // Offset scrolling works even before the target row has mounted. Pinning the focused index
  // makes the row and its focus ring commit together, avoiding a one-frame missing-row flash.
  // The flyout anchor is written only when it changes: this effect re-runs on every new
  // `layout`, and a state write here with nothing changed still costs a render (ticket 09).
  useLayoutEffect(() => {
    const container = treeRef.current
    const index = focusKey ? rowIndexByKey.get(focusKey) : undefined
    const anchor = container && index != null && focusKey ? rowRefs.current.get(focusKey) ?? null : null
    if (container && index != null) {
      const target = scrollTargetFor(layout, index, container.scrollTop, container.clientHeight)
      if (target != null && target !== container.scrollTop) {
        container.scrollTop = target
        setScrollTop(target)
      }
    }
    if (anchor !== anchorEl) setAnchorEl(anchor)
  }, [focusKey, rowIndexByKey, layout, viewMode, viewportH])

  useEffect(() => () => {
    if (scrollRafRef.current != null) cancelAnimationFrame(scrollRafRef.current)
  }, [])

  // Focus the search input when the tw-search-talks command fires (command palette / ⌘⇧T).
  useEffect(() => {
    const focus = (): void => { requestAnimationFrame(() => { searchRef.current?.focus(); searchRef.current?.select() }) }
    window.addEventListener('tw-search-talks', focus)
    return () => window.removeEventListener('tw-search-talks', focus)
  }, [])

  // / from outside the panel (browser.filter): while the file list is open, / pressed anywhere but the
  // talk editor, a text field or a modal surface puts the caret in the search box. Bubble phase, after
  // every surface's own key handling, so a key already taken (the panel's own /) is left alone.
  useEffect(() => {
    const onSlash = (e: KeyboardEvent): void => {
      const target = e.target instanceof HTMLElement ? e.target : null
      const facts = {
        key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey,
        defaultPrevented: e.defaultPrevented,
        typing: !!target && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target.isContentEditable),
        inEditor: !!target?.closest('.cm-editor'),
        modalOpen: document.querySelector('[aria-modal="true"]') != null
      }
      if (!slashFocusesFileListSearch(facts) || !searchRef.current) return
      e.preventDefault()
      searchRef.current.focus()
      searchRef.current.select()
    }
    window.addEventListener('keydown', onSlash)
    return () => window.removeEventListener('keydown', onSlash)
  }, [])

  // ⌘K (WorkspaceLayout's universal context-menu chord) dispatches tw-context-menu: open the
  // menu for the keyboard-focused row, anchored at its rect — exactly as right-click would.
  // Panel-scoped guard: only act while the Talks panel owns the DOM focus.
  useEffect(() => {
    const onContextKey = (): void => {
      const panel = panelRef.current
      if (!panel || !focusedRow) return
      if (document.activeElement !== panel && !panel.contains(document.activeElement)) return
      const at = focusedRowRect()
      if (focusedRow.kind === 'talk') setMenu({ kind: 'talk', talk: focusedRow.talk, x: at.x, y: at.y, viaKeyboard: true })
      else if (focusedRow.kind === 'folder') setMenu({ kind: 'folder', topic: focusedRow.path, vaultId: focusedRow.vaultId, x: at.x, y: at.y, viaKeyboard: true })
      else if (focusedRow.kind === 'vault') setMenu({ kind: 'vault', vaultId: focusedRow.vaultId, x: at.x, y: at.y, viaKeyboard: true })
    }
    window.addEventListener('tw-context-menu', onContextKey)
    return () => window.removeEventListener('tw-context-menu', onContextKey)
  })

  // ── folders / drag-drop ──
  // Every open/close goes through chooseFoldersIn (the vault's folder memory): it updates the tree
  // at once and, for the first open vault, persists the choice (the picker shares it).
  function toggleFolder(path: string, vaultId?: string): void {
    const id = vaultId ?? primary?.id
    if (id) chooseFoldersIn(id, { [path]: collapsed.has(collapseId(id, path)) })
  }
  function subfoldersOf(tree: TreeNode): string[] {
    const out: string[] = []
    const walk = (n: TreeNode): void => { for (const c of n.children) { out.push(c.path); walk(c) } }
    walk(tree)
    return out
  }
  function collapseAll(): void {
    for (const v of openVaults) {
      const tree = trees.get(v.id)
      if (tree) chooseFoldersIn(v.id, folderChoices(subfoldersOf(tree), false))
    }
  }
  function onDropTo(topic: string, vaultId?: string): void {
    const talk = draggingRef.current
    draggingRef.current = null
    setDragKey(null)
    setDragTopic(null)
    if (!talk) return
    // A folder is a place inside one vault: dropping into another vault's folder does nothing.
    if ((vaultId ?? primary?.id) !== vaultIdOfTalk(talk, vaults)) { notify('A talk can only move within its own vault.', 'info'); return }
    void actions.doMove(talk, topic)
  }
  // ⌘↑ — one breadcrumb level up, refocusing the folder we just left so the position reads.
  function upOneLevel(): void {
    if (!focus) return
    const from = focus.path
    setFocusPath(focus.path.split('/').slice(0, -1).join('/'))
    setFocusKey(folderKey(from, focus.vaultId))
  }
  // ⌘← / ⌘→ — every subfolder of the current drilled-in view (every vault's folders at top level).
  function foldersInView(): Array<{ vaultId: string; paths: string[] }> {
    if (focus) {
      const tree = trees.get(focus.vaultId)
      return tree ? [{ vaultId: focus.vaultId, paths: subfoldersOf(focusNode(tree, focus.path)) }] : []
    }
    return openVaults.map((v) => ({ vaultId: v.id, paths: subfoldersOf(trees.get(v.id) ?? { name: '', path: '', children: [], talks: [] }) }))
  }
  function collapseAllInView(): void {
    for (const { vaultId, paths } of foldersInView()) chooseFoldersIn(vaultId, folderChoices(paths, false))
  }
  function expandAllInView(): void {
    for (const { vaultId, paths } of foldersInView()) chooseFoldersIn(vaultId, folderChoices(paths, true))
  }
  // A vault header: an open vault folds or unfolds its section; a closed one opens (its ⋯ menu does the same).
  function toggleVault(vaultId: string): void {
    const vault = vaultById.get(vaultId)
    if (!vault) return
    if (!vault.open) { onSetVaultOpen?.(vaultId, true); return }
    if (showVaultId && vaultId !== showVaultId) { setShow(vaultId); return } // a one-line row: show that vault
    setSectionCollapsed((all) => {
      const next = new Set(all)
      if (!next.delete(vaultId)) next.add(vaultId)
      return next
    })
  }
  function setSection(vaultId: string, expanded: boolean): void {
    setSectionCollapsed((all) => {
      const next = new Set(all)
      if (expanded) next.delete(vaultId)
      else next.add(vaultId)
      return next
    })
  }
  // The vault a toolbar "New talk" / "New folder" acts in: the drilled-in vault, else the vault of
  // the row under keyboard focus, else the first open vault.
  // New talk / New folder go to the focused vault, or the first vault whose folder is there: never
  // into an unavailable (or closed) vault (ticket 07).
  const targetVaultId = [focus?.vaultId, focusedRow ? rowVaultId(focusedRow, vaults) : null]
    .find((id) => !!id && openVaults.some((v) => v.id === id)) ?? primary?.id
  function onVaultAction(vaultId: string, action: VaultAction): void {
    setMenu(null)
    if (action === 'edit') { onEditVault?.(vaultId); return }
    if (action === 'only') { setShow(vaultId); return }
    if (action === 'reveal') { void window.tw.vault.reveal(vaultId); return }
    onSetVaultOpen?.(vaultId, action === 'open')
  }

  /** The unavailable section's one action: open the cloud service's settings, or look at the folder
   *  again now; either way the list is re-read. */
  function runUnavailableAction(vaultId: string): void {
    const vault = vaultById.get(vaultId)
    const act = vault?.unavailable?.action === 'open-service' ? window.tw.vault.openService(vaultId) : window.tw.vault.recheck()
    void Promise.resolve(act).catch(() => {}).finally(() => { void onRefresh() })
  }

  // ── keyboard (panel-scoped; identical in both modes) ──
  const handlePanelKey = makePanelKeyHandler({
    rows, focusKey, setFocusKey, focusedRow, focusedTalk,
    collapsed, toggleFolder,
    drillInto: setFocusPath,
    activateVaultRow: (row, key) => {
      const vault = vaultById.get(row.vaultId)
      if (!vault) return
      if (row.kind === 'empty') {
        if (key !== 'enter') return
        // The unavailable note: Enter presses its one button (Check again / Open settings), never New talk.
        if (vault.unavailable) { runUnavailableAction(vault.id); return }
        if (vault.open) onNewTalk?.('', vault.id)
        return
      }
      if (!vault.open) { if (key !== 'collapse') onSetVaultOpen?.(vault.id, true); return }
      if (key === 'enter') toggleVault(vault.id)
      else setSection(vault.id, key === 'expand')
    },
    upOneLevel,
    collapseAllInView,
    expandAllInView,
    cycleViewMode: () => setViewMode((m) => (m === 'ledger' ? 'shelf' : 'ledger')),
    cycleNaming: () => setNaming((n) => (n === 'title' ? 'file' : 'title')),
    sortPopOpen: !!sortPop,
    toggleSortPop: () => toggleSortPop(),
    closeSortPop: () => setSortPop(null),
    setSortKey,
    query,
    clearQuery: () => setQuery(''),
    focusSearch: () => { searchRef.current?.focus(); searchRef.current?.select() },
    anyOverlayOpen: !!(prompt || confirm || menu || moveMenu),
    // Enter/⌘O open the talk AND retire the keyboard preview (T29: the card follows the opened
    // talk away — never stays behind).
    onSelectTalk: (talk) => { dispatchCard({ type: 'open', at: Date.now() }); onSelectTalk(talk) },
    startRename: actions.startRename,
    startRenameFolder: (path, vaultId) => actions.onFolderAction(path, 'rename', vaultId),
    startDuplicate: actions.startDuplicate,
    startDelete: actions.startDelete,
    startMove: actions.startMove,
    focusedRowRect
  })
  // Escape hides the preview card whatever else the key does (clear search, blur the panel).
  function handlePanelKeyDown(e: ReactKeyboardEvent<HTMLElement>): void {
    if (e.key === 'Escape') dispatchCard({ type: 'escape', at: Date.now() })
    handlePanelKey(e)
  }
  function focusedRowRect(): { x: number; y: number } {
    const container = treeRef.current
    const index = focusKey ? rowIndexByKey.get(focusKey) : undefined
    let el = focusKey ? rowRefs.current.get(focusKey) : undefined
    if (!el && container && index != null) {
      const target = scrollTargetFor(layout, index, container.scrollTop, container.clientHeight)
      if (target != null) {
        container.scrollTop = target
        setScrollTop(target)
      }
      el = rowRefs.current.get(focusKey!)
    }
    const rect = el?.getBoundingClientRect()
    if (rect) return { x: rect.left + 60, y: rect.bottom + 2 }
    const containerRect = container?.getBoundingClientRect()
    return containerRect
      ? { x: containerRect.left + 60, y: containerRect.top + 24 }
      : { x: 120, y: 120 }
  }
  function handleTreeScroll(e: React.UIEvent<HTMLDivElement>): void {
    dispatchCard({ type: 'scroll', at: Date.now() }) // rows moved under the pointer — card goes
    pendingScrollTopRef.current = e.currentTarget.scrollTop
    if (scrollRafRef.current != null) return
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null
      setScrollTop(pendingScrollTopRef.current)
    })
  }
  function autoScrollDuringDrag(e: React.DragEvent): void {
    const container = treeRef.current
    if (!container || !draggingRef.current) return
    const rect = container.getBoundingClientRect()
    const delta = e.clientY - rect.top < 24 ? -8 : rect.bottom - e.clientY < 24 ? 8 : 0
    if (!delta) return
    container.scrollTop = Math.max(0, Math.min(container.scrollTop + delta, container.scrollHeight - container.clientHeight))
  }
  function toggleSortPop(): void {
    setSortPop((open) => {
      if (open) return null
      const r = sortBtnRef.current?.getBoundingClientRect()
      return r ? { x: r.right - 180, y: r.bottom + 4 } : { x: 80, y: 80 }
    })
  }

  // ── rendering ──
  const treeCallbacks: TreeCallbacks = {
    setRowRef: (key) => (el) => {
      if (el) rowRefs.current.set(key, el)
      else rowRefs.current.delete(key)
    },
    // stopPropagation on the opening right-click: belt-and-braces with useDismiss's arming
    // delay — the same native contextmenu event must never reach the window dismiss listener.
    onOpenTalk: (talk, key) => { setFocusKey(key); onSelectTalk(talk); panelRef.current?.focus({ preventScroll: true }) },
    onRowEnter: (_talk, key) => dispatchCard({ type: 'enter', rowKey: key, at: Date.now() }),
    onRowLeave: (key) => dispatchCard({ type: 'leave', rowKey: key, at: Date.now() }),
    onTalkContext: (talk, key, e) => { e.preventDefault(); e.stopPropagation(); setFocusKey(key); setMenu({ kind: 'talk', talk, x: e.clientX, y: e.clientY }) },
    onToggleFolder: (path, key, vaultId) => { setFocusKey(key); setSelectedFolder(`${vaultId ?? ''}\u001f${path}`); toggleFolder(path, vaultId); panelRef.current?.focus({ preventScroll: true }) },
    onFolderContext: (path, key, e, vaultId) => { e.preventDefault(); e.stopPropagation(); setFocusKey(key); setMenu({ kind: 'folder', topic: path, vaultId, x: e.clientX, y: e.clientY }) },
    onDrill: setFocusPath,
    onToggleVault: (vaultId, key) => { setFocusKey(key); toggleVault(vaultId); panelRef.current?.focus({ preventScroll: true }) },
    onVaultMenu: (vaultId, key, e) => { e.preventDefault(); e.stopPropagation(); setFocusKey(key); setMenu({ kind: 'vault', vaultId, x: e.clientX, y: e.clientY }) },
    onNewTalkIn: (vaultId) => onNewTalk?.('', vaultId),
    onUnavailableAction: (vaultId) => runUnavailableAction(vaultId),
    onShowVault: (vaultId) => setShow(vaultId),
    hiddenCount: (vaultId) => (talksInVault.get(vaultId) ?? []).length,
    onDragStartTalk: (talk, key) => { draggingRef.current = talk; setDragKey(key) },
    onDragEndTalk: () => { draggingRef.current = null; setDragKey(null); setDragTopic(null) },
    // stopPropagation: without it the SAME dragover bubbles on to the tree container, whose
    // handler overwrites dragTopic to '' — so the folder's .tl-drop highlight never showed
    // (live finding, 0.14.0). The folder row owns the event; the tree only sees open-space drags.
    onFolderDragOver: (path, e, vaultId) => {
      if (draggingRef.current) { autoScrollDuringDrag(e); e.preventDefault(); e.stopPropagation(); setDragTopic(collapseId(vaultId, path)) }
    },
    // relatedTarget check: dragleave also fires when moving onto the row's own children
    // (name/count spans); only clear when the pointer truly leaves the row's subtree.
    onFolderDragLeave: (path, e, vaultId) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragTopic((t) => (t === collapseId(vaultId, path) ? null : t))
    },
    onFolderDrop: (path, e, vaultId) => { e.preventDefault(); e.stopPropagation(); onDropTo(path, vaultId) },
    // Dropping on empty space (not a folder) moves the talk to the root of its own vault.
    onTreeDragOver: (e) => { if (draggingRef.current) { autoScrollDuringDrag(e); e.preventDefault(); setDragTopic('') } },
    onTreeDrop: (e) => { e.preventDefault(); const t = draggingRef.current; onDropTo('', t ? vaultIdOfTalk(t, vaults) ?? undefined : undefined) }
  }

  const targetFolder = focusPath // header ＋ / New-folder create in the drilled-in folder, else root
  const modalOpen = !!(menu || moveMenu || prompt || confirm)

  // ── preview card ──
  // The hover-intent model owns WHEN/WHERE: hover arms a pause (450ms, 150ms between rows),
  // clicks never leave a card behind, keyboard browsing keeps today's focus-following preview.
  const cardTarget = card.target
  const cardRow = cardTarget ? rows.find((r) => r.key === cardTarget.key) ?? null : null
  const cardTalk = cardRow?.kind === 'talk' ? cardRow.talk : null
  const cardHover = cardTarget?.source === 'hover'
  const cardAnchorEl = cardHover && cardTarget ? (rowRefs.current.get(cardTarget.key) ?? null) : anchorEl

  return (
    <aside
      className={`talk-list tl-panel${assist.completion ? ' tl-panel--completing' : ''}`}
      ref={panelRef}
      tabIndex={0}
      aria-label="Talks browser"
      onKeyDown={handlePanelKeyDown}
      onMouseDownCapture={(e) => {
        // ANY panel click dismisses the card — a click must never show one, nor leave one
        // behind (T29). A LEFT click on a talk row also suppresses that row until the pointer
        // leaves it; right-click (menu intent) dismisses only.
        pointerDownAtRef.current = Date.now()
        const rowKey = e.button === 0
          ? (e.target as HTMLElement).closest?.('[data-row-key]')?.getAttribute('data-row-key') ?? undefined
          : undefined
        dispatchCard({ type: 'click', rowKey, at: Date.now() })
      }}
      onFocus={() => {
        setPanelFocused(true)
        // Tab-in restores the keyboard preview (today's behaviour); a pointer-click focus must not.
        if (focusKey && Date.now() - pointerDownAtRef.current > CLICK_FOCUS_GRACE_MS) {
          dispatchCard({ type: 'keymove', rowKey: focusKey, at: Date.now() })
        }
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setPanelFocused(false)
          dispatchCard({ type: 'panelblur', at: Date.now() })
        }
      }}
    >
      <PanelHeader
        viewMode={viewMode}
        onSetViewMode={setViewMode}
        onNewTalk={() => onNewTalk?.(targetFolder, targetVaultId)}
        onNewFolder={() => setPrompt({ label: targetFolder ? `New folder inside "${targetFolder.split('/').pop()}"` : 'New folder name', initial: '', cta: 'Create', onSubmit: (v) => void actions.doNewFolder(v, targetFolder, targetVaultId) })}
        onToggleSort={(e) => { e.stopPropagation(); toggleSortPop() }}
        sortOpen={!!sortPop}
        sortBtnRef={sortBtnRef}
        onCollapseAll={collapseAll}
        onRefresh={onRefresh}
        onChangeVault={onChangeVault}
        query={query}
        onQueryChange={assist.onChange}
        searchRef={searchRef}
        onSearchFocus={assist.onFocus}
        onSearchBlur={assist.onBlur}
        onSearchSelect={assist.onSelect}
        assist={assist.completion
          ? <CompletionPop completion={assist.completion} active={assist.active} onPick={assist.pick} onHover={assist.setActive} />
          : assist.hintVisible ? <PrefixHints onPick={assist.pickHint} /> : null}
        onSearchKeyDown={(e) => {
          if (assist.onKeyDown(e)) return
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (query) setQuery(''); else e.currentTarget.blur() }
          if (e.key === 'ArrowDown') { e.preventDefault(); panelRef.current?.focus() }
        }}
        focusPath={focusPath}
        onFocusPath={setFocusPath}
        showSlot={showFilterVisible(vaults) ? <ShowFilter vaults={vaults} showId={showVaultId} onChange={setShow} /> : null}
        rootLabel={focus && openVaults.length > 1 ? vaultById.get(focus.vaultId)?.name ?? 'Vault' : 'Vault'}
      />

      {!searching && recentTalks.length > 0 && (
        <div className="tl-recent">
          <button
            type="button"
            className="tl-recent-head"
            aria-expanded={recentOpen}
            onClick={() => setRecentOpen((v) => !v)}
          >
            <span className={`tl-recent-twist ${recentOpen ? 'is-open' : ''}`}>▸</span>
            <span className="tl-recent-label">Recent</span>
            <span className="tl-recent-count">{recentTalks.length}</span>
          </button>
          {recentOpen && (
            <div className="tl-recent-rows" role="list">
              {recentTalks.map((t) => (
                <button
                  type="button"
                  key={t.slug}
                  role="listitem"
                  className={`tl-recent-row ${activeTalk?.outlinePath === t.outlinePath ? 'is-active' : ''}`}
                  title={topicOf(t, rootOfTalk(t)) || 'vault root'}
                  onClick={() => { onSelectTalk(t); panelRef.current?.focus({ preventScroll: true }) }}
                >
                  {vaultById.get(vaultIdOfTalk(t, vaults) ?? '')
                    ? <span className="tl-recent-ficon"><VaultBadge vault={vaultById.get(vaultIdOfTalk(t, vaults) ?? '')!} size={14} /></span>
                    : <span className="tl-recent-ficon"><IcFile size={11.5} /></span>}
                  <span className="tl-recent-name">{t.title}</span>
                  <span className="tl-recent-count">{talkMeta[t.slug]?.slideCount ?? '—'}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {searching && searchResult && (
        <SearchHead
          result={searchResult}
          shown={rows.length}
          onSearchEverywhere={() => setFocusPath('')}
        />
      )}

      <Tree
        searching={searching}
        query={query}
        searchSettled={searchSettled}
        focusPath={focusPath}
        everywhereCount={searchResult?.within ? searchResult.everywhereCount : null}
        onSearchEverywhere={() => setFocusPath('')}
        suggestions={suggestions}
        onSuggest={assist.replaceQuery}
        rows={rows}
        trees={trees}
        vaults={vaults}
        sectionCollapsed={sectionCollapsed}
        isEmptyVault={vaults.length === 0}
        viewMode={viewMode}
        naming={naming}
        collapsed={collapsed}
        focusKey={focusKey}
        activeTalkPath={activeTalk?.outlinePath ?? null}
        menuTalkPath={menu?.kind === 'talk' ? menu.talk.outlinePath : null}
        dragTopic={dragTopic}
        talkMeta={talkMeta}
        lastDelivered={lastDelivered}
        pubFor={pubFor}
        sharedFor={sharedFor}
        feedbackCountFor={feedbackCountFor}
        layout={layout}
        mounted={mounted}
        containerRef={treeRef}
        onScroll={handleTreeScroll}
        cb={treeCallbacks}
      />

      <button type="button" className="tl-addvault" onClick={() => onAddVault?.()} data-add-vault>
        <IcPlus size={11} />Add vault…
      </button>

      <div className="tl-keybar" aria-hidden>
        <span><b>↑↓</b>navigate</span>
        <span><b>←→</b>fold</span>
        <span><b>↵</b>open</span>
        <span><b>⌘↑</b>up</span>
        <span><b>v</b>view</span>
        <span><b>n</b>names</span>
        <span><b>/</b>search</span>
        <span><b>F2</b>rename</span>
        <span><b>⌘K</b>menu</span>
      </div>

      {/* Keyboard previews stay Ledger-only and panel-focus-bound (unchanged); hover previews
          work in both view modes and need no focus. */}
      {cardTalk && cardTarget && !modalOpen && (cardHover || (viewMode === 'ledger' && panelFocused)) && (
        <Flyout
          talk={cardTalk}
          meta={talkMeta[cardTalk.slug]}
          deliveredMs={lastDelivered[cardTalk.slug]}
          pub={pubFor(cardTalk.slug)}
          anchorEl={cardAnchorEl}
          panelEl={panelRef.current}
          hover={cardHover}
        />
      )}

      {sortPop && (
        <SortPopover x={sortPop.x} y={sortPop.y} sortKey={sortKey} naming={naming} onClose={() => setSortPop(null)}
          onPick={(k) => { setSortKey(k); setSortPop(null); panelRef.current?.focus({ preventScroll: true }) }}
          onPickNaming={(m) => { setNaming(m); setSortPop(null); panelRef.current?.focus({ preventScroll: true }) }} />
      )}
      {menu?.kind === 'talk' && (
        <TalkContextMenu x={menu.x} y={menu.y} startAtFirst={!!menu.viaKeyboard} onClose={() => setMenu(null)}
          onAction={(a) => actions.onTalkAction(menu.talk, a, { x: menu.x, y: menu.y })} />
      )}
      {menu?.kind === 'folder' && (
        <FolderContextMenu x={menu.x} y={menu.y} startAtFirst={!!menu.viaKeyboard} onClose={() => setMenu(null)}
          onAction={(a) => actions.onFolderAction(menu.topic, a, menu.vaultId)} />
      )}
      {menu?.kind === 'vault' && (
        <VaultContextMenu x={menu.x} y={menu.y} open={vaultById.get(menu.vaultId)?.open ?? false} unavailable={!!vaultById.get(menu.vaultId)?.unavailable} startAtFirst={!!menu.viaKeyboard}
          onClose={() => setMenu(null)} onAction={(a) => onVaultAction(menu.vaultId, a)} />
      )}
      {moveMenu && (
        <MoveMenu
          x={moveMenu.x} y={moveMenu.y}
          topics={topicsForMove(moveMenu.talk)}
          currentTopic={topicOf(moveMenu.talk, rootOfTalk(moveMenu.talk))}
          onClose={() => setMoveMenu(null)}
          onPick={(topic) => { const t = moveMenu.talk; setMoveMenu(null); void actions.doMove(t, topic) }}
        />
      )}
      {prompt && (
        <PromptModal
          label={prompt.label} initial={prompt.initial} cta={prompt.cta}
          onCancel={() => setPrompt(null)}
          onSubmit={(v) => { const fn = prompt.onSubmit; setPrompt(null); if (v.trim()) fn(v.trim()) }}
        />
      )}
      {confirm && (
        <ConfirmModal
          label={confirm.label} cta={confirm.cta} danger={confirm.danger}
          onCancel={() => setConfirm(null)}
          onConfirm={() => { const fn = confirm.onConfirm; setConfirm(null); fn() }}
        />
      )}
    </aside>
  )
}
