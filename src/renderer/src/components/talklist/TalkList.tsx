import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { TalkInfo, TalkMeta, TalkHandouts } from '../../../../preload/index'
import { type TreeNode, topicOf, buildTree, focusNode } from '../talkTreeNav'
import {
  type ViewMode, type TalkSortKey, type NamingMode, type PubState, type RowRef,
  VIEW_STORAGE_KEY, SORT_STORAGE_KEY, NAMING_STORAGE_KEY,
  readViewPreference, readSortPreference, readNamingPreference,
  lastDeliveredBySlug, sortTalks, isIgnoredPath, flattenTree, flattenSearch,
  allMoveTopics, folderKey
} from './model'
import {
  buildLayout, mountedIndices, scrollTargetFor, windowRange, type RowHeights
} from './window'
import { useTalkActions, type Prompt, type Confirm } from './actions'
import { makePanelKeyHandler } from './useKeyboard'
import PanelHeader from './PanelHeader'
import Tree, { type TreeCallbacks } from './Tree'
import Flyout from './Flyout'
import { SortPopover, TalkContextMenu, FolderContextMenu, MoveMenu } from './menus'
import { PromptModal, ConfirmModal } from './modals'

export { PromptModal, ConfirmModal }

interface Props {
  talks: TalkInfo[]
  folders?: string[]
  activeTalk: TalkInfo | null
  vaultRoot: string
  onSelectTalk: (talk: TalkInfo) => void
  onDeletedTalk?: (outlinePath: string) => void
  onRefresh: () => void
  onChangeVault: () => void
  /** Open the New Talk dialog, optionally pre-selecting a subfolder (vault-rel path). */
  onNewTalk?: (topic?: string) => void
  /** Open the per-talk Metadata panel (ADR-0036) for this talk. */
  onOpenMetadata?: (talk: TalkInfo) => void
  /** Await the App-level editor flush before renaming the ACTIVE talk (rename moves its folder). */
  flushActive?: () => Promise<void>
}

// viaKeyboard: opened by ⌘K — the menu starts with its first item highlighted (right-click starts blank).
type Menu =
  | { kind: 'talk'; talk: TalkInfo; x: number; y: number; viaKeyboard?: boolean }
  | { kind: 'folder'; topic: string; x: number; y: number; viaKeyboard?: boolean }

// Handout liveness, cached per app session — checked lazily and NEVER blocking a render.
const liveCache = new Map<string, 'live' | 'offline'>()
const liveInFlight = new Set<string>()
const FALLBACK_ROW_HEIGHTS: RowHeights = { ledger: 26, shelf: 55, fhead: 24 }

