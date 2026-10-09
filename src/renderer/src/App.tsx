import { useState, useEffect, useCallback, useRef } from 'react'
import type { PathwayWindowContext, TalkInfo, VaultView } from '../../preload/index'
import VaultSetup from './components/VaultSetup'
import TalkList, { PromptModal } from './components/talklist/TalkList'
import WorkspaceLayout, { type OutlineOps } from './components/WorkspaceLayout'
import NewTalkDialog from './components/NewTalkDialog'
import SlidesOrganizer from './components/SlidesOrganizer'
import SettingsPanel from './components/SettingsPanel'
import MetadataPanel from './components/MetadataPanel'
import Studio from './components/Studio'
import History from './components/History'
import Pathways from './components/Pathways'
import TalkText from './components/TalkText'
import Importer from './components/Importer'
import Toasts from './components/Toasts'
import ConflictCompare from './components/ConflictCompare'
import { CONFLICT_COMPARE_EVENT } from './components/talklist/ConflictLine'
import { VaultSheet, type VaultSheetState } from './components/talklist/VaultSheet'
import { notify } from './lib/notify'
import type { OpenInNewWindowTarget } from '../../shared/open-in-new-window'
import { encodeFocus } from './components/talklist/vaultSections'
import { armOutlineSwitch, consumeEditorEngagement } from './lib/outlineSwitch'
import { effectiveKeys, eventToCMKey, KEYMAP_CHANGED_EVENT } from './keymap/store'

type ToolsView = 'studio' | 'history' | 'pathways' | 'talktext' | 'importer'

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
  | { phase: 'ready'; vaultRoot: string; vaults: VaultView[]; talks: TalkInfo[]; folders: string[]; foldersByVault: Record<string, string[]> }

// A vault scan streams talks in fixed-size batches; several UI surfaces can each kick off a scan,
// and overlapping scans' non-reset (tail) batches would otherwise stack in the accumulator and
// render the same talk 2–3× (display-only — the files on disk are untouched). Upsert by
// outlinePath so an append can never duplicate a talk already present; a reset batch starts fresh.
function mergeTalkBatch(existing: TalkInfo[], batch: TalkInfo[], reset: boolean): TalkInfo[] {
  const byPath = new Map<string, TalkInfo>((reset ? [] : existing).map((talk) => [talk.outlinePath, talk]))
  for (const talk of batch) byPath.set(talk.outlinePath, talk)
  return [...byPath.values()]
}

/** The talks of every open vault, each stamped with its vault. A batch replaces or extends only its
 *  own vault's talks (a reset starts that vault fresh); other vaults are untouched. */
function mergeVaultBatch(existing: TalkInfo[], vaultId: string, batch: TalkInfo[], reset: boolean): TalkInfo[] {
  const stamped = batch.map((talk) => ({ ...talk, vaultId }))
  const others = existing.filter((talk) => talk.vaultId !== vaultId)
  const mine = existing.filter((talk) => talk.vaultId === vaultId)
  return [...others, ...mergeTalkBatch(mine, stamped, reset)]
}

/** The vault holding a talk: its stamped id, else the longest vault root that contains its path. */
function vaultOfTalk(talk: TalkInfo | null, vaults: VaultView[]): VaultView | null {
  if (!talk) return null
  const byId = talk.vaultId ? vaults.find((v) => v.id === talk.vaultId) : undefined
  if (byId) return byId
  let best: VaultView | null = null
  for (const v of vaults) {
    if ((talk.outlinePath === v.root || talk.outlinePath.startsWith(v.root.replace(/\/+$/, '') + '/')) && (!best || v.root.length > best.root.length)) best = v
  }
  return best
}

export default function App() {
  const toolsView = readToolsView()
  return toolsView ? <ToolsShell initialView={toolsView} /> : <MainApp />
}

function readToolsView(): ToolsView | null {
  const view = new URLSearchParams(window.location.search).get('view')
  return view === 'studio' || view === 'history' || view === 'pathways' || view === 'talktext' || view === 'importer' ? view : null
}

