import { useState, useEffect, useCallback, useRef } from 'react'
import type { PathwayWindowContext, TalkInfo } from '../../preload/index'
import VaultSetup from './components/VaultSetup'
import TalkList, { PromptModal } from './components/TalkList'
import WorkspaceLayout, { type OutlineOps } from './components/WorkspaceLayout'
import NewTalkDialog from './components/NewTalkDialog'
import SlidesOrganizer from './components/SlidesOrganizer'
import SettingsPanel from './components/SettingsPanel'
import MetadataPanel from './components/MetadataPanel'
import Studio from './components/Studio'
import History from './components/History'
import Pathways from './components/Pathways'
import Toasts from './components/Toasts'
import { notify } from './lib/notify'
import { effectiveKeys, eventToCMKey, KEYMAP_CHANGED_EVENT } from './keymap/store'

type ToolsView = 'studio' | 'history' | 'pathways'

// The flat "Outline" view was retired: every slide already lives in the file, and the Slides
// view (now labelled "Slide outline") is the structure people actually want. Two sidebar tabs.
type SidebarMode = 'talks' | 'slides'
type SidebarCommandId = 'sidebar.talks' | 'sidebar.outline' | 'sidebar.toggle'

const SIDEBAR_STORAGE_KEY = 'tw-sidebar'
const SIDEBAR_DEFAULT = 240
const SIDEBAR_MIN = 160
const SIDEBAR_MAX = 420
const SIDEBAR_COMMAND_IDS: SidebarCommandId[] = ['sidebar.talks', 'sidebar.outline', 'sidebar.toggle']

function readSidebarWidth(): number {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_STORAGE_KEY)
    if (raw === null) return SIDEBAR_DEFAULT
    const n = parseFloat(raw)
    return Number.isFinite(n) ? Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, n)) : SIDEBAR_DEFAULT
  } catch {
    return SIDEBAR_DEFAULT
  }
}

type AppState =
  | { phase: 'loading' }
  | { phase: 'setup' }
  | { phase: 'ready'; vaultRoot: string; talks: TalkInfo[]; folders: string[] }

export default function App() {
  const toolsView = readToolsView()
  return toolsView ? <ToolsShell initialView={toolsView} /> : <MainApp />
}

function readToolsView(): ToolsView | null {
  const view = new URLSearchParams(window.location.search).get('view')
  return view === 'studio' || view === 'history' || view === 'pathways' ? view : null
}

function ToolsShell({ initialView }: { initialView: ToolsView }): JSX.Element {
  const [view, setView] = useState<ToolsView>(initialView)
  const [studioInitialSessionId, setStudioInitialSessionId] = useState<string | null>(null)
  const [pathwayContext, setPathwayContext] = useState<PathwayWindowContext | null>(null)

  const showStudio = useCallback((sessionId?: string): void => {
    setStudioInitialSessionId(sessionId ?? null)
    setView('studio')
  }, [])

  const showHistory = useCallback((): void => {
    setView('history')
  }, [])

  useEffect(() => {
    document.title = view === 'studio' ? 'TalkWeaver Studio' : view === 'history' ? 'TalkWeaver History' : 'TalkWeaver Pathways'
  }, [view])

  useEffect(() => {
    return window.tw.tools.onShow(({ view: nextView, sessionId, pathway }) => {
      if (nextView === 'studio') showStudio(sessionId)
      else if (nextView === 'history') setView('history')
      else {
        setPathwayContext(pathway ?? null)
        setView('pathways')
      }
    })
  }, [showStudio])

  if (view === 'pathways') {
    return <Pathways context={pathwayContext} onClose={() => window.close()} />
  }

  return view === 'studio' ? (
    <Studio
      isOpen
      onClose={() => window.close()}
      initialSessionId={studioInitialSessionId}
      onShowHistory={showHistory}
    />
  ) : (
    <History
      isOpen
      onClose={() => window.close()}
      onShowStudio={showStudio}
    />
  )
}

