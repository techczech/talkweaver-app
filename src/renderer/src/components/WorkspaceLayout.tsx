import { plainInlineText } from '../../../../compiler/scripts/lib/00-inline-render.mjs'
import { runActionBarEditorCommand } from './actionBar/command-runner'
import { venueScreenLinkFromOutline } from '../../../shared/venue-screen-link'
import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { createPortal } from 'react-dom'
import type { TalkInfo, ProjectionRow, RecordingSession } from '../../../preload/index'
import { textFitNotesFor } from '../../../shared/text-fit-notes.ts'
import { dismissToast, notify } from '../lib/notify'
import Editor, { type ObjectInsertHandler } from './Editor'
import SlideFocus from './SlideFocus'
import type { FocusRange } from '../extensions/focusScope'
import { focusRangeForSlideLine, firstFocusableFrom, nextFocusableSlide, readableSectionLabel } from './slideFocusModel'
import Inspector from './Inspector'
import { applyBoardEditToOutline, type BoardEdit } from '../../../../compiler/scripts/lib/board-slide.mjs'
import { applyRightAnswerToOutline } from '../../../../compiler/scripts/lib/prework.mjs'
import SlideStrip from './SlideStrip'
import GridView from './GridView'
import StatusBar from './StatusBar'
import { useTalkFacts } from '../lib/talkFacts'
import LayoutPickerColumn from './LayoutPickerColumn'
import { reanchorPickerSlide, selectionFromTriggerLine, toggleLayoutSelection, type LayoutPickerContext } from './layoutPickerModel'
import { LayoutVerbError, previewLayout, setLayout, type SlideRef } from '../../../shared/layout-verbs'
import { reportTriggerMergeWarnings } from '../../../shared/trigger-line'
import { readOutlineSlides } from '../../../shared/feedback-accept'
import { LAYOUTS, type LayoutDef, type OptionGroup } from '../data/layouts'
import SearchPalette from './SearchPalette'
import SlideBrowser from './SlideBrowser'
import PropagationChecklist, { type AdoptVersion } from './PropagationChecklist'
import MergeConfirm from './MergeConfirm'
import ShareSheet from './ShareSheet'
import PlanRunSheet from './PlanRunSheet'
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
import ArchiveImageSearch from './ArchiveImageSearch'
import IconPicker from './IconPicker'
import KeyboardHelp from './KeyboardHelp'
import ToolbarMenu, { Icon, type MenuItem } from './ToolbarMenu'
import ExplainPanel from './ExplainPanel'
import WhereUsedPanel from './WhereUsedPanel'
import EmbedCheckPanel from './EmbedCheckPanel'
import LayoutDoctorPanel from './LayoutDoctorPanel'
import ResizablePanes from './ResizablePanes'
import ImageMetaPanel from './ImageMetaPanel'
import AbstractPanel from './AbstractPanel'
import DeckDesignPanel from './DeckDesignPanel'
import CommandMenu, { type Command } from './CommandMenu'
import {
  paletteCommands,
  toolbarCommands,
  type PaletteCommandHandlerId,
  type ToolbarMenuName
} from '../../../shared/command-registry'
import { componentInsertEntries } from '../../../shared/layout-registry/entries'
import { liveCommandShortcutLabel, liveShortcutLabel, onKeymapChanged } from '../keymap/store'
import { surfaceKey } from '../keymap/surfaceKeys'
import type { PickerCommandOutcome, SlidePickerCommands } from './slidePickerCommands'
import ActionBar from './actionBar/ActionBar'
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
import { createOutlineMutator, type OutlineMutate, type OutlineMutationOptions, type OutlineMutationResult, type OutlineMutator } from '../lib/outlineMutation'
import { stampHandoutUrl } from '../../../shared/handout-stamp'
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

export type OutlineOps = {
  move: (line: number, dir: 'up' | 'down') => void
  reLevel: (line: number, dir: -1 | 1, withSubtree: boolean) => void
  moveTo: (fromLine: number, toLine: number) => void
}

// What a queued outline save answers (window.tw.talk.writeOutline).
type OutlineSaveResult = Awaited<ReturnType<typeof window.tw.talk.writeOutline>>