function ToolsShell({ initialView }: { initialView: ToolsView }): JSX.Element {
  const [view, setView] = useState<ToolsView>(initialView)
  const [studioInitialSessionId, setStudioInitialSessionId] = useState<string | null>(null)
  const [talkTextSessionId, setTalkTextSessionId] = useState<string | null>(null)
  const [pathwayContext, setPathwayContext] = useState<PathwayWindowContext | null>(null)
  // Bumped each time the window is asked to open History's plan sheet (Plan a run… with no talk open).
  const [planRequest, setPlanRequest] = useState(0)
  // Asked to open a planned Run's pre-work page ('prework:<talk slug>/<run id>' in the show payload's sessionId).
  const [preworkRequest, setPreworkRequest] = useState<{ talkSlug: string; runId: string; nonce: number } | null>(null)

  const showStudio = useCallback((sessionId?: string): void => {
    setStudioInitialSessionId(sessionId ?? null)
    setView('studio')
  }, [])

  const showHistory = useCallback((): void => {
    setView('history')
  }, [])

  const showImporter = useCallback((): void => {
    setView('importer')
  }, [])

  const showTalkText = useCallback((sessionId: string): void => {
    setTalkTextSessionId(sessionId)
    setView('talktext')
  }, [])

  useEffect(() => {
    document.title = view === 'studio'
      ? 'TalkWeaver Studio'
      : view === 'history'
        ? 'TalkWeaver History'
        : view === 'importer'
          ? 'TalkWeaver Importer'
        : view === 'talktext'
          ? 'TalkWeaver — Manage notes'
          : 'TalkWeaver Pathways'
  }, [view])

  useEffect(() => {
    return window.tw.tools.onShow(({ view: nextView, sessionId, pathway }) => {
      if (nextView === 'studio') showStudio(sessionId)
      else if (nextView === 'history') { setView('history'); if (sessionId === 'plan-run') setPlanRequest((n) => n + 1)
        else if (sessionId?.startsWith('prework:')) {
          const slash = sessionId.indexOf('/')
          if (slash > 8) setPreworkRequest((current) => ({ talkSlug: sessionId.slice(8, slash), runId: sessionId.slice(slash + 1), nonce: (current?.nonce ?? 0) + 1 }))
        } }
      else if (nextView === 'importer') setView('importer')
      else if (nextView === 'talktext') {
        if (sessionId) showTalkText(sessionId)
        else {
          setTalkTextSessionId(null)
          setView('talktext')
        }
      }
      else if (nextView === 'pathways') {
        setPathwayContext(pathway ?? null)
        setView('pathways')
      }
    })
  }, [showStudio, showTalkText])

  if (view === 'pathways') {
    return <Pathways context={pathwayContext} onClose={() => window.close()} />
  }

  if (view === 'talktext') {
    return <TalkText isOpen sessionId={talkTextSessionId} onBackToStudio={showStudio} onClose={() => window.close()} />
  }

  if (view === 'importer') {
    return <Importer isOpen onClose={() => window.close()} onShowStudio={showStudio} onShowHistory={showHistory} />
  }

  return view === 'studio' ? (
    <Studio
      isOpen
      onClose={() => window.close()}
      initialSessionId={studioInitialSessionId}
      onShowHistory={showHistory}
      onShowImporter={showImporter}
      onOpenTalkText={showTalkText}
    />
  ) : (
    <History
      isOpen
      onClose={() => window.close()}
      onShowStudio={showStudio}
      onShowImporter={showImporter}
      planRequest={planRequest}
      preworkRequest={preworkRequest}
    />
  )
}

// The window's one answer from main to "what was I opened for" (see MainApp's take-open-request effect).
let takeOpenRequestOnce: Promise<OpenInNewWindowTarget | null> | null = null

