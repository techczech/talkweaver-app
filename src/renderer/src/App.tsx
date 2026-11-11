import { LayoutGrid } from 'lucide-react'
import { NARROW_WINDOW_PX } from '../../shared/window-widths'
import { flushSync } from 'react-dom'
import ManagementLayer from './components/vault-gallery/ManagementLayer'
import { isWorkspaceCovered } from './lib/workspaceCover'
import { adoptMovedTalk, selectGuardedTalk, type GalleryOpenGuard } from './lib/talkSelection'
import VaultGallery from './components/vault-gallery/VaultGallery'
import { useState, useEffect, useCallback, useRef } from 'react'
import type { TalkInfo, VaultView } from '../../preload/index'
import VaultSetup from './components/VaultSetup'
import TalkList, { PromptModal } from './components/talklist/TalkList'
import WorkspaceLayout, { type OutlineOps } from './components/WorkspaceLayout'
import NewTalkDialog, { createdTalk } from './components/NewTalkDialog'
import SlidesOrganizer from './components/SlidesOrganizer'
import Studio from './components/Studio'
import TalkText from './components/TalkText'
import Importer from './components/Importer'
import Toasts from './components/Toasts'
import { ToolsRail } from './components/ToolsRail'
import { ToolsPalette } from './components/ToolsPalette'
import { useToolsActions } from './lib/toolsActions'
import { PublishedPagesView } from './components/PublishedPagesView'
import { WorkFilesView } from './components/WorkFilesView'
import { RunsView } from './components/RunsView'
import { RESPONSES_SEEN_EVENT } from './components/RunAnswers'
import { canonicalToolsView, isToolsView, type CanonicalToolsView, type ToolsRunRef, type ToolsView } from '../../shared/tools-views'
import { runsWithResponses } from '../../shared/sessions-list'
import ConflictCompare from './components/ConflictCompare'
import { CONFLICT_COMPARE_EVENT } from './components/talklist/ConflictLine'
import { VaultSheet, type VaultSheetState } from './components/talklist/VaultSheet'
import { notify } from './lib/notify'

/** Settings is its own window (0.42); main opens it, at `section` when one is named. */
function openSettingsWindow(section?: string): void {
  void window.tw.settingsWindow?.open(section).catch(() => { /* main not answering: nothing to show */ })
}
import GuidePane from './components/GuidePane'
import { AgentSkillStep } from './components/AgentSkillOffer'
import RemoveExampleConfirm from './components/RemoveExampleConfirm'
import { EXAMPLE_REMOVAL_TEXT, type ExampleRemovalPreview } from '../../shared/example-vault-removal'
import { commandRan, onCommandTicked } from './commands/command-ran'
import { liveShortcutLabel } from './keymap/store'
import { CHAPTER_TALK, chapterOfCommand, deriveChapters } from '../../shared/guide-chapters'
import { emptyGuideLearn, guideLearnFrom, type GuideLearn } from '../../shared/guide-learn'
import type { TopicTarget } from '../../shared/guide-topics'
import type { ConnectionActionId, ConnectionRow } from '../../shared/guide-connections'
import type { TaskGroup } from '../../shared/task-groups'
import { rowChords, shortChord, type PracticeState } from './components/GuideChapters'
import { GUIDE_DEFAULT_SEGMENT, GUIDE_TEXT, EMPTY_GUIDE_PROGRESS, firstSteps, type FirstStepId, type GuideProgress, type GuideSegment } from '../../shared/guide'
import type { OpenInNewWindowTarget } from '../../shared/open-in-new-window'
import { encodeFocus } from './components/talklist/vaultSections'
import { editWindowTitle } from '../../shared/talk-title-text.ts'
import { armOutlineSwitch, consumeEditorEngagement } from './lib/outlineSwitch'
import { effectiveKeys, eventToCMKey, KEYMAP_CHANGED_EVENT, startKeymapSync } from './keymap/store'

// The flat "Outline" view was retired: every slide already lives in the file, and the Slides
// view (now labelled "Slide outline") is the structure people actually want. Two sidebar tabs.
type SidebarMode = 'talks' | 'slides'
type SidebarCommandId = 'sidebar.talks' | 'sidebar.outline' | 'sidebar.toggle'

const SIDEBAR_STORAGE_KEY = 'tw-sidebar'
const SIDEBAR_DEFAULT = 220
// R17: below this window width the left sidebar collapses to its rail so the content keeps its room; the sidebar is never more than this share of the window.
const SIDEBAR_COLLAPSE_BELOW_PX = NARROW_WINDOW_PX
const SIDEBAR_MAX_SHARE_VW = 28
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
// The ten chapters, derived once from the registries (src/shared/guide-chapters.ts).
const GUIDE_CHAPTERS = deriveChapters()

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
  return isToolsView(view) ? view : null
}

/**
 * Runs with responses waiting, for the Sessions rail badge (2026-10-19 prework-responses, decision 12). Read
 * from the Sessions list main already builds (the live service's count is the work timer's): on opening, when
 * the window comes to the front, when main says talk facts changed, and when the view or Run on show changes.
 */
function useRunsWithResponses(again: unknown): number {
  const [count, setCount] = useState(0)
  useEffect(() => {
    let alive = true
    const load = (): void => { void window.tw.sessions.list().then((result) => { if (alive) setCount(runsWithResponses(result.runs)) }, () => {}) }
    load()
    window.addEventListener('focus', load)
    window.addEventListener(RESPONSES_SEEN_EVENT, load)
    const off = window.tw.vault.onTalkMetaUpdated(load)
    return () => { alive = false; window.removeEventListener('focus', load); window.removeEventListener(RESPONSES_SEEN_EVENT, load); off() }
  }, [again])
  return count
}

