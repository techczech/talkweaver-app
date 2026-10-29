import { projectGridMove } from '../../../shared/slide-handling/grid-move-projection'
import { runSetAside, type SetAsideHost } from '../lib/slideSetAside'
import { retainMatchingThumbnails } from '../../../shared/slide-preview'
import { insertResearchItem as insertResearchItemInEditor } from '../lib/research-insert'
import { plainInlineText } from '../../../../compiler/scripts/lib/00-inline-render.mjs'
import { runActionBarEditorCommand } from './actionBar/command-runner'
import { venueScreenLinkFromOutline } from '../../../shared/venue-screen-link'
import { useState, useEffect, useRef, useMemo, useCallback, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { TalkInfo, ProjectionRow, RecordingSession } from '../../../preload/index'
import { textFitNotesFor } from '../../../shared/text-fit-notes.ts'
import { computeSlideLines } from '../../../shared/slide-lines.ts'
import { marginLabels, MARGIN_LAYOUT_NAMES } from '../../../shared/plain-view-margin.ts'
import { levelMenuFor, setHeadingKind, type HeadingKind } from '../../../shared/heading-kind.ts'
import { dismissToast, notify } from '../lib/notify'
import Editor, { type HeadingTools, type ObjectInsertHandler, type PlainIconTools, type SlideBlockOps } from './Editor'
import MarginMenu, { MORE_IN_INSPECTOR_KEY } from './MarginMenu'
import { slideSelectionControls } from '../lib/slideSelectionBus'
import { rememberSlideClip } from '../extensions/slideBlockOps'
import SlideRowMenus, { writeSlideClipboard, type SlideMenuRequest } from './SlideRowMenus'
import { slideRows } from '../extensions/slideOutline'
import { pressAttachOnStrip } from '../extensions/workStrips'
import { moveSubject } from '../lib/moveDestinations'
import { publishSlideThumbs, searchSurface } from '../lib/slideSearch'
import { getStripNumbers, outlineNumbers, publishStripNumbers, stripNumbersToPublish, subscribeStripNumbers } from '../lib/stripNumbers'
import { getOutlineSelection } from '../lib/outlineSelection'
import SlideFocus from './SlideFocus'
import type { FocusRange } from '../extensions/focusScope'
import { focusRangeForSlideLine, firstFocusableFrom, nextFocusableSlide, readableSectionLabel } from './slideFocusModel'
import Inspector from './Inspector'
import { applyBoardEditToOutline, type BoardEdit } from '../../../../compiler/scripts/lib/board-slide.mjs'
import SlideStrip from './SlideStrip'
import RightColumnTabs from './RightColumnTabs'
import WhatsNewPane from './WhatsNewPane'
import { WHATS_NEW_OPEN_EVENT, openWhatsNewTab, runCheckForUpdates } from '../lib/updateNotices'
import type { RightColumnTab } from '../../../shared/guide'
import GridView from './GridView'
import StatusBar from './StatusBar'
import { usePlace } from '../lib/usePlace'
import { placeAt, type Place } from '../../../shared/place.ts'
import { actionRowsAt, paletteChordText, type ActionRow } from '../../../shared/actions-here.ts'
import ActionsHerePanel from './ActionsHerePanel'
import type { SheetRow } from '../../../shared/keyboard-sheet.ts'
import { useTalkFacts } from '../lib/talkFacts'
import LayoutPickerColumn from './LayoutPickerColumn'
import { reanchorPickerSlide, selectionFromTriggerLine, toggleLayoutSelection, type LayoutPickerContext } from './layoutPickerModel'
import { LayoutVerbError, chooseLayout, clearLayout, isQuoteSlide, previewLayout, setLayout, type QuoteFormChoice, type SlideRef } from '../../../shared/layout-verbs'
import { reportTriggerMergeWarnings } from '../../../shared/trigger-line'
import { readOutlineSlides } from '../../../shared/feedback-accept'
import { LAYOUTS, type LayoutDef, type OptionGroup } from '../data/layouts'
import SearchPalette from './SearchPalette'
import SlideBrowser from './SlideBrowser'
import PropagationChecklist, { type AdoptVersion } from './PropagationChecklist'
import MergeConfirm from './MergeConfirm'
import ShareSheet from './ShareSheet'
import PublishNotReadySheet from './PublishNotReadySheet'
import PublishWorkNoticeSheet from './PublishWorkNoticeSheet'
import { publishWorkNotice } from '../../../shared/publish-work-notice.ts'
import { readTalkWorkNames } from '../../../shared/work-files-view.ts'
import { earlierHandoutsToast, publishedWithoutLiveToast } from '../lib/publish-failure-toast'
import type { PublishNotReady } from '../../../preload/index'
import PlanRunSheet from './PlanRunSheet'
import CaptureResearchSheet from './CaptureResearchSheet'
import ResearchPanel, { type ResearchActions } from './ResearchPanel'
import ScratchpadPanel, { type ScratchpadActions } from './scratchpad/ScratchpadPanel'
import type { PlaceChoice, ScratchpadInsertApi } from './scratchpad/ScratchpadInsert'
import { runScratchInsert, type ScratchInsertHost } from '../lib/scratchpadInsert'
import { settlePlace, type ScratchPlace, type ScratchVisual } from '../../../shared/scratchpad-insert'
import { blockAt, copyBlocks, cutBlocks, moveBlocks, refAt, refHolds, stepPlace, type SlideRef as MoveRef } from '../../../shared/slide-handling/blocks'
import type { SlidePlace } from '../../../shared/slide-handling/place'
import type { ScratchItem } from '../../../shared/scratchpad'
import { useScratchpad } from '../lib/useScratchpad'
import { useScratchpadLayout } from '../lib/useScratchpadLayout'
import { type ResearchItem, type ResearchUse } from '../../../shared/research'
import RunStatusChips from './RunStatusChips'
import ConflictLine from './talklist/ConflictLine'
import { shareForTalk, useSharedTalks } from '../lib/sharedTalks'
import FeedbackRail, { type FeedbackFocus } from './FeedbackRail'
import { useFeedbackList, useFeedbackSummaries } from '../lib/feedback'
import { acceptProposal, DISK_CHANGED, undoAccepted, type FeedbackAcceptDeps } from '../lib/feedbackAccept'
import { slideMarkers } from '../../../shared/feedback-markers'
import { ENDED_LABEL, PAUSED_LABEL, type RailSlide } from '../../../shared/feedback'
import { sharedStatusLabel } from '../../../shared/shared-talk'
import TagPicker from './TagPicker'
import { stampedIdOf, type MergeRequest } from './slideBrowserModel'
import { tagsOfBlock } from '../../../shared/tags'
import ImageDrawer, { DropHint, IMAGE_DRAG_TYPE, OLD_SLIDE_DRAG_TYPE, OLD_SLIDE_DROP_EVENT } from './ImageDrawer'
import { insertSlideAfterCaret, OLD_SLIDE_REFUSED, oldSlideMarkdown } from '../../../shared/old-slide'
import type { ImageSearchHit } from '../../../shared/image-search'
import IconPicker from './IconPicker'
import { usePlainIconPicker } from './usePlainIconPicker'
import KeyboardHelp from './KeyboardHelp'
import ToolbarMenu, { Icon, type MenuItem } from './ToolbarMenu'
import { collapseAllSections, expandAllSections, publishOutline, revealLine } from '../lib/outlineCollapseStore'
import { activeHeadingLine, createActiveLineReporter, lineOfOffset, slideIndexAtLine } from '../lib/activeOutlineLine'
import ExplainPanel from './ExplainPanel'
import WhereUsedPanel from './WhereUsedPanel'
import EmbedCheckPanel from './EmbedCheckPanel'
import LayoutDoctorPanel from './LayoutDoctorPanel'
import { applyScannedTitleIconRestore } from '../../../shared/title-icon-restore'
import ResizablePanes from './ResizablePanes'
import ImageMetaPanel from './ImageMetaPanel'
import AbstractPanel from './AbstractPanel'
import DeckDesignPanel from './DeckDesignPanel'
import CommandMenu, { type Command } from './CommandMenu'
import {
  COMMAND_REGISTRY,
  paletteCommands,
  listedPaletteCommands,
  type CommandDefinition,
  toolbarCommands,
  type PaletteCommandHandlerId,
  type ToolbarMenuName
} from '../../../shared/command-registry'
import { componentInsertEntries } from '../../../shared/layout-registry/entries'
import { createHtmlPageInserter } from '../lib/insertHtmlPage'
import { openCaptureEmbed, planSavedViewRemoval } from '../lib/captureEmbed'
import { extractInspectorSlideBlock as captureEmbedSlideBlock } from './inspectorModel'
import { effectiveKeys, liveCommandShortcutLabel, liveShortcutLabel, onKeymapChanged } from '../keymap/store'
import { chordEventInit } from '../../../shared/chord-event'
import { shortcutById } from '../../../shared/shortcut-registry'
import { surfaceKey } from '../keymap/surfaceKeys'
import type { PickerCommandOutcome, SlidePickerCommands } from './slidePickerCommands'
import ActionBar from './actionBar/ActionBar'
import EditorTabs from './EditorTabs'
import { PLAIN_LOOK_DEFAULT, type PlainLook } from '../../../shared/plain-view-look'
import { EDITOR_VIEW_MODE_DEFAULT, type EditorViewMode } from '../../../shared/editor-view-mode'
import OutlineDiskChangeBar, { OutlineDiskChangeSheet } from './OutlineDiskChangeBar'
import { useOutlineDiskChange } from './useOutlineDiskChange'
import { noteOutlineSaveReply } from '../lib/outlineDiskChange'
import {
  DEFAULT_ACTION_BAR_ITEMS,
  resolveActionBarItems,
  type RunnableActionBarCommand
} from './actionBar/model'
import { actionBarItemsFrom } from '../../../shared/action-bar-settings'
import SlideContextMenu, { type SlideMenuAction } from './SlideContextMenu'
import { outlineWritesSettled, queueOutlineWrite } from '../lib/saveQueue'
import { OUTLINE_PAUSE_MS } from '../lib/pausedScan'
import { createOutlineMutator, type OutlineMutate, type OutlineMutationOptions, type OutlineMutationResult, type OutlineMutator } from '../lib/outlineMutation'
import { stampHandoutUrl } from '../../../shared/handout-stamp'
import { commandRan, ran, reportingHandlers, setCommandRanContext } from '../commands/command-ran'
import { editFrontmatterText, type FrontmatterEdit } from '../../../shared/frontmatter-editor'
import type { CursorListItemContext } from '../extensions/outliner'
import {
  headingLineForSlideId,
  inspectedSlideIdAfterCursorChange,
  migrateInspectorMode,
  migratePaneState,
  navigateInspectorSlide,
  resolveInspectedSlide,
  type PaneState
} from './inspectorModel'
import {
  attributeOrphanedTriggerFindings,
  scanOutlineTriggers,
  unresolvedTriggerBlock,
  type LayoutDoctorFinding
} from '../../../shared/layout-doctor'

// Handlers that report for themselves, because they can decline after they start (the slide picker's
// talk-search actions answer "nothing to act on"): runPickerCommand reports once the action acted.
const SELF_REPORTING_HANDLERS: ReadonlySet<string> = new Set(['add-talk-beside', 'talk-beside', 'close-talk-beside', 'select-whole-section'])

// The slide menu's actions that are registry commands (the menu now opens only from the triple-backtick
// Insert-object access; Actions here's carried rows reach the same handlers): the command each reports.
const SLIDE_MENU_COMMANDS: Readonly<Partial<Record<SlideMenuAction, string>>> = {
  layout: 'layout', icon: 'icon-picker', image: 'image', tag: 'tag-slide',
  'insert-table': 'insert-object-table', 'insert-mindmap': 'insert-object-mindmap', 'insert-chart': 'insert-object-chart',
  'insert-mermaid': 'insert-object-mermaid', 'insert-diagram': 'insert-object-diagram', 'insert-svg': 'insert-object-svg',
  'fmt-bold': 'format-bold', 'fmt-italic': 'format-italic', 'fmt-code': 'format-inline-code', 'fmt-highlight': 'format-highlight',
  'fmt-strikethrough': 'format-strikethrough', 'fmt-underline': 'format-underline', 'fmt-link': 'format-link',
  focus: 'focus-slide', 'where-used': 'where-used', 'present-here': 'present-from-here', delete: 'delete-slide'
}

export type OutlineOps = {
  move: (line: number, dir: 'up' | 'down') => void
  reLevel: (line: number, dir: -1 | 1, withSubtree: boolean) => void
  moveTo: (fromLine: number, toLine: number) => void
  /** Move the heading-block to the end of the talk (the organizer's drop zone after the last row). */
  moveToEnd: (fromLine: number) => void
  /** Move the heading-block into a section as its last slide (a drop on a collapsed section row). */
  moveInto: (fromLine: number, sectionLine: number) => void
  /** Whole slides and sections by heading line: cut, copy, paste, Move … to…, delete (Editor.tsx SlideBlockOps). */
  slides?: SlideBlockOps
}

// What a queued outline save answers (window.tw.talk.writeOutline).
type OutlineSaveResult = Awaited<ReturnType<typeof window.tw.talk.writeOutline>>

/** The Guide's hold on the right-hand column (onboarding ticket 07). App owns whether its tab is up; the
 *  column owns which tab is showing. `nonce` rises on every request to open it. */
export interface GuideColumn {
  open: boolean
  nonce: number
  /** The Guide itself (GuidePane): the column only hosts it. */
  body: React.ReactNode
  onClose: () => void
}

interface Props {
  researchJump?: { file: string; line: number; nonce: number } | null
  onResearchJump?: (use: ResearchUse) => void
  activeTalk: TalkInfo | null
  vaultRoot: string
  /** The Guide's hold on the right-hand column (onboarding ticket 07); absent = no Guide. */
  guide?: GuideColumn
  // Lets App's left sidebar (Outline / Slides views) mirror the live outline and jump the
  // editor + strip to a source line.
  onOutlineChange?: (content: string) => void
  registerJump?: (fn: (line: number, opts?: { takeFocus?: boolean }) => void) => void
  /** Open App's Settings panel (Tools → Settings in the toolbar). */
  onOpenSettings?: () => void
  /** Forwards the editor's line-targeted outline ops up to App (for the Slides organizer). */
  registerOutlineOps?: (ops: OutlineOps) => void
  /** Switch the active Talk (App owns activeTalk). Slide Focus uses it to open a DIFFERENT talk's
   *  slide picked in the Browser before scoping onto it. */
  onSelectTalk?: (talk: TalkInfo) => void
  /** T29b: editor engagement ping (first pointerdown in the editor / first user document change),
   *  fired by the Editor; App consumes it to switch the sidebar to the Slide outline once per
   *  opened talk. Pure pass-through. */
  onEditorEngaged?: () => void
  /** Hand App a "flush the current editor's pending edit" fn. App calls it BEFORE a genuine talk
   *  switch so a sub-1.5s edit made just before switching is persisted to the OUTGOING talk's file
   *  (data-loss guard, 2026-07-05). No-op when nothing is pending. */
  registerFlushSave?: (fn: () => Promise<void>) => void
  /** Hand App the outline external-change guard's leave check: App awaits it before a talk switch
   *  (it flushes pending typing, and holds the switch behind the sheet while the talk's file differs
   *  from the editor). Resolves false when the person chose Stay here. */
  registerLeaveGuard?: (fn: () => Promise<boolean>) => void
  /** The person discarded the open talk (removed on disk): App lets it go. */
  onDiscardTalk?: () => void
  /** The source line of the slide the editor cursor is now in, so App's Slide-outline sidebar can
   *  follow the cursor (highlight + scroll to the current slide). Fires only when the active slide
   *  changes, not on every keystroke. null = the cursor is above the first slide (cover/frontmatter). */
  onActiveLineChange?: (line: number | null) => void
}

// Grid view is a separate full-width view mode that replaces the normal panes with a
// real CSS grid of slide thumbnails. It is orthogonal to PaneState: switching to any
// pane-toggle (editor/both/strip) turns grid off; the Grid button turns it on.
const GRID_COLS_STORAGE_KEY = 'tw-grid-cols'
const GRID_COLS_DEFAULT = 3
const GRID_COLS_MIN = 1
const GRID_COLS_MAX = 6
const PANE_STATE_STORAGE_KEY = 'tw-pane-state'
const INSPECTOR_MODE_STORAGE_KEY = 'tw-inspector-mode'

function readPaneState(): PaneState {
  try { return migratePaneState(window.localStorage.getItem(PANE_STATE_STORAGE_KEY)) }
  catch { return 'both' }
}

function readInspectorMode(): boolean {
  try {
    return migrateInspectorMode(
      window.localStorage.getItem(PANE_STATE_STORAGE_KEY),
      window.localStorage.getItem(INSPECTOR_MODE_STORAGE_KEY)
    )
  } catch { return false }
}

function readGridColumns(): number {
  try {
    const raw = window.localStorage.getItem(GRID_COLS_STORAGE_KEY)
    if (raw === null) return GRID_COLS_DEFAULT
    const n = parseInt(raw, 10)
    return Number.isFinite(n) ? Math.min(GRID_COLS_MAX, Math.max(GRID_COLS_MIN, n)) : GRID_COLS_DEFAULT
  } catch {
    return GRID_COLS_DEFAULT
  }
}

export default function WorkspaceLayout({ researchJump, onResearchJump, activeTalk, vaultRoot, onOutlineChange, registerJump, onOpenSettings, registerOutlineOps, onSelectTalk, onEditorEngaged, registerFlushSave, registerLeaveGuard, onDiscardTalk, onActiveLineChange, guide }: Props) {
  const commandHandlersRef = useRef<Record<PaletteCommandHandlerId, () => void> | null>(null)
  const [, setKeymapRevision] = useState(0)
  useEffect(
    // Keep this subscription in the label-owning component: React.memo on a command child would
    // otherwise turn an incidental parent render into a latent stale-shortcut-label trap.
    () => onKeymapChanged(() => setKeymapRevision((revision) => revision + 1)),
    []
  )
  // ── Action bar (ADR-0025): one app-wide setting, on until explicitly switched off ────────────────────────
  // Loaded once here and then kept current by the main process's `action-bar:changed` broadcast, so
  // a toggle in one window's Settings redraws the bar in every open window without a restart. The
  // raw stored list rides the same state; only the default populates it today (configure sheet is
  // a later parcel), but a stored list is what the bar reads.
  const [actionBarVisible, setActionBarVisible] = useState(true)
  const [actionBarItemsStored, setActionBarItemsStored] = useState<unknown>(null)
  useEffect(() => {
    let cancelled = false
    window.tw.settings.getActionBar()
      .then((state) => {
        if (cancelled) return
        setActionBarVisible(state.visible)
        setActionBarItemsStored(state.items)
      })
      .catch(() => { /* settings unavailable — retain the visible default */ })
    return () => {
      cancelled = true
    }
  }, [])
  useEffect(() => window.tw.settings.onActionBarChanged((state) => {
    setActionBarVisible(state.visible)
    setActionBarItemsStored(state.items)
  }), [])
  // Plain / Markdown tab (plain editing view, spec T3): one per-user setting, Plain until chosen.
  const [editorViewMode, setEditorViewModeState] = useState<EditorViewMode>(EDITOR_VIEW_MODE_DEFAULT)
  useEffect(() => {
    let cancelled = false
    window.tw.settings.getEditorViewMode()
      .then((mode) => { if (!cancelled) setEditorViewModeState(mode) })
      .catch(() => { /* settings unavailable: keep Plain */ })
    return () => { cancelled = true }
  }, [])
  useEffect(() => window.tw.settings.onEditorViewModeChanged(setEditorViewModeState), [])
  const [plainLook, setPlainLook] = useState<PlainLook>(PLAIN_LOOK_DEFAULT)
  useEffect(() => {
    let cancelled = false
    window.tw.settings.getPlainLook()
      .then((look) => { if (!cancelled) setPlainLook(look) })
      .catch(() => { /* keep the default */ })
    const off = window.tw.settings.onPlainLookChanged(setPlainLook)
    return () => { cancelled = true; off() }
  }, [])
  const chooseEditorViewMode = (mode: EditorViewMode): void => {
    setEditorViewModeState(mode)
    window.tw.settings.setEditorViewMode(mode).catch(() => { /* not saved: the tab still switches */ })
  }
  // The place chip (onboarding ticket 02): the caret's place from the editor, combined with where
  // the keyboard is; the setting "Show where I am in the status bar" (on by default).
  const [editorPlace, setEditorPlace] = useState<Place>('slide-text')
  const { place, row: placeRow, activate: activatePlace } = usePlace(editorPlace)
  // The chip counts the list Actions here shows (shared/actions-here.ts), so the two always agree.
  const editorPlaceRef = useRef<Place>(editorPlace)
  editorPlaceRef.current = editorPlace
  const [placeChipVisible, setPlaceChipVisible] = useState(true)
  useEffect(() => {
    let cancelled = false
    window.tw.settings.getPlaceChip()
      .then((state) => { if (!cancelled) setPlaceChipVisible(state.visible) })
      .catch(() => { /* settings unavailable — keep the default */ })
    return () => { cancelled = true }
  }, [])
  useEffect(() => window.tw.settings.onPlaceChipChanged((state) => setPlaceChipVisible(state.visible)), [])
  const runRegisteredCommand = useCallback((handlerId: PaletteCommandHandlerId): void => {
    commandHandlersRef.current?.[handlerId]()
  }, [])
  // A palette row runs its handler; a command only a key reaches (the outline's move and jump keys,
  // the sidebar and find keys) is run by sending its effective key to the editor, as the presenter
  // palette does for its viaKey entries.
  const runListedCommand = useCallback((command: CommandDefinition): void => {
    const handler = commandHandlersRef.current?.[command.handlerId as PaletteCommandHandlerId]
    if (handler) { handler(); return }
    if (!command.shortcutId) return
    const code = shortcutById(command.shortcutId).codes[0]
    if (!code) return
    const keys = effectiveKeys(command.shortcutId) || code
    window.setTimeout(() => {
      const target = document.querySelector<HTMLElement>('.cm-content')
      target?.focus()
      ;(target ?? document.body).dispatchEvent(new KeyboardEvent('keydown', chordEventInit(keys)))
    }, 0)
  }, [])
  const [paneState, setPaneState] = useState<PaneState>(readPaneState)
  const [inspectorMode, setInspectorMode] = useState<boolean>(readInspectorMode)
  // Grid mode is a distinct full-width view; any pane-toggle click clears it.
  const [gridMode, setGridMode] = useState<boolean>(false)
  const [gridColumns, setGridColumns] = useState<number>(readGridColumns)
  // The Guide tab (onboarding ticket 07). Up while App says so; `guideActive` is whether it is the tab
  // showing (Slides and Inspector are the others). Each request to open it shows it and brings the
  // right-hand column up, as the Inspector's own toggle does.
  const [guideActive, setGuideActive] = useState<boolean>(false)
  const guideUp = guide?.open === true
  useEffect(() => {
    if (!guide || !guide.open || guide.nonce === 0) return
    setGuideActive(true)
    setWhatsNewActive(false)
    setGridMode(false)
    setPaneState((current) => (current === 'editor' ? 'both' : current))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guide?.nonce])
  useEffect(() => { if (!guideUp) setGuideActive(false) }, [guideUp])
  // The What's new tab (update notices, ADR-0041): opened only by the Updated mark or its command, never by itself.
  const [whatsNewUp, setWhatsNewUp] = useState<boolean>(false)
  const [whatsNewActive, setWhatsNewActive] = useState<boolean>(false)
  useEffect(() => {
    const open = (): void => {
      setWhatsNewUp(true); setWhatsNewActive(true); setGuideActive(false); setGridMode(false)
      setPaneState((current) => (current === 'editor' ? 'both' : current))
    }
    window.addEventListener(WHATS_NEW_OPEN_EVENT, open)
    return () => window.removeEventListener(WHATS_NEW_OPEN_EVENT, open)
  }, [])
  // The image drawer docked beside the panes (ticket 11). Not an overlay: the editor stays usable.
  const [imageDrawerOpen, setImageDrawerOpen] = useState<boolean>(false)
  const [imageDropping, setImageDropping] = useState<'picture' | 'slide' | null>(null)
  const [iconPickerOpen, setIconPickerOpen] = useState<boolean>(false)
  const [outlineContent, setOutlineContent] = useState<string>('')
  const [compiledSlides, setCompiledSlides] = useState<ProjectionRow[] | null>(null)
  const compiledSourceRef = useRef<string | null>(null)
  const [triggerFindings, setTriggerFindings] = useState<LayoutDoctorFinding[]>([])
  const [thumbnails, setThumbnails] = useState<Record<string, string> | null>(null)
  const [previewsPending, setPreviewsPending] = useState(false)
  const thumbnailRowsRef = useRef<ProjectionRow[] | null>(null)
  const [thumbnailRefresh, setThumbnailRefresh] = useState(0)
  const compileTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const compileImmediatelyRef = useRef(false)
  const compileAttemptedRef = useRef(false)

  const [buildStatus, setBuildStatus] = useState<'idle' | 'building' | 'done' | 'error'>('idle')
  const [buildPath, setBuildPath] = useState<string | null>(null)
  // Publishing is a long, opaque wrangler deploy (no streamed progress) — show a prominent
  // blocking overlay with an elapsed-seconds ticker so it never looks hung.
  const [publishing, setPublishing] = useState<boolean>(false)
  // Re-entry guard for Publish: a ref, so the command registry's (possibly older) closure sees it too.
  // Two overlapping publishes of one talk would race on its slide-assets/ folder.
  const publishingRef = useRef(false)
  // Share for comments (ticket 03): the sheet, and every shared talk (status bar chip).
  const [shareSheetOpen, setShareSheetOpen] = useState<boolean>(false)
  // Publish handout could not start: what is missing, for the sheet (spec: the "not ready" table).
  const [publishNotReady, setPublishNotReady] = useState<PublishNotReady | null>(null)
  // The plan sheet (ADR-0032 point 5): a new Run (run null) or editing a planned one.
  // Publish handout when the talk names work files: the notice that they go out with a Run (ticket 23).
  const [publishWorkNoticeText, setPublishWorkNoticeText] = useState<string | null>(null)
  const [planSheet, setPlanSheet] = useState<{ run: RecordingSession | null } | null>(null)
  // "Capture to research…": the sheet, with the editor's selection captured when it was asked for.
  const [researchPanelOpen, setResearchPanelOpen] = useState(false)
  const [researchPickerOpen, setResearchPickerOpen] = useState(false)
  const [researchRefresh, setResearchRefresh] = useState(0)
  const researchActionsRef = useRef<ResearchActions>({})
  const registerResearchActions = useCallback((actions: ResearchActions) => { researchActionsRef.current = actions }, [])
  const [captureSheet, setCaptureSheet] = useState<{ body: string; artefact?: string } | null>(null)
  // Slide Scratchpad (components/scratchpad/): the open talk's candidates, and where its panel sits.
  const scratchpad = useScratchpad(activeTalk?.outlinePath ?? null)
  const scratchpadLayout = useScratchpadLayout()
  const scratchpadActionsRef = useRef<ScratchpadActions>({})
  const registerScratchpadActions = useCallback((actions: ScratchpadActions) => { scratchpadActionsRef.current = actions }, [])
  // Inserting from the Slide Scratchpad (ticket 2): the place chosen by hand (Change place; null follows the cursor or
  // the slide selected in the grid), whether the caret stands in a slide's text (the note's "at the cursor"), and an
  // insert in progress (one at a time).
  const [scratchChosenPlace, setScratchChosenPlace] = useState<ScratchPlace | null>(null)
  const scratchChosenPlaceRef = useRef<ScratchPlace | null>(null)
  scratchChosenPlaceRef.current = scratchChosenPlace
  const [scratchCaretInBody, setScratchCaretInBody] = useState(false)
  const [scratchInserting, setScratchInserting] = useState(false)
  const scratchInsertingRef = useRef(false)
  /** The places a chosen place advanced from (settlePlace), so an Undo of the insert brings the earlier place back. */
  const scratchChosenEarlierRef = useRef<ScratchPlace[]>([])
  useEffect(() => { setScratchChosenPlace(null); scratchChosenEarlierRef.current = [] }, [activeTalk?.outlinePath])
  const [researchHighlight, setResearchHighlight] = useState<string | null>(null)
  const researchCaptureDropRef = useRef<{ body: string; artefact?: string } | null>(null)
  const sharedTalks = useSharedTalks()
  const [publishElapsed, setPublishElapsed] = useState<number>(0)
  const [wordCount, setWordCount] = useState<number>(0)
  const [lastSaved, setLastSaved] = useState<Date | null>(null)
  // Shared talk facts (T29): the status bar's dates segment reads the SAME store as the Talks
  // panel — one IPC fetch for both, refreshed by main on index updates and saved deliveries.
  const talkFacts = useTalkFacts()
  // Unsaved-edit indicator: set by the Editor on real user edits, cleared only by a REAL save —
  // a refused or failed write leaves it standing, so save health is visible at a glance.
  const [dirty, setDirty] = useState(false)
  const [compiling, setCompiling] = useState<boolean>(false)
  // ADR-0032: ⌘L turns the Inspector column into the layout picker for one slide. `slide` is the outline's
  // own address of it ({id=…}, or its heading line before the save stamps one); `query` seeds the search box.
  const [layoutPicker, setLayoutPicker] = useState<{ slide: SlideRef; slideId: string | null; query: string; anchor: string } | null>(null)
  const layoutPickerRef = useRef(layoutPicker)
  layoutPickerRef.current = layoutPicker
  // The layout being tried: the Inspector preview shows it, nothing is written.
  const [pickerTry, setPickerTry] = useState<string | null>(null)
  // Dead-but-compiling until Task 12 deletes SearchPalette: ⌘S now opens the Slide Browser,
  // so nothing sets searchOpen any more, but the palette stays mounted (and unreachable).
  const [searchOpen, setSearchOpen] = useState(false)
  const [browserOpen, setBrowserOpen] = useState(false)
  // Propagation checklist (A5): the version being adopted across presentations, or null.
  // Opened from the Browser filmstrip's 'Adopt this version in…'; stacks over the Browser.
  const [adoptTarget, setAdoptTarget] = useState<{ slideId: string; version: AdoptVersion } | null>(null)
  // Merge-into-one (Task 9): the byte-identical cluster being merged (or null). Opened from the
  // Browser's locations panel AND the insert-time nudge (which fires after the Browser closes),
  // so it lives here as a sibling overlay. mergeNonce bumps after a clean merge → the Browser
  // re-runs its search so the cluster now reads as one shared id.
  const [mergeRequest, setMergeRequest] = useState<MergeRequest | null>(null)
  const [mergeNonce, setMergeNonce] = useState(0)
  const [helpOpen, setHelpOpen] = useState(false)
  // "Explain rendering" (ADR-0024): the slide index whose render trace is shown, or null.
  const [explainIndex, setExplainIndex] = useState<number | null>(null)
  // "Where used & versions" (ADR-0032 ledger MVP): the slide id whose panel is open, or null.
  const [whereUsedId, setWhereUsedId] = useState<string | null>(null)
  // "Check embeds" preflight panel open state.
  const [embedCheckOpen, setEmbedCheckOpen] = useState<boolean>(false)
  const [layoutDoctorOpen, setLayoutDoctorOpen] = useState<boolean>(false)
  const [unresolvedBlock, setUnresolvedBlock] = useState<{
    count: number
    firstTitle: string
    firstLine: number
    message: string
  } | null>(null)
  // The editor's slide context menu (v0.15 stage 4): ⌘K with the editor focused, or right-click
  // inside .cm-content. startAtFirst mirrors the Talks-panel convention (⌘K highlights the first
  // row, right-click starts blank); withText adds the cut/copy/paste group on right-click only.
  // The Plain margin's menus (spec T8, T9): which menu, for which heading line, drawn under which label.
  const [marginMenu, setMarginMenu] = useState<{ kind: 'level' | 'layout'; line: number; anchor: { left: number; bottom: number } } | null>(null)
  const headingToolsRef = useRef<HeadingTools | null>(null)
  // Command-I. In the Plain and the Markdown tab it opens the small picker under the caret's line,
  // which puts an icon on a title, a paragraph or a list item (usePlainIconPicker.tsx; in Markdown
  // the token shows as text). Where there is no editor to open that picker in, it opens the icon
  // search as before.
  const plainIconToolsRef = useRef<PlainIconTools | null>(null)
  const plainIcon = usePlainIconPicker(plainIconToolsRef)
  const toggleIconPickerRef = useRef<() => void>(() => {})
  toggleIconPickerRef.current = () => {
    if (!iconPickerOpen && plainIcon.toggle()) return
    setIconPickerOpen((prev) => !prev)
  }
  const [slideMenu, setSlideMenu] = useState<{
    x: number
    y: number
    startAtFirst: boolean
    startAtAction?: SlideMenuAction
    withText: boolean
    consumeFence?: () => void
  } | null>(null)

  // Strip ↔ editor sync + reorder/insert plumbing
  const [activeSlide, setActiveSlide] = useState<number>(0)
  const [inspectedSlideId, setInspectedSlideId] = useState<string | null>(null)
  // takeFocus distinguishes deliberate "go edit this" jumps (outline sidebar, deck ⌘E — the caret
  // should land in the editor) from strip/grid card CLICKS, which only aim the editor's viewport:
  // stealing focus there killed the strip's own arrow-key navigation for mouse users.
  const [focusLine, setFocusLine] = useState<{ line: number; takeFocus: boolean } | null>(null)
  const [imageMetaId, setImageMetaId] = useState<string | null>(null)
  const [abstractOpen, setAbstractOpen] = useState<boolean>(false)
  const [deckDesignOpen, setDeckDesignOpen] = useState<boolean>(false)
  const [cmdMenuOpen, setCmdMenuOpen] = useState<boolean>(false)
  // Text the palette opens with: Actions here hands over what was typed in its filter.
  const [cmdMenuQuery, setCmdMenuQuery] = useState<string>('')
  // Actions here (⌘K, right-click, Menu key): the panel at the caret or the selected slide.
  const [actionsHere, setActionsHere] = useState<{ x: number; y: number; place: Place; returnTo: HTMLElement | null } | null>(null)

  // Slide Focus (B1/B3/B4). A VIEW state (peer of gridMode, not a scrim): the compiled index of the
  // focused slide, or null. `focusRange` is the line-aligned band handed to the Editor's focusRange
  // prop. Focus is a WORKSPACE-only affair since v0.15.x: the Browser's ↵ opens its own
  // insert-decision viewer and never switches talks (the pendingFocus cross-talk path is gone —
  // the silent activeTalk switch it performed caused a data-loss near-miss).
  const [focusSlide, setFocusSlide] = useState<number | null>(null)
  const [focusRange, setFocusRange] = useState<FocusRange | null>(null)
  const focusSlideRef = useRef<number | null>(focusSlide)
  useEffect(() => { focusSlideRef.current = focusSlide }, [focusSlide])
  // The 1-based outline heading line the scoped band was last built from. The re-sync effect below
  // re-bands ONLY when this changes (a compile re-aligns slideLines, or a delete/reorder shifts the
  // focused index) — never on ordinary in-band typing, where the heading line is stable and the
  // focus-scope extension already maps the band through the edit. This prevents a per-keystroke
  // re-band (which would re-trim trailing blanks and yank the caret).
  const lastFocusLineRef = useRef<number | null>(null)

  // Reverse-portal editor reuse: the live Editor is mounted ONCE into a persistent detached host div
  // and rendered there via createPortal, so entering/leaving Focus never remounts it (undo history +
  // idProtect/focus-scope/heading guards all survive). Whichever layout is active renders an empty
  // slot; an effect-free callback ref moves the host DOM node into that slot. Moving a DOM node with
  // appendChild does not destroy it, so CodeMirror keeps running across the reparent.
  const editorHostRef = useRef<HTMLDivElement | null>(null)
  if (!editorHostRef.current) {
    editorHostRef.current = document.createElement('div')
    editorHostRef.current.className = 'editor-portal-host'
  }
  const editorSlotRef = useRef<HTMLDivElement | null>(null)
  const attachEditorSlot = useCallback((node: HTMLDivElement | null) => {
    editorSlotRef.current = node
    const host = editorHostRef.current
    if (node && host && host.parentElement !== node) node.appendChild(host)
  }, [])

  // View-switch positioning (⌘1/2/3/4). The reverse-portal detaches the editor while a strip/grid-only
  // view is active, and CodeMirror re-measures from the top on reattach — so switching back snaps the
  // editor to the top. When the editor re-appears we scroll it to reveal the CURRENT cursor, which
  // lands on the slide you're on: the cursor is wherever strip/grid/outline navigation last put it, so
  // this both fixes the snap-to-top AND follows a slide you picked while the editor was hidden. Two
  // frames: one for React's commit (host reparented), one for CM's post-attach measure.
  const scrollEditorToCursor = useCallback(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => editorCmdsRef.current?.scrollCursorIntoView())
    })
  }, [])

  // Imperative insert-at-cursor channel (ADR-0013). The Editor registers a function
  // here on mount; the cross-talk search palette calls it to splice an imported
  // slide at the live caret instead of appending at EOF.
  const editorInsertRef = useRef<((text: string) => void) | null>(null)
  const editorInsertObjectRef = useRef<ObjectInsertHandler | null>(null)
  // Puts rewritten text into the buffer in place as ONE minimal change (caret mapped, scroll and undo
  // history kept, no remount); `{ save: true }` also supersedes the autosave and returns the text to
  // save now (Editor registerReplaceDoc). editorReadRef reads the buffer itself — the doc CodeMirror
  // holds — never the outlineContent mirror (one-writer spec D1).
  const editorReplaceRef = useRef<((text: string, opts?: { save?: boolean; savedFrom?: string; ownUndoStep?: boolean }) => string | null) | null>(null)
  const editorReadRef = useRef<(() => { path: string; text: string; caret: number } | null) | null>(null)
  const editorLayoutContextRef = useRef<(() => LayoutPickerContext | null) | null>(null)
  const editorApplyLayoutRef = useRef<((initial: LayoutDef[], selected: LayoutDef[]) => void) | null>(null)
  const editorApplyOptionRef = useRef<((entry: LayoutDef | undefined, group: OptionGroup, token: string, headingLine?: number, slideId?: string | null, compiledLayout?: string) => string | null) | null>(null)
  // Editor-only commands (fold/unfold all + line-targeted outline ops) exposed to the command palette and Slides organizer.
  const editorCmdsRef = useRef<{
    foldAll: () => void; unfoldAll: () => void
    move: (line: number, dir: 'up' | 'down') => void
    reLevel: (line: number, dir: -1 | 1, withSubtree: boolean) => void
    moveTo: (fromLine: number, toLine: number) => void
    moveToEnd: (fromLine: number) => void
    moveInto: (fromLine: number, sectionLine: number) => void
    undo: () => void
    redo: () => void
    newSlide: () => void
    /** Returns the new board's heading line (1-based), or null when nothing was inserted. */
    insertBoardSlide: () => number | null
    promoteHeading: () => void
    demoteHeading: () => void
    bulletedList: () => void
    numberedList: () => void
    normalizeTriggers: () => void
    setQuoteForm: (form: QuoteFormChoice, compiledLayoutAt?: (headingLine: number) => string | undefined) => void
    deleteSlide: () => void
    flushSave: () => Promise<void>
    scrollCursorIntoView: () => void
    cursorCoords: () => { x: number; y: number } | null
    placeCursorAtCoords: (x: number, y: number) => void
    cutSelection: () => void
    copySelection: () => void
    pasteClipboard: () => void
    selectionText: () => string
    slides: SlideBlockOps
    runFormat: (id: 'bold' | 'italic' | 'inline-code' | 'highlight' | 'strikethrough' | 'underline' | 'link') => void
  } | null>(null)
  // Reads the caret's current top-level list-item context for the icon picker (ADR-0021).
  const iconContextRef = useRef<(() => CursorListItemContext | null) | null>(null)
  // Always-current outline text, so handleSearchInsert can flush the post-insert
  // doc to disk immediately (the Editor's own autosave is debounced 1.5s, too slow
  // for an insert the user — or the harness — reads back right away).
  const outlineContentRef = useRef<string>('')
  useEffect(() => { outlineContentRef.current = outlineContent }, [outlineContent])
  // Mirror activeTalk into a ref so the (deps-[]) global key handler can present the CURRENT talk.
  const activeTalkRef = useRef<TalkInfo | null>(activeTalk)
  useEffect(() => { activeTalkRef.current = activeTalk }, [activeTalk])
  // Ticket 09 (LOCKED-conflict frame 1): the status bar says when the open talk has conflict copies.
  const [activeConflicts, setActiveConflicts] = useState(activeTalk?.conflicts ?? 0)
  useEffect(() => {
    setActiveConflicts(activeTalk?.conflicts ?? 0)
    const path = activeTalk?.outlinePath
    if (!path) return
    return window.tw.vault.onTalkConflicts(({ outlinePath, conflicts }) => { if (outlinePath === path) setActiveConflicts(conflicts) })
  }, [activeTalk?.outlinePath, activeTalk?.conflicts])
  // Mirror browserOpen so the (deps-[]) global key handler can tell whether the Browser is
  // already open — ⌘S then re-focuses the search field rather than toggling the overlay closed.
  const browserOpenRef = useRef(browserOpen)
  useEffect(() => { browserOpenRef.current = browserOpen }, [browserOpen])
  // The Browser registers a "focus + select the search field" fn here (registerFocusSearch);
  // ⌘S calls it when the Browser is already open.
  const browserFocusSearchRef = useRef<(() => void) | null>(null)
  // The Browser's talk-search actions (registerCommands), for the palette and ⇧⌘S (talk search 08).
  const pickerCommandsRef = useRef<SlidePickerCommands | null>(null)
  const registerPickerCommands = useCallback((commands: SlidePickerCommands) => { pickerCommandsRef.current = commands }, [])
  // True while ANY overlay covers the workspace — the ⌘K/right-click slide menu must never
  // open (or swallow the key) underneath one. Synced by an effect below (after the overlay
  // states are all declared); read by the deps-[] global key handler.
  const overlayOpenRef = useRef(false)

  // One undo history (slide handling ticket 1a): the Editor stays mounted in every view, the grid
  // included (reverse-portal into editorHostRef), so a move made in the grid is a CodeMirror history
  // step and ⌘Z / ⇧⌘Z there run the editor's own undo and redo.
  const gridModeRef = useRef(gridMode)
  useEffect(() => { gridModeRef.current = gridMode }, [gridMode])
  const paneStateRef = useRef(paneState)
  useEffect(() => { paneStateRef.current = paneState }, [paneState])

  // lineForSlide[compiledIndex] = the slide's source line (or null). Aligned to compiledSlides
  // so the editor↔strip sync indexes the SAME array the strip/grid render from.
  const slideLines = useMemo(
    () => computeSlideLines(compiledSlides, outlineContent),
    [compiledSlides, outlineContent]
  )
  // The talk's slides for the Slide Scratchpad's placement note and Change place; worked out only while its panel shows.
  const scratchPanelShown = Boolean(activeTalk) && scratchpadLayout.layout.mode !== 'collapsed'
  const scratchAllRows = useMemo(() => (scratchPanelShown ? slideRows(outlineContent) : []), [outlineContent, scratchPanelShown])
  const scratchRows = useMemo(() => scratchAllRows.filter((row) => row.level >= 2), [scratchAllRows])
  // The numbers the Slide outline shows (one helper, outlineNumbers, so they cannot disagree): the compiled numbers by
  // line while they are fresh, by position or ordinal while a compile after an edit is still out. Reading the
  // published map by line directly gave stale numbers right after an insert.
  const stripNumbersNow = useSyncExternalStore(subscribeStripNumbers, getStripNumbers)
  const scratchNumbers = useMemo(() => outlineNumbers(scratchAllRows, stripNumbersNow), [scratchAllRows, stripNumbersNow])
  // A chosen place follows its slide through edits; when its slide is gone (an Undo of the insert that moved it there),
  // the earlier place comes back, or the place follows the cursor again. The note never names a slide that is gone.
  useEffect(() => {
    if (!scratchPanelShown || !scratchChosenPlace || scratchChosenPlace.kind === 'start') return
    const settled = settlePlace(outlineContent, scratchChosenPlace, scratchChosenEarlierRef.current)
    scratchChosenEarlierRef.current = settled.earlier
    if (settled.place !== scratchChosenPlace) setScratchChosenPlace(settled.place)
  }, [outlineContent, scratchChosenPlace, scratchPanelShown])

  // The Plain view's margin: Talk / Section / Slide n with the layout name. Recomputed when the
  // compiled rows change (or the outline first loads), not on every keystroke: between compiles the
  // editor's margin rides the edits itself, as the slide-number gutter does.
  const marginLabelList = useMemo(
    () => marginLabels(compiledSlides, outlineContentRef.current),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [compiledSlides, activeTalk?.outlinePath, outlineContent === '']
  )

  // The Quote form commands are offered only while the slide at the caret is a quote slide.
  const quoteSlideAtCaret = useMemo(() => {
    const line = slideLines[activeSlide]
    // A quote-only slide with no `{quote}` token is drawn with the quote layout too: the compiled row says so.
    return line != null && isQuoteSlide(outlineContent, { headingLine: line }, compiledSlides?.[activeSlide]?.layout)
  }, [outlineContent, slideLines, activeSlide, compiledSlides])
  const placeCount = useMemo(() => actionRowsAt(place, { row: placeRow, quoteSlide: quoteSlideAtCaret }).length, [place, placeRow, quoteSlideAtCaret])
  const placeChip = { place, count: placeCount, chord: liveShortcutLabel('app.context-menu'), visible: placeChipVisible, onActivate: activatePlace }

  // Mirror the strip's current-slide mapping into refs so the (deps-[]) global key handler can
  // resolve the ACTIVE slide for the where-used command — same pattern as activeTalkRef above.
  const activeSlideRef = useRef<number>(activeSlide)
  useEffect(() => { activeSlideRef.current = activeSlide }, [activeSlide])
  const compiledSlidesRef = useRef<ProjectionRow[] | null>(compiledSlides)
  useEffect(() => { compiledSlidesRef.current = compiledSlides }, [compiledSlides])
  const inspectedSlideIdRef = useRef<string | null>(inspectedSlideId)
  useEffect(() => { inspectedSlideIdRef.current = inspectedSlideId }, [inspectedSlideId])
  const inspectorCommitInProgressRef = useRef(false)
  const cursorLineRef = useRef<number | null>(null)
  const onActiveLineChangeRef = useRef(onActiveLineChange)
  onActiveLineChangeRef.current = onActiveLineChange
  const [activeLineReporter] = useState(() => createActiveLineReporter(() => onActiveLineChangeRef.current))
  const cursorAwaitsCompileRef = useRef(false)
  // The heading line of a board slide just inserted, until the Inspector has opened on it.
  const insertedBoardLineRef = useRef<number | null>(null)
  const inspectedSlideIndexRef = useRef(0)
  const inspectedSlideIndex = resolveInspectedSlide(
    compiledSlides,
    inspectedSlideId,
    inspectedSlideIndexRef.current
  ).index
  // ADR-0033 §1: heading lines the outline editor marks for text that cannot fit at the readable minimum.
  const textFitNotes = useMemo(() => textFitNotesFor(compiledSlides, slideLines), [compiledSlides, slideLines])
  const slideLinesRef = useRef<(number | null)[]>(slideLines)
  // The slide the inspector shows, as of this render (Capture embed… acts on it).
  const inspectedNowRef = useRef(inspectedSlideIndex)
  inspectedNowRef.current = inspectedSlideIndex
  // Nothing is published before the first compile of the open talk (compiledSlides is null on talk load), so numbers never carry from another talk.
  useEffect(() => { publishStripNumbers(stripNumbersToPublish(compiledSlides, slideLines)) }, [compiledSlides, slideLines])
  useEffect(() => () => publishStripNumbers(null), [])
  // The outline's search shows a thumbnail under each hit (lib/slideSearch.ts): the compiled slides' preview urls, by compiled index.
  useEffect(() => {
    publishSlideThumbs(compiledSlides && thumbnails ? compiledSlides.map((r) => thumbnails[r.render_hash || r.content_hash || r.slide_id || ''] ?? null) : null)
  }, [compiledSlides, thumbnails])
  useEffect(() => () => publishSlideThumbs(null), [])
  useEffect(() => { slideLinesRef.current = slideLines }, [slideLines])
  // The layout the compiler gave the compiled slide whose heading is on `line` (the quote commands need it for a quote-only slide with no `{quote}` token).
  const compiledLayoutAtLine = useCallback((line: number): string | undefined => {
    const index = slideLinesRef.current.indexOf(line)
    return index < 0 ? undefined : compiledSlidesRef.current?.[index]?.layout
  }, [])

  // ── Whole slides: cut, copy, paste, Move … to… (the grid, the two commands; the outline gets the same ops through App) ──
  const [slideOps, setSlideOps] = useState<SlideBlockOps | null>(null)
  const [moveRequest, setMoveRequest] = useState<SlideMenuRequest | null>(null)
  // Which panel last had the keyboard: the command palette takes the focus before a command runs, so
  // "the slide selected in the focused panel" is read from where the keyboard was before it.
  const focusRegionRef = useRef<'editor' | 'outline' | 'slides'>('editor')
  useEffect(() => {
    const onFocusIn = (e: FocusEvent): void => {
      const t = e.target
      if (!(t instanceof HTMLElement)) return
      if (t.closest('[data-slides-organizer]')) focusRegionRef.current = 'outline'
      else if (t.closest('[data-place-region="strip"]')) focusRegionRef.current = 'slides'
      else if (t.closest('.cm-content')) focusRegionRef.current = 'editor'
    }
    window.addEventListener('focusin', onFocusIn)
    return () => window.removeEventListener('focusin', onFocusIn)
  }, [])
  // The heading line, in the editor's CURRENT text, of the slide a card shows. The line the compiled
  // row is mapped to is used when the row's id is still on it; otherwise the id is looked up (the
  // mapping lags the compile after an edit), so an operation never lands on a neighbouring slide.
  const lineOfSlideIndex = useCallback((index: number): number | null => {
    const text = editorReadRef.current?.()?.text ?? outlineContentRef.current
    const mapped = slideLinesRef.current[index] ?? null
    const id = compiledSlidesRef.current?.[index]?.slide_id ?? null
    if (!id) return mapped
    const lines = text.split('\n')
    if (mapped != null) {
      for (let i = mapped - 1; i < lines.length && (i === mapped - 1 || /^\s*(\{[^}]*\}\s*)+$/.test(lines[i])); i += 1) {
        if (lines[i].includes(`{id=${id}}`)) return mapped
      }
    }
    return headingLineForSlideId(text, id) ?? mapped
  }, [])
  // After a paste or a move made from the grid or a command: open the sections around the slide now,
  // and select its card once the compile that carries the change arrives.
  const slideLandingRef = useRef<{ line: number; compiled: ProjectionRow[] | null; at: number } | null>(null)
  const slideLanded = useCallback((line: number): void => {
    const talkKey = activeTalkRef.current?.outlinePath
    if (talkKey) revealLine(talkKey, line, editorReadRef.current?.()?.text ?? outlineContentRef.current)
    const current = editorReadRef.current?.()
    if (current?.text === compiledSourceRef.current) {
      const index = slideLinesRef.current.indexOf(line)
      if (index >= 0) { slideLandingRef.current = null; selectSlideRef.current(index); return }
    }
    slideLandingRef.current = { line, compiled: compiledSlidesRef.current, at: Date.now() }
  }, [])
  useEffect(() => {
    const landing = slideLandingRef.current
    if (!landing || compiledSlides === landing.compiled) return
    slideLandingRef.current = null
    if (Date.now() - landing.at > 15000) return
    const index = slideLines.indexOf(landing.line)
    if (index >= 0) selectSlideRef.current(index)
  }, [slideLines, compiledSlides])
  // Move slide to… / Move section to…: the destination list for the slide or section at the caret, or
  // selected in the panel that had the keyboard (the Slides outline, the strip, the grid).
  // The line a whole-slide command acts on: the slide selected in the panel that had the keyboard
  // (the Slides outline, the strip, the grid), else the line of the caret. `anchor` is where a list
  // for it opens.
  function commandSlideLine(doc: { text: string; caret: number }): { line: number; anchor: { x: number; y: number } | null } {
    const region = gridModeRef.current ? 'slides' : focusRegionRef.current
    let line: number | null = null
    let box: DOMRect | undefined
    if (region === 'slides') {
      line = lineOfSlideIndex(activeSlideRef.current)
      box = document.querySelector(`[data-place-region="strip"] [data-slide-index="${activeSlideRef.current}"]`)?.getBoundingClientRect()
    } else if (region === 'outline' && getOutlineSelection() != null) {
      line = getOutlineSelection()
      box = document.querySelector(`[data-slides-organizer] [data-line="${line}"]`)?.getBoundingClientRect()
    }
    let anchor = box ? { x: box.left + 24, y: box.top + 24 } : null
    if (line == null) {
      line = doc.text.slice(0, doc.caret).split('\n').length
      anchor = editorCmdsRef.current?.cursorCoords() ?? null
    }
    return { line, anchor }
  }
  // Cut slide, Copy slide, Paste slide after, run from Actions here: the same operations as the rows
  // of the slide and section context menus (SlideRowMenus), on the slide commandSlideLine names.
  function runSlideClipboardRow(action: 'cut' | 'copy' | 'paste'): void {
    const doc = editorReadRef.current?.()
    if (!doc || !activeTalkRef.current || !slideOps) return
    const subject = moveSubject(slideRows(doc.text), commandSlideLine(doc).line, 'slide')
    if (!subject) { notify('Put the cursor on a slide first.', 'info', 'slide-clipboard'); return }
    if (action === 'paste') {
      navigator.clipboard.readText()
        .then((text) => {
          const landed = slideOps.paste(text, subject.line)
          if (landed != null) slideLanded(landed)
        })
        .catch(() => notify('Couldn’t read the clipboard. Paste with ⌘V instead.', 'warning', 'slide-clipboard-failed'))
      return
    }
    const clip = action === 'cut' ? slideOps.cut(subject.line) : slideOps.copy(subject.line)
    if (clip != null) writeSlideClipboard(clip, action === 'cut')
  }
  function openMoveTo(want: 'slide' | 'section'): void {
    const doc = editorReadRef.current?.()
    if (!doc || !activeTalkRef.current) return
    const at = commandSlideLine(doc)
    const line = at.line
    let anchor = at.anchor
    const subject = moveSubject(slideRows(doc.text), line, want)
    if (!subject) {
      notify(want === 'section' ? 'Put the cursor in a section first: this slide is not in one.' : 'Put the cursor on a slide first.', 'info', 'slide-clipboard')
      return
    }
    if (!anchor) {
      const bar = document.querySelector('.workspace-toolbar')?.getBoundingClientRect()
      anchor = bar ? { x: bar.left + 16, y: bar.bottom + 8 } : { x: 80, y: 80 }
    }
    setMoveRequest({ x: anchor.x, y: anchor.y, line: subject.line, mode: 'move' })
  }

  // The Inspector owns its navigation while open. Recompiles may insert, remove, or reorder rows,
  // so its index is always recovered from the stable deep-link id. Only a vanished id falls back
  // to the previous (clamped) position.
  useEffect(() => {
    if (!inspectorMode) return
    // Insert › Board slide (ADR-0032 A1): the Inspector opens on the new board once a compile
    // carries it. Until then the caret's slide index points into the rows compiled before it.
    const inserted = insertedBoardLineRef.current
    const insertedIndex = inserted == null ? -1 : slideLines.findIndex((line) => line === inserted)
    if (insertedIndex >= 0 && compiledSlides?.[insertedIndex]) {
      insertedBoardLineRef.current = null
      const id = compiledSlides[insertedIndex].slide_id ?? null
      inspectedSlideIdRef.current = id
      inspectedSlideIndexRef.current = insertedIndex
      setInspectedSlideId(id)
      return
    }
    const previousIndex = inspectedSlideId == null ? activeSlideRef.current : inspectedSlideIndexRef.current
    const seedId = inspectedSlideId
      ?? compiledSlides?.[Math.max(0, Math.min((compiledSlides?.length ?? 1) - 1, activeSlideRef.current))]?.slide_id
      ?? null
    const resolved = resolveInspectedSlide(compiledSlides, seedId, previousIndex)
    inspectedSlideIdRef.current = resolved.id
    inspectedSlideIndexRef.current = resolved.index
    setInspectedSlideId(resolved.id)
  }, [compiledSlides, inspectorMode, activeTalk?.outlinePath])

  // The ledger {id=…} of the slide the strip/cursor is currently on, or null if it has none
  // (a synthesized cover/closing row, or a slide not yet saved-and-stamped). Reads refs only, so
  // it is safe to call from the deps-[] global key handler. Shared by openWhereUsed (⌘⇧U) and
  // present-from-here (⇧F5): both need "which slide am I on, by its stable id".
  function currentSlideId(): string | null {
    const startLine = slideLinesRef.current[activeSlideRef.current] ?? null
    if (startLine == null) return null
    // The slide block runs from its heading line to the next heading (any level) or EOF.
    const lines = outlineContentRef.current.split('\n')
    let end = lines.length
    for (let i = startLine; i < lines.length; i++) {
      if (/^#{1,6}\s/.test(lines[i])) { end = i; break }
    }
    const block = lines.slice(startLine - 1, end).join('\n')
    const m = block.match(/\{id=([A-Za-z0-9_-]+)\}/)
    return m ? m[1] : null
  }

  // "Slide: where used & versions" (ADR-0032 ledger MVP). Reuses the editor↔strip current-slide
  // plumbing (activeSlide → slideLines source line) to find the active block, extracts its
  // {id=…}, and opens the read-only panel. An unstamped slide gets an info toast, not a panel.
  function openWhereUsed(): void {
    if (slideLinesRef.current[activeSlideRef.current] == null) {
      // Synthesized cover/closing rows have no source block — nothing to look up.
      notify('This slide has no {id=…} yet — save the outline to stamp ledger versions.', 'info')
      return
    }
    const id = currentSlideId()
    if (id) setWhereUsedId(id)
    else notify('This slide has no {id=…} yet — save the outline to stamp ledger versions.', 'info')
  }

  // ── Slide Focus entry/exit/paging (B1) ──────────────────────────────────────
  // enterFocus: scope onto the compiled slide `slideIndex` IN THE ACTIVE TALK. A synthesized
  // cover/section row (no editable block) redirects to the nearest focusable slide; a talk with
  // none at all no-ops with a hint. Sets the Editor's focusRange band from the CURRENT outline +
  // that slide's heading line, and syncs the strip's active card. Stable (reads refs only) so the
  // deps-[] key handler can call it.
  const enterFocus = useCallback((slideIndex: number) => {
    const lines = slideLinesRef.current
    let idx = slideIndex
    if (!(idx >= 0 && idx < lines.length && lines[idx] != null)) {
      const alt = firstFocusableFrom(lines, Math.max(0, idx))
      if (alt == null) { notify('This slide can’t be focused — it has no editable block yet.', 'info'); return }
      idx = alt
    }
    const range = focusRangeForSlideLine(outlineContentRef.current, lines[idx])
    if (!range) { notify('This slide can’t be focused — it has no editable block yet.', 'info'); return }
    lastFocusLineRef.current = lines[idx]
    setActiveSlide(idx)
    setFocusRange(range)
    setFocusSlide(idx)
  }, [])
  const enterFocusRef = useRef(enterFocus)
  useEffect(() => { enterFocusRef.current = enterFocus }, [enterFocus])

  // Prev/next within the compiled order, skipping synthesized rows, recomputing the band each step.
  const focusStep = useCallback((dir: 1 | -1) => {
    const cur = focusSlideRef.current
    if (cur == null) return
    const lines = slideLinesRef.current
    const next = nextFocusableSlide(lines, cur, dir)
    if (next === cur) return
    // slideLines' heading lines lag the ~900ms compile: mid-window the target's line can point at a
    // shifted (or removed) line. If its band no longer resolves, DON'T page — a null range would
    // un-scope the editor to the whole outline. Stay put until the compile re-aligns slideLines.
    const range = focusRangeForSlideLine(outlineContentRef.current, lines[next])
    if (!range) return
    lastFocusLineRef.current = lines[next]
    setFocusRange(range)
    setActiveSlide(next)
    setFocusSlide(next)
  }, [])

  const exitFocus = useCallback(() => {
    lastFocusLineRef.current = null
    setFocusSlide(null)
    setFocusRange(null)
    // Focus only ever enters from the workspace now — hand the keyboard back to the editor.
    requestAnimationFrame(() => (document.querySelector('.cm-content') as HTMLElement | null)?.focus())
  }, [])

  // Re-sync the scoped band after a compile (or a delete/reorder) re-aligns slideLines. slideLines'
  // heading lines come from compiledSlides.source_line, stale for up to the compile debounce after a
  // keystroke; when the compile lands the focused index may map to a different (or no) heading line.
  // We re-band ONLY when that heading line changes vs. the one we last banded on — so ordinary in-band
  // typing (heading line unchanged; the extension maps the band itself) never triggers a re-band, and
  // a genuine re-alignment is corrected. If the focused index no longer resolves to a block (its slide
  // was deleted), leave Focus — it can no longer point anywhere valid.
  useEffect(() => {
    if (focusSlide == null) { lastFocusLineRef.current = null; return }
    const line = slideLines[focusSlide] ?? null
    if (line === lastFocusLineRef.current) return
    const range = focusRangeForSlideLine(outlineContentRef.current, line)
    if (!range) { exitFocus(); return }
    lastFocusLineRef.current = line
    setFocusRange(range)
  }, [slideLines, focusSlide, exitFocus])

  // Delete the current slide (the sanctioned whole-slide removal). While in Focus this would leave
  // focusSlide pointing at a now-stale compiled index, so exit Focus back to the origin first. Wired
  // to the ⌘⇧P command + the toolbar item; the in-editor ⌘⇧⌫ path is handled by the re-sync effect
  // above (a removed slide's index stops resolving → it exits, or re-bands onto the adjacent slide).
  // ADR-0032 §4: component-kind entries (code, QR, action button, embeds, countdown) are written at
  // the caret from the Insert menu and the action bar; the picker no longer offers them.
  const insertComponent = useCallback((name: string) => {
    const entry = componentInsertEntries().find((candidate) => candidate.name === name)
    // Speaker notes go through the notes planner (privacy checked by the compiler's reading), never a snippet.
    if (entry?.planner === 'notes') headingToolsRef.current?.insertNotes()
    else if (entry) editorInsertRef.current?.(entry.snippet)
  }, [])

  // Insert › HTML page… (lib/insertHtmlPage.ts): main picks and copies; the line goes in at the caret of
  // the talk that was open when the command ran, or nowhere.
  const insertHtmlPageRef = useRef<(() => Promise<unknown>) | null>(null)
  insertHtmlPageRef.current ??= createHtmlPageInserter({
    currentTalk: () => activeTalkRef.current?.outlinePath ?? null,
    choose: (outlinePath) => window.tw.htmlPage.choose(outlinePath),
    importPage: (token, outlinePath) => window.tw.htmlPage.import(token, outlinePath),
    insert: (text) => { const insert = editorInsertRef.current; if (!insert) return false; insert(text); return true },
    notify: (message, kind) => notify(message, kind, 'insert-html-page')
  })

  // Capture embed… (lib/captureEmbed.ts, src/main/live-page-capture-window.ts): the capture window for
  // the inspected slide's web page (`pageUrl` absent: its first). Main binds it to that slide and page;
  // each saved view's {capture} line reaches this editor through the talk writer like any main edit.
  const captureEmbed = useCallback((pageUrl?: string) => {
    const index = inspectedNowRef.current
    const row = compiledSlidesRef.current?.[index] ?? null
    const line = slideLinesRef.current[index] ?? null
    void openCaptureEmbed({
      open: (request) => window.tw.livePage.openCapture(request),
      notify: (message, kind) => notify(message, kind, 'capture-embed')
    }, {
      outlinePath: activeTalkRef.current?.outlinePath ?? null,
      slideId: row?.slide_id ?? null,
      title: row?.title ?? '',
      text: captureEmbedSlideBlock(outlineContentRef.current, line)
    }, pageUrl)
  }, [])
  // Capture embed… from a web page card in the editor: the card says which slide (its heading line) and
  // which page; the slide must be compiled (its id binds the capture window), else nothing opens.
  const captureEmbedAt = useCallback((headingLine: number, pageUrl: string) => {
    const index = slideLinesRef.current.indexOf(headingLine)
    const row = index >= 0 ? compiledSlidesRef.current?.[index] ?? null : null
    if (!row?.slide_id) { notify('This slide is not ready yet. Wait a moment for the preview, then capture again.', 'info', 'capture-embed'); return }
    void openCaptureEmbed({
      open: (request) => window.tw.livePage.openCapture(request),
      notify: (message, kind) => notify(message, kind, 'capture-embed')
    }, {
      outlinePath: activeTalkRef.current?.outlinePath ?? null,
      slideId: row.slide_id,
      title: row.title ?? '',
      text: captureEmbedSlideBlock(outlineContentRef.current, headingLine)
    }, pageUrl)
  }, [])
  // Remove from slide (Inspector › Web page): takes one saved view's {capture} line out of the
  // inspected slide, planned against the editor's own buffer (typing not yet saved is kept) and put in
  // as one undoable change. The slide's marker stays, so the view does not come back; the picture and
  // its record stay in the talk folder. A refusal leaves the text exactly as it is and says why.
  const removeSavedView = useCallback((pageUrl: string, image: string, embed: { index: number; of: number }) => {
    const doc = editorReadRef.current?.()
    const index = inspectedNowRef.current
    if (!doc) { notify('This saved view could not be removed: the slide is not ready yet. Try again in a moment.', 'warning', 'capture-embed'); return }
    const plan = planSavedViewRemoval({ text: doc.text, rows: compiledSlidesRef.current, index, line: slideLinesRef.current[index] ?? null, pageUrl, image, embed })
    if ('refused' in plan) { notify(plan.refused, 'warning', 'capture-embed'); return }
    inspectorCommitInProgressRef.current = true
    try {
      // Its own undo step: typing just before or after it is never undone with it.
      if (editorReplaceRef.current?.(plan.text, { ownUndoStep: true }) == null) notify('This saved view could not be removed: the editor did not take the change.', 'warning', 'capture-embed')
    } finally {
      queueMicrotask(() => { inspectorCommitInProgressRef.current = false })
    }
  }, [])
  // Another talk in this window: its Capture embed window (if any) closes.
  const captureEmbedTalk = activeTalk?.outlinePath ?? null
  useEffect(() => () => { void window.tw.livePage.closeCapture() }, [captureEmbedTalk])

  const handleDeleteSlide = useCallback(() => {
    if (slideSelectionControls()?.remove()) return // several slides selected in the grid: all of them, one Undo step
    editorCmdsRef.current?.deleteSlide()
    if (focusSlideRef.current != null) exitFocus()
  }, [exitFocus])

  // The Browser's ↵ no longer reaches the workspace at all (v0.15.x): it opens the Browser's
  // own insert-decision viewer. The old cross-talk pendingFocus flow — which silently switched
  // activeTalk under the editor — is deliberately gone.

  // Detach (B3). Main detaches against this window's BUFFER (talk-writer.ts routes the open talk
  // here) and the re-id'd text arrives through the D1 seam as one minimal change, saved through the
  // queue — so there is no flush first and no reload after (one-writer spec D1).
  async function handleDetach(ref: { heading: string; occurrence: number }): Promise<boolean> {
    const talk = activeTalkRef.current
    if (!talk) return false
    const res = await window.tw.ledger.detach(talk.outlinePath, outlineContentRef.current, ref)
    if (!res) { notify('Couldn’t detach this slide — the ledger didn’t return a result.', 'error'); return false }
    notify(`Detached — new id {id=${res.newId}}`, 'success')
    return true
  }

  // ── Slide tags (ADR-0037) ────────────────────────────────────────────────────
  // Tag writes (the Browser's and "Tag current slide…") go to main's tags:apply, which applies an
  // open talk's tags to its editor BUFFER (talk-writer.ts routes it to this window's D1 seam): the
  // change is in the buffer and saved through the queue when the call returns. No flush before, no
  // reload after (one-writer spec D1); a talk open nowhere is written on disk by main.

  // "Tag current slide…" (command palette): the SAME locked picker, anchored under the toolbar,
  // applying to the slide the cursor/strip is on. The ⌘K editor slide menu arrives in a later
  // stage — until then the palette is the keyboard path.
  const [tagSlide, setTagSlide] = useState<{ id: string | null; heading: string; occurrence: number; tags: string[] } | null>(null)
  const [tagSlideBusy, setTagSlideBusy] = useState(false)

  // Keep overlayOpenRef honest: any overlay that can sit over the editor blocks the slide
  // context menu (and lets ⌘K fall through untouched, per the no-swallow rule).
  useEffect(() => {
    overlayOpenRef.current =
      browserOpen || searchOpen || iconPickerOpen || plainIcon.isOpen || helpOpen ||
      cmdMenuOpen || abstractOpen || deckDesignOpen || embedCheckOpen || layoutDoctorOpen ||
      explainIndex != null || whereUsedId != null || imageMetaId != null ||
      adoptTarget != null || mergeRequest != null || tagSlide != null || slideMenu != null || actionsHere != null
  }, [
    browserOpen, searchOpen, iconPickerOpen, plainIcon.isOpen, helpOpen, cmdMenuOpen,
    abstractOpen, deckDesignOpen, embedCheckOpen, layoutDoctorOpen, explainIndex, whereUsedId, imageMetaId,
    adoptTarget, mergeRequest, tagSlide, slideMenu, actionsHere
  ])

  // Open the slide context menu anchored near the caret's slide: the editor's live cursor
  // coordinates (CodeMirror coordsAtPos) when the caret is in the viewport, else under the
  // toolbar — never nowhere.
  const openSlideMenu = useCallback((opts: {
    startAtFirst: boolean
    startAtAction?: SlideMenuAction
    withText: boolean
    consumeFence?: () => void
    at?: { x: number; y: number }
  }) => {
    let anchor = opts.at ?? editorCmdsRef.current?.cursorCoords() ?? null
    if (!anchor) {
      const bar = document.querySelector('.workspace-toolbar')?.getBoundingClientRect()
      anchor = bar ? { x: bar.left + 16, y: bar.bottom + 8 } : { x: 80, y: 80 }
    }
    setSlideMenu({
      x: anchor.x,
      y: anchor.y,
      startAtFirst: opts.startAtFirst,
      startAtAction: opts.startAtAction,
      withText: opts.withText,
      consumeFence: opts.consumeFence
    })
  }, [])
  const openSlideMenuRef = useRef(openSlideMenu)
  useEffect(() => { openSlideMenuRef.current = openSlideMenu }, [openSlideMenu])

  // Actions here: the place decides the rows. `at` is the pointer (right-click); otherwise the panel
  // opens at the caret, or at the selected slide's card in the strip or grid.
  const openActionsHere = useCallback((opts: { region: 'editor' | 'strip'; at?: { x: number; y: number } }) => {
    const place: Place = opts.region === 'strip'
      ? placeAt({ focus: 'strip', row: null, editorPlace: editorPlaceRef.current })
      : editorPlaceRef.current
    let anchor = opts.at ?? null
    if (!anchor && opts.region === 'strip') {
      const card = document.querySelector<HTMLElement>(`[data-place-region="strip"] [data-slide-index="${activeSlideRef.current}"]`)
      const box = card?.getBoundingClientRect()
      if (box) anchor = { x: box.left + 24, y: box.top + 24 }
    }
    if (!anchor && opts.region === 'editor') anchor = editorCmdsRef.current?.cursorCoords() ?? null
    if (!anchor) {
      const bar = document.querySelector('.workspace-toolbar')?.getBoundingClientRect()
      anchor = bar ? { x: bar.left + 16, y: bar.bottom + 8 } : { x: 80, y: 80 }
    }
    const active = document.activeElement
    setActionsHere({ x: anchor.x, y: anchor.y, place, returnTo: active instanceof HTMLElement ? active : null })
  }, [])
  const openActionsHereRef = useRef(openActionsHere)
  useEffect(() => { openActionsHereRef.current = openActionsHere }, [openActionsHere])

  // The current slide's block (same activeSlide→slideLines plumbing as currentSlideId), plus
  // its {heading, occurrence} address for an unstamped write. Occurrence counts identical
  // heading lines from the top — the same verbatim-line rule listSlideBlocks uses.
  function currentSlideBlock(): { markdown: string; heading: string; occurrence: number } | null {
    const startLine = slideLinesRef.current[activeSlideRef.current] ?? null
    if (startLine == null) return null
    const lines = outlineContentRef.current.split('\n')
    let end = lines.length
    for (let i = startLine; i < lines.length; i++) {
      if (/^#{1,6}\s/.test(lines[i])) { end = i; break }
    }
    const heading = lines[startLine - 1]
    if (!/^#{2,6}\s/.test(heading)) return null // the deck title / frontmatter is not a taggable slide
    let occurrence = 0
    for (let i = 0; i <= startLine - 1; i++) if (lines[i] === heading) occurrence += 1
    return { markdown: lines.slice(startLine - 1, end).join('\n'), heading, occurrence }
  }

  function openTagCurrentSlide(): void {
    const block = currentSlideBlock()
    if (!block) {
      notify('Put the cursor on a slide first — synthesized cover/closing slides can’t be tagged.', 'info')
      return
    }
    setTagSlide({
      id: stampedIdOf(block.markdown),
      heading: block.heading,
      occurrence: block.occurrence,
      tags: tagsOfBlock(block.markdown)
    })
  }

  async function applyTagToCurrentSlide(tag: string, action: 'add' | 'remove'): Promise<void> {
    const talk = activeTalkRef.current
    if (!talk || !tagSlide || tagSlideBusy) return
    setTagSlideBusy(true)
    try {
      const target = tagSlide.id
        ? { outline: talk.outlinePath, id: tagSlide.id }
        : { outline: talk.outlinePath, heading: tagSlide.heading, occurrence: tagSlide.occurrence }
      const res = await window.tw.tags.apply(
        [target],
        action === 'add' ? [tag] : [],
        action === 'remove' ? [tag] : []
      )
      if (!res || res.ok !== true || res.failed.length > 0) {
        notify('Couldn’t write the tag — nothing was changed.', 'error')
        return
      }
      // Keep the picker's states honest without re-parsing the (asynchronously adopting) buffer.
      // An unstamped slide whose HEADING carried tags= keeps its heading address only until the
      // scrub — stamped slides (the norm: every save stamps) are id-addressed and immune.
      setTagSlide((s) =>
        s
          ? { ...s, tags: action === 'add' ? (s.tags.includes(tag) ? s.tags : [...s.tags, tag]) : s.tags.filter((t) => t !== tag) }
          : s
      )
    } finally {
      setTagSlideBusy(false)
    }
  }

  // Adopt-current (B3): open the host-mounted PropagationChecklist with the CURRENT block as the
  // version to push across the other talks carrying this id (reuses adoptTarget).
  function handleAdoptCurrent(slideId: string, currentMarkdown: string): void {
    const talk = activeTalkRef.current
    setAdoptTarget({
      slideId,
      version: { file: '__current__', markdown: currentMarkdown, savedAt: Date.now(), talk: talk?.slug ?? '', canonical: false }
    })
  }

  // Every outline write from the workspace goes through the outline's shared save queue — the
  // same queue as the Editor's saves — so a workspace write made before an instant-slide save
  // ("Add to talk") can never land on disk after it (live-presenting ticket 07).
  function writeOutline(outlinePath: string, text: string): ReturnType<typeof window.tw.talk.writeOutline> {
    return queueOutlineWrite(outlinePath, () => window.tw.talk.writeOutline(outlinePath, text))
  }

  // One writer for talk files, renderer side (spec D1, lib/outlineMutation.ts). Every programmatic
  // change of the talk open here — reorder, grid undo, the publish stamp, and every main-process write
  // T1 routes to this window (tags, frontmatter, detach, image optimisation, "Add to talk") — reads
  // the editor's buffer, works out the new text, puts it into the buffer as one minimal change and
  // saves that buffer through writeOutline. The editor is never remounted for it.
  // Built once from refs only, so the deps-[] handlers (⌘Z, editor requests) can use it too.
  const outlineMutatorRef = useRef<OutlineMutator<OutlineSaveResult> | null>(null)
  if (!outlineMutatorRef.current) {
    outlineMutatorRef.current = createOutlineMutator<OutlineSaveResult>({
      bufferFor: (outlinePath) => activeTalkRef.current?.outlinePath !== outlinePath ? null : {
        read: (path) => {
          const doc = editorReadRef.current?.()
          return doc && doc.path === path ? doc.text : null
        },
        apply: (path, next, applyOpts) => {
          const doc = editorReadRef.current?.()
          if (!doc || doc.path !== path) return null
          // A completed move/cut is one deliberate edit, so its new order need not wait for a typing pause.
          if (applyOpts?.ownUndoStep && next !== doc.text) compileImmediatelyRef.current = true
          return editorReplaceRef.current?.(next, { save: true, ownUndoStep: applyOpts?.ownUndoStep }) ?? null
        },
        adopt: (path, sent, saved) => {
          // What the save wrote (tidied, ids stamped): the editor adopts it only while its buffer is
          // still the text the save was made from (never over newer typing; the next save stamps it
          // again). That text is `sent` before the save's tidy-up, which only the editor knows.
          const doc = editorReadRef.current?.()
          if (doc && doc.path === path) editorReplaceRef.current?.(saved, { savedFrom: sent })
        },
        insertAtCaret: (path, block) => {
          // The editor's own insert channel: one change at the live caret, scrolled into view.
          const doc = editorReadRef.current?.()
          const insert = editorInsertRef.current
          if (!doc || doc.path !== path || !insert) return false
          insert(block)
          return true
        },
      },
      settled: (outlinePath) => outlineWritesSettled(outlinePath),
      write: (outlinePath, text) => writeOutline(outlinePath, text),
      onSaved: (_outlinePath, reply) => {
        setLastSaved(new Date())
        setDirty(false)
        notifyCollisions(reply)
      },
      onSaveFailed: (_outlinePath, reply) => {
        // External-change guard: the bar at the top of the talk explains and offers the choice.
        if (noteOutlineSaveReply(reply)) {
          notify('Not saved: this talk’s file differs from what TalkWeaver has open. Choose in the bar at the top of the talk.', 'warning', 'changed-on-disk')
          return
        }
        if (reply && reply.ok === false && reply.refused === 'outside-vault') notify(reply.error, 'error', 'save-failed')
        else if (reply && reply.ok === false) notify('Save skipped — the app refused to overwrite the outline with empty content. Your file on disk is unchanged.', 'warning', 'save-refused')
        else notify('Save FAILED — the outline could not be written to disk. Your recent edits are not saved.', 'error', 'save-failed')
      },
    })
  }

  /** The D1 seam: applies `mutate` to the open talk's buffer (read from the editor itself), puts the
   *  result in as a minimal change and saves it through the file's queue. A talk not open in this
   *  window answers 'not-open' — its callers write it through the main-process handler instead. */
  function applyOutlineMutation(outlinePath: string, mutate: OutlineMutate, opts?: OutlineMutationOptions): Promise<OutlineMutationResult<OutlineSaveResult>> {
    return outlineMutatorRef.current!.apply(outlinePath, mutate, opts)
  }

  // Outline external-change guard (shared-talk ticket 01): the bar at the top of the talk (every view),
  // the sheet that holds a switch or a close, and the recovery offer (useOutlineDiskChange).
  const diskGuard = useOutlineDiskChange({
    activeOutlinePath: activeTalk?.outlinePath ?? null,
    readDoc: () => editorReadRef.current?.() ?? null,
    replaceDoc: (text) => editorReplaceRef.current?.(text) ?? null,
    saveBuffer: async (outlinePath) => (await applyOutlineMutation(outlinePath, (current) => current, { force: true })).ok,
    flush: async () => { await editorCmdsRef.current?.flushSave() },
    onDiscardTalk: () => onDiscardTalk?.(),
  })
  useEffect(() => { registerLeaveGuard?.(diskGuard.guardLeave) }, [registerLeaveGuard, diskGuard.guardLeave])
  const diskChangeBar = diskGuard.change && (
    <OutlineDiskChangeBar change={diskGuard.change} busy={diskGuard.busy} onChoose={diskGuard.choose} />
  )

  // Save-path collision surfacing (ADR-0032): writeOutline now reports duplicate {id=…}s in the
  // outline it just recorded. Called only at AWAITED call sites — fire-and-forget saves stay as-is.
  function notifyCollisions(saved: Awaited<ReturnType<typeof window.tw.talk.writeOutline>>): void {
    if (saved && typeof saved === 'object' && saved.ok === true && saved.collisions?.length) {
      notify(
        `Duplicate slide id${saved.collisions.length > 1 ? 's' : ''} in this outline: ${saved.collisions.join(', ')} — duplicate/detach to fix.`,
        'error',
        'id-collision'
      )
    }
  }

  // Return keyboard focus to the editor after a palette closes — otherwise typing "/" and then
  // dismissing without choosing leaves focus nowhere and the user gets stuck (has to click in).
  const focusEditor = (): void => {
    requestAnimationFrame(() => (document.querySelector('.cm-content') as HTMLElement | null)?.focus())
  }

  // Menu / palette entry: open the drawer, or bring the cursor back to its search box when it is
  // already open. (⌘⇧I itself toggles.)
  function openImageDrawer(): void {
    // Read from the page, not state: the command table that calls this can hold an older render.
    const search = document.querySelector<HTMLInputElement>('[data-image-drawer] input')
    if (search) search.focus()
    else showImageDrawer()
  }
  // Opening the drawer closes the Inspector (the right column goes back to the slide strip). It is not
  // reopened when the drawer closes: no panel in this app is remembered across another panel's opening
  // (the grid is the only one with a return flag), so the person reopens it with the Inspector command.
  function showImageDrawer(): void {
    setInspectorMode(false)
    setImageDrawerOpen(true)
  }
  // The one way the drawer closes (its own Esc / close button, and the closing half of ⌘⇧I): the
  // keyboard goes back to the editor, never to the page.
  function closeImageDrawer(): void {
    setImageDrawerOpen(false)
    setImageDropping(null)
    focusEditor()
  }
  // ⌘⇧I (the keydown handler has deps [] and reads this ref): open the drawer, or close it as above.
  const toggleImageDrawerRef = useRef<() => void>(() => {})
  toggleImageDrawerRef.current = () => {
    if (imageDrawerOpen) closeImageDrawer()
    else showImageDrawer()
  }

  const activeShare = shareForTalk(sharedTalks, activeTalk?.outlinePath)
  const closeShareSheet = useCallback(() => {
    setShareSheetOpen(false)
    requestAnimationFrame(() => (document.querySelector('.cm-content') as HTMLElement | null)?.focus())
  }, [])
  // The sheet belongs to the talk it opened on.
  useEffect(() => { setShareSheetOpen(false) }, [activeTalk?.outlinePath])

  // Feedback rail (ticket 05): takes the Inspector's slot beside the outline while open. Counts and
  // the owner socket's state come from main's summaries; the list from the talk's feedback file.
  const [feedbackOpen, setFeedbackOpen] = useState<boolean>(false)
  const feedbackSummaries = useFeedbackSummaries()
  const activeFeedback = activeShare ? feedbackSummaries[activeShare.shareId] ?? null : null
  const feedbackPaused = activeFeedback?.connection === 'paused'
  const shareEnded = Boolean(activeShare?.ended) || activeFeedback?.connection === 'ended'
  const railOpen = feedbackOpen && Boolean(activeShare)
  // Read while the talk is shared, rail open or not: the slide pane's markers come from it too.
  const feedback = useFeedbackList(activeTalk?.outlinePath ?? null, activeFeedback, Boolean(activeShare))
  const railSlides = useMemo<RailSlide[]>(
    () => (compiledSlides ?? []).map((row) => ({ slideId: row.slide_id, title: plainInlineText(row.nav_title || row.title), line: row.source_line ?? null })),
    [compiledSlides]
  )
  // Stopping the share (here or in another window) closes the rail with it.
  useEffect(() => { if (!activeShare) setFeedbackOpen(false) }, [activeShare])
  // Markers on the slide pane (ticket 06, frame 2): badges per slide, ghost rows for new slides.
  const feedbackMarkers = useMemo(
    () => (activeShare && feedback.list ? slideMarkers(feedback.list.items, (compiledSlides ?? []).map((row) => row.slide_id)) : null),
    [activeShare, feedback.list, compiledSlides]
  )
  // Opened from a marker, the rail sits beside the slide pane (frame 2); from the toolbar, it takes
  // the pane's slot (frame 1).
  const [railWithStrip, setRailWithStrip] = useState(false)
  const [feedbackFocus, setFeedbackFocus] = useState<FeedbackFocus | null>(null)
  const [feedbackBusy, setFeedbackBusy] = useState<string | null>(null)
  // The guard's refusal of an Accept is moot once its bar is answered.
  const diskHeld = diskGuard.change != null
  useEffect(() => {
    if (!diskHeld && feedback.error === DISK_CHANGED) feedback.setError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diskHeld])

  // Mirror the live outline up to App so the left sidebar's Outline/Slides views stay current.
  // App only passes the callback while the Slide-outline sidebar is visible (perf: a hidden
  // pane must not re-render App per keystroke); this effect re-fires when the callback
  // (re)attaches, so switching to the Slides tab pushes the current content immediately.
  useEffect(() => { onOutlineChange?.(outlineContent) }, [outlineContent, onOutlineChange])

  // The outline's collapsed sections are kept per talk, by section identity (lib/outlineCollapseStore.ts).
  // The store is told the text on every change, whichever view is showing, so the sidebar outline and the
  // grid agree and the state follows edits. Both read the talk's path, not its text.
  const collapseKey = activeTalk?.outlinePath ?? ''
  useEffect(() => { if (collapseKey) publishOutline(collapseKey, outlineContent) }, [collapseKey, outlineContent])
  // An explicit jump to a slide (strip, grid, search, doctor) opens the sections it sits in; typing and
  // arrow movement in the editor do not come through here.
  const revealSlideLine = (line: number | undefined | null): void => {
    if (collapseKey && line != null) revealLine(collapseKey, line, outlineContentRef.current)
  }

  // Same for the cursor line: the other call sites are imperative (cursor moves), so a
  // freshly attached consumer would show no current-slide highlight until the next move.
  useEffect(() => {
    activeLineReporter.forget()
    activeLineReporter.report(slideLines[activeSlideRef.current] ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onActiveLineChange])
  // The text or the slides changed (a move, a paste, typing above the caret, a compile): the caret may
  // be in another slide now, or its slide's heading on another line, with no caret movement to say so.
  // Worked out from where the caret IS in the buffer (lib/activeOutlineLine.ts).
  useEffect(() => {
    if (!onActiveLineChange) return
    const doc = editorReadRef.current?.()
    const line = doc && doc.path === activeTalk?.outlinePath ? lineOfOffset(doc.text, doc.caret) : cursorLineRef.current
    if (line != null) activeLineReporter.report(activeHeadingLine(slideLines, line))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slideLines])

  // Hand App a stable "flush the CURRENT editor's pending edit" fn. It always reaches the live editor
  // via editorCmdsRef (re-registered on each editor mount), so App can persist the outgoing talk's
  // edit before switching (data-loss guard, 2026-07-05). No-op when no debounced edit is pending.
  useEffect(() => {
    registerFlushSave?.(async () => { await editorCmdsRef.current?.flushSave() })
  }, [registerFlushSave])

  // Main-process writes of the talk open here (talk-writer.ts: "Add to talk", tags, frontmatter,
  // detach, image optimisation, the publish stamp and flush) come through THIS buffer: main reads it,
  // works out the change, then asks us to apply it only if the buffer has not moved on — through the
  // same D1 seam as every workspace mutation, so an unsaved edit is never overwritten and the next
  // autosave cannot undo the change. The reply is ok only once the save has reached the disk.
  useEffect(() => {
    // Optional-chained: the browser-only dev mock (tw-mock.ts) has no outline bridge.
    return window.tw.outline?.onEditorDocumentRequest?.(async (request) => {
      const mutator = outlineMutatorRef.current!
      if (request.kind === 'research-insert') {
        if (activeTalkRef.current?.outlinePath !== request.outlinePath) return { ok: false, error: 'Open this talk first.' }
        const ok = await insertResearchItem({ file: request.file }, request.slide)
        return ok ? { ok: true } : { ok: false, error: 'Research could not be inserted. Check the active talk.' }
      }
      if (request.kind === 'read') return mutator.readForMain(request.outlinePath)
      return mutator.applyFromMain(request.outlinePath, request.base, request.next, request.origin)
    })
  }, [])

  // Expose a jump-to-line to App: scroll/cursor the editor there AND sync the strip's active
  // card. Re-registered when the line→slide mapping changes so it always resolves correctly.
  useEffect(() => {
    registerJump?.((line: number, opts?: { takeFocus?: boolean }) => {
      setFocusLine({ line, takeFocus: opts?.takeFocus ?? true })
      handleCursorLine(line)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerJump, slideLines])

  // Persist the grid column count so it survives reloads.
  useEffect(() => {
    try {
      window.localStorage.setItem(GRID_COLS_STORAGE_KEY, String(gridColumns))
    } catch {
      // ignore persistence failures
    }
  }, [gridColumns])

  useEffect(() => {
    try { window.localStorage.setItem(PANE_STATE_STORAGE_KEY, paneState) } catch { /* ignore persistence failures */ }
  }, [paneState])

  useEffect(() => {
    try { window.localStorage.setItem(INSPECTOR_MODE_STORAGE_KEY, String(inspectorMode)) } catch { /* ignore persistence failures */ }
  }, [inspectorMode])

  // A pane-toggle picks a normal pane layout AND leaves grid mode. The Grid button
  // and ⌘4 are the only controls that enter grid mode. Both preserve the editor's scroll
  // position (it survives the reverse-portal reparent — see restoreEditorScroll) so switching
  // views keeps you where you were instead of snapping to the top.
  // Set when Enter/double-click in the grid sent you to the editor; the next Escape there
  // returns to the grid. One-shot, and any MANUAL view switch cancels it — after ⌘1/⌘4 the
  // user has chosen a view themselves, so Esc must not yank them back.
  const returnToGridRef = useRef(false)

  function selectPane(next: PaneState): void {
    returnToGridRef.current = false
    setGridMode(false)
    setPaneState(next)
    // The editor is on-screen in editor/both; scroll it to the current slide once the reparent settles.
    if (next === 'editor' || next === 'both') scrollEditorToCursor()
  }

  function selectGrid(): void {
    returnToGridRef.current = false
    setGridMode(true)
  }

  function toggleInspector(): void {
    returnToGridRef.current = false
    setGridMode(false)
    setGuideActive(false)
    setInspectorMode((current) => {
      const next = !current
      if (next) {
        const activeId = compiledSlidesRef.current?.[activeSlideRef.current]?.slide_id ?? null
        const resolved = resolveInspectedSlide(compiledSlidesRef.current, activeId, activeSlideRef.current)
        inspectedSlideIdRef.current = resolved.id
        inspectedSlideIndexRef.current = resolved.index
        setInspectedSlideId(resolved.id)
      }
      if (next && paneStateRef.current === 'editor') {
        setPaneState('both')
        scrollEditorToCursor()
      }
      return next
    })
  }

  // Global keyboard handler
  useEffect(() => {
    function isTypingTarget(t: EventTarget | null): boolean {
      if (!(t instanceof HTMLElement)) return false
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return true
      // CodeMirror edits a contentEditable div, not a textarea.
      if (t.isContentEditable) return true
      return !!t.closest('.cm-editor')
    }
    function handleGlobalKey(e: KeyboardEvent) {
      // ⌃/ toggles the keyboard-shortcuts list — works even WHILE typing in the editor (unlike
      // "?", which is a real character there). ⌘/ is deliberately left to CodeMirror's
      // toggle-comment. Capture-phase here means we see it before the editor's own keymap.
      if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === '/' || e.code === 'Slash')) {
        e.preventDefault()
        e.stopPropagation()
        setHelpOpen((prev) => !prev)
        commandRan('help')
        return
      }
      // Escape in the EDITOR returns to the grid — only as the one-shot bounce-back after
      // Enter/double-click on a grid card sent you there (returnToGridRef). Scoped to the
      // actual editing surface (.cm-content), so Esc in CodeMirror's search panel, an input,
      // or any overlay is untouched. Any manual view switch has already cleared the flag.
      if (
        e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey &&
        returnToGridRef.current &&
        e.target instanceof HTMLElement && e.target.closest('.cm-content')
      ) {
        e.preventDefault()
        e.stopPropagation()
        returnToGridRef.current = false
        setGridMode(true)
        return
      }
      // ? key for help — never while typing (incl. the CodeMirror editor).
      if (e.key === '?' && !isTypingTarget(e.target)) {
        e.preventDefault()
        setHelpOpen(prev => !prev)
        commandRan('help')
        return
      }
      // ⌘Z / ⌘⇧Z route to undo/redo when focus is OUTSIDE the editor (grid / slides / strip), so a
      // move made there is undoable without clicking into the editor first. When typing IN the
      // editor, CodeMirror's own history handles it — skip so we don't double-undo. One undo source in
      // every view, the grid included: CodeMirror's history (the editor stays mounted, hidden, in grid).
      if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z') && !isTypingTarget(e.target)) {
        e.preventDefault()
        e.stopPropagation()
        if (e.shiftKey) { editorCmdsRef.current?.redo(); commandRan('redo') }
        else { editorCmdsRef.current?.undo(); commandRan('undo') }
        return
      }
      for (const id of ['check-for-updates', 'whats-new', 'research-panel', 'research-find', 'set-aside-slides', 'search-slides-grid', 'search-next', 'search-previous'] as const) {
        if (surfaceKey(e, id)) { e.preventDefault(); e.stopPropagation(); runRegisteredCommand(id); return }
      }
      // ⇧⌘S (app.find-talk, rebindable): the same picker, with the cursor in Find a talk.
      if (surfaceKey(e, 'find-talk')) {
        e.preventDefault()
        e.stopPropagation()
        if (focusSlideRef.current != null) return
        runRegisteredCommand('find-talk')
        return
      }
      // ⌘S opens the Slide Browser (the Light Table; moved off ⌘K 2026-07-11 — the app autosaves,
      // so ⌘S was free). When it is ALREADY open, re-focus + select the search field instead of
      // toggling it closed — after arrowing into the grid the search blurs, and a second ⌘S should
      // return you to the query, not shut the overlay (Esc is the only close path).
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault()
        e.stopPropagation()
        // Don't stack the Slide Browser over Focus — swallow ⌘S while focused (Esc leaves Focus first).
        if (focusSlideRef.current != null) return
        if (browserOpenRef.current) browserFocusSearchRef.current?.()
        else setBrowserOpen(true)
        commandRan('search')
        return
      }
      // ⌘K = Actions here for the FOCUSED item (onboarding 0.38.1 ticket 03; it replaces the context
      // menu). Where the keyboard is decides what opens:
      // the Talks panel gets Actions here for its row (TalkList); the grid/strip gets it for the
      // selected slide; the EDITOR gets it at the caret. Anywhere else — text fields outside
      // CodeMirror, or with an overlay covering the workspace — the key is NOT swallowed, so any other binding still sees it. preventDefault
      // only when we acted.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === 'k' || e.key === 'K')) {
        const overlayOpen = overlayOpenRef.current || focusSlideRef.current != null
        if (!overlayOpen) {
          const active = document.activeElement
          // Editor owns focus → Actions here at the caret. Deliberately BEFORE the isTypingTarget
          // guard: CodeMirror is a typing target, but an ordinary text INPUT outside it still
          // falls through unswallowed.
          if (
            activeTalkRef.current &&
            e.target instanceof HTMLElement && e.target.closest('.cm-content') &&
            active instanceof HTMLElement && active.closest('.cm-content')
          ) {
            e.preventDefault()
            e.stopPropagation()
            openActionsHereRef.current({ region: 'editor' })
            commandRan('app.context-menu')
            return
          }
          if (!isTypingTarget(e.target)) {
            if (active instanceof HTMLElement && active.closest('.tl-panel')) {
              e.preventDefault()
              e.stopPropagation()
              window.dispatchEvent(new Event('tw-context-menu'))
              commandRan('app.context-menu')
              return
            }
            // The Slide outline: Actions here for its selected row (a slide or a section), opened at the
            // row. The row's slide becomes the selected slide first, as a click on its card would make
            // it, so every action in the panel acts on that row. (The outline's search box is a typing
            // target and never gets here.)
            if (activeTalkRef.current && !gridModeRef.current && active instanceof HTMLElement && active.closest('[data-slides-organizer]')) {
              e.preventDefault()
              e.stopPropagation()
              const line = getOutlineSelection()
              let at: { x: number; y: number } | undefined
              if (line != null) {
                const index = slideIndexAtLine(slideLinesRef.current, line)
                if (index >= 0) { activeSlideRef.current = index; selectSlideRef.current(index) }
                const box = document.querySelector(`[data-slides-organizer] [data-line="${line}"]`)?.getBoundingClientRect()
                if (box) at = { x: box.left + 24, y: box.bottom }
              }
              if (!at) { const box = active.closest('[data-slides-organizer]')!.getBoundingClientRect(); at = { x: box.left + 24, y: box.top + 56 } }
              openActionsHereRef.current({ region: 'strip', at })
              commandRan('app.context-menu')
              return
            }
            // The strip or the grid: Actions here for the selected slide.
            if (activeTalkRef.current && (gridModeRef.current || (active instanceof HTMLElement && active.closest('[data-place-region="strip"]')))) {
              e.preventDefault()
              e.stopPropagation()
              openActionsHereRef.current({ region: 'strip' })
              commandRan('app.context-menu')
              return
            }
          }
        }
        // fall through — not ours here
      }
      // ⌘I opens the ICON picker (pins a glyph to the caret's bullet); ⌘⇧I opens or closes the image
      // drawer. Swapped 2026-06-23 (⌘⇧K was confusing for icons). Capture + stopPropagation so
      // the editor never also sees the keystroke. (Neither is a CodeMirror default.)
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === 'i' || e.key === 'I')) {
        e.preventDefault()
        e.stopPropagation()
        toggleIconPickerRef.current()
        commandRan('icon-picker')
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'i' || e.key === 'I')) {
        e.preventDefault()
        e.stopPropagation()
        toggleImageDrawerRef.current()
        commandRan('image')
        return
      }
      // ⌘L opens the LAYOUT picker (replaces the old `/` auto-popup, which left stray slashes). It
      // places the chosen trigger on the current slide's Trigger line via the editor's layout channel.
      // F5 launches the presenter view for the current talk (uses refs — the handler has deps []).
      // ⇧F5 starts the presenter on the slide you're currently on (present-from-here); plain F5
      // starts at the top. An unstamped current slide has no {id=…} to deep-link to, so ⇧F5 falls
      // back to the top with a hint rather than silently starting elsewhere.
      if (e.key === 'F5' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        e.stopPropagation()
        const content = outlineContentRef.current
        if (blockedByUnresolved(content)) return
        const t = activeTalkRef.current
        if (t) {
          commandRan(e.shiftKey ? 'present-from-here' : 'present-presenter')
          let startSlideId: string | undefined
          if (e.shiftKey) {
            startSlideId = currentSlideId() ?? undefined
            if (!startSlideId) notify('This slide isn’t stamped yet — starting from the top. Save the outline to enable present-from-here.', 'info')
          }
          void window.tw.talk
            .present(t.outlinePath, content, 'presenter', startSlideId)
            .then((r) => { if (r && r.success === false) notify('Present failed: ' + (r.error || 'unknown error'), 'error') })
        }
        return
      }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === 'l' || e.key === 'L')) {
        e.preventDefault()
        e.stopPropagation()
        openLayoutPicker()
        commandRan('layout')
        return
      }
      // ⌘⇧U opens the where-used & versions panel for the current slide (ADR-0032 ledger MVP). In Slide
      // Focus the where-used strip is already on-screen, so the panel is redundant — swallow it there.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'u' || e.key === 'U')) {
        e.preventDefault()
        e.stopPropagation()
        if (focusSlideRef.current != null) return
        openWhereUsed()
        commandRan('where-used')
        return
      }
      // ⌘⌥⇧F focuses the current slide (Slide Focus; it was ⌘⇧F, which every app keeps for "Search
      // everything"). ⌘F stays CodeMirror's find. No-op if already in Focus. Uses refs (handler deps []).
      if ((e.metaKey || e.ctrlKey) && e.altKey && e.shiftKey && e.code === 'KeyF') {
        e.preventDefault()
        e.stopPropagation()
        if (focusSlideRef.current == null) { enterFocusRef.current(activeSlideRef.current); commandRan('focus-slide') }
        return
      }
      // ⌘⇧P opens the command palette (all app commands). Capture + stopPropagation. Routes
      // through the SAME registered handler the Tools menu's "All commands…" uses — one toggle
      // path, no drift.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault()
        e.stopPropagation()
        runRegisteredCommand('app.command-palette')
        return
      }
      // ⌘P uses the same registered dispatch channel as Deck → Inspector and the command palette.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault()
        e.stopPropagation()
        runRegisteredCommand('toggle-inspector')
        return
      }
      // ⌘N (New Window — work on two presentations at once) is now owned by the File-menu
      // accelerator in main (installApplicationMenu), so it is discoverable and works from any
      // focus. The old renderer keydown was removed 2026-07-19 to avoid a double-open.
      // ⌘1/2/3 for pane switching (also clears grid mode); ⌘4 enters the grid. All preserve the
      // editor's scroll position rather than snapping to the top.
      if ((e.metaKey || e.ctrlKey) && e.key === '1') { e.preventDefault(); selectPane('editor'); commandRan('view-editor') }
      if ((e.metaKey || e.ctrlKey) && e.key === '2') { e.preventDefault(); selectPane('both'); commandRan('view-both') }
      if ((e.metaKey || e.ctrlKey) && e.key === '3') { e.preventDefault(); selectPane('strip'); commandRan('view-strip') }
      if ((e.metaKey || e.ctrlKey) && e.key === '4') { e.preventDefault(); selectGrid(); commandRan('view-grid') }
    }
    window.addEventListener('keydown', handleGlobalKey, { capture: true })
    return () => window.removeEventListener('keydown', handleGlobalKey, { capture: true })
  }, [])

  useEffect(() => window.tw.app?.onCommand?.(runRegisteredCommand), [runRegisteredCommand])
  // The menu bar (generated from the command registry, 0.42) sends a command's id: run as its palette row runs it.
  useEffect(() => window.tw.app?.onRunCommand?.((id) => {
    const command = COMMAND_REGISTRY.find((c) => c.id === id && !c.surface)
    if (command) runListedCommand(command)
  }), [runListedCommand])
  // Every report of a command run says which talk this window is in, so main can tell the example vault
  // (commands that delete tick only there: lock decision 12).
  useEffect(() => setCommandRanContext(() => ({ outlinePath: activeTalkRef.current?.outlinePath ?? null })), [])

  // Right-click and the Menu key open Actions here, the same panel as ⌘K (ticket 03); the native menu
  // is suppressed. Inside the editing surface a right-click first moves the caret to the clicked
  // position, so "here" is the line under the pointer; the Menu key opens at the caret. A right-click
  // on a card in the strip or the grid selects that slide and opens the panel for it. In Slide Focus
  // or under an overlay we leave the event alone. useDismiss's arming fix means the very contextmenu
  // gesture that opens the panel cannot also dismiss it.
  useEffect(() => {
    function onContextMenu(e: MouseEvent): void {
      const t = e.target
      if (!(t instanceof HTMLElement)) return
      if (!activeTalkRef.current) return
      if (overlayOpenRef.current || focusSlideRef.current != null) return
      if (t.closest('.cm-content')) {
        e.preventDefault()
        e.stopPropagation()
        if (e.button === 2) {
          editorCmdsRef.current?.placeCursorAtCoords(e.clientX, e.clientY)
          openActionsHereRef.current({ region: 'editor', at: { x: e.clientX, y: e.clientY } })
        } else {
          openActionsHereRef.current({ region: 'editor' })
        }
        return
      }
      // The grid opens its own slide and section menus (GridView, SlideRowMenus); its More actions… row comes back here.
      if (t.closest('[data-view="grid"]')) return
      const card = t.closest<HTMLElement>('[data-place-region="strip"] [data-slide-index]')
      if (card) {
        e.preventDefault()
        e.stopPropagation()
        const index = Number(card.getAttribute('data-slide-index'))
        if (Number.isInteger(index)) {
          activeSlideRef.current = index
          selectSlideRef.current(index)
        }
        openActionsHereRef.current({ region: 'strip', at: e.button === 2 ? { x: e.clientX, y: e.clientY } : undefined })
      }
    }
    window.addEventListener('contextmenu', onContextMenu, { capture: true })
    return () => window.removeEventListener('contextmenu', onContextMenu, { capture: true })
  }, [])

  // Closing Actions here (Escape, a click outside) returns the keyboard to where it was.
  const actionsHereRef = useRef(actionsHere)
  actionsHereRef.current = actionsHere
  const closeActionsHere = useCallback((): void => {
    const target = actionsHereRef.current?.returnTo
    setActionsHere(null)
    if (target && target.isConnected) target.focus()
    requestAnimationFrame(() => {
      // A panel opened again before this frame ran owns the focus now (its filter box); this late
      // refocus would take it, and the typed text would land in the editor.
      if (actionsHereRef.current) return
      if (target && target.isConnected) target.focus()
      else (document.querySelector('.cm-content') as HTMLElement | null)?.focus()
    })
  }, [])

  // Running a row is running the command: a registry command goes the palette's route
  // (runListedCommand); a carried row (no registry command) has its handler in
  // runCarriedActionRow. Focus goes back first, so a command that works on the caret finds it.
  const runActionRow = useCallback((row: ActionRow): void => {
    const target = actionsHere?.returnTo
    setActionsHere(null)
    if (target && target.isConnected) target.focus()
    else (document.querySelector('.cm-content') as HTMLElement | null)?.focus()
    if (row.commandId) {
      const command = COMMAND_REGISTRY.find((candidate) => candidate.id === row.commandId)
      if (command) runListedCommand(command)
      return
    }
    runCarriedActionRowRef.current(row.key)
  }, [actionsHere, runListedCommand])
  // The keyboard sheet's Run action: the same route as a row of Actions here (ticket 04).
  const runSheetRow = useCallback((row: SheetRow): void => {
    const target = document.querySelector<HTMLElement>('.cm-content')
    target?.focus()
    if (row.commandId) {
      const command = COMMAND_REGISTRY.find((candidate) => candidate.id === row.commandId)
      if (command) runListedCommand(command)
      return
    }
    runCarriedActionRowRef.current(row.key)
  }, [runListedCommand])
  const sheetCanRunCarried = useCallback((key: string): boolean => key === 'explain-rendering' || key === 'present-from-here' || key === 'slide-cut' || key === 'slide-copy' || key === 'slide-paste-after', [])
  const openPaletteWith = useCallback((query: string): void => {
    setActionsHere(null)
    setCmdMenuQuery(query)
    setCmdMenuOpen(true)
  }, [])
  // The Talks panel hosts its own Actions here (TalkList): its All commands… row and the rows that
  // are plain registry commands come back here.
  useEffect(() => {
    const onPalette = (event: Event): void => openPaletteWith(String((event as CustomEvent<string>).detail ?? ''))
    const onRun = (event: Event): void => {
      const command = COMMAND_REGISTRY.find((candidate) => candidate.id === (event as CustomEvent<string>).detail)
      if (command) runListedCommand(command)
    }
    window.addEventListener('tw-open-palette', onPalette)
    window.addEventListener('tw-run-command', onRun)
    return () => {
      window.removeEventListener('tw-open-palette', onPalette)
      window.removeEventListener('tw-run-command', onRun)
    }
  }, [openPaletteWith, runListedCommand])

  // Slide context menu → the existing handlers, verbatim. The menu closes first; actions that
  // stay in the editor hand focus back so the keyboard flow is unbroken.
  function handleSlideMenuAction(action: SlideMenuAction): void {
    setSlideMenu(null)
    const reported = SLIDE_MENU_COMMANDS[action]
    if (reported) commandRan(reported)
    switch (action) {
      case 'layout': openLayoutPicker(); break
      case 'icon': setIconPickerOpen(true); break
      case 'image': openImageDrawer(); break
      case 'tag': openTagCurrentSlide(); break
      case 'insert-table': editorInsertObjectRef.current?.('table'); break
      case 'insert-mindmap': editorInsertObjectRef.current?.('mindmap'); break
      case 'insert-chart': editorInsertObjectRef.current?.('chart'); break
      case 'insert-mermaid': editorInsertObjectRef.current?.('mermaid'); break
      case 'insert-diagram': editorInsertObjectRef.current?.('diagram'); break
      case 'insert-svg': editorInsertObjectRef.current?.('svg'); break
      case 'fmt-bold': editorCmdsRef.current?.runFormat('bold'); break
      case 'fmt-italic': editorCmdsRef.current?.runFormat('italic'); break
      case 'fmt-code': editorCmdsRef.current?.runFormat('inline-code'); break
      case 'fmt-highlight': editorCmdsRef.current?.runFormat('highlight'); break
      case 'fmt-strikethrough': editorCmdsRef.current?.runFormat('strikethrough'); break
      case 'fmt-underline': editorCmdsRef.current?.runFormat('underline'); break
      case 'fmt-link': editorCmdsRef.current?.runFormat('link'); break
      case 'focus': enterFocusRef.current(activeSlideRef.current); break
      case 'where-used': openWhereUsed(); break
      case 'explain': setExplainIndex(activeSlideRef.current); break
      case 'present-here': void presentFromHere(); break
      case 'delete': handleDeleteSlide(); focusEditor(); break
      case 'cut': editorCmdsRef.current?.cutSelection(); break
      case 'copy': editorCmdsRef.current?.copySelection(); break
      case 'paste': editorCmdsRef.current?.pasteClipboard(); break
    }
  }

  // The rows Actions here carries over from the old context menu that no registry command runs
  // (shared/actions-here.ts CARRIED_ROWS, the slide places): same handlers as before.
  function runCarriedActionRow(key: string): void {
    switch (key) {
      case 'explain-rendering': handleSlideMenuAction('explain'); break
      case 'present-from-here': handleSlideMenuAction('present-here'); break
      case 'slide-cut': runSlideClipboardRow('cut'); break
      case 'slide-copy': runSlideClipboardRow('copy'); break
      case 'slide-paste-after': runSlideClipboardRow('paste'); break
      case 'cut': handleSlideMenuAction('cut'); break
      case 'copy': handleSlideMenuAction('copy'); break
      case 'paste': handleSlideMenuAction('paste'); break
    }
  }
  const runCarriedActionRowRef = useRef(runCarriedActionRow)
  runCarriedActionRowRef.current = runCarriedActionRow
  const selectSlideRef = useRef<(i: number) => void>(() => undefined)

  // ⌘E in a live deck window (presenter or presentation window) jumps this editor to that slide.
  // Main forwards the deck's current slide — its stable ledger id AND its compiled index — and brings
  // this window to the front. We resolve to a source line by {id=…} first (survives reorders), then
  // fall back to the compiled index via slideLines. If neither resolves in the current outline (e.g.
  // the editor has since switched to another talk), it is a safe no-op. Reads/uses refs + stable
  // setters only, so the deps-[] subscription always acts on the live outline.
  useEffect(() => {
    const off = window.tw.present?.onEditSlide?.(({ slideId, index }) => {
      let line: number | null = null
      if (slideId) {
        const lines = outlineContentRef.current.split('\n')
        const needle = `{id=${slideId}}`
        const at = lines.findIndex((l) => l.includes(needle))
        if (at >= 0) {
          for (let j = at; j >= 0; j--) { if (/^#{1,6}\s/.test(lines[j])) { line = j + 1; break } }
        }
      }
      if (line == null && typeof index === 'number' && index >= 0) line = slideLinesRef.current[index] ?? null
      if (line == null) return
      // Leave Focus + grid, make sure the editor is on-screen (strip-only hides it), then jump.
      // setFocusLine drives the Editor's scroll-to-line + focus; the cursor move re-syncs the strip.
      setFocusSlide(null)
      setFocusRange(null)
      setGridMode(false)
      setPaneState((p) => (p === 'strip' ? 'both' : p))
      setFocusLine({ line, takeFocus: true })
    })
    return off
  }, [])

  // ⌘R in a deck window (refresh-in-place): main asks the editor for the talk's CURRENT content so
  // the reload includes an unsaved fix. If the deck is the talk we're editing, use the live in-memory
  // outline; otherwise read that talk from disk. rebuild() recompiles + reloads the deck at its slide.
  useEffect(() => {
    const off = window.tw.present?.onRefresh?.(async ({ outlinePath, slideId, deckWcId }) => {
      let content: string | null = null
      if (activeTalkRef.current?.outlinePath === outlinePath) {
        // Flush any pending debounced save first, then use the live buffer — the freshest text.
        await editorCmdsRef.current?.flushSave()
        content = outlineContentRef.current
      } else {
        content = await window.tw.talk.readOutline(outlinePath)
      }
      if (content == null) {
        notify('This talk could not be opened: it is not in your current vault, or its file could not be read.', 'warning', 'talk-not-read')
        return
      }
      if (blockedByUnresolved(content)) return
      await window.tw.present.rebuild(deckWcId, outlinePath, content, slideId)
    })
    return off
  }, [])

  // Reset per-talk state when talk changes. Also drops any active Focus — switching talks must
  // never leave the scoped editor pointing at the previous talk's offsets.
  useEffect(() => {
    setCompiledSlides(null)
    compiledSourceRef.current = null
    setTriggerFindings([])
    setThumbnails(null)
    thumbnailRowsRef.current = null
    setPreviewsPending(false)
    compileImmediatelyRef.current = false
    compileAttemptedRef.current = false
    // Also drop the previous talk's text: until the new outline loads, SlideStrip falls back to
    // parseSlides(outlineContent) — the OLD talk's cards briefly rendered under the NEW talk's title.
    setOutlineContent('')
    setActiveSlide(0)
    inspectedSlideIndexRef.current = 0
    setInspectedSlideId(null)
    setDirty(false) // pending edits were flushed at the switch boundary
    setFocusLine(null)
    setFocusSlide(null)
    setFocusRange(null)
    // Clear the outline sidebar's follow-cursor highlight so it doesn't linger on the previous
    // talk's line until the first cursor move in the new talk.
    activeLineReporter.report(null)
  }, [activeTalk?.outlinePath])

  // Typing waits for a pause. Opening a talk and deliberate grid/slide mutations compile on the
  // next turn, so a move does not spend 900ms showing its old order. Thumbnail work stays separate.
  useEffect(() => {
    if (!activeTalk || !outlineContent) return
    let cancelled = false
    let stopProgress: (() => void) | undefined
    const outlinePath = activeTalk.outlinePath
    const requestId = crypto.randomUUID()
    if (compileTimer.current) clearTimeout(compileTimer.current)
    const pause = gridModeRef.current || compileImmediatelyRef.current || !compileAttemptedRef.current ? 0 : OUTLINE_PAUSE_MS
    compileTimer.current = setTimeout(async () => {
      compileAttemptedRef.current = true
      compileImmediatelyRef.current = false
      // setCompiling belongs INSIDE the timer: calling it per keystroke forced a full
      // WorkspaceLayout re-render on every character typed during the debounce window.
      setCompiling(true)
      setPreviewsPending(true)
      const slides = await window.tw.talk.compile(outlinePath, outlineContent)
      const current = editorReadRef.current?.()
      if (cancelled || activeTalkRef.current?.outlinePath !== outlinePath ||
          (current?.path === outlinePath && current.text !== outlineContent)) return
      // Surface a compile failure instead of silently showing the client-side fallback strip.
      if (slides === null) {
        notify('Couldn’t compile this talk — the html-presentations compiler wasn’t found or errored. Slides/previews won’t update.', 'error', 'compile-fail')
      } else {
        // The error toast is persistent — clear it once a compile succeeds again, so it can't
        // keep accusing a talk that has since recovered.
        dismissToast('compile-fail')
      }
      const previousRows = thumbnailRowsRef.current
      thumbnailRowsRef.current = slides
      setThumbnails((pictures) => retainMatchingThumbnails(pictures, previousRows, slides))
      compiledSourceRef.current = slides ? outlineContent : null
      setCompiledSlides(slides)
      setTriggerFindings(slides === null
        ? []
        : attributeOrphanedTriggerFindings(outlineContent, slides, scanOutlineTriggers(outlineContent, undefined, { strandedTitleIcons: true })))
      setCompiling(false)
      // Thumbnails: do not block the strip. A null map = the render couldn't run at all.
      stopProgress = window.tw.talk.onThumbnailProgress?.((update) => {
        if (cancelled || update.requestId !== requestId || update.outlinePath !== outlinePath) return
        setThumbnails((pictures) => ({ ...pictures, ...update.thumbnails }))
      })
      window.tw.talk
        .thumbnails(outlinePath, outlineContent, { requestId })
        .then((map) => {
          if (cancelled) return
          setThumbnails(map)
          if (map && slides && slides.length) {
            // Slides whose preview couldn't render (e.g. an image too slow to decode) are NOT cached
            // — surface the count so a blank strip card isn't a silent mystery.
            const missing = slides.filter((s) => s.content_hash && !(map[s.render_hash || ''] || map[s.content_hash || ''])).length
            if (missing > 0) notify(`${missing} slide preview${missing === 1 ? '' : 's'} couldn’t render — use the Refresh button to retry.`, 'warning', 'thumb-missing')
          }
        })
        .catch(() => { if (cancelled) return; setThumbnails(null); notify('Slide previews failed to render.', 'warning', 'thumb-missing') })
        .finally(() => { stopProgress?.(); if (!cancelled) setPreviewsPending(false) })
    }, pause)
    return () => {
      cancelled = true
      stopProgress?.()
      if (compileTimer.current) clearTimeout(compileTimer.current)
    }
  }, [outlineContent, activeTalk?.outlinePath, thumbnailRefresh])

  // Word count effect
  useEffect(() => {
    setWordCount(outlineContent.split(/\s+/).filter(Boolean).length)
  }, [outlineContent])

  function blockedByUnresolved(content: string): boolean {
    const block = unresolvedTriggerBlock(content)
    if (!block) return false
    setUnresolvedBlock({
      count: block.count,
      firstTitle: block.first.slideTitle,
      firstLine: block.first.headingLine,
      message: block.message
    })
    return true
  }

  async function handlePresent(mode: 'window' | 'presenter' | 'audience' = 'window') {
    if (!activeTalk || !outlineContent) return
    if (blockedByUnresolved(outlineContent)) return
    const result = await window.tw.talk.present(activeTalk.outlinePath, outlineContent, mode)
    if (result && result.success === false) notify('Present failed: ' + (result.error || 'unknown error'), 'error')
  }

  // Presenter view starting on the slide you're currently on (⇧F5 / Present menu). An unstamped
  // current slide has no {id=…} to deep-link to, so it falls back to the top with a hint.
  async function presentFromHere() {
    if (!activeTalk || !outlineContent) return
    if (blockedByUnresolved(outlineContent)) return
    const id = currentSlideId()
    if (!id) notify('This slide isn’t stamped yet — starting from the top. Save the outline to enable present-from-here.', 'info')
    const result = await window.tw.talk.present(activeTalk.outlinePath, outlineContent, 'presenter', id ?? undefined)
    if (result && result.success === false) notify('Present failed: ' + (result.error || 'unknown error'), 'error')
  }

  // The ⌘L layout picker, also reachable from the toolbar Insert → Layout. A bare trigger lands on
  // the slide's Trigger line; a multi-line template is spliced as a new block at the caret.
  //
  // ADR-0032: the picker is the Inspector column, so opening it brings that column up (slides beside the
  // outline, not the grid, not Focus) and aims it at the Inspector's slide, or at the caret's slide when the
  // Inspector is not showing. Pressed again, it closes and the slide is as it was.
  const closeLayoutPicker = useCallback((): void => {
    setLayoutPicker(null)
    setPickerTry(null)
    focusEditor()
  }, [])
  function openLayoutPicker(query = ''): void {
    if (layoutPickerRef.current && !query) { closeLayoutPicker(); return }
    const doc = editorReadRef.current?.()
    if (!doc) return
    const read = readOutlineSlides(doc.text)
    const inspectorShowing = inspectorMode && paneState !== 'editor' && !gridMode && !railOpen
    const caretLine = doc.text.slice(0, doc.caret).split('\n').length - 1
    const byCaret = [...read.slides].reverse().find((candidate) => candidate.start <= caretLine)
    const byInspector = inspectorShowing && inspectedSlideIdRef.current
      ? read.slides.find((candidate) => candidate.id === inspectedSlideIdRef.current)
      : undefined
    const target = byInspector ?? byCaret
    if (!target) { notify('Put the cursor on a slide first: the layout picker changes the slide you are on.', 'info', 'layout-picker'); return }
    if (focusSlideRef.current != null) exitFocus()
    if (gridModeRef.current) setGridMode(false)
    if (paneStateRef.current === 'editor') setPaneState('both')
    if (feedbackOpen) setFeedbackOpen(false)
    setGuideActive(false)
    setInspectorMode(true)
    // The Inspector previews the slide the picker acts on, stamped or not (an unstamped one is found by its heading line).
    const index = target.id
      ? compiledSlides?.findIndex((row) => row.slide_id === target.id) ?? -1
      : slideLinesRef.current.findIndex((line) => line === target.line)
    const inspectId = target.id || (index >= 0 ? compiledSlides?.[index]?.slide_id ?? null : null)
    if (inspectId) {
      inspectedSlideIdRef.current = inspectId
      if (index >= 0) inspectedSlideIndexRef.current = index
      setInspectedSlideId(inspectId)
    }
    setPickerTry(null)
    setLayoutPicker({ slide: target.id ? target.id : { headingLine: target.line }, slideId: target.id || null, query, anchor: doc.text })
  }

  // ↵ in the picker: the slide's Trigger line is rewritten by the set-layout verb, in one undoable change in
  // the editor's own buffer (the one-writer seam), and the column becomes the Inspector at that layout.
  function keepPickedLayout(layout: string, withStarterText: boolean): void {
    const picker = layoutPickerRef.current
    const doc = editorReadRef.current?.()
    if (!picker || !doc) return
    let written: string
    try {
      const write = setLayout(doc.text, reanchorPickerSlide(picker.anchor, doc.text, picker.slide) ?? picker.slide, layout, [], withStarterText)
      written = write.outline
      // What the merge set aside (a second id in the Trigger block) goes where the editor's ↵ reports it.
      reportTriggerMergeWarnings(write.warnings)
    } catch (error) {
      notify(error instanceof LayoutVerbError ? error.detail : 'That layout could not be applied.', 'warning', 'layout-picker')
      return
    }
    inspectorCommitInProgressRef.current = true
    try {
      if (written !== doc.text) editorReplaceRef.current?.(written)
    } finally {
      queueMicrotask(() => { inspectorCommitInProgressRef.current = false })
    }
    closeLayoutPicker()
  }

  // ── Plain margin menus (spec T8, T9) ──────────────────────────────────────────────────────────
  // They act on the heading whose label was opened, not on the caret's. A choice is one undoable buffer
  // change through the same replace path as the picker's ↵; the caret then sits at the end of that
  // heading's visible text, which also points the preview and the Inspector at that slide.
  function openMarginMenu(kind: 'level' | 'layout', line: number, anchor: { left: number; bottom: number }): void {
    setMarginMenu({ kind, line, anchor: { left: anchor.left, bottom: anchor.bottom } })
  }
  function openMarginMenuAtCaret(kind: 'level' | 'layout'): void {
    const target = headingToolsRef.current?.caretHeading()
    const doc = editorReadRef.current?.()
    if (!target || !doc) { notify('Put the cursor on a heading first.', 'info', 'margin-menu'); return }
    if (kind === 'layout' && marginLabels(compiledSlidesRef.current, doc.text).find((l) => l.line === target.line)?.layoutLabel === undefined) {
      notify('Put the cursor on a slide first: the layout belongs to a slide.', 'info', 'margin-menu')
      return
    }
    openMarginMenu(kind, target.line, target.anchor)
  }
  function closeMarginMenu(): void { setMarginMenu(null) }
  function marginMenuEscape(): void {
    const line = marginMenu?.line
    setMarginMenu(null)
    if (line) headingToolsRef.current?.focusHeading(line)
  }
  function writeFromMargin(written: string, line: number): void {
    const doc = editorReadRef.current?.()
    if (!doc) return
    inspectorCommitInProgressRef.current = true
    try {
      if (written !== doc.text) editorReplaceRef.current?.(written)
    } finally {
      queueMicrotask(() => { inspectorCommitInProgressRef.current = false })
    }
    setMarginMenu(null)
    headingToolsRef.current?.focusHeading(line)
  }
  function chooseMarginLevel(kind: HeadingKind, line: number): void {
    const doc = editorReadRef.current?.()
    if (!doc) return
    writeFromMargin(setHeadingKind(doc.text, line, kind), line)
  }
  function chooseMarginLayout(name: string | null, line: number): void {
    const doc = editorReadRef.current?.()
    if (!doc) return
    // Auto removes the written layout; a layout is set as the picker's click sets it: no options, no starter text.
    // The verb answers ok only for a result it has read back through the compiler; otherwise nothing is written.
    let write: ReturnType<typeof chooseLayout>
    try {
      write = name == null ? clearLayout(doc.text, { headingLine: line }) : chooseLayout(doc.text, { headingLine: line }, name)
    } catch (error) {
      setMarginMenu(null)
      notify(error instanceof LayoutVerbError ? error.detail : 'That layout could not be applied.', 'warning', 'margin-menu')
      headingToolsRef.current?.focusHeading(line)
      return
    }
    if (!write.ok) {
      setMarginMenu(null)
      notify(write.detail || 'That layout could not be applied.', 'warning', 'margin-menu')
      headingToolsRef.current?.focusHeading(line)
      return
    }
    reportTriggerMergeWarnings(write.warnings)
    const written = write.text
    writeFromMargin(written, line)
  }
  function moreInInspector(line: number): void {
    setMarginMenu(null)
    headingToolsRef.current?.focusHeading(line)
    openLayoutPicker()
  }
  const marginMenuView = (() => {
    if (!marginMenu) return null
    const doc = editorReadRef.current?.()
    if (!doc) return null
    const { kind, line, anchor } = marginMenu
    if (kind === 'level') {
      const rows = levelMenuFor(doc.text, line).map((item) => ({ key: item.kind, label: item.label, note: item.note, current: item.current }))
      if (!rows.length) return null
      return <MarginMenu title="Level" ariaLabel="Heading level" rows={rows} anchor={anchor}
        onChoose={(key) => chooseMarginLevel(key as HeadingKind, line)} onClose={closeMarginMenu} onEscape={marginMenuEscape} />
    }
    const current = marginLabels(compiledSlidesRef.current, doc.text).find((l) => l.line === line)?.layoutLabel
    const rows = [
      { key: 'auto', label: 'Auto', note: 'TalkWeaver picks the layout', current: current === 'Auto' },
      ...MARGIN_LAYOUT_NAMES.map((name) => {
        const label = LAYOUTS.find((entry) => entry.name === name)?.label ?? name
        return { key: name, label, current: current === label }
      })
    ]
    return <MarginMenu title="Layout" ariaLabel="Slide layout" rows={rows} separatorsAfter={['auto']} more="More in Inspector…" anchor={anchor}
      onChoose={(key) => key === MORE_IN_INSPECTOR_KEY ? moreInInspector(line) : chooseMarginLayout(key === 'auto' ? null : key, line)}
      onClose={closeMarginMenu} onEscape={marginMenuEscape} />
  })()

  // An unstamped slide is named by its heading line, and the save that stamps ids inserts lines above it:
  // follow the slide through the change so the open picker keeps pointing at it (it used to close itself).
  const pickerSlide = useMemo(
    (): SlideRef | null => (layoutPicker ? reanchorPickerSlide(layoutPicker.anchor, outlineContent, layoutPicker.slide) ?? layoutPicker.slide : null),
    [layoutPicker, outlineContent]
  )
  const pickerTryOutline = useMemo((): string | null => {
    if (!layoutPicker || !pickerSlide || !pickerTry) return null
    try { return previewLayout(outlineContent, pickerSlide, pickerTry) } catch { return null }
  }, [layoutPicker, pickerSlide, pickerTry, outlineContent])

  // The picker belongs to one slide: moving the Inspector to another (⌥↑ ⌥↓, a click in the strip) closes it.
  useEffect(() => {
    if (layoutPicker?.slideId && inspectedSlideId && inspectedSlideId !== layoutPicker.slideId) {
      setLayoutPicker(null)
      setPickerTry(null)
    }
  }, [inspectedSlideId, layoutPicker])
  // ...and so does the talk it was opened on.
  useEffect(() => { setLayoutPicker(null); setPickerTry(null) }, [activeTalk?.outlinePath])

  async function handleBuild() {
    if (!activeTalk || !outlineContent) return
    if (blockedByUnresolved(outlineContent)) return
    setBuildStatus('building')
    const result = await window.tw.talk.buildVariants(activeTalk.outlinePath, outlineContent)
    if (result?.success) {
      setBuildStatus('done')
      // Report the primary (first) output variant in the build chip, and reveal it in Finder so the
      // file can be copied/moved (opening it in a browser only lets you view it).
      const out = result.outPaths?.[0] ?? null
      setBuildPath(out)
      if (out) window.tw.shell.showInFolder(out)
      notify('Built HTML presentation — revealed in Finder.', 'success')
    } else {
      setBuildStatus('error')
      notify('Build failed: ' + (result?.error || 'unknown error'), 'error')
    }
  }

  // Export the audience handout (share-no-notes reading HTML) and REVEAL it in Finder (so the file
  // can be copied/moved). Reuses the build chip for progress/result.
  async function handleExportHandout() {
    if (!activeTalk || !outlineContent) return
    if (blockedByUnresolved(outlineContent)) return
    setBuildStatus('building')
    const result = await window.tw.talk.exportHandout(activeTalk.outlinePath, outlineContent)
    if (result?.success && result.path) {
      setBuildStatus('done')
      setBuildPath(result.path)
      window.tw.shell.showInFolder(result.path)
      notify('Handout exported — revealed in Finder.', 'success')
    } else {
      setBuildStatus('error')
      notify('Handout export failed: ' + (result?.error || 'unknown error'), 'error')
    }
  }

  // Publish handout as the toolbar, menu and palette ask for it. A talk that names a pre-work or post-work file
  // first shows the notice that work files go out with a Run (ticket 23); a talk naming neither publishes at once.
  async function requestPublishHandout() {
    if (publishingRef.current || !activeTalk || !outlineContent) return
    const names = readTalkWorkNames(outlineContent)
    if (!names.prework && !names.postwork) { void handlePublishHandout(); return }
    if (blockedByUnresolved(outlineContent)) return
    const listing = await window.tw.workFiles.list(activeTalk.vaultId).catch(() => null)
    // No listing (no vault, or the work files could not be read): the strips draw nothing either, so the dialog is as in 0.39.
    const notice = listing ? publishWorkNotice(names, listing.items) : null
    // `true` / `false` (the 0.39 switch) name no file: nothing to say.
    if (!notice) { void handlePublishHandout(); return }
    setPublishWorkNoticeText(notice)
  }

  // Publish the handout to the user's Cloudflare Pages site (Settings → Publishing). The publisher
  // STAMPS handout_url into the outline. For the talk open here main stamps this window's BUFFER
  // (talk-writer.ts routes it through the D1 seam), never the file behind it; the stamp is then
  // adopted by stamping the buffer as it stands NOW (idempotent: a no-op when main's stamp landed),
  // so a stamp main could not apply — the buffer moved during the minutes-long deploy — still lands,
  // and newer typing is never replaced by the text the publish started from (one-writer spec D1).
  async function handlePublishHandout() {
    if (publishingRef.current) return
    if (!activeTalk || !outlineContent) return
    if (blockedByUnresolved(outlineContent)) return
    const outlinePath = activeTalk.outlinePath
    publishingRef.current = true
    setBuildStatus('building')
    setPublishElapsed(0)
    setPublishing(true)
    const ticker = setInterval(() => setPublishElapsed((s) => s + 1), 1000)
    try {
      const res = await window.tw.talk.publishHandout(outlinePath, outlineContent)
      if (res?.success && res.url) {
        const url = res.url
        const stamped = await applyOutlineMutation(outlinePath, (current) => stampHandoutUrl(current, url))
        if (!stamped.ok && stamped.reason !== 'not-open') {
          notify(`Published, but the link could not be written into the outline: ${stamped.error}`, 'warning')
        }
        // e.g. a video over the per-file limit was published as a "plays live" placeholder.
        if (res.warning) notify('Published with a warning: ' + res.warning, 'warning', 'publish-warning')
        // Published without live features (spec D7): "Published. Going live is not set up: Settings → Cloudflare".
        const withoutLive = publishedWithoutLiveToast(res, 'publish-without-live', notify, () => { void window.tw.cloudflare.openSettings() })
        if (withoutLive) notify(withoutLive.message, withoutLive.level, withoutLive.key, withoutLive.action)
        else dismissToast('publish-without-live')
        const earlier = earlierHandoutsToast(res, 'publish-earlier-handouts', notify)
        if (earlier) notify(earlier.message, earlier.level, earlier.key, earlier.action)
        else dismissToast('publish-earlier-handouts')
      }
      if (res?.success && res.url) {
        setBuildStatus('done')
        setBuildPath(res.display || res.url)
        window.tw.shell.openExternal(res.url)
        // Copy-link is the thing you actually need after publishing (to paste into an email or
        // a chat) — the URL otherwise lives only in frontmatter. Persistent until acted on.
        const link = res.display || res.url
        notify('Published: ' + link, 'success', 'publish-done', {
          label: 'Copy link',
          onAction: () => { navigator.clipboard.writeText(link).then(() => notify('Link copied.', 'success')).catch(() => notify('Couldn’t copy the link.', 'warning')) }
        })
      } else if (res?.notReady) {
        // Publishing could not start (not connected, or one thing missing): the sheet, not a failure toast.
        setBuildStatus('idle')
        setPublishNotReady(res.notReady)
      } else {
        setBuildStatus('error')
        if (res?.display || res?.url) setBuildPath(res.display || res.url || null)
        console.warn('[publish-handout]', res?.error)
        // What lies behind the message (e.g. which bundled file is missing) is shown on request.
        const details = res?.details
        notify('Publish failed: ' + (res?.error || 'unknown error'), 'error', 'publish-failed', details
          ? { label: 'Details', onAction: () => notify(details, 'info', 'publish-failed-details') }
          : undefined)
      }
    } finally {
      clearInterval(ticker)
      publishingRef.current = false
      setPublishing(false)
    }
  }

  // Share for comments: the sheet shares the talk the moment it opens (LOCKED-share-sheet.html).
  function handleShareForComments() {
    if (!activeTalkRef.current) return
    if (blockedByUnresolved(outlineContentRef.current)) return
    setShareSheetOpen(true)
  }

  async function handleCopyVenueScreenLink() {
    if (!activeTalkRef.current) return
    const link = venueScreenLinkFromOutline(outlineContentRef.current)
    if (!link) { notify('Publish this talk before copying its venue-screen link.', 'info'); return }
    try {
      await navigator.clipboard.writeText(link)
      notify('Venue-screen link copied.', 'success')
    } catch { notify('Couldn’t copy the venue-screen link.', 'warning') }
  }

  // Manual rebuild (the escape hatch Dominik asked for): wipe this talk's thumbnail cache, then
  // recompile + re-render thumbnails from scratch. For when a preview ever looks stale/wrong.
  async function handleRefresh() {
    const talk = activeTalkRef.current
    if (!talk) return
    const cleared = await window.tw.talk.clearThumbCache(talk.slug, talk.outlinePath)
    if (!cleared || activeTalkRef.current?.outlinePath !== talk.outlinePath) return
    thumbnailRowsRef.current = null
    setThumbnails(null)
    compileImmediatelyRef.current = true
    // The same cancellable, progressive route as an edit; an old refresh can never publish into another talk.
    setThumbnailRefresh((n) => n + 1)
  }

  // Optimize the talk's images to WebP (smaller → faster previews + handouts). Imported talks carry
  // large relative-path PNGs; this converts + downscales them, rewrites refs in place, trashes the
  // originals (recoverable). The buffer change triggers a fresh compile → faster previews.
  async function handleOptimizeImages() {
    if (!activeTalk) return
    notify('Optimizing images…', 'info', 'optimize')
    const res = await window.tw.talk.optimizeImages(activeTalk.outlinePath, outlineContentRef.current)
    if (!res?.success) {
      notify('Image optimization failed: ' + (res?.error || 'unknown error'), 'error', 'optimize')
      return
    }
    // The rewritten refs are already in the buffer: main applied them through the D1 seam
    // (talk-writer.ts routes the open talk to this window) and saved them through the queue.
    // What was left alone on purpose, said in words (never a silent skip).
    const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`
    const leftNotes: string[] = []
    if (res.leftAlone) leftNotes.push(`${plural(res.leftAlone, 'picture belongs', 'pictures belong')} to another talk or the shared pool and ${res.leftAlone === 1 ? 'was' : 'were'} left alone`)
    if (res.clashes) leftNotes.push(`${plural(res.clashes, 'picture was', 'pictures were')} left alone because a .webp of the same name is already there`)
    const leftNote = leftNotes.length ? ` ${leftNotes.join('; ')}.` : ''
    if ((res.converted ?? 0) > 0 && res.newContent) {
      const mb = ((res.savedBytes ?? 0) / 1048576).toFixed(1)
      const failNote = res.failed ? ` (${res.failed} couldn’t convert)` : ''
      notify(`Optimized ${res.converted} image${res.converted === 1 ? '' : 's'} to WebP — saved ${mb} MB${failNote}. Previews will rebuild faster.${leftNote}`, 'success', 'optimize')
    } else {
      notify(leftNote ? `Nothing converted.${leftNote}` : 'No PNG/JPG images to convert in this talk.', 'info', 'optimize')
    }
  }

  // OCR-index the vault images so search matches text inside images (native macOS Vision).
  async function handleOcrIndex() {
    notify('Indexing image text (OCR)…', 'info', 'ocr')
    const res = await window.tw.talk.ocrIndex()
    if (res?.success) notify(`Image text: ${res.read ?? 0} images read, ${res.known ?? 0} already known, ${res.failed ?? 0} failed (${res.total ?? 0} found). Search matches text in images.`, 'success', 'ocr')
    else notify('OCR indexing failed: ' + (res?.error || 'unknown error'), 'error', 'ocr')
  }

  // Map the editor cursor line back to a slide index (editor → strip highlight): the slide
  // whose source line is the greatest one at/before the cursor.
  function handleCursorLine(line: number) {
    // Remember where the caret is, and whether the rows it was mapped against were the compiler's yet: a click made
    // before the first compile maps against the heading-only fallback, so it is mapped again when the rows arrive.
    cursorLineRef.current = line
    cursorAwaitsCompileRef.current = compiledSlidesRef.current == null
    closePickerIfCaretLeft()
    const idx = slideIndexAtLine(slideLines, line)
    // The Slide Scratchpad's note: below the heading of the caret's slide reads as "in its text" (the insert itself checks
    // exactly, against the editor's text).
    setScratchCaretInBody(idx >= 0 && slideLines[idx] != null && line > (slideLines[idx] as number))
    if (idx >= 0) {
      // Tell the outline sidebar only when the LINE it should mark changes (not every keystroke). By
      // line, not by slide index: after a move the same index is another slide on another line.
      activeLineReporter.report(slideLines[idx] ?? null)
      setActiveSlide(idx)
      if (inspectorMode) {
        const nextInspectedId = inspectedSlideIdAfterCursorChange(
          compiledSlidesRef.current,
          idx,
          inspectedSlideIdRef.current,
          inspectorCommitInProgressRef.current
        )
        if (nextInspectedId !== inspectedSlideIdRef.current) {
          inspectedSlideIdRef.current = nextInspectedId
          inspectedSlideIndexRef.current = idx
          setInspectedSlideId(nextInspectedId)
        }
      }
    }
  }

  // The caret's slide is re-resolved once, when the compile that the caret was placed ahead of arrives.
  useEffect(() => {
    const line = cursorLineRef.current
    if (line == null || !compiledSlides || !cursorAwaitsCompileRef.current) return
    handleCursorLine(line)
  }, [compiledSlides]) // eslint-disable-line react-hooks/exhaustive-deps

  // A picker opened on a slide with no `{id=…}` yet belongs to the slide it was opened on: a caret that moves to
  // another slide closes it (as moving the Inspector does for a stamped slide), so a try never rings another slide.
  function closePickerIfCaretLeft(): void {
    const picker = layoutPickerRef.current
    if (!picker || picker.slideId) return
    const doc = editorReadRef.current?.()
    const line = cursorLineRef.current
    if (!doc || line == null) return
    const slide = reanchorPickerSlide(picker.anchor, doc.text, picker.slide) ?? picker.slide
    if (typeof slide === 'string') return
    const caret = [...readOutlineSlides(doc.text).slides].reverse().find((candidate) => candidate.start <= line - 1)
    if (caret && caret.line !== slide.headingLine) closeLayoutPicker()
  }

  const handleOutlineContentChange = useCallback((text: string): void => {
    const rows = compiledSlidesRef.current, source = compiledSourceRef.current
    if (gridModeRef.current && rows && source != null && source !== text) {
      const ordered = projectGridMove(rows, source, text)
      if (ordered) {
        const active = rows[activeSlideRef.current]
        const index = ordered.findIndex(row => row.slide_id === active?.slide_id && row.role === active?.role && row.source_markdown === active?.source_markdown)
        compiledSourceRef.current = text
        compiledSlidesRef.current = ordered
        slideLinesRef.current = computeSlideLines(ordered, text)
        setCompiledSlides(ordered)
        if (index >= 0) { activeSlideRef.current = index; setActiveSlide(index) }
      }
    }
    setOutlineContent(text)
  }, [])

  // Moving slides and sections (slide handling ticket 1a): every drag and ⌘↑/↓ in the grid and the slide
  // strip runs moveBlocks (shared/slide-handling/blocks.ts) on the editor's BUFFER, through the D1 seam:
  // one minimal change, its own CodeMirror undo step, saved through the file's queue. A ref names a
  // heading line and the heading text seen at drag start; if the buffer no longer has that heading there,
  // the move is refused with a message and nothing changes. The moved slide is selected where it landed.
  async function handleMoveSlides(refs: MoveRef[], place: SlidePlace): Promise<void> {
    const talk = activeTalkRef.current
    if (!talk || refs.length === 0) return
    let landed: number | null = null
    let movedText: string | null = null
    const result = await applyOutlineMutation(talk.outlinePath, (text) => {
      const moved = moveBlocks(text, refs, place)
      if ('refused' in moved) throw new Error(moved.refused)
      landed = moved.movedRanges[0]?.line ?? null
      movedText = moved.text
      return moved.text
    }, { ownUndoStep: true })
    if (!result.ok && !result.applied) { notify(result.error, 'info', 'slide-move'); return }
    // Saving may finish after Undo, another move or a talk switch. A late landing must not
    // select a different card at yesterday's line.
    let savedText = result.ok ? result.text : movedText
    if (result.ok && result.changed && result.saved && result.saved.ok && 'content' in result.saved) savedText = result.saved.content ?? savedText
    const current = editorReadRef.current?.()
    if (landed != null && current?.path === talk.outlinePath &&
        savedText != null && current.text === savedText) slideLanded(landed)
  }
  // Keep one host identity while async copying is in flight: repeated clicks cannot issue a second copy/cut.
  const setAsideHostRef = useRef<SetAsideHost | null>(null)
  setAsideHostRef.current ??= {
    get outlinePath() { return activeTalkRef.current?.outlinePath ?? null },
    settled: async () => { const path = activeTalkRef.current?.outlinePath; if (path) await outlineWritesSettled(path) },
    read: () => { const editor = editorReadRef.current?.(); return editor?.path === activeTalkRef.current?.outlinePath ? editor ?? null : null },
    copy: (inputs, expectedOutline) => window.tw.scratchpad.setAside(inputs, expectedOutline),
    apply: (path, mutate, options) => applyOutlineMutation(path, mutate, options),
    notify: (message) => notify(message, 'info', 'slide-set-aside')
  }
  async function handleSetAsideSlides(refs: MoveRef[]): Promise<boolean> {
    const talk = activeTalkRef.current
    if (!talk) return false
    const relative = talk.outlinePath.startsWith(vaultRoot + '/') ? talk.outlinePath.slice(vaultRoot.length + 1) : talk.outlinePath
    const ok = await runSetAside(setAsideHostRef.current!, refs, {
      talkPath: relative, talkTitle: talk.title || talk.slug, talkSlug: talk.slug, vaultId: talk.vaultId, thumbKey: ''
    })
    if (activeTalkRef.current?.outlinePath === talk.outlinePath) scratchpadLayout.expand()
    return ok
  }
  // Cut, copy and delete of several slides at once (slide handling 1b, the grid's batch bar and ⌘X / ⌘C / ⌘⌫ on a
  // selection): cutBlocks on the buffer, ONE own undo step; the clip is the blocks in talk order, the same format a
  // single cut puts on the clipboard, so the existing paste takes it. Refused (stale heading, the talk's title): a
  // message and nothing changes. Delete asks no question: Undo restores it.
  async function handleCutSlides(refs: MoveRef[], mode: 'cut' | 'delete'): Promise<boolean> {
    const talk = activeTalkRef.current
    if (!talk || refs.length === 0) return false
    let clip = ''
    let count = 0
    let one = ''
    const result = await applyOutlineMutation(talk.outlinePath, (text) => {
      const cut = cutBlocks(text, refs)
      if ('refused' in cut) throw new Error(cut.refused)
      clip = cut.clip
      count = cut.count
      one = oneBlockName(text, refs, cut.titles)
      return cut.text
    }, { ownUndoStep: true })
    if (!result.ok && !result.applied) { notify(result.error, 'info', 'slide-clipboard'); return false }
    if (mode === 'cut') {
      writeSlideClipboard(clip, true)
      notify(count === 1 ? `Cut ${one}. Paste with ⌘V.` : `Cut ${count} slides. Paste with ⌘V.`, 'info', 'slide-clipboard')
    } else {
      notify(count === 1 ? `Deleted ${one}. Undo with ⌘Z to get it back.` : `Deleted ${count} slides. Undo with ⌘Z to get them back.`, 'info', 'slide-clipboard')
    }
    return true
  }
  /** One block's name for a message, as a single-slide cut says it: slide “Title” or section “Title”. */
  function oneBlockName(text: string, refs: readonly MoveRef[], titles: readonly string[]): string {
    const outer = blockAt(text, Math.min(...refs.map((r) => r.line)))
    return `${outer?.section ? 'section' : 'slide'} “${titles[0] ?? ''}”`
  }
  const PASTE_STALE = 'The talk changed while you were pasting, and the slide you chose is no longer where it was. Nothing was pasted; try again.'
  /**
   * Paste after a grid card (⌘V, the card menu's Paste): the card's heading must still be on its line, as a cut or
   * move checks it; refused with a message otherwise. A card with no heading of its own (cover, closing) pastes at
   * the end of the talk, as before.
   */
  function handlePasteAfterCard(clip: string, index: number): number | null {
    const ops = slideOps
    if (!ops) return null
    const row = compiledSlidesRef.current?.[index]
    const hasHeading = !!row && (row.role === 'section-title' || /^#{2,6}\s/.test((row.source_markdown ?? '').trimStart()))
    if (!hasHeading) return ops.paste(clip, null)
    const ref = slideRefOf(index)
    const text = editorReadRef.current?.()?.text
    if (!ref || text == null || !refHolds(text, ref)) { notify(PASTE_STALE, 'info', 'slide-clipboard'); return null }
    return ops.paste(clip, ref.line)
  }
  /** Copy several slides: the clip, in talk order (null: refused, said). */
  function handleCopySlides(refs: MoveRef[]): string | null {
    const text = editorReadRef.current?.()?.text
    if (text == null || refs.length === 0) return null
    const copy = copyBlocks(text, refs)
    if ('refused' in copy) { notify(copy.refused, 'info', 'slide-clipboard'); return null }
    rememberSlideClip(copy.clip)
    notify(copy.count === 1 ? `Copied ${oneBlockName(text, refs, copy.titles)}. Paste with ⌘V.` : `Copied ${copy.count} slides. Paste with ⌘V.`, 'info', 'slide-clipboard')
    return copy.clip
  }
  /** ⌘↑ / ⌘↓ on a card: past the neighbouring slide or section of the same level. */
  function handleStepSlide(ref: MoveRef, dir: 'up' | 'down'): void {
    const text = editorReadRef.current?.()?.text
    if (text == null) return
    const place = stepPlace(text, ref.line, dir)
    if (place) void handleMoveSlides([ref], place)
  }
  /**
   * The heading behind a card: its line in the editor's current text, and the heading AS THE CARD SHOWS IT (the
   * compiled row's heading line, or its title when the row carries no source). The heading text is never read from
   * the buffer at that line: the line may be stale (an id-less heading, edits above it since the compile), and the
   * shared move core refuses a ref whose line no longer holds the card's heading. Null: no line, not a heading line.
   */
  function slideRefOf(index: number): MoveRef | null {
    const line = lineOfSlideIndex(index)
    if (line == null) return null
    const text = editorReadRef.current?.()?.text ?? outlineContentRef.current
    if (!refAt(text, line)) return null
    const row = compiledSlidesRef.current?.[index]
    const first = (row?.source_markdown ?? '').trimStart().split('\n')[0] ?? ''
    const headingText = /^#{1,6}\s/.test(first) ? first : (row?.title ?? '')
    return headingText.trim() === '' ? null : { line, headingText }
  }

  // Inserts at the live caret (cross-talk reuse, archive images): one change through the editor's
  // insert channel, then the buffer is saved as it stands through the file's queue (the D1 seam's
  // insertAtCaret; onSaved stamps "saved" and reports collisions). Never a remount, never a disk
  // write ahead of the buffer. The target is always the talk open here; if its text is not loaded in
  // the editor yet there is no caret and no buffer, so nothing is inserted and the person is told.
  const INSERT_NOT_READY = 'The talk is not ready in the editor yet. Nothing was inserted; try again.'
  async function insertAtCaretAndSave(block: string): Promise<boolean> {
    const talk = activeTalkRef.current
    if (!talk) return false
    const result = await outlineMutatorRef.current!.insertAtCaret(talk.outlinePath, block)
    if (!result.ok && !result.applied) notify(INSERT_NOT_READY, 'warning', 'insert-not-ready')
    return result.ok || result.applied
  }

  // Cross-Talk reuse insert (ADR-0013): the imported slide goes in at the live caret. Provenance is
  // implicit: the block keeps its `{id=…}` verbatim and the ledger records the arrival on save
  // (ADR-0032). Saved at once rather than after the debounced autosave, so a read-back sees it.
  async function handleSearchInsert(markdown: string, _fromSlug: string, sourceOutlinePath?: string) {
    if (!activeTalkRef.current) return
    const md = await prepareInsertedSlide(markdown, sourceOutlinePath)
    if (md === null) return
    await insertAtCaretAndSave(md.replace(/\s*$/, ''))
  }

  // One picked slide made ready for THIS talk. From another vault (ticket 06): main copies it into
  // this talk's vault — media, a re-stamped id if the id is taken here, provenance — and returns the
  // markdown to insert; null when that copy failed (nothing inserted, the person is told). From this
  // vault: cross-talk reuse, the slide's relative images materialized into the vault pool so they
  // resolve in THIS talk (a relative assets/ ref points at the SOURCE talk and would go grey).
  async function prepareInsertedSlide(markdown: string, sourceOutlinePath?: string): Promise<string | null> {
    const talk = activeTalkRef.current
    if (!sourceOutlinePath || !talk) return markdown
    try {
      const liveIds = [...outlineContentRef.current.matchAll(/\{id=([A-Za-z0-9_-]+)\}/g)].map((m) => m[1])
      const cross = await window.tw.talk.insertFromVault(sourceOutlinePath, talk.outlinePath, markdown, liveIds)
      if (cross.ok && cross.crossVault) return cross.markdown
      if (!cross.ok) {
        notify(`Couldn’t copy the slide into this vault — ${cross.error} Nothing was inserted.`, 'warning', 'insert-from-vault')
        return null
      }
    } catch { /* an older main without the handler: the same-vault path below */ }
    try {
      const mat = await window.tw.talk.materializeSlideAssets(sourceOutlinePath, markdown)
      if (mat?.success) return mat.markdown
    } catch { /* fall back to the raw markdown */ }
    return markdown
  }

  // Insert SEVERAL searched slides at once (multi-select), each its own block, at the caret in
  // result order: one insertion, one save.
  async function handleSearchInsertMany(items: { markdown: string; fromSlug: string; sourceOutlinePath?: string }[]) {
    if (!activeTalkRef.current || items.length === 0) return
    // Each slide made ready for this talk (cross-talk reuse, or a copy from another vault), one after
    // another so ids promised to an earlier slide are never handed out again.
    const mdById: Array<string | null> = []
    for (const it of items) mdById.push(await prepareInsertedSlide(it.markdown, it.sourceOutlinePath))
    if (mdById.some((md) => md === null)) return
    const blocks = mdById.map((md) => (md as string).replace(/\s*$/, ''))
    if (await insertAtCaretAndSave(blocks.join('\n\n'))) {
      notify(`Inserted ${items.length} slide${items.length === 1 ? '' : 's'}.`, 'success')
    }
  }

  // Image drawer insert (ADR-0019 archive reuse, ticket 11). The one import copies the chosen file into
  // the active talk's own vault's _assets (content-addressed, with its provenance) and returns its `img-<hash>`
  // id; we splice `![](img-<id>)` at the live caret, like the cross-talk insert. Both the drag and
  // ⌘↵ come here, In your talks pictures too: main works out the talk's vault by the registry and answers the
  // existing id without copying when the picture is already in that pool. Null from the import means nothing
  // was copied, and nothing is inserted.
  async function insertDrawerImage(thumbUrl: string): Promise<boolean> {
    const talk = activeTalkRef.current
    if (!talk) return false
    let imported: Awaited<ReturnType<typeof window.tw.images.importImage>> = null
    try { imported = await window.tw.images.importImage(thumbUrl, talk.outlinePath) } catch { imported = null }
    if (!imported || !imported.id) {
      notify('Couldn’t copy that image into the vault. Nothing was inserted.', 'warning', 'image-import')
      return false
    }
    // importImage already returns a full `img-<hash>` id — do NOT re-prefix (that produced
    // the `img-img-…` refs that the inline-image widget regex could not match).
    const id = imported.id.startsWith('img-') ? imported.id : `img-${imported.id}`
    // The id names a file in THIS talk's vault: another talk opened meanwhile (perhaps in another vault) gets nothing.
    if (activeTalkRef.current !== talk) return false
    return insertAtCaretAndSave(`![](${id})`)
  }

  // ── Slide Scratchpad: Insert whole slide / Insert visual only (ticket 2, lib/scratchpadInsert.ts) ──────────────────
  // The Insert buttons, palette commands and card drops share the same insertion operation. They go
  // through this workspace's own writers: the one-writer seam for a new slide, the caret insert for a visual at the
  // cursor, and prepareInsertedSlide (the Slide Browser's step) for a picked slide's media and ids.
  const scratchInsertHost: ScratchInsertHost = {
    talk: () => activeTalkRef.current?.outlinePath ?? null,
    editor: () => editorReadRef.current?.() ?? null,
    apply: (outlinePath, mutate) => applyOutlineMutation(outlinePath, mutate, { ownUndoStep: true }),
    insertAtCaret: (block) => insertAtCaretAndSave(block),
    prepareSlide: (markdown, sourceOutlinePath) => sourceOutlinePath === activeTalkRef.current?.outlinePath ? Promise.resolve(markdown) : prepareInsertedSlide(markdown, sourceOutlinePath),
    api: window.tw.scratchpad,
    notify: (message, kind, key) => notify(message, kind, key)
  }
  /** Where an insert goes when no place was chosen by hand: after the slide selected in the grid, strip or Slide
   *  outline when that had the keyboard, else after the caret's slide. `fromCaret`: the caret decided. */
  function scratchAutoPlace(rows: ReadonlyArray<{ line: number; level: number; text: string }>): { place: ScratchPlace; fromCaret: boolean } {
    const region = gridModeRef.current ? 'slides' : focusRegionRef.current
    let line: number | null = null
    let fromCaret = false
    if (region === 'slides') line = slideLinesRef.current[activeSlideRef.current] ?? null
    else if (region === 'outline' && getOutlineSelection() != null) line = getOutlineSelection()
    else { line = cursorLineRef.current ?? slideLinesRef.current[activeSlideRef.current] ?? null; fromCaret = true }
    let found: { line: number; text: string } | null = null
    if (line != null) for (const row of rows) { if (row.line <= line) found = row; else break }
    return { place: found ? { kind: 'after', line: found.line, title: found.text } : { kind: 'start' }, fromCaret }
  }
  async function scratchpadInsert(item: ScratchItem, mode: 'slide' | 'visual', visual: ScratchVisual | null = null): Promise<boolean> {
    if (scratchInsertingRef.current) return false
    scratchInsertingRef.current = true
    setScratchInserting(true)
    try {
      const text = editorReadRef.current?.()?.text ?? outlineContentRef.current
      const chosen = scratchChosenPlaceRef.current
      const auto = scratchAutoPlace(slideRows(text).filter((row) => row.level >= 2))
      const place = chosen ?? auto.place
      const outcome = await runScratchInsert(scratchInsertHost, mode === 'slide'
        ? { mode, item, place }
        : { mode, item, visual, place, atCaret: !chosen && auto.fromCaret })
      // A place chosen by hand moves on to the slide just added, so several inserts there keep their order.
      if (outcome.ok && chosen && outcome.newSlide) {
        scratchChosenEarlierRef.current = [...scratchChosenEarlierRef.current, chosen]
        setScratchChosenPlace(outcome.newSlide)
      }
      return outcome.ok
    } finally {
      scratchInsertingRef.current = false
      setScratchInserting(false)
    }
  }
  async function handleScratchDrop(id: string, place: SlidePlace): Promise<void> {
    if (scratchInsertingRef.current) return
    const talk = activeTalkRef.current?.outlinePath
    if (!talk) return
    scratchInsertingRef.current = true
    setScratchInserting(true)
    try {
      const reply = await window.tw.scratchpad.load()
      if (activeTalkRef.current?.outlinePath !== talk) return
      const item = reply.ok ? reply.snapshot.items.find(candidate => candidate.id === id) : null
      if (!item || item.missing || item.status !== 'active') { notify('That item is no longer available in this talk’s Scratchpad. Nothing was inserted.', 'info', 'scratchpad-insert'); return }
      await runScratchInsert(scratchInsertHost, item.kind === 'slide'
        ? { mode: 'slide', item, place }
        : { mode: 'visual', item, visual: null, place, atCaret: false })
    } finally { scratchInsertingRef.current = false; setScratchInserting(false) }
  }
  const scratchNumberAt = (line: number): number | null => scratchNumbers.get(line) ?? null
  const scratchAuto = scratchPanelShown ? scratchAutoPlace(scratchRows) : { place: { kind: 'start' } as ScratchPlace, fromCaret: false }
  const scratchInsertApi: ScratchpadInsertApi = {
    place: scratchChosenPlace ?? scratchAuto.place,
    chosen: scratchChosenPlace !== null,
    caretInBody: scratchAuto.fromCaret && scratchCaretInBody,
    rows: (): PlaceChoice[] => scratchRows.map((row) => ({ line: row.line, level: row.level, title: row.text, no: scratchNumberAt(row.line) })),
    numberAt: scratchNumberAt,
    choose: (place) => { scratchChosenEarlierRef.current = []; setScratchChosenPlace(place) },
    insert: scratchpadInsert,
    busy: scratchInserting,
    hasSlideTitled: (title) => scratchRows.some((r) => r.text === title)
  }

  // An old slide as a new, editable slide after the current one (ticket 12). Its pictures go into the vault
  // through the same import as any picture result (provenance kept), the old slide record is converted by
  // the PowerPoint import's rules (shared/old-slide), and the slide is put in through the one-writer seam at
  // the place worked out inside the mutation, against the buffer and caret as they stand. Nothing is
  // inserted unless every step before the buffer change worked; a picture that could not be copied is left
  // out of the slide and the person is told.
  async function insertResearchItem(item: Pick<ResearchItem, 'file'>, slide: boolean): Promise<boolean> {
    try {
      const inserted = await insertResearchItemInEditor(item.file, slide, {
        activeTalk: () => activeTalkRef.current,
        readItem: input => window.tw.research.list(input),
        editor: () => editorReadRef.current?.() ?? null,
        mutator: outlineMutatorRef.current!
      })
      if (inserted) { setResearchHighlight(item.file); setResearchRefresh(n => n + 1) }
      return inserted
    } catch (error) { notify(error instanceof Error ? error.message : 'Research could not be inserted.', 'warning', 'research-insert'); return false }
  }
  function jumpToResearchUse(use: ResearchUse): void {
    const talk = activeTalkRef.current
    if (talk?.outlinePath === use.file) {
      selectPane('both'); setFocusLine({ line: use.slideLine, takeFocus: true }); handleCursorLine(use.slideLine)
    } else onResearchJump?.(use)
  }
  useEffect(() => {
    if (!researchJump || researchJump.file !== activeTalk?.outlinePath || editorReadRef.current?.()?.path !== researchJump?.file) return
    setFocusLine({ line: researchJump.line, takeFocus: true }); handleCursorLine(researchJump.line)
  }, [researchJump, activeTalk?.outlinePath, outlineContent])

  async function insertOldSlideAfterCurrent(hit: ImageSearchHit): Promise<boolean> {
    const talk = activeTalkRef.current
    const record = hit.oldSlide
    if (!talk || !record) return false
    const assets: Record<string, string> = {}
    let missed = 0
    for (const image of record.images) {
      let imported: Awaited<ReturnType<typeof window.tw.images.importImage>> = null
      try { imported = await window.tw.images.importImage(image.thumbUrl, talk.outlinePath) } catch { imported = null }
      if (imported?.id) assets[image.key] = imported.id.startsWith('img-') ? imported.id : `img-${imported.id}`
      else missed += 1
    }
    const slide = oldSlideMarkdown(record, assets)
    if (activeTalkRef.current !== talk) return false
    let placed = false
    const result = await applyOutlineMutation(talk.outlinePath, (current) => {
      const editor = editorReadRef.current?.()
      if (!editor || editor.path !== talk.outlinePath || editor.text !== current) throw new Error('The talk changed while the slide was being placed. Nothing was inserted; try again.')
      const r = insertSlideAfterCaret({ text: current, caret: editor.caret, slide })
      if (!r.ok) throw new Error(r.error)
      placed = true
      return r.text
    })
    if (result.ok && placed) {
      if (missed > 0) notify(`${missed === 1 ? 'One picture' : `${missed} pictures`} could not be copied into the vault and ${missed === 1 ? 'was' : 'were'} left out of the new slide.`, 'warning', 'image-import')
      return true
    }
    if (result.ok) { notify('The slide could not be placed. Nothing was inserted.', 'warning', 'old-slide-insert'); return false }
    if (result.applied) return true
    // A slide that would not read as one slide of its own: the one sentence, which points at the picture.
    if (result.reason !== 'not-open' && result.error === OLD_SLIDE_REFUSED) { notify(OLD_SLIDE_REFUSED, 'warning', 'old-slide-insert'); return false }
    notify(result.reason === 'not-open' ? INSERT_NOT_READY : `Couldn’t add the slide — ${result.error} Nothing was inserted.`, 'warning', 'old-slide-insert')
    return false
  }

  // The drawer's drag lands on the panes: only the drawer's own drag type counts, so files and text
  // dropped on the editor behave as before.
  const isDrawerDrag = (e: React.DragEvent): boolean => e.dataTransfer.types.includes(IMAGE_DRAG_TYPE)
  function handleDrawerDragOver(e: React.DragEvent): void {
    if (!isDrawerDrag(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    const kind = e.dataTransfer.types.includes(OLD_SLIDE_DRAG_TYPE) ? 'slide' : 'picture'
    if (imageDropping !== kind) setImageDropping(kind)
  }
  function handleDrawerDrop(e: React.DragEvent): void {
    if (!isDrawerDrag(e)) return
    e.preventDefault()
    e.stopPropagation()
    setImageDropping(null)
    try {
      const { key, thumbUrl, oldSlide } = JSON.parse(e.dataTransfer.getData(IMAGE_DRAG_TYPE)) as { key?: string; thumbUrl?: string; oldSlide?: boolean }
      // An old slide asks first (editable slide or picture); the drawer shows the choice.
      if (oldSlide && key) window.dispatchEvent(new CustomEvent(OLD_SLIDE_DROP_EVENT, { detail: { key } }))
      else if (thumbUrl) void insertDrawerImage(thumbUrl)
    } catch { /* not our payload */ }
  }

  // Icon pick (ADR-0021). The IconPicker resolved a glyph key; we pin it to the caret's current
  // top-level list bullet. The editor's registered reader gives us the bullet's line and its slide's
  // heading line for the live caret; main's setListItemIcon rewrites the BUFFER's text (the D1 seam reads it from
  // the editor, and works it out again if the person typed during the round trip). The rewrite is a
  // tiny `{icon=…}` token, so it lands as one minimal change — caret and scroll kept, no remount —
  // and is saved at once through the queue. No-op with a hint when the caret is not in a bullet.
  async function handleIconPicked(iconKey: string) {
    const talk = activeTalkRef.current
    if (!talk) return
    const ctx = iconContextRef.current?.() ?? null
    if (!ctx) {
      notify('Place the caret in a top-level list item first — an icon pins to a bullet.', 'info', 'icon-pick')
      return
    }
    const NO_ITEM = 'icon-item-gone'
    const result = await applyOutlineMutation(talk.outlinePath, async (text) => {
      const next = await window.tw.outline.setItemIcon(text, ctx.slideHeading, iconKey, ctx.itemLine)
      if (next == null) throw new Error(NO_ITEM)
      return next
    })
    if (result.ok || result.applied) return
    if (result.reason === 'refused' && result.error === NO_ITEM) {
      notify('Couldn’t pin the icon to that item — the outline was left unchanged.', 'warning', 'icon-pick')
    } else {
      notify(`Couldn’t pin the icon — ${result.error}`, 'warning', 'icon-pick')
    }
  }

  // Deck settings (DeckDesignPanel) hand back the frontmatter EDITS, not a whole outline worked out
  // from the panel's copy of the text: they are applied to the buffer as it stands (D1 seam), so
  // typing since the panel opened is kept. A talk whose text is not in the editor goes to main's
  // metadata:edit-frontmatter, which writes it through writeTalkOutline.
  async function handleDeckDesignSave(edits: FrontmatterEdit[]) {
    const talk = activeTalkRef.current
    if (!talk || edits.length === 0) return
    const result = await applyOutlineMutation(talk.outlinePath, (text) => editFrontmatterText(text, edits))
    if (result.ok) return
    if (result.reason === 'not-open') {
      const res = await window.tw.metadata.editFrontmatter(talk.outlinePath, edits)
      if (!res.ok) notify('Design change could not be written to disk.', 'error', 'save-failed')
      return
    }
    if (!result.applied) notify(`Design change not applied — ${result.error}`, 'warning')
  }

  // A picker command from the palette or a key: it acts on the open picker, or says why it cannot.
  const runPickerCommand = (run: (commands: SlidePickerCommands) => PickerCommandOutcome, id: string): void => {
    const commands = pickerCommandsRef.current
    if (!browserOpenRef.current || !commands) {
      notify(`Open the slide picker (${liveShortcutLabel('app.slide-search')}) first.`, 'info', 'picker-command')
      return
    }
    const outcome = run(commands)
    if (outcome !== true) notify(outcome, 'info', 'picker-command')
    else commandRan(id)
  }

  // Every generated palette, native-menu, and toolbar item reaches renderer behaviour through
  // this typed handler map. It is assigned before the empty-state return because the Talk-free
  // Tools menu uses the same registered commands.
  commandHandlersRef.current = reportingHandlers({
    refresh: () => { void handleRefresh() },
    'optimize-images': () => { void handleOptimizeImages() },
    'ocr-index': () => { void handleOcrIndex() },
    'check-embeds': () => setEmbedCheckOpen(true),
    'layout-doctor': () => {
      void (async () => {
        await editorCmdsRef.current?.flushSave()
        setLayoutDoctorOpen(true)
      })()
    },
    // The research folder beside the open talk (knowledge step two): the sheet files through scout; Reveal creates the folder if absent.
    'research-panel': () => { if (activeTalkRef.current) setResearchPanelOpen(open => !open); else notify('Open a talk first.', 'info') },
    'research-find': () => { if (activeTalkRef.current) setResearchPickerOpen(true); else notify('Open a talk first.', 'info') },
    'research-rename': () => researchActionsRef.current['research-rename']?.(),
    'research-change-kind': () => researchActionsRef.current['research-change-kind']?.(),
    'research-delete': () => researchActionsRef.current['research-delete']?.(),
    'research-move': () => researchActionsRef.current['research-move']?.(),
    'research-copy': () => researchActionsRef.current['research-copy']?.(),
    'research-insert-here': () => researchActionsRef.current['research-insert-here']?.(),
    'research-insert': () => researchActionsRef.current['research-insert']?.(),
    'research-make-slide': () => researchActionsRef.current['research-make-slide']?.(),
    'research-open': () => researchActionsRef.current['research-open']?.(),
    'research-previous': () => researchActionsRef.current['research-previous']?.(),
    'research-next': () => researchActionsRef.current['research-next']?.(),
    'research-scope': () => researchActionsRef.current['research-scope']?.(),
    'research-close': () => researchActionsRef.current['research-close']?.(),
    'research-copy-reference': () => researchActionsRef.current['research-copy-reference']?.(),
    'research-reveal': () => researchActionsRef.current['research-reveal']?.(),
    'research-source': () => researchActionsRef.current['research-source']?.(),
    'research-used-in': () => researchActionsRef.current['research-used-in']?.(),
    'research-scope-talk': () => researchActionsRef.current['research-scope-talk']?.(),
    'research-scope-research': () => researchActionsRef.current['research-scope-research']?.(),
    'research-scope-everything': () => researchActionsRef.current['research-scope-everything']?.(),
    'research-retry': () => researchActionsRef.current['research-retry']?.(),
    // Slide Scratchpad: the panel commands need an open talk; the item commands act on the panel's selection.
    'scratchpad-panel': () => { if (activeTalkRef.current) scratchpadLayout.toggle(); else notify('Open a talk first.', 'info') },
    'scratchpad-dock': () => { if (activeTalkRef.current) scratchpadLayout.dock(); else notify('Open a talk first.', 'info') },
    'scratchpad-float': () => { if (activeTalkRef.current) scratchpadLayout.float(); else notify('Open a talk first.', 'info') },
    'scratchpad-collapse': () => scratchpadLayout.collapse(),
    'scratchpad-add-slides': () => runPickerCommand((picker) => picker.addToScratchpad(), 'scratchpad-add-slides'),
    'scratchpad-keep': () => scratchpadActionsRef.current['scratchpad-keep']?.(),
    'scratchpad-reject': () => scratchpadActionsRef.current['scratchpad-reject']?.(),
    'scratchpad-move-back': () => scratchpadActionsRef.current['scratchpad-move-back']?.(),
    'scratchpad-move-to-group': () => scratchpadActionsRef.current['scratchpad-move-to-group']?.(),
    'scratchpad-new-group': () => scratchpadActionsRef.current['scratchpad-new-group']?.(),
    'scratchpad-remove-missing': () => scratchpadActionsRef.current['scratchpad-remove-missing']?.(),
    // Ticket 2: the panel acts on its selection; opening the panel first so the result is seen.
    'scratchpad-insert-slide': () => { if (activeTalkRef.current) { scratchpadLayout.expand(); scratchpadActionsRef.current['scratchpad-insert-slide']?.() } else notify('Open a talk first.', 'info') },
    'scratchpad-insert-visual': () => { if (activeTalkRef.current) { scratchpadLayout.expand(); scratchpadActionsRef.current['scratchpad-insert-visual']?.() } else notify('Open a talk first.', 'info') },
    'scratchpad-compare': () => { if (activeTalkRef.current) { scratchpadLayout.expand(); scratchpadActionsRef.current['scratchpad-compare']?.() } else notify('Open a talk first.', 'info') },
    'scratchpad-change-place': () => { if (activeTalkRef.current) { scratchpadLayout.expand(); scratchpadActionsRef.current['scratchpad-change-place']?.() } else notify('Open a talk first.', 'info') },
    'research-capture': () => {
      if (!activeTalkRef.current) { notify('Open a talk first.', 'info', 'research-capture'); return }
      setCaptureSheet(researchCaptureDropRef.current ?? { body: editorCmdsRef.current?.selectionText() ?? '' }); researchCaptureDropRef.current = null
    },
    'research-reveal-folder': () => {
      const talk = activeTalkRef.current
      if (!talk) { notify('Open a talk first.', 'info', 'research-capture'); return }
      void window.tw.research.revealFolder(talk.path).then((reply) => { if (!reply.ok) notify(reply.error.message, 'error', 'research-reveal') })
    },
    'where-used': openWhereUsed,
    'focus-slide': () => enterFocus(activeSlideRef.current),
    'toggle-inspector': toggleInspector,
    studio: () => window.dispatchEvent(new Event('tw-open-studio')),
    history: () => window.dispatchEvent(new Event('tw-open-history')),
    importer: () => window.dispatchEvent(new Event('tw-open-importer')),
    // With no talk open the sheet cannot name a talk: the Tools window opens the sheet, with its talk picker, over its Sessions view.
    'plan-run': () => {
      if (activeTalkRef.current) setPlanSheet({ run: null })
      else void window.tw.tools.open('sessions', 'plan-run')
    },
    // The strips under the Metadata table (work-files ticket 30): the command presses the strip's own Attach button.
    'attach-prework': () => { const why = activeTalkRef.current ? pressAttachOnStrip(document, 'pre') : 'Open a talk first.'; if (why) notify(why, 'info', 'attach-work-file') },
    'attach-postwork': () => { const why = activeTalkRef.current ? pressAttachOnStrip(document, 'post') : 'Open a talk first.'; if (why) notify(why, 'info', 'attach-work-file') },
    pathways: () => {
      const talk = activeTalkRef.current
      if (!talk) return
      void (async () => {
        await editorCmdsRef.current?.flushSave()
        await window.tw.tools.openPathways({
          outlinePath: talk.outlinePath,
          talkSlug: talk.slug,
          talkTitle: talk.title
        })
      })()
    },
    'new-window': () => { void window.tw.windows?.open?.() },
    'open-in-new-window': () => window.dispatchEvent(new Event('tw-open-in-new-window')),
    'new-talk': () => window.dispatchEvent(new Event('tw-new-talk')),
    'new-folder': () => window.dispatchEvent(new Event('tw-new-folder')),
    'refresh-talks': () => window.dispatchEvent(new Event('tw-refresh-talks')),
    'change-vault': () => window.dispatchEvent(new Event('tw-change-vault')),
    'search-talks': () => window.dispatchEvent(new Event('tw-search-talks')),
    'present-window': () => handlePresent('window'),
    'present-presenter': () => handlePresent('presenter'),
    'present-from-here': () => { void presentFromHere() },
    'present-audience': () => handlePresent('audience'),
    handout: () => { void handleExportHandout() },
    build: () => { void handleBuild() },
    'publish-handout': () => { if (!publishingRef.current) void requestPublishHandout() },
    'share-for-comments': () => handleShareForComments(),
    'copy-venue-screen-link': () => { void handleCopyVenueScreenLink() },
    layout: openLayoutPicker,
    image: openImageDrawer,
    search: () => setBrowserOpen(true),
    'find-talk': () => {
      pickerCommandsRef.current?.focusFindTalk()
      if (!browserOpenRef.current) setBrowserOpen(true)
    },
    'add-talk-beside': () => runPickerCommand((picker) => picker.addTalkBeside(), 'add-talk-beside'),
    'talk-beside': () => runPickerCommand((picker) => picker.talkBeside(), 'talk-beside'),
    'close-talk-beside': () => runPickerCommand((picker) => picker.closeTalkBeside(), 'close-talk-beside'),
    'select-whole-section': () => runPickerCommand((picker) => picker.selectWholeSection(), 'select-whole-section'),
    'icon-picker': () => toggleIconPickerRef.current(),
    'insert-object-table': () => editorInsertObjectRef.current?.('table'),
    'insert-object-mindmap': () => editorInsertObjectRef.current?.('mindmap'),
    'insert-object-chart': () => editorInsertObjectRef.current?.('chart'),
    'insert-object-mermaid': () => editorInsertObjectRef.current?.('mermaid'),
    'insert-object-diagram': () => editorInsertObjectRef.current?.('diagram'),
    'insert-object-svg': () => editorInsertObjectRef.current?.('svg'),
    'insert-component-code': () => insertComponent('code'),
    'insert-component-qr': () => insertComponent('qr'),
    'insert-component-action': () => insertComponent('action'),
    'insert-component-embed': () => insertComponent('embed'),
    'insert-component-auto-embed': () => insertComponent('auto-embed'),
    'insert-component-countdown': () => insertComponent('countdown'),
    'insert-component-notes': () => insertComponent('notes'),
    'insert-html-page': () => { void insertHtmlPageRef.current?.() },
    'capture-embed': () => captureEmbed(),
    'format-bold': () => editorCmdsRef.current?.runFormat('bold'),
    'format-italic': () => editorCmdsRef.current?.runFormat('italic'),
    'format-inline-code': () => editorCmdsRef.current?.runFormat('inline-code'),
    'format-highlight': () => editorCmdsRef.current?.runFormat('highlight'),
    'format-strikethrough': () => editorCmdsRef.current?.runFormat('strikethrough'),
    'format-underline': () => editorCmdsRef.current?.runFormat('underline'),
    'format-link': () => editorCmdsRef.current?.runFormat('link'),
    'deck-design': () => setDeckDesignOpen(true),
    metadata: () => window.dispatchEvent(new Event('tw-open-metadata')),
    'tag-slide': openTagCurrentSlide,
    abstract: () => setAbstractOpen(true),
    'view-plain': () => chooseEditorViewMode('plain'),
    'change-heading-level': () => openMarginMenuAtCaret('level'),
    'change-slide-layout': () => openMarginMenuAtCaret('layout'),
    'view-markdown': () => chooseEditorViewMode('markdown'),
    'view-editor': () => selectPane('editor'),
    'view-both': () => selectPane('both'),
    'view-strip': () => selectPane('strip'),
    'view-grid': selectGrid,
    'outline-collapse-all': () => { if (collapseKey) { publishOutline(collapseKey, outlineContentRef.current); collapseAllSections(collapseKey) } },
    'outline-expand-all': () => { if (collapseKey) { publishOutline(collapseKey, outlineContentRef.current); expandAllSections(collapseKey) } },
    'select-section': () => { if (!slideSelectionControls()?.selectSection()) notify('Open the grid and select a slide first.', 'info', 'slide-selection') },
    'clear-slide-selection': () => { slideSelectionControls()?.clear() },
    'search-slides-grid': () => {
      if (!gridModeRef.current) selectGrid()
      requestAnimationFrame(() => requestAnimationFrame(() => searchSurface('grid')?.focus()))
    },
    'search-next': () => { if (!searchSurface()?.step(1)) notify('Type a search in the outline or the grid first.', 'info', 'slide-search') },
    'search-previous': () => { if (!searchSurface()?.step(-1)) notify('Type a search in the outline or the grid first.', 'info', 'slide-search') },
    'set-aside-slides': () => {
      if (gridModeRef.current && slideSelectionControls()?.setAside?.()) return
      const editor = editorReadRef.current?.()
      const line = focusRegionRef.current === 'slides' ? slideLinesRef.current[activeSlideRef.current] : cursorLineRef.current
      const row = editor && slideRows(editor.text).filter(r => r.level >= 2 && r.line <= (line ?? 0)).at(-1)
      const ref = row && editor ? { line: row.line, headingText: editor.text.split('\n')[row.line - 1] } : null
      if (ref) void handleSetAsideSlides([ref])
      else notify('Select a slide to set aside first.', 'info', 'slide-set-aside')
    },
    'move-selected-slides-to': () => { if (!slideSelectionControls()?.openMove()) notify('Select two or more slides in the grid first.', 'info', 'slide-selection') },
    'move-slide-to': () => openMoveTo('slide'),
    'move-section-to': () => openMoveTo('section'),
    'fold-all': () => editorCmdsRef.current?.foldAll(),
    'unfold-all': () => editorCmdsRef.current?.unfoldAll(),
    'normalize-triggers': () => editorCmdsRef.current?.normalizeTriggers(),
    'quote-form-auto': () => editorCmdsRef.current?.setQuoteForm('auto', compiledLayoutAtLine),
    'quote-form-plain': () => editorCmdsRef.current?.setQuoteForm('plain', compiledLayoutAtLine),
    'quote-form-tweet': () => editorCmdsRef.current?.setQuoteForm('tweet', compiledLayoutAtLine),
    'quote-form-video': () => editorCmdsRef.current?.setQuoteForm('video', compiledLayoutAtLine),
    'quote-form-book': () => editorCmdsRef.current?.setQuoteForm('book', compiledLayoutAtLine),
    'quote-form-paper': () => editorCmdsRef.current?.setQuoteForm('paper', compiledLayoutAtLine),
    'quote-form-web': () => editorCmdsRef.current?.setQuoteForm('web', compiledLayoutAtLine),
    undo: () => runActionBarEditorCommand(editorCmdsRef.current, 'undo'),
    redo: () => runActionBarEditorCommand(editorCmdsRef.current, 'redo'),
    'new-slide': () => runActionBarEditorCommand(editorCmdsRef.current, 'new-slide'),
    'insert-board-slide': () => { insertedBoardLineRef.current = editorCmdsRef.current?.insertBoardSlide() ?? null },
    'promote-heading': () => runActionBarEditorCommand(editorCmdsRef.current, 'promote-heading'),
    'demote-heading': () => runActionBarEditorCommand(editorCmdsRef.current, 'demote-heading'),
    'bulleted-list': () => runActionBarEditorCommand(editorCmdsRef.current, 'bulleted-list'),
    'numbered-list': () => runActionBarEditorCommand(editorCmdsRef.current, 'numbered-list'),
    'delete-slide': handleDeleteSlide,
    help: () => setHelpOpen(true),
    settings: () => onOpenSettings?.(),
    'guide.open': () => window.dispatchEvent(new Event('tw-guide-open')),
    'check-for-updates': () => { void runCheckForUpdates() },
    'whats-new': openWhatsNewTab,
    'guide.show-button': () => window.dispatchEvent(new Event('tw-guide-show-button')),
    'example.restore': () => window.dispatchEvent(new Event('tw-restore-example')),
    'app.command-palette': () => setCmdMenuOpen(prev => !prev)
  }, (handlerId) => { if (!SELF_REPORTING_HANDLERS.has(handlerId)) commandRan(handlerId) })

  const toolbarItems = (menu: ToolbarMenuName, excludedHandlerIds: string[] = []): MenuItem[] => {
    let lastGroup: string | undefined
    return toolbarCommands(menu).flatMap((registered) => {
      if (excludedHandlerIds.includes(registered.handlerId)) return []
      const handler = commandHandlersRef.current?.[registered.handlerId as PaletteCommandHandlerId]
      if (!handler) {
        if (import.meta.env.DEV) throw new Error(`Toolbar command has no renderer handler: ${registered.handlerId}`)
        return []
      }
      // A command carrying a placement group starts a new visual group when the previous item did
      // not share it — the object inserts (T27) draw one hairline under the built-in insert items.
      const separatorBefore = Boolean(registered.toolbar!.group) && registered.toolbar!.group !== lastGroup
      lastGroup = registered.toolbar!.group
      return [{
        icon: registered.toolbar!.icon,
        label: registered.toolbar!.menuLabel ?? registered.label,
        onClick: handler,
        hint: liveCommandShortcutLabel(registered) || undefined,
        ...(separatorBefore ? { separatorBefore: true } : {})
      }]
    })
  }

  // onSaved is ALSO a dep of that registration effect — inline it and every save-path
  // re-render re-arms the same loop the stable registerEditorCommands exists to break.
  const handleEditorSaved = useCallback(() => { setLastSaved(new Date()); setDirty(false) }, [])

  // The Editor's CodeMirror buffer is the one authoritative copy of the outline text in this window:
  // every save (autosave, flushSave, "Add to talk") writes it, and outlineContent only mirrors it
  // (onContentChange). The Editor stays mounted in every pane state (reverse portal, see
  // editorHostRef), so an option commit goes into that buffer in the slides-only view as well. The
  // old editor-less fallback changed only outlineContent: the buffer's next save — an "Add to talk"
  // made at once, or any later keystroke — wrote the older text and dropped the option.
  function applyOption(entry: LayoutDef | undefined, group: OptionGroup, token: string, targetHeadingLine?: number, targetSlideId?: string | null): string | null {
    return editorApplyOptionRef.current?.(entry, group, token, targetHeadingLine, targetSlideId, targetHeadingLine == null ? undefined : compiledLayoutAtLine(targetHeadingLine)) ?? null
  }

  function applyInspectorOption(entry: LayoutDef | undefined, group: OptionGroup, token: string): string | null {
    const headingLine = headingLineForSlideId(
      outlineContentRef.current,
      inspectedSlideIdRef.current
    )
    if (headingLine == null) return null
    // CodeMirror is the undo/autosave authority in every pane state (applyOption); the commit
    // receives the ID-derived heading explicitly.
    inspectorCommitInProgressRef.current = true
    try {
      return applyOption(entry, group, token, headingLine, inspectedSlideIdRef.current)
    } finally {
      // CodeMirror reports mapped selections synchronously with the commit dispatch. Release after
      // that dispatch settles so the next real pointer/keyboard cursor move follows immediately.
      queueMicrotask(() => { inspectorCommitInProgressRef.current = false })
    }
  }
  // ADR-0032 (ticket 01): the Board section edits the slide BODY, not only its Trigger line. The
  // edit is computed against the editor's own buffer (never the outlineContent mirror), for the
  // slide found by its id in that buffer — a slide without an id yet (a fresh insert before its
  // first save) is refused, like an option commit — and goes in as one undoable change.
  function applyInspectorBoardEdit(edit: BoardEdit): boolean {
    const doc = editorReadRef.current?.()
    if (!doc) return false
    const headingLine = headingLineForSlideId(doc.text, inspectedSlideIdRef.current)
    if (headingLine == null) return false
    const next = applyBoardEditToOutline(doc.text, headingLine, edit)
    if (next === doc.text) return true
    inspectorCommitInProgressRef.current = true
    try {
      return editorReplaceRef.current?.(next) != null
    } finally {
      queueMicrotask(() => { inspectorCommitInProgressRef.current = false })
    }
  }
  // Stable identity: this prop is a dep of the editor's registration effect — an inline
  // lambda here re-fired that effect every render, and the registerOutlineOps?.() call inside
  // setStates in MainApp (fresh ops object) — closing a render loop (see App.registerOutlineOps).
  const registerEditorCommands = useCallback((cmds: NonNullable<(typeof editorCmdsRef)['current']>) => {
    editorCmdsRef.current = cmds
    // The whole-slide operations as the panels get them: editor operations, so each is a step in the
    // one CodeMirror history, the grid's ⌘Z included.
    const slides: SlideBlockOps = cmds.slides
    setSlideOps(slides)
    registerOutlineOps?.({ move: cmds.move, reLevel: cmds.reLevel, moveTo: cmds.moveTo, moveToEnd: cmds.moveToEnd, moveInto: cmds.moveInto, slides })
  }, [registerOutlineOps])


  // With the Guide tab up the column gets a tab row (Guide, Slides, Inspector) over the body it chose.
  // Slides and Inspector keep their own panes and keys; the tab only picks between them.
  const columnUp = guideUp || whatsNewUp
  const whatsNewShown = whatsNewUp && whatsNewActive
  const guideShown = guideUp && guideActive && !whatsNewShown
  const columnTab: RightColumnTab = whatsNewShown ? 'whats-new' : guideShown ? 'guide' : inspectorMode && !railOpen ? 'inspector' : 'slides'
  function selectColumnTab(tab: RightColumnTab): void {
    if (tab === 'whats-new') { setWhatsNewActive(true); setGuideActive(false); return }
    if (tab === 'guide') { setGuideActive(true); setWhatsNewActive(false); return }
    setGuideActive(false)
    setWhatsNewActive(false)
    if (tab === 'inspector' && !inspectorMode) toggleInspector()
    if (tab === 'slides' && inspectorMode) toggleInspector()
  }
  const guidePane = <div className="pane pane--guide">{guide?.body}</div>
  const whatsNewPane = <WhatsNewPane />
  const tabsRow = (hasTalk: boolean): React.ReactNode => (
    <RightColumnTabs guideUp={guideUp} whatsNewUp={whatsNewUp} hasTalk={hasTalk} active={columnTab} onSelect={selectColumnTab} onCloseGuide={() => guide?.onClose()} onCloseWhatsNew={() => { setWhatsNewUp(false); setWhatsNewActive(false) }} />
  )

  if (!activeTalk) {
    return (
      <div className="workspace">
        <div className="workspace-toolbar">
          <span className="workspace-title" style={{ color: 'var(--text-2)', fontWeight: 500 }}>TalkWeaver</span>
          <div className="toolbar-actions">
          <button type="button" className="toolbar-btn" aria-pressed={researchPanelOpen} title={`Research (${liveShortcutLabel('app.research-panel')})`} onClick={() => runRegisteredCommand('research-panel')}>Research <kbd>{liveShortcutLabel('app.research-panel')}</kbd></button>
            <ToolbarMenu
              icon="tools"
              label="Tools"
              title="Studio, history, and app settings"
              items={toolbarItems('tools', ['pathways'])}
            />
          </div>
        </div>
        {(() => {
          const empty = (
            <div className="workspace-empty">
              <div className="workspace-empty-hint">
                Select a Talk from the list to start editing
              </div>
            </div>
          )
          // The Guide opens with no talk open too: it takes the right-hand column beside the empty state.
          if (!columnUp) return empty
          return (
            <div className="workspace-panes workspace-panes--both">
              <ResizablePanes
                left={empty}
                right={<div className="pane pane--tabs" data-right-column>{tabsRow(false)}<div className="pane-tabs-body">{whatsNewShown || !guideUp ? whatsNewPane : guidePane}</div></div>}
                storageKey="tw-split"
                initialLeftPct={55}
              />
            </div>
          )
        })()}
        <StatusBar minimal placeChip={placeChip} />
        <KeyboardHelp isOpen={helpOpen} onClose={() => setHelpOpen(false)} />  {/* no talk open: no Here section */}
      </div>
    )
  }

  // Editor remount key: talk identity + reorder/insert nonce forces a reload from disk after a
  // programmatic content rewrite.
  //
  // Data-loss note (2026-07-05): entering/leaving Focus does NOT change this key (same outlinePath,
  // same nonce) — the reverse-portal already keeps the SAME editor across Focus, which is its whole
  // point. We DELIBERATELY keep `outlinePath` in the key so a TALK SWITCH remounts: each talk then gets
  // its own CodeMirror undo history. Dropping it (one shared instance across talks) would let ⌘Z after
  // a switch revert into the PREVIOUS talk's text, which the autosave would then persist to the NEW
  // talk's file — a worse data-loss vector than the remount it removes. The remount's `doc:''` transient
  // is now provably safe instead: the load effect gates autosave on `loadedPathRef`, empty text is never
  // autosaved/flushed, stale timers are cleared on unmount + talk change, and the main process refuses
  // any empty-over-nonempty write. See Editor.tsx + src/main talk:write-outline.
  // The editor remounts only on a talk switch. Nothing that changes the open talk remounts it (the old
  // reorderNonce bump re-read the file behind the buffer): every change goes through the buffer (D1).
  const editorKey = activeTalk.outlinePath

  // The live Editor — rendered ONCE via a reverse-portal into a persistent host div (editorHostRef),
  // so it survives entering/leaving Focus without a remount. focusRange scopes it to the focused
  // slide's band when in Focus (null otherwise = normal full-outline editing).
  const editorElement = (
    <Editor
      onScratchDrop={handleScratchDrop}
      key={editorKey}
      talk={activeTalk}
      content={outlineContent}
      onContentChange={handleOutlineContentChange}
      onSaved={handleEditorSaved}
      onDirty={setDirty}
      vaultRoot={vaultRoot}
      focusRange={focusRange}
      viewMode={editorViewMode}
      plainLook={plainLook}
      onMarginLevelMenu={(line, anchor) => openMarginMenu('level', line, anchor)}
      onMarginLayoutMenu={(line, anchor) => openMarginMenu('layout', line, anchor)}
      onCaptureEmbedAt={captureEmbedAt}
      registerHeadingTools={(tools) => { headingToolsRef.current = tools }}
      registerPlainIconTools={(tools) => { plainIconToolsRef.current = tools }}
      onPlanRun={() => setPlanSheet({ run: null })}
      textFitNotes={textFitNotes}
      slideLines={slideLines}
      marginLabels={marginLabelList}
      placementRows={compiledSlides}
      registerLayoutContext={(fn) => { editorLayoutContextRef.current = fn }}
      registerApplyLayout={(fn) => { editorApplyLayoutRef.current = fn }}
      registerApplyOption={(fn) => { editorApplyOptionRef.current = fn }}
      focusLine={focusLine}
      onCursorLine={handleCursorLine}
      onPlace={setEditorPlace}
      onImageWidgetClick={(id) => setImageMetaId(id)}
      onOpenHelp={() => setHelpOpen(true)}
      registerInsert={(fn) => { editorInsertRef.current = fn }}
      showResearchInsertion={researchPanelOpen || researchPickerOpen}
      onResearchDrop={(file) => {
        const talk = activeTalkRef.current
        if (!talk) return
        void window.tw.research.list({ talkDir: talk.path, file }).then(reply => {
          if (reply.ok && reply.items[0]) void insertResearchItem(reply.items[0], false)
          else if (!reply.ok) notify(reply.error.message, 'error', 'research-drop')
        })
      }}
      registerInsertObject={(fn) => { editorInsertObjectRef.current = fn }}
      onEditorEngaged={onEditorEngaged}
      compiledLayoutAt={compiledLayoutAtLine}
      onOpenObjectLayoutFamily={(kind) => openLayoutPicker(kind === 'diagram' ? 'smartart' : kind)}
      onInsertObjectMenu={(coords, consumeFence) => openSlideMenu({
        consumeFence,
        startAtFirst: false,
        startAtAction: 'insert-table',
        withText: false,
        at: coords
      })}
      registerEditorCommands={registerEditorCommands}
      registerIconContext={(fn) => { iconContextRef.current = fn }}
      registerReplaceDoc={(fn) => { editorReplaceRef.current = fn }}
      registerReadDoc={(fn) => { editorReadRef.current = fn }}
      onProtectedTokenClick={(token, kind) => {
        if (kind === 'id') {
          const m = token.match(/\{id=([A-Za-z0-9_-]+)\}/)
          if (m) setWhereUsedId(m[1])
        } else {
          // The click parked the caret on the token's slide; the picker's choice merges
          // onto that slide's Trigger line (same-key replace, everything else kept).
          openLayoutPicker()
        }
      }}
    />
  )

  // Normal-mode editor pane: an empty slot the reverse-portal host is moved into (see attachEditorSlot).
  // The action bar (ADR-0025) sits at the top of the SAME column, so the shelf starts where the
  // editor starts — the sidebar and the slide-strip/preview column never move. In Strip and Grid
  // view there is no editor pane, and this column is not rendered at all, so nor is the bar.
  //
  // The bar's rows are rebuilt every render from the SAME palette rows the ⌘⇧P surface lists, so
  // the effective chords re-resolve on the keymap-changed re-render above (a rebinding shows in
  // the tooltip). Hidden, the bar is not rendered at all — no lip, no reserved height.
  const actionBarCommands: ReadonlyMap<string, RunnableActionBarCommand> = new Map(
    paletteCommands().map((command) => {
      const keys = liveCommandShortcutLabel(command)
      return [command.id, {
        label: command.label,
        ...(command.toolbar ? { icon: command.toolbar.icon } : {}),
        ...(keys && keys !== 'no default' ? { keys } : {}),
        run: () => runRegisteredCommand(command.handlerId)
      }]
    })
  )
  const actionBarSections = resolveActionBarItems(
    actionBarItemsFrom(actionBarItemsStored, DEFAULT_ACTION_BAR_ITEMS),
    actionBarCommands
  )
  const editorColumn = (
    <div className="editor-column">
      <EditorTabs mode={editorViewMode} onChange={(mode) => { chooseEditorViewMode(mode); commandRan(mode === 'plain' ? 'view-plain' : 'view-markdown') }} />
      {actionBarVisible && <ActionBar sections={actionBarSections} />}
      <div className="pane pane--editor">
        <div className="editor-portal-slot" ref={attachEditorSlot} />
      </div>
    </div>
  )

  function handleSelectSlide(i: number): void {
    setActiveSlide(i)
    // Keep the Slide-outline sidebar in sync with strip/grid picks (told once per line: lib/activeOutlineLine.ts).
    activeLineReporter.report(slideLines[i] ?? null)
    const target = slideLines[i]
    revealSlideLine(target)
    // Card click: aim the editor viewport but do NOT steal focus — the strip keeps keyboard nav.
    if (target != null) setFocusLine({ line: target, takeFocus: false })
  }

  selectSlideRef.current = handleSelectSlide

  function handleSelectInspectorSlide(i: number): void {
    const row = compiledSlides?.[i]
    if (!row) return
    inspectedSlideIdRef.current = row.slide_id
    inspectedSlideIndexRef.current = i
    setInspectedSlideId(row.slide_id)
    handleSelectSlide(i)
  }

  // Enter / double-click on a card: put the CARET in that slide's source, focused and ready
  // to type. The one deliberate contrast with handleSelectSlide (select + aim, never steal
  // focus): editing is an explicit act, so here the editor takes over. From the grid this
  // leaves grid mode (recording that Esc in the editor returns there); from a strip-only
  // pane it opens editor+slides, since editing needs the editor on screen.
  function handleEditSlide(i: number): void {
    setActiveSlide(i)
    activeLineReporter.report(slideLines[i] ?? null)
    const target = slideLines[i]
    if (target == null) return
    revealSlideLine(target)
    if (gridModeRef.current) {
      returnToGridRef.current = true
      setGridMode(false)
      if (paneState === 'strip') setPaneState('both')
    } else if (paneState === 'strip') {
      setPaneState('both')
    }
    setFocusLine({ line: target, takeFocus: true })
  }

  function handleDoctorJumpToLine(line: number): void {
    if (gridModeRef.current) setGridMode(false)
    if (paneState === 'strip') setPaneState('both')
    if (focusSlideRef.current != null) exitFocus()
    revealSlideLine(line)
    setFocusLine({ line, takeFocus: true })
  }

  // Layout Doctor's one fix (plain view ticket 15): a title's icon goes from its layout line to the
  // title. Worked out on the buffer as it stands (D1 seam) by a verb that keeps the move only when
  // it has read the result back (shared/title-icon-restore.ts); a refusal leaves the buffer as it is.
  // The finding is bound to the talk and the exact text the Doctor read it from (`scan`): the move is
  // made only while the editor still holds that text, compared at the moment of applying.
  async function handleDoctorRestoreTitleIcon(finding: LayoutDoctorFinding, scan: { outlinePath: string; text: string }): Promise<string | null> {
    const talk = activeTalkRef.current
    if (!talk || talk.outlinePath !== scan.outlinePath) return 'This talk is not open in the editor, so nothing was changed.'
    return applyScannedTitleIconRestore((mutate, options) => applyOutlineMutation(scan.outlinePath, mutate, options), scan.text, finding)
  }

  const inspectorPane = (
    <div className="pane pane--inspector">
      <Inspector
        talk={activeTalk}
        compiledSlides={compiledSlides}
        outlineContent={outlineContent}
        triggerFindings={triggerFindings}
        activeIndex={inspectedSlideIndex}
        headingLine={slideLines[inspectedSlideIndex] ?? null}
        onPrev={() => handleSelectInspectorSlide(navigateInspectorSlide(inspectedSlideIndex, -1, compiledSlides?.length ?? 0))}
        onNext={() => handleSelectInspectorSlide(navigateInspectorSlide(inspectedSlideIndex, 1, compiledSlides?.length ?? 0))}
        onEdit={() => handleEditSlide(inspectedSlideIndex)}
        onExplain={() => setExplainIndex(inspectedSlideIndex)}
        onOpenLayoutDoctor={() => runRegisteredCommand('layout-doctor')}
        onCaptureEmbed={captureEmbed}
        onRemoveSavedView={removeSavedView}
        onCommitOption={applyInspectorOption}
        onBoardEdit={applyInspectorBoardEdit}
        onChangeLayout={() => openLayoutPicker()}
        picker={layoutPicker ? {
          tryOutline: pickerTryOutline,
          tryLabel: pickerTryOutline && pickerTry ? LAYOUTS.find((entry) => entry.name === pickerTry)?.label ?? null : null,
          column: (
            <LayoutPickerColumn
              outlinePath={activeTalk.outlinePath}
              outline={outlineContent}
              slide={pickerSlide ?? layoutPicker.slide}
              initialQuery={layoutPicker.query}
              onTry={setPickerTry}
              onKeep={keepPickedLayout}
              onClose={closeLayoutPicker}
            />
          )
        } : null}
      />
    </div>
  )

  const stripPane = (
    <div className="pane pane--strip">
      <SlideStrip
        talk={activeTalk}
        compiledSlides={compiledSlides}
        outlineContent={outlineContent}
        triggerFindings={triggerFindings}
        thumbnails={thumbnails}
        activeIndex={activeSlide}
        onSelectSlide={handleSelectSlide}
        onEdit={handleEditSlide}
        slideRefOf={slideRefOf}
        onMoveSlides={handleMoveSlides}
        onExplain={(i) => setExplainIndex(i)}
        markers={feedbackMarkers}
        onMarker={openFeedbackOnSlide}
        onGhost={openFeedbackOnItem}
      />
    </div>
  )

  const feedbackPane = (
    <div className="pane pane--feedback">
      <FeedbackRail
        list={feedback.list}
        slides={railSlides}
        outline={outlineContent}
        activeSlideId={compiledSlides?.[activeSlide]?.slide_id ?? null}
        error={feedback.error}
        focus={feedbackFocus}
        busy={feedbackBusy}
        onSetStatus={(itemId, status) => { void feedback.setStatus(itemId, status) }}
        onAccept={(itemId) => { void handleFeedbackAccept(itemId) }}
        onUndo={(itemId) => { void handleFeedbackUndo(itemId) }}
        onOpenSlide={handleFeedbackOpenSlide}
        onClose={() => setFeedbackOpen(false)}
      />
    </div>
  )

  // Accept / Use theirs and Undo (ticket 06): through the one-writer seam, never a file write
  // (lib/feedbackAccept). The external-change guard's bar holds them while it is up.
  function feedbackAcceptDeps(): FeedbackAcceptDeps<unknown> {
    return {
      targetPath: () => activeTalkRef.current?.outlinePath ?? null,
      diskChanged: () => diskGuard.change != null,
      apply: (outlinePath, mutate) => applyOutlineMutation(outlinePath, mutate),
      setStatus: (itemId, status, edit) => feedback.setStatus(itemId, status, edit),
    }
  }
  async function handleFeedbackAccept(itemId: string): Promise<void> {
    const item = feedback.list?.items.find((i) => i.itemId === itemId)
    if (!item || feedbackBusy) return
    const slideId = item.kind === 'insert' ? item.afterSlideId : item.slideId
    const line = railSlides.find((slide) => slide.slideId === slideId)?.line ?? null
    setFeedbackBusy(itemId)
    feedback.setError(null)
    try {
      const outcome = await acceptProposal(itemId, item, { text: item.baseText, line }, feedbackAcceptDeps())
      if (!outcome.ok) feedback.setError(outcome.error)
    } finally { setFeedbackBusy(null) }
  }
  async function handleFeedbackUndo(itemId: string): Promise<void> {
    const item = feedback.list?.items.find((i) => i.itemId === itemId)
    if (!item?.acceptedEdit || feedbackBusy) return
    setFeedbackBusy(itemId)
    feedback.setError(null)
    try {
      const outcome = await undoAccepted(itemId, item.acceptedEdit, feedbackAcceptDeps())
      if (!outcome.ok) feedback.setError(outcome.error)
    } finally { setFeedbackBusy(null) }
  }
  // Open slide to merge: the caret into the slide's block; the rail stays open beside it with their text.
  function handleFeedbackOpenSlide(slideId: string): void {
    const index = (compiledSlides ?? []).findIndex((row) => row.slide_id === slideId)
    if (index >= 0) handleEditSlide(index)
  }
  // A marker on the slide pane: the rail beside the pane, on that slide (frame 2).
  function openFeedbackBeside(focus: Omit<FeedbackFocus, 'nonce'>): void {
    setGuideActive(false)
    if (gridModeRef.current) setGridMode(false)
    if (paneStateRef.current !== 'both') setPaneState('both')
    setRailWithStrip(true)
    setFeedbackOpen(true)
    setFeedbackFocus((prev) => ({ ...focus, nonce: (prev?.nonce ?? 0) + 1 }))
  }
  function openFeedbackOnSlide(index: number): void {
    const slideId = compiledSlides?.[index]?.slide_id
    if (!slideId) return
    handleSelectSlide(index)
    openFeedbackBeside({ slideId })
  }
  function openFeedbackOnItem(itemId: string): void {
    openFeedbackBeside({ itemId })
  }

  function toggleFeedback(): void {
    setGuideActive(false)
    setRailWithStrip(false)
    setFeedbackFocus(null) // from the toolbar: every item, not the last marker's slide
    setFeedbackOpen((open) => {
      if (!open) {
        // The rail sits beside the outline: bring both on screen.
        if (gridModeRef.current) setGridMode(false)
        if (paneStateRef.current === 'editor') setPaneState('both')
      }
      return !open
    })
  }

  const slidesSurface = railOpen
    ? (railWithStrip ? <div className="pane pane--strip-rail">{stripPane}{feedbackPane}</div> : feedbackPane)
    : inspectorMode ? inspectorPane : stripPane

  const stripSurface = columnUp
    ? <div className="pane pane--tabs" data-right-column>{tabsRow(true)}<div className="pane-tabs-body">{whatsNewShown ? whatsNewPane : guideShown ? guidePane : slidesSurface}</div></div>
    : slidesSurface

  const gridPane = (
    <div className="pane pane--grid">
      <GridView
        talk={activeTalk}
        compiledSlides={compiledSlides}
        triggerFindings={triggerFindings}
        thumbnails={thumbnails}
        previewsPending={previewsPending}
        activeIndex={activeSlide}
        onSelectSlide={handleSelectSlide}
        onEdit={handleEditSlide}
        slideRefOf={slideRefOf}
        onMoveSlides={handleMoveSlides}
        onSetAsideSlides={handleSetAsideSlides}
        onScratchDrop={handleScratchDrop}
        onCutSlides={handleCutSlides}
        onCopySlides={handleCopySlides}
        onStepSlide={handleStepSlide}
        onExplain={(i) => setExplainIndex(i)}
        columns={gridColumns}
        slideOps={slideOps}
        lineOfSlide={lineOfSlideIndex}
        onPasteAfterCard={handlePasteAfterCard}
        onLanded={slideLanded}
        onMoreActions={(i, at) => { activeSlideRef.current = i; openActionsHereRef.current({ region: 'strip', at }) }}
      />
    </div>
  )

  // The focused slide's compiled row supplies the crumb's section + title (authored case).
  const focusRow = focusSlide != null ? (compiledSlides?.[focusSlide] ?? null) : null

  // Status-bar dates (T29) for the active talk — hidden entirely until the talk's metadata has
  // loaded (no placeholder dashes); updates ride the shared facts store.
  const activeMeta = activeTalk ? talkFacts.meta[activeTalk.slug] : undefined
  const talkDates = activeTalk && activeMeta
    ? { createdMs: activeMeta.createdMs, editedMs: activeMeta.editedMs, deliveredMs: talkFacts.lastDelivered[activeTalk.slug] }
    : null

  return (
    <div className="workspace">
      {/* The reused Editor lives here permanently (reverse-portal); attachEditorSlot moves its DOM
          into whichever layout's slot is mounted. Rendering it unconditionally is what stops a
          remount when Focus opens/closes. */}
      {createPortal(editorElement, editorHostRef.current)}
      {publishing && (
        // Non-modal: a corner status toast that NEVER blocks the app — pointer-events off so you can
        // launch Presenter view, edit, etc. while the deploy runs in the background.
        <div
          role="status"
          aria-live="polite"
          aria-label="Publishing handout"
          style={{
            position: 'fixed', right: 18, bottom: 18, zIndex: 3000, pointerEvents: 'none',
            display: 'flex', alignItems: 'center', gap: 12,
            background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 12,
            padding: '12px 16px', maxWidth: 360,
            boxShadow: '0 10px 30px #17202a33, 0 2px 8px #17202a1f', fontFamily: 'var(--font-ui)'
          }}
        >
          <div className="spinner" style={{ width: 22, height: 22, flexShrink: 0 }} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>
              Publishing… <span style={{ color: 'var(--faint)', fontWeight: 500, fontFamily: 'var(--font-mono)' }}>{publishElapsed}s</span>
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              Deploying to Cloudflare — you can keep working.
            </div>
          </div>
        </div>
      )}
      <div className="workspace-row">
      <div className="workspace-main">
      {focusSlide == null ? (
      <>
      <div className={`workspace-toolbar${scratchpadLayout.layout.mode === 'docked' ? ' workspace-toolbar--tight' : ''}`}>
        <span className="workspace-title">{activeTalk.title}</span>
        <div className="pane-toggle">
          <button
            className={`pane-btn ${!gridMode && paneState === 'editor' ? 'pane-btn--active' : ''}`}
            onClick={ran('view-editor', () => selectPane('editor'))}
            title="Editor only"
          >
            <Icon name="pane-editor" size={17} />
          </button>
          <button
            className={`pane-btn ${!gridMode && paneState === 'both' ? 'pane-btn--active' : ''}`}
            onClick={ran('view-both', () => selectPane('both'))}
            title="Editor + slide strip"
          >
            <Icon name="pane-both" size={17} />
          </button>
          <button
            className={`pane-btn ${!gridMode && paneState === 'strip' ? 'pane-btn--active' : ''}`}
            onClick={ran('view-strip', () => selectPane('strip'))}
            title="Slide strip only"
          >
            <Icon name="pane-strip" size={17} />
          </button>
          <button
            className={`pane-btn ${gridMode ? 'pane-btn--active' : ''}`}
            onClick={ran('view-grid', () => setGridMode(true))}
            title="Grid"
            data-testid="grid-toggle"
          >
            <Icon name="pane-grid" size={17} />
          </button>
        </div>
        {gridMode && (
          <div className="grid-col-selector" role="group" aria-label="Grid columns">
            <span className="grid-col-label">Cols</span>
            {[1, 2, 3, 4, 5, 6].map((n) => (
              <button
                key={n}
                type="button"
                className={`grid-col-btn ${gridColumns === n ? 'grid-col-btn--active' : ''}`}
                data-columns={n}
                aria-pressed={gridColumns === n}
                onClick={() => setGridColumns(n)}
                title={`${n} column${n === 1 ? '' : 's'}`}
              >
                {n}
              </button>
            ))}
          </div>
        )}
        <div className="toolbar-actions">
          {activeShare && (
            <button
              type="button"
              className={`toolbar-btn${railOpen ? ' is-on' : ''}`}
              onClick={toggleFeedback}
              title={railOpen ? 'Close feedback' : 'Feedback from the shared talk'}
              aria-pressed={railOpen}
              data-testid="toolbar-feedback"
            >
              <span className="toolbar-btn-content">
                <Icon name="inbox" size={15} />
                <span>Feedback</span>
                {(activeFeedback?.unread ?? 0) > 0 && <span className="fb-n" data-testid="toolbar-feedback-count">{activeFeedback!.unread}</span>}
              </span>
            </button>
          )}
          <ToolbarMenu
            icon="share"
            label="Share"
            title="Export, build, or publish this talk"
            items={[
              { icon: 'handout', label: 'Handout (reveal in Finder)', onClick: ran('handout', handleExportHandout) },
              { icon: 'html', label: 'HTML presentation (reveal in Finder)', onClick: ran('build', handleBuild) },
              { icon: 'publish', label: publishing ? 'Publishing…' : 'Publish to Cloudflare', onClick: ran('publish-handout', requestPublishHandout), disabled: publishing },
              { icon: 'comment', label: 'Share for comments…', onClick: ran('share-for-comments', handleShareForComments), separatorBefore: true }
            ]}
          />
          <ToolbarMenu
            icon="insert"
            label="Insert"
            title="Insert content into the current slide"
            items={[
              ...toolbarItems('insert'),
              // The Slide Scratchpad opens from here (and from the palette and View menu); collapsed, its pill is the way back.
              { icon: 'insert', label: `Slide Scratchpad · ${scratchpad.activeCount}`, onClick: ran('scratchpad-panel', () => { if (activeTalkRef.current) scratchpadLayout.expand() }), separatorBefore: true }
            ]}
          />
          <ToolbarMenu
            icon="design"
            label="Deck"
            title="Deck setup for this talk"
            items={toolbarItems('deck')}
          />
          <ToolbarMenu
            icon="tools"
            label="Tools"
            title="Studio, history, and app settings"
            items={toolbarItems('tools')}
          />
          <ToolbarMenu
            icon="present"
            label="Present"
            primary
            title="Present this talk"
            items={toolbarItems('present')}
          />
        </div>
      </div>

      {diskChangeBar}
      <div
        className={`workspace-panes workspace-panes--${gridMode ? 'grid' : paneState}${imageDropping ? ' workspace-panes--dropping' : ''}`}
        onDragOver={handleDrawerDragOver}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setImageDropping(null) }}
        onDrop={handleDrawerDrop}
      >
        {gridMode ? (
          gridPane
        ) : (
          <>
            {paneState === 'editor' && editorColumn}
            {paneState === 'strip' && stripSurface}
            {paneState === 'both' && (
              <ResizablePanes
                left={editorColumn}
                right={stripSurface}
                minRightPx={layoutPicker ? 400 : undefined}
                storageKey="tw-split"
                initialLeftPct={55}
              />
            )}
          </>
        )}
        <DropHint kind={imageDropping} />
      </div>
      <StatusBar
        placeChip={placeChip}
        slideCount={compiledSlides?.length ?? null}
        wordCount={wordCount}
        lastSaved={lastSaved}
        dirty={dirty}
        compiling={compiling}
        buildStatus={buildStatus}
        buildPath={buildPath}
        dates={talkDates}
        runChips={activeTalk && activeConflicts > 0 ? (
          <ConflictLine talk={{ ...activeTalk, conflicts: activeConflicts }} className="tw-status-conflict" />
        ) : null}
        runChip={activeTalk ? <RunStatusChips talk={activeTalk} /> : null}
        shared={activeShare ? {
          label: shareEnded ? ENDED_LABEL : feedbackPaused ? PAUSED_LABEL : sharedStatusLabel(activeShare),
          title: shareEnded
            ? 'This link no longer takes comments. Open to stop sharing or share again.'
            : feedbackPaused
              ? 'Editing and saving carry on as normal. What they send arrives when the link is back.'
              : activeShare.lastError ? `Their page is not up to date: ${activeShare.lastError}` : activeShare.url,
          error: !feedbackPaused && !shareEnded && Boolean(activeShare.lastError),
          paused: feedbackPaused && !shareEnded,
          ended: shareEnded,
          onClick: () => setShareSheetOpen(true),
        } : null}
      />
      </>
      ) : (
        <SlideFocus
          talk={activeTalk}
          vaultRoot={vaultRoot}
          slideIndex={focusSlide}
          slideCount={compiledSlides?.length ?? 0}
          section={readableSectionLabel(compiledSlides, focusSlide)}
          slideTitle={plainInlineText(focusRow?.nav_title || focusRow?.title)}
          compiledSlideId={focusRow?.slide_id || ''}
          headingLine={slideLines[focusSlide] ?? null}
          outlineContent={outlineContent}
          editorSlotRef={attachEditorSlot}
          banner={diskChangeBar || null}
          onPrev={() => focusStep(-1)}
          onNext={() => focusStep(1)}
          onExit={exitFocus}
          onAdoptCurrent={handleAdoptCurrent}
          onDetach={handleDetach}
          onShowOutlineLine={() => { const l = slideLinesRef.current[focusSlide]; if (l != null) setFocusLine({ line: l, takeFocus: true }) }}
          suspendKeys={helpOpen || adoptTarget != null}
        />
      )}
      </div>
      <ScratchpadPanel
        key={`scratchpad:${activeTalk.outlinePath}`} data={scratchpad} layoutApi={scratchpadLayout}
        registerActions={registerScratchpadActions} onOpenSlideBrowser={() => setBrowserOpen(true)}
        insert={scratchInsertApi} outlineText={outlineContent}
      />
      <ResearchPanel
        key={activeTalk.outlinePath} talkDir={activeTalk.path} panelOpen={researchPanelOpen} pickerOpen={researchPickerOpen}
        refresh={researchRefresh} highlightedFile={researchHighlight} registerActions={registerResearchActions} onCommand={id => runRegisteredCommand(id as PaletteCommandHandlerId)}
        onClosePanel={() => { setResearchPanelOpen(false); focusEditor() }} onClosePicker={() => { setResearchPickerOpen(false); focusEditor() }}
        onOpenPanel={() => { setResearchPanelOpen(true); setResearchPickerOpen(false) }}
        onCapture={drop => { researchCaptureDropRef.current = drop ?? null; runRegisteredCommand('research-capture') }} onRevealFolder={() => runRegisteredCommand('research-reveal-folder')}
        onInsert={async (item, slide) => { const reply = await window.tw.research.insert(item.file, slide); if (!reply.ok) notify(reply.error.message, 'warning', 'research-insert'); return reply.ok }} onJump={jumpToResearchUse}
      />
      {imageDrawerOpen && activeTalk && (
        <ImageDrawer
          currentTalkPath={activeTalk.outlinePath}
          onInsert={(hit) => insertDrawerImage(hit.thumbUrl)}
          onInsertOldSlide={insertOldSlideAfterCurrent}
          currentSlide={activeSlide + 1}
          onClose={closeImageDrawer}
        />
      )}
      </div>
      {diskGuard.sheet && <OutlineDiskChangeSheet change={diskGuard.sheet} onAnswer={diskGuard.answerSheet} />}
      <SearchPalette
        isOpen={searchOpen}
        onClose={() => { setSearchOpen(false); focusEditor() }}
        onInsert={handleSearchInsert}
        onInsertMany={handleSearchInsertMany}
        currentTalkSlug={activeTalk?.slug ?? ''}
      />
      <SlideBrowser
        isOpen={browserOpen}
        onClose={() => { setBrowserOpen(false); focusEditor() }}
        onInsert={handleSearchInsert}
        onInsertMany={handleSearchInsertMany}
        currentTalkSlug={activeTalk?.slug ?? ''}
        currentOutlinePath={activeTalk?.outlinePath}
        currentTalkVaultId={activeTalk?.vaultId}
        vaultRoot={vaultRoot}
        onOpenHelp={() => setHelpOpen(true)}
        // The command palette opens above the Browser: its keys are the palette's alone.
        suspendKeys={helpOpen || cmdMenuOpen || adoptTarget != null || mergeRequest != null}
        onAdoptVersion={(slideId, version) => setAdoptTarget({ slideId, version })}
        onRequestMerge={(req) => setMergeRequest(req)}
        refreshNonce={mergeNonce}
        registerFocusSearch={(fn) => { browserFocusSearchRef.current = fn }}
        registerCommands={registerPickerCommands}
      />
      {tagSlide && (
        <TagPicker
          isOpen
          count={1}
          tagLists={[tagSlide.tags]}
          onToggle={(tag, action) => void applyTagToCurrentSlide(tag, action)}
          onClose={() => setTagSlide(null)}
          anchor="toolbar"
          busy={tagSlideBusy}
        />
      )}
      {adoptTarget && (
        // No onAdopted re-read: ledger:adopt writes every target through the one writer
        // (talk-writer.ts), so the talk open here was changed IN THIS BUFFER through the D1 seam and
        // saved through its queue before the adopt resolved; other targets are closed talks main
        // wrote on disk. (Re-reading the file and replacing the buffer with it reverted anything
        // typed between that save and the read.)
        <PropagationChecklist
          isOpen
          onClose={() => setAdoptTarget(null)}
          slideId={adoptTarget.slideId}
          adoptVersion={adoptTarget.version}
          currentOutlinePath={activeTalk?.outlinePath ?? null}
          vaultRoot={vaultRoot}
          suspendKeys={helpOpen}
        />
      )}
      {mergeRequest && (
        <MergeConfirm
          isOpen
          onClose={() => setMergeRequest(null)}
          request={mergeRequest}
          vaultRoot={vaultRoot}
          onMerged={() => setMergeNonce((n) => n + 1)}
          suspendKeys={helpOpen}
        />
      )}
      {iconPickerOpen && (
        // Wrapper carries the class + data hook the e2e harness targets (the component styles
        // inline and renders inline, so `.icon-picker [data-icon-search]` resolves).
        <div className="icon-picker" data-icon-picker>
          <IconPicker
            isOpen={iconPickerOpen}
            onClose={() => { setIconPickerOpen(false); focusEditor() }}
            onIconSelected={handleIconPicked}
          />
        </div>
      )}
      <ImageMetaPanel
        imageId={imageMetaId}
        vaultRoot={vaultRoot}
        onClose={() => setImageMetaId(null)}
      />
      {activeTalk && (
        <DeckDesignPanel
          isOpen={deckDesignOpen}
          outlineContent={outlineContent}
          activeTalk={activeTalk}
          onClose={() => setDeckDesignOpen(false)}
          onSave={handleDeckDesignSave}
        />
      )}
      <AbstractPanel
        talk={activeTalk}
        isOpen={abstractOpen}
        onClose={() => setAbstractOpen(false)}
      />
      <KeyboardHelp
        isOpen={helpOpen}
        onClose={() => setHelpOpen(false)}
        place={place}
        placeRow={placeRow}
        quoteSlide={quoteSlideAtCaret}
        onRun={runSheetRow}
        canRunCarried={sheetCanRunCarried}
      />
      <ExplainPanel
        isOpen={explainIndex != null}
        onClose={() => setExplainIndex(null)}
        outlinePath={activeTalk.outlinePath}
        content={outlineContent}
        index={explainIndex}
        onInsertExample={(layout) => {
          const doc = editorReadRef.current?.()
          const row = explainIndex == null ? null : compiledSlidesRef.current?.[explainIndex]
          if (!doc || doc.path !== activeTalk.outlinePath || !row?.slide_id) return
          try {
            const read = readOutlineSlides(doc.text)
            const target = read.slides.find((slide) => slide.id && slide.id === row.slide_id)
              ?? read.slides.find((slide) => slide.line === row.source_line
                && read.lines[slide.start] === row.source_markdown?.split('\n')[0])
            if (!target) {
              notify('The slide changed. Close Explain and open it again before inserting an example.', 'info', 'layout-example')
              return
            }
            const ref: SlideRef = target.id || { headingLine: target.line }
            const withExample = setLayout(doc.text, ref, layout, [], true)
            const layoutOnly = setLayout(doc.text, ref, layout)
            if (withExample.outline === layoutOnly.outline) {
              notify('Insert the example on an empty slide, or copy it from Explain.', 'info', 'layout-example')
              return
            }
            editorReplaceRef.current?.(withExample.outline)
            setExplainIndex(null)
            focusEditor()
          } catch (error) {
            notify(error instanceof LayoutVerbError ? error.detail : 'The example could not be inserted.', 'warning', 'layout-example')
          }
        }}
      />
      {publishNotReady && (
        <PublishNotReadySheet
          what="Publish handout"
          notReady={publishNotReady}
          onClose={() => setPublishNotReady(null)}
          onSaveAsFile={() => { void handleExportHandout() }}
        />
      )}
      {publishWorkNoticeText && (
        <PublishWorkNoticeSheet
          talkTitle={activeTalk.title || activeTalk.slug}
          notice={publishWorkNoticeText}
          onCancel={() => setPublishWorkNoticeText(null)}
          onPublish={() => { setPublishWorkNoticeText(null); void handlePublishHandout() }}
          onPlanRun={() => { setPublishWorkNoticeText(null); setPlanSheet({ run: null }) }}
        />
      )}
      {shareSheetOpen && (
        <ShareSheet
          key={activeTalk.outlinePath}
          talk={activeTalk}
          title={activeTalk.title || activeTalk.slug}
          onClose={closeShareSheet}
        />
      )}
      {planSheet && (
        <PlanRunSheet
          key={`${activeTalk.outlinePath}:${planSheet.run?.id ?? 'new'}`}
          talk={{ slug: activeTalk.slug, title: activeTalk.title || activeTalk.slug, outlinePath: activeTalk.outlinePath, vaultId: activeTalk.vaultId }}
          run={planSheet.run}
          onClose={() => setPlanSheet(null)}
          onSaved={() => setPlanSheet(null)}
        />
      )}
      {captureSheet && (
        <CaptureResearchSheet
          key={activeTalk.outlinePath}
          talkDir={activeTalk.path}
          talkTitle={activeTalk.title || activeTalk.slug}
          initialBody={captureSheet.body}
          initialArtefact={captureSheet.artefact}
          onCaptured={file => setResearchHighlight(file)}
          onClose={() => { setCaptureSheet(null); setResearchRefresh(n => n + 1) }}
        />
      )}
      {whereUsedId && (
        <WhereUsedPanel slideId={whereUsedId} onClose={() => setWhereUsedId(null)} />
      )}
      <EmbedCheckPanel
        isOpen={embedCheckOpen}
        onClose={() => setEmbedCheckOpen(false)}
        outlinePath={activeTalk.outlinePath}
        content={outlineContent}
      />
      <LayoutDoctorPanel
        isOpen={layoutDoctorOpen}
        onClose={() => setLayoutDoctorOpen(false)}
        talk={activeTalk}
        outlineText={outlineContent}
        slideRows={compiledSlides}
        onJumpToLine={handleDoctorJumpToLine}
        onRestoreTitleIcon={handleDoctorRestoreTitleIcon}
      />
      {unresolvedBlock && createPortal(
        <div
          className="tw-unresolved-block-backdrop"
          onMouseDown={(event) => { if (event.target === event.currentTarget) setUnresolvedBlock(null) }}
        >
          <div className="tw-unresolved-block" role="dialog" aria-modal="true" aria-labelledby="tw-unresolved-block-title">
            <h2 id="tw-unresolved-block-title">Unresolved triggers</h2>
            <p>
              {unresolvedBlock.message}
              {' '}The first is “{unresolvedBlock.firstTitle}” at line {unresolvedBlock.firstLine}.
            </p>
            <div className="tw-unresolved-block-actions">
              <button
                type="button"
                className="tw-unresolved-block-primary"
                onClick={() => {
                  setUnresolvedBlock(null)
                  runRegisteredCommand('layout-doctor')
                }}
              >
                Open Layout Doctor
              </button>
              <button type="button" onClick={() => setUnresolvedBlock(null)}>Cancel</button>
            </div>
          </div>
        </div>,
        document.body
      )}
      <CommandMenu
        isOpen={cmdMenuOpen}
        initialQuery={cmdMenuQuery}
        onClose={() => { setCmdMenuOpen(false); setCmdMenuQuery('') }}
        // Every command, each with its task group (onboarding 01). The few it cannot run are
        // the written exclusion list in command-registry.ts (PALETTE_EXCLUSIONS).
        commands={listedPaletteCommands().map((command): Command => ({
          id: command.id,
          title: command.label,
          hint: liveCommandShortcutLabel(command),
          group: command.taskGroup ?? undefined,
          keywords: command.palette.keywords,
          run: () => runListedCommand(command)
        }))}
      />
      <SlideRowMenus
        request={moveRequest}
        rows={moveRequest ? slideRows(editorReadRef.current?.()?.text ?? outlineContent) : []}
        ops={slideOps}
        onClose={() => setMoveRequest(null)}
        onActed={() => { if (!gridModeRef.current && focusRegionRef.current === 'editor') focusEditor() }}
        onLanded={slideLanded}
      />
      {actionsHere && (
        <ActionsHerePanel
          x={actionsHere.x}
          y={actionsHere.y}
          rows={actionRowsAt(actionsHere.place, { quoteSlide: quoteSlideAtCaret })}
          chordOf={liveShortcutLabel}
          paletteChord={paletteChordText(liveShortcutLabel('app.command-palette'))}
          onRun={runActionRow}
          onAllCommands={openPaletteWith}
          onClose={closeActionsHere}
        />
      )}
      {marginMenuView}
      {plainIcon.view}
      {slideMenu && (
        <SlideContextMenu
          x={slideMenu.x}
          y={slideMenu.y}
          startAtFirst={slideMenu.startAtFirst}
          startAtAction={slideMenu.startAtAction}
          withText={slideMenu.withText}
          onAction={handleSlideMenuAction}
          consumeFence={slideMenu.consumeFence}
          currentLayoutName={selectionFromTriggerLine(
            editorLayoutContextRef.current?.()?.triggerLine ?? '', LAYOUTS
          ).find((entry) => entry.kind === 'layout')?.name}
          onSetLayout={(layout) => {
            const context = editorLayoutContextRef.current?.()
            if (context) {
              const initial = selectionFromTriggerLine(context.triggerLine, LAYOUTS)
              editorApplyLayoutRef.current?.(initial, toggleLayoutSelection(initial, layout))
            }
            setSlideMenu(null)
          }}
          onClose={() => { setSlideMenu(null); focusEditor() }}
        />
      )}
    </div>
  )
}