interface Props {
  activeTalk: TalkInfo | null
  vaultRoot: string
  // Lets App's left sidebar (Outline / Slides views) mirror the live outline and jump the
  // editor + strip to a source line.
  onOutlineChange?: (content: string) => void
  registerJump?: (fn: (line: number) => void) => void
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

// 1-based outline line for EACH compiled slide, aligned to the compiledSlides INDEX.
// The old version counted only `### ` lines, but compiledSlides also contains synthesized
// rows (cover, section-title dividers, closing) — so a content-slide count never matched the
// compiledSlides index and the editor↔strip sync highlighted the wrong card. Here we walk the
// compiled rows and the source headings together: a `### ` content row consumes the next
// level-3 heading, a section-title row consumes the next level-1/2 heading, synthesized rows
// (cover/closing) map to null. Returns lineForSlide[compiledIndex] = source line (or null).
function computeSlideLines(rows: ProjectionRow[] | null, content: string): (number | null)[] {
  const lines = content.split('\n')
  const headings: Array<{ line: number; level: number }> = []
  lines.forEach((t, i) => {
    const m = t.match(/^(#{1,6})\s/)
    if (m) headings.push({ line: i + 1, level: m[1].length })
  })
  // No compiler output yet → the fallback strip shows one card per `### ` heading in order.
  if (!rows) return headings.filter((h) => h.level === 3).map((h) => h.line)

  // PREFERRED: the engine stamps each slide's source line (ADR — no drift). Use it directly when
  // present; a synthesized cover/closing slide has null → the cover maps to the top of the file.
  if (rows.some((r) => typeof r.source_line === 'number')) {
    return rows.map((r, i) => (typeof r.source_line === 'number' ? r.source_line : i === 0 ? 1 : null))
  }

  // FALLBACK (older projections / non-markdown adapters): walk rows + headings together.
  let h = 0
  return rows.map((row, i) => {
    const isBlock = /^###\s/.test((row.source_markdown ?? '').trimStart())
    const isSection = row.role === 'section-title'
    if (isBlock) {
      // content slide ← next `### ` (level-3) heading
      while (h < headings.length && headings[h].level !== 3) h += 1
      const ln = h < headings.length ? headings[h].line : null
      if (h < headings.length) h += 1
      return ln
    }
    if (isSection) {
      // section divider ← next `## ` (level-2) heading (level-1 belongs to the title slide)
      while (h < headings.length && headings[h].level !== 2) h += 1
      const ln = h < headings.length ? headings[h].line : null
      if (h < headings.length) h += 1
      return ln
    }
    // The leading synthesized cover/title slide maps to the top of the file, so the cursor
    // in the frontmatter or on a `# ` (h1) heading jumps to the title slide.
    if (i === 0) return 1
    return null // closing / other synthesized rows have no source heading
  })
}

export default function WorkspaceLayout({ activeTalk, vaultRoot, onOutlineChange, registerJump, onOpenSettings, registerOutlineOps, onSelectTalk, onEditorEngaged, registerFlushSave, registerLeaveGuard, onDiscardTalk, onActiveLineChange }: Props) {
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
  const runRegisteredCommand = useCallback((handlerId: PaletteCommandHandlerId): void => {
    commandHandlersRef.current?.[handlerId]()
  }, [])
  const [paneState, setPaneState] = useState<PaneState>(readPaneState)
  const [inspectorMode, setInspectorMode] = useState<boolean>(readInspectorMode)
  // Grid mode is a distinct full-width view; any pane-toggle click clears it.
  const [gridMode, setGridMode] = useState<boolean>(false)
  const [gridColumns, setGridColumns] = useState<number>(readGridColumns)
  const [archiveOpen, setArchiveOpen] = useState<boolean>(false)
  const [iconPickerOpen, setIconPickerOpen] = useState<boolean>(false)
  const [outlineContent, setOutlineContent] = useState<string>('')
  const [compiledSlides, setCompiledSlides] = useState<ProjectionRow[] | null>(null)
  const [triggerFindings, setTriggerFindings] = useState<LayoutDoctorFinding[]>([])
  const [thumbnails, setThumbnails] = useState<Record<string, string> | null>(null)
  const compileTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [buildStatus, setBuildStatus] = useState<'idle' | 'building' | 'done' | 'error'>('idle')
  const [buildPath, setBuildPath] = useState<string | null>(null)
  // Publishing is a long, opaque wrangler deploy (no streamed progress) — show a prominent
  // blocking overlay with an elapsed-seconds ticker so it never looks hung.
  const [publishing, setPublishing] = useState<boolean>(false)
  // Share for comments (ticket 03): the sheet, and every shared talk (status bar chip).
  const [shareSheetOpen, setShareSheetOpen] = useState<boolean>(false)
  // The plan sheet (ADR-0032 point 5): a new Run (run null) or editing a planned one.
  const [planSheet, setPlanSheet] = useState<{ run: RecordingSession | null } | null>(null)
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
  const [slideMenu, setSlideMenu] = useState<{
    x: number
    y: number
    startAtFirst: boolean
    startAtAction?: SlideMenuAction
    withText: boolean
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
  const editorReplaceRef = useRef<((text: string, opts?: { save?: boolean }) => string | null) | null>(null)
  const editorReadRef = useRef<(() => { path: string; text: string; caret: number } | null) | null>(null)
  const editorLayoutContextRef = useRef<(() => LayoutPickerContext | null) | null>(null)
  const editorApplyLayoutRef = useRef<((initial: LayoutDef[], selected: LayoutDef[]) => void) | null>(null)
  const editorApplyOptionRef = useRef<((entry: LayoutDef | undefined, group: OptionGroup, token: string, headingLine?: number, slideId?: string | null) => string | null) | null>(null)
  // Editor-only commands (fold/unfold all + line-targeted outline ops) exposed to the command palette and Slides organizer.
  const editorCmdsRef = useRef<{
    foldAll: () => void; unfoldAll: () => void
    move: (line: number, dir: 'up' | 'down') => void
    reLevel: (line: number, dir: -1 | 1, withSubtree: boolean) => void
    moveTo: (fromLine: number, toLine: number) => void
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
    deleteSlide: () => void
    flushSave: () => Promise<void>
    scrollCursorIntoView: () => void
    cursorCoords: () => { x: number; y: number } | null
    placeCursorAtCoords: (x: number, y: number) => void
    cutSelection: () => void
    copySelection: () => void
    pasteClipboard: () => void
    runFormat: (id: 'bold' | 'italic' | 'inline-code' | 'highlight' | 'link') => void
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

  // Grid-reorder undo. The grid has no editor focus, so ⌘Z there cannot reach CodeMirror's history:
  // we keep our own stack of pre-reorder buffer snapshots; ⌘Z / ⌘⇧Z walk it while the grid is the
  // active view (each step goes back into the buffer through the D1 seam, handleReorder).
  const reorderUndoRef = useRef<string[]>([])
  const reorderRedoRef = useRef<string[]>([])
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
  useEffect(() => { slideLinesRef.current = slideLines }, [slideLines])

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
    if (entry) editorInsertRef.current?.(entry.snippet)
  }, [])

  const handleDeleteSlide = useCallback(() => {
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
      browserOpen || searchOpen || archiveOpen || iconPickerOpen || helpOpen ||
      cmdMenuOpen || abstractOpen || deckDesignOpen || embedCheckOpen || layoutDoctorOpen ||
      explainIndex != null || whereUsedId != null || imageMetaId != null ||
      adoptTarget != null || mergeRequest != null || tagSlide != null || slideMenu != null
  }, [
    browserOpen, searchOpen, archiveOpen, iconPickerOpen, helpOpen, cmdMenuOpen,
    abstractOpen, deckDesignOpen, embedCheckOpen, layoutDoctorOpen, explainIndex, whereUsedId, imageMetaId,
    adoptTarget, mergeRequest, tagSlide, slideMenu
  ])

  // Open the slide context menu anchored near the caret's slide: the editor's live cursor
  // coordinates (CodeMirror coordsAtPos) when the caret is in the viewport, else under the
  // toolbar — never nowhere.
  const openSlideMenu = useCallback((opts: {
    startAtFirst: boolean
    startAtAction?: SlideMenuAction
    withText: boolean
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
      withText: opts.withText
    })
  }, [])
  const openSlideMenuRef = useRef(openSlideMenu)
  useEffect(() => { openSlideMenuRef.current = openSlideMenu }, [openSlideMenu])

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
        apply: (path, next) => {
          const doc = editorReadRef.current?.()
          if (!doc || doc.path !== path) return null
          return editorReplaceRef.current?.(next, { save: true }) ?? null
        },
        adopt: (path, sent, saved) => {
          // The save stamped ids: adopt them only while the buffer is still what was sent (never
          // over newer typing; the next save stamps it again).
          const doc = editorReadRef.current?.()
          if (doc && doc.path === path && doc.text === sent) editorReplaceRef.current?.(saved)
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

  // Same for the cursor line: the other call sites are imperative (cursor moves), so a
  // freshly attached consumer would show no current-slide highlight until the next move.
  useEffect(() => {
    onActiveLineChange?.(slideLines[activeSlideRef.current] ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onActiveLineChange])

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
      if (request.kind === 'read') return mutator.readForMain(request.outlinePath)
      return mutator.applyFromMain(request.outlinePath, request.base, request.next, request.origin)
    })
  }, [])