export default function TalkList({
  talks, folders = [], activeTalk, vaultRoot,
  onSelectTalk, onDeletedTalk, onRefresh, onChangeVault, onNewTalk, onOpenMetadata, flushActive
}: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>(readViewPreference)
  const [naming, setNaming] = useState<NamingMode>(readNamingPreference)
  const [sortKey, setSortKey] = useState<TalkSortKey>(readSortPreference)
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [focusPath, setFocusPath] = useState('') // drill-in ('' = whole vault)
  const [selectedFolder, setSelectedFolder] = useState('')
  const [focusKey, setFocusKey] = useState<string | null>(null) // keyboard focus row
  const [talkMeta, setTalkMeta] = useState<TalkMeta>({})
  const [lastDelivered, setLastDelivered] = useState<Record<string, number>>({})
  const [handouts, setHandouts] = useState<TalkHandouts>({})
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
  const [panelFocused, setPanelFocused] = useState(false) // flyout shows only while we own the keyboard
  const draggingRef = useRef<TalkInfo | null>(null)
  const panelRef = useRef<HTMLElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const sortBtnRef = useRef<HTMLButtonElement>(null)
  const treeRef = useRef<HTMLDivElement>(null)
  const scrollRafRef = useRef<number | null>(null)
  const pendingScrollTopRef = useRef(0)
  const rowRefs = useRef(new Map<string, HTMLDivElement>())

  const q = query.toLowerCase().trim()
  const searching = q.length > 0
  const sortedTalks = useMemo(() => sortTalks(talks, sortKey, talkMeta, lastDelivered), [talks, sortKey, talkMeta, lastDelivered])
  const filtered = useMemo(
    () => sortedTalks.filter((t) => {
      const topic = topicOf(t, vaultRoot)
      if (isIgnoredPath(topic)) return false
      if (focusPath && topic !== focusPath && !topic.startsWith(focusPath + '/')) return false
      return !q || t.title.toLowerCase().includes(q) || t.slug.toLowerCase().includes(q)
    }),
    [sortedTalks, q, focusPath, vaultRoot]
  )
  const tree = useMemo(
    () => buildTree(sortedTalks.filter((t) => !isIgnoredPath(topicOf(t, vaultRoot))), folders.filter((f) => !isIgnoredPath(f)), vaultRoot),
    [sortedTalks, folders, vaultRoot]
  )
  const view = useMemo(() => focusNode(tree, focusPath), [tree, focusPath])
  const rows: RowRef[] = useMemo(
    () => (searching ? flattenSearch(filtered) : flattenTree(view, collapsed)),
    [searching, filtered, view, collapsed]
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
  const allTopics = useMemo(() => allMoveTopics(talks, folders, vaultRoot), [talks, folders, vaultRoot])
  const focusedRow = useMemo(() => rows.find((r) => r.key === focusKey) ?? null, [rows, focusKey])
  const focusedTalk = focusedRow?.kind === 'talk' ? focusedRow.talk : null

  const pubFor = (slug: string): PubState => {
    const url = handouts[slug]?.handoutUrl
    if (!url) return 'none'
    return liveCache.get(url) === 'offline' ? 'dead' : 'live'
  }

  const actions = useTalkActions({
    talks, vaultRoot, activeTalk, onSelectTalk, onDeletedTalk, onRefresh, onNewTalk,
    onOpenMetadata, flushActive, setPrompt, setConfirm, setMenu, setMoveMenu, setFocusKey
  })

  // ── data plumbing ──
  useEffect(() => {
    let alive = true
    async function load(): Promise<void> {
      try {
        const [meta, sessions, hands] = await Promise.all([
          window.tw.vault.talkMeta(),
          window.tw.recording.listAllSessions(),
          window.tw.history.talkHandouts()
        ])
        if (!alive) return
        setTalkMeta(meta || {})
        setLastDelivered(lastDeliveredBySlug(sessions || []))
        setHandouts(hands || {})
      } catch {
        if (!alive) return
        setTalkMeta({}); setLastDelivered({}); setHandouts({})
      }
    }
    void load()
    // Slide counts come from the search index; re-fetch when main says fresh counts landed.
    const unsubscribe = window.tw.vault.onTalkMetaUpdated?.(() => { void load() })
    return () => { alive = false; unsubscribe?.() }
  }, [talks])

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

  // If the drilled-into / selected folder disappears (deleted or renamed), pop back to the root.
  useEffect(() => {
    if (focusPath && focusNode(tree, focusPath) === tree) setFocusPath('')
    if (selectedFolder && focusNode(tree, selectedFolder) === tree) setSelectedFolder('')
  }, [tree, focusPath, selectedFolder])

  // Keyboard focus starts on the first talk; while searching it snaps to a visible match.
  // A dangling focus (row briefly gone mid-refresh, e.g. after rename/move) is left alone so
  // the focus can land on the row's NEW key when the refreshed list arrives.
  useEffect(() => {
    if (!focusKey) { setFocusKey(rows.find((r) => r.kind === 'talk')?.key ?? rows[0]?.key ?? null); return }
    if (searching && !rows.some((r) => r.key === focusKey)) {
      setFocusKey(rows.find((r) => r.kind === 'talk')?.key ?? rows[0]?.key ?? null)
    }
  }, [rows, focusKey, searching])

  // Measure one mounted sample of each available row kind, using a single observer rather
  // than one observer per row. CSS-derived fallbacks make first paint viable; real geometry
  // replaces each estimate after mount and whenever zoom/font metrics resize a sample.
  useLayoutEffect(() => {
    const container = treeRef.current
    if (!container) return

    const measure = (): void => {
      setViewportH(container.clientHeight)
      const ledger = container.querySelector<HTMLElement>('.tl-row')?.offsetHeight
      const shelf = container.querySelector<HTMLElement>('.tl-shrow')?.offsetHeight
      const fhead = container.querySelector<HTMLElement>('.tl-fhead')?.offsetHeight
      setRowHeights((current) => {
        const next = {
          ledger: ledger || current.ledger,
          shelf: shelf || current.shelf,
          fhead: fhead || current.fhead
        }
        return next.ledger === current.ledger && next.shelf === current.shelf && next.fhead === current.fhead
          ? current
          : next
      })
    }

    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    const samples = [
      container.querySelector<HTMLElement>('.tl-fhead'),
      container.querySelector<HTMLElement>('.tl-row'),
      container.querySelector<HTMLElement>('.tl-shrow')
    ].filter((sample): sample is HTMLElement => sample != null)
    for (const sample of samples) observer.observe(sample)
    return () => observer.disconnect()
  }, [viewMode, rows, focusKey])

  // Offset scrolling works even before the target row has mounted. Pinning the focused index
  // makes the row and its focus ring commit together, avoiding a one-frame missing-row flash.
  useLayoutEffect(() => {
    const container = treeRef.current
    const index = focusKey ? rowIndexByKey.get(focusKey) : undefined
    if (!container || index == null) { setAnchorEl(null); return }
    const target = scrollTargetFor(layout, index, container.scrollTop, container.clientHeight)
    if (target != null && target !== container.scrollTop) {
      container.scrollTop = target
      setScrollTop(target)
    }
    setAnchorEl(rowRefs.current.get(focusKey) ?? null)
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
      else setMenu({ kind: 'folder', topic: focusedRow.path, x: at.x, y: at.y, viaKeyboard: true })
    }
    window.addEventListener('tw-context-menu', onContextKey)
    return () => window.removeEventListener('tw-context-menu', onContextKey)
  })

  // ── folders / drag-drop ──
  function toggleFolder(path: string): void {
    setCollapsed((prev) => { const next = new Set(prev); next.has(path) ? next.delete(path) : next.add(path); return next })
  }
  function collapseAll(): void {
    const all = new Set<string>()
    const walk = (n: TreeNode): void => { for (const c of n.children) { all.add(c.path); walk(c) } }
    walk(tree)
    setCollapsed(all)
  }
  function onDropTo(topic: string): void {
    const talk = draggingRef.current
    draggingRef.current = null
    setDragKey(null)
    setDragTopic(null)
    if (talk) void actions.doMove(talk, topic)
  }
  // ⌘↑ — one breadcrumb level up, refocusing the folder we just left so the position reads.
  function upOneLevel(): void {
    if (!focusPath) return
    const from = focusPath
    setFocusPath(focusPath.split('/').slice(0, -1).join('/'))
    setFocusKey(folderKey(from))
  }
  // ⌘← / ⌘→ — every subfolder of the current drilled-in view (the whole vault at top level).
  function subfolderPathsInView(): string[] {
    const out: string[] = []
    const walk = (n: TreeNode): void => { for (const c of n.children) { out.push(c.path); walk(c) } }
    walk(view)
    return out
  }
  function collapseAllInView(): void {
    setCollapsed((prev) => new Set([...prev, ...subfolderPathsInView()]))
  }
  function expandAllInView(): void {
    setCollapsed((prev) => {
      const next = new Set(prev)
      for (const p of subfolderPathsInView()) next.delete(p)
      return next
    })
  }

  // ── keyboard (panel-scoped; identical in both modes) ──
  const handlePanelKey = makePanelKeyHandler({
    rows, focusKey, setFocusKey, focusedRow, focusedTalk,
    collapsed, toggleFolder,
    drillInto: setFocusPath,
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
    onSelectTalk,
    startRename: actions.startRename,
    startRenameFolder: (path) => actions.onFolderAction(path, 'rename'),
    startDuplicate: actions.startDuplicate,
    startDelete: actions.startDelete,
    startMove: actions.startMove,
    focusedRowRect
  })
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
    onTalkContext: (talk, key, e) => { e.preventDefault(); e.stopPropagation(); setFocusKey(key); setMenu({ kind: 'talk', talk, x: e.clientX, y: e.clientY }) },
    onToggleFolder: (path, key) => { setFocusKey(key); setSelectedFolder(path); toggleFolder(path); panelRef.current?.focus({ preventScroll: true }) },
    onFolderContext: (path, key, e) => { e.preventDefault(); e.stopPropagation(); setFocusKey(key); setMenu({ kind: 'folder', topic: path, x: e.clientX, y: e.clientY }) },
    onDrill: setFocusPath,
    onDragStartTalk: (talk, key) => { draggingRef.current = talk; setDragKey(key) },
    onDragEndTalk: () => { draggingRef.current = null; setDragKey(null); setDragTopic(null) },
    // stopPropagation: without it the SAME dragover bubbles on to the tree container, whose
    // handler overwrites dragTopic to '' — so the folder's .tl-drop highlight never showed
    // (live finding, 0.14.0). The folder row owns the event; the tree only sees open-space drags.
    onFolderDragOver: (path, e) => {
      if (draggingRef.current) { autoScrollDuringDrag(e); e.preventDefault(); e.stopPropagation(); setDragTopic(path) }
    },
    // relatedTarget check: dragleave also fires when moving onto the row's own children
    // (name/count spans); only clear when the pointer truly leaves the row's subtree.
    onFolderDragLeave: (path, e) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragTopic((t) => (t === path ? null : t))
    },
    onFolderDrop: (path, e) => { e.preventDefault(); e.stopPropagation(); onDropTo(path) },
    // Dropping on empty space (not a folder) moves the talk to the vault root.
    onTreeDragOver: (e) => { if (draggingRef.current) { autoScrollDuringDrag(e); e.preventDefault(); setDragTopic('') } },
    onTreeDrop: (e) => { e.preventDefault(); onDropTo('') }
  }

  const targetFolder = focusPath // header ＋ / New-folder create in the drilled-in folder, else root
  const modalOpen = !!(menu || moveMenu || prompt || confirm)
  const flyoutMeta = focusedTalk ? talkMeta[focusedTalk.slug] : undefined

  return (
    <aside
      className="talk-list tl-panel"
      ref={panelRef}
      tabIndex={0}
      aria-label="Talks browser"
      onKeyDown={handlePanelKey}
      onFocus={() => setPanelFocused(true)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPanelFocused(false) }}
    >
      <PanelHeader
        viewMode={viewMode}
        onSetViewMode={setViewMode}
        onNewTalk={() => onNewTalk?.(targetFolder)}
        onNewFolder={() => setPrompt({ label: targetFolder ? `New folder inside "${targetFolder.split('/').pop()}"` : 'New folder name', initial: '', cta: 'Create', onSubmit: (v) => void actions.doNewFolder(v, targetFolder) })}
        onToggleSort={(e) => { e.stopPropagation(); toggleSortPop() }}
        sortOpen={!!sortPop}
        sortBtnRef={sortBtnRef}
        onCollapseAll={collapseAll}
        onRefresh={onRefresh}
        onChangeVault={onChangeVault}
        query={query}
        onQueryChange={setQuery}
        searchRef={searchRef}
        onSearchKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (query) setQuery(''); else e.currentTarget.blur() }
          if (e.key === 'ArrowDown') { e.preventDefault(); panelRef.current?.focus() }
        }}
        focusPath={focusPath}
        onFocusPath={setFocusPath}
      />

      <Tree
        searching={searching}
        query={query}
        rows={rows}
        view={view}
        isEmptyVault={talks.length === 0 && folders.length === 0}
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
        layout={layout}
        mounted={mounted}
        containerRef={treeRef}
        onScroll={handleTreeScroll}
        cb={treeCallbacks}
      />

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

      {viewMode === 'ledger' && panelFocused && focusedTalk && !modalOpen && (
        <Flyout
          talk={focusedTalk}
          meta={flyoutMeta}
          deliveredMs={lastDelivered[focusedTalk.slug]}
          pub={pubFor(focusedTalk.slug)}
          anchorEl={anchorEl}
          panelEl={panelRef.current}
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
          onAction={(a) => actions.onFolderAction(menu.topic, a)} />
      )}
      {moveMenu && (
        <MoveMenu
          x={moveMenu.x} y={moveMenu.y}
          topics={allTopics}
          currentTopic={topicOf(moveMenu.talk, vaultRoot)}
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
