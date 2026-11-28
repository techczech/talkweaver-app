import { editVideoMarker, scanOutlineVideos, type AuthoredVideo, type VideoMarkerEdit } from '../../../shared/video-marker-edits'
import type { VideoMarkerPanel } from './VideoMarkerPage'
import { useMarkerPreview } from './useMarkerPreview'
import { NARROW_WINDOW_PX } from '../../../shared/window-widths'
import { withOutlineEditReplay } from '../extensions/savedTextAdoption'
import { requestSlideThumbnails } from '../lib/slideThumbnails'
import { createLiveCompile } from '../lib/liveCompile'
import { plainTalkTitle } from '../../../shared/plain-title'
import { editInlinePicture, pooledImageOnLine, replaceEditedImageUse } from '../../../shared/image-edit'
import { selectOfflinePage, offlinePageReplacement, type OfflinePageSelection } from '../lib/offlinePage'
import { outlineDiskChanges } from '../lib/outlineDiskChange'
import { isWorkspaceCovered } from '../lib/workspaceCover'
import { isSlideMergeReviewOpen } from '../lib/slideMergeTransaction'
import { clipboardHasText, htmlClipboardText } from '../lib/clipboardText'
import { projectGridMove } from '../../../shared/slide-handling/grid-move-projection'
import { runSetAside, type SetAsideHost } from '../lib/slideSetAside'
import { retainMatchingThumbnails } from '../../../shared/slide-preview'
import { insertResearchItem as insertResearchItemInEditor } from '../lib/research-insert'
import { plainInlineText } from '../../../../compiler/scripts/lib/00-inline-render.mjs'
import { runActionBarEditorCommand } from './actionBar/command-runner'
import { venueScreenLinkFromOutline } from '../../../shared/venue-screen-link'
import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, useSyncExternalStore, useId } from 'react'
import { createPortal } from 'react-dom'
import type { TalkInfo, ProjectionRow, RecordingSession } from '../../../preload/index'
import { textFitNotesFor } from '../../../shared/text-fit-notes.ts'
import { computeSlideLines } from '../../../shared/slide-lines.ts'
import { marginLabels, MARGIN_LAYOUT_NAMES } from '../../../shared/plain-view-margin.ts'
import { levelMenuFor, setHeadingKind, type HeadingKind } from '../../../shared/heading-kind.ts'
import { dismissToast, notify } from '../lib/notify'
import type { HeadingCompletionSource } from '../extensions/triggerComplete'
import Editor, { type CommitSlideMerge, type HeadingTools, type ObjectInsertHandler, type PlainIconTools, type ReadEditorDoc, type ReplaceEditorDoc, type SlideBlockOps } from './Editor'
import MarginMenu, { MORE_IN_INSPECTOR_KEY } from './MarginMenu'
import { slideSelectionControls } from '../lib/slideSelectionBus'
import { rememberSlideClip } from '../extensions/slideBlockOps'
import SlideRowMenus, { writeSlideClipboard, type SlideMenuRequest } from './SlideRowMenus'
import { slideRows } from '../extensions/slideOutline'
import { pressAttachOnStrip } from '../extensions/workStrips'
import { moveSubject } from '../lib/moveDestinations'
import { publishSlideThumbs, publishWidgetTitles, searchSurface } from '../lib/slideSearch'
import { getStripNumbers, outlineMarksToPublish, outlineNumbers, publishOutlineMarks, publishStripNumbers, stripNumbersToPublish, subscribeStripNumbers } from '../lib/stripNumbers'
import { getOutlineSelection } from '../lib/outlineSelection'
import SlideFocus from './SlideFocus'
import type { FocusRange } from '../extensions/focusScope'
import { extractSlideBlock, focusRangeForSlideLine, firstFocusableFrom, nextFocusableSlide, readableSectionLabel } from './slideFocusModel'
import Inspector from './Inspector'
import { applyBoardEditToOutline, type BoardEdit } from '../../../../compiler/scripts/lib/board-slide.mjs'
import SlideStrip from './SlideStrip'
import SlidesOrganizer from './SlidesOrganizer'
import { designName, panelEdit, type Design } from './rightPanelDesigns'
import CopyForAgentDialog, { type HandoffReady } from './CopyForAgentDialog'
import { normalizeOutlineMergeText } from '../../../shared/outline-merge'
import type { PanelTry } from './RightPanelPictures'
import { isKnownIcon } from './plainIconPickerModel'
import { clearLineIcon, setLineIcon, setExistingLineIconCross } from '../../../shared/icon-verbs'
import { StructureAddLine, StructureFooter, StructureMenu, type StructureActions } from './StructureControls'
import { carouselPaneSibling, createSection, groupSection, groupSectionReason, NONCONTIGUOUS, NO_SECTION, nodeAtSourceLine, reorderStructure, structureDrop, structureOf, subsectionOwner, type DropSide, type SectionKind } from '../../../shared/talk-structure'
import { slideKeys, useSlideSelection } from '../lib/useSlideSelection'
import RightColumnTabs from './RightColumnTabs'
import WhatsNewPane from './WhatsNewPane'
import { WHATS_NEW_OPEN_EVENT, openWhatsNewTab, runCheckForUpdates } from '../lib/updateNotices'
import type { RightColumnTab } from '../../../shared/guide'
import GridView from './GridView'
import PathwaysView, { usePathways } from './PathwaysView'
import StatusBar from './StatusBar'
import { usePlace } from '../lib/usePlace'
import { placeAt, type Place } from '../../../shared/place.ts'
import { actionRowsAt, paletteChordText, type ActionRow } from '../../../shared/actions-here.ts'
import ActionsHerePanel from './ActionsHerePanel'
import type { SheetRow } from '../../../shared/keyboard-sheet.ts'
import { useTalkFacts } from '../lib/talkFacts'
import RevealPreviewBadge from './RevealPreviewBadge'
import LayoutPickerColumn from './LayoutPickerColumn'
import { reanchorPickerSlide, selectionFromTriggerLine, toggleLayoutSelection, type LayoutPickerContext } from './layoutPickerModel'
import { LayoutVerbError, chooseLayout, clearLayout, isQuoteSlide, previewLayout, setLayout, type QuoteFormChoice, type SlideRef } from '../../../shared/layout-verbs'
import { reportTriggerMergeWarnings } from '../../../shared/trigger-line'
import { readOutlineSlides, slidePointLines } from '../../../shared/feedback-accept'
import { LAYOUTS, type LayoutDef, type OptionGroup } from '../data/layouts'
import SearchPalette from './SearchPalette'
import SlideBrowser from './SlideBrowser'
import PropagationChecklist, { type AdoptVersion } from './PropagationChecklist'
import MergeConfirm from './MergeConfirm'
import ShareSheet from './ShareSheet'
import PublishNotReadySheet from './PublishNotReadySheet'
import PublishDetailsSheet from './PublishDetailsSheet'
import { interruptedPublishDiagnostic, publishDiagnosticTitle, type PublishDiagnostic } from '../../../shared/publish-diagnostic'
import { useHandoutPublishProgress } from '../lib/useHandoutPublishProgress'
import PublishWorkNoticeSheet from './PublishWorkNoticeSheet'
import { publishWorkNotice } from '../../../shared/publish-work-notice.ts'
import { readTalkWorkNames } from '../../../shared/work-files-view.ts'
import { earlierHandoutsToast, publishedWithoutLiveToast } from '../lib/publish-failure-toast'
import type { MediaPublishChoice, PublishNotReady } from '../../../preload/index'
import PlanRunSheet from './PlanRunSheet'
import CaptureResearchSheet from './CaptureResearchSheet'
import ResearchPanel, { type ResearchActions } from './ResearchPanel'
import ScratchpadPanel, { type ScratchpadActions } from './scratchpad/ScratchpadPanel'
import type { PlaceChoice, ScratchpadInsertApi } from './scratchpad/ScratchpadInsert'
import { prepareScratchBatchSlide, runScratchBatch, runScratchInsert, type ScratchInsertHost } from '../lib/scratchpadInsert'
import { settlePlace, type ScratchPlace, type ScratchVisual } from '../../../shared/scratchpad-insert'
import { blockAt, copyBlocks, cutBlocks, moveBlocks, refAt, refHolds, stepPlace, type SlideRef as MoveRef } from '../../../shared/slide-handling/blocks'
import type { SlidePlace } from '../../../shared/slide-handling/place'
import type { ScratchItem } from '../../../shared/scratchpad'
import SketchView from './SketchView'
import SketchReview, { SketchBreakdowns } from './SketchReview'
import { reviewSlides, type SketchReview as SketchReviewState } from '../../../shared/sketch-review'
import { sketchPictureReferences } from '../../../shared/sketch-breakdown'
import { planSketchApply } from '../../../shared/sketch-apply'
import { placeForLine, scratchSectionPlace } from '../../../shared/scratchpad-insert'
import { useSketch } from '../lib/useSketch'
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
import { DropHint, IMAGE_DRAG_TYPE, OLD_SLIDE_DRAG_TYPE, OLD_SLIDE_DROP_EVENT } from './ImageDrawer'
import FindPanel, { type FindMode } from './FindPanel'
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
import TalkTab from './TalkTab'
import { TalkMetadataLeaveDialog, useTalkMetadata, type CommitMetadata } from './useTalkMetadata'
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
import { captureSourceBlock, openCaptureEmbed, planSavedViewRemoval } from '../lib/captureEmbed'
import { extractInspectorSlideBlock as captureEmbedSlideBlock } from './inspectorModel'
import { effectiveKeys, eventMatchesEffectiveShortcut, liveCommandShortcutLabel, liveShortcutLabel, onKeymapChanged } from '../keymap/store'
import { chordEventInit } from '../../../shared/chord-event'
import { shortcutById } from '../../../shared/shortcut-registry'
import { isTypingKey, surfaceKey } from '../keymap/surfaceKeys'
import type { PickerCommandOutcome, SlidePickerCommands } from './slidePickerCommands'
import ActionBar from './actionBar/ActionBar'
import EditorTabs from './EditorTabs'
import WorkspaceSlideView from './WorkspaceSlideView'
import { VIEW_COMMANDS, WORKSPACE_VIEWS, type SlideTabView, type SlidesPanelView, type StartingView, type WorkspaceView } from '../../../shared/workspace-view'
import { completeBlankSlide, isEmptyAuthoringSlide, placeBlankSlide, placePictures, splitPictureRow } from '../../../shared/redesign-window-source'
import { notesGet, notesInsert, notesRemove, notesReplace } from '../../../shared/objects/object-verbs'
import { ChevronDown, ChevronRight, Image, Plus, SmilePlus, Table2 } from 'lucide-react'
import { copyBlock, pasteSlides } from '../../../shared/slide-handling/slide-block-ops'
import '../workspace-views.css'
import { PLAIN_LOOK_DEFAULT, type PlainLook } from '../../../shared/plain-view-look'
import type { EditorViewMode } from '../../../shared/editor-view-mode'
import OutlineDiskChangeBar, { OutlineDiskChangeChip, OutlineDiskChangeSheet } from './OutlineDiskChangeBar'
import { useOutlineDiskChange } from './useOutlineDiskChange'
import OutlineMergeSheet from './OutlineMergeSheet'
import SlideMergeCards from './SlideMergeCards'
import SlideDiskReview from './SlideDiskReview'
import { singleSlideDiskReview } from '../lib/slideDiskReview'
import { noteOutlineSaveReply } from '../lib/outlineDiskChange'
import {
  DEFAULT_ACTION_BAR_ITEMS,
  resolveActionBarItems,
  type RunnableActionBarCommand
} from './actionBar/model'
import { ACTION_BAR_SEPARATOR, actionBarItemsFrom } from '../../../shared/action-bar-settings'
import SlideContextMenu, { type SlideMenuAction } from './SlideContextMenu'
import type { ConsumeInsertFence } from '../extensions/objectBlocks/field'
import type { ObjectInsertRequest } from '../../../shared/objects/insert-objects'
import { outlineWritesSettled, queueOutlineWrite } from '../lib/saveQueue'
import { createOutlineMutator, type OutlineMutate, type OutlineMutationOptions, type OutlineMutationResult, type OutlineMutator } from '../lib/outlineMutation'
import { handoutAddressLabel } from '../../../shared/publish-status'
import { stampHandoutUrl } from '../../../shared/handout-stamp'
import { commandRan, ran, reportingHandlers, setCommandRanContext } from '../commands/command-ran'
import { editFrontmatterText, parseFrontmatterPairs, type FrontmatterEdit } from '../../../shared/frontmatter-editor'
import type { CursorListItemContext } from '../extensions/outliner'
import {
  headingLineForSlideId,
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
// The action bar's line controls: unavailable (dimmed in place) while a closed object is selected.
const SLIDE_BAR_EDITS: Readonly<Partial<Record<string, Pick<RunnableActionBarCommand, 'label' | 'icon'>>>> = {
  'move-current-slide-up': { label: 'Move slide up', icon: 'arrow-up' },
  'move-current-slide-down': { label: 'Move slide down', icon: 'arrow-down' },
  'duplicate-slide': { label: 'Duplicate slide', icon: 'copy' },
  'delete-slide': { label: 'Delete slide', icon: 'trash' }
}
const FORMAT_BAR_EDITS = ['format-bold', 'format-italic', 'format-link', 'bulleted-list', 'numbered-list']
const ACTION_BAR_LINE_COMMANDS: ReadonlySet<string> = new Set(['bulleted-list', 'numbered-list', 'promote-heading', 'demote-heading'])
const SELF_REPORTING_HANDLERS: ReadonlySet<string> = new Set(['add-talk-beside', 'talk-beside', 'close-talk-beside', 'select-whole-section'])
const LIVE_COMPILE_PAUSE_MS = 450

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

function structureUndoText(result: OutlineMutationResult<OutlineSaveResult>, planned: string): string {
  if (!result.ok || !result.changed) return planned
  // Even when main stamps nothing, the writer may have tidied the editor text before sending it.
  const reply = result.saved
  return reply && reply.ok && 'content' in reply ? reply.content ?? result.text : result.text
}

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
  researchJump?: { file: string; line?: number; nonce: number; index?: number; slideId?: string } | null
  onResearchJump?: (use: ResearchUse) => void
  activeTalk: TalkInfo | null
  vaultRoot: string
  /** The Guide's hold on the right-hand column (onboarding ticket 07); absent = no Guide. */
  guide?: GuideColumn
  onSketchStarted?: () => void
  startView?: WorkspaceView
  defaultView?: WorkspaceView
  talkOpening?: { sequence: number; view?: 'grid' }
  welcome?: React.ReactNode
  slideTabView?: SlideTabView
  onChooseSlideTabView?: (view: SlideTabView) => void
  slidesPanelView?: SlidesPanelView
  leftPreviewsHost?: HTMLDivElement | null
  leftPathwaysHost?: HTMLDivElement | null
  onOpenPathways?: () => void
  onClosePathways?: () => void
  onChooseSlidesPanelView?: (view: SlidesPanelView) => void
  // Lets App's left sidebar (Outline / Slides views) mirror the live outline and jump the
  // editor + strip to a source line.
  /** Open App's Settings panel (Tools → Settings in the toolbar). */
  onOpenSettings?: () => void
  /** Forwards the editor's line-targeted outline ops up to App (for the Slides organizer). */
  /** Switch the active Talk (App owns activeTalk). Slide Focus uses it to open a DIFFERENT talk's
   *  slide picked in the Browser before scoping onto it. */
  onSelectTalk?: (talk: TalkInfo) => void
  /** Switch the Talks sidebar when the workspace enters Slide, Outline or Markdown. */
  onEnterEditingView?: (path: string) => void
  /** Hand App a "flush the current editor's pending edit" fn. App calls it BEFORE a genuine talk
   *  switch so a sub-1.5s edit made just before switching is persisted to the OUTGOING talk's file
   *  (data-loss guard, 2026-07-05). No-op when nothing is pending. */
  registerFlushSave?: (fn: () => Promise<void>) => void
  /** A write through the Talk tab's Advanced part landed: App refreshes the Talks list (title, subtitle, event). */
  onMetadataSaved?: () => void
  /** Hand App the outline external-change guard's leave check: App awaits it before a talk switch
   *  (it flushes pending typing, and holds the switch behind the sheet while the talk's file differs
   *  from the editor). Resolves false when the person chose Stay here. */
  registerLeaveGuard?: (fn: () => Promise<boolean>) => void
  /** The person discarded the open talk (removed on disk): App lets it go. */
  onDiscardTalk?: () => void
  /** The source line of the slide the editor cursor is now in, so App's Slide-outline sidebar can
   *  follow the cursor (highlight + scroll to the current slide). Fires only when the active slide
   *  changes, not on every keystroke. null = the cursor is above the first slide (cover/frontmatter). */
  /** The Talks sidebar on the left is showing. In a narrow window it and the right sidebar are not open together (R17). */
  leftSidebarShown?: boolean
  /** Asks App to collapse the Talks sidebar: the right sidebar was just opened in a narrow window. */
  onNeedRoom?: () => void
}

// Grid view is a separate full-width view mode that replaces the normal panes with a
// real CSS grid of slide thumbnails. It is orthogonal to PaneState: switching to any
// pane-toggle (editor/both/strip) turns grid off; the Grid button turns it on.
const GRID_COLS_STORAGE_KEY = 'tw-grid-cols'
const GRID_COLS_DEFAULT = 3
const GRID_COLS_MIN = 1
const GRID_COLS_MAX = 6
const PANE_STATE_STORAGE_KEY = 'tw-pane-state'
const SIDEBAR_TAB_STORAGE_KEY = 'tw-right-tab'
const OUTLINE_PREVIEW_COLLAPSED_KEY = 'tw-outline-preview-collapsed'
// The right sidebar's default width: wide enough for the Inspector, narrow enough that the editor keeps its share of a 1280 window.
const RIGHT_SIDEBAR_DEFAULT_PX = 346
// The toolbar's widths (px) at which it gives way: view names go, then the menu buttons' words, then Present's.
const TOOLBAR_FULL_FROM_PX = 1240
const TOOLBAR_LABELS_FROM_PX = 1040
const TOOLBAR_ICONS_FROM_PX = 640
// Below this Present is an icon too, and the Grid's column choice moves into a popover (a Grid with Talks open at 1000 px).
const TOOLBAR_PRESENT_LABEL_FROM_PX = 900
const TOOLBAR_COLS_INLINE_FROM_PX = 1100

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return true
  // CodeMirror edits a contentEditable div, not a textarea.
  if (t.isContentEditable) return true
  return !!t.closest('.cm-editor')
}

function readPaneState(): PaneState {
  try { return migratePaneState(window.localStorage.getItem(PANE_STATE_STORAGE_KEY)) }
  catch { return 'both' }
}