function MainApp() {
  const [state, setState] = useState<AppState>({ phase: 'loading' })
  const pendingTalkBatchesRef = useRef<Array<{ batch: TalkInfo[]; reset: boolean }>>([])
  const [activeTalk, setActiveTalk] = useState<TalkInfo | null>(null)
  // null = closed; a string (possibly '') = open with that subfolder pre-selected.
  const [newTalkTopic, setNewTalkTopic] = useState<string | null>(null)
  const [newFolderOpen, setNewFolderOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState<number>(readSidebarWidth)
  const draggingRef = useRef(false)
  // Every launch opens on the Talks list, expanded — never restored into Slide-outline mode or
  // collapsed. Talks is the orientation point when reopening; the persisted value is deliberately
  // ignored at startup (both stay switchable within the session, and the effects below still record
  // the live state for anything else that reads it).
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>('talks')
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(false)
  // The current talk's outline, mirrored up from WorkspaceLayout so the Slide-outline
  // sidebar view renders the live structure; jumpRef jumps the editor + strip to a line.
  const [outlineContent, setOutlineContent] = useState('')
  // The source line of the slide the editor cursor is in, mirrored up from WorkspaceLayout so the
  // Slide-outline sidebar can follow the cursor (highlight + scroll the current slide into view).
  const [activeOutlineLine, setActiveOutlineLine] = useState<number | null>(null)
  const jumpRef = useRef<((line: number) => void) | null>(null)
  const [outlineOps, setOutlineOps] = useState<OutlineOps | null>(null)
  // STABLE registration sink + identity bail. outlineOps is the one register* channel that
  // lives in STATE (the Slides sidebar re-renders from it) — an inline `(ops) => setOutlineOps(ops)`
  // gets a new identity on every MainApp render, which re-fires the editor's registration effect,
  // which setStates a fresh ops object, which re-renders MainApp: a silent microtask-speed render
  // loop that pinned the renderer at 100% CPU whenever a talk was open (the beachball). The
  // useCallback([]) breaks the identity link; the same-functions bail stops re-registrations of
  // identical commands from scheduling renders at all.
  const registerOutlineOps = useCallback((ops: OutlineOps) => {
    setOutlineOps((prev) =>
      prev && prev.move === ops.move && prev.reLevel === ops.reLevel && prev.moveTo === ops.moveTo
        ? prev
        : ops
    )
  }, [])
  const sidebarKeysRef = useRef<Record<SidebarCommandId, string>>({
    'sidebar.talks': effectiveKeys('sidebar.talks'),
    'sidebar.outline': effectiveKeys('sidebar.outline'),
    'sidebar.toggle': effectiveKeys('sidebar.toggle')
  })

  // Flush-on-switch (data-loss guard, 2026-07-05). WorkspaceLayout registers a "flush the current
  // editor's pending edit" fn here; every talk switch funnels through selectTalk, which flushes the
  // OUTGOING editor to the OUTGOING talk's file BEFORE the switch remounts it — so a sub-1.5s edit
  // made just before switching is persisted, not silently dropped. Fires ONLY on a genuine talk change
  // (outlinePath differs); a same-talk re-select and every reorderNonce remount (which never reaches
  // App) are untouched, so the reorder/grid-undo clobber the earlier unmount-flush caused stays gone.
  const flushSaveRef = useRef<(() => Promise<void>) | null>(null)
  const activeTalkRef = useRef<TalkInfo | null>(activeTalk)
  useEffect(() => { activeTalkRef.current = activeTalk }, [activeTalk])
  // Per-talk Metadata panel (ADR-0036) — opened from the Talks-panel context menu (any talk) or
  // the tw-open-metadata event (toolbar Deck menu / command palette → the active talk). When the
  // panel writes the ACTIVE talk's outline on disk, adoptOutlineRef pushes the new text into the
  // live editor buffer (WorkspaceLayout registers it) so the next autosave can't clobber the edit.
  const [metadataTalk, setMetadataTalk] = useState<TalkInfo | null>(null)
  const adoptOutlineRef = useRef<((content: string) => void) | null>(null)
  // Name the editor window by the talk it's editing (e.g. "TalkWeaver Edit — AI 2026 Agents") so
  // ⌘` / Mission Control / the Window menu make it easy to pick the right window (esp. with ⌘N open).
  // Electron uses the page <title> for the window title, so setting document.title is enough here.
  useEffect(() => {
    document.title = activeTalk ? `TalkWeaver Edit — ${activeTalk.title}` : 'TalkWeaver'
  }, [activeTalk])
  const selectTalk = useCallback(async (talk: TalkInfo | null) => {
    // Same-talk guard (multi-window, ⌘N): claim this talk for this window. If another window already
    // has it active, main focuses that window and refuses — we keep our current talk rather than
    // opening the same file in two windows (which would let their autosaves clobber each other).
    const claim = await window.tw.windows?.claimTalk?.(talk?.outlinePath ?? null)
    if (talk && claim && claim.ok === false) {
      notify(`“${talk.title}” is already open in another window — brought it to the front.`, 'info')
      return
    }
    const prev = activeTalkRef.current
    // Fire-and-forget: flushSave reads the outgoing doc + path synchronously before the switch.
    if (prev && talk?.outlinePath !== prev.outlinePath) void flushSaveRef.current?.()
    setActiveTalk(talk)
  }, [])

  useEffect(() => { window.localStorage.setItem('tw-sidebar-mode', sidebarMode) }, [sidebarMode])
  useEffect(() => {
    window.localStorage.setItem('tw-sidebar-collapsed', sidebarCollapsed ? '1' : '0')
  }, [sidebarCollapsed])

  const focusSidebarSearch = useCallback((mode: SidebarMode): void => {
    setSidebarMode(mode)
    setSidebarCollapsed(false)
    requestAnimationFrame(() => {
      window.dispatchEvent(new Event(mode === 'talks' ? 'tw-search-talks' : 'tw-search-slides'))
    })
  }, [])

  const toggleSidebar = useCallback((focusMode: SidebarMode): void => {
    setSidebarCollapsed((collapsed) => {
      if (collapsed) {
        requestAnimationFrame(() => {
          window.dispatchEvent(new Event(focusMode === 'talks' ? 'tw-search-talks' : 'tw-search-slides'))
        })
      }
      return !collapsed
    })
  }, [])

  // Sidebar shortcuts are remappable through the shared keymap registry, but they execute here
  // because the registry's run(view) only fires while the CodeMirror editor has focus. ⌘\ remains
  // as the hardcoded historical alias for sidebar toggle; ⌘, opens Settings (standard macOS
  // Preferences chord — works anywhere, including inside the editor).
  useEffect(() => {
    const readSidebarKeys = (): void => {
      sidebarKeysRef.current = {
        'sidebar.talks': effectiveKeys('sidebar.talks'),
        'sidebar.outline': effectiveKeys('sidebar.outline'),
        'sidebar.toggle': effectiveKeys('sidebar.toggle')
      }
    }
    function onKey(e: KeyboardEvent): void {
      const cmKey = eventToCMKey(e)
      const matched = SIDEBAR_COMMAND_IDS.find((id) => sidebarKeysRef.current[id] === cmKey)
      if (matched === 'sidebar.talks') {
        e.preventDefault()
        focusSidebarSearch('talks')
        return
      }
      if (matched === 'sidebar.outline') {
        e.preventDefault()
        focusSidebarSearch('slides')
        return
      }
      if (matched === 'sidebar.toggle' || ((e.metaKey || e.ctrlKey) && e.key === '\\')) {
        e.preventDefault()
        toggleSidebar(sidebarMode)
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault()
        e.stopPropagation()
        setSettingsOpen((o) => !o)
      }
    }
    readSidebarKeys()
    window.addEventListener('keydown', onKey, { capture: true })
    window.addEventListener(KEYMAP_CHANGED_EVENT, readSidebarKeys)
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true })
      window.removeEventListener(KEYMAP_CHANGED_EVENT, readSidebarKeys)
    }
  }, [focusSidebarSearch, sidebarMode, toggleSidebar])

  // Commands that live deeper in the tree (command palette / toolbar) reach App via window events,
  // so every clickable action also has a keyboard-reachable command. Settings / New talk / New folder.
  useEffect(() => {
    const openSettings = (): void => setSettingsOpen(true)
    const openStudio = (event: Event): void => {
      const detail = (event as CustomEvent<{ sessionId?: string }>).detail
      void window.tw.tools.open('studio', detail?.sessionId)
    }
    const openHistory = (): void => {
      void window.tw.tools.open('history')
    }
    const newTalk = (): void => setNewTalkTopic('')
    const newFolder = (): void => setNewFolderOpen(true)
    const refresh = (): void => { void refreshTalks() }
    const changeVaultEv = (): void => { void changeVault() }
    const searchTalks = (): void => { setSidebarMode('talks'); setSidebarCollapsed(false) }
    const searchSlides = (): void => { setSidebarMode('slides'); setSidebarCollapsed(false) }
    const openMetadata = (): void => { if (activeTalkRef.current) setMetadataTalk(activeTalkRef.current) }
    window.addEventListener('tw-open-settings', openSettings)
    window.addEventListener('tw-open-studio', openStudio)
    window.addEventListener('tw-open-history', openHistory)
    window.addEventListener('tw-new-talk', newTalk)
    window.addEventListener('tw-new-folder', newFolder)
    window.addEventListener('tw-refresh-talks', refresh)
    window.addEventListener('tw-change-vault', changeVaultEv)
    window.addEventListener('tw-search-talks', searchTalks)
    window.addEventListener('tw-search-slides', searchSlides)
    window.addEventListener('tw-open-metadata', openMetadata)
    return () => {
      window.removeEventListener('tw-open-settings', openSettings)
      window.removeEventListener('tw-open-studio', openStudio)
      window.removeEventListener('tw-open-history', openHistory)
      window.removeEventListener('tw-new-talk', newTalk)
      window.removeEventListener('tw-new-folder', newFolder)
      window.removeEventListener('tw-refresh-talks', refresh)
      window.removeEventListener('tw-change-vault', changeVaultEv)
      window.removeEventListener('tw-search-talks', searchTalks)
      window.removeEventListener('tw-search-slides', searchSlides)
      window.removeEventListener('tw-open-metadata', openMetadata)
    }
  }, [])

  async function changeVault(): Promise<void> {
    const root = await window.tw.vault.chooseRoot()
    if (root) await handleVaultChosen(root)
  }

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(sidebarWidth))
    } catch {
      // ignore persistence failures
    }
  }, [sidebarWidth])

  const startSidebarDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    draggingRef.current = true
    const onMove = (ev: MouseEvent): void => {
      if (!draggingRef.current) return
      const next = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, ev.clientX))
      setSidebarWidth(next)
    }
    const onUp = (): void => {
      draggingRef.current = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  useEffect(() => {
    const unsubscribe = window.tw.vault.onTalksBatch(({ batch, reset }) => {
      setState((current) => {
        if (current.phase !== 'ready') {
          pendingTalkBatchesRef.current.push({ batch, reset })
          return current
        }
        const talks = reset ? batch : [...current.talks, ...batch]
        return { ...current, talks }
      })
    })
    async function init() {
      const root = await window.tw.vault.getRoot()
      if (!root) {
        setState({ phase: 'setup' })
        return
      }
      const talks = await window.tw.vault.listTalks()
      const queued = pendingTalkBatchesRef.current.splice(0)
      const indexedTalks = queued.reduce((all, item) => item.reset ? item.batch : [...all, ...item.batch], talks)
      setState({ phase: 'ready', vaultRoot: root, talks: indexedTalks, folders: [] })
      void window.tw.vault.listFolders().then((folders) => {
        setState((current) => current.phase === 'ready' && current.vaultRoot === root
          ? { ...current, folders: folders || [] }
          : current)
      })
    }
    void init()
    return unsubscribe
  }, [])

  async function handleVaultChosen(root: string) {
    const [talks, folders] = await Promise.all([window.tw.vault.listTalks(), window.tw.vault.listFolders()])
    setState({ phase: 'ready', vaultRoot: root, talks, folders: folders || [] })
  }

  async function refreshTalks() {
    if (state.phase !== 'ready') return
    const [talks, folders] = await Promise.all([window.tw.vault.listTalks(), window.tw.vault.listFolders()])
    setState({ ...state, talks, folders: folders || [] })
  }

  if (state.phase === 'loading') {
    return (
      <div className="loading-screen">
        <div className="spinner" />
      </div>
    )
  }

  if (state.phase === 'setup') {
    return <VaultSetup onVaultChosen={handleVaultChosen} />
  }

  const modes: Array<{ id: SidebarMode; label: string }> = [
    { id: 'talks', label: 'Talks' },
    { id: 'slides', label: 'Slide outline' }
  ]

  // Mirror the live outline (and cursor line) up from WorkspaceLayout ONLY while the
  // Slide-outline sidebar is visible — it is the sole consumer. Passing the setters
  // unconditionally re-rendered App + TalkList on EVERY keystroke for a hidden pane.
  // On switching to the Slides tab, WorkspaceLayout's mirror effect re-fires (the
  // callback identity is in its deps) and pushes the current content immediately.
  const slidesOutlineVisible = !sidebarCollapsed && sidebarMode === 'slides'

  return (
    <div className="app-shell">
      {sidebarCollapsed ? (
        <div className="sidebar-rail">
          <button
            className="icon-btn"
            onClick={() => setSidebarCollapsed(false)}
            title="Show sidebar (⌘\\)"
            data-sidebar-expand
          >
            ☰
          </button>
        </div>
      ) : (
        <div
          className="sidebar-wrap"
          data-sidebar
          style={{ width: sidebarWidth, ['--sidebar-width' as string]: `${sidebarWidth}px` }}
        >
          <div className="sidebar-modebar">
            <div className="sidebar-modes" role="tablist">
              {modes.map((m) => (
                <button
                  key={m.id}
                  role="tab"
                  aria-selected={sidebarMode === m.id}
                  className={`sidebar-mode-btn ${sidebarMode === m.id ? 'sidebar-mode-btn--active' : ''}`}
                  onClick={() => setSidebarMode(m.id)}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <button
              className="icon-btn"
              onClick={() => setSidebarCollapsed(true)}
              title="Hide sidebar (⌘\\)"
              data-sidebar-collapse
            >
              ⟨
            </button>
          </div>

          {sidebarMode === 'talks' && (
            <TalkList
              talks={state.talks}
              folders={state.folders}
              activeTalk={activeTalk}
              onSelectTalk={selectTalk}
              onDeletedTalk={(outlinePath) => { if (activeTalk?.outlinePath === outlinePath) { setActiveTalk(null); void window.tw.windows?.claimTalk?.(null) } }}
              onRefresh={refreshTalks}
              vaultRoot={state.vaultRoot}
              onChangeVault={async () => {
                const root = await window.tw.vault.chooseRoot()
                if (root) handleVaultChosen(root)
              }}
              onNewTalk={(topic) => setNewTalkTopic(topic ?? '')}
              onOpenMetadata={(talk) => setMetadataTalk(talk)}
              // Rename safety (ADR-0008): the panel awaits the editor's pending-autosave flush
              // BEFORE renaming the active talk's folder, so no late write recreates the old path.
              flushActive={async () => { await flushSaveRef.current?.() }}
            />
          )}
          {sidebarMode === 'slides' && (
            <div className="sidebar-nav-body">
              <SlidesOrganizer content={outlineContent} onJump={(line) => jumpRef.current?.(line)} ops={outlineOps} currentLine={activeOutlineLine} />
            </div>
          )}

          <div
            className="sidebar-resizer"
            role="separator"
            aria-orientation="vertical"
            onMouseDown={startSidebarDrag}
            title="Drag to resize"
          />
        </div>
      )}
      {newTalkTopic !== null && (
        <NewTalkDialog
          vaultRoot={state.vaultRoot}
          folders={state.folders}
          defaultTopic={newTalkTopic}
          onCreated={async (talk) => {
            setNewTalkTopic(null)
            await refreshTalks()
            selectTalk(talk)
          }}
          onClose={() => setNewTalkTopic(null)}
        />
      )}
      {newFolderOpen && (
        <PromptModal
          label="New folder name"
          initial=""
          cta="Create"
          onCancel={() => setNewFolderOpen(false)}
          onSubmit={async (v) => {
            setNewFolderOpen(false)
            const name = v.trim()
            if (name) { await window.tw.vault.createFolder(name, ''); await refreshTalks() }
          }}
        />
      )}
      <WorkspaceLayout
        activeTalk={activeTalk}
        vaultRoot={state.vaultRoot}
        onOutlineChange={slidesOutlineVisible ? setOutlineContent : undefined}
        registerJump={(fn) => { jumpRef.current = fn }}
        registerOutlineOps={registerOutlineOps}
        onOpenSettings={() => setSettingsOpen(true)}
        onSelectTalk={selectTalk}
        registerFlushSave={(fn) => { flushSaveRef.current = fn }}
        registerAdoptOutline={(fn) => { adoptOutlineRef.current = fn }}
        onActiveLineChange={slidesOutlineVisible ? setActiveOutlineLine : undefined}
      />
      <MetadataPanel
        talk={metadataTalk}
        vaultRoot={state.vaultRoot}
        isOpen={metadataTalk !== null}
        onClose={() => setMetadataTalk(null)}
        // Flush the live editor buffer to disk before the panel reads/writes the ACTIVE talk, so
        // it always operates on current bytes (other talks have no buffer — the flush is a no-op).
        flushBeforeIO={async () => {
          if (metadataTalk && activeTalkRef.current?.outlinePath === metadataTalk.outlinePath) {
            await flushSaveRef.current?.()
          }
        }}
        // Adopt disk writes into the live buffer when the edited talk is the one being edited.
        onSaved={(outlinePath, content) => {
          if (activeTalkRef.current?.outlinePath === outlinePath) adoptOutlineRef.current?.(content)
          void refreshTalks() // sidebar title/subtitle/event may have changed
        }}
      />
      <SettingsPanel
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        vaultRoot={state.vaultRoot}
        onChangeVault={async () => {
          const root = await window.tw.vault.chooseRoot()
          if (root) await handleVaultChosen(root)
        }}
      />
      <Toasts />
    </div>
  )
}