function MainApp() {
  const [state, setState] = useState<AppState>({ phase: 'loading' })
  const pendingTalkBatchesRef = useRef<Array<{ vaultId: string; batch: TalkInfo[]; reset: boolean }>>([])
  // Vault ids whose talks the state holds; a vault that is open but not in here is loaded next.
  const loadedVaultsRef = useRef<Set<string>>(new Set())
  const talkBatchRevisionRef = useRef(0)
  // The Talks panel unmounts when the sidebar switches to Slide outline (deliberate, for perf),
  // so hold its drill-in folder here to restore on return instead of dumping back to the root.
  const talkFocusPathRef = useRef('')
  const rememberTalkFocusPath = useCallback((path: string) => { talkFocusPathRef.current = path }, [])
  const [activeTalk, setActiveTalk] = useState<TalkInfo | null>(null)
  // null = closed; a string (possibly '') = open with that subfolder pre-selected, in newTalkVaultId's vault
  // (null = the first open vault).
  const [newTalkTopic, setNewTalkTopic] = useState<string | null>(null)
  const [newTalkVaultId, setNewTalkVaultId] = useState<string | null>(null)
  const [newFolderOpen, setNewFolderOpen] = useState(false)
  // Add vault / Edit this vault / join / refusal sheet (several-vaults ticket 04).
  const [vaultSheet, setVaultSheet] = useState<VaultSheetState | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState<number>(readSidebarWidth)
  const draggingRef = useRef(false)
  // Every launch opens on the Talks list, expanded — never restored into Slide-outline mode or
  // collapsed. Talks is the orientation point when reopening; the persisted value is deliberately
  // ignored at startup (both stay switchable within the session, and the effects below still record
  // the live state for anything else that reads it).
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>('talks')
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(false)
  const sidebarShowsTalksRef = useRef(true)
  sidebarShowsTalksRef.current = sidebarMode === 'talks' && !sidebarCollapsed
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
  // (outlinePath differs); a same-talk re-select and every in-buffer change (reorder, grid undo — none
  // of which remounts the editor) are untouched, so the clobber the earlier unmount-flush caused stays gone.
  const flushSaveRef = useRef<(() => Promise<void>) | null>(null)
  // Outline external-change guard (shared-talk ticket 01): WorkspaceLayout's leave check. It flushes the
  // outgoing talk's pending typing and, while that talk's file differs from the editor, holds the
  // switch behind the sheet (Reload / Keep mine / Stay here) until the choice has completed.
  const leaveGuardRef = useRef<(() => Promise<boolean>) | null>(null)
  const activeTalkRef = useRef<TalkInfo | null>(activeTalk)
  useEffect(() => { activeTalkRef.current = activeTalk }, [activeTalk])
  // Per-talk Metadata panel (ADR-0036) — opened from the Talks-panel context menu (any talk) or
  // the tw-open-metadata event (toolbar Deck menu / command palette → the active talk). Its writes go
  // to main's metadata:edit-frontmatter, which edits an open talk's editor BUFFER (talk-writer.ts →
  // the window's D1 seam, saved through its queue) and any other talk on disk — nothing to adopt.
  const [metadataTalk, setMetadataTalk] = useState<TalkInfo | null>(null)
  // Ticket 10: the compare screen for a talk's conflict copy (raised by the talk row's or the status
  // bar's "Compare…"). The open talk's pending save is flushed first, so both versions are read as
  // they stand.
  const [compare, setCompare] = useState<{ outlinePath: string; vaultId: string | null } | null>(null)
  useEffect(() => {
    const onCompare = (event: Event): void => {
      const detail = (event as CustomEvent<{ outlinePath?: string; vaultId?: string }>).detail
      if (!detail?.outlinePath) return
      const path = detail.outlinePath
      void (async () => {
        if (activeTalkRef.current?.outlinePath === path) { try { await flushSaveRef.current?.() } catch { /* compare reads the buffer anyway */ } }
        setCompare({ outlinePath: path, vaultId: detail.vaultId ?? null })
      })()
    }
    window.addEventListener(CONFLICT_COMPARE_EVENT, onCompare)
    return () => window.removeEventListener(CONFLICT_COMPARE_EVENT, onCompare)
  }, [])
  // Name the editor window by the talk it's editing (e.g. "TalkWeaver Edit — AI 2026 Agents") so
  // ⌘` / Mission Control / the Window menu make it easy to pick the right window (esp. with ⌘N open).
  // Electron uses the page <title> for the window title, so setting document.title is enough here.
  useEffect(() => {
    document.title = activeTalk ? `TalkWeaver Edit — ${activeTalk.title}` : 'TalkWeaver'
  }, [activeTalk])
  /** True when the window switched to `talk`; false when the switch was held (Stay here, or another window has it). */
  const selectTalk = useCallback(async (talk: TalkInfo | null): Promise<boolean> => {
    const prev = activeTalkRef.current
    // Leaving the talk: its pending typing is flushed to ITS file first (awaited, before the claim moves
    // the window on), and the switch waits for the person while that file differs from the editor.
    if (prev && talk?.outlinePath !== prev.outlinePath) {
      const guard = leaveGuardRef.current
      const mayLeave = guard ? await guard() : (await flushSaveRef.current?.(), true)
      if (!mayLeave) return false
    }
    // Same-talk guard (multi-window, ⌘N): claim this talk for this window. If another window already
    // has it active, main focuses that window and refuses — we keep our current talk rather than
    // opening the same file in two windows (which would let their autosaves clobber each other).
    const claim = await window.tw.windows?.claimTalk?.(talk?.outlinePath ?? null)
    if (talk && claim && claim.ok === false) {
      notify(`“${talk.title}” is already open in another window — brought it to the front.`, 'info')
      return false
    }
    setActiveTalk(talk)
    return true
  }, [])

  // T29b (2026-09-19): opening a talk from the Talks panel leaves the sidebar on Talks — the user
  // scrolls the editor to see if it is the right file — and the FIRST engagement with the editor
  // (pointerdown inside it, or the first document-changing keydown) then switches the sidebar to
  // the Slide outline, once per opened talk. Armed ONLY in this panel wrapper: the shared
  // selectTalk above serves every open route (launch restore, deep links, History/Studio, ⌘N
  // windows, new-talk creation) and none of those may arm. Keyed by outlinePath, so an arm goes
  // stale (and is dropped) if a non-panel route changes the active talk before engagement.
  const outlineSwitchArmedRef = useRef<string | null>(null)
  const selectTalkFromPanel = useCallback((talk: TalkInfo | null) => {
    outlineSwitchArmedRef.current = armOutlineSwitch(talk?.outlinePath ?? null)
    void selectTalk(talk)
  }, [selectTalk])
  // A window opened by the file list's "Open in new window" asks main once what it was opened for.
  // A talk is selected through the same selectTalk as any open (claim, guard) once the talk list holds
  // it; a folder scopes the new window's file list to that folder (TalkList drill-in).
  const [openRequest, setOpenRequest] = useState<OpenInNewWindowTarget | null>(null)
  const openRequestAtRef = useRef(0)
  const [folderRequest, setFolderRequest] = useState<{ path: string; vaultId?: string; nonce: number } | null>(null)
  useEffect(() => {
    let live = true
    // One ask per window, shared by every setup of this effect (StrictMode runs setup, cleanup, setup in dev):
    // main hands the request out once, so the second setup must reuse the first call's answer.
    takeOpenRequestOnce ??= window.tw.windows?.takeOpenRequest?.() ?? Promise.resolve(null)
    void takeOpenRequestOnce.then((req) => { if (live && req) { openRequestAtRef.current = Date.now(); setOpenRequest(req) } }).catch(() => undefined)
    return () => { live = false }
  }, [])
  useEffect(() => {
    if (!openRequest || state.phase !== 'ready') return
    if (openRequest.kind === 'folder') {
      talkFocusPathRef.current = encodeFocus({ vaultId: openRequest.vaultId ?? state.vaults.find((v) => v.open && !v.unavailable)?.id ?? '', path: openRequest.topic })
      setFolderRequest({ path: openRequest.topic, vaultId: openRequest.vaultId, nonce: Date.now() })
      setOpenRequest(null)
      return
    }
    const talk = state.talks.find((t) => t.outlinePath === openRequest.outlinePath)
    if (talk) { setOpenRequest(null); void selectTalk(talk); return }
    // Talks arrive in batches: wait for the one that holds it. 15 s in all from the request, not from the last state change.
    const left = Math.max(0, 15000 - (Date.now() - openRequestAtRef.current))
    const timer = window.setTimeout(() => { setOpenRequest(null); void window.tw.windows?.claimTalk?.(null) /* release: this window is no longer "starting" for the talk */; notify('Couldn’t find that talk to open it in this window.', 'error') }, left)
    return () => window.clearTimeout(timer)
  }, [openRequest, state, selectTalk])

  // WorkspaceLayout calls this on the editor's two engagement triggers (see Editor.onEditorEngaged).
  // Talks-panel folder position is untouched: the panel unmounts on the switch and talkFocusPathRef
  // restores it when the user comes back via the tab or sidebar.talks.
  const onEditorEngaged = useCallback(() => {
    const result = consumeEditorEngagement(outlineSwitchArmedRef.current, activeTalkRef.current?.outlinePath ?? null)
    outlineSwitchArmedRef.current = result.armed
    if (result.switchToOutline) {
      setSidebarMode('slides')
      setSidebarCollapsed(false)
    }
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
    const openImporter = (): void => { void window.tw.tools.open('importer') }
    const newTalk = (): void => { setNewTalkVaultId(null); setNewTalkTopic('') }
    const newFolder = (): void => setNewFolderOpen(true)
    const refresh = (): void => { void refreshTalks() }
    // "Add vault…" (palette command id change-vault): the Add vault flow, never a replacement of the
    // first vault (ticket 07). First-run setup still chooses a root through VaultSetup.
    const changeVaultEv = (): void => { void addVault() }
    const searchTalks = (): void => { setSidebarMode('talks'); setSidebarCollapsed(false) }
    // Palette command open-in-new-window: show the file list first (it is unmounted when the sidebar is
    // collapsed or on Slide outline), then let it act on its focused row.
    const openInNewWindow = (): void => {
      if (sidebarShowsTalksRef.current) { window.dispatchEvent(new Event('tw-open-in-new-window-run')); return }
      // The list was hidden: show it, but do not act on the row it focuses by itself on mount.
      setSidebarMode('talks'); setSidebarCollapsed(false)
      notify('Select a talk or folder in the file list first.', 'info')
    }
    const searchSlides = (): void => { setSidebarMode('slides'); setSidebarCollapsed(false) }
    const openMetadata = (): void => { if (activeTalkRef.current) setMetadataTalk(activeTalkRef.current) }
    window.addEventListener('tw-open-settings', openSettings)
    window.addEventListener('tw-open-studio', openStudio)
    window.addEventListener('tw-open-history', openHistory)
    window.addEventListener('tw-open-importer', openImporter)
    window.addEventListener('tw-new-talk', newTalk)
    window.addEventListener('tw-new-folder', newFolder)
    window.addEventListener('tw-refresh-talks', refresh)
    window.addEventListener('tw-change-vault', changeVaultEv)
    window.addEventListener('tw-search-talks', searchTalks)
    window.addEventListener('tw-open-in-new-window', openInNewWindow)
    window.addEventListener('tw-search-slides', searchSlides)
    window.addEventListener('tw-open-metadata', openMetadata)
    return () => {
      window.removeEventListener('tw-open-settings', openSettings)
      window.removeEventListener('tw-open-studio', openStudio)
      window.removeEventListener('tw-open-history', openHistory)
      window.removeEventListener('tw-open-importer', openImporter)
      window.removeEventListener('tw-new-talk', newTalk)
      window.removeEventListener('tw-new-folder', newFolder)
      window.removeEventListener('tw-refresh-talks', refresh)
      window.removeEventListener('tw-change-vault', changeVaultEv)
      window.removeEventListener('tw-search-talks', searchTalks)
      window.removeEventListener('tw-open-in-new-window', openInNewWindow)
      window.removeEventListener('tw-search-slides', searchSlides)
      window.removeEventListener('tw-open-metadata', openMetadata)
    }
  }, [])

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
    const unsubscribe = window.tw.vault.onTalksBatch(({ vaultId, batch, reset }) => {
      talkBatchRevisionRef.current += 1
      setState((current) => {
        if (current.phase !== 'ready') {
          pendingTalkBatchesRef.current.push({ vaultId, batch, reset })
          return current
        }
        // A batch from a vault this window does not show (closed, or not loaded yet) is dropped;
        // loading the vault lists it afresh.
        if (!current.vaults.some((v) => v.id === vaultId && v.open)) return current
        return { ...current, talks: mergeVaultBatch(current.talks, vaultId, batch, reset) }
      })
    })
    // Ticket 09: a scan of the open talk's folder recounted its conflict copies.
    const unsubscribeConflicts = window.tw.vault.onTalkConflicts(({ vaultId, outlinePath, conflicts }) => {
      setState((current) => {
        if (current.phase !== 'ready') return current
        let changed = false
        const talks = current.talks.map((talk) => {
          if (talk.vaultId !== vaultId || talk.outlinePath !== outlinePath || (talk.conflicts ?? 0) === conflicts) return talk
          changed = true
          return { ...talk, conflicts }
        })
        return changed ? { ...current, talks } : current
      })
    })
    void loadVaults({ force: true, init: true })
    const unsubscribeVaults = window.tw.vault.onVaultsChanged(() => { void loadVaults({ force: false }) })
    // Ticket 07: a vault folder that was unmounted comes back (or goes away) while the app runs; the
    // list is re-read each time the window gets focus (one stat per vault in main), no watcher.
    const onFocus = (): void => { void loadVaults({ force: false }) }
    window.addEventListener('focus', onFocus)
    return () => { unsubscribe(); unsubscribeConflicts(); unsubscribeVaults(); window.removeEventListener('focus', onFocus) }
  }, [])

  // Bring the window's vault list, talks and folders up to date with main's registry. force reloads
  // every open vault; otherwise only vaults not shown yet are listed, and closed vaults drop out.
  const loadingRef = useRef<Promise<void> | null>(null)
  async function loadVaults(opts: { force: boolean; init?: boolean }): Promise<void> {
    // Loads run one after another: a change event that lands mid-load is served by the next pass.
    while (loadingRef.current) await loadingRef.current.catch(() => {})
    const run = (async () => {
      const vaults = await window.tw.vault.list()
      // An unavailable vault (folder missing or unreadable) stays in the list with no talks; it is
      // listed again once it is back (a window focus re-reads the list).
      const open = vaults.filter((v) => v.open && !v.unavailable)
      if (!open.length && !vaults.some((v) => v.open)) {
        loadedVaultsRef.current = new Set()
        setState({ phase: 'setup' })
        return
      }
      const batchRevision = talkBatchRevisionRef.current
      const targets = opts.force ? open : open.filter((v) => !loadedVaultsRef.current.has(v.id))
      const loaded = await Promise.all(targets.map(async (v) => {
        const [talks, folders] = await Promise.all([window.tw.vault.listTalks(v.id), window.tw.vault.listFolders(v.id)])
        return { vault: v, talks: (talks || []).map((t) => ({ ...t, vaultId: v.id })), folders: folders || [] }
      }))
      loadedVaultsRef.current = new Set([...open.filter((v) => opts.force ? false : loadedVaultsRef.current.has(v.id)).map((v) => v.id), ...targets.map((v) => v.id)])
      const queued = opts.init ? pendingTalkBatchesRef.current.splice(0) : []
      setState((current) => {
        const openIds = new Set(open.map((v) => v.id))
        const base = current.phase === 'ready' ? current : null
        let talks = (base?.talks ?? []).filter((t) => t.vaultId && openIds.has(t.vaultId))
        const foldersByVault: Record<string, string[]> = {}
        for (const v of open) foldersByVault[v.id] = base?.foldersByVault[v.id] ?? []
        for (const { vault, talks: listed, folders } of loaded) {
          // listTalks returns a cached snapshot while the fresh scan streams separately. A slow folder
          // walk can let that stream finish first; never replace it with the older cache.
          const streamedSince = !opts.init && batchRevision !== talkBatchRevisionRef.current && talks.some((t) => t.vaultId === vault.id)
          if (!streamedSince) talks = [...talks.filter((t) => t.vaultId !== vault.id), ...listed]
          foldersByVault[vault.id] = folders
        }
        for (const item of queued) if (openIds.has(item.vaultId)) talks = mergeVaultBatch(talks, item.vaultId, item.batch, item.reset)
        const firstShown = open[0] ?? vaults.find((v) => v.open)!
        return { phase: 'ready', vaultRoot: firstShown.root, vaults, talks, folders: foldersByVault[firstShown.id] ?? [], foldersByVault }
      })
    })()
    loadingRef.current = run
    try { await run } finally { loadingRef.current = null }
  }

  async function handleVaultChosen(_root: string) {
    await loadVaults({ force: true })
  }

  async function refreshTalks() {
    await loadVaults({ force: true })
  }

  // "+ Add vault…" (ticket 04): pick a folder. A folder with no vault file opens the New vault sheet,
  // one with a vault file the join sheet; a folder already open as a vault, or inside one, is refused
  // in a small sheet that names that vault.
  async function addVault(): Promise<void> {
    const chosen = await window.tw.vault.chooseFolder()
    if (!chosen) return
    if (!chosen.ok) { setVaultSheet({ mode: 'refused', reason: chosen.reason, message: chosen.message, other: chosen.other }); return }
    setVaultSheet({ mode: chosen.kind, chosen })
  }
  async function vaultSheetDone(): Promise<void> {
    setVaultSheet(null)
    await loadVaults({ force: false })
  }
  function showVault(vaultId: string): void {
    setVaultSheet(null)
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-vault-header="${CSS.escape(vaultId)}"]`)
      el?.scrollIntoView({ block: 'nearest' })
      el?.classList.add('tl-vhead--flash')
      window.setTimeout(() => el?.classList.remove('tl-vhead--flash'), 1200)
    })
  }

  // Close or reopen a vault in this window. A talk open from a vault being closed is put away first
  // (its typing is saved), since a closed vault's files are no longer written by this app.
  async function setVaultOpen(vaultId: string, open: boolean): Promise<void> {
    const closingActive = !open && state.phase === 'ready' && vaultOfTalk(activeTalkRef.current, state.vaults)?.id === vaultId
    // The editor's pending typing is saved (and any changed-on-disk choice settled) BEFORE the vault
    // closes, since a closed vault's files are no longer written by this app.
    if (closingActive) {
      const guard = leaveGuardRef.current
      const mayLeave = guard ? await guard() : (await flushSaveRef.current?.(), true)
      if (!mayLeave) return
    }
    // Main decides (it refuses the last open vault); only an accepted close puts the talk away.
    const result = await window.tw.vault.setOpen(vaultId, open)
    if (!result.ok) { notify(result.message, 'info'); return }
    if (closingActive) {
      setActiveTalk(null)
      void window.tw.windows?.claimTalk?.(null)
    }
    await loadVaults({ force: false })
  }

  // New talk with no vault whose folder is there (ticket 07): nothing opens and nothing is created.
  useEffect(() => {
    if (newTalkTopic === null || state.phase !== 'ready') return
    if (state.vaults.some((v) => v.open && !v.unavailable)) return
    setNewTalkTopic(null)
    notify('No vault is available on this Mac right now, so no talk was made.', 'warning')
  }, [newTalkTopic, state])

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

  // The vault a talk is in decides which root the editor and panels work against; with no talk open, the
  // first open vault. A vault to create in (a New talk started from one section) is picked the same way.
  // A vault whose folder is not there (ticket 07) is skipped: nothing is created in it.
  const usableVault = (v: VaultView): boolean => v.open && !v.unavailable
  const firstUsableVault = state.vaults.find(usableVault) ?? null
  const firstOpenVault = firstUsableVault ?? state.vaults.find((v) => v.open) ?? state.vaults[0]
  const activeVault = vaultOfTalk(activeTalk, state.vaults) ?? firstOpenVault
  const newTalkVault = state.vaults.find((v) => v.id === newTalkVaultId && usableVault(v)) ?? firstUsableVault

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
              foldersByVault={state.foldersByVault}
              vaults={state.vaults}
              onAddVault={() => { void addVault() }}
              onSetVaultOpen={(id, open) => { void setVaultOpen(id, open) }}
              onEditVault={(id) => setVaultSheet({ mode: 'edit', vaultId: id })}
              activeTalk={activeTalk}
              onSelectTalk={selectTalkFromPanel}
              onDeletedTalk={(outlinePath) => { if (activeTalk?.outlinePath === outlinePath) { setActiveTalk(null); void window.tw.windows?.claimTalk?.(null) } }}
              onRefresh={refreshTalks}
              onChangeVault={() => { void addVault() }}
              onNewTalk={(topic, vaultId) => { setNewTalkVaultId(vaultId ?? null); setNewTalkTopic(topic ?? '') }}
              onOpenMetadata={(talk) => setMetadataTalk(talk)}
              // Rename safety (ADR-0008): the panel awaits the editor's pending-autosave flush
              // BEFORE renaming the active talk's folder, so no late write recreates the old path.
              flushActive={async () => { await flushSaveRef.current?.() }}
              // …and the external-change guard's leave check before any move of the active talk.
              leaveActive={async () => { const guard = leaveGuardRef.current; if (guard) return guard(); await flushSaveRef.current?.(); return true }}
              initialFocusPath={talkFocusPathRef.current}
              focusRequest={folderRequest}
              onFocusPathChange={rememberTalkFocusPath}
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
      {newTalkTopic !== null && newTalkVault && (
        <NewTalkDialog
          vaultRoot={newTalkVault.root}
          vaultId={newTalkVault.id}
          folders={state.foldersByVault[newTalkVault.id] ?? []}
          defaultTopic={newTalkTopic}
          onCreated={async (talk) => {
            setNewTalkTopic(null)
            await refreshTalks()
            selectTalk({ ...talk, vaultId: newTalkVault.id })
          }}
          onClose={() => setNewTalkTopic(null)}
        />
      )}
      {vaultSheet && (
        <VaultSheet
          state={vaultSheet}
          onClose={() => setVaultSheet(null)}
          onDone={() => { void vaultSheetDone() }}
          onChooseAnother={() => { setVaultSheet(null); void addVault() }}
          onShowVault={showVault}
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
            if (name) { await window.tw.vault.createFolder(name, '', activeVault.id); await refreshTalks() }
          }}
        />
      )}
      <WorkspaceLayout
        activeTalk={activeTalk}
        vaultRoot={activeVault.root}
        onOutlineChange={slidesOutlineVisible ? setOutlineContent : undefined}
        registerJump={(fn) => { jumpRef.current = fn }}
        registerOutlineOps={registerOutlineOps}
        onOpenSettings={() => setSettingsOpen(true)}
        onSelectTalk={selectTalk}
        onEditorEngaged={onEditorEngaged}
        registerFlushSave={(fn) => { flushSaveRef.current = fn }}
        registerLeaveGuard={(fn) => { leaveGuardRef.current = fn }}
        onDiscardTalk={() => { void selectTalk(null) }}
        onActiveLineChange={slidesOutlineVisible ? setActiveOutlineLine : undefined}
      />
      <MetadataPanel
        talk={metadataTalk}
        vaultRoot={activeVault.root}
        isOpen={metadataTalk !== null}
        onClose={() => setMetadataTalk(null)}
        // Flush the live editor buffer to disk before the panel READS the active talk, so it shows
        // current bytes (other talks have no buffer — the flush is a no-op). Writes need no flush.
        flushBeforeIO={async () => {
          if (metadataTalk && activeTalkRef.current?.outlinePath === metadataTalk.outlinePath) {
            await flushSaveRef.current?.()
          }
        }}
        // The edit is already in the open talk's buffer (or on disk for any other talk).
        onSaved={() => {
          void refreshTalks() // sidebar title/subtitle/event may have changed
        }}
      />
      <SettingsPanel
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        vaultRoot={firstOpenVault.root}
        onChangeVault={async () => { setSettingsOpen(false); await addVault() }}
      />
      {compare && (
        <ConflictCompare
          key={compare.outlinePath}
          outlinePath={compare.outlinePath}
          vault={state.vaults.find((v) => v.id === compare.vaultId) ?? null}
          onClose={() => setCompare(null)}
          onMerged={(outlinePath) => {
            // The merged talk opens (frame 4); an open talk already has the text in its editor.
            if (activeTalkRef.current?.outlinePath === outlinePath) return
            const talk = state.talks.find((t) => t.outlinePath === outlinePath)
            if (talk) void selectTalk(talk)
          }}
        />
      )}
      <Toasts />
    </div>
  )
}