// The right sidebar's open tab (R11a). Fresh installs start on the Inspector; a person who had turned it off keeps the strip.
function readSidebarTab(): RightColumnTab {
  try {
    const stored = window.localStorage.getItem(SIDEBAR_TAB_STORAGE_KEY)
    return stored === 'talk' ? 'talk' : 'inspector'
  } catch { return 'inspector' }
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

export default function WorkspaceLayout({ researchJump, onResearchJump, activeTalk, vaultRoot, onOpenSettings, onSelectTalk, onEnterEditingView, registerFlushSave, onMetadataSaved, registerLeaveGuard, onDiscardTalk, guide, leftSidebarShown = false, onNeedRoom, startView, onSketchStarted, defaultView = 'slide', talkOpening, welcome, leftPreviewsHost, leftPathwaysHost, onOpenPathways, onClosePathways, slidesPanelView = 'previews', onChooseSlidesPanelView, slideTabView = 'pages', onChooseSlideTabView }: Props) {
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
  const [textView, setTextView] = useState<Exclude<WorkspaceView, 'grid'>>('slide')
  const editorViewMode: EditorViewMode = textView === 'markdown' ? 'markdown' : 'plain'
  const [notesVisibility, setNotesVisibility] = useState<{ row: string; open: boolean } | null>(null)
  const pastedRow = useRef<{ path: string; refs: string[]; keepFirst: boolean } | null>(null)
  const pendingSlide = useRef<{ path: string; id: string } | null>(null)
  const [plainLook, setPlainLook] = useState<PlainLook>(PLAIN_LOOK_DEFAULT)
  useEffect(() => {
    let cancelled = false
    window.tw.settings.getPlainLook()
      .then((look) => { if (!cancelled) setPlainLook(look) })
      .catch(() => { /* keep the default */ })
    const off = window.tw.settings.onPlainLookChanged(setPlainLook)
    return () => { cancelled = true; off() }
  }, [])
  // The place chip (onboarding ticket 02): the caret's place from the editor, combined with where
  // the keyboard is; the setting "Show where I am in the status bar" (on by default).
  const [editorPlace, setEditorPlace] = useState<Place>('slide-text')
  const [promoteHeadingReason, setPromoteHeadingReason] = useState<string>()
  // A selected object in the editor: the bar's line controls (lists, heading levels) have nothing to act on.
  const [lineCommandsUnavailable, setLineCommandsUnavailable] = useState(false)
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
    if (isSlideMergeReviewOpen()) return
    commandHandlersRef.current?.[handlerId]()
  }, [])
  // A palette row runs its handler; a command only a key reaches (the outline's move and jump keys,
  // the sidebar and find keys) is run by sending its effective key to the editor, as the presenter
  // palette does for its viaKey entries.
  const runListedCommand = useCallback((command: CommandDefinition): void => {
    if (isSlideMergeReviewOpen()) return
    const handler = commandHandlersRef.current?.[command.handlerId as PaletteCommandHandlerId]
    if (handler) { handler(); return }
    if (!command.shortcutId) return
    const code = shortcutById(command.shortcutId).codes[0]
    if (!code) return
    const keys = effectiveKeys(command.shortcutId) || code
    window.setTimeout(() => {
      if (isSlideMergeReviewOpen()) return
      const target = document.querySelector<HTMLElement>('.cm-content')
      target?.focus()
      ;(target ?? document.body).dispatchEvent(new KeyboardEvent('keydown', chordEventInit(keys)))
    }, 0)
  }, [])
  // The pane state the person chose (saved) is kept apart from the automatic collapse of the right sidebar in a narrow
  // window (R17): `paneState` is what is drawn; only an explicit change (every setPaneState call) writes the saved choice.
  const [savedPaneState, setSavedPaneState] = useState<PaneState>(readPaneState)
  const [autoCollapsed, setAutoCollapsed] = useState(false)
  const setPaneState = useCallback((next: PaneState | ((current: PaneState) => PaneState)): void => {
    setAutoCollapsed(false)
    setSavedPaneState(next)
  }, [])
  const paneState: PaneState = autoCollapsed && savedPaneState === 'both' ? 'editor' : savedPaneState
  const [outlinePreviewCollapsed, setOutlinePreviewCollapsed] = useState(() => {
    try { return window.sessionStorage.getItem(OUTLINE_PREVIEW_COLLAPSED_KEY) === 'true' }
    catch { return false }
  })
  const outlinePreviewId = useId()
  useEffect(() => {
    try { window.sessionStorage.setItem(OUTLINE_PREVIEW_COLLAPSED_KEY, String(outlinePreviewCollapsed)) }
    catch { /* keep the choice in this renderer */ }
  }, [outlinePreviewCollapsed])
  // One right sidebar with tabs (R11a). `paneState` says whether it is showing: 'both' = Slides with the sidebar
  // on, 'editor' = Slides with it off, 'strip' = the Strip view (full width, no sidebar); `sidebarTab` says which tab.
  const [sidebarTab, setSidebarTab] = useState<RightColumnTab>(readSidebarTab)
  // R17: the toolbar's density follows its own measured width (see styles.css [data-density]).
  const [toolbarEl, setToolbarEl] = useState<HTMLDivElement | null>(null)
  const [toolbarWidth, setToolbarWidth] = useState<number | null>(null)
  useEffect(() => {
    if (!toolbarEl || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => setToolbarWidth(Math.round(toolbarEl.clientWidth)))
    observer.observe(toolbarEl)
    setToolbarWidth(Math.round(toolbarEl.clientWidth))
    return () => observer.disconnect()
  }, [toolbarEl])
  const [colsOpen, setColsOpen] = useState(false)
  const colsInline = toolbarWidth === null || toolbarWidth >= TOOLBAR_COLS_INLINE_FROM_PX
  const toolbarDensity = toolbarWidth === null || toolbarWidth >= TOOLBAR_FULL_FROM_PX ? 'full'
    : toolbarWidth >= TOOLBAR_LABELS_FROM_PX ? 'compact' : toolbarWidth >= TOOLBAR_ICONS_FROM_PX ? 'icons' : 'tight'
  // Grid and Pathways use the current slide shared with the Inspector.
  const pathwaysMode = !!leftPathwaysHost
  const [hasPathwayGridSelection, setHasPathwayGridSelection] = useState(false)
  const [gridMode, setGridMode] = useState<boolean>(false)
  const onNeedRoomRef = useRef(onNeedRoom)
  onNeedRoomRef.current = onNeedRoom
  // R17: in a narrow window the two sidebars are not open together; the one opened last stays.
  const rightSidebarShown = paneState === 'both'
  const wasRightShownRef = useRef(rightSidebarShown)
  const wasLeftShownRef = useRef(leftSidebarShown)
  useEffect(() => {
    const narrow = window.innerWidth < NARROW_WINDOW_PX
    const rightOpened = rightSidebarShown && !wasRightShownRef.current
    const leftOpened = leftSidebarShown && !wasLeftShownRef.current
    wasRightShownRef.current = rightSidebarShown
    wasLeftShownRef.current = leftSidebarShown
    if (activeTalkRef.current || !narrow || !rightSidebarShown || !leftSidebarShown) return
    // The one that just opened wins; at the start (neither "just opened") the Talks list the person chose stays.
    if (rightOpened && !leftOpened) onNeedRoomRef.current?.()
    else setAutoCollapsed(true)
  }, [rightSidebarShown, leftSidebarShown])
  // Wider again (or the Talks sidebar closed): the sidebar comes back as the person had it.
  useEffect(() => {
    const restore = (): void => { if (window.innerWidth >= NARROW_WINDOW_PX) setAutoCollapsed(false) }
    window.addEventListener('resize', restore)
    return () => window.removeEventListener('resize', restore)
  }, [])
  useEffect(() => { if (!leftSidebarShown) setAutoCollapsed(false) }, [leftSidebarShown])
  useEffect(() => {
    const show = (event: Event): void => {
      if ((event as CustomEvent).detail === activeTalk?.outlinePath) openPathways()
    }
    window.addEventListener('tw-show-pathways', show)
    return () => window.removeEventListener('tw-show-pathways', show)
  }, [activeTalk?.outlinePath, onOpenPathways])
  const [gridColumns, setGridColumns] = useState<number>(readGridColumns)
  // The Guide tab (onboarding ticket 07). Up while App says so; `guideActive` is whether it is the tab
  // showing (Slides and Inspector are the others). Each request to open it shows it and brings the
  // right-hand column up, as the Inspector's own toggle does.
  const guideUp = guide?.open === true
  useEffect(() => {
    if (!guide || !guide.open || guide.nonce === 0) return
    showTab('guide')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guide?.nonce])
  useEffect(() => { if (!guideUp) closeTab('guide') }, [guideUp])
  // The What's new tab (update notices, ADR-0041): opened only by the Updated mark or its command, never by itself.
  const [whatsNewUp, setWhatsNewUp] = useState<boolean>(false)
  useEffect(() => {
    const open = (): void => {
      setWhatsNewUp(true); showTab('whats-new')
    }
    window.addEventListener(WHATS_NEW_OPEN_EVENT, open)
    return () => window.removeEventListener(WHATS_NEW_OPEN_EVENT, open)
  }, [])
  // Find is a temporary right-sidebar tab. Its mode is set while the tab is open.
  // The panel is visible when its tab is selected and the sidebar is showing.
  const [findMode, setFindMode] = useState<FindMode | null>(null)
  const findPanelVisible = findMode !== null && sidebarTab === 'find' && paneState === 'both'
  const [pictureProgress, setPictureProgress] = useState<{ path: string; id: string; message: string; pos?: number } | null>(null)
  const [imageDropping, setImageDropping] = useState<'picture' | 'slide' | null>(null)
  const [pictureDropLines, setPictureDropLines] = useState<{ pointer: number; heading: number | null } | null>(null)
  const [iconPickerOpen, setIconPickerOpen] = useState<boolean>(false)
  const [outlineContent, setOutlineContent] = useState<string>('')
  const [panelApplied, setPanelApplied] = useState<{ text: string; path: string; index: number; label: string } | null>(null)
  // The first render after a talk switch can still hold the previous talk's text.
  const [outlineOwner, setOutlineOwner] = useState<string | null>(null)
  const [compiledSlides, setCompiledSlides] = useState<ProjectionRow[] | null>(null)
  const pathwaySourceReady = !!activeTalk && outlineOwner === activeTalk.outlinePath
  const pathways = usePathways(activeTalk?.outlinePath, pathwaySourceReady ? outlineContent : null, pathwaySourceReady ? compiledSlides : null, pathwaysMode)
  const selectedPathway = pathways.pathway
  const pathwayOrder = useMemo(() => {
    if (!selectedPathway) return undefined
    const indices = new Map((compiledSlides ?? []).map((row, index) => [row.slide_id, index]))
    return selectedPathway.slideIds.flatMap(id => {
      const index = indices.get(id)
      return index === undefined ? [] : [index]
    })
  }, [selectedPathway, compiledSlides])
  const structure = useMemo(() => structureOf(outlineContent), [outlineContent])
  const liveStructureRef = useRef({ text: outlineContent, structure })
  liveStructureRef.current = { text: outlineContent, structure }
  const selectionKeys = useMemo(() => slideKeys(compiledSlides ?? [], i => /^#{2,6}[ \t]/.test(compiledSlides?.[i].source_markdown ?? '')), [compiledSlides])
  const selection = useSlideSelection(selectionKeys)
  const [selectingSeveral, setSelectingSeveral] = useState(false)
  const [selectedSubslide, setSelectedSubslide] = useState<{ path: string; id: string; line: number } | null>(null)
  const clearSelection = selection.clear
  useEffect(() => { clearSelection(); setSelectingSeveral(false) }, [activeTalk?.outlinePath, talkOpening, selectedPathway?.id, clearSelection])
  const [failedCompilePath, setFailedCompilePath] = useState<string | null>(null)
  const compiledSourceRef = useRef<string | null>(null)
  const [triggerFindings, setTriggerFindings] = useState<LayoutDoctorFinding[]>([])
  const [thumbnails, setThumbnails] = useState<Record<string, string> | null>(null)
  const [previewsPending, setPreviewsPending] = useState(false)
  const thumbnailRowsRef = useRef<ProjectionRow[] | null>(null)
  const [thumbnailRefresh, setThumbnailRefresh] = useState(0)
  useEffect(() => {
    const repaired = (event: Event): void => {
      if ((event as CustomEvent<string>).detail !== activeTalkRef.current?.outlinePath) return
      setThumbnailRefresh((n) => n + 1)
    }
    window.addEventListener('tw:widget-repaired', repaired)
    return () => window.removeEventListener('tw:widget-repaired', repaired)
  }, [])
  const compileTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // At most one live-preview compile in flight per talk; edits made meanwhile are compiled once, as
  // their newest text, when it returns (lib/liveCompile.ts). Without this a heavy talk queued dozens.
  const [liveCompile] = useState(() => createLiveCompile<ProjectionRow[] | null>((outlinePath, text) => window.tw.talk.compile(outlinePath, text)))
  const compileImmediatelyRef = useRef(false)
  const compileAttemptedRef = useRef(false)

  const [buildStatus, setBuildStatus] = useState<'idle' | 'building' | 'done' | 'error'>('idle')
  const [buildPath, setBuildPath] = useState<string | null>(null)
  // The build chip names the local action that failed.
  const [buildErrorLabel, setBuildErrorLabel] = useState('Build failed')
  const [publishIssue, setPublishIssue] = useState<{ diagnostic: PublishDiagnostic; outlinePath: string } | null>(null)
  const [publishDetails, setPublishDetails] = useState(false)
  const publishProgress = useHandoutPublishProgress()
  const [publishing, setPublishing] = useState<boolean>(false)
  // Re-entry guard for Publish: a ref, so the command registry's (possibly older) closure sees it too.
  // Two overlapping publishes of one talk would race on its slide-assets/ folder.
  const publishingRef = useRef(false)
  useEffect(() => {
    publishProgress.observe()
    return window.tw.talk.onCliPublish?.(update => {
      if (update.outlinePath !== activeTalk?.outlinePath) return
      if (update.kind === 'progress') {
        if (!publishingRef.current && update.progress.step === 'preparing') {
          setBuildStatus('idle')
          setPublishIssue(null)
          setPublishDetails(false)
        }
        publishProgress.observe(update.progress)
      } else {
        publishProgress.observe()
        if (publishingRef.current) return
        if (update.url) {
          setPublishIssue(null)
          setBuildStatus('done')
          setBuildPath(update.url)
        } else if (update.diagnostic) {
          setBuildStatus('idle')
          setPublishIssue({ diagnostic: update.diagnostic, outlinePath: update.outlinePath })
        }
      }
    })
  }, [activeTalk?.outlinePath])
  // Share for comments (ticket 03): the sheet, and every shared talk (status bar chip).
  const [shareSheetOpen, setShareSheetOpen] = useState<boolean>(false)
  // Publish handout could not start: what is missing, for the sheet (spec: the "not ready" table).
  const [publishNotReady, setPublishNotReady] = useState<{ warning: PublishNotReady; outlinePath: string } | null>(null)
  // The plan sheet (ADR-0032 point 5): a new Run (run null) or editing a planned one.
  // Publish handout when the talk names work files: the notice that they go out with a Run (ticket 23).
  const [publishWorkNoticeText, setPublishWorkNoticeText] = useState<string | null>(null)
  const [planSheet, setPlanSheet] = useState<{ run: RecordingSession | null } | null>(null)
  // "Capture to research…": the sheet, with the editor's selection captured when it was asked for.
  const researchPanelOpen = sidebarTab === 'research' && paneState === 'both'
  const researchPanelOpenRef = useRef(researchPanelOpen)
  researchPanelOpenRef.current = researchPanelOpen
  const [researchHost, setResearchHost] = useState<HTMLElement | null>(null)
  const [pillHost, setPillHost] = useState<HTMLElement | null>(null)
  const [researchPickerOpen, setResearchPickerOpen] = useState(false)
  const [researchRefresh, setResearchRefresh] = useState(0)
  const researchActionsRef = useRef<ResearchActions>({})
  const registerResearchActions = useCallback((actions: ResearchActions) => { researchActionsRef.current = actions }, [])
  const [captureSheet, setCaptureSheet] = useState<{ body: string; artefact?: string } | null>(null)
  // Slide Scratchpad (components/scratchpad/): the open talk's candidates, and where its panel sits.
  const scratchpad = useScratchpad(activeTalk?.outlinePath ?? null)
  const sketch = useSketch(activeTalk?.outlinePath ?? null)
  const [sketchReview, setSketchReview] = useState<{
    path: string; name: string; text: string; pictures: ReadonlyMap<string, string>; review: SketchReviewState | null; place?: ScratchPlace; key?: string
  } | null>(null)
  const [sketchApplying, setSketchApplying] = useState(false)
  const sketchApplyInFlight = useRef(false)
  const sketchStage = sketch.current && sketchReview?.path === sketch.current.path &&
    sketch.current.path === activeTalk?.outlinePath && sketchReview.name === sketch.current.saved?.name && sketchReview.text === sketch.current.text ? sketchReview : null

  async function beginBreakdown(): Promise<void> {
    if (!await sketch.flush()) return
    const draft = sketch.read()
    if (!draft?.saved || draft.path !== activeTalkRef.current?.outlinePath || !draft.text.trim()) return
    const { path, text, saved } = draft
    const refs = sketchPictureReferences(text)
    try {
      const matches = refs.length ? await window.tw.scratchpad.sketchPictures(path, refs) : null
      if (matches && !matches.ok) throw new Error(matches.error)
      if (sketch.read() !== draft || draft.text !== text || activeTalkRef.current?.outlinePath !== path) return
      setSketchReview({ path, name: saved.name, text, pictures: new Map(matches?.pictures), review: null })
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not check the sketch pictures.', 'warning', 'sketch')
    }
  }

  function backFromSketch(): void {
    if (sketchApplyInFlight.current) return
    if (sketchStage) setSketchReview(null)
    else void sketch.close()
  }

  function chooseSketchBreakdown(review: SketchReviewState): void {
    const doc = editorReadRef.current?.()
    if (!sketchStage || doc?.path !== sketchStage.path) {
      notify('The talk is loading. Try again in a moment.', 'info', 'sketch')
      return
    }
    const row = compiledSlidesRef.current?.[activeSlideRef.current]
    const line = row?.slide_id === 'deck-title' ? null : slideLinesRef.current[activeSlideRef.current]
    const place = placeForLine(doc.text, line)
    setSketchReview({ ...sketchStage, review, place, key: crypto.randomUUID() })
  }

  async function applySketch(): Promise<void> {
    const stage = sketchStage
    const talk = activeTalkRef.current
    if (!stage?.review || !stage.place || stage.path !== talk?.outlinePath || sketchApplyInFlight.current) return
    sketchApplyInFlight.current = true
    setSketchApplying(true)
    try {
      const live = await window.tw.scratchpad.readSketch(stage.path, stage.name)
      if (!live.ok) throw new Error(live.error)
      if (live.sketch.text !== stage.text) throw new Error('The sketch changed on disk. Open it again to review the latest text.')
      let reviewed = stage.review
      const pictures = reviewed.slides.flatMap(slide => slide.pictures.map(picture => picture.text))
      if (pictures.length) {
        const checked = await window.tw.scratchpad.sketchPictures(stage.path, pictures)
        if (!checked.ok) throw new Error(checked.error)
        const available = new Map(checked.pictures)
        const undecided = [...reviewed.undecided]
        const slides = reviewed.slides.map(slide => ({
          ...slide, pictures: slide.pictures.flatMap(picture => {
            const ref = available.get(picture.text)
            if (ref) return [{ ...picture, ref }]
            undecided.push({ ...picture, section: slide.section, reason: 'missing-picture' })
            return []
          }),
        }))
        reviewed = { ...reviewed, slides, undecided }
        if (undecided.length > stage.review.undecided.length) {
          setSketchReview({ ...stage, review: reviewed })
          return
        }
      }
      const doc = editorReadRef.current?.()
      if (doc?.path !== stage.path || activeTalkRef.current?.outlinePath !== stage.path) return
      const plan = planSketchApply(doc.text, stage.place, reviewed)
      if (!plan.ok) throw new Error(plan.error)
      const key = stage.key ?? crypto.randomUUID()
      const proposals = plan.proposals.map(proposal => ({
        ...proposal, talkPath: stage.path, talkTitle: talk.title, thumbKey: '', slideId: '',
      }))
      if (proposals.length) {
        const kept = await window.tw.scratchpad.recordSketchUse(stage.path, stage.name, key, [], proposals)
        if (!kept.ok) throw new Error(kept.error)
      }
      const result = await applyOutlineMutation(stage.path, () => plan.text, { base: doc.text, ownUndoStep: true })
      if (!result.ok && !result.applied) throw new Error(proposals.length
        ? `The proposals are in the Scratchpad. ${result.error}` : result.error)
      const record = async () => {
        if (activeTalkRef.current?.outlinePath !== stage.path) return
        try {
          const reply = await window.tw.scratchpad.recordSketchUse(stage.path, stage.name, key, plan.ids, [], plan.count)
          if (!reply.ok) throw new Error(reply.error)
        } catch (error) {
          notify(`The Scratchpad could not record the breakdown. ${error instanceof Error ? error.message : ''}`, 'warning', 'sketch-receipt',
            { label: 'Retry', onAction: () => void record() })
        }
      }
      await record()
      if (activeTalkRef.current?.outlinePath !== stage.path) return
      await sketch.close()
      setSketchReview(null)
      showWorkspaceView('outline')
      setSidebarTab('inspector')
      setPaneState('both')
      if (plan.firstSlide) pendingSlide.current = { path: stage.path, id: plan.firstSlide }
      const written = structureUndoText(result, plan.text)
      const wording = plan.count ? `${plan.count} ${plan.count === 1 ? 'slide' : 'slides'} added. The sketch stays in the Scratchpad.`
        : 'Proposed slides kept in the Scratchpad.'
      notify(result.ok ? wording : result.error, result.ok ? 'success' : 'warning', 'sketch-apply',
        plan.ids.length ? { label: 'Undo', onAction: () => {
          if (editorReadRef.current?.()?.path === stage.path && editorReadRef.current?.()?.text === written) {
            undoStructure(stage.path, written)
            void sketch.open(stage.name).then(ok => {
              if (ok && sketch.read()?.saved?.text === stage.text) setSketchReview({ ...stage, key: crypto.randomUUID() })
            })
          } else undoStructure(stage.path, written)
        } } : undefined)
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not add slides from this sketch.', 'warning', 'sketch')
    } finally {
      sketchApplyInFlight.current = false
      setSketchApplying(false)
    }
  }
  const startingSketch = useRef<string | null>(null)
  useEffect(() => {
    const path = activeTalk?.outlinePath
    if (!path || startView !== 'outline' || scratchpad.loading || startingSketch.current === path) return
    startingSketch.current = path
    void sketch.open().then(() => { if (activeTalkRef.current?.outlinePath === path) onSketchStarted?.() })
  }, [activeTalk?.outlinePath, startView, scratchpad.loading])
  async function openSketch(name?: string, breakdown = false): Promise<void> {
    if (sketchApplyInFlight.current) return
    if (await sketch.open(name)) {
      setSketchReview(null)
      if (focusSlideRef.current != null) exitFocus()
      if (breakdown) await beginBreakdown()
    }
  }
  async function renameSketch(title: string): Promise<boolean> {
    const draft = sketch.read()
    if (!draft?.saved || draft.path !== activeTalkRef.current?.outlinePath) return false
    try {
      const reply = await window.tw.scratchpad.renameSketch(draft.path, draft.saved.name, title)
      if (!reply.ok) throw new Error(reply.error)
      return true
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not rename the sketch.', 'warning', 'sketch')
      return false
    }
  }
  const scratchpadLayout = useScratchpadLayout()
  const [scratchDockHost, setScratchDockHost] = useState<HTMLDivElement | null>(null)
  const scratchDocked = scratchpadLayout.layout.mode === 'docked'
  function openScratchTab(): void {
    if (focusSlideRef.current != null) exitFocus()
    if (gridModeRef.current || paneStateRef.current === 'strip') selectSlides()
    showTab('scratchpad')
  }
  function expandScratchpad(): void {
    if (scratchDocked || scratchpadLayout.layout.restore === 'docked') openScratchTab()
    scratchpadLayout.expand()
  }
  function dockScratchpad(): void {
    scratchpadLayout.dock()
    openScratchTab()
  }
  useEffect(() => { if (scratchDocked) openScratchTab() }, [scratchDocked])
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
  const [scratchBatchLanding, setScratchBatchLanding] = useState<{ talk: string; text: string; lines: number[]; at: number } | null>(null)
  useEffect(() => { setScratchChosenPlace(null); scratchChosenEarlierRef.current = [] }, [activeTalk?.outlinePath])
  const [researchHighlight, setResearchHighlight] = useState<string | null>(null)
  const researchCaptureDropRef = useRef<{ body: string; artefact?: string } | null>(null)
  const sharedTalks = useSharedTalks()
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
    consumeFence?: ConsumeInsertFence
  } | null>(null)

  // Strip ↔ editor sync + reorder/insert plumbing
  const [activeSlide, setActiveSlide] = useState<number>(0)
  const [panelOpened, setPanelOpened] = useState<{ slide: string | null; page: string } | null>(null)
  const panelRemap = useRef<{ id: string | null; index: number } | null>(null)
  const panelHistoryInProgress = useRef(false)
  // takeFocus distinguishes deliberate "go edit this" jumps (outline sidebar, deck ⌘E — the caret
  // should land in the editor) from strip/grid card CLICKS, which only aim the editor's viewport:
  // stealing focus there killed the strip's own arrow-key navigation for mouse users.
  const [focusLine, setFocusLine] = useState<{ line: number; takeFocus: boolean; editTitle?: boolean; selectPlaceholder?: boolean } | null>(null)
  const [imageMetaId, setImageMetaId] = useState<string | null>(null)
  const [imageEditRequested, setImageEditRequested] = useState(false)
  const imageMetaTalkRef = useRef<string | null>(null)
  const panelImageTarget = useRef<{ path: string; base: string; line: number } | null>(null)
  const replacingPanelImage = useRef<{ path: string; base: string; line: number } | null>(null)
  useEffect(() => { setImageMetaId(null); setImageEditRequested(false) }, [activeTalk?.outlinePath])
  const [abstractOpen, setAbstractOpen] = useState<boolean>(false)
  const [cmdMenuOpen, setCmdMenuOpen] = useState<boolean>(false)
  // Text the palette opens with: Actions here hands over what was typed in its filter.
  const [cmdMenuQuery, setCmdMenuQuery] = useState<string>('')
  // Actions here (⌘K, right-click, Menu key): the panel at the caret or the selected slide.
  const [actionsHere, setActionsHere] = useState<{ x: number; y: number; place: Place; returnTo: HTMLElement | null } | null>(null)

  // Slide Focus scopes the editor to the same current slide as the other workspace views.
  const [focusOpen, setFocusOpen] = useState(false)
  const focusSlide = focusOpen ? activeSlide : null
  const scopeOnSlide = !gridMode && paneState !== 'strip' && textView === 'slide'
  const slideNavigationActive = !!activeTalk && scopeOnSlide && focusSlide === null
  const slideNavigationRef = useRef({ active: false, scopedText: false })
  const markdownView = textView === 'markdown' && !gridMode && paneState !== 'strip' && focusSlide === null
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
  const editorScrollFrame = useRef<number | null>(null)
  const cancelEditorScroll = useCallback(() => {
    if (editorScrollFrame.current === null) return
    cancelAnimationFrame(editorScrollFrame.current)
    editorScrollFrame.current = null
  }, [])
  const scrollEditorToCursor = useCallback(() => {
    cancelEditorScroll()
    editorScrollFrame.current = requestAnimationFrame(() => {
      editorScrollFrame.current = requestAnimationFrame(() => {
        editorScrollFrame.current = null
        editorCmdsRef.current?.scrollCursorIntoView()
      })
    })
  }, [cancelEditorScroll])

  useEffect(() => {
    const host = editorHostRef.current
    // The pointer targets the editor as painted. A queued scroll must yield to that click.
    host?.addEventListener('pointerdown', cancelEditorScroll, true)
    return () => {
      host?.removeEventListener('pointerdown', cancelEditorScroll, true)
      cancelEditorScroll()
    }
  }, [cancelEditorScroll])

  // Imperative insert-at-cursor channel (ADR-0013). The Editor registers a function
  // here on mount; the cross-talk search palette calls it to splice an imported
  // slide at the live caret instead of appending at EOF.
  const editorInsertRef = useRef<((text: string) => void) | null>(null)
  const editorInsertObjectRef = useRef<ObjectInsertHandler | null>(null)
  // Puts rewritten text into the buffer in place as ONE minimal change (caret mapped, scroll and undo
  // history kept, no remount); `{ save: true }` also supersedes the autosave and returns the text to
  // save now (Editor registerReplaceDoc). editorReadRef reads the buffer itself — the doc CodeMirror
  // holds — never the outlineContent mirror (one-writer spec D1).
  const editorReplaceRef = useRef<ReplaceEditorDoc | null>(null)
  const editorReadRef = useRef<ReadEditorDoc | null>(null)
  const editorLayoutContextRef = useRef<(() => LayoutPickerContext | null) | null>(null)
  const editorApplyLayoutRef = useRef<((initial: LayoutDef[], selected: LayoutDef[]) => void) | null>(null)
  const editorApplyOptionRef = useRef<((group: OptionGroup, token: string, headingLine?: number, slideId?: string | null, compiledLayout?: string) => string | null) | null>(null)
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
    settleSave: (signal?: AbortSignal) => Promise<void>
    forceSave: (signal?: AbortSignal) => Promise<boolean>
    cancelDebouncedSave: (outlinePath: string) => void
    commitSlideMerge: CommitSlideMerge
    scrollCursorIntoView: () => void
    cursorCoords: () => { x: number; y: number } | null
    placeCursorAtCoords: (x: number, y: number) => void
    pointAtCoords: (x: number, y: number) => { pos: number; line: number } | null
    cutSelection: () => void
    copySelection: () => void
    pasteClipboard: () => void
    selectionText: () => string
    slides: SlideBlockOps
    runFormat: (id: 'bold' | 'italic' | 'inline-code' | 'highlight' | 'strikethrough' | 'underline' | 'link') => void
    goToLine: () => void
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

  useEffect(() => {
    const pending = scratchBatchLanding
    if (!pending) return
    const live = editorReadRef.current?.()
    if (activeTalk?.outlinePath !== pending.talk || live?.text !== pending.text || Date.now() - pending.at > 15000) { setScratchBatchLanding(null); return }
    if (compiledSourceRef.current !== pending.text) return
    if (!gridModeRef.current || slideSelectionControls()?.selectLines(pending.lines)) setScratchBatchLanding(null)
  }, [compiledSlides, outlineContent, activeTalk?.outlinePath, scratchBatchLanding])

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
  const authoredVideos = useMemo(() => scanOutlineVideos(outlineContent).videos, [outlineContent])
  function videosAt(headingLine: number | null): AuthoredVideo[] {
    if (headingLine == null) return []
    const next = structure.nodes.find(node => node.line >= headingLine)?.line ?? Infinity
    return authoredVideos.filter(video => video.line >= headingLine && video.line < next)
  }
  const hasFileVideo = videosAt(slideLines[activeSlide] ?? null).some(video => !video.player)
  const markerCommandAvailableRef = useRef(hasFileVideo)
  markerCommandAvailableRef.current = hasFileVideo
  const placeCount = useMemo(() => actionRowsAt(place, { row: placeRow, quoteSlide: quoteSlideAtCaret, fileVideo: hasFileVideo }).length,
    [place, placeRow, quoteSlideAtCaret, hasFileVideo])
  const placeChip = { place, count: placeCount, chord: liveShortcutLabel('app.context-menu'), visible: placeChipVisible, onActivate: activatePlace }

  // Mirror the strip's current-slide mapping into refs so the (deps-[]) global key handler can
  // resolve the ACTIVE slide for the where-used command — same pattern as activeTalkRef above.
  const activeSlideRef = useRef<number>(activeSlide)
  const compiledSlidesRef = useRef<ProjectionRow[] | null>(compiledSlides)
  const inspectorCommitInProgressRef = useRef(false)
  const cursorLineRef = useRef<number | null>(null)
  const editedCaret = useRef<{ path: string | undefined; text: string; line: number } | null>(null)
  const [activeOutlineLine, setActiveOutlineLine] = useState<number | null>(null)
  const onActiveLineChange = leftPreviewsHost || markdownView ? setActiveOutlineLine : undefined
  const outlineLineListener = useRef(onActiveLineChange)
  outlineLineListener.current = onActiveLineChange
  const [activeLineReporter] = useState(() => createActiveLineReporter(() => outlineLineListener.current))
  const cursorAwaitsCompileRef = useRef(false)
  const sectionNotice = useRef<{ path: string; token: string } | null>(null)
  const currentCompiledSlideId = compiledSlides?.[activeSlide]?.slide_id ?? null
  const panelPage = panelOpened?.slide === currentCompiledSlideId ? panelOpened.page : 'home'
  // ADR-0033 §1: heading lines the outline editor marks for text that cannot fit at the readable minimum.
  const textFitNotes = useMemo(() => textFitNotesFor(compiledSlides, slideLines), [compiledSlides, slideLines])
  const markdownHeadings = useMemo(() => {
    if (!markdownView || outlineOwner !== activeTalk?.outlinePath) return undefined
    return new Map(structure.nodes.map(node => [
      node.line + 1,
      node.folded ? 'subslide' : node.section ? node.level === 2 ? 'section' : 'subsection' : 'slide'
    ] as const))
  }, [markdownView, outlineOwner, activeTalk?.outlinePath, structure])
  const slideLinesRef = useRef<(number | null)[]>(slideLines)
  // Nothing is published before the first compile of the open talk (compiledSlides is null on talk load), so numbers never carry from another talk.
  useEffect(() => { publishStripNumbers(stripNumbersToPublish(compiledSlides, slideLines)) }, [compiledSlides, slideLines])
  useEffect(() => () => publishStripNumbers(null), [])
  // The Slide outline's section numbers (§1) and layout marks (R7): from the margin's labels and the compiled rows, on the same cadence as the numbers.
  useEffect(() => {
    publishOutlineMarks(outlineMarksToPublish(marginLabelList, slideLines, (compiledSlides ?? []).map((row) => row.triggers?.layout ?? row.layout)))
  }, [compiledSlides, slideLines, marginLabelList])
  useEffect(() => () => publishOutlineMarks(null), [])
  // The outline's search shows a thumbnail under each hit (lib/slideSearch.ts): the compiled slides' preview urls, by compiled index.
  useEffect(() => {
    publishSlideThumbs(compiledSlides && thumbnails ? compiledSlides.map((r) => thumbnails[r.render_hash || r.content_hash || r.slide_id || ''] ?? null) : null)
  }, [compiledSlides, thumbnails])
  useEffect(() => () => publishSlideThumbs(null), [])
  useEffect(() => { publishWidgetTitles(compiledSlides ?? [], slideLines) }, [compiledSlides, slideLines])
  useEffect(() => () => publishWidgetTitles([], []), [])
  useEffect(() => {
    if (compiledSlidesRef.current === compiledSlides) slideLinesRef.current = slideLines
  }, [compiledSlides, slideLines])
  // The layout the compiler gave the compiled slide whose heading is on `line` (the quote commands need it for a quote-only slide with no `{quote}` token).
  const compiledLayoutAtLine = useCallback((line: number): string | undefined => {
    const index = slideLinesRef.current.indexOf(line)
    return index < 0 ? undefined : compiledSlidesRef.current?.[index]?.layout
  }, [])

  // ── Whole slides: cut, copy, paste, Move … to… (the grid, the two commands; the outline gets the same ops through App) ──
  const [outlineOps, setOutlineOps] = useState<OutlineOps | null>(null)
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
    const id = compiledSlidesRef.current?.[index]?.slide_id
    if (!id || text === compiledSourceRef.current) return mapped
    const snapshot = liveStructureRef.current
    const source = snapshot.text === text ? snapshot.structure : structureOf(text)
    const nodes = source.nodes.filter(candidate => candidate.id === id)
    return nodes.length === 1 ? nodes[0].line + 1 : null
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
  function gridOutlineActionAllowed(): boolean {
    if (!gridModeRef.current || slideSelectionControls()?.canEditOutline() !== false) return true
    notify('Generated slides can only be added to a pathway. Clear the selection to edit an authored slide.', 'info', 'slide-selection')
    return false
  }
  function runSlideClipboardRow(action: 'cut' | 'copy' | 'paste'): void {
    if (action !== 'paste' && !gridOutlineActionAllowed()) return
    const doc = editorReadRef.current?.()
    if (!doc || !activeTalkRef.current || !slideOps) return
    const subject = moveSubject(slideRows(doc.text), commandSlideLine(doc).line, 'slide')
    if (!subject) { notify('Put the cursor on a slide first.', 'info', 'slide-clipboard'); return }
    if (action === 'paste') {
      navigator.clipboard.readText()
        .then((text) => {
          const landed = slideOps.paste(text, subject.line)
          if (typeof landed === 'number') slideLanded(landed)
          else if (landed) return landed.then((line) => { if (line != null) slideLanded(line) })
        })
        .catch(() => notify('Couldn’t read the clipboard. Paste with ⌘V instead.', 'warning', 'slide-clipboard-failed'))
      return
    }
    const clip = action === 'cut' ? slideOps.cut(subject.line) : slideOps.copy(subject.line)
    if (clip != null) writeSlideClipboard(clip, action === 'cut')
  }
  function openMoveTo(want: 'slide' | 'section'): void {
    if (!gridOutlineActionAllowed()) return
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

  useLayoutEffect(() => {
    const remap = panelRemap.current
    if (remap && compiledSlides?.[activeSlide] && activeSlide === remap.index && currentCompiledSlideId !== remap.id) {
      // A save can replace the compiler's temporary ID without changing the current slide.
      setPanelOpened(opened => opened?.slide === remap.id ? { ...opened, slide: currentCompiledSlideId } : opened)
      panelRemap.current = { id: currentCompiledSlideId, index: activeSlide }
    }
  }, [compiledSlides, activeSlide, currentCompiledSlideId])

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
  const talkMetadata = useTalkMetadata(activeTalk?.outlinePath, applyTalkMetadata, async () => {
    await editorCmdsRef.current?.settleSave()
  })
  const { afterLeave: afterTalkMetadata, guard: guardTalkMetadata } = talkMetadata
  const sidebarTabRef = useRef(sidebarTab)
  sidebarTabRef.current = sidebarTab

  const enterFocus = useCallback((slideIndex: number) => afterTalkMetadata(() => {
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
    selectSlideRef.current(idx)
    setFocusRange(range)
    setFocusOpen(true)
  }), [afterTalkMetadata])
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
    afterTalkMetadata(() => {
      lastFocusLineRef.current = lines[next]
      setFocusRange(range)
      selectSlideRef.current(next)
    })
  }, [afterTalkMetadata])

  const exitFocus = useCallback(() => {
    lastFocusLineRef.current = null
    setFocusOpen(false)
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

  const offlineSavingRef = useRef(false)
  const [offlineSaving, setOfflineSaving] = useState(false)
  const saveOffline = useCallback(async (requested?: OfflinePageSelection) => {
    if (offlineSavingRef.current) return
    const talk = activeTalkRef.current?.outlinePath
    const doc = editorReadRef.current?.()
    const index = activeSlideRef.current
    const line = slideLinesRef.current[index]
    if (!talk || !doc || line == null) { notify('Choose a slide with an HTML page first.', 'info', 'save-offline-page'); return }
    const selected = selectOfflinePage(doc.text, line, requested)
    if (!selected.ok) { notify(selected.message, 'info', 'save-offline-page'); return }
    const { candidate } = selected
    const source = candidate.source
    offlineSavingRef.current = true; setOfflineSaving(true)
    try {
      const result = await window.tw.htmlPage.saveOffline({ outlinePath: talk, source })
      if (!result.ok) { notify(result.message, 'warning', 'save-offline-page'); return }
      const now = editorReadRef.current?.()
      const next = activeTalkRef.current?.outlinePath === talk && now?.text === doc.text
        ? offlinePageReplacement(now.text, line, candidate, result.embedPath) : null
      if (!next) { notify(`The copy is saved as ${result.embedPath}, but the talk changed, so no line was replaced.`, 'warning', 'save-offline-page'); return }
      inspectorCommitInProgressRef.current = true
      try {
        if (editorReplaceRef.current?.(next, { ownUndoStep: true }) == null) { notify(`The copy is saved as ${result.embedPath}, but the editor did not take the change.`, 'warning', 'save-offline-page'); return }
      }
      finally { queueMicrotask(() => { inspectorCommitInProgressRef.current = false }) }
      notify(`Static offline copy saved with ${result.images} images and ${result.dataFiles} data files.${result.omitted ? ` ${result.omitted} items could not be included.` : ''}`, result.omitted ? 'warning' : 'success', 'save-offline-page')
    } catch { notify('The page could not be saved. Try again.', 'warning', 'save-offline-page') }
    finally { offlineSavingRef.current = false; setOfflineSaving(false) }
  }, [])
  // Capture embed… (lib/captureEmbed.ts, src/main/live-page-capture-window.ts): the capture window for
  // the inspected slide's web page (`pageUrl` absent: its first). Main binds it to that slide and page;
  // each saved view's {capture} line reaches this editor through the talk writer like any main edit.
  const captureEmbed = useCallback(async (pageUrl?: string) => {
    const path = activeTalkRef.current?.outlinePath
    const index = activeSlideRef.current
    const row = compiledSlidesRef.current?.[index] ?? null
    const compiledSource = compiledSourceRef.current
    try {
      if (!editorCmdsRef.current) throw new Error('The editor is not ready')
      await editorCmdsRef.current.settleSave()
    } catch { notify('The talk could not be saved. Try capturing again.', 'warning', 'capture-embed'); return }
    if (activeTalkRef.current?.outlinePath !== path) return
    const source = captureSourceBlock(editorReadRef.current?.()?.text ?? outlineContentRef.current, row, compiledSource)
    if (!source) { notify('This slide has changed. Wait for the preview, then capture again.', 'info', 'capture-embed'); return }
    void openCaptureEmbed({
      open: (request) => window.tw.livePage.openCapture(request),
      notify: (message, kind) => notify(message, kind, 'capture-embed')
    }, {
      outlinePath: activeTalkRef.current?.outlinePath ?? null,
      slideId: row?.slide_id ?? null,
      title: row?.title ?? '',
      text: source
    }, pageUrl)
  }, [])
  // Capture embed… from a web page card in the editor: the card says which slide (its heading line) and
  // which page; the slide must be compiled (its id binds the capture window), else nothing opens.
  const captureEmbedAt = useCallback(async (headingLine: number, pageUrl: string) => {
    const path = activeTalkRef.current?.outlinePath
    const index = slideLinesRef.current.indexOf(headingLine)
    const row = index >= 0 ? compiledSlidesRef.current?.[index] ?? null : null
    const compiledSource = compiledSourceRef.current
    try {
      if (!editorCmdsRef.current) throw new Error('The editor is not ready')
      await editorCmdsRef.current.settleSave()
    } catch { notify('The talk could not be saved. Try capturing again.', 'warning', 'capture-embed'); return }
    if (activeTalkRef.current?.outlinePath !== path) return
    if (!row?.slide_id) { notify('This slide is not ready yet. Wait a moment for the preview, then capture again.', 'info', 'capture-embed'); return }
    const source = captureSourceBlock(editorReadRef.current?.()?.text ?? outlineContentRef.current, row, compiledSource)
    if (!source) { notify('This slide has changed. Wait for the preview, then capture again.', 'info', 'capture-embed'); return }
    void openCaptureEmbed({
      open: (request) => window.tw.livePage.openCapture(request),
      notify: (message, kind) => notify(message, kind, 'capture-embed')
    }, {
      outlinePath: activeTalkRef.current?.outlinePath ?? null,
      slideId: row.slide_id,
      title: row.title ?? '',
      text: source
    }, pageUrl)
  }, [])
  // Remove from slide (Inspector › Web page): takes one saved view's {capture} line out of the
  // inspected slide, planned against the editor's own buffer (typing not yet saved is kept) and put in
  // as one undoable change. The slide's marker stays, so the view does not come back; the picture and
  // its record stay in the talk folder. A refusal leaves the text exactly as it is and says why.
  const removeSavedView = useCallback((pageUrl: string, image: string, embed: { index: number; of: number }) => {
    const doc = editorReadRef.current?.()
    const index = activeSlideRef.current
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
    const selected = slideSelectionControls()
    // A refused grid selection must never fall through to deleting the editor's active slide.
    if (selected && selected.count() > 0) { selected.remove(); return }
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
      cmdMenuOpen || abstractOpen || embedCheckOpen || layoutDoctorOpen ||
      explainIndex != null || whereUsedId != null || imageMetaId != null ||
      adoptTarget != null || mergeRequest != null || tagSlide != null || slideMenu != null || actionsHere != null
  }, [
    browserOpen, searchOpen, iconPickerOpen, plainIcon.isOpen, helpOpen, cmdMenuOpen,
    abstractOpen, embedCheckOpen, layoutDoctorOpen, explainIndex, whereUsedId, imageMetaId,
    adoptTarget, mergeRequest, tagSlide, slideMenu, actionsHere
  ])

  // Open the slide context menu anchored near the caret's slide: the editor's live cursor
  // coordinates (CodeMirror coordsAtPos) when the caret is in the viewport, else under the
  // toolbar — never nowhere.
  const openSlideMenu = useCallback((opts: {
    startAtFirst: boolean
    startAtAction?: SlideMenuAction
    withText: boolean
    consumeFence?: ConsumeInsertFence
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
    const before = editorReadRef.current?.({ saveText: text })
    const currentBaseline = (): boolean => {
      const current = editorReadRef.current?.()
      return before?.path !== outlinePath || (current?.path === outlinePath && current.epoch === before.epoch)
    }
    return queueOutlineWrite(outlinePath, async () => {
      if (!currentBaseline()) return false
      const doc = editorReadRef.current?.()
      const identity = before?.path === outlinePath ? before.saveIdentity : undefined
      const reply = await window.tw.talk.writeOutline(outlinePath, text, {
        expectedDiskHash: doc?.path === outlinePath ? doc.diskHash : undefined,
        identity: identity?.options()
      })
      if (reply && reply.ok && currentBaseline()) identity?.acknowledge(reply.content ?? text)
      return reply
    })
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
          return editorReplaceRef.current?.(next, { save: true, ownUndoStep: applyOpts?.ownUndoStep, headingOrder: applyOpts?.headingOrder }) ?? null
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
  const editorIdentityRef = useRef({path:activeTalk?.outlinePath, key:activeTalk?.outlinePath})
  if (editorIdentityRef.current.path !== activeTalk?.outlinePath)
    editorIdentityRef.current = {path:activeTalk?.outlinePath,key:activeTalk?.outlinePath}
  useEffect(() => {
    const adopt = (event:Event) => {
      const {from,to} = (event as CustomEvent<{from:string;to:string}>).detail
      if (editorIdentityRef.current.path === from) editorIdentityRef.current.path = to
    }
    window.addEventListener('tw-adopt-moved-buffer', adopt)
    return () => window.removeEventListener('tw-adopt-moved-buffer', adopt)
  }, [])
  const recoveryPathRef = useRef({path: activeTalk?.outlinePath, generation: 0})
  if (recoveryPathRef.current.path !== activeTalk?.outlinePath) {
    recoveryPathRef.current = {path: activeTalk?.outlinePath, generation: recoveryPathRef.current.generation + 1}
  }
  const recoveryDiscardRef = useRef(onDiscardTalk)
  recoveryDiscardRef.current = onDiscardTalk
  useEffect(() => {
    const recover = (event:Event) => receive(event)
    type Caller = { retire: boolean; done?: (ok: boolean) => void }
    type Operation = { from: string; talk: typeof activeTalkRef.current; generation: number; callers: Caller[]; retire: boolean; adopt?: (isCurrent:()=>boolean)=>Promise<boolean> }
    let owner: Operation | null = null
    let mounted = true
    const settle = (op: Operation, ok: boolean) => {
      const callers = op.callers.splice(0)
      for (const caller of callers) {
        // A retirement supersedes selection, but must still answer its close caller.
        try { caller.done?.(ok && (!op.retire || caller.retire)) } catch (error) { console.error(error) }
      }
    }
    const current = (op: Operation) => mounted && owner === op && recoveryPathRef.current.generation === op.generation && activeTalkRef.current === op.talk && activeTalkRef.current?.outlinePath === op.from
    const receive = (event:Event) => {
      const {from, done, retire, adopt} = (event as CustomEvent<{from:string;retire?:boolean;done?:(ok:boolean)=>void;adopt?:(isCurrent:()=>boolean)=>Promise<boolean>}>).detail
      const caller = {done, retire: !!retire || !done}
      if (activeTalkRef.current?.outlinePath !== from) { done?.(false); return }
      if (owner) {
        if (!current(owner)) { done?.(false); return }
        owner.callers.push(caller)
        owner.retire ||= caller.retire
        return
      }
      const op: Operation = {from, talk: activeTalkRef.current, generation: recoveryPathRef.current.generation, callers: [caller], retire: caller.retire, adopt}
      owner = op
      window.dispatchEvent(new CustomEvent('tw-freeze-moved-editor', {detail:true}))
      void (async () => {
        let ok = false
        try {
          await outlineWritesSettled(from)
          if (!current(op)) return
          const doc = editorReadRef.current?.()
          if (!doc || doc.path !== from) return
          // The real editor filter stays frozen through copying, acknowledgement and adoption.
          // Retirement may join a preservation already in flight; it needs its own main receipt settlement.
          let retired = op.retire
          let result = retired
            ? await window.tw.windows.retireMovedTalk(from, doc.text)
            : await window.tw.windows.preserveMovedTalk(from, doc.text)
          if (!current(op) || !result.ok) return
          if (!op.retire && op.adopt) {
            // Ownership includes the IPC acknowledgement and synchronous editor handoff.
            // A joining close invalidates adoption before it can reset the editor freeze.
            const adopted = await op.adopt(() => current(op) && !op.retire)
            if (adopted) { ok = true; return }
            if (!op.retire) return
          }
          if (op.retire && !retired) {
            const latest = editorReadRef.current?.()
            if (!latest || latest.path !== from || latest.text !== doc.text) return
            result = await window.tw.windows.retireMovedTalk(from, latest.text)
            if (!current(op) || !result.ok) return
            retired = true
          }
          const latest = editorReadRef.current?.()
          if (!latest || latest.path !== from || latest.text !== doc.text) return
          outlineDiskChanges.discard(from)
          ok = true
          if (retired) { recoveryDiscardRef.current?.(); notify('Your editor text was kept in a recovery copy for the moved talk.', 'info') }
        } catch {
          notify('Could not keep the recovery copy. Your editor is still open; retry recovery.', 'error')
        } finally {
          // Never unfreeze a failed or obsolete snapshot. A path change resets the editor filter.
          if (owner === op) owner = null
          settle(op, ok)
        }
      })()
    }
    window.addEventListener('tw-retire-moved-editor', recover)
    window.addEventListener('tw-preserve-moved-editor', recover)
    return () => {
      mounted = false
      if (owner) settle(owner, false)
      window.removeEventListener('tw-retire-moved-editor', recover)
      window.removeEventListener('tw-preserve-moved-editor', recover)
    }
  }, [])
  const diskGuard = useOutlineDiskChange({
    activeOutlinePath: activeTalk?.outlinePath ?? null,
    readDoc: () => editorReadRef.current?.({ authoredOnly: true }) ?? null,
    replaceDoc: (text, opts) => editorReplaceRef.current?.(text, { ...opts, ownUndoStep: true }) ?? null,
    saveBuffer: async () => (await editorCmdsRef.current?.forceSave()) ?? false,
    flush: async () => { await editorCmdsRef.current?.flushSave() },
    settle: async (signal) => { await editorCmdsRef.current?.settleSave(signal) },
    forceSave: async (signal) => (await editorCmdsRef.current?.forceSave(signal)) ?? false,
    cancelDebouncedSave: path => editorCmdsRef.current?.cancelDebouncedSave(path),
    beforeClose: guardTalkMetadata,
    hasMetadataDraft: talkMetadata.hasStaged,
    hasPendingSketch: sketch.hasPending,
    saveSketch: () => sketchApplyInFlight.current ? Promise.resolve(false) : sketch.flush(),
    onDiscardTalk: () => onDiscardTalk?.(),
  })
  useEffect(() => {
    registerLeaveGuard?.(async () => await guardTalkMetadata() && diskGuard.guardLeave())
  }, [registerLeaveGuard, diskGuard.guardLeave, guardTalkMetadata])
  const reviewedSlide = useMemo(() => diskGuard.mergeReview ? singleSlideDiskReview(diskGuard.mergeReview) : null, [diskGuard.mergeReview])
  const diskChangeBar = diskGuard.change && (
    <OutlineDiskChangeBar change={diskGuard.change} busy={diskGuard.busy} onChoose={diskGuard.choose} />
  )
  // Outside Slide Focus the notice is a warning chip in the status bar (R2); Slide Focus has no status bar and keeps the bar.
  const diskChangeChip = diskGuard.change && (
    <OutlineDiskChangeChip change={diskGuard.change} busy={diskGuard.busy} onChoose={diskGuard.choose} />
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

  function openImageDrawer(): void {
    openFind('images')
  }
  function openFind(mode: FindMode): void {
    if (!activeTalkRef.current) { notify('Open a talk first.', 'info'); return }
    const search = document.querySelector<HTMLInputElement>(`[data-find-panel="${mode}"] input`)
    if (search) { search.focus(); return }
    setFindMode(mode)
    showTab('find')
  }
  function closeFind(): void {
    replacingPanelImage.current = null
    setFindMode(null)
    closeTab('find')
    setImageDropping(null)
    focusEditor()
  }
  const toggleImageDrawerRef = useRef<() => void>(() => {})
  toggleImageDrawerRef.current = () => {
    if (findPanelVisible && findMode === 'images') { closeFind(); commandRan('image') }
    else runRegisteredCommand('image')
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
  const feedbackSummaries = useFeedbackSummaries()
  const activeFeedback = activeShare ? feedbackSummaries[activeShare.shareId] ?? null : null
  const feedbackPaused = activeFeedback?.connection === 'paused'
  const shareEnded = Boolean(activeShare?.ended) || activeFeedback?.connection === 'ended'
  const railOpen = sidebarTab === 'feedback' && Boolean(activeShare) && paneState === 'both'
  // Read while the talk is shared, rail open or not: the slide pane's markers come from it too.
  const feedback = useFeedbackList(activeTalk?.outlinePath ?? null, activeFeedback, Boolean(activeShare))
  const railSlides = useMemo<RailSlide[]>(
    () => (compiledSlides ?? []).map((row) => ({ slideId: row.slide_id, title: plainInlineText(row.nav_title || row.title), line: row.source_line ?? null })),
    [compiledSlides]
  )
  // Stopping the share (here or in another window) closes the rail with it.
  useEffect(() => { if (!activeShare) closeTab('feedback') }, [activeShare])
  // Markers on the slide pane (ticket 06, frame 2): badges per slide, ghost rows for new slides.
  const feedbackMarkers = useMemo(
    () => (activeShare && feedback.list ? slideMarkers(feedback.list.items, (compiledSlides ?? []).map((row) => row.slide_id)) : null),
    [activeShare, feedback.list, compiledSlides]
  )
  // The feedback rail is the Feedback tab of the right sidebar (R11a), from a marker or from the toolbar.
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
    if (line != null && !markdownView) activeLineReporter.report(activeHeadingLine(slideLines, line))
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
      if (request.kind === 'slide-merge') {
        return editorCmdsRef.current?.commitSlideMerge(request) ?? { ok: false, error: 'The editor is no longer open.' }
      }
      return mutator.applyFromMain(request.outlinePath, request.base, request.next, request.origin)
    })
  }, [])

  function jumpToOutlineLine(line: number, opts?: { takeFocus?: boolean }): void {
    const node = structure.nodes.find(node => node.line + 1 === line)
    const path = activeTalkRef.current?.outlinePath
    setSelectedSubslide(node?.folded && path ? { id: node.id, line, path } : null)
    setFocusLine({ line, takeFocus: opts?.takeFocus ?? true })
    handleCursorLine(line)
    if (node?.folded) activeLineReporter.report(line)
  }

  // Persist the grid column count so it survives reloads.
  useEffect(() => {
    try {
      window.localStorage.setItem(GRID_COLS_STORAGE_KEY, String(gridColumns))
    } catch {
      // ignore persistence failures
    }
  }, [gridColumns])

  useEffect(() => {
    try { window.localStorage.setItem(PANE_STATE_STORAGE_KEY, savedPaneState) } catch { /* ignore persistence failures */ }
  }, [savedPaneState])

  useEffect(() => {
    if (sidebarTab !== 'inspector' && sidebarTab !== 'talk') return
    try { window.localStorage.setItem(SIDEBAR_TAB_STORAGE_KEY, sidebarTab) } catch { /* ignore persistence failures */ }
  }, [sidebarTab])
  // Slides with the sidebar on or off, as it was before the Strip or Grid view was picked: the Slides view comes back to it.
  const slidesPaneRef = useRef<PaneState>(savedPaneState === 'strip' ? 'both' : savedPaneState)
  useEffect(() => { if (savedPaneState !== 'strip') slidesPaneRef.current = savedPaneState }, [savedPaneState])

  // Set when Enter/double-click in the grid sent you to the editor; the next Escape there
  // returns to the grid. One-shot, and any MANUAL view switch cancels it — after ⌘1/⌘4 the
  // user has chosen a view themselves, so Esc must not yank them back.
  const returnToGridRef = useRef(false)

  // The three main views (R18): Slides (the editor, the right sidebar on or off), Grid, and Strip (full width).
  function selectPane(next: PaneState, revealCaret = true): void {
    const select = () => {
      returnToGridRef.current = false
      setGridMode(false)
      setPaneState(next)
      if (revealCaret && next !== 'strip') scrollEditorToCursor()
    }
    if (paneStateRef.current === 'both' && next !== 'both') afterTalkMetadata(select)
    else select()
  }

  function selectWorkspaceView(view: WorkspaceView): void {
    if (sketchApplyInFlight.current) return
    if (sketch.current) {
      void sketch.close().then(ok => { if (ok) showWorkspaceView(view) })
    } else showWorkspaceView(view)
  }

  function showWorkspaceView(view: WorkspaceView): void {
    if (focusSlideRef.current != null) exitFocus()
    if (view === 'grid') {
      if (paneStateRef.current === 'strip') setPaneState(slidesPaneRef.current)
      selectGrid()
    } else {
      setTextView(view)
      selectPane(paneStateRef.current === 'strip' ? slidesPaneRef.current : paneStateRef.current, view !== 'slide')
    }
  }

  const workspaceView = gridMode ? 'grid' : paneState === 'strip' ? null : textView
  const lastWorkspace = useRef<{ path?: string; opening?: typeof talkOpening; startView?: WorkspaceView; view: WorkspaceView | null }>({ view: null })
  const openingTalk = lastWorkspace.current.path !== activeTalk?.outlinePath || lastWorkspace.current.opening !== talkOpening
  useEffect(() => {
    const path = activeTalk?.outlinePath
    const previous = lastWorkspace.current
    lastWorkspace.current = { path, opening: talkOpening, startView, view: workspaceView }
    if (!path) return
    if (openingTalk || previous.startView !== startView) {
      const initialView = talkOpening?.view ?? startView ?? defaultView
      if (openingTalk && previous.path === path) {
        // Reopening the same file retains its editor and compiled rows.
        pathways.setPathwayId(null)
        if (outlineOwner === path && compiledSlides?.length) selectSlideRef.current(0)
      }
      showWorkspaceView(initialView)
      if (initialView !== 'grid') onEnterEditingView?.(path)
    } else if (workspaceView !== previous.view && workspaceView && workspaceView !== 'grid') {
      onEnterEditingView?.(path)
    }
  }, [activeTalk?.outlinePath, talkOpening, startView, workspaceView])

  function selectSlides(): void { selectWorkspaceView('slide') }

  function selectStrip(): void { selectPane('strip') }

  function selectGrid(): void {
    returnToGridRef.current = false
    onClosePathways?.()
    setGridMode(true)
  }

  function openPathways(): void {
    if (!activeTalk) return
    onOpenPathways?.()
    if (focusSlideRef.current != null) exitFocus()
    setGridMode(true)
  }

  function backFromPathways(): void {
    onClosePathways?.()
    selectSlides()
  }

  function openPathwaysWithHint(): void {
    openPathways()
    notify('Choose a pathway, then Present this pathway.', 'info', 'pathways')
  }

  // Show one tab of the right sidebar, bringing the sidebar up beside the editor (Slides view) if it was off.
  function showTab(tab: RightColumnTab): void {
    const show = () => {
      returnToGridRef.current = false
      setSidebarTab(tab)
      if (paneStateRef.current !== 'both') scrollEditorToCursor()
      setPaneState('both')
    }
    if (tab !== 'talk' && sidebarTabRef.current === 'talk') afterTalkMetadata(show)
    else show()
  }

  useEffect(() => {
    sectionNotice.current = null
    dismissToast('section-added')
  }, [activeTalk?.outlinePath])

  const [talkTabPage, setTalkTabPage] = useState<'details' | 'design'>('details')
  const talkTabPageRef = useRef(talkTabPage)
  talkTabPageRef.current = talkTabPage
  function changeTalkTabPage(page: 'details' | 'design', then?: () => void): void {
    const select = () => { setPanelTry(null); setTalkTabPage(page); then?.() }
    if (talkTabPageRef.current !== page) afterTalkMetadata(select)
    else then?.()
  }
  function openTalkTab(page: 'details' | 'design' = 'details'): void {
    if (!activeTalkRef.current) { notify('Open a talk first.', 'info'); return }
    changeTalkTabPage(page, () => showTab('talk'))
  }
  useEffect(() => {
    const open = (): void => { if (activeTalkRef.current) showTab('talk') }
    window.addEventListener('tw-open-metadata', open)
    return () => window.removeEventListener('tw-open-metadata', open)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function closeTab(tab: RightColumnTab): void {
    setSidebarTab(current => current === tab ? 'inspector' : current)
  }

  function toggleRightSidebar(): void {
    const toggle = () => {
      returnToGridRef.current = false
      const current = paneStateRef.current
      if (current === 'strip') setGridMode(false)
      setPaneState(current === 'both' ? 'editor' : 'both')
      scrollEditorToCursor()
    }
    if (paneStateRef.current === 'both') afterTalkMetadata(toggle)
    else toggle()
  }

  // Global keyboard handler
  useEffect(() => {
    function handleGlobalKey(e: KeyboardEvent) {
      if (isWorkspaceCovered() || isSlideMergeReviewOpen() || talkMetadata.isAsking()) return
      // The edit shell owns keystrokes while its draft is focused, including Escape and Done.
      if (e.target instanceof HTMLElement && e.target.closest('.oe')) return
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
      if (!e.isComposing && !overlayOpenRef.current && eventMatchesEffectiveShortcut(e, 'app.video-marker-add', 'video-marker-add') &&
          markerCommandAvailableRef.current) {
        e.preventDefault()
        e.stopPropagation()
        runRegisteredCommand('video-marker-add')
        return
      }
      if (eventMatchesEffectiveShortcut(e, 'editor.new-slide', 'new-slide')) {
        e.preventDefault()
        e.stopPropagation()
        runRegisteredCommand('new-slide')
        return
      }
      if (slideNavigationRef.current.active && !overlayOpenRef.current && !e.defaultPrevented && !e.isComposing) {
        const target = e.target
        // Talk rows have their own folder navigation. Of the text fields, only the scoped
        // Slide text editor uses these keys to leave the current slide.
        const editingText = target instanceof HTMLElement &&
          (target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)
        const scopedText = slideNavigationRef.current.scopedText &&
          target instanceof HTMLElement && target.matches('.workspace-slide-input .cm-content')
        if (!(target instanceof HTMLElement && target.closest('.tl-panel')) &&
            (!editingText || (scopedText && !isTypingKey(e)))) {
          for (const id of ['previous-slide', 'next-slide'] as const) {
            if (e.metaKey && e.ctrlKey && !effectiveKeys(id).split('-').includes('Ctrl')) continue
            if (surfaceKey(e, id)) { e.preventDefault(); e.stopPropagation(); runRegisteredCommand(id); return }
          }
        }
      }
      for (const id of ['new-section', 'new-subsection', 'present-from-here', 'present-presenter', 'research-panel'] as const) {
        if (surfaceKey(e, id) && activeTalkRef.current && !(isTypingTarget(e.target) && isTypingKey(e))) {
          e.preventDefault(); e.stopPropagation(); runRegisteredCommand(id); return
        }
      }
      for (const id of [...Object.values(VIEW_COMMANDS), 'check-for-updates', 'whats-new', 'research-find', 'set-aside-slides', 'search-slides-grid', 'search-next', 'search-previous', 'pathways', 'add-to-pathway', 'present-pathway'] as const) {
        if (surfaceKey(e, id)) { e.preventDefault(); e.stopPropagation(); runRegisteredCommand(id); return }
      }
      if (activeTalkRef.current && !e.isComposing && !overlayOpenRef.current && !(isTypingTarget(e.target) && isTypingKey(e))) {
        for (const id of ['image', 'find-slides', 'find-icons'] as const) {
          if (!surfaceKey(e, id)) continue
          e.preventDefault()
          e.stopPropagation()
          if (id === 'image') toggleImageDrawerRef.current()
          else runRegisteredCommand(id)
          return
        }
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
      if ((e.metaKey || e.ctrlKey) && !(e.metaKey && e.ctrlKey) && !e.shiftKey && (e.key === 's' || e.key === 'S')) {
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
                if (index >= 0) selectSlideRef.current(index)
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
      // ⌘I opens the icon picker at the caret.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === 'i' || e.key === 'I')) {
        e.preventDefault()
        e.stopPropagation()
        toggleIconPickerRef.current()
        commandRan('icon-picker')
        return
      }
      // ⌘L opens the LAYOUT picker (replaces the old `/` auto-popup, which left stray slashes). It
      // places the chosen trigger on the current slide's Trigger line via the editor's layout channel.
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
    }
    window.addEventListener('keydown', handleGlobalKey, { capture: true })
    return () => window.removeEventListener('keydown', handleGlobalKey, { capture: true })
  }, [])

  useEffect(() => window.tw.app?.onCommand?.(runRegisteredCommand), [runRegisteredCommand])
  useEffect(() => {
    const run = (event: Event): void => runRegisteredCommand((event as CustomEvent<PaletteCommandHandlerId>).detail)
    window.addEventListener('tw-workspace-command', run)
    return () => window.removeEventListener('tw-workspace-command', run)
  }, [runRegisteredCommand])

  useEffect(() => {
    const paste = (event: ClipboardEvent): void => {
      if (isWorkspaceCovered() || focusSlideRef.current != null || !activeTalkRef.current) return
      const clipboard = event.clipboardData
      if (!clipboard) return
      const files = stillPictures(clipboard.files)
      if (!files.length) return
      if (clipboardHasText(clipboard)) {
        const target = event.target
        if (isTypingTarget(target)) {
          // Native fields normally handle plain text themselves. Give HTML-only mixed copies
          // a plain-text insertion when there is no CodeMirror paste handler to do that.
          const editorText = target instanceof HTMLElement && target.closest('.cm-content') &&
            !(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)
          if (!editorText && !clipboard.getData('text/plain')) {
            const text = htmlClipboardText(clipboard)
            if (text) {
              event.preventDefault()
              document.execCommand('insertText', false, text)
            }
          }
          return
        }
        if (!(target instanceof Element) || !target.closest('.workspace-slide-stage, [data-view="grid"], [data-slides-mode]')) return
      }
      event.preventDefault()
      event.stopImmediatePropagation()
      void pastePicturesRef.current(files)
    }
    const drop = (event: DragEvent): void => {
      if (isWorkspaceCovered() || focusSlideRef.current != null || !activeTalkRef.current) return
      if (!(event.target instanceof Element) || !event.target.closest('.workspace-panes, [data-slides-mode]')) return
      const files = stillPictures(event.dataTransfer?.files)
      if (!files.length) return
      event.preventDefault()
      event.stopImmediatePropagation()
      setImageDropping(null)
      setPictureDropLines(null)
      const point = pictureDropPointAt(event)
      if (point === null) {
        notify('Choose a line in the editor to drop the picture.', 'warning', 'paste-picture')
        return
      }
      void pastePicturesRef.current(files, point)
    }
    // The editor lives in a reverse portal, so its drag events bypass the panes' React handlers.
    // Listen in the native DOM, where the editor is inside the current Markdown pane.
    const dragOver = (event: DragEvent): void => {
      if (isWorkspaceCovered() || focusSlideRef.current != null || !activeTalkRef.current) return
      const data = event.dataTransfer
      if (!data || data.types.includes(IMAGE_DRAG_TYPE) || !hasPictureItem(data)) return
      const point = pictureDropPointAt(event)
      if (point === undefined) return
      event.preventDefault()
      data.dropEffect = 'copy'
      setImageDropping(null)
      const pointer = point?.line ?? null
      const doc = editorReadRef.current?.()
      const node = doc && pointer !== null ? markdownCaretNode(doc, pointer) : undefined
      const heading = node ? node.line + 1 : null
      setPictureDropLines(current => pointer === null ? null
        : current?.pointer === pointer && current.heading === heading ? current : { pointer, heading })
    }
    const clearPictureDrop = (): void => setPictureDropLines(null)
    const dragLeave = (event: DragEvent): void => {
      if (isMarkdownEditorTarget(event.target) && !isMarkdownEditorTarget(event.relatedTarget)) clearPictureDrop()
    }
    window.addEventListener('paste', paste, true)
    window.addEventListener('drop', drop, true)
    window.addEventListener('dragover', dragOver, true)
    window.addEventListener('dragleave', dragLeave, true)
    window.addEventListener('dragend', clearPictureDrop, true)
    return () => {
      window.removeEventListener('paste', paste, true)
      window.removeEventListener('drop', drop, true)
      window.removeEventListener('dragover', dragOver, true)
      window.removeEventListener('dragleave', dragLeave, true)
      window.removeEventListener('dragend', clearPictureDrop, true)
    }
  }, [])
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
        if (Number.isInteger(index)) selectSlideRef.current(index)
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
    // Transfer the return target before the focused Actions filter unmounts. No deferred refocus:
    // the palette must own the input as soon as it opens.
    const target = actionsHereRef.current?.returnTo
    if (target?.isConnected) target.focus()
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
  function handleSlideMenuAction(action: SlideMenuAction, request?: ObjectInsertRequest): void {
    setSlideMenu(null)
    const reported = SLIDE_MENU_COMMANDS[action]
    if (reported) commandRan(reported)
    switch (action) {
      case 'layout': openLayoutPicker(); break
      case 'icon': setIconPickerOpen(true); break
      case 'image': openImageDrawer(); break
      case 'tag': openTagCurrentSlide(); break
      case 'insert-table': editorInsertObjectRef.current?.('table', request); break
      case 'insert-mindmap': editorInsertObjectRef.current?.('mindmap'); break
      case 'insert-chart': editorInsertObjectRef.current?.('chart', request); break
      case 'insert-mermaid': editorInsertObjectRef.current?.('mermaid', request); break
      case 'insert-diagram': editorInsertObjectRef.current?.('diagram'); break
      case 'insert-svg': editorInsertObjectRef.current?.('svg', request); break
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
      setFocusOpen(false)
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
    activeSlideRef.current = 0
    cursorLineRef.current = null
    cursorAwaitsCompileRef.current = false
    compiledSlidesRef.current = null
    compiledSourceRef.current = null
    slideLinesRef.current = []
    setCompiledSlides(null)
    setFailedCompilePath(null)
    setTriggerFindings([])
    setThumbnails(null)
    thumbnailRowsRef.current = null
    setPreviewsPending(false)
    compileImmediatelyRef.current = false
    compileAttemptedRef.current = false
    // Also drop the previous talk's text: until the new outline loads, SlideStrip falls back to
    // parseSlides(outlineContent) — the OLD talk's cards briefly rendered under the NEW talk's title.
    setOutlineContent('')
    setOutlineOwner(null)
    setPictureDropLines(null)
    setActiveSlide(0)
    panelRemap.current = null
    setPanelOpened(null)
    setDirty(false) // pending edits were flushed at the switch boundary
    setFocusLine(null)
    setFocusOpen(false)
    setFocusRange(null)
    // Clear the outline sidebar's follow-cursor highlight so it doesn't linger on the previous
    // talk's line until the first cursor move in the new talk.
    activeLineReporter.report(null)
  }, [activeTalk?.outlinePath])

  // Typing waits for a pause. Opening a talk and deliberate grid/slide mutations compile on the
  // next turn, so a move does not spend 900ms showing its old order. Thumbnail work stays separate.
  useEffect(() => {
    // The selected path can change before the editor finishes loading its outline. Compiling
    // that path with the outgoing buffer does real work and makes the incoming compile wait.
    if (!activeTalk || outlineOwner !== activeTalk.outlinePath || !outlineContent) return
    let cancelled = false
    let stopProgress: (() => void) | undefined
    const outlinePath = activeTalk.outlinePath
    const requestId = crypto.randomUUID()
    if (compileTimer.current) clearTimeout(compileTimer.current)
    // While this talk's compile is in flight an edit is recorded at once (it only replaces the remembered
    // text; nothing is sent until the reply), so the follow-up compile is always the newest text. The
    // typing pause only decides when an idle talk starts compiling.
    const pause = gridModeRef.current || compileImmediatelyRef.current || !compileAttemptedRef.current || liveCompile.busy(activeTalk.outlinePath) ? 0 : LIVE_COMPILE_PAUSE_MS
    compileTimer.current = setTimeout(async () => {
      compileAttemptedRef.current = true
      compileImmediatelyRef.current = false
      // setCompiling belongs INSIDE the timer: calling it per keystroke forced a full
      // WorkspaceLayout re-render on every character typed during the debounce window.
      setCompiling(true)
      setPreviewsPending(true)
      let slides: ProjectionRow[] | null
      try {
        const outcome = await liveCompile.request(outlinePath, outlineContent)
        // A newer revision of this talk replaced this request before it ran: its reply will follow.
        if (outcome.status === 'superseded') return
        slides = outcome.result
      } catch (error) {
        console.error('[compile]', error)
        slides = null
      }
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
      const previousIndex = activeSlideRef.current
      const previousId = compiledSlidesRef.current?.[previousIndex]?.slide_id ?? null
      const index = slides?.length ? resolveInspectedSlide(slides, previousId, previousIndex).index : previousIndex
      // Inspector actions can read these before React commits the new rows.
      compiledSlidesRef.current = slides
      compiledSourceRef.current = slides ? outlineContent : null
      slideLinesRef.current = computeSlideLines(slides, outlineContent)
      activeSlideRef.current = index
      if (index !== previousIndex) setActiveSlide(index)
      setCompiledSlides(slides)
      setFailedCompilePath(slides === null ? outlinePath : null)
      setTriggerFindings(slides === null
        ? []
        : attributeOrphanedTriggerFindings(outlineContent, slides, scanOutlineTriggers(outlineContent, undefined, { strandedTitleIcons: true })))
      setCompiling(false)
      // Thumbnails: do not block the strip. A null map = the render couldn't run at all.
      stopProgress = window.tw.talk.onThumbnailProgress?.((update) => {
        if (cancelled || update.requestId !== requestId || update.outlinePath !== outlinePath) return
        setThumbnails((pictures) => ({ ...pictures, ...update.thumbnails }))
      })
      requestSlideThumbnails(outlinePath, outlineContent, { requestId })
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
  }, [outlineContent, outlineOwner, activeTalk?.outlinePath, thumbnailRefresh])

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

  async function handlePresent(mode: 'window' | 'presenter' | 'audience' = 'window', startSlideId?: string) {
    if (!activeTalk || !outlineContent) return
    if (blockedByUnresolved(outlineContent)) return
    if (selectedPathway && pathwayOrder?.length === 0) {
      notify('Add slides to this pathway before presenting.', 'info', 'pathways')
      return
    }
    const start = !selectedPathway || (startSlideId && selectedPathway.slideIds.includes(startSlideId)) ? startSlideId : undefined
    const result = await window.tw.talk.present(activeTalk.outlinePath, outlineContent, mode, start, undefined, undefined, { pathwayId: selectedPathway?.id })
    if (result && result.success === false) notify('Present failed: ' + (result.error || 'unknown error'), 'error')
  }

  // Generated slides have a compiled id but no outline heading to look up.
  async function presentFromHere() {
    if (!activeTalk || !outlineContent) return
    const row = compiledSlidesRef.current?.[activeSlideRef.current]
    const generatedId = compiledSourceRef.current === outlineContent && !row?.source_line ? row?.slide_id : undefined
    const id = currentSlideId() ?? generatedId
    if (!id) notify('This slide isn’t stamped yet — starting from the top. Save the outline to enable present-from-here.', 'info')
    await handlePresent('presenter', id ?? undefined)
  }

  // The ⌘L layout picker, also reachable from the toolbar Insert → Layout. A bare trigger lands on
  // the slide's Trigger line; a multi-line template is spliced as a new block at the caret.
  //
  // ADR-0032: the picker is the Inspector column, so opening it brings that column up (slides beside the
  // outline, not the grid, not Focus) and aims it at the current slide. Pressed again, it closes and the slide is as it was.
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
    const currentLine = lineOfSlideIndex(activeSlideRef.current)
    const caretLine = doc.text.slice(0, doc.caret).split('\n').length - 1
    const target = read.slides.find(candidate => candidate.line === currentLine)
      ?? read.slides.findLast(candidate => candidate.start <= caretLine)
    if (!target) { notify('Put the cursor on a slide first: the layout picker changes the slide you are on.', 'info', 'layout-picker'); return }
    if (focusSlideRef.current != null) exitFocus()
    if (gridModeRef.current) setGridMode(false)
    showTab('inspector')
    if (currentLine !== target.line) jumpToOutlineLine(target.line, { takeFocus: false })
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
      if (written !== doc.text) editorReplaceRef.current?.(written, { ownUndoStep: true })
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
      { key: 'auto', label: 'Auto', note: 'TalkWeaver picks the design', current: current === 'Auto' },
      ...MARGIN_LAYOUT_NAMES.map((name) => {
        const label = LAYOUTS.find((entry) => entry.name === name)?.label ?? name
        return { key: name, label: designName(name, label), current: current === label }
      })
    ]
    return <MarginMenu title="Design" ariaLabel="Slide design" rows={rows} separatorsAfter={['auto']} more="All designs in the side panel…" anchor={anchor}
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
    if (layoutPicker?.slideId && currentCompiledSlideId && currentCompiledSlideId !== layoutPicker.slideId) {
      setLayoutPicker(null)
      setPickerTry(null)
    }
  }, [currentCompiledSlideId, layoutPicker])
  // ...and so does the talk it was opened on.
  useEffect(() => { setLayoutPicker(null); setPickerTry(null) }, [activeTalk?.outlinePath])

  async function handleBuild() {
    if (!activeTalk || !outlineContent) return
    if (blockedByUnresolved(outlineContent)) return
    setBuildErrorLabel('Build failed')
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
    setBuildErrorLabel('Handout export failed')
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
  async function handlePublishHandout(mediaChoice?: MediaPublishChoice) {
    if (publishingRef.current) return
    if (!activeTalk || !outlineContent) return
    if (blockedByUnresolved(outlineContent)) return
    const outlinePath = activeTalk.outlinePath
    publishingRef.current = true
    setBuildStatus('idle')
    dismissToast('publish-failed')
    setPublishIssue(null)
    setPublishDetails(false)
    setPublishing(true)
    const showIssue = (diagnostic: PublishDiagnostic): void => {
      setPublishIssue({ diagnostic, outlinePath })
      notify(publishDiagnosticTitle(diagnostic), diagnostic.kind === 'cancelled' ? 'info' : 'error', 'publish-failed', {
        label: 'Details', onAction: () => { setPublishIssue({ diagnostic, outlinePath }); setPublishDetails(true) },
      })
    }
    try {
      const res = await publishProgress.run(id => window.tw.talk.publishHandout(outlinePath, outlineContent, mediaChoice, id))
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
        setBuildPath(res.url)
        window.tw.shell.openExternal(res.url)
        // Copy-link is the thing you actually need after publishing (to paste into an email or
        // a chat) — the URL otherwise lives only in frontmatter. Persistent until acted on.
        const link = res.url
        notify('Published: ' + handoutAddressLabel(link), 'success', 'publish-done', {
          label: 'Copy link',
          onAction: () => { navigator.clipboard.writeText(link).then(() => notify('Link copied.', 'success')).catch(() => notify('Couldn’t copy the link.', 'warning')) }
        })
      } else if (res?.notReady) {
        // Publishing could not start (not connected, or one thing missing): the sheet, not a failure toast.
        setBuildStatus('idle')
        if (res.diagnostic) setPublishIssue({ diagnostic: res.diagnostic, outlinePath })
        setPublishNotReady({ warning: res.notReady, outlinePath })
      } else {
        showIssue(res?.diagnostic ?? interruptedPublishDiagnostic(res?.error))
      }
    } catch {
      showIssue(interruptedPublishDiagnostic())
    } finally {
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

  function slideAtEditorLine(line: number, text: string): { index: number; sourceLine: number | null } {
    const snapshot = liveStructureRef.current
    const tree = snapshot.text === text ? snapshot.structure : structureOf(text)
    const node = nodeAtSourceLine(tree, line)
    const authored = node?.folded ? node.ancestors.map(i => tree.nodes[i]).find(parent => parent.container) : node
    const rows = compiledSlidesRef.current
    let index = -1
    if (!rows) index = slideIndexAtLine(slideLinesRef.current, line)
    else if (!authored) index = rows.findIndex(row => row.slide_id === 'deck-title')
    else if (text === compiledSourceRef.current) index = slideLinesRef.current.indexOf(authored.line + 1)
    else if (authored.id) {
      const first = rows.findIndex(row => row.slide_id === authored.id)
      if (first >= 0 && first === rows.findLastIndex(row => row.slide_id === authored.id)) index = first
    }
    return { index, sourceLine: node ? node.line + 1 : null }
  }

  function handleCursorLine(line: number) {
    cursorLineRef.current = line
    if (panelHistoryInProgress.current || inspectorCommitInProgressRef.current) return
    closePickerIfCaretLeft()
    const text = editorReadRef.current?.()?.text ?? outlineContentRef.current
    const { index: idx, sourceLine } = slideAtEditorLine(line, text)
    cursorAwaitsCompileRef.current = compiledSlidesRef.current == null || idx < 0
    activeLineReporter.report(sourceLine)
    // The Slide Scratchpad's note: below the heading of the caret's slide reads as "in its text" (the insert itself checks
    // exactly, against the editor's text).
    setScratchCaretInBody(idx >= 0 && sourceLine != null && line > sourceLine)
    if (idx >= 0) {
      activeSlideRef.current = idx
      setActiveSlide(idx)
    }
  }

  function reportEditorCursor(line: number, editedText?: string, scopedHeadingLine?: number): void {
    if (scopedHeadingLine !== undefined) {
      // The scoped editor already owns this caret. Its new line can be past a neighbour's old
      // compiled heading after a long paste, even though the edit never left this slide.
      editedCaret.current = null
      cursorLineRef.current = line
      cursorAwaitsCompileRef.current = false
      activeLineReporter.report(scopedHeadingLine)
      setScratchCaretInBody(line > scopedHeadingLine)
      return
    }
    const path = activeTalkRef.current?.outlinePath
    if (markdownView && editedText !== undefined && (editedText !== outlineContent || path !== outlineOwner)) {
      // React already reads the new structure for the outline. Follow that same revision
      // before paint, coalescing edits delivered in one commit.
      cursorLineRef.current = line
      editedCaret.current = { path, text: editedText, line }
      return
    }
    editedCaret.current = null
    if (editedText === undefined && talkMetadata.hasStaged()) {
      const { index } = slideAtEditorLine(line, editorReadRef.current?.()?.text ?? outlineContentRef.current)
      if (index >= 0 && index !== activeSlideRef.current) {
        const previousLine = cursorLineRef.current
        // CodeMirror reports selection from inside its update. Saving may dispatch a new transaction.
        queueMicrotask(async () => {
          if (path !== activeTalkRef.current?.outlinePath) return
          if (await guardTalkMetadata()) handleCursorLine(line)
          else if (previousLine != null) setFocusLine({ line: previousLine, takeFocus: false })
        })
        return
      }
    }
    handleCursorLine(line)
  }
  useLayoutEffect(() => {
    const edit = editedCaret.current
    if (!edit) return
    editedCaret.current = null
    if (markdownView && edit.path === outlineOwner && edit.path === activeTalk?.outlinePath && edit.text === outlineContent) {
      handleCursorLine(edit.line)
    }
  })

  // The caret's slide is re-resolved once, when the compile that the caret was placed ahead of arrives.
  useEffect(() => {
    const line = cursorLineRef.current
    if (line == null || !compiledSlides || (!markdownView && !cursorAwaitsCompileRef.current)) return
    if (markdownView && compiledSlides[activeSlideRef.current]?.slide_id === 'deck-thanks') return
    handleCursorLine(line)
  }, [compiledSlides, markdownView]) // eslint-disable-line react-hooks/exhaustive-deps

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

  const handleOutlineContentChange = useCallback((text: string, adoptedFrom?: string): void => {
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
    const path = activeTalkRef.current?.outlinePath ?? null
    if (!adoptedFrom && !inspectorCommitInProgressRef.current && !panelHistoryInProgress.current) panelRemap.current = null
    // A save can tidy Trigger lines or stamp ids. The editor's Undo groups that adoption with
    // the panel edit. Keep the button for this verified successor and clear it on any other edit.
    setPanelApplied(current => current && current.path === path && current.text === adoptedFrom
      ? { ...current, text } : null)
    setOutlineContent(text)
    setOutlineOwner(path)
  }, [])

  // Moving slides and sections (slide handling ticket 1a): every drag and ⌘↑/↓ in the grid and the slide
  // strip runs moveBlocks (shared/slide-handling/blocks.ts) on the editor's BUFFER, through the D1 seam:
  // one minimal change, its own CodeMirror undo step, saved through the file's queue. A ref names a
  // heading line and the heading text seen at drag start; if the buffer no longer has that heading there,
  // the move is refused with a message and nothing changes. The moved slide is selected where it landed.
  async function handleMoveSlides(refs: MoveRef[], place: SlidePlace): Promise<void> {
    if (!gridOutlineActionAllowed()) return
    const talk = activeTalkRef.current
    if (!talk || refs.length === 0) return
    let landed: number | null = null
    let movedText: string | null = null
    const result = await applyOutlineMutation(talk.outlinePath, (text) => {
      const moved = moveBlocks(text, refs, place)
      if ('refused' in moved) throw new Error(moved.refused)
      landed = moved.movedRanges[0]?.line ?? null
      movedText = moved.text
      return { text: moved.text, headingOrder: moved.headingOrder }
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
    if (!gridOutlineActionAllowed()) return false
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
    if (!gridOutlineActionAllowed()) return false
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
      return { text: cut.text, headingOrder: cut.headingOrder }
    }, { ownUndoStep: true })
    if (!result.ok && !result.applied) { notify(result.error, 'info', 'slide-clipboard'); return false }
    if (mode === 'cut') {
      void window.tw.talk.rememberSlideCopy?.(talk.outlinePath, clip).catch(() => {})
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
  function handlePasteAfterCard(clip: string, index: number): ReturnType<SlideBlockOps['paste']> {
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
    const source = activeTalkRef.current?.outlinePath
    if (source) void window.tw.talk.rememberSlideCopy?.(source, copy.clip).catch(() => {})
    notify(copy.count === 1 ? `Copied ${oneBlockName(text, refs, copy.titles)}. Paste with ⌘V.` : `Copied ${copy.count} slides. Paste with ⌘V.`, 'info', 'slide-clipboard')
    return copy.clip
  }
  /** ⌘↑ / ⌘↓ on a card: past the neighbouring slide or section of the same level. */
  function handleStepSlide(ref: MoveRef, dir: 'up' | 'down'): void {
    if (!gridOutlineActionAllowed()) return
    const text = editorReadRef.current?.()?.text
    if (text == null) return
    if (markdownView) {
      const snapshot = liveStructureRef.current
      const tree = snapshot.text === text ? snapshot.structure : structureOf(text)
      const pane = tree.nodes.find(node => node.line + 1 === ref.line && node.folded)
      if (pane) {
        const sibling = carouselPaneSibling(tree, pane, dir)
        if (sibling) void handleStructureDrop([ref.line], sibling.line + 1, dir === 'up' ? 'before' : 'after')
        else notify('There is no subslide in that direction in this carousel.', 'info', 'slide-move')
        return
      }
    }
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
    const target = activeTalkRef.current?.outlinePath
    if (!target) return
    const md = await prepareInsertedSlide(markdown, sourceOutlinePath)
    if (md === null || activeTalkRef.current?.outlinePath !== target) return
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
      const mat = await window.tw.talk.materializeSlideAssets(sourceOutlinePath, markdown, talk.outlinePath)
      if (mat?.success) return mat.markdown
    } catch { /* the copy failed */ }
    notify('The slide files could not be copied into this talk.', 'warning', 'insert-from-vault')
    return null
  }

  // Insert SEVERAL searched slides at once (multi-select), each its own block, at the caret in
  // result order: one insertion, one save.
  async function handleSearchInsertMany(items: { markdown: string; fromSlug: string; sourceOutlinePath?: string }[]) {
    const target = activeTalkRef.current?.outlinePath
    if (!target || items.length === 0) return
    // Each slide made ready for this talk (cross-talk reuse, or a copy from another vault), one after
    // another so ids promised to an earlier slide are never handed out again.
    const blocks: string[] = []
    for (const it of items) {
      const markdown = await prepareInsertedSlide(it.markdown, it.sourceOutlinePath)
      if (markdown === null || activeTalkRef.current?.outlinePath !== target) return
      blocks.push(markdown.replace(/\s*$/, ''))
    }
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
    const replacement = replacingPanelImage.current
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
    if (replacement) {
      if (replacingPanelImage.current !== replacement || replacement.path !== talk.outlinePath) return false
      const applied = changePanelSlide(replacement.base, text => {
        const next = editInlinePicture(text, replacement.line, id)
        if (next === null) throw Error('The picture moved.')
        return next
      }, 'Replace picture')
      if (applied) { replacingPanelImage.current = null; showTab('inspector') }
      return applied
    }
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
  async function scratchpadInsertMany(ids: string[]): Promise<boolean> {
    if (scratchInsertingRef.current) return false
    const talk = activeTalkRef.current?.outlinePath
    if (!talk) return false
    scratchInsertingRef.current = true; setScratchInserting(true)
    try {
      const text = editorReadRef.current?.()?.text ?? outlineContentRef.current
      const place = scratchChosenPlaceRef.current ?? scratchAutoPlace(slideRows(text).filter(row => row.level >= 2)).place
      const outcome = await runScratchBatch({ ...scratchInsertHost, api: window.tw.scratchpad,
        prepareSlide: async (markdown, source) => {
          if (activeTalkRef.current?.outlinePath !== talk) throw new Error('The open talk changed.')
          return prepareScratchBatchSlide(window.tw.talk, markdown, source, talk, text)
        }
      }, ids, place)
      if (!outcome.ok) return false
      if (activeTalkRef.current?.outlinePath === talk) {
        scratchChosenEarlierRef.current = [...scratchChosenEarlierRef.current, place]
        setScratchChosenPlace(outcome.newSlide)
        setScratchBatchLanding({ talk, text: outcome.sourceText, lines: outcome.selectionLines, at: Date.now() })
        slideSelectionControls()?.clear()
        setFocusLine({ line: outcome.lines[0], takeFocus: false })
      }
      return true
    } finally { scratchInsertingRef.current = false; setScratchInserting(false) }
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
      if (!item || item.missing || item.status !== 'active') { notify('That item is no longer available in this talk’s Slide Scratchpad. Nothing was inserted.', 'info', 'scratchpad-insert'); return }
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
    insertMany: scratchpadInsertMany,
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
      selectSlides(); setFocusLine({ line: use.slideLine, takeFocus: true }); handleCursorLine(use.slideLine)
    } else onResearchJump?.(use)
  }
  useEffect(() => {
    if (!researchJump || researchJump.file !== activeTalk?.outlinePath || editorReadRef.current?.()?.path !== researchJump?.file) return
    if (researchJump.index === undefined && researchJump.line !== undefined) {
      setFocusLine({ line: researchJump.line, takeFocus: true }); handleCursorLine(researchJump.line)
    }
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

  function stillPictures(files: FileList | undefined): File[] {
    return Array.from(files ?? []).filter(file => /^image\/(?!gif$|svg\+xml$)/.test(file.type))
  }

  async function pastePictures(files?: readonly File[], drop?: { pos: number; line: number }): Promise<void> {
    const talk = activeTalkRef.current
    const doc = editorReadRef.current?.()
    if (!talk || !doc || doc.path !== talk.outlinePath) return
    const index = activeSlideRef.current
    const row = compiledSlidesRef.current?.[index]
    if (!markdownView && !row) return
    const caretNode = markdownView ? markdownCaretNode(doc, drop?.line) : undefined
    const line = markdownView ? (caretNode ? caretNode.line + 1 : null) : lineOfSlideIndex(index)
    const source = line == null ? null : readOutlineSlides(doc.text).slides.find(slide => slide.line === line)
    if (markdownView && line != null && !source) {
      notify('The caret’s slide could not take the picture. Choose another place and try again.', 'warning', 'paste-picture', undefined, 'expanded')
      return
    }
    const isSection = markdownView ? caretNode?.section : row?.role === 'section-title' || row?.role === 'subsection-title'
    const separate = !source || !!isSection
    const id = crypto.randomUUID().slice(0, 8)
    const resolveLine = (text: string): number | null | undefined => {
      if (text === doc.text) return source?.line ?? null
      if (!source) return (markdownView || row?.slide_id === 'deck-title') ? null : undefined
      if (!source.id) return undefined
      const matches = readOutlineSlides(text).slides.filter(slide => slide.id === source.id)
      return matches.length === 1 ? matches[0].line : undefined
    }
    const stillOpen = () => {
      const current = editorReadRef.current?.()
      return current?.path === doc.path && current.epoch === doc.epoch
    }
    if (placePictures(doc.text, source?.line ?? null, separate, ['pending'], id) === null) {
      notify('This slide could not take the picture. Check the source around the slide and try again.', 'warning', 'paste-picture', undefined, 'expanded')
      return
    }
    const progress = files && files.length > 1 ? 'Adding pictures…' : 'Adding picture…'
    setPictureProgress({ path: talk.outlinePath, id, message: progress, pos: drop?.pos })
    notify(progress, 'info', 'paste-picture')
    try {
      const pictures = files ? await Promise.all(files.map(file => file.arrayBuffer())) : undefined
      if (!stillOpen()) throw new Error('The open talk changed. No picture was pasted.')
      const imported = await window.tw.asset.pasteTalkPictures(talk.outlinePath, pictures)
      if (!imported) throw new Error('That picture could not be added. Nothing on the slide has changed.')
      if (!stillOpen()) throw new Error('The open talk changed during import. No picture was pasted.')
      if (separate) pendingSlide.current = { path: talk.outlinePath, id }
      const result = await applyOutlineMutation(talk.outlinePath, text => {
        const at = stillOpen() ? resolveLine(text) : undefined
        if (at === undefined) throw new Error('The current slide changed during import. Nothing was pasted.')
        const placed = placePictures(text, at, separate, imported, id)
        if (placed === null) throw new Error('The slide could not take the picture. Nothing was pasted.')
        return placed
      }, { ownUndoStep: true })
      if (!result.ok && !result.applied) throw new Error(result.error)
      if (imported.length > 1) {
        pastedRow.current = { path: talk.outlinePath, refs: imported, keepFirst: separate }
        notify(`${imported.length} pictures pasted on this slide.`, 'info', 'paste-picture', {
          label: 'One slide each',
          onAction: () => runRegisteredCommand('split-pasted-picture-row')
        })
      } else notify(separate
        ? 'This slide has no place for a picture, so the picture is on a new slide after it.'
        : 'Picture added and saved in this talk’s media folder.', 'success', 'paste-picture')
    } catch (error) {
      if (pendingSlide.current?.id === id) pendingSlide.current = null
      notify(error instanceof Error ? error.message : 'The picture could not be added.', 'warning', 'paste-picture', undefined, 'expanded')
    } finally {
      setPictureProgress(current => current?.id === id ? null : current)
    }
  }
  async function splitPastedPictureRow(): Promise<void> {
    const row = pastedRow.current
    if (!row || row.path !== activeTalkRef.current?.outlinePath) {
      notify('Paste several pictures to put each one on its own slide.', 'info', 'paste-picture')
      return
    }
    const result = await applyOutlineMutation(row.path, text => {
      const next = splitPictureRow(text, row.refs, row.keepFirst, () => crypto.randomUUID().slice(0, 8))
      if (!next) throw new Error('The picture row has changed. Select the pictures to move them.')
      return next
    }, { ownUndoStep: true })
    if (result.ok || result.applied) { if (pastedRow.current === row) pastedRow.current = null }
    else notify(result.error, 'warning', 'paste-picture')
  }

  const pastePicturesRef = useRef(pastePictures)
  pastePicturesRef.current = pastePictures

  // MD1 uses the source caret even before a new compile has mapped that heading to a card.
  function markdownCaretNode(doc: { text: string; caret: number }, line = lineOfOffset(doc.text, doc.caret)) {
    const snapshot = liveStructureRef.current
    return nodeAtSourceLine(snapshot.text === doc.text ? snapshot.structure : structureOf(doc.text), line)
  }

  function currentSlideRef(): MoveRef | null {
    if (!markdownView) return slideRefOf(activeSlideRef.current)
    const doc = editorReadRef.current?.()
    if (!doc) return null
    const node = markdownCaretNode(doc)
    return node ? { line: node.line + 1, headingText: doc.text.split('\n')[node.line] } : null
  }

  function moveCurrentSlide(dir: 'up' | 'down'): void {
    const ref = currentSlideRef()
    if (ref) handleStepSlide(ref, dir)
  }

  async function duplicateCurrentSlide(): Promise<void> {
    const talk = activeTalkRef.current
    const ref = currentSlideRef()
    if (!talk || !ref) return
    let landed: number | null = null
    const result = await applyOutlineMutation(talk.outlinePath, text => {
      if (!refHolds(text, ref)) throw new Error('This slide changed. Select it again before duplicating it.')
      const copied = copyBlock(text, ref.line)
      if (!copied || copied.block.level === 1) throw new Error('Select a slide you can duplicate.')
      const inserted = pasteSlides(text, copied.clip, { after: ref.line }, () => crypto.randomUUID().slice(0, 8))
      if (!inserted) throw new Error('This slide could not be duplicated.')
      landed = inserted.line
      return inserted.text
    }, { ownUndoStep: true })
    if (result.ok || result.applied) {
      if (landed !== null) slideLanded(landed)
    } else notify(result.error, 'warning', 'duplicate-slide')
  }

  async function duplicateStructureSelection(): Promise<void> {
    const talk = activeTalkRef.current
    const refs = selection.indices.flatMap(index => {
      const ref = slideRefOf(index)
      return ref ? [ref] : []
    })
    if (!talk || refs.length === 0 || refs.length !== selection.count) return
    const reply = await applyOutlineMutation(talk.outlinePath, text => {
      const clip = copyBlocks(text, refs)
      if ('refused' in clip) throw new Error(clip.refused)
      const inserted = pasteSlides(text, clip.clip, { after: clip.lastBlockLine }, () => crypto.randomUUID().slice(0, 8))
      if (!inserted) throw new Error('These slides could not be duplicated here.')
      return inserted.text
    }, { ownUndoStep: true })
    if (!reply.ok && !reply.applied) notify(reply.error, 'warning', 'duplicate-slide')
    else clearStructureSelection()
  }

  async function completeWorkspaceSlide(heading: HeadingCompletionSource): Promise<void> {
    const talk = activeTalkRef.current
    const doc = editorReadRef.current?.()
    if (!talk || !doc || doc.path !== talk.outlinePath) return
    const end = heading.from + heading.text.length
    if (doc.caret !== end || doc.text.slice(heading.from, end) !== heading.text) return
    const id = crypto.randomUUID().slice(0, 8)
    const result = await applyOutlineMutation(talk.outlinePath, text => {
      const placed = completeBlankSlide(text, heading.from, id)
      if (placed === null) throw new Error('A slide could not be added here. Check the source around this slide.')
      return placed
    }, { base: doc.text, ownUndoStep: true })
    if (!result.ok && !result.applied) notify(result.error, 'warning', 'new-slide')
  }

  async function addWorkspaceSlide(after?: number | null, forceChild = false): Promise<void> {
    const talk = activeTalkRef.current
    const doc = editorReadRef.current?.()
    if (!talk || !doc || doc.path !== talk.outlinePath) return
    const index = activeSlideRef.current
    const row = compiledSlidesRef.current?.[index]
    const append = !markdownView && after === undefined && row?.slide_id === 'deck-thanks'
    const caretNode = markdownView && after === undefined ? markdownCaretNode(doc) : undefined
    const originalLine = after !== undefined ? after
      : markdownView ? caretNode ? caretNode.line + 1 : null
        : append || row?.slide_id === 'deck-title' ? null : lineOfSlideIndex(index)
    const source = originalLine == null ? null : readOutlineSlides(doc.text).slides.find(slide => slide.line === originalLine)
    const id = crypto.randomUUID().slice(0, 8)
    pendingSlide.current = { path: talk.outlinePath, id }
    const result = await applyOutlineMutation(talk.outlinePath, text => {
      const line = append ? readOutlineSlides(text).slides.filter(slide => !slide.folded).at(-1)?.line ?? null
        : source?.id ? readOutlineSlides(text).slides.find(slide => slide.id === source.id)?.line
        : doc.text === text ? originalLine : undefined
      if (line === undefined) throw new Error('The current slide changed. Try adding the slide again.')
      const child = forceChild || structureOf(text).nodes.some(node => node.line + 1 === line && node.section)
      const placed = placeBlankSlide(text, line, child, id)
      if (placed === null) throw new Error('A slide could not be added here. Check the source around this slide.')
      return placed
    }, { ownUndoStep: true })
    if (!result.ok && !result.applied) {
      if (pendingSlide.current?.id === id) pendingSlide.current = null
      notify(result.error, 'warning', 'new-slide')
    }
  }

  function selectedStructureLines(): number[] {
    return selection.indices.map(index => lineOfSlideIndex(index)).filter((line): line is number => line !== null)
  }

  async function addStructure(
    kind: SectionKind | 'group',
    line?: number | null,
    heading?: HeadingCompletionSource
  ): Promise<void> {
    const talk = activeTalkRef.current
    const doc = editorReadRef.current?.()
    if (!talk || !doc || doc.path !== talk.outlinePath || !gridOutlineActionAllowed()) return
    const row = compiledSlidesRef.current?.[activeSlideRef.current]
    const active = lineOfSlideIndex(activeSlideRef.current)
    // Accepting a completion replaces only its own prefix, in the same undo step as the new divider.
    const end = heading ? heading.from + heading.text.length : doc.caret
    if (heading && (doc.caret !== end || doc.text.slice(heading.from, end) !== heading.text)) return
    const text = heading ? doc.text.slice(0, heading.from) + doc.text.slice(end) : doc.text
    const source = structureOf(text)
    const caretNode = nodeAtSourceLine(source, lineOfOffset(text, heading?.from ?? doc.caret))
    const selectedPane = selectedSubslide?.path === talk.outlinePath
      ? source.nodes.find(node => node.folded && node.id === selectedSubslide.id) : undefined
    const caretPane = caretNode?.folded && slideIndexAtLine(slideLinesRef.current, caretNode.line + 1) === activeSlideRef.current
      ? caretNode : undefined
    const pane = selectedPane ?? caretPane
    if (kind === 'group' && pane) {
      notify(NONCONTIGUOUS, 'info', 'structure')
      return
    }
    const after = line !== undefined ? line
      : markdownView ? caretNode ? caretNode.line + 1 : null
      : row?.slide_id === 'deck-title' ? null
      : row?.slide_id === 'deck-thanks' ? (source.nodes.at(-1)?.line ?? -1) + 1 || null
        : pane ? pane.line + 1 : active
    const id = crypto.randomUUID().slice(0, 8)
    const lines = selectedStructureLines()
    if (kind === 'group' && lines.length !== selection.count) {
      notify(NONCONTIGUOUS, 'info', 'structure')
      return
    }
    const edit = kind === 'group' ? groupSection(text, lines, id) : createSection(text, { kind, after, id })
    if (!edit.ok) { notify(edit.error, 'info', 'structure'); return }
    pendingSlide.current = { path: talk.outlinePath, id }
    const result = await applyOutlineMutation(talk.outlinePath, text => {
      if (text !== doc.text) throw new Error('The outline changed. Choose the place again.')
      return edit.text
    }, { ownUndoStep: true })
    if (!result.ok && !result.applied) {
      if (pendingSlide.current?.id === id) pendingSlide.current = null
      notify(result.error, 'warning', 'structure')
      return
    }
    if (activeTalkRef.current?.outlinePath !== talk.outlinePath) return
    clearStructureSelection()
    const name = edit.kind === 'section' ? 'Section' : 'Subsection'
    const message = kind === 'group' ? `${name} made. The ${edit.count} slides are in it. Type its name.`
      : `${name} added. ${edit.count === 0 ? 'Its first slide comes next.' :
        `${edit.count} slide${edit.count === 1 ? '' : 's'} that followed ${edit.count === 1 ? 'is' : 'are'} now in it.`}`
    const saved = structureUndoText(result, edit.text)
    const token = `{id=${id}}`
    if (!editorReadRef.current?.()?.text.includes(token)) return
    sectionNotice.current = { path: talk.outlinePath, token }
    notify(result.ok ? message : result.error, result.ok ? 'success' : 'warning', 'section-added',
      { label: 'Undo', onAction: () => undoStructure(talk.outlinePath, saved, 'section-added') })
  }

  function handleGridStructureDrop(refs: readonly MoveRef[], target: MoveRef, side: DropSide): void {
    const text = editorReadRef.current?.()?.text
    if (text == null || !refHolds(text, target) || refs.some(ref => !refHolds(text, ref))) {
      notify('The talk changed while you were moving the slides. Choose the place again.', 'info', 'structure')
      return
    }
    void handleStructureDrop(refs.map(ref => ref.line), target.line, side)
  }

  async function handleStructureDrop(lines: readonly number[], target: number, side: DropSide): Promise<void> {
    const talk = activeTalkRef.current
    const doc = editorReadRef.current?.()
    if (!talk || doc?.path !== talk.outlinePath || doc.text !== outlineContent || !gridOutlineActionAllowed()) return
    const edit = reorderStructure(doc.text, lines, target, side)
    if ('error' in edit) { notify(edit.error ?? 'Choose another place for the slides.', 'info', 'structure'); return }
    const result = await applyOutlineMutation(talk.outlinePath, text => {
      if (text !== doc.text) throw new Error('The outline changed. Choose the place again.')
      return { text: edit.text, headingOrder: edit.headingOrder }
    }, { ownUndoStep: true })
    if (!result.ok && !result.applied) { notify(result.error, 'warning', 'structure'); return }
    const saved = structureUndoText(result, edit.text)
    if (editorReadRef.current?.()?.text === saved) slideLanded(edit.line)
    notify(result.ok ? `Slides moved. ${edit.label}.` : result.error, result.ok ? 'success' : 'warning', 'structure',
      { label: 'Undo', onAction: () => undoStructure(talk.outlinePath, saved) })
  }

  function undoStructure(path: string, written: string, noticeKey = 'structure'): void {
    const doc = editorReadRef.current?.()
    if (doc?.path === path && doc.text === written) editorCmdsRef.current?.undo()
    else notify('The outline has changed since this edit. Use Undo to step back through your later edits first.', 'info', noticeKey)
  }

  function clearStructureSelection(): void {
    selection.clear()
    setSelectingSeveral(false)
  }

  useEffect(() => {
    if (!compiledSlides || !activeTalk) return
    const requested = pendingSlide.current
    const target = requested?.path === activeTalk.outlinePath ? compiledSlides.findIndex(row => row.slide_id === requested.id) : -1
    if (target < 0) {
      const pane = requested?.path === activeTalk.outlinePath ? structure.nodes.find(node => node.id === requested.id && node.folded) : undefined
      if (pane) {
        pendingSlide.current = null
        jumpToOutlineLine(pane.line + 1)
        setFocusLine({ line: pane.line + 1, takeFocus: true, editTitle: true })
      }
      return
    }
    pendingSlide.current = null
    selectSlideRef.current(target)
    const line = slideLines[target]
    if (line != null) setFocusLine({ line, takeFocus: true, editTitle: true })
  }, [compiledSlides])

  // “Start with a slide” creates a blank authored slide and puts the caret there.
  const startedWithSlide = useRef<string | null>(null)
  useEffect(() => {
    const path = activeTalk?.outlinePath
    if (!path || startView !== 'slide' || outlineOwner !== path || !compiledSlides || startedWithSlide.current === path) return
    startedWithSlide.current = path
    const first = compiledSlides.findIndex((row, index) =>
      row.slide_id !== 'deck-title' && focusRangeForSlideLine(outlineContent, slideLines[index] ?? null) != null)
    if (first < 0) return
    selectSlideRef.current(first)
    const line = slideLines[first]
    if (line != null) setFocusLine({ line, takeFocus: true, editTitle: true })
  }, [startView, activeTalk?.outlinePath, outlineOwner, compiledSlides, outlineContent, slideLines])

  const landedExplorerJump = useRef<number | null>(null)
  useEffect(() => {
    if (!compiledSlides || !researchJump || researchJump.index === undefined || researchJump.file !== activeTalk?.outlinePath ||
      outlineOwner !== researchJump.file || compiledSourceRef.current !== outlineContent || landedExplorerJump.current === researchJump.nonce) return
    const byId = researchJump.slideId ? compiledSlides.findIndex(row => row.slide_id === researchJump.slideId) : -1
    const index = byId >= 0 ? byId : researchJump.index
    if (!compiledSlides[index]) return
    landedExplorerJump.current = researchJump.nonce
    setFocusOpen(false)
    setFocusRange(null)
    setGridMode(false)
    setPaneState(pane => pane === 'strip' ? 'both' : pane)
    selectSlideRef.current(index)
    const line = slideLines[index] ?? compiledSlides[index].source_line ?? researchJump.line
    if (line != null) setFocusLine({ line, takeFocus: true })
  }, [researchJump, activeTalk?.outlinePath, outlineOwner, outlineContent, compiledSlides, slideLines])

  const selectedRow = compiledSlides?.[activeSlide]
  const paneNode = selectedSubslide?.path === activeTalk?.outlinePath ? structure.nodes.find(node =>
    node.folded && (selectedSubslide?.id ? node.id === selectedSubslide.id : node.line + 1 === selectedSubslide?.line)) : undefined
  // A slide selected just after an edit or Undo may have moved since its preview compiled.
  const liveSlideNode = scopeOnSlide && selectedRow && outlineContent !== compiledSourceRef.current
    ? structure.nodes.find(node => node.id === selectedRow.slide_id)
    : undefined
  const currentSlideLine = paneNode ? paneNode.line + 1 : liveSlideNode ? liveSlideNode.line + 1
    : selectedRow && selectedRow.slide_id !== 'deck-title' ? slideLines[activeSlide] ?? null : null
  const videoOwner = JSON.stringify([activeTalk?.outlinePath, selectedRow?.slide_id, paneNode?.id ?? paneNode?.line])
  const [videoChoice, chooseVideo] = useState<{ owner: string; index: number }>()
  const [videoNaming, setVideoNaming] = useState<{ owner: string; t: number }>()
  const [videoPlayback, setVideoPlayback] = useState<{ owner: string; ref: string; duration: number }>()
  const ownerVideos = videosAt(currentSlideLine)
  const markerPreview = useMarkerPreview(selectedRow?.slide_id ?? null, scopeOnSlide, ownerVideos)
  const video = ownerVideos[videoChoice?.owner === videoOwner ? videoChoice.index : 0] ?? ownerVideos[0]
  const liveVideo = video && markerPreview.playback(video, ownerVideos)
  useEffect(() => {
    if (video && liveVideo?.duration != null) setVideoPlayback({ owner: videoOwner, ref: video.ref, duration: liveVideo.duration })
  }, [videoOwner, video?.ref, liveVideo?.duration])
  const lastDuration = videoPlayback?.owner === videoOwner && videoPlayback.ref === video?.ref ? videoPlayback.duration : null
  const markerSourceDuration = useMemo(() => video && lastDuration !== null
    ? { ref: video.ref, seconds: lastDuration } : undefined, [video?.ref, lastDuration])

  async function writeVideoMarker(target: AuthoredVideo, edit: VideoMarkerEdit): Promise<void> {
    const path = activeTalk?.outlinePath
    if (!path) return
    const result = await applyOutlineMutation(path, text => {
      const plan = editVideoMarker(text, target, edit)
      if ('error' in plan) throw new Error(plan.error)
      return plan.text
    }, { base: outlineContent, ownUndoStep: true })
    if (!result.ok) notify(result.error, 'warning', 'video-marker-edit')
    if (edit.action === 'add' && (result.ok ? result.changed : result.applied)) {
      // The save can move heading attributes and shift marker lines.
      setVideoNaming({ owner: videoOwner, t: edit.t })
    }
  }

  function addCurrentVideoMarker() {
    const target = video && !video.player ? video : ownerVideos.find(candidate => !candidate.player)
    if (!target) return
    const index = ownerVideos.indexOf(target)
    const t = Math.floor(markerPreview.playback(target, ownerVideos)?.t ?? 0)
    if (target.markers.some(marker => marker.t === t)) return
    if (!scopeOnSlide) selectWorkspaceView('slide')
    if (layoutPicker) closeLayoutPicker()
    showTab('inspector')
    setPanelOpened({ slide: currentCompiledSlideId, page: 'video' })
    chooseVideo({ owner: videoOwner, index })
    void writeVideoMarker(target, { action: 'add', t })
  }

  const videoPanel: VideoMarkerPanel | undefined = video ? {
    selected: video,
    videos: ownerVideos,
    choose: index => chooseVideo({ owner: videoOwner, index }),
    playback: liveVideo ?? (lastDuration === null ? undefined : { t: 0, duration: lastDuration }),
    namingT: videoNaming?.owner === videoOwner ? videoNaming.t : null,
    clearNaming: () => setVideoNaming(undefined),
    add: addCurrentVideoMarker,
    edit: edit => { void writeVideoMarker(video, edit) },
    seek: t => markerPreview.seek(video, ownerVideos, t)
  } : undefined
  // CodeMirror maps the band through edits, including a blank body line begun with Enter. Only
  // selecting a different slide, or a compile moving its heading, should replace that band.
  const scopeKey = compiledSlides?.[activeSlide]?.slide_id
  const viewScope = useMemo(
    () => scopeOnSlide && currentSlideLine !== null ? focusRangeForSlideLine(outlineContent, currentSlideLine) : null,
    // The heading line and text must come from the same render. CodeMirror maps the band on other edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scopeOnSlide, currentSlideLine, scopeKey, outlineOwner]
  )
  slideNavigationRef.current = { active: slideNavigationActive, scopedText: viewScope !== null }
  const emptySlide = useMemo(
    () => scopeOnSlide && isEmptyAuthoringSlide(extractSlideBlock(outlineContent, currentSlideLine)),
    [scopeOnSlide, outlineContent, currentSlideLine]
  )
  const slideNoteKey = JSON.stringify([activeTalk?.outlinePath, selectedRow?.slide_id, paneNode?.id ?? paneNode?.line])
  const speakerNotes = useMemo(
    () => scopeOnSlide && currentSlideLine !== null ? notesGet(outlineContent, currentSlideLine).blocks : [],
    [scopeOnSlide, currentSlideLine, outlineContent]
  )

  function notesLineOfCurrentSlide(text: string): number | null {
    if (!paneNode) return lineOfSlideIndex(activeSlideRef.current)
    const snapshot = liveStructureRef.current
    const live = snapshot.text === text ? snapshot.structure : structureOf(text)
    if (!paneNode.id) return text === outlineContent ? paneNode.line + 1 : null
    const matches = live.nodes.filter(node => node.folded && node.id === paneNode.id)
    return matches.length === 1 ? matches[0].line + 1 : null
  }

  function editSlideNotes(body: string, position: number, expectedHash?: string, leaving = false): string | null {
    const doc = editorReadRef.current?.({ discardProvisionalTrigger: true })
    if (!doc || doc.path !== activeTalkRef.current?.outlinePath) return 'Select a slide to edit its notes.'
    const line = notesLineOfCurrentSlide(doc.text)
    if (line == null) return 'Select a slide to edit its notes.'
    const blocks = notesGet(doc.text, line).blocks
    const latest = blocks[position]
    if (latest?.hash !== expectedHash || (!latest && blocks.length)) return 'These notes have changed. Reopen the slide to edit the latest text.'
    const blank = !body.trim()
    if (blank && !latest) return null
    // Keep the block's position while the author clears and retypes its body.
    const remove = blank && leaving
    const result = latest
      ? remove ? notesRemove(doc.text, latest.index, latest.hash, true) : notesReplace(doc.text, latest.index, latest.hash, body)
      : notesInsert(doc.text, line, body)
    if (!result.ok) return result.message
    if (remove) setNotesVisibility({ row: slideNoteKey, open: true })
    if (result.text === doc.text) return null
    return editorReplaceRef.current?.(result.text) === result.text ? null : 'The notes could not be saved. Try again.'
  }

  function isMarkdownEditorTarget(target: EventTarget | null): boolean {
    return target instanceof Element && !!target.closest('[data-view="markdown"] .editor-container')
  }

  // Other drop surfaces keep their selection rules.
  function pictureDropPointAt(event: DragEvent): { pos: number; line: number } | null | undefined {
    return isMarkdownEditorTarget(event.target)
      ? editorCmdsRef.current?.pointAtCoords(event.clientX, event.clientY) ?? null : undefined
  }

  function hasPictureItem(data: DataTransfer): boolean {
    return Array.from(data.items).some(item => item.kind === 'file' && /^image\/(?!gif$|svg\+xml$)/.test(item.type))
  }

  // The drawer's result drag keeps its own MIME type and insertion behaviour.
  const isDrawerDrag = (e: React.DragEvent): boolean => e.dataTransfer.types.includes(IMAGE_DRAG_TYPE)
  function handleDrawerDragOver(e: React.DragEvent): void {
    if (isMarkdownEditorTarget(e.target) && !isDrawerDrag(e)) return
    if (!isDrawerDrag(e) && !hasPictureItem(e.dataTransfer)) return
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

  // Metadata commits are authored CodeMirror transactions. Saving the editor's current
  // revision through its normal queue also keeps undo, conflict handling and close in step.
  function applyTalkMetadata(path: string, edits: FrontmatterEdit[], bases?: Parameters<CommitMetadata>[2]): boolean {
    const doc = editorReadRef.current?.()
    if (!doc || doc.path !== path || activeTalkRef.current?.outlinePath !== path) return false
    if (bases) {
      const pairs = parseFrontmatterPairs(doc.text)
      for (const field of bases) {
        const pair = [field.key, ...(field.aliases ?? [])].map(key => pairs.find(pair => pair.key === key)).find(Boolean)
        if (Boolean(pair) !== field.present || (pair?.value ?? '') !== field.value) return false
      }
    }
    const next = editFrontmatterText(doc.text, edits)
    if (next === doc.text) return true
    inspectorCommitInProgressRef.current = true
    compileImmediatelyRef.current = true
    try {
      const accepted = editorReplaceRef.current?.(next, { ownUndoStep: true })
      if (accepted == null || accepted === doc.text) return false
      const save = editorCmdsRef.current?.flushSave()
      if (edits.some(({ key }) => key === 'title' || key === 'subtitle' || key === 'event')) {
        void save?.then(() => onMetadataSaved?.())
      }
      return true
    } finally {
      inspectorCommitInProgressRef.current = false
    }
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

  function openNewTalkInView(view: StartingView): void {
    if (activeTalkRef.current) window.dispatchEvent(new CustomEvent('tw-new-talk', { detail: view }))
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
    'research-panel': () => { if (!activeTalkRef.current) notify('Open a talk first.', 'info'); else if (researchPanelOpenRef.current) { closeTab('research'); focusEditor() } else showTab('research') },
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
    'new-sketch': () => { if (activeTalkRef.current) void openSketch(); else notify('Open a talk first.', 'info') },
    'scratchpad-panel': () => {
      if (!activeTalkRef.current) notify('Open a talk first.', 'info')
      else if (scratchpadLayout.layout.mode === 'collapsed' || (scratchDocked && (sidebarTab !== 'scratchpad' || !rightSidebarShown))) expandScratchpad()
      else scratchpadLayout.collapse()
    },
    'scratchpad-dock': () => { if (activeTalkRef.current) dockScratchpad(); else notify('Open a talk first.', 'info') },
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
    'scratchpad-move-up': () => { if (activeTalkRef.current) { scratchpadLayout.expand(); scratchpadActionsRef.current['scratchpad-move-up']?.() } },
    'scratchpad-move-down': () => { if (activeTalkRef.current) { scratchpadLayout.expand(); scratchpadActionsRef.current['scratchpad-move-down']?.() } },
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
    'toggle-inspector': toggleRightSidebar,
    studio: () => window.dispatchEvent(new Event('tw-open-studio')),
    // One Runs view (R5): `history` is the old name of the same command.
    runs: () => window.dispatchEvent(new Event('tw-open-history')),
    history: () => window.dispatchEvent(new Event('tw-open-history')),
    importer: () => window.dispatchEvent(new Event('tw-open-importer')),
    // With no talk open the sheet cannot name a talk: the Tools window opens the sheet, with its talk picker, over its Runs view.
    'plan-run': () => {
      if (activeTalkRef.current) setPlanSheet({ run: null })
      else void window.tw.tools.open('runs', 'plan-run')
    },
    // The strips under the Metadata table (work-files ticket 30): the command presses the strip's own Attach button.
    'attach-prework': () => { const why = activeTalkRef.current ? pressAttachOnStrip(document, 'pre') : 'Open a talk first.'; if (why) notify(why, 'info', 'attach-work-file') },
    'attach-postwork': () => { const why = activeTalkRef.current ? pressAttachOnStrip(document, 'post') : 'Open a talk first.'; if (why) notify(why, 'info', 'attach-work-file') },
    pathways: openPathways,
    'add-to-pathway': () => {
      if (!gridModeRef.current || !pathwaysMode) openPathwaysWithHint()
      else slideSelectionControls()?.addToPathway?.()
    },
    'present-pathway': () => {
      if (!gridModeRef.current || !pathwaysMode) openPathwaysWithHint()
      else window.dispatchEvent(new CustomEvent('tw-pathway-command', { detail: 'present' }))
    },
    'new-window': () => { void window.tw.windows?.open?.() },
    'open-in-new-window': () => window.dispatchEvent(new Event('tw-open-in-new-window')),
    'new-talk': () => window.dispatchEvent(new Event('tw-new-talk')),
    'new-folder': () => window.dispatchEvent(new Event('tw-new-folder')),
    'refresh-talks': () => window.dispatchEvent(new Event('tw-refresh-talks')),
    'change-vault': () => window.dispatchEvent(new Event('tw-change-vault')),
    'vault-gallery': () => window.dispatchEvent(new Event('tw-vault-gallery')),
    'search-talks': () => window.dispatchEvent(new Event('tw-search-talks')),
    'present-slide-window': () => { void handlePresent('window', currentSlideId() ?? compiledSlidesRef.current?.[activeSlideRef.current]?.slide_id) },
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
    'find-slides': () => openFind('slides'),
    'find-icons': () => openFind('icons'),
    search: () => setBrowserOpen(true),
    'find-talk': () => {
      pickerCommandsRef.current?.focusFindTalk()
      if (!browserOpenRef.current) setBrowserOpen(true)
    },
    'add-talk-beside': () => runPickerCommand((picker) => picker.addTalkBeside(), 'add-talk-beside'),
    'talk-beside': () => runPickerCommand((picker) => picker.talkBeside(), 'talk-beside'),
    'close-talk-beside': () => runPickerCommand((picker) => picker.closeTalkBeside(), 'close-talk-beside'),
    'select-whole-section': () => runPickerCommand((picker) => picker.selectWholeSection(), 'select-whole-section'),
    'edit-image': () => {
      const at = plainIconToolsRef.current?.caret()
      const line = at?.text.split('\n')[at.line] ?? ''
      const id = pooledImageOnLine(line, at?.text ?? line, at?.line)
      if (id) { imageMetaTalkRef.current = activeTalkRef.current?.outlinePath ?? null; setImageEditRequested(true); setImageMetaId(id) }
      else notify('Place the cursor on a pooled image, then choose Crop and mark up in its image panel.', 'info', 'edit-image')
    },
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
    'save-offline-page': () => { void saveOffline() },
    'video-marker-add': addCurrentVideoMarker,
    'format-bold': () => editorCmdsRef.current?.runFormat('bold'),
    'format-italic': () => editorCmdsRef.current?.runFormat('italic'),
    'format-inline-code': () => editorCmdsRef.current?.runFormat('inline-code'),
    'format-highlight': () => editorCmdsRef.current?.runFormat('highlight'),
    'format-strikethrough': () => editorCmdsRef.current?.runFormat('strikethrough'),
    'format-underline': () => editorCmdsRef.current?.runFormat('underline'),
    'format-link': () => editorCmdsRef.current?.runFormat('link'),
    // Talk design… and Metadata… were two dialogs; a talk's details are edited in the Talk tab now (house rule R11), and the two command ids open it.
    'deck-design': () => openTalkTab('design'),
    metadata: () => openTalkTab(),
    'tag-slide': openTagCurrentSlide,
    abstract: () => setAbstractOpen(true),
    'view-plain': () => selectWorkspaceView('outline'),
    'view-panel-previews': () => onChooseSlidesPanelView?.('previews'),
    'view-panel-outline': () => onChooseSlidesPanelView?.('outline'),
    'view-slide-tab-pages': () => onChooseSlideTabView?.('pages'),
    'view-slide-tab-list': () => onChooseSlideTabView?.('list'),
    'paste-picture': () => { void pastePictures() },
    'split-pasted-picture-row': () => { void splitPastedPictureRow() },
    'duplicate-slide': () => { void duplicateCurrentSlide() },
    'move-current-slide-up': () => moveCurrentSlide('up'),
    'move-current-slide-down': () => moveCurrentSlide('down'),
    'edit-speaker-notes': () => {
      const doc = editorReadRef.current?.()
      if (!selectedRow || !doc || notesLineOfCurrentSlide(doc.text) == null) return
      selectWorkspaceView('slide')
      setNotesVisibility(current => ({ row: slideNoteKey, open: !scopeOnSlide || !(current?.row === slideNoteKey ? current.open : speakerNotes.length > 0) }))
    },
    'view-slide-panel': () => showTab('inspector'),
    'welcome-slide': () => openNewTalkInView('slide'),
    'welcome-outline': () => openNewTalkInView('outline'),
    'welcome-markdown': () => openNewTalkInView('markdown'),
    'change-heading-level': () => openMarginMenuAtCaret('level'),
    'change-slide-layout': () => openMarginMenuAtCaret('layout'),
    'view-markdown': () => selectWorkspaceView('markdown'),
    'view-slides': selectSlides,
    'previous-slide': () => { if (slideNavigationActive) stepInspector(-1) },
    'next-slide': () => { if (slideNavigationActive) stepInspector(1) },
    'view-strip': selectStrip,
    'view-grid': () => selectWorkspaceView('grid'),
    'outline-collapse-all': () => { if (collapseKey) { publishOutline(collapseKey, outlineContentRef.current); collapseAllSections(collapseKey) } },
    'outline-expand-all': () => { if (collapseKey) { publishOutline(collapseKey, outlineContentRef.current); expandAllSections(collapseKey) } },
    'select-section': () => { if (!slideSelectionControls()?.selectSection()) notify('Open the grid and select a slide first.', 'info', 'slide-selection') },
    'clear-slide-selection': () => { slideSelectionControls()?.clear() },
    'search-slides-grid': () => {
      if (!gridModeRef.current) selectGrid()
      requestAnimationFrame(() => requestAnimationFrame(() => searchSurface('grid')?.focus()))
    },
    'go-to-line': () => editorCmdsRef.current?.goToLine(),
    'search-next': () => { if (!searchSurface()?.step(1)) notify('Type a search in the outline or the grid first.', 'info', 'slide-search') },
    'search-previous': () => { if (!searchSurface()?.step(-1)) notify('Type a search in the outline or the grid first.', 'info', 'slide-search') },
    'set-aside-slides': () => {
      if (gridModeRef.current) {
        const selected = slideSelectionControls()
        if (selected && selected.count() > 0) { selected.setAside?.(); return }
        if (selected?.setAside?.()) return
      }
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
    'new-slide': () => { void addWorkspaceSlide() },
    'new-section': () => { void addStructure('section') },
    'new-subsection': () => { void addStructure('subsection') },
    'make-section': () => { void addStructure('group') },
    'select-several-slides': () => {
      setSelectingSeveral(true)
      selection.addMany([activeSlideRef.current])
    },
    'insert-board-slide': () => {
      const line = editorCmdsRef.current?.insertBoardSlide()
      const doc = editorReadRef.current?.()
      if (line == null || !doc) return
      const board = nodeAtSourceLine(structureOf(doc.text), line)
      if (board) slideLanded(board.line + 1)
    },
    'promote-heading': () => runActionBarEditorCommand(editorCmdsRef.current, 'promote-heading'),
    'demote-heading': () => runActionBarEditorCommand(editorCmdsRef.current, 'demote-heading'),
    'bulleted-list': () => runActionBarEditorCommand(editorCmdsRef.current, 'bulleted-list'),
    'numbered-list': () => runActionBarEditorCommand(editorCmdsRef.current, 'numbered-list'),
    'delete-slide': () => { if (!markdownView || currentSlideRef()) handleDeleteSlide() },
    help: () => setHelpOpen(true),
    settings: () => onOpenSettings?.(),
    'settings.setup-folder': () => { void window.tw.settingsWindow.open('setup-folder') },
    'guide.open': () => window.dispatchEvent(new Event('tw-guide-open')),
    'check-for-updates': () => { void runCheckForUpdates() },
    'whats-new': openWhatsNewTab,
    'guide.show-button': () => window.dispatchEvent(new Event('tw-guide-show-button')),
    'example.restore': () => window.dispatchEvent(new Event('tw-restore-example')),
    'app.command-palette': () => setCmdMenuOpen(prev => !prev)
  }, (handlerId) => { if (!SELF_REPORTING_HANDLERS.has(handlerId)) commandRan(handlerId) })

  const markdownInsertReason = markdownView && editorPlace === 'metadata' ? 'Place the caret below Talk details.' : undefined
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
        disabled: menu === 'insert' && !!markdownInsertReason,
        title: menu === 'insert' ? markdownInsertReason : undefined,
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
  function applyInspectorOption(group: OptionGroup, token: string): string | null {
    const path = activeTalkRef.current?.outlinePath
    const row = compiledSlidesRef.current?.[activeSlideRef.current]
    const id = row?.slide_id ?? null
    const headingLine = headingLineForSlideId(outlineContentRef.current, id, group.key === 'arrival-mode')
    if (!path || headingLine == null) return null
    const layout = row?.has_table && (!row.layout || row.layout === 'list') ? 'table' : row?.layout
    return commitPanelEdit(path, () => editorApplyOptionRef.current?.(group, token, headingLine, id, layout) ?? null)
  }
  // ADR-0032 (ticket 01): the Board section edits the slide BODY, not only its Trigger line. The
  // edit is computed against the editor's own buffer (never the outlineContent mirror), for the
  // slide found by its id in that buffer — a slide without an id yet (a fresh insert before its
  // first save) is refused, like an option commit — and goes in as one undoable change.
  function applyInspectorBoardEdit(edit: BoardEdit): boolean {
    const doc = editorReadRef.current?.()
    if (!doc) return false
    const id = compiledSlidesRef.current?.[activeSlideRef.current]?.slide_id ?? null
    const headingLine = headingLineForSlideId(doc.text, id)
    if (headingLine == null) return false
    const next = applyBoardEditToOutline(doc.text, headingLine, edit)
    if (next === doc.text) return true
    return commitPanelEdit(doc.path, () => editorReplaceRef.current?.(next, { ownUndoStep: true })) != null
  }
  const registerEditorCommands = useCallback((cmds: NonNullable<(typeof editorCmdsRef)['current']>) => {
    editorCmdsRef.current = cmds
    setSlideOps(cmds.slides)
    setOutlineOps({ move: cmds.move, reLevel: cmds.reLevel, moveTo: cmds.moveTo, moveToEnd: cmds.moveToEnd, moveInto: cmds.moveInto, slides: cmds.slides })
  }, [])


  const [handoff, setHandoff] = useState<{
    aspect: string; path: string; base: string; slide?: SlideRef; number: number; current: string
    scratch?: { name?: string; item?: ScratchItem; folder: string; after?: { title: string; id?: string } }
  } | null>(null)

  async function openScratchHandoff(aspect: 'sketch' | 'split' | 'scratch', item?: ScratchItem): Promise<void> {
    if (!item && !sketch.read()?.saved && !await sketch.flush()) return
    const doc = editorReadRef.current?.()
    const talk = activeTalkRef.current
    if (!doc || doc.path !== talk?.outlinePath) return
    const name = item?.file ?? (item ? undefined : sketch.read()?.saved?.name)
    if (!name && !item?.slide) return
    const current = compiledSlidesRef.current?.[activeSlideRef.current]
    const place = scratchChosenPlaceRef.current
    const after = place?.kind === 'after' ? { title: place.title, id: structureOf(doc.text).nodes.find(node => node.line + 1 === place.line)?.id }
      : place?.kind === 'start' || !current ? undefined : { title: plainInlineText(current.title), id: current.slide_id || undefined }
    const sep = talk.path.startsWith('/') ? '/' : '\\'
    setHandoff({ aspect, path: doc.path, base: doc.text, number: 0, current: '',
      scratch: { name, item, folder: `${talk.path}${sep}scratchpad`, after } })
  }
  function openHandoff(aspect: string): void {
    const doc = editorReadRef.current?.()
    if (!doc || doc.path !== activeTalk?.outlinePath) return
    if (aspect === 'talkdesign') {
      setHandoff({ aspect, path: doc.path, base: doc.text, number: 0, current: '' })
      return
    }
    const row = compiledSlides?.[activeSlide]
    const line = slideLines[activeSlide]
    if (!row) return
    // Before save tidies Trigger lines, the parser can already see an id on a legacy heading.
    // Prefer source identity so a save that moves that id cannot strand a heading-line locator.
    const authored = readOutlineSlides(doc.text).slides
    const source = authored.find(candidate => candidate.id && candidate.id === row.slide_id)
      ?? authored.find(candidate => candidate.line === line)
    if (!source) return
    const slide = source.id || { headingLine: source.line }
    const current = [row.layout, row.title_layout].filter(Boolean).join(' · ')
    setHandoff({ aspect, path: doc.path, base: doc.text, slide, number: activeSlide + 1, current })
  }
  async function prepareHandoff(request: NonNullable<typeof handoff>): Promise<HandoffReady> {
    const initial = editorReadRef.current?.()
    const editor = editorCmdsRef.current
    if (!editor || initial?.path !== request.path) throw Error('The open talk changed.')
    const draft = sketch.read()
    const sketchDirty = draft?.path === request.path && draft.text !== (draft.saved?.text ?? '')
    if (request.scratch && !await sketch.flush()) throw Error('The sketch was not saved.')
    await editor.settleSave()
    const saved = editorReadRef.current?.()
    if (!saved || saved.epoch !== initial.epoch || saved.dirty || saved.path !== request.path) throw Error('The talk was not saved.')
    const stillCurrent = async (): Promise<boolean> => {
      const disk = await window.tw.talk.outlineDiskVersion(request.path)
      const current = editorReadRef.current?.()
      return !!disk && current?.epoch === saved.epoch && current.text === saved.text && !current.dirty &&
        normalizeOutlineMergeText(disk.text) === saved.text
    }
    if (!await stillCurrent()) throw Error('The file differs from this window.')
    const source: HandoffReady['source'] = { path: saved.path }
    const scratch = request.scratch
    if (scratch) {
      const { name, item, folder, after } = scratch
      const isSketch = !item || item.fileKind === 'sketch'
      const sep = folder.startsWith('/') ? '/' : '\\'
      const file = name ? `${folder}${sep}${name}` : undefined
      source.scratch = { kind: isSketch ? 'sketch' : item.slide ? 'snapshot' : 'visual', title: item?.title ?? name ?? '',
        folder, file, after: item ? after : undefined, markdown: item?.slide?.markdown }
      if (isSketch && name) {
        const live = await window.tw.scratchpad.readSketch(request.path, name)
        const local = sketch.read()
        if (!live.ok || (local?.saved?.name === name && local.path === request.path && local.text !== live.sketch.text)) {
          throw Error('The sketch changed on disk.')
        }
        return { source, saved: initial.dirty || !!sketchDirty, stillCurrent: async () => {
          if (!await stillCurrent()) return false
          const latest = await window.tw.scratchpad.readSketch(request.path, name)
          return latest.ok && latest.sketch.revision === live.sketch.revision
        } }
      }
      return { source, saved: initial.dirty, stillCurrent: async () => {
        if (!await stillCurrent()) return false
        const latest = await window.tw.scratchpad.load()
        return latest.ok && activeTalkRef.current?.outlinePath === request.path && latest.snapshot.items.some(candidate =>
          candidate.id === item?.id && !candidate.missing && candidate.file === item.file && candidate.slide?.markdown === item.slide?.markdown)
      } }
    }
    if (request.slide) {
      const ref = reanchorPickerSlide(request.base, saved.text, request.slide)
      const read = readOutlineSlides(saved.text)
      const slide = read.slides.find(candidate => typeof ref === 'string' ? candidate.id === ref : candidate.line === ref?.headingLine)
      if (!slide) throw Error('The saved slide could not be found.')
      const heading = (line: number): string => read.lines[line].replace(/^#{1,6}\s+/, '').replace(/\s*(?:\{[^}]+\}\s*)+$/, '')
      const section = read.slides.findLast(candidate => candidate.line <= slide.line && candidate.level === 2)
      const points = slidePointLines(read, slide).map(point => point.text)
      source.slide = { id: slide.id || undefined, title: heading(slide.start), section: section ? heading(section.start) : '',
        line: slide.line, number: request.number, current: request.current, points }
    }
    return { source, saved: initial.dirty, stillCurrent }
  }

  const [panelTry, setPanelTry] = useState<(PanelTry & { base: string; path: string; index: number }) | null>(null)
  const activePanelApplied = panelApplied?.path === activeTalk?.outlinePath && panelApplied?.text === outlineContent &&
    panelApplied?.index === activeSlide ? panelApplied : null
  function previewPanelDesign(preview: PanelTry | null): void {
    setPanelTry(preview && activeTalk ? { ...preview, base: outlineContent, path: activeTalk.outlinePath, index: activeSlide } : null)
  }
  const replayPanelEdit = useCallback((place: { path: string; id: string | null; index: number; page: string }, dispatch: () => void): void => {
    if (activeTalkRef.current?.outlinePath !== place.path) {
      dispatch()
      return
    }
    panelHistoryInProgress.current = true
    compileImmediatelyRef.current = true
    try {
      dispatch()
      const resolved = resolveInspectedSlide(compiledSlidesRef.current, place.id, place.index)
      panelRemap.current = resolved
      if (focusSlideRef.current != null) enterFocusRef.current(resolved.index)
      else if (activeSlideRef.current !== resolved.index) selectSlideRef.current(resolved.index)
      setPanelOpened({ slide: resolved.id, page: place.page })
    } finally {
      // The editor reports its history landing in a microtask after its caret clamp.
      queueMicrotask(() => { panelHistoryInProgress.current = false })
    }
  }, [])

  function commitPanelEdit<T>(path: string, commit: () => T): T {
    const place = { path, id: currentCompiledSlideId, index: activeSlide, page: panelPage }
    inspectorCommitInProgressRef.current = true
    compileImmediatelyRef.current = true
    try {
      // History retains the small location and the stable callback, not this render's outline.
      const result = withOutlineEditReplay(replayPanelEdit.bind(null, place), commit)
      panelRemap.current = place
      return result
    } finally {
      queueMicrotask(() => { inspectorCommitInProgressRef.current = false })
    }
  }

  function changePanelSlide(base: string, apply: (text: string) => string, label: string): boolean {
    const doc = editorReadRef.current?.()
    if (!doc || doc.path !== activeTalk?.outlinePath || doc.text !== base) {
      notify('The slide changed. Choose the option again.', 'info')
      return false
    }
    setPanelTry(null)
    try {
      const next = apply(doc.text)
      if (next === doc.text) return true
      const accepted = commitPanelEdit(doc.path, () => editorReplaceRef.current?.(next, { ownUndoStep: true }))
      if (accepted != null) setPanelApplied({ text: accepted, path: doc.path, index: activeSlide, label })
      return accepted != null
    } catch {
      notify('The change could not be applied to this slide.', 'warning')
      return false
    }
  }
  function keepPanelDesign(slide: SlideRef, layout: string, design: Design): void {
    let firstSide: { id: string; line: number } | undefined
    const applied = changePanelSlide(outlineContent, text => {
      const next = panelEdit(text, slide, design, layout)
      if (next === text || design.structure !== 'split-into-groups') return next
      const { nodes, lines } = structureOf(next)
      const owner = nodes.findIndex(node => typeof slide === 'string' ? node.id === slide : node.line + 1 === slide.headingLine)
      if (owner < 0) return next
      // Autosave can move Trigger tokens to their own lines, so keep the sides by id.
      for (const side of nodes.filter(node => node.folded && node.ancestors.at(-1) === owner)) {
        const id = crypto.randomUUID().slice(0, 8)
        firstSide ??= { id, line: side.line + 1 }
        lines[side.line] = lines[side.line].replace(/\r?$/, ` {id=${id}}$&`)
      }
      return lines.join('\n')
    }, design.label)
    if (!applied || !firstSide || !activeTalk) return
    const { line } = firstSide
    showWorkspaceView('slide')
    setSelectedSubslide({ path: activeTalk.outlinePath, ...firstSide })
    activeLineReporter.report(line)
    setFocusLine({ line, takeFocus: true, editTitle: true, selectPlaceholder: true })
  }
  function applyPanelIcon(line: number, key: string | null, base: string, edit?: 'cross'): void {
    changePanelSlide(base, text => {
      const result = !key ? clearLineIcon(text, line)
        : edit === 'cross' ? setExistingLineIconCross(text, line, key)
          : setLineIcon(text, line, key, isKnownIcon)
      if (!result.ok) throw new Error(result.detail)
      return result.text
    }, 'Icon')
  }
  function undoPanelEdit(): void {
    const doc = editorReadRef.current?.()
    if (activePanelApplied && doc?.path === activePanelApplied.path && doc.text === activePanelApplied.text) {
      editorCmdsRef.current?.undo()
      setPanelApplied(null)
    }
  }

  // The right sidebar (R11a): a tab row over the chosen tab. The toolbar's sidebar button shows and hides the whole column.
  const columnUp = guideUp || whatsNewUp
  const whatsNewShown = whatsNewUp && sidebarTab === 'whats-new'
  const guideShown = guideUp && sidebarTab === 'guide' && !whatsNewShown
  const feedbackShared = Boolean(activeShare)
  const columnTab: RightColumnTab = activeTalk
    ? (sidebarTab === 'scratchpad' && !scratchDocked) || (sidebarTab === 'whats-new' && !whatsNewUp) || (sidebarTab === 'guide' && !guideUp) || (sidebarTab === 'feedback' && !feedbackShared) ? 'inspector' : sidebarTab
    : whatsNewShown || !guideUp ? 'whats-new' : 'guide'
  const activePanelTry = rightSidebarShown && panelTry?.path === activeTalk?.outlinePath && panelTry?.base === outlineContent &&
    panelTry?.index === activeSlide && (columnTab === 'inspector' || columnTab === 'talk') ? panelTry : null
  const [layoutGallery, setLayoutGallery] = useState<{ path: string; index: number; opener: HTMLButtonElement } | null>(null)
  const [layoutGalleryTarget, setLayoutGalleryTarget] = useState<HTMLDivElement | null>(null)
  const layoutGalleryOpen = !!layoutGallery && scopeOnSlide && !focusOpen && !layoutPicker && !paneNode && rightSidebarShown &&
    columnTab === 'inspector' && selection.count <= 1 &&
    layoutGallery.path === activeTalk?.outlinePath && layoutGallery.index === activeSlide
  const closeLayoutGallery = useCallback(() => {
    setLayoutGallery(null)
    setPanelTry(null)
    layoutGallery?.opener.focus({ preventScroll: true })
  }, [layoutGallery])
  useEffect(() => {
    if (!layoutGallery) return
    if (!layoutGalleryOpen) {
      setLayoutGallery(null)
      setPanelTry(null)
      return
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing ||
          event.metaKey || event.ctrlKey || event.altKey || event.shiftKey ||
          overlayOpenRef.current || isWorkspaceCovered()) return
      event.preventDefault()
      closeLayoutGallery()
    }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [layoutGallery, layoutGalleryOpen, closeLayoutGallery])
  useEffect(() => { setPanelTry(null) }, [activeSlide, columnTab, rightSidebarShown, focusOpen])
  useEffect(() => { if (columnTab !== 'find' || findMode !== 'images') replacingPanelImage.current = null }, [columnTab, findMode, activeTalk?.outlinePath])
  function selectColumnTab(tab: RightColumnTab): void {
    if (tab !== 'talk' && sidebarTabRef.current === 'talk') afterTalkMetadata(() => setSidebarTab(tab))
    else setSidebarTab(tab)
  }
  const guidePane = <div className="pane pane--guide">{guide?.body}</div>
  const whatsNewPane = <WhatsNewPane />
  const tabsRow = (hasTalk: boolean): React.ReactNode => (
    <RightColumnTabs guideUp={guideUp} whatsNewUp={whatsNewUp} hasTalk={hasTalk} shared={feedbackShared} scratchpad={scratchDocked} findOpen={findMode !== null} active={columnTab} onSelect={tab => {
      if (tab === 'inspector') runRegisteredCommand('view-slide-panel')
      else if (tab === 'talk') runRegisteredCommand('metadata')
      else if (tab === 'research' && columnTab !== tab) runRegisteredCommand('research-panel')
      else if (tab === 'guide' && !guideUp) runRegisteredCommand('guide.open')
      else selectColumnTab(tab)
    }} slideTabView={hasTalk && columnTab === 'inspector' ? slideTabView : undefined}
      onChooseSlideTabView={view => runRegisteredCommand(view === 'pages' ? 'view-slide-tab-pages' : 'view-slide-tab-list')}
      onDismissPanelOptions={() => { setPanelOpened(null); setPanelTry(null) }}
      onCloseGuide={() => guide?.onClose()} onCloseWhatsNew={() => { setWhatsNewUp(false); closeTab('whats-new') }}
      onCloseFind={closeFind} />
  )

  useEffect(() => {
    if (focusSlide !== null || (gridMode ? pathwaysMode : !scopeOnSlide)) return
    if (!pathwayOrder?.length || pathwayOrder.includes(activeSlideRef.current)) return
    selectSlideRef.current(pathwayOrder[0])
  }, [pathwayOrder, pathwaysMode, gridMode, scopeOnSlide, focusSlide, activeSlide])

  if (!activeTalk) {
    return (
      <div className="workspace">
        <div className="workspace-toolbar workspace-welcome-titlebar">
          <span className="workspace-title" style={{ color: 'var(--text-2)', fontWeight: 500 }}>TalkWeaver</span>
          <div className="toolbar-actions">
            <ToolbarMenu
              icon="tools"
              label="Tools"
              title="Studio, history, and app settings"
              items={toolbarItems('tools', ['pathways'])}
            />
          </div>
        </div>
        {sketch.current ? <SketchView talkTitle="TalkWeaver" name={sketch.current.saved?.name ?? ''} text={sketch.current.text}
          error={sketch.current.error} sketches={[]} detached frozen={sketch.frozen} onChange={sketch.change}
          onOpen={() => {}} onDiscard={sketch.discard} onSaveElsewhere={() => void sketch.saveElsewhere()} onBack={backFromSketch} /> : (() => {
          const empty = welcome ?? <div className="workspace-empty" />
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
  const editorKey = editorIdentityRef.current.key

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
      focusRange={focusSlide != null ? focusRange : viewScope}
      slideTextPanel={focusSlide == null && viewScope != null}
      startWithBullet={focusSlide == null && textView !== 'markdown'}
      viewMode={editorViewMode}
      showSourceObjectPreviews={textView !== 'slide'}
      plainLook={plainLook}
      onMarginLevelMenu={(line, anchor) => openMarginMenu('level', line, anchor)}
      onMarginLayoutMenu={(line, anchor) => openMarginMenu('layout', line, anchor)}
      onCaptureEmbedAt={captureEmbedAt}
      registerHeadingTools={(tools) => { headingToolsRef.current = tools }}
      registerPlainIconTools={(tools) => { plainIconToolsRef.current = tools }}
      onPlanRun={() => setPlanSheet({ run: null })}
      textFitNotes={textFitNotes}
      markdownHeadings={markdownHeadings}
      markerSourceDuration={markerSourceDuration}
      pictureProgress={pictureProgress?.path === activeTalk.outlinePath ? pictureProgress : undefined}
      pictureDropLines={pictureDropLines}
      marginLabels={marginLabelList}
      placementRows={compiledSlides}
      registerLayoutContext={(fn) => { editorLayoutContextRef.current = fn }}
      registerApplyLayout={(fn) => { editorApplyLayoutRef.current = fn }}
      registerApplyOption={(fn) => { editorApplyOptionRef.current = fn }}
      focusLine={focusLine}
      onCursorLine={reportEditorCursor}
      onNewHeading={(kind, heading) => {
        if (kind === 'slide') void completeWorkspaceSlide(heading)
        else void addStructure(kind, undefined, heading)
      }}
      onSectionChild={line => {
        jumpToOutlineLine(line)
        setFocusLine({ line, takeFocus: true, editTitle: true })
      }}
      onHistoryLine={(line, outline) => {
        const notice = sectionNotice.current
        if (notice?.path === activeTalk.outlinePath && !outline.includes(notice.token)) {
          sectionNotice.current = null
          dismissToast('section-added')
        }
        if (panelHistoryInProgress.current) return
        const { index, sourceLine } = slideAtEditorLine(line, outline)
        if (index < 0) {
          if (sourceLine !== null) slideLanded(sourceLine)
          return
        }
        if (index === activeSlideRef.current) return
        if (focusSlideRef.current != null) enterFocusRef.current(index)
        else selectSlideRef.current(index)
      }}
      onPlace={(place, reason) => {
        setEditorPlace(place)
        setPromoteHeadingReason(reason)
      }}
      onLineCommandsUnavailable={setLineCommandsUnavailable}
      onImageWidgetClick={(id) => { imageMetaTalkRef.current = activeTalkRef.current?.outlinePath ?? null; setImageEditRequested(false); setImageMetaId(id) }}
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
  const sourceCaretNode = markdownView && outlineOwner === activeTalk.outlinePath && activeOutlineLine != null
    ? nodeAtSourceLine(structure, activeOutlineLine) : undefined
  const actionBarCommands: ReadonlyMap<string, RunnableActionBarCommand> = new Map(
    paletteCommands().map((command) => {
      const keys = liveCommandShortcutLabel(command)
      const slideEdit = SLIDE_BAR_EDITS[command.id]
      const paneDirection = command.id === 'move-current-slide-up' ? 'up'
        : command.id === 'move-current-slide-down' ? 'down' : undefined
      const paneBoundary = sourceCaretNode?.folded && paneDirection && !carouselPaneSibling(structure, sourceCaretNode, paneDirection)
      const disabledReason = command.id === 'promote-heading' && promoteHeadingReason ? promoteHeadingReason
        : slideEdit && markdownView && !sourceCaretNode ? 'Place the caret in an authored slide.'
        : paneBoundary ? 'There is no subslide in that direction in this carousel.'
        : markdownView && command.id === 'promote-heading' && editorPlace !== 'slide-heading' ? 'Place the caret on a heading.'
        : lineCommandsUnavailable && ACTION_BAR_LINE_COMMANDS.has(command.id) ? 'Place the caret on an editable line.'
          : undefined
      return [command.id, {
        label: slideEdit?.label ?? command.label,
        icon: slideEdit?.icon ?? command.toolbar?.icon,
        ...(keys && keys !== 'no default' ? { keys } : {}),
        disabled: Boolean(disabledReason || (slideEdit && !markdownView && currentSlideLine === null)),
        disabledReason,
        run: () => runRegisteredCommand(command.handlerId)
      }]
    })
  )
  const actionBarSections = resolveActionBarItems(
    actionBarItemsFrom(actionBarItemsStored, DEFAULT_ACTION_BAR_ITEMS),
    actionBarCommands
  )
  const ownsOutline = outlineOwner === activeTalk.outlinePath
  const pathwayPosition = pathwayOrder?.indexOf(activeSlide) ?? -1
  const activeRow = ownsOutline && (!scopeOnSlide || !pathwayOrder || pathwayPosition >= 0) ? compiledSlides?.[activeSlide] : undefined
  const authoredNode = structure.nodes.find(node => node.line + 1 === currentSlideLine)
  const childrenOf = (node: typeof authoredNode) => node
    ? structure.nodes.filter(child => child.ancestors.includes(structure.nodes.indexOf(node))) : []
  const authoredChildren = childrenOf(authoredNode)
  const sectionSlide = authoredNode?.section && (activeRow?.role === 'section-title' || activeRow?.role === 'subsection-title')
  const choicesFor = (node: typeof authoredNode, row: ProjectionRow | undefined) => node?.container && row?.layout === 'carousel'
    ? childrenOf(node).filter(child => child.folded).map(child => ({
      title: child.title || 'New subslide', select: () => jumpToOutlineLine(child.line + 1)
    })) : undefined
  const currentPaneParent = paneNode && structure.nodes[paneNode.ancestors.find(index => structure.nodes[index].container) ?? -1]
  const currentPaneIndex = currentPaneParent ? childrenOf(currentPaneParent).filter(child => child.folded).indexOf(paneNode!) : -1
  const currentThumbKey = activeRow?.render_hash || activeRow?.content_hash || activeRow?.slide_id
  const activePaneThumb = currentPaneIndex >= 0 ? thumbnails?.[`${currentThumbKey}__${currentPaneIndex}`] : undefined
  const subsection = activeRow?.subsection && compiledSlides?.find(row => row.role === 'subsection-title' && row.subsection === activeRow.subsection)
  const slidePlace = [readableSectionLabel(compiledSlides, activeSlide), subsection ? plainInlineText(subsection.nav_title || subsection.title) : ''].filter(Boolean).join(' › ')
  const sourceRecovery = !activeRow && failedCompilePath === activeTalk.outlinePath
  const navigationShortcuts = slideNavigationActive ? {
    previous: liveShortcutLabel('app.previous-slide'),
    next: liveShortcutLabel('app.next-slide')
  } : undefined
  const editorColumn = scopeOnSlide ? (
    <WorkspaceSlideView
      key={activeTalk.outlinePath} path={activeTalk.outlinePath} outline={ownsOutline ? outlineContent : ''} row={activeRow} headingLine={currentSlideLine}
      markerPreview={ownerVideos.some(candidate => !candidate.player) ? markerPreview : undefined}
      trying={activePanelTry}
      applied={activePanelApplied?.label}
      layoutGallerySlot={layoutGalleryOpen ? setLayoutGalleryTarget : undefined}
      onUndoDesign={undoPanelEdit}
      onOpenReveal={() => {
        showTab('inspector')
        if (layoutPicker) closeLayoutPicker()
        setPanelOpened({ slide: currentCompiledSlideId, page: 'steps' })
      }}
      index={pathwayOrder ? pathwayPosition : activeSlide} count={pathwayOrder?.length ?? compiledSlides?.length ?? 0}
      place={activeRow ? slidePlace : ''}
      pathwayNavigation={pathwayOrder && {
        prev: pathwayPosition > 0 ? () => handleSelectSlide(pathwayOrder[pathwayPosition - 1]) : undefined,
        next: pathwayPosition >= 0 && pathwayPosition + 1 < pathwayOrder.length ? () => handleSelectSlide(pathwayOrder[pathwayPosition + 1]) : undefined,
        empty: !!compiledSlides && pathwayOrder.length === 0
      }}
      navigationShortcuts={navigationShortcuts}
      notes={speakerNotes} notesKey={slideNoteKey} notesOpen={notesVisibility?.row === slideNoteKey ? notesVisibility.open : speakerNotes.length > 0}
      onToggleNotes={() => runRegisteredCommand('edit-speaker-notes')} onNotesChange={editSlideNotes}
      attachEditor={attachEditorSlot} editable={ownsOutline && (!!activeRow && viewScope !== null || sourceRecovery)}
      sourceRecovery={sourceRecovery}
      section={sectionSlide && authoredNode ? { label: authoredNode.level === 2 ? 'Section' : 'Subsection',
        count: authoredChildren.filter(child => !child.section && !child.folded).length,
        addFirst: () => { void addWorkspaceSlide(currentSlideLine) } } : undefined}
      subslides={choicesFor(authoredNode, activeRow)}
      addSubslide={() => { void addWorkspaceSlide(currentSlideLine, true) }}
      subslide={paneNode ? { title: currentPaneParent?.title ?? '', thumb: activePaneThumb } : undefined}
      emptySlide={emptySlide} onTalkDetails={() => runRegisteredCommand('metadata')}
    />
  ) : (
    <div className="editor-column" data-view={textView}>
      <div className="pane pane--editor">
        <div className="editor-portal-slot" ref={attachEditorSlot} />
      </div>
    </div>
  )

  const activeStructureLine = markdownView ? (sourceCaretNode?.line ?? -1) + 1 || null
    : paneNode ? currentSlideLine : activeOutlineLine ?? currentSlideLine
  const selectedLines = selectedStructureLines()
  const groupReason = paneNode || selectedLines.length !== selection.count ? NONCONTIGUOUS
    : selection.count ? groupSectionReason(structure, selectedLines) : undefined
  const subsectionReason = (line: number | null) => subsectionOwner(structure, line) ? undefined : NO_SECTION
  const gridBatchSelection = gridMode && !pathwaysMode && !pathwayOrder
  const structureActions: StructureActions = {
    subsectionReason: subsectionReason(activeStructureLine),
    groupReason,
    count: selection.count,
    create: kind => runRegisteredCommand(kind === 'section' ? 'new-section' : 'new-subsection'),
    newSlide: () => runRegisteredCommand('new-slide'),
    group: () => runRegisteredCommand('make-section'),
    selectSeveral: () => runRegisteredCommand('select-several-slides'),
    levelUp: () => runRegisteredCommand('promote-heading'),
    levelUpReason: promoteHeadingReason ?? (markdownView && (editorPlace !== 'slide-heading' || sourceCaretNode?.level !== 3)
      ? 'Place the caret on a level-three slide heading.' : undefined),
    duplicate: () => { void duplicateStructureSelection() },
    delete: () => { void handleCutSlides(selection.indices.flatMap(index => {
      const ref = slideRefOf(index)
      return ref ? [ref] : []
    }), 'delete').then(ok => { if (ok) clearStructureSelection() }) },
    clear: clearStructureSelection
  }
  const addLine = (line: number | null, always?: boolean) => <StructureAddLine
    key={`${activeTalk.outlinePath}:${line}`}
    always={always} subsectionReason={subsectionReason(line)}
    onAdd={kind => { if (kind === 'slide') void addWorkspaceSlide(line); else void addStructure(kind, line) }}
  />
  function pickStructureIndex(index: number, event: React.MouseEvent, outlineLine?: number): void {
    if (event.shiftKey) selection.extendTo(index, activeSlide)
    else if (event.metaKey || event.ctrlKey || selectingSeveral) {
      if (selection.count === 0 && index !== activeSlide) selection.addMany([activeSlide, index])
      else selection.toggle(index)
    } else selection.reset(index)
    const clickedOutline = outlineLine !== undefined && !event.shiftKey && !event.metaKey && !event.ctrlKey && !selectingSeveral
    handleSelectSlide(index, clickedOutline ? outlineLine : undefined)
  }

  const toolbarButton = (id: PaletteCommandHandlerId, label: string, Glyph: typeof Plus, disabledReason?: string) => (
    <button type="button" className="tw-action-bar-btn workspace-edit-button" data-command={id} aria-label={label}
      title={disabledReason ?? label} disabled={!!disabledReason} onMouseDown={e => e.preventDefault()} onClick={() => runRegisteredCommand(id)}>
      <Glyph size={17} strokeWidth={1.75} aria-hidden /><span>{label}</span>
    </button>
  )
  const toolbarLead = (
    <div className="workspace-edit-controls">
      {toolbarButton('new-slide', 'New slide', Plus)}
      <StructureMenu actions={structureActions} />
      <span className="tw-action-bar-sep" />
      {toolbarButton('insert-object-table', 'Table', Table2, markdownInsertReason)}
      {toolbarButton('image', 'Picture', Image, markdownInsertReason)}
      {toolbarButton('icon-picker', 'Icon', SmilePlus, markdownInsertReason)}
      <ToolbarMenu icon="insert" label="Insert" iconOnly title="More to insert" items={toolbarItems('insert')} />
    </div>
  )
  const fixedItems = [...Object.keys(SLIDE_BAR_EDITS), 'promote-heading', 'demote-heading', ACTION_BAR_SEPARATOR, ...FORMAT_BAR_EDITS]
  const leadIds = new Set(['new-slide', 'image', 'icon-picker', 'insert-object-table', ...fixedItems])
  const editingSections = resolveActionBarItems(fixedItems, actionBarCommands)
  const extraSections = actionBarVisible
    ? actionBarSections.map(section => ({ ...section, items: section.items.filter(item => !leadIds.has(item.commandId)) })).filter(section => section.items.length)
    : []
  const workspaceEditBar = <ActionBar lead={toolbarLead} sections={[...editingSections, ...extraSections]} />

  function handleSelectSlide(i: number, outlineLine?: number): void {
    if (i !== activeSlideRef.current) afterTalkMetadata(() => selectSlide(i, outlineLine))
    else selectSlide(i, outlineLine)
  }

  function selectSlide(i: number, outlineLine?: number): void {
    setSelectedSubslide(null)
    activeSlideRef.current = i
    setActiveSlide(i)
    // Preview cards keep keyboard navigation. Clicking a source heading moves focus to the editor.
    const target = outlineLine ?? lineOfSlideIndex(i)
    activeLineReporter.report(target)
    revealSlideLine(target)
    if (target != null) setFocusLine({ line: target, takeFocus: outlineLine !== undefined, editTitle: markdownView })
  }

  selectSlideRef.current = handleSelectSlide

  function stepInspector(direction: -1 | 1): void {
    const index = activeSlideRef.current
    const next = scopeOnSlide && pathwayOrder
      ? pathwayOrder[pathwayOrder.indexOf(index) + direction]
      : navigateInspectorSlide(index, direction, compiledSlidesRef.current?.length ?? 0)
    if (next !== undefined) handleSelectSlide(next)
  }

  // Enter / double-click on a card: put the CARET in that slide's source, focused and ready
  // to type. The one deliberate contrast with handleSelectSlide (select + aim, never steal
  // focus): editing is an explicit act, so here the editor takes over. From the grid this
  // leaves grid mode (recording that Esc in the editor returns there); from a strip-only
  // pane it opens editor+slides, since editing needs the editor on screen.
  function handleEditSlide(i: number): void {
    afterTalkMetadata(() => editSlide(i))
  }

  function editSlide(i: number): void {
    selectSlide(i)
    const target = lineOfSlideIndex(i)
    if (gridModeRef.current) {
      setTextView('slide')
      returnToGridRef.current = target != null
      setGridMode(false)
      if (paneState === 'strip') setPaneState('both')
    } else if (paneState === 'strip') {
      setPaneState('both')
    }
    if (target != null) setFocusLine({ line: target, takeFocus: true })
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

  const structureInspectorRow = compiledSlides?.[activeSlide]
  const inspectorNode = outlineContent === compiledSourceRef.current
    ? structure.nodes.find(node => node.line + 1 === slideLines[activeSlide])
    : structure.nodes.find(node => node.id && node.id === currentCompiledSlideId)
  const inspectorLine = inspectorNode ? inspectorNode.line + 1 : null
  const inspectorSection = inspectorNode && inspectorNode.level > 2 && inspectorLine !== null
    ? subsectionOwner(structure, inspectorLine) : undefined
  const inspectorSubslides = choicesFor(inspectorNode, structureInspectorRow)
  const inspectorChildren = childrenOf(inspectorNode)
  const inspectorNodeIndex = inspectorNode ? structure.nodes.indexOf(inspectorNode) : -1
  const sectionCarousel = inspectorChildren.length > 1 && inspectorChildren.every(child =>
    child.ancestors.at(-1) === inspectorNodeIndex &&
    compiledSlides?.some(row => row.source_line === child.line + 1 && row.image_count > 0))
  const isSectionSlide = structureInspectorRow?.role === 'section-title' || structureInspectorRow?.role === 'subsection-title'
  const inspectorPane = (
    <div className="pane pane--inspector">
      <Inspector
        talk={activeTalk}
        compiledSlides={ownsOutline ? compiledSlides : null}
        outlineContent={ownsOutline ? outlineContent : ''}
        triggerFindings={triggerFindings}
        activeIndex={activeSlide}
        headingLine={inspectorLine}
        onPrev={() => stepInspector(-1)}
        onNext={() => stepInspector(1)}
        navigationShortcuts={navigationShortcuts}
        onEdit={() => handleEditSlide(activeSlide)}
        onExplain={() => setExplainIndex(activeSlide)}
        onOpenLayoutDoctor={() => runRegisteredCommand('layout-doctor')}
        onCaptureEmbed={captureEmbed}
        onSaveOffline={saveOffline}
        offlineSaving={offlineSaving}
        onRemoveSavedView={removeSavedView}
        videoMarkers={videoPanel}
        onCommitOption={applyInspectorOption}
        onBoardEdit={applyInspectorBoardEdit}
        long={slideTabView === 'list' && panelPage !== 'steps'}
        page={panelPage}
        onPageChange={page => setPanelOpened({ slide: currentCompiledSlideId, page })}
        centrePreview={!gridMode && paneState !== 'strip' && scopeOnSlide}
        layoutGallery={ownsOutline && activeRow && !paneNode ? {
          open: layoutGalleryOpen,
          target: layoutGalleryOpen ? layoutGalleryTarget : null,
          toggle: opener => {
            if (layoutGalleryOpen) {
              closeLayoutGallery()
              return
            }
            setPanelTry(null)
            if (!scopeOnSlide || focusOpen) showWorkspaceView('slide')
            setLayoutGallery({ path: activeTalk.outlinePath, index: activeSlide, opener })
          },
          close: closeLayoutGallery
        } : undefined}
        multiCount={selection.count}
        gridSelection={gridBatchSelection}
        preview={activePanelTry}
        applied={activePanelApplied?.label}
        onTry={previewPanelDesign}
        onKeep={keepPanelDesign}
        onUndo={undoPanelEdit}
        onIcon={applyPanelIcon}
        onCropPicture={(line, id) => {
          panelImageTarget.current = { path: activeTalk.outlinePath, base: outlineContent, line }
          imageMetaTalkRef.current = activeTalk.outlinePath
          setImageEditRequested(true); setImageMetaId(id)
        }}
        onReplacePicture={(line) => {
          replacingPanelImage.current = { path: activeTalk.outlinePath, base: outlineContent, line }
          openImageDrawer()
        }}
        onRemovePicture={(line) => changePanelSlide(outlineContent, text => {
          const next = editInlinePicture(text, line, null)
          if (next === null) throw Error('The picture moved.')
          return next
        }, 'Remove picture')}
        onCopy={openHandoff}
        onTalk={page => openTalkTab(page)}
        onMarkdown={() => runRegisteredCommand('view-markdown')}
        structure={inspectorNode && inspectorLine != null ? {
          section: !!isSectionSlide,
          hasSubslides: inspectorNode.container,
          childCount: inspectorChildren.length,
          carousel: sectionCarousel,
          panes: inspectorSubslides,
          addSubslide: () => { void addWorkspaceSlide(inspectorLine, true) },
          inheritedColour: inspectorSection ? {
            value: String(JSON.parse(inspectorSection.attrs)['section-colour'] ?? ''),
            selectSection: () => {
              const index = slideIndexAtLine(slideLines, inspectorSection.line + 1)
              if (index >= 0) handleSelectSlide(index)
            }
          } : undefined
        } : undefined}
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
        sidebarFollow={!!leftPreviewsHost && paneState !== 'strip'}
        compiledSlides={compiledSlides}
        outlineContent={outlineContent}
        triggerFindings={triggerFindings}
        thumbnails={thumbnails}
        activeIndex={activeSlide}
        onSelectSlide={handleSelectSlide}
        selection={selection}
        onPickStructure={pickStructureIndex}
        renderAddLine={index => {
          if (compiledSlides?.[index]?.slide_id === 'deck-title') return addLine(null)
          const line = lineOfSlideIndex(index)
          return line === null ? null : addLine(line)
        }}
        rowStructureItems={structureRowItems}
        onSubslideSelect={jumpToOutlineLine}
        onStructureMove={handleStructureDrop}
        structure={structure}
        slideOps={slideOps}
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

  function structureRowItems(line: number | null) {
    return [
      { action: 'new-slide-after', label: 'New slide after', run: () => { void addWorkspaceSlide(line) } },
      { action: 'new-section-after', label: 'New section after', run: () => { void addStructure('section', line) } },
      { action: 'new-subsection-after', label: 'New subsection after', disabled: subsectionReason(line),
        run: () => { void addStructure('subsection', line) } },
      { action: 'select-several', label: 'Select several…', run: () => {
        const i = line == null ? activeSlide : slideIndexAtLine(slideLines, line)
        setSelectingSeveral(true)
        selection.addMany([i])
      } }
    ] as const
  }
  const showPinnedPreview = !rightSidebarShown && !scopeOnSlide && focusSlide == null
  const pinnedUrl = activePaneThumb || (currentThumbKey && thumbnails?.[currentThumbKey])
  const pinnedTitle = plainInlineText(activeRow?.nav_title || activeRow?.title || '') || 'New slide'
  const pinnedCaption = paneNode ? paneNode.title : `Slide ${activeSlide + 1} · ${pinnedTitle}`
  const slidesPanel = <div className="tw-structure-panel">
      <SlidesOrganizer content={outlineContent} onJump={jumpToOutlineLine} ops={outlineOps}
        idlePreviews={slidesPanelView === 'previews' ? stripPane : undefined}
        currentLine={activeStructureLine} talkKey={activeTalk.outlinePath} talkTitle={activeTalk.title}
        structureRows={structure.nodes} dropStructure={structure} rowStructureItems={structureRowItems}
        cover={compiledSlides?.[0]?.slide_id === 'deck-title' ? plainInlineText(compiledSlides[0].title) : undefined}
        closing={compiledSlides?.at(-1)?.slide_id === 'deck-thanks' ? 'Closing' : undefined}
        currentGenerated={activeRow?.slide_id === 'deck-title' ? 'cover' : activeRow?.slide_id === 'deck-thanks' ? 'closing' : undefined}
        onGenerated={kind => handleSelectSlide(kind === 'cover' ? 0 : (compiledSlides?.length ?? 1) - 1)}
        selectedLines={selectedLines}
        onPickStructure={(line, event) => {
          const index = slideLines.indexOf(line)
          if (index < 0) { jumpToOutlineLine(line); return }
          pickStructureIndex(index, event, line)
        }}
        renderAddLine={addLine}
        onStructureMove={handleStructureDrop}
      />
      {slidesPanelView === 'outline' && showPinnedPreview && activeRow && <div className="tw-structure-pinned">
        <button type="button" className="tw-structure-preview-toggle"
          aria-label={`Current slide preview · ${pinnedCaption}`} aria-expanded={!outlinePreviewCollapsed} aria-controls={outlinePreviewId}
          title={outlinePreviewCollapsed ? 'Expand slide preview' : 'Collapse slide preview'}
          onClick={() => setOutlinePreviewCollapsed(collapsed => !collapsed)}>
          {outlinePreviewCollapsed ? <ChevronRight size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
          <span>{pinnedCaption}</span>
        </button>
        <div id={outlinePreviewId} hidden={outlinePreviewCollapsed}>
          {!outlinePreviewCollapsed && <div className="tw-structure-pinned-picture">
            {pinnedUrl
              ? <img src={pinnedUrl} draggable={false} alt="" />
              : <div className="tw-structure-pinned-placeholder">{pinnedTitle}</div>}
            {activeRow.reveal_enabled && <RevealPreviewBadge />}
          </div>}
        </div>
      </div>}
    {!(gridBatchSelection && selection.count >= 2) && <StructureFooter actions={structureActions} />}
  </div>

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
        onClose={() => closeTab('feedback')}
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
  // A marker on the slide pane: the Feedback tab of the sidebar, on that slide.
  function openFeedbackBeside(focus: Omit<FeedbackFocus, 'nonce'>): void {
    showTab('feedback')
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
    setFeedbackFocus(null) // from the toolbar: every item, not the last marker's slide
    if (railOpen) closeTab('feedback')
    else showTab('feedback')
  }

  const researchHostPane = <div className="pane pane--research" ref={setResearchHost} />
  const findPane = findPanelVisible && findMode !== null ? (
    <FindPanel key={activeTalk.outlinePath} mode={findMode} onMode={openFind} onClose={closeFind}
      images={{ currentTalkPath: activeTalk.outlinePath, onInsert: hit => insertDrawerImage(hit.thumbUrl),
        onInsertOldSlide: insertOldSlideAfterCurrent, currentSlide: activeSlide + 1 }}
      slides={{ talkPath: activeTalk.outlinePath, talkTitle: activeTalk.title ?? activeTalk.name,
        rows: ownsOutline ? compiledSlides : null, thumbnails, onSelect: handleSelectSlide }}
      onPickIcon={plainIcon.insertAtCaret} />
  ) : null
  // The tab's body (R11a). A tab whose reason is gone (the Guide closed, the share stopped) shows the Inspector.
  const talkPane = activeTalk && outlineOwner === activeTalk.outlinePath ? (
    <TalkTab
      key={activeTalk.outlinePath}
      talk={activeTalk}
      outlineContent={outlineContent}
      page={talkTabPage}
      onPage={changeTalkTabPage}
      metadata={talkMetadata}
      onCopy={openHandoff}
      onTry={preview => { if (preview) setPanelTry({ ...preview, base: outlineContent, path: activeTalk.outlinePath, index: activeSlide }); else setPanelTry(null) }}
      onMarkdown={() => runRegisteredCommand('view-markdown')}
      onAbstract={() => runRegisteredCommand('abstract')}
      onSaveDesign={edits => {
        const accepted = applyTalkMetadata(activeTalk.outlinePath, edits)
        if (!accepted) notify('Couldn’t apply those metadata changes. Try again.', 'warning')
        return accepted
      }}
    />
  ) : null
  const sidebarBody = columnTab === 'whats-new' ? whatsNewPane
    : columnTab === 'scratchpad' ? <div ref={setScratchDockHost} className="sp-dock-host" />
    : columnTab === 'talk' ? talkPane
    : columnTab === 'guide' ? guidePane
    : columnTab === 'research' ? researchHostPane
    : columnTab === 'find' ? findPane
    : columnTab === 'feedback' ? feedbackPane
    : inspectorPane
  const rightSidebar = <div className="pane pane--tabs" data-right-column>{tabsRow(true)}<div className="pane-tabs-body">{sidebarBody}</div></div>

  const gridPane = (
    <div className="pane pane--grid">
      <GridView
        key={JSON.stringify([activeTalk.outlinePath, talkOpening?.sequence])}
        slideOrder={pathwaysMode ? undefined : pathwayOrder}
        pathwayIds={pathwaysMode ? selectedPathway?.slideIds : undefined}
        onAddToPathway={pathwaysMode ? pathways.setAdding : undefined}
        onHasSelectionChange={pathwaysMode ? setHasPathwayGridSelection : undefined}
        searchOnDemand
        selection={pathwaysMode || pathwayOrder ? undefined : selection}
        onMakeSection={pathwaysMode || pathwayOrder ? undefined : structureActions.group}
        makeSectionReason={groupReason}
        rowStructureItems={structureRowItems}
        talk={activeTalk}
        compiledSlides={ownsOutline ? compiledSlides : null}
        triggerFindings={triggerFindings}
        thumbnails={thumbnails}
        onStructureDrop={pathwaysMode || pathwayOrder ? undefined : handleGridStructureDrop}
        structureSource={outlineContent}
        structureDropLabel={(line, side) => structureDrop(structure, line, side)?.label}
        previewsPending={previewsPending}
        activeIndex={openingTalk ? 0 : activeSlide}
        onSelectSlide={handleSelectSlide}
        onEdit={handleEditSlide}
        slideRefOf={slideRefOf}
        onMoveSlides={!pathwaysMode && pathwayOrder ? undefined : handleMoveSlides}
        onSetAsideSlides={handleSetAsideSlides}
        onScratchDrop={handleScratchDrop}
        onCutSlides={handleCutSlides}
        onCopySlides={handleCopySlides}
        onStepSlide={!pathwaysMode && pathwayOrder ? undefined : handleStepSlide}
        onExplain={(i) => setExplainIndex(i)}
        columns={gridColumns}
        slideOps={slideOps}
        lineOfSlide={lineOfSlideIndex}
        onPasteAfterCard={handlePasteAfterCard}
        onLanded={slideLanded}
        onMoreActions={(i, at) => { handleSelectSlide(i); openActionsHereRef.current({ region: 'strip', at }) }}
      />
    </div>
  )

  // The focused slide's compiled row supplies the crumb's section + title (authored case).
  const focusRow = focusSlide != null ? (compiledSlides?.[focusSlide] ?? null) : null

  // Status-bar dates (T29) for the active talk — hidden entirely until the talk's metadata has
  // loaded (no placeholder dashes); updates ride the shared facts store.
  const activeMeta = activeTalk ? talkFacts.meta[activeTalk.slug] : undefined
  const sketchFile = sketch.current?.path === activeTalk.outlinePath
    ? scratchpad.snapshot.items.find(item => item.file === sketch.current?.saved?.name) : undefined
  const sketchUse = sketchFile?.sketchUses && [...sketchFile.sketchUses].reverse().find(use => use.ids.some(id => headingLineForSlideId(outlineContent, id) != null))
  const sketchMenuItems = sketch.current ? scratchpad.snapshot.items.filter(item => item.fileKind === 'sketch' && !item.missing).map(item => {
    const used = item.sketchUses?.findLast(use => use.ids.length > 0)
    const usedSlideCount = used?.slideCount ?? (used ? readOutlineSlides(outlineContent).slides.filter(slide => slide.level >= 3 && used.ids.includes(slide.id)).length : undefined)
    return { ...item, usedSlideCount }
  }) : []
  const sketchUseDay = sketchUse && new Date(sketchUse.at).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })
  const addsSections = sketchStage?.review && reviewSlides(sketchStage.review).some(slide => !slide.aside && slide.section !== 0)
  const destinationSection = addsSections && sketchStage?.place
    ? scratchSectionPlace(outlineContent, sketchStage.place)?.title : null
  const sketchDestination = destinationSection ? `After the section “${destinationSection}”`
    : addsSections && sketchStage?.place?.kind === 'after' ? 'At the next section boundary'
    : sketchStage?.place?.kind === 'after' ? `After “${sketchStage.place.title}”` : 'After the title slide'
  const talkDates = activeTalk && activeMeta
    ? { createdMs: activeMeta.createdMs, editedMs: activeMeta.editedMs, deliveredMs: talkFacts.lastDelivered[activeTalk.slug] }
    : null

  return (
    <div className="workspace">
      {/* The reused Editor lives here permanently (reverse-portal); attachEditorSlot moves its DOM
          into whichever layout's slot is mounted. Rendering it unconditionally is what stops a
          remount when Focus opens/closes. */}
      {createPortal(editorElement, editorHostRef.current)}
      {leftPreviewsHost && paneState !== 'strip' && createPortal(slidesPanel, leftPreviewsHost)}
      {createPortal(<PathwaysView key={activeTalk.outlinePath} talk={activeTalk} model={pathways} thumbnails={thumbnails}
        docked={pathwaysMode} onBack={backFromPathways} canAddSelected={gridMode && hasPathwayGridSelection}
        onAddSelected={() => runRegisteredCommand('add-to-pathway')} />, leftPathwaysHost ?? document.body)}
      {publishProgress.text && (
        // Only Cancel takes pointer events. The rest of the app stays available during upload.
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
              Publishing… <span aria-hidden="true" style={{ color: 'var(--faint)', fontWeight: 500, fontFamily: 'var(--font-mono)' }}>{publishProgress.elapsed}s</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              {publishProgress.text}
            </div>
          </div>
          {publishProgress.canCancel && <button type="button" className="toolbar-btn" style={{ pointerEvents: 'auto', flexShrink: 0 }}
            disabled={publishProgress.cancelling} onClick={() => void publishProgress.cancel()}>Cancel publish</button>}
        </div>
      )}
      <div className="workspace-row">
      <div className="workspace-main">
      {focusSlide == null ? (
      <>
      <div ref={setToolbarEl} data-density={toolbarDensity} data-present={toolbarWidth !== null && toolbarWidth < TOOLBAR_PRESENT_LABEL_FROM_PX ? 'icon' : undefined} className="workspace-toolbar workspace-view-titlebar">
        <ToolbarMenu icon="design" label={plainTalkTitle(activeTalk.title)} title="Talk menu" items={toolbarItems('deck')} />
        {pathways.snapshot?.pathways.length ? (
          <div className="workspace-pathway-switch">
            <ToolbarMenu icon="slides" label={selectedPathway?.name ?? 'Full talk'} title={selectedPathway?.name ?? 'Full talk'}
              items={[
                { icon: 'slides', label: 'Full talk', checked: !selectedPathway, onClick: () => pathways.setPathwayId(null) },
                ...pathways.snapshot.pathways.map(pathway => ({
                  icon: 'slides' as const, label: pathway.name, checked: selectedPathway?.id === pathway.id,
                  onClick: () => pathways.setPathwayId(pathway.id)
                })),
                { icon: 'settings', label: 'Manage pathways…', separatorBefore: true, onClick: openPathways }
              ]} />
          </div>
        ) : (
          <button type="button" className="toolbar-btn workspace-pathway-add" aria-label="Add a pathway" disabled={!pathwaySourceReady || (!pathways.snapshot && !pathways.error)}
            onClick={() => { openPathways(); if (pathways.snapshot) pathways.setDialog({ kind: 'new', name: '' }) }}>
            <span className="toolbar-btn-content"><Icon name="insert" size={15} /><span>Pathway</span></span>
          </button>
        )}
        <EditorTabs mode={workspaceView}
          onChange={view => runRegisteredCommand(VIEW_COMMANDS[view])}
          shortcut={view => liveCommandShortcutLabel(COMMAND_REGISTRY.find(command => command.id === VIEW_COMMANDS[view])!)} />
        <button
          type="button"
          className={`pane-btn pane-btn--sidebar${rightSidebarShown ? ' pane-btn--active' : ''}`}
          onClick={() => runRegisteredCommand('toggle-inspector')}
          title={`${paneState === 'both' ? 'Hide' : 'Show'} the sidebar (${liveShortcutLabel('app.toggle-inspector')})`}
          aria-label="Sidebar"
          aria-pressed={paneState === 'both'}
          data-testid="sidebar-toggle"
        >
          <Icon name="pane-both" size={17} />
        </button>
        {gridMode && colsInline && (
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
        {gridMode && !colsInline && (
          <div className="grid-col-pop" style={{ position: 'relative' }}>
            <button type="button" className="pane-btn pane-btn--sidebar" aria-haspopup="true" aria-expanded={colsOpen} title="Grid columns" aria-label={`Grid columns: ${gridColumns}`} onClick={() => setColsOpen((v) => !v)}>
              <span className="grid-col-label">Cols</span>&nbsp;{gridColumns}
            </button>
            {colsOpen && (
              <div className="grid-col-selector" role="group" aria-label="Grid columns" style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 40, boxShadow: '0 8px 24px #17202a33' }}>
                {[1, 2, 3, 4, 5, 6].map((n) => (
                  <button key={n} type="button" className={`grid-col-btn ${gridColumns === n ? 'grid-col-btn--active' : ''}`} data-columns={n} aria-pressed={gridColumns === n} onClick={() => { setGridColumns(n); setColsOpen(false) }} title={`${n} column${n === 1 ? '' : 's'}`}>{n}</button>
                ))}
              </div>
            )}
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
              { icon: 'handout', label: COMMAND_REGISTRY.find(command => command.id === 'handout')!.toolbar!.menuLabel!, onClick: ran('handout', handleExportHandout) },
              { icon: 'html', label: 'HTML presentation (reveal in Finder)', onClick: ran('build', handleBuild) },
              { icon: 'publish', label: publishing ? 'Publishing…' : COMMAND_REGISTRY.find(command => command.id === 'publish-handout')!.toolbar!.menuLabel!, onClick: ran('publish-handout', requestPublishHandout), disabled: publishing },
              { icon: 'comment', label: 'Share for comments…', onClick: ran('share-for-comments', handleShareForComments), separatorBefore: true }
            ]}
          />
          <ToolbarMenu icon="more" label="Tools" iconOnly title="Studio, history, and app settings" items={toolbarItems('tools')} />
          <ToolbarMenu icon="present" label="Present" primary
            title={COMMAND_REGISTRY.find(command => command.id === 'present-from-here')!.label}
            defaultAction={() => runRegisteredCommand('present-from-here')} items={toolbarItems('present')} />
        </div>
      </div>

      {sketch.current ? <SketchView
        talkTitle={activeTalk.title} name={sketch.current.saved?.name ?? ''} detached={sketch.current.path !== activeTalk.outlinePath} frozen={sketch.frozen} text={sketch.current.text} error={sketch.current.error}
        sketches={sketchMenuItems} onRename={renameSketch}
        onChange={sketch.change} onOpen={name => void openSketch(name)} onCopyDraft={() => void sketch.saveAsNew()} onDiscard={sketch.discard} onSaveElsewhere={() => void sketch.saveElsewhere()}
        onBack={backFromSketch}
        used={sketchUseDay ? {
          day: sketchUseDay,
          show: () => {
            const first = sketchUse?.ids.find(id => headingLineForSlideId(outlineContentRef.current, id) != null)
            if (!first) return
            void sketch.close().then(ok => {
              if (!ok) return
              const index = compiledSlidesRef.current?.findIndex(row => row.slide_id === first) ?? -1
              showWorkspaceView('outline')
              if (index >= 0) handleSelectSlide(index)
            })
          },
        } : undefined}
        toolbar={sketch.current.path === activeTalk.outlinePath && <>
          <button className="tw-btn tw-btn--secondary" type="button" disabled={sketchApplying || (!sketch.current.saved && !sketch.current.text.trim())}
            onClick={() => void openScratchHandoff(sketchStage ? 'split' : 'sketch')}>Copy for agent</button>
          {!sketchStage && <button className="tw-btn tw-btn--primary" type="button" disabled={!sketch.current.text.trim()} onClick={() => void beginBreakdown()}>Break into slides</button>}
        </>}
      >
        {sketchStage && (sketchStage.review ? <SketchReview review={sketchStage.review}
          change={review => setSketchReview({ ...sketchStage, review, key: crypto.randomUUID() })} otherWays={() => setSketchReview({ ...sketchStage, review: null })}
          cancel={() => setSketchReview(null)} place={sketchDestination}
          add={() => void applySketch()} busy={sketchApplying}
        /> : <SketchBreakdowns text={sketchStage.text} pictures={sketchStage.pictures} choose={chooseSketchBreakdown} onBack={() => setSketchReview(null)} />)}
      </SketchView> : <div
        className={`workspace-panes workspace-panes--${gridMode ? 'grid' : paneState}${imageDropping ? ' workspace-panes--dropping' : ''}`}
        onDragOver={handleDrawerDragOver}
        onDragLeave={e => {
          const to = e.relatedTarget
          if (!(to instanceof Node) || !e.currentTarget.contains(to)) setImageDropping(null)
        }}
        onDrop={handleDrawerDrop}
      >
        {(() => {
          const centre = <div className="workspace-centre">{workspaceEditBar}
            {gridMode ? gridPane : paneState === 'strip' ? stripPane : editorColumn}
            {!gridMode && textView === 'outline' && outlineOwner === activeTalk.outlinePath && addLine(activeStructureLine, true)}
          </div>
          if (rightSidebarShown) return <ResizablePanes
            left={centre} right={rightSidebar} minRightPx={layoutPicker ? 400 : undefined}
            rightPx={{ storageKey: 'tw-right-width', initial: RIGHT_SIDEBAR_DEFAULT_PX }}
          />
          return centre
        })()}
        <DropHint kind={imageDropping} />
      </div>}
      <StatusBar
        workspace
        caretPath={textView === 'markdown' && !gridMode && activeRow ? [slidePlace, plainInlineText(activeRow.nav_title || activeRow.title)].filter(Boolean).join(' › ') : undefined}
        placeChip={placeChip}
        pillSlot={setPillHost}
        diskNotice={diskChangeChip}
        slideCount={compiledSlides?.length ?? null}
        wordCount={wordCount}
        lastSaved={lastSaved}
        dirty={dirty}
        compiling={compiling}
        buildStatus={buildStatus}
        buildPath={buildPath}
        buildErrorLabel={buildErrorLabel}
        publishIssue={publishIssue ? { diagnostic: publishIssue.diagnostic, onClick: () => setPublishDetails(true) } : null}
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
      {!sketch.current && <ScratchpadPanel
        key={`scratchpad:${activeTalk.outlinePath}`} data={scratchpad} layoutApi={scratchpadLayout}
        pillHost={pillHost} dockHost={scratchDockHost} onDock={dockScratchpad} onExpand={expandScratchpad} registerActions={registerScratchpadActions} onOpenSlideBrowser={() => setBrowserOpen(true)}
        insert={scratchInsertApi} outlineText={outlineContent}
        currentSlide={activeRow ? { title: plainInlineText(activeRow.title), markdown: currentSlideBlock()?.markdown ?? '' } : undefined}
        onCopyItem={item => openScratchHandoff('scratch', item)}
        onOpenSketch={(name, breakdown) => void openSketch(name, breakdown)}
      />}
      <ResearchPanel
        key={activeTalk.outlinePath} talkDir={activeTalk.path} panelOpen={researchPanelOpen} pickerOpen={researchPickerOpen}
        refresh={researchRefresh} host={researchHost} highlightedFile={researchHighlight} registerActions={registerResearchActions} onCommand={id => runRegisteredCommand(id as PaletteCommandHandlerId)}
        onClosePanel={() => { closeTab('research'); focusEditor() }} onClosePicker={() => { setResearchPickerOpen(false); focusEditor() }}
        onOpenPanel={() => { showTab('research'); setResearchPickerOpen(false) }}
        onCapture={drop => { researchCaptureDropRef.current = drop ?? null; runRegisteredCommand('research-capture') }} onRevealFolder={() => runRegisteredCommand('research-reveal-folder')}
        onInsert={async (item, slide) => { const reply = await window.tw.research.insert(item.file, slide); if (!reply.ok) notify(reply.error.message, 'warning', 'research-insert'); return reply.ok }} onJump={jumpToResearchUse}
      />
      </div>
      {handoff?.path === activeTalk.outlinePath && <CopyForAgentDialog key={handoff.aspect} aspect={handoff.aspect} prepare={() => prepareHandoff(handoff)} close={() => setHandoff(null)} />}
      {handoff?.path !== activeTalk.outlinePath && diskGuard.mergeReview && (reviewedSlide
        ? <SlideDiskReview key={diskGuard.mergeReview.generation} path={activeTalk.outlinePath} review={diskGuard.mergeReview} change={reviewedSlide}
          busy={diskGuard.busy} close={diskGuard.dismissMerge} keep={() => diskGuard.applyMerge(diskGuard.mergeReview!.generation, {})}
          putBack={() => diskGuard.applyMerge(diskGuard.mergeReview!.generation, {}, 'put-back')} />
        : <OutlineMergeSheet key={diskGuard.mergeReview.generation} review={diskGuard.mergeReview}
          busy={diskGuard.busy} onApply={() => diskGuard.applyMerge(diskGuard.mergeReview!.generation, {})} onDismiss={diskGuard.dismissMerge} />)}
      {handoff?.path !== activeTalk.outlinePath && diskGuard.slideReview &&
        <SlideMergeCards key={diskGuard.slideReview.generation} path={activeTalk.outlinePath} title={activeTalk.title}
          review={diskGuard.slideReview} busy={diskGuard.busy} saving={diskGuard.savingMerge} stale={diskGuard.slideReviewStale}
          error={diskGuard.slideReviewError} wholeTalk={diskGuard.slideReviewWholeTalk}
          onApply={diskGuard.applySlideReview} onDismiss={diskGuard.dismissMerge} onRefresh={diskGuard.refreshSlideReview} />}
      {talkMetadata.question && <TalkMetadataLeaveDialog fields={talkMetadata.question} answer={talkMetadata.answer} />}
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
        currentTalkTitle={activeTalk?.title ?? null}
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
        autoEdit={imageEditRequested}
        onUseCopy={async (id) => {
          const talk = activeTalkRef.current
          const oldId = imageMetaId
          if (!talk || !oldId || talk.outlinePath !== imageMetaTalkRef.current) return false
          const panelTarget = panelImageTarget.current
          if (panelTarget) {
            if (talk.outlinePath !== panelTarget.path) return false
            const applied = changePanelSlide(panelTarget.base, text => replaceEditedImageUse(text, oldId, id, panelTarget.line), 'Crop or mark up picture')
            if (applied) { panelImageTarget.current = null; setImageMetaId(null) }
            return applied
          }
          const at = plainIconToolsRef.current?.caret()
          const result = await applyOutlineMutation(talk.outlinePath, (text) => {
            return replaceEditedImageUse(text, oldId, id, at?.text === text ? at.line : undefined)
          }, { ownUndoStep: true })
          if (!result.ok) { notify('Place the cursor on the image to replace, or copy the new reference.', 'info', 'edit-image'); return false }
          setImageMetaId(null)
          return true
        }}
        outlinePath={activeTalk?.outlinePath ?? null}
        imageId={imageMetaId}
        vaultRoot={vaultRoot}
        onClose={() => { panelImageTarget.current = null; setImageMetaId(null) }}
      />
      <AbstractPanel
        talk={activeTalk}
        isOpen={abstractOpen}
        onClose={() => setAbstractOpen(false)}
      />
      <KeyboardHelp
        isOpen={helpOpen}
        onClose={() => setHelpOpen(false)}
        view={browserOpen ? 'slide-picker' : focusSlide != null ? 'slide-focus' : findPanelVisible && findMode === 'images' ? 'image-drawer' : pathwaysMode ? 'pathways' : undefined}
        place={place}
        placeRow={placeRow}
        quoteSlide={quoteSlideAtCaret}
        fileVideo={hasFileVideo}
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
                && read.lines[slide.start]?.replace(/\r$/, '') === row.source_markdown?.split('\n')[0]?.replace(/\r$/, ''))
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
      {publishDetails && publishIssue && <PublishDetailsSheet diagnostic={publishIssue.diagnostic} close={() => setPublishDetails(false)}
        retry={activeTalk.outlinePath === publishIssue.outlinePath ? () => void handlePublishHandout() : undefined} />}
      {publishNotReady && (
        <PublishNotReadySheet
          what="Publish handout"
          notReady={publishNotReady.warning}
          outlinePath={publishNotReady.outlinePath}
          onRetry={() => { if (activeTalkRef.current?.outlinePath === publishNotReady.outlinePath) void handlePublishHandout(); else notify('Select the original talk and publish again.', 'info') }}
          onRecheck={() => { if (activeTalkRef.current?.outlinePath === publishNotReady.outlinePath) void handlePublishHandout('recheck-media'); else notify('Select the original talk and publish again.', 'info') }}
          onPublishAnyway={() => { if (activeTalkRef.current?.outlinePath === publishNotReady.outlinePath) void handlePublishHandout(publishNotReady.warning.kind === 'media-warning' ? 'with-placeholders' : undefined); else notify('Select the original talk and publish again.', 'info') }}
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
          disabled: (command.id === 'previous-slide' || command.id === 'next-slide') && !slideNavigationActive ||
            command.id === 'go-to-line' && (!activeTalk || gridMode || paneState === 'strip') ||
            command.id === 'video-marker-add' && !hasFileVideo,
          group: command.taskGroup ?? undefined,
          subgroup: command.subgroup ?? undefined,
          keywords: command.palette.keywords,
          run: () => runListedCommand(command)
        }))}
      />
      <SlideRowMenus
        request={moveRequest}
        rows={moveRequest ? slideRows(editorReadRef.current?.()?.text ?? outlineContent) : []}
        ops={slideOps ? { ...slideOps, moveTo: (...args) => gridOutlineActionAllowed() ? slideOps.moveTo(...args) : null } : null}
        onClose={() => setMoveRequest(null)}
        onActed={() => { if (!gridModeRef.current && focusRegionRef.current === 'editor') focusEditor() }}
        onLanded={slideLanded}
      />
      {actionsHere && (
        <ActionsHerePanel
          x={actionsHere.x}
          y={actionsHere.y}
          rows={actionRowsAt(actionsHere.place, { quoteSlide: quoteSlideAtCaret, fileVideo: hasFileVideo })}
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