function ToolsShell({ initialView }: { initialView: ToolsView }): JSX.Element {
  // History and Sessions are the one Runs view (house rule R5): the old names are folded into it.
  const [view, setView] = useState<CanonicalToolsView>(canonicalToolsView(initialView))
  const [sessionsRun, setSessionsRun] = useState<ToolsRunRef | null>(null)
  const runsWithResponsesNow = useRunsWithResponses(`${view}|${sessionsRun ? `${sessionsRun.vaultId ?? ''}|${sessionsRun.talkSlug}/${sessionsRun.runId}` : ''}`)
  const [studioVideoRequest,setStudioVideoRequest]=useState<number|null>(null)
  const studioVideoSerial=useRef(0)
  const videoRegistered=useCallback(()=>setStudioVideoRequest(null),[])
  useEffect(()=>{if(view!=='studio')setStudioVideoRequest(null)},[view])
  const [studioInitialSessionId, setStudioInitialSessionId] = useState<string | null>(null)
  const [talkTextSessionId, setTalkTextSessionId] = useState<string | null>(null)
  // Plan a Run: the Runs view hosts the one sheet. A command from any view switches to Runs and leaves the request
  // there until the view has opened the sheet (the Runs view may not be mounted yet).
  const [planPending, setPlanPending] = useState(false)
  const planHandled = useCallback(() => setPlanPending(false), [])
  // Asked to show one work file (the Run page's Open file): the Work files view selects it.
  const [workFileRequest, setWorkFileRequest] = useState<{ fileName: string; vaultId: string; nonce: number } | null>(null)
  // Asked to open a Run's results ('results:<talk slug>/<run id>'; the Run page's Open results): the ledger scrolls into view.
  const [resultsNonce, setResultsNonce] = useState(0)

  const showStudio = useCallback((sessionId?: string): void => {
    setStudioInitialSessionId(sessionId ?? null)
    setView('studio')
  }, [])

  const showTalkText = useCallback((sessionId: string): void => {
    setTalkTextSessionId(sessionId)
    setView('talktext')
  }, [])

  /** The Runs view, on a Run when one is named. */
  const showRuns = useCallback((target: ToolsRunRef | null): void => {
    setSessionsRun(target)
    setView('runs')
  }, [])

  useEffect(() => {
    document.title = view === 'studio'
      ? 'TalkWeaver Studio'
      : view === 'importer'
        ? 'TalkWeaver Importer'
        : view === 'talktext'
          ? 'TalkWeaver — Manage notes'
          : 'TalkWeaver Tools'
  }, [view])

  useEffect(() => {
    return window.tw.tools.onShow(({ view: requested, sessionId, run, command }) => {
      if (!isToolsView(requested)) return
      const nextView = canonicalToolsView(requested)
      if (nextView === 'runs') {
        showRuns(run ?? null)
        if (sessionId === 'plan-run') setPlanPending(true)
        else if (sessionId?.startsWith('results:')) setResultsNonce((n) => n + 1)
      } else if (nextView === 'published' || nextView === 'workfiles') {
        setSessionsRun(null)
        setView(nextView)
      }
      else if (nextView === 'studio') { showStudio(sessionId); setStudioVideoRequest(command?++studioVideoSerial.current:null) }
      else if (nextView === 'importer') setView('importer')
      else if (nextView === 'talktext') {
        if (sessionId) showTalkText(sessionId)
        else {
          setTalkTextSessionId(null)
          setView('talktext')
        }
      }

    })
  }, [showRuns, showStudio, showTalkText])

  const shown: CanonicalToolsView = view

  // The Tools commands the window itself carries out (work-files ticket 30): the views and Plan a Run. The old
  // History and Sessions commands (`tools-view-sessions`) are aliases of the Runs one. The Run page's, Published
  // pages' and Work files' own commands are offered by those views.
  const planRun = (): void => { setView('runs'); setPlanPending(true) }
  const showRail = (next: CanonicalToolsView): void => {
    if (next === shown) return
    if (next === 'studio') showStudio()
    else { setSessionsRun(null); setView(next) }
  }
  useToolsActions({
    // ⌘1 to ⌘3 (ToolsPalette): the views in rail order; these two have no palette command of their own.
    'tools-view-studio': { enabled: true, run: () => showRail('studio') },
    'tools-view-importer': { enabled: true, run: () => showRail('importer') },
    'tools-view-runs': { enabled: true, run: () => showRail('runs') },
    'tools-view-sessions': { enabled: true, run: () => showRail('runs') },
    'tools-view-published': { enabled: true, run: () => showRail('published') },
    'tools-view-workfiles': { enabled: true, run: () => showRail('workfiles') },
    'tools-plan-run': { enabled: true, run: planRun }
  })
  // The palette and the keys belong to the window with the rail (Notes and script has its own).
  const toolsKeysOn = (shown === 'studio' || shown === 'runs' || shown === 'importer' || shown === 'published' || shown === 'workfiles')

  if (view === 'talktext') {
    return <TalkText isOpen sessionId={talkTextSessionId} onBackToStudio={showStudio} onClose={() => window.close()} />
  }

  // Studio and the Runs view say why an upload did not go through as a notification with its one action
  // ("Set up recording storage"), so this window shows the notification stack too.
  const body = shown === 'studio' ? (
    <Studio
      isOpen
      onClose={() => window.close()}
      initialSessionId={studioInitialSessionId}
      videoRequest={studioVideoRequest}
      onVideoRequestRegistered={videoRegistered}
      onOpenTalkText={showTalkText}
    />
  ) : shown === 'importer' ? (
    <Importer isOpen onClose={() => window.close()} />
  ) : shown === 'runs' ? (
    <RunsView
      run={sessionsRun}
      onSelect={setSessionsRun}
      planPending={planPending}
      onPlanHandled={planHandled}
      resultsRequest={resultsNonce}
      onOpenStudio={showStudio}
      onOpenNotes={showTalkText}
      onShowWorkFile={(fileName, vaultId) => { setWorkFileRequest((r) => ({ fileName, vaultId, nonce: (r?.nonce ?? 0) + 1 })); setSessionsRun(null); setView('workfiles') }}
    />
  ) : shown === 'workfiles' ? (
    <WorkFilesView request={workFileRequest} onOpenRun={(talkSlug, runId, vaultId) => showRuns({ talkSlug, runId, vaultId })} />
  ) : (
    <PublishedPagesView onOpenRun={(talkSlug, runId, vaultId) => showRuns({ talkSlug, runId, vaultId })} />
  )
  return (<>
    <div className="lt tw-tools-shell">
      <ToolsRail view={shown} onSelect={showRail} badges={{ runs: runsWithResponsesNow }} />
      <div className="tw-tools-main">{body}</div>
    </div>
    <ToolsPalette active={toolsKeysOn} />
    <Toasts />
  </>)
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
  // Whether the example vault is in the list (onboarding ticket 06): read by Add vault…, which is
  // also reached from listeners set up once.
  const exampleListedRef = useRef(false)
  // "Get started: show the example vault again" (ticket 12) reaches the restore through this ref.
  const restoreExampleRef = useRef<(() => Promise<void>) | null>(null)
  useEffect(() => {
    const restoreRequest = (): void => { void restoreExampleRef.current?.() }
    window.addEventListener('tw-restore-example', restoreRequest)
    return () => window.removeEventListener('tw-restore-example', restoreRequest)
  }, [])
  // The Guide (onboarding ticket 07). Per window and in no vault: whether its tab is up, which segment
  // it shows, and a counter that tells the column to bring itself up on each request. The Settings
  // switch and the progress are app-wide, kept in app config, and heard from every window.
  const [guideOpen, setGuideOpen] = useState(false)
  const [guideNonce, setGuideNonce] = useState(0)
  const [guideSegment, setGuideSegment] = useState<GuideSegment>(GUIDE_DEFAULT_SEGMENT)
  const [guideButtonOn, setGuideButtonOn] = useState(true)
  const [guideProgress, setGuideProgress] = useState<GuideProgress>(EMPTY_GUIDE_PROGRESS)
  const guideButtonOnRef = useRef(true)
  guideButtonOnRef.current = guideButtonOn
  const openGuide = useCallback((): void => { setGuideOpen(true); setGuideNonce((n) => n + 1) }, [])
  useEffect(() => {
    let cancelled = false
    window.tw.settings.getGuideButton().then((s) => { if (!cancelled) setGuideButtonOn(s.visible) }).catch(() => { /* keep the default */ })
    window.tw.guide.getProgress().then((p) => { if (!cancelled) setGuideProgress(p) }).catch(() => { /* keep the default */ })
    // The switch turned off, here or in another window, removes the button and the tab.
    const offSwitch = window.tw.settings.onGuideButtonChanged((s) => { setGuideButtonOn(s.visible); if (!s.visible) setGuideOpen(false) })
    const offProgress = window.tw.guide.onProgressChanged(setGuideProgress)
    // The presenter's "All chapters": the Guide opens on the chapter list (Commands segment, no chapter open).
    const offChapterList = window.tw.guide.onShowChapterList(() => { setGuideSegment('commands'); setGuideChapter(null); openGuide() })
    // Palette: "Get started: open the Guide" works with the button off (this session only);
    // "Get started: show the Guide button" turns the switch back on.
    const openRequest = (): void => openGuide()
    const showButton = (): void => {
      void window.tw.settings.setGuideButtonVisible(true).then(() => notify(GUIDE_TEXT.onFlash, 'info'))
    }
    window.addEventListener('tw-guide-open', openRequest)
    window.addEventListener('tw-guide-show-button', showButton)
    return () => {
      cancelled = true
      offSwitch(); offProgress(); offChapterList()
      window.removeEventListener('tw-guide-open', openRequest)
      window.removeEventListener('tw-guide-show-button', showButton)
    }
  }, [openGuide])
  // Learn the commands (ticket 08): the chapters are derived from the registries once; the record of what
  // has been tried is app-wide, kept by main and heard from every window. The open chapter and the row
  // that has just ticked are this window's own.
  const [guideLearn, setGuideLearn] = useState<GuideLearn>(emptyGuideLearn)
  const [guideChapter, setGuideChapter] = useState<TaskGroup | null>(null)
  const [flashRow, setFlashRow] = useState<string | null>(null)
  const guideOpenRef = useRef(false)
  guideOpenRef.current = guideOpen
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    window.tw.guide.getLearn().then((record) => { if (!cancelled) setGuideLearn(guideLearnFrom(record)) }).catch(() => { /* keep the empty record */ })
    const offLearn = window.tw.guide.onLearnChanged((record) => setGuideLearn(guideLearnFrom(record)))
    // A row that ticks in this window flashes, and a toast says which: only while the Guide is up.
    const offTick = onCommandTicked((id) => {
      const chapter = chapterOfCommand(GUIDE_CHAPTERS, id)
      const row = chapter?.rows.find((candidate) => candidate.ids.includes(id))
      if (!chapter || !row || !guideOpenRef.current) return
      setFlashRow(row.id)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setFlashRow(null), 1600)
      const chord = rowChords(row, liveShortcutLabel)[0]
      notify(`${GUIDE_TEXT.chapters.ticked} · ${row.label}${chord ? ` ${shortChord(chord)}` : ''}`, 'success', 'guide-tick')
    })
    return () => { cancelled = true; offLearn(); offTick(); if (timer) clearTimeout(timer) }
  }, [])
  // How it works (ticket 11): the open topic is this window's own; opening one marks it Read (kept by main,
  // app-wide). A Features row reads Read when clicked. What it connects to is read from this Mac by main.
  const [guideTopic, setGuideTopic] = useState<string | null>(null)
  const openGuideTopic = useCallback((id: string): void => {
    setGuideTopic(id)
    void window.tw.guide.topicRead(id).catch(() => { /* not recorded */ })
  }, [])
  const markFeatureRead = useCallback((id: string): void => { void window.tw.guide.topicRead(id).catch(() => { /* not recorded */ }) }, [])
  const readConnections = useCallback((): Promise<ConnectionRow[]> => window.tw.guide.connections(), [])
  const runConnectionAction = useCallback((action: ConnectionActionId): void => {
    if (action === 'open-settings') window.dispatchEvent(new Event('tw-open-settings'))
    // Settings, scrolled to its Cloudflare section (the same route as a publish sheet's Open Settings).
    else if (action === 'open-cloudflare') openSettingsWindow('cloudflare')
    else if (action === 'get-slidewell') void window.tw.guide.openLink('slidewell-download').catch(() => undefined)
  }, [])
  const selectGuideChapter = useCallback((task: TaskGroup): void => {
    setGuideChapter(task)
    void window.tw.guide.chapterOpened(task).catch(() => { /* not recorded */ })
  }, [])
  // The third first step ticks when a talk of the example vault is open in any window.
  useEffect(() => {
    if (state.phase !== 'ready' || !activeTalk || guideProgress.exampleTalkOpened) return
    if (vaultOfTalk(activeTalk, state.vaults)?.example === true) void window.tw.guide.noteExampleTalkOpened().then(setGuideProgress).catch(() => { /* not recorded */ })
  }, [state, activeTalk, guideProgress.exampleTalkOpened])
  // Remove the example vault and bring it back (onboarding ticket 12). `exampleRemoved` is main's answer
  // (removed, and not in the list now), heard from every window; the confirmation is this window's own.
  const [exampleRemoved, setExampleRemoved] = useState(false)
  const [removeConfirm, setRemoveConfirm] = useState<{ preview: ExampleRemovalPreview | null; busy: boolean; error: string | null } | null>(null)
  const openRemoveConfirm = useCallback((): void => {
    setRemoveConfirm({ preview: null, busy: false, error: null })
    void window.tw.vault.exampleRemovalPreview()
      .then((preview) => setRemoveConfirm((current) => (current ? { ...current, preview } : current)))
      .catch(() => setRemoveConfirm(null))
  }, [])
  const confirmRemoveExample = useCallback((token: string): void => {
    setRemoveConfirm((current) => (current ? { ...current, busy: true, error: null } : current))
    void window.tw.vault.removeExample(token).then(async (result) => {
      if (result.ok) { setRemoveConfirm(null); return }
      // The token is used up: a fresh look, with the sentence that says why nothing was removed.
      const preview = await window.tw.vault.exampleRemovalPreview().catch(() => null)
      setRemoveConfirm((current) => (current ? { preview, busy: false, error: result.message } : current))
    }).catch(() => setRemoveConfirm(null))
  }, [])
  useEffect(() => {
    let cancelled = false
    window.tw.vault.exampleState?.().then((s) => { if (!cancelled) setExampleRemoved(s.removed) }).catch(() => { /* keep the default */ })
    const offChanged = window.tw.vault.onExampleChanged?.((event) => {
      setExampleRemoved(event.removed)
      if (event.moved) notify(EXAMPLE_REMOVAL_TEXT.removedFlash, 'success')
    })
    const removeRequest = (): void => openRemoveConfirm()
    window.addEventListener('tw-remove-example', removeRequest)
    return () => { cancelled = true; offChanged?.(); window.removeEventListener('tw-remove-example', removeRequest) }
  }, [openRemoveConfirm])
  const [sidebarWidth, setSidebarWidth] = useState<number>(readSidebarWidth)
  const draggingRef = useRef(false)
  // Every launch opens on the Talks list, expanded — never restored into Slide-outline mode or
  // collapsed. Talks is the orientation point when reopening; the persisted value is deliberately
  // ignored at startup (both stay switchable within the session, and the effects below still record
  // the live state for anything else that reads it).
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>('talks')
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(false)
  // R17: a narrow window gives the content its room by collapsing this sidebar to its rail.
  useEffect(() => {
    // Collapse once, on crossing into the narrow range; inside it the person's last choice stands (a height-only resize changes nothing).
    let wasNarrow = false
    const collapseWhenNarrow = (): void => {
      const narrow = window.innerWidth < SIDEBAR_COLLAPSE_BELOW_PX
      if (narrow && !wasNarrow) setSidebarCollapsed(true)
      wasNarrow = narrow
    }
    collapseWhenNarrow()
    window.addEventListener('resize', collapseWhenNarrow)
    return () => window.removeEventListener('resize', collapseWhenNarrow)
  }, [])
  const sidebarShowsTalksRef = useRef(true)
  sidebarShowsTalksRef.current = sidebarMode === 'talks' && !sidebarCollapsed
  // The current talk's outline, mirrored up from WorkspaceLayout so the Slide-outline
  // sidebar view renders the live structure; jumpRef jumps the editor + strip to a line.
  const [outlineContent, setOutlineContent] = useState('')
  // The source line of the slide the editor cursor is in, mirrored up from WorkspaceLayout so the
  // Slide-outline sidebar can follow the cursor (highlight + scroll the current slide into view).
  const [activeOutlineLine, setActiveOutlineLine] = useState<number | null>(null)
  const [researchJump, setResearchJump] = useState<{ file: string; line: number; nonce: number } | null>(null)
  const jumpRef = useRef<((line: number, opts?: { takeFocus?: boolean }) => void) | null>(null)
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
      prev && prev.move === ops.move && prev.reLevel === ops.reLevel && prev.moveTo === ops.moveTo &&
        prev.moveToEnd === ops.moveToEnd && prev.moveInto === ops.moveInto && prev.slides === ops.slides
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
  const [galleryOpen, setGalleryOpen] = useState(false)
  const leaveGuardRef = useRef<(() => Promise<boolean>) | null>(null)
  const activeTalkRef = useRef<TalkInfo | null>(activeTalk)
  useEffect(() => { activeTalkRef.current = activeTalk }, [activeTalk])
  // A talk's details live in the Talk tab of the right sidebar (house rule R11); the Talks list's Metadata… opens the
  // talk (any talk) and then the tab, through the same tw-open-metadata event the Talk menu uses. The tab's writes go
  // through the open talk's editor buffer (talk-writer.ts, the D1 seam), as the Metadata dialog's did.
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
    document.title = editWindowTitle(activeTalk?.title)
  }, [activeTalk])
  /** True when the window switched to `talk`; false when the switch was held (Stay here, or another window has it). */
  const selectTalk = useCallback(async (talk: TalkInfo | null, gallery?: GalleryOpenGuard<TalkInfo> | string): Promise<boolean> => {
    if (typeof gallery === 'string') {
      if (!talk) return false
      return new Promise<boolean>(done => window.dispatchEvent(new CustomEvent('tw-preserve-moved-editor', {detail:{from:gallery,done,adopt:(isCurrent:()=>boolean)=>adoptMovedTalk<TalkInfo>(talk, gallery, {current:()=>activeTalkRef.current,confirm:async(from,to)=>window.tw.windows.adoptMovedTalk(from,to),adopt:next=>flushSync(()=>setActiveTalk(next)),isCurrent})}})))
    }
    const previous = activeTalkRef.current
    if (previous) {
      const recovered = await window.tw.windows.recoverMovedTalk(previous.outlinePath)
      if (recovered.kind === 'revoked' && !recovered.retired) {
        window.dispatchEvent(new CustomEvent("tw-retire-moved-editor", {detail:{from:previous.outlinePath}}))
        return false
      }
      if (recovered.kind === 'recoverable' && recovered.talk.outlinePath !== previous.outlinePath) {
        return new Promise<boolean>(done => window.dispatchEvent(new CustomEvent('tw-preserve-moved-editor', {detail:{from:previous.outlinePath,done,adopt:(isCurrent:()=>boolean)=>adoptMovedTalk<TalkInfo>(recovered.talk, previous.outlinePath, {current:()=>activeTalkRef.current,confirm:async(from,to)=>window.tw.windows.adoptMovedTalk(from,to),adopt:next=>flushSync(()=>setActiveTalk(next)),isCurrent})}})))
      }
    }
    return selectGuardedTalk<TalkInfo>(talk, {
      isCurrent: gallery?.isCurrent,
      revalidate: gallery?.revalidate,
      current: () => activeTalkRef.current,
      leave: async () => { const guard = leaveGuardRef.current; return guard ? await guard() : (await flushSaveRef.current?.(), true) },
      settle: gallery?.settle,
      claim: async path => gallery ? gallery.claim(path) : window.tw.windows?.claimTalk?.(path),
      adopt: setActiveTalk,
      refused: target => notify(`“${target.title}” is already open in another window — brought it to the front.`, 'info')
    })
  }, [])

  useEffect(() => {
    const open = (event: Event): void => {
      const talk = (event as CustomEvent<TalkInfo>).detail
      void selectTalk(talk).then(ok => {
        if (ok) requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('tw-show-pathways', { detail: talk.outlinePath })))
      })
    }
    window.addEventListener('tw-open-pathways', open)
    return () => window.removeEventListener('tw-open-pathways', open)
  }, [selectTalk])

  // T29b (2026-09-19): opening a talk from the Talks panel leaves the sidebar on Talks — the user
  // scrolls the editor to see if it is the right file — and the FIRST engagement with the editor
  // (pointerdown inside it, or the first document-changing keydown) then switches the sidebar to
  // the Slide outline, once per opened talk. Armed ONLY in this panel wrapper: the shared
  // selectTalk above serves every open route (launch restore, deep links, History/Studio, ⌘N
  // windows, new-talk creation) and none of those may arm. Keyed by outlinePath, so an arm goes
  // stale (and is dropped) if a non-panel route changes the active talk before engagement.
  const outlineSwitchArmedRef = useRef<string | null>(null)
  const selectTalkFromPanel = useCallback((talk: TalkInfo | null, movedFrom?: string) => {
    outlineSwitchArmedRef.current = armOutlineSwitch(talk?.outlinePath ?? null)
    return selectTalk(talk, movedFrom)
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
      if (isWorkspaceCovered()) return
      const cmKey = eventToCMKey(e)
      const matched = SIDEBAR_COMMAND_IDS.find((id) => sidebarKeysRef.current[id] === cmKey)
      if (matched === 'sidebar.talks') {
        e.preventDefault()
        focusSidebarSearch('talks')
        commandRan('app.sidebar-talks')
        return
      }
      if (matched === 'sidebar.outline') {
        e.preventDefault()
        focusSidebarSearch('slides')
        commandRan('app.sidebar-outline')
        return
      }
      if (matched === 'sidebar.toggle' || ((e.metaKey || e.ctrlKey) && e.key === '\\')) {
        e.preventDefault()
        toggleSidebar(sidebarMode)
        commandRan('app.sidebar-toggle')
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault()
        e.stopPropagation()
        openSettingsWindow()
        commandRan('app.settings')
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
    const openGallery = (): void => setGalleryOpen(true)
    const openSettings = (): void => openSettingsWindow()
    const openStudio = (event: Event): void => {
      const detail = (event as CustomEvent<{ sessionId?: string }>).detail
      void window.tw.tools.open('studio', detail?.sessionId)
    }
    const openHistory = (): void => {
      void window.tw.tools.open('runs')
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
    window.addEventListener('tw-vault-gallery', openGallery)
    window.addEventListener('tw-open-settings', openSettings)
    // "Open Settings" on a publish sheet or notice (any window): Settings, at its Cloudflare section.
    const stopShowCloudflare = window.tw.cloudflare.onShowSettings(() => openSettingsWindow('cloudflare'))
    // The live service is being set up or updated before a use (spec D9: the person is told). One toast, replaced by the next.
    const stopLiveNotice = window.tw.liveService.onNotice((message) => notify(message, 'info', 'live-service-notice'))
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
    return () => {
      window.removeEventListener('tw-vault-gallery', openGallery)
      window.removeEventListener('tw-open-settings', openSettings)
      stopShowCloudflare()
      stopLiveNotice()
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

  // "+ Add vault…" (onboarding ticket 06): while the example vault is not in the list, the Add vault
  // sheet offers a folder or the example vault; otherwise the folder picker opens at once, as before.
  async function addVault(): Promise<void> {
    if (!exampleListedRef.current) { setVaultSheet({ mode: 'add' }); return }
    await pickVaultFolder()
  }
  // Open example vault (onboarding ticket 06): main writes it (or finds it) at its fixed path and adds
  // it to the list; the start talk opens once the list holds it. Resolves with the one sentence to
  // show when nothing was opened, else null. Never a dialog.
  async function openExampleVault(): Promise<string | null> {
    const wasListed = exampleListedRef.current
    const result = await window.tw.vault.openExample()
    if (!result.ok) return result.message
    // Opening the example vault for the first time opens the Guide, unless the person has removed its button.
    if (!wasListed && guideButtonOnRef.current) openGuide()
    if (result.startTalk) {
      openRequestAtRef.current = Date.now()
      setOpenRequest({ kind: 'talk', outlinePath: result.startTalk })
    }
    await loadVaults({ force: true })
    return null
  }
  // Bring the example vault back (ticket 12; lock decision 17): a fresh copy (or the marked folder
  // already there), the vault back in the list, and the Guide with its earlier ticks and read marks.
  async function restoreExampleVault(): Promise<void> {
    const result = await window.tw.vault.restoreExample()
    if (!result.ok) { notify(result.message, 'info'); return }
    await loadVaults({ force: true })
    openGuide()
  }
  restoreExampleRef.current = restoreExampleVault
  const addVaultRef = useRef(addVault)
  addVaultRef.current = addVault
  // The Settings window's Get started page asks this window to open the Guide, show the example
  // vault again or add a vault (0.42: Settings is its own window).
  useEffect(() => window.tw.app.onEditorAction?.((action) => {
    if (action === 'open-guide') openGuide()
    else if (action === 'restore-example') void restoreExampleRef.current?.()
    else if (action === 'add-vault') void addVaultRef.current()
  }), [openGuide])
  // The keymap's overrides come from the settings store (moved there once from localStorage).
  useEffect(() => startKeymapSync(), [])
  // Pick a folder (ticket 04). A folder with no vault file opens the New vault sheet, one with a
  // vault file the join sheet; a folder already open as a vault, or inside one, is refused in a small
  // sheet that names that vault.
  async function pickVaultFolder(): Promise<void> {
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

  // An install whose recordings took their keys from Bitwarden is told once to type them into
  // Settings. The main process answers once and never again, so it is asked only when the window
  // can show the answer: the notification stack is on screen once the app shell is.
  const shellReady = state.phase === 'ready'
  useEffect(() => {
    if (!shellReady) return
    void window.tw.recording.takeSetupNotice().then((notice) => {
      if (notice) notify(notice, 'warning', 'recording-keys-notice', { label: 'Open Settings', onAction: () => openSettingsWindow('accounts') })
    }).catch(() => {})
  }, [shellReady])

  if (state.phase === 'loading') {
    return (
      <div className="loading-screen">
        <div className="spinner" />
      </div>
    )
  }

  exampleListedRef.current = state.phase === 'ready' && state.vaults.some((v) => v.example === true)

  if (state.phase === 'setup') {
    return <VaultSetup onVaultChosen={handleVaultChosen} onOpenExample={openExampleVault} />
  }

  // The vault a talk is in decides which root the editor and panels work against; with no talk open, the
  // first open vault. A vault to create in (a New talk started from one section) is picked the same way.
  // A vault whose folder is not there (ticket 07) is skipped: nothing is created in it.
  const usableVault = (v: VaultView): boolean => v.open && !v.unavailable
  const firstUsableVault = state.vaults.find(usableVault) ?? null
  const firstOpenVault = firstUsableVault ?? state.vaults.find((v) => v.open) ?? state.vaults[0]
  const activeVault = vaultOfTalk(activeTalk, state.vaults) ?? firstOpenVault
  const newTalkVault = state.vaults.find((v) => v.id === newTalkVaultId && usableVault(v)) ?? firstUsableVault

  // The Guide's First steps: ticked from the vault list, the talks and the progress; each undone step's
  // button does the thing. "Make your first talk" goes to a vault of the person's own, never the example.
  // Once the example vault is removed, its step leaves First steps with it (ticket 12).
  const steps = firstSteps({ vaults: state.vaults, talks: state.talks, progress: guideProgress })
    .filter((step) => !(exampleRemoved && !state.vaults.some((v) => v.example) && step.id === 'example-talk'))
  const runGuideStep = (id: FirstStepId): void => {
    if (id === 'own-vault') { void addVault(); return }
    if (id === 'first-talk') {
      const own = state.vaults.find((v) => usableVault(v) && !v.example)
      if (!own) { void addVault(); return }
      setNewTalkVaultId(own.id); setNewTalkTopic('')
      return
    }
    void openExampleVault().then((message) => { if (message) notify(message, 'info') })
  }
  // A chapter's practice talk: where it is, and Open this talk, which opens it in its own window (or brings
  // that window forward) and never replaces the person's own talk (lock decision 10).
  const exampleVaultIds = new Set(state.vaults.filter((v) => v.example).map((v) => v.id))
  const exampleVault = state.vaults.find((v) => v.example) ?? null
  const practiceOf = (task: TaskGroup): PracticeState => {
    const [talk, section] = CHAPTER_TALK[task]
    const openNow = activeTalk !== null && activeTalk.title === talk && !!activeTalk.vaultId && exampleVaultIds.has(activeTalk.vaultId)
    return { talk, section, openNow }
  }
  const openExampleTalk = (title: string): void => {
    const talk = state.talks.find((t) => t.title === title && !!t.vaultId && exampleVaultIds.has(t.vaultId))
    if (!talk) { notify(GUIDE_TEXT.chapters.noExample, 'info'); return }
    void window.tw.windows.openInNewWindow({ kind: 'talk', outlinePath: talk.outlinePath })
      .then((res) => { if (!res?.ok) notify('Couldn’t open a new window.', 'error') })
      .catch(() => notify('Couldn’t open a new window.', 'error'))
  }
  const openPractice = (task: TaskGroup): void => openExampleTalk(CHAPTER_TALK[task][0])
  // Try it on a How it works topic: an example talk in its own window, or a command that needs no talk open.
  const runTopicTry = (target: TopicTarget): void => {
    if (target.kind === 'talk') { openExampleTalk(target.talk); return }
    window.dispatchEvent(new Event(target.id === 'settings' ? 'tw-open-settings' : target.id === 'history' ? 'tw-open-history' : 'tw-search-talks'))
  }
  const guideBody = (
    <GuidePane
      segment={guideSegment}
      onSegment={setGuideSegment}
      steps={steps}
      onStep={runGuideStep}
      chapters={{
        chapters: GUIDE_CHAPTERS, learn: guideLearn, selected: guideChapter, onSelect: selectGuideChapter, onBack: () => setGuideChapter(null),
        chordOf: liveShortcutLabel, practice: practiceOf, onOpenPractice: openPractice, flashId: flashRow
      }}
      onRemoveExample={exampleVault ? openRemoveConfirm : undefined}
      how={{ learn: guideLearn, openId: guideTopic, onOpen: openGuideTopic, onBack: () => setGuideTopic(null), onTry: runTopicTry }}
      features={{ learn: guideLearn, onRead: markFeatureRead, readConnections, onAction: runConnectionAction }}
    />
  )
  const guideButton = guideButtonOn ? { open: guideOpen, onToggle: () => { if (guideOpen) setGuideOpen(false); else openGuide() } } : null

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
      {galleryOpen && <VaultGallery revision={state.vaults} talkTitle={activeTalk?.title ?? null} onClose={() => setGalleryOpen(false)} onOpen={selectTalk} management={{talks:state.talks,vaults:state.vaults,foldersByVault:state.foldersByVault,activeTalk,
        leaveActive:async()=>{const guard=leaveGuardRef.current;if(guard)return guard();await flushSaveRef.current?.();return true},
        onRefresh:refreshTalks,onRecheck:()=>loadVaults({force:false}),onSelectTalk:selectTalk,
        onDeletedTalk:path=>{if(activeTalk?.outlinePath===path){setActiveTalk(null);void window.tw.windows?.claimTalk?.(null)}},
        onNewTalk:(topic,id)=>{setNewTalkVaultId(id);setNewTalkTopic(topic)},onAddVault:()=>void addVault(),
        onEditVault:id=>setVaultSheet({mode:'edit',vaultId:id}),onSetVaultOpen:setVaultOpen}} />}
      {sidebarCollapsed ? (
        <div className="sidebar-rail">
          <button
            className="icon-btn"
            onClick={() => setSidebarCollapsed(false)}
            title="Show sidebar (⌘\\)"
            aria-label="Show sidebar"
            data-sidebar-expand
          >
            ☰
          </button>
          <button className="icon-btn vault-gallery-entry" onClick={() => setGalleryOpen(true)} title="Vault Gallery" aria-label="Vault Gallery"><LayoutGrid size={15} aria-hidden /></button>
        </div>
      ) : (
        <div
          className="sidebar-wrap"
          data-sidebar
          style={{ width: `min(${sidebarWidth}px, ${SIDEBAR_MAX_SHARE_VW}vw)`, ['--sidebar-width' as string]: `min(${sidebarWidth}px, ${SIDEBAR_MAX_SHARE_VW}vw)` }}
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
            <button className="icon-btn vault-gallery-entry" onClick={() => setGalleryOpen(true)} title="Vault Gallery" aria-label="Vault Gallery"><LayoutGrid size={15} aria-hidden /></button>
            <button
              className="icon-btn"
              onClick={() => setSidebarCollapsed(true)}
              title="Hide sidebar (⌘\\)"
              aria-label="Hide sidebar"
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
              onOpenMetadata={(talk) => { void selectTalk(talk).then((opened) => { if (opened) window.setTimeout(() => window.dispatchEvent(new Event('tw-open-metadata')), 150) }) }}
              // Rename safety (ADR-0008): the panel awaits the editor's pending-autosave flush
              // BEFORE renaming the active talk's folder, so no late write recreates the old path.
              flushActive={async () => { await flushSaveRef.current?.() }}
              // …and the external-change guard's leave check before any move of the active talk.
              leaveActive={async () => { const guard = leaveGuardRef.current; if (guard) return guard(); await flushSaveRef.current?.(); return true }}
              initialFocusPath={talkFocusPathRef.current}
              focusRequest={folderRequest}
              onFocusPathChange={rememberTalkFocusPath}
              guideButton={guideButton}
            />
          )}
          {sidebarMode === 'slides' && (
            <div className="sidebar-nav-body">
              <SlidesOrganizer content={outlineContent} onJump={(line, opts) => jumpRef.current?.(line, opts)} ops={outlineOps} currentLine={activeOutlineLine} talkKey={activeTalk?.outlinePath ?? null} talkTitle={activeTalk?.title ?? null} />
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
        <ManagementLayer onDismiss={()=>setNewTalkTopic(null)}>
        <NewTalkDialog
          vaultRoot={newTalkVault.root}
          vaultId={newTalkVault.id}
          folders={state.foldersByVault[newTalkVault.id] ?? []}
          defaultTopic={newTalkTopic}
          onCreated={async (talk) => {
            setNewTalkTopic(null)
            await refreshTalks()
            if (await selectTalk(createdTalk(talk, newTalkVault.id))) setGalleryOpen(false)
          }}
          onClose={() => setNewTalkTopic(null)}
        />
        </ManagementLayer>
      )}
      {vaultSheet && (
        <ManagementLayer onDismiss={()=>setVaultSheet(null)}>
        <VaultSheet
          state={vaultSheet}
          onClose={() => setVaultSheet(null)}
          onDone={() => { void vaultSheetDone() }}
          onChooseAnother={() => { setVaultSheet(null); void pickVaultFolder() }}
          onShowVault={showVault}
          onOpenExample={async () => {
            const message = await openExampleVault()
            if (message === null) setVaultSheet(null)
            return message
          }}
        />
        </ManagementLayer>
      )}
      {newFolderOpen && (
        <PromptModal
          label="New folder"
          kind="folder"
          mode="new"
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
        researchJump={researchJump}
        onResearchJump={(use) => {
          const target = state.talks.find(talk => talk.outlinePath === use.file)
          if (!target) { notify('That slide is not in an open talk.', 'info'); return }
          void selectTalk(target).then(selected => { if (selected) setResearchJump({ file: use.file, line: use.slideLine, nonce: Date.now() }) })
        }}
        activeTalk={activeTalk}
        vaultRoot={activeVault.root}
        onOutlineChange={slidesOutlineVisible ? setOutlineContent : undefined}
        leftSidebarShown={!sidebarCollapsed}
        onNeedRoom={() => setSidebarCollapsed(true)}
        registerJump={(fn) => { jumpRef.current = fn }}
        registerOutlineOps={registerOutlineOps}
        onOpenSettings={() => openSettingsWindow()}
        onSelectTalk={selectTalk}
        onEditorEngaged={onEditorEngaged}
        registerFlushSave={(fn) => { flushSaveRef.current = fn }}
        onMetadataSaved={() => { void refreshTalks() }} // sidebar title/subtitle/event may have changed
        registerLeaveGuard={(fn) => { leaveGuardRef.current = fn }}
        onDiscardTalk={() => { void selectTalk(null) }}
        onActiveLineChange={slidesOutlineVisible ? setActiveOutlineLine : undefined}
        guide={{ open: guideOpen, nonce: guideNonce, body: guideBody, onClose: () => setGuideOpen(false) }}
      />
      {removeConfirm && (
        <RemoveExampleConfirm
          vault={exampleVault ?? { color: '#0f766e', initial: 'E', name: 'Example vault' }}
          preview={removeConfirm.preview}
          busy={removeConfirm.busy}
          error={removeConfirm.error}
          onCancel={() => setRemoveConfirm(null)}
          onConfirm={confirmRemoveExample}
        />
      )}
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
      <AgentSkillStep />
      <Toasts />
    </div>
  )
}