  // Expose a jump-to-line to App: scroll/cursor the editor there AND sync the strip's active
  // card. Re-registered when the line→slide mapping changes so it always resolves correctly.
  useEffect(() => {
    registerJump?.((line: number) => {
      setFocusLine({ line, takeFocus: true })
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
        return
      }
      // ⌘Z / ⌘⇧Z route to undo/redo when focus is OUTSIDE the editor (grid / slides / strip), so a
      // reorder made there is undoable without clicking into the editor first. When typing IN the
      // editor, CodeMirror's own history handles it — skip so we don't double-undo. Two undo sources:
      // the GRID rewrites the file directly, so its moves walk our snapshot stack; everywhere else
      // (slides-outline ⌘-moves, etc.) goes through CodeMirror history.
      if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z') && !isTypingTarget(e.target)) {
        e.preventDefault()
        e.stopPropagation()
        if (gridModeRef.current) {
          const talk = activeTalkRef.current
          if (!talk) return
          const popFrom = e.shiftKey ? reorderRedoRef : reorderUndoRef
          const pushTo = e.shiftKey ? reorderUndoRef : reorderRedoRef
          const text = popFrom.current.pop()
          if (text == null) return // nothing left to undo/redo
          // Through the buffer (one-writer spec D1): one minimal change, saved through the queue, no
          // remount. The buffer it replaced goes on the other stack.
          void applyOutlineMutation(talk.outlinePath, () => text).then((result) => {
            if (result.ok || result.applied) { if (result.base != null) pushTo.current.push(result.base) }
            else { popFrom.current.push(text); notify(`Couldn’t undo the move — ${result.error}`, 'warning') }
          })
        } else if (e.shiftKey) editorCmdsRef.current?.redo()
        else editorCmdsRef.current?.undo()
        return
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
        return
      }
      // ⌘K = context menu for the FOCUSED item (freed by the Browser's move to ⌘S). Where the
      // keyboard is decides what opens: the Talks panel gets its row menu (talk or folder, exactly
      // as right-click would); the grid/strip gets the Explain panel for the active slide; the
      // EDITOR gets the slide context menu for the caret's slide (v0.15 stage 4), anchored at the
      // caret. Anywhere else — text fields outside CodeMirror, or with an overlay covering the
      // workspace — the key is NOT swallowed, so any other binding still sees it. preventDefault
      // only when we acted.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === 'k' || e.key === 'K')) {
        const overlayOpen = overlayOpenRef.current || focusSlideRef.current != null
        if (!overlayOpen) {
          const active = document.activeElement
          // Editor owns focus → the slide menu (first row highlighted — keyboard opening).
          // Deliberately BEFORE the isTypingTarget guard: CodeMirror is a typing target, but
          // an ordinary text INPUT outside it still falls through unswallowed.
          if (
            activeTalkRef.current &&
            e.target instanceof HTMLElement && e.target.closest('.cm-content') &&
            active instanceof HTMLElement && active.closest('.cm-content')
          ) {
            e.preventDefault()
            e.stopPropagation()
            openSlideMenuRef.current({ startAtFirst: true, withText: false })
            return
          }
          if (!isTypingTarget(e.target)) {
            if (active instanceof HTMLElement && active.closest('.tl-panel')) {
              e.preventDefault()
              e.stopPropagation()
              window.dispatchEvent(new Event('tw-context-menu'))
              return
            }
            if (activeTalkRef.current && gridModeRef.current) {
              e.preventDefault()
              e.stopPropagation()
              setExplainIndex(activeSlideRef.current)
              return
            }
          }
        }
        // fall through — not ours here
      }
      // ⌘I opens the ICON picker (pins a glyph to the caret's bullet); ⌘⇧I opens the old-PowerPoint
      // image search. Swapped 2026-06-23 (⌘⇧K was confusing for icons). Capture + stopPropagation so
      // the editor never also sees the keystroke. (Neither is a CodeMirror default.)
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === 'i' || e.key === 'I')) {
        e.preventDefault()
        e.stopPropagation()
        setIconPickerOpen((prev) => !prev)
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'i' || e.key === 'I')) {
        e.preventDefault()
        e.stopPropagation()
        setArchiveOpen((prev) => !prev)
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
        return
      }
      // ⌘⇧U opens the where-used & versions panel for the current slide (ADR-0032 ledger MVP). In Slide
      // Focus the where-used strip is already on-screen, so the panel is redundant — swallow it there.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'u' || e.key === 'U')) {
        e.preventDefault()
        e.stopPropagation()
        if (focusSlideRef.current != null) return
        openWhereUsed()
        return
      }
      // ⌘⇧F focuses the current slide (Slide Focus). ⌘F (no Shift) stays CodeMirror's find. No-op if
      // already in Focus. Uses refs (handler deps []).
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault()
        e.stopPropagation()
        if (focusSlideRef.current == null) enterFocusRef.current(activeSlideRef.current)
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
      if ((e.metaKey || e.ctrlKey) && e.key === '1') { e.preventDefault(); selectPane('editor') }
      if ((e.metaKey || e.ctrlKey) && e.key === '2') { e.preventDefault(); selectPane('both') }
      if ((e.metaKey || e.ctrlKey) && e.key === '3') { e.preventDefault(); selectPane('strip') }
      if ((e.metaKey || e.ctrlKey) && e.key === '4') { e.preventDefault(); selectGrid() }
    }
    window.addEventListener('keydown', handleGlobalKey, { capture: true })
    return () => window.removeEventListener('keydown', handleGlobalKey, { capture: true })
  }, [])

  useEffect(() => window.tw.app?.onCommand?.(runRegisteredCommand), [runRegisteredCommand])

  // Right-click inside the editing surface opens the slide context menu at the pointer — the
  // native menu is suppressed. The caret first moves to the clicked position, so "the current
  // slide" is the slide under the pointer (matching every native editor's contextual convention);
  // the cursor move re-syncs activeSlide via the editor's onCursorLine. Right-click openings add
  // the Text (cut/copy/paste) group and start with no row highlighted (mouse opening). In Slide
  // Focus or under an overlay we leave the event alone. useDismiss's arming fix means the very
  // contextmenu gesture that opens the menu cannot also dismiss it.
  useEffect(() => {
    function onContextMenu(e: MouseEvent): void {
      const t = e.target
      if (!(t instanceof HTMLElement) || !t.closest('.cm-content')) return
      if (!activeTalkRef.current) return
      if (overlayOpenRef.current || focusSlideRef.current != null) return
      e.preventDefault()
      e.stopPropagation()
      editorCmdsRef.current?.placeCursorAtCoords(e.clientX, e.clientY)
      openSlideMenuRef.current({ startAtFirst: false, withText: true, at: { x: e.clientX, y: e.clientY } })
    }
    window.addEventListener('contextmenu', onContextMenu, { capture: true })
    return () => window.removeEventListener('contextmenu', onContextMenu, { capture: true })
  }, [])

  // Slide context menu → the existing handlers, verbatim. The menu closes first; actions that
  // stay in the editor hand focus back so the keyboard flow is unbroken.
  function handleSlideMenuAction(action: SlideMenuAction): void {
    setSlideMenu(null)
    switch (action) {
      case 'layout': openLayoutPicker(); break
      case 'icon': setIconPickerOpen(true); break
      case 'image': setArchiveOpen(true); break
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
    setTriggerFindings([])
    setThumbnails(null)
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
    onActiveLineChange?.(null)
  }, [activeTalk?.outlinePath])

  // Debounced compile: fires 900ms after the last content change.
  // After a successful compile, also fetch thumbnails (fire-and-forget).
  useEffect(() => {
    if (!activeTalk || !outlineContent) return
    let cancelled = false
    const outlinePath = activeTalk.outlinePath
    if (compileTimer.current) clearTimeout(compileTimer.current)
    compileTimer.current = setTimeout(async () => {
      // setCompiling belongs INSIDE the timer: calling it per keystroke forced a full
      // WorkspaceLayout re-render on every character typed during the debounce window.
      setCompiling(true)
      const slides = await window.tw.talk.compile(outlinePath, outlineContent)
      if (cancelled) return
      // Surface a compile failure instead of silently showing the client-side fallback strip.
      if (slides === null) {
        notify('Couldn’t compile this talk — the html-presentations compiler wasn’t found or errored. Slides/previews won’t update.', 'error', 'compile-fail')
      } else {
        // The error toast is persistent — clear it once a compile succeeds again, so it can't
        // keep accusing a talk that has since recovered.
        dismissToast('compile-fail')
      }
      setCompiledSlides(slides)
      setTriggerFindings(slides === null
        ? []
        : attributeOrphanedTriggerFindings(outlineContent, slides, scanOutlineTriggers(outlineContent)))
      setCompiling(false)
      // Thumbnails: do not block the strip. A null map = the render couldn't run at all.
      window.tw.talk
        .thumbnails(outlinePath, outlineContent)
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
    }, 900)
    return () => {
      cancelled = true
      if (compileTimer.current) clearTimeout(compileTimer.current)
    }
  }, [outlineContent, activeTalk?.outlinePath])

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

  // Publish the handout to the user's Cloudflare Pages site (Settings → Publishing). The publisher
  // STAMPS handout_url into the outline. For the talk open here main stamps this window's BUFFER
  // (talk-writer.ts routes it through the D1 seam), never the file behind it; the stamp is then
  // adopted by stamping the buffer as it stands NOW (idempotent: a no-op when main's stamp landed),
  // so a stamp main could not apply — the buffer moved during the minutes-long deploy — still lands,
  // and newer typing is never replaced by the text the publish started from (one-writer spec D1).
  async function handlePublishHandout() {
    if (!activeTalk || !outlineContent) return
    if (blockedByUnresolved(outlineContent)) return
    const outlinePath = activeTalk.outlinePath
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
      } else {
        setBuildStatus('error')
        if (res?.display || res?.url) setBuildPath(res.display || res.url || null)
        console.warn('[publish-handout]', res?.error)
        notify('Publish failed: ' + (res?.error || 'unknown error'), 'error')
      }
    } finally {
      clearInterval(ticker)
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
    if (!activeTalk) return
    await window.tw.talk.clearThumbCache(activeTalk.slug, activeTalk.outlinePath)
    setThumbnails(null)
    setCompiledSlides(null)
    const slides = await window.tw.talk.compile(activeTalk.outlinePath, outlineContentRef.current)
    setCompiledSlides(slides)
    window.tw.talk
      .thumbnails(activeTalk.outlinePath, outlineContentRef.current)
      .then((m) => setThumbnails(m))
      .catch(() => setThumbnails(null))
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
    if ((res.converted ?? 0) > 0 && res.newContent) {
      const mb = ((res.savedBytes ?? 0) / 1048576).toFixed(1)
      const failNote = res.failed ? ` (${res.failed} couldn’t convert)` : ''
      notify(`Optimized ${res.converted} image${res.converted === 1 ? '' : 's'} to WebP — saved ${mb} MB${failNote}. Previews will rebuild faster.`, 'success', 'optimize')
    } else {
      notify('No PNG/JPG images to convert in this talk.', 'info', 'optimize')
    }
  }

  // OCR-index the vault images so search matches text inside images (native macOS Vision).
  async function handleOcrIndex() {
    notify('Indexing image text (OCR)…', 'info', 'ocr')
    const res = await window.tw.talk.ocrIndex()
    if (res?.success) notify(`Image text indexed — ${res.cached}/${res.total} images${res.added ? ` (+${res.added} new)` : ''}. Search now matches text in images.`, 'success', 'ocr')
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
    let idx = -1
    let best = -1
    for (let i = 0; i < slideLines.length; i++) {
      const ln = slideLines[i]
      if (ln != null && ln <= line && ln > best) {
        best = ln
        idx = i
      }
    }
    if (idx >= 0) {
      // Only notify the outline sidebar when the active SLIDE changes (not every keystroke).
      // activeSlideRef still holds the pre-update value here, so this is a genuine "changed" check.
      if (idx !== activeSlideRef.current) onActiveLineChange?.(slideLines[idx] ?? null)
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

  // Drag-reorder (one-writer spec D1): the compiler lib reorders the editor's BUFFER (not the file,
  // which lags the debounced autosave), the result goes into the buffer as one minimal change —
  // recorded in CM history like ⌘⇧↑/↓ moves, caret kept, no remount — and that buffer is saved
  // through the queue. The old remount path re-read the file before the reorder's own write landed
  // and wiped the undo history.
  async function handleReorder(from: number, to: number) {
    const talk = activeTalkRef.current
    if (!talk) return
    const result = await applyOutlineMutation(talk.outlinePath, async (text) =>
      (await window.tw.outline.reorder(talk.outlinePath, from, to, text)) ?? text) // null: not a possible move
    const moved = result.ok ? result.changed : result.applied
    if (moved && result.base != null) {
      // Snapshot the pre-reorder buffer for the GRID-mode ⌘Z stack (no editor focus there); a fresh
      // move invalidates any redo. In "both" view the CM history is the undo authority.
      reorderUndoRef.current.push(result.base)
      if (reorderUndoRef.current.length > 50) reorderUndoRef.current.shift()
      reorderRedoRef.current = []
    }
    if (!result.ok && !result.applied) notify(`Couldn’t move the slide — ${result.error}`, 'warning')
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

  // Archive image insert (ADR-0019 archive reuse). ArchiveImageSearch already copied the chosen
  // archive image into the current vault's _assets (content-addressed) and resolved its id; we
  // splice `![](img-<id>)` at the live caret, like the cross-talk insert.
  async function handleArchiveInsert(imgId: string) {
    if (!activeTalkRef.current) return
    // importImage already returns a full `img-<hash>` id — do NOT re-prefix (that produced
    // the `img-img-…` refs that the inline-image widget regex could not match).
    const id = imgId.startsWith('img-') ? imgId : `img-${imgId}`
    await insertAtCaretAndSave(`![](${id})`)
  }

  // Icon pick (ADR-0021). The IconPicker resolved a glyph key; we pin it to the caret's current
  // top-level list bullet. The editor's registered reader gives us {heading, occurrence, itemIndex}
  // for the live caret; main's setListItemIcon rewrites the BUFFER's text (the D1 seam reads it from
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
      const next = await window.tw.outline.setItemIcon(text, ctx.slideHeading, ctx.slideOccurrence, ctx.itemIndex, iconKey)
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
  const runPickerCommand = (run: (commands: SlidePickerCommands) => PickerCommandOutcome): void => {
    const commands = pickerCommandsRef.current
    if (!browserOpenRef.current || !commands) {
      notify(`Open the slide picker (${liveShortcutLabel('app.slide-search')}) first.`, 'info', 'picker-command')
      return
    }
    const outcome = run(commands)
    if (outcome !== true) notify(outcome, 'info', 'picker-command')
  }

  // Every generated palette, native-menu, and toolbar item reaches renderer behaviour through
  // this typed handler map. It is assigned before the empty-state return because the Talk-free
  // Tools menu uses the same registered commands.
  commandHandlersRef.current = {
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
    'where-used': openWhereUsed,
    'focus-slide': () => enterFocus(activeSlideRef.current),
    'toggle-inspector': toggleInspector,
    studio: () => window.dispatchEvent(new Event('tw-open-studio')),
    history: () => window.dispatchEvent(new Event('tw-open-history')),
    importer: () => window.dispatchEvent(new Event('tw-open-importer')),
    // With no talk open the sheet cannot name a talk: open History, whose sheet has the talk picker.
    'plan-run': () => {
      if (activeTalkRef.current) setPlanSheet({ run: null })
      else void window.tw.tools.open('history', 'plan-run')
    },
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
    'publish-handout': () => { void handlePublishHandout() },
    'share-for-comments': () => handleShareForComments(),
    'copy-venue-screen-link': () => { void handleCopyVenueScreenLink() },
    layout: openLayoutPicker,
    image: () => setArchiveOpen(true),
    search: () => setBrowserOpen(true),
    'find-talk': () => {
      pickerCommandsRef.current?.focusFindTalk()
      if (!browserOpenRef.current) setBrowserOpen(true)
    },
    'add-talk-beside': () => runPickerCommand((picker) => picker.addTalkBeside()),
    'talk-beside': () => runPickerCommand((picker) => picker.talkBeside()),
    'close-talk-beside': () => runPickerCommand((picker) => picker.closeTalkBeside()),
    'select-whole-section': () => runPickerCommand((picker) => picker.selectWholeSection()),
    'icon-picker': () => setIconPickerOpen(true),
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
    'format-bold': () => editorCmdsRef.current?.runFormat('bold'),
    'format-italic': () => editorCmdsRef.current?.runFormat('italic'),
    'format-inline-code': () => editorCmdsRef.current?.runFormat('inline-code'),
    'format-highlight': () => editorCmdsRef.current?.runFormat('highlight'),
    'format-link': () => editorCmdsRef.current?.runFormat('link'),
    'deck-design': () => setDeckDesignOpen(true),
    metadata: () => window.dispatchEvent(new Event('tw-open-metadata')),
    'tag-slide': openTagCurrentSlide,
    abstract: () => setAbstractOpen(true),
    'view-editor': () => selectPane('editor'),
    'view-both': () => selectPane('both'),
    'view-strip': () => selectPane('strip'),
    'view-grid': selectGrid,
    'fold-all': () => editorCmdsRef.current?.foldAll(),
    'unfold-all': () => editorCmdsRef.current?.unfoldAll(),
    'normalize-triggers': () => editorCmdsRef.current?.normalizeTriggers(),
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
    'app.command-palette': () => setCmdMenuOpen(prev => !prev)
  }

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
    return editorApplyOptionRef.current?.(entry, group, token, targetHeadingLine, targetSlideId) ?? null
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
  // Ticket 08: the Quick check's right answer is a `{right}` marker on one option's list item — a
  // body edit, made like a Board edit (the editor's own buffer, the slide found by its id, one
  // undoable change).
  function applyInspectorRightAnswer(optionIndex: number): boolean {
    const doc = editorReadRef.current?.()
    if (!doc) return false
    const headingLine = headingLineForSlideId(doc.text, inspectedSlideIdRef.current)
    if (headingLine == null) return false
    const next = applyRightAnswerToOutline(doc.text, headingLine, optionIndex)
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
    registerOutlineOps?.({ move: cmds.move, reLevel: cmds.reLevel, moveTo: cmds.moveTo })
  }, [registerOutlineOps])


  if (!activeTalk) {
    return (
      <div className="workspace">
        <div className="workspace-toolbar">
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
        <div className="workspace-empty">
          <div className="workspace-empty-hint">
            Select a Talk from the list to start editing
          </div>
        </div>
        <StatusBar minimal />
        <KeyboardHelp isOpen={helpOpen} onClose={() => setHelpOpen(false)} />
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
      key={editorKey}
      talk={activeTalk}
      content={outlineContent}
      onContentChange={setOutlineContent}
      onSaved={handleEditorSaved}
      onDirty={setDirty}
      vaultRoot={vaultRoot}
      focusRange={focusRange}
      textFitNotes={textFitNotes}
      registerLayoutContext={(fn) => { editorLayoutContextRef.current = fn }}
      registerApplyLayout={(fn) => { editorApplyLayoutRef.current = fn }}
      registerApplyOption={(fn) => { editorApplyOptionRef.current = fn }}
      focusLine={focusLine}
      onCursorLine={handleCursorLine}
      onImageWidgetClick={(id) => setImageMetaId(id)}
      onOpenHelp={() => setHelpOpen(true)}
      registerInsert={(fn) => { editorInsertRef.current = fn }}
      registerInsertObject={(fn) => { editorInsertObjectRef.current = fn }}
      onEditorEngaged={onEditorEngaged}
      onOpenObjectLayoutFamily={(kind) => openLayoutPicker(kind === 'diagram' ? 'smartart' : kind)}
      onInsertObjectMenu={(coords) => openSlideMenu({
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
      {actionBarVisible && <ActionBar sections={actionBarSections} />}
      <div className="pane pane--editor">
        <div className="editor-portal-slot" ref={attachEditorSlot} />
      </div>
    </div>
  )

  function handleSelectSlide(i: number): void {
    setActiveSlide(i)
    // Keep the Slide-outline sidebar in sync with strip/grid picks. handleCursorLine's own notify is
    // gated on the active slide CHANGING, but we've just set it to `i` here, so the cursor-sync that
    // follows would see no change and skip the outline — notify directly instead.
    onActiveLineChange?.(slideLines[i] ?? null)
    const target = slideLines[i]
    // Card click: aim the editor viewport but do NOT steal focus — the strip keeps keyboard nav.
    if (target != null) setFocusLine({ line: target, takeFocus: false })
  }

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
    onActiveLineChange?.(slideLines[i] ?? null)
    const target = slideLines[i]
    if (target == null) return
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
    setFocusLine({ line, takeFocus: true })
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
        onRightAnswer={applyInspectorRightAnswer}
        onPlanRun={(run) => setPlanSheet({ run })}
        onInspectSlideId={(slideId) => {
          const index = compiledSlides?.findIndex((row) => row.slide_id === slideId) ?? -1
          if (index >= 0) handleSelectInspectorSlide(index)
        }}
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
        onReorder={handleReorder}
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

  const stripSurface = railOpen
    ? (railWithStrip ? <div className="pane pane--strip-rail">{stripPane}{feedbackPane}</div> : feedbackPane)
    : inspectorMode ? inspectorPane : stripPane

  const gridPane = (
    <div className="pane pane--grid">
      <GridView
        talk={activeTalk}
        compiledSlides={compiledSlides}
        triggerFindings={triggerFindings}
        thumbnails={thumbnails}
        activeIndex={activeSlide}
        onSelectSlide={handleSelectSlide}
        onEdit={handleEditSlide}
        onReorder={handleReorder}
        onExplain={(i) => setExplainIndex(i)}
        columns={gridColumns}
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
      {focusSlide == null ? (
      <>
      <div className="workspace-toolbar">
        <span className="workspace-title">{activeTalk.title}</span>
        <div className="pane-toggle">
          <button
            className={`pane-btn ${!gridMode && paneState === 'editor' ? 'pane-btn--active' : ''}`}
            onClick={() => selectPane('editor')}
            title="Editor only"
          >
            <Icon name="pane-editor" size={17} />
          </button>
          <button
            className={`pane-btn ${!gridMode && paneState === 'both' ? 'pane-btn--active' : ''}`}
            onClick={() => selectPane('both')}
            title="Editor + slide strip"
          >
            <Icon name="pane-both" size={17} />
          </button>
          <button
            className={`pane-btn ${!gridMode && paneState === 'strip' ? 'pane-btn--active' : ''}`}
            onClick={() => selectPane('strip')}
            title="Slide strip only"
          >
            <Icon name="pane-strip" size={17} />
          </button>
          <button
            className={`pane-btn ${gridMode ? 'pane-btn--active' : ''}`}
            onClick={() => setGridMode(true)}
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
              { icon: 'handout', label: 'Handout (reveal in Finder)', onClick: handleExportHandout },
              { icon: 'html', label: 'HTML presentation (reveal in Finder)', onClick: handleBuild },
              { icon: 'publish', label: 'Publish to Cloudflare', onClick: handlePublishHandout },
              { icon: 'comment', label: 'Share for comments…', onClick: handleShareForComments, separatorBefore: true }
            ]}
          />
          <ToolbarMenu
            icon="insert"
            label="Insert"
            title="Insert content into the current slide"
            items={toolbarItems('insert')}
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
      <div className={`workspace-panes workspace-panes--${gridMode ? 'grid' : paneState}`}>
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
      </div>
      <StatusBar
        slideCount={compiledSlides?.length ?? null}
        wordCount={wordCount}
        lastSaved={lastSaved}
        dirty={dirty}
        compiling={compiling}
        buildStatus={buildStatus}
        buildPath={buildPath}
        dates={talkDates}
        runChips={activeTalk ? (
          <>
            {activeConflicts > 0 && <ConflictLine talk={{ ...activeTalk, conflicts: activeConflicts }} className="tw-status-conflict" />}
            <RunStatusChips talk={activeTalk} outlineContent={outlineContent} onPlan={(run) => setPlanSheet({ run })} />
          </>
        ) : null}
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
      {archiveOpen && (
        // Wrapper carries the class + data hook the e2e harness targets to find the
        // archive palette and its input (the component itself styles inline). React
        // portals the modal to document.body? No — it renders inline, so the wrapper
        // contains it and selectors like `.archive-image-search input` resolve.
        <div className="archive-image-search" data-archive-search>
          <ArchiveImageSearch
            isOpen={archiveOpen}
            onClose={() => { setArchiveOpen(false); focusEditor() }}
            onInsertImage={handleArchiveInsert}
          />
        </div>
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
      />
      <ExplainPanel
        isOpen={explainIndex != null}
        onClose={() => setExplainIndex(null)}
        outlinePath={activeTalk.outlinePath}
        content={outlineContent}
        index={explainIndex}
      />
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
          talk={{ slug: activeTalk.slug, title: activeTalk.title || activeTalk.slug, outlinePath: activeTalk.outlinePath }}
          run={planSheet.run}
          onClose={() => setPlanSheet(null)}
          onSaved={() => setPlanSheet(null)}
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
        onClose={() => setCmdMenuOpen(false)}
        commands={paletteCommands()
          // Palette-hidden commands ("All commands…" opens the palette; it must not list itself).
          .filter((command) => command.palette.visible)
          .map((command): Command => ({
          id: command.id,
          title: command.label,
          hint: liveCommandShortcutLabel(command),
          keywords: command.palette.keywords,
          run: () => runRegisteredCommand(command.handlerId)
        }))}
      />
      {slideMenu && (
        <SlideContextMenu
          x={slideMenu.x}
          y={slideMenu.y}
          startAtFirst={slideMenu.startAtFirst}
          startAtAction={slideMenu.startAtAction}
          withText={slideMenu.withText}
          onAction={handleSlideMenuAction}
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
