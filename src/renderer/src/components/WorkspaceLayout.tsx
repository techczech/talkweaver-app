import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { createPortal } from 'react-dom'
import type { TalkInfo, ProjectionRow } from '../../../preload/index'
import { dismissToast, notify } from '../lib/notify'
import Editor from './Editor'
import SlideFocus from './SlideFocus'
import type { FocusRange } from '../extensions/focusScope'
import { focusRangeForSlideLine, firstFocusableFrom, nextFocusableSlide, readableSectionLabel } from './slideFocusModel'
import Inspector from './Inspector'
import SlideStrip from './SlideStrip'
import GridView from './GridView'
import StatusBar from './StatusBar'
import CommandPalette from './CommandPalette'
import { selectionFromTriggerLine, toggleLayoutSelection, type LayoutPickerContext } from './layoutPickerModel'
import { LAYOUTS, type LayoutDef, type OptionGroup } from '../data/layouts'
import SearchPalette from './SearchPalette'
import SlideBrowser from './SlideBrowser'
import PropagationChecklist, { type AdoptVersion } from './PropagationChecklist'
import MergeConfirm from './MergeConfirm'
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
import ResizablePanes from './ResizablePanes'
import ImageMetaPanel from './ImageMetaPanel'
import AbstractPanel from './AbstractPanel'
import DeckDesignPanel from './DeckDesignPanel'
import CommandMenu, { type Command } from './CommandMenu'
import {
  commandShortcutLabel,
  paletteCommands,
  toolbarCommands,
  type PaletteCommandHandlerId,
  type ToolbarMenuName
} from '../../../shared/command-registry'
import SlideContextMenu, { type SlideMenuAction } from './SlideContextMenu'
import type { CursorListItemContext } from '../extensions/outliner'
import {
  applyInspectorOptionToOutline,
  headingLineForSlideId,
  inspectedSlideIdAfterCursorChange,
  migrateInspectorMode,
  migratePaneState,
  navigateInspectorSlide,
  resolveInspectedSlide,
  type PaneState
} from './inspectorModel'

export type OutlineOps = {
  move: (line: number, dir: 'up' | 'down') => void
  reLevel: (line: number, dir: -1 | 1, withSubtree: boolean) => void
  moveTo: (fromLine: number, toLine: number) => void
}

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
  /** Hand App a "flush the current editor's pending edit" fn. App calls it BEFORE a genuine talk
   *  switch so a sub-1.5s edit made just before switching is persisted to the OUTGOING talk's file
   *  (data-loss guard, 2026-07-05). No-op when nothing is pending. */
  registerFlushSave?: (fn: () => Promise<void>) => void
  /** Hand App an "adopt this outline text into the live editor buffer" fn (the publish-handout
   *  adoption pattern). The Metadata panel writes the active talk's frontmatter on DISK; without
   *  adoption the editor's stale buffer would clobber that write on its next autosave. */
  registerAdoptOutline?: (fn: (content: string) => void) => void
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
const INSPECTOR_AUTOSAVE_MS = 1500

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

export default function WorkspaceLayout({ activeTalk, vaultRoot, onOutlineChange, registerJump, onOpenSettings, registerOutlineOps, onSelectTalk, registerFlushSave, registerAdoptOutline, onActiveLineChange }: Props) {
  const commandHandlersRef = useRef<Record<PaletteCommandHandlerId, () => void> | null>(null)
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
  const [thumbnails, setThumbnails] = useState<Record<string, string> | null>(null)
  const compileTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inspectorSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [buildStatus, setBuildStatus] = useState<'idle' | 'building' | 'done' | 'error'>('idle')
  const [buildPath, setBuildPath] = useState<string | null>(null)
  // Publishing is a long, opaque wrangler deploy (no streamed progress) — show a prominent
  // blocking overlay with an elapsed-seconds ticker so it never looks hung.
  const [publishing, setPublishing] = useState<boolean>(false)
  const [publishElapsed, setPublishElapsed] = useState<number>(0)
  const [wordCount, setWordCount] = useState<number>(0)
  const [lastSaved, setLastSaved] = useState<Date | null>(null)
  // Unsaved-edit indicator: set by the Editor on real user edits, cleared only by a REAL save —
  // a refused or failed write leaves it standing, so save health is visible at a glance.
  const [dirty, setDirty] = useState(false)
  const [compiling, setCompiling] = useState<boolean>(false)
  const [paletteOpen, setPaletteOpen] = useState<boolean>(false)
  const [paletteQuery, setPaletteQuery] = useState<string>('')
  const [paletteContext, setPaletteContext] = useState<LayoutPickerContext | null>(null)
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
  // The editor's slide context menu (v0.15 stage 4): ⌘K with the editor focused, or right-click
  // inside .cm-content. startAtFirst mirrors the Talks-panel convention (⌘K highlights the first
  // row, right-click starts blank); withText adds the cut/copy/paste group on right-click only.
  const [slideMenu, setSlideMenu] = useState<{ x: number; y: number; startAtFirst: boolean; withText: boolean } | null>(null)

  // Strip ↔ editor sync + reorder/insert plumbing
  const [activeSlide, setActiveSlide] = useState<number>(0)
  const [inspectedSlideId, setInspectedSlideId] = useState<string | null>(null)
  // takeFocus distinguishes deliberate "go edit this" jumps (outline sidebar, deck ⌘E — the caret
  // should land in the editor) from strip/grid card CLICKS, which only aim the editor's viewport:
  // stealing focus there killed the strip's own arrow-key navigation for mouse users.
  const [focusLine, setFocusLine] = useState<{ line: number; takeFocus: boolean } | null>(null)
  const [reorderNonce, setReorderNonce] = useState<number>(0)
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
  // Replaces the whole doc in place, preserving caret + scroll (icon pin → no jump-to-top).
  const editorReplaceRef = useRef<((text: string) => void) | null>(null)
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
    normalizeTriggers: () => void
    deleteSlide: () => void
    flushSave: () => Promise<void>
    scrollCursorIntoView: () => void
    cursorCoords: () => { x: number; y: number } | null
    placeCursorAtCoords: (x: number, y: number) => void
    cutSelection: () => void
    copySelection: () => void
    pasteClipboard: () => void
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
  // Mirror browserOpen so the (deps-[]) global key handler can tell whether the Browser is
  // already open — ⌘S then re-focuses the search field rather than toggling the overlay closed.
  const browserOpenRef = useRef(browserOpen)
  useEffect(() => { browserOpenRef.current = browserOpen }, [browserOpen])
  // The Browser registers a "focus + select the search field" fn here (registerFocusSearch);
  // ⌘S calls it when the Browser is already open.
  const browserFocusSearchRef = useRef<(() => void) | null>(null)
  // True while ANY overlay covers the workspace — the ⌘K/right-click slide menu must never
  // open (or swallow the key) underneath one. Synced by an effect below (after the overlay
  // states are all declared); read by the deps-[] global key handler.
  const overlayOpenRef = useRef(false)

  // Grid-reorder undo. A grid drag rewrites the outline file directly (handleReorder) — it never
  // dispatches through CodeMirror, so the editor's own history can't undo it. We keep our own
  // stack of pre-reorder outline snapshots; ⌘Z / ⌘⇧Z walk it while the grid is the active view.
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
  const inspectedSlideIndexRef = useRef(0)
  const inspectedSlideIndex = resolveInspectedSlide(
    compiledSlides,
    inspectedSlideId,
    inspectedSlideIndexRef.current
  ).index
  const slideLinesRef = useRef<(number | null)[]>(slideLines)
  useEffect(() => { slideLinesRef.current = slideLines }, [slideLines])

  // The Inspector owns its navigation while open. Recompiles may insert, remove, or reorder rows,
  // so its index is always recovered from the stable deep-link id. Only a vanished id falls back
  // to the previous (clamped) position.
  useEffect(() => {
    if (!inspectorMode) return
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
  const handleDeleteSlide = useCallback(() => {
    editorCmdsRef.current?.deleteSlide()
    if (focusSlideRef.current != null) exitFocus()
  }, [exitFocus])

  // The Browser's ↵ no longer reaches the workspace at all (v0.15.x): it opens the Browser's
  // own insert-decision viewer. The old cross-talk pendingFocus flow — which silently switched
  // activeTalk under the editor — is deliberately gone.

  // Detach (B3): flush the pending autosave FIRST (else the engine reads a stale on-disk copy — the
  // progress ledger flagged this race), then ledger.detach, apply the re-id'd text in place, toast.
  async function handleDetach(ref: { heading: string; occurrence: number }): Promise<boolean> {
    const talk = activeTalkRef.current
    if (!talk) return false
    await editorCmdsRef.current?.flushSave()
    const res = await window.tw.ledger.detach(talk.outlinePath, outlineContentRef.current, ref)
    if (!res) { notify('Couldn’t detach this slide — the ledger didn’t return a result.', 'error'); return false }
    if (editorReplaceRef.current) editorReplaceRef.current(res.text)
    else { setOutlineContent(res.text); setReorderNonce((n) => n + 1) }
    setLastSaved(new Date())
    notify(`Detached — new id {id=${res.newId}}`, 'success')
    return true
  }

  // ── Slide tags (ADR-0037) ────────────────────────────────────────────────────
  // Browser tag writes: flush the active talk's pending autosave BEFORE a tags:apply that
  // targets it (the detach/adopt flush rule), and re-read + adopt the rewritten text AFTER
  // (handleAdopted pattern) so the next autosave can't clobber the tag write.
  const flushBeforeTagWrite = useCallback(async (outlinePaths: string[]) => {
    const talk = activeTalkRef.current
    if (talk && outlinePaths.includes(talk.outlinePath)) await editorCmdsRef.current?.flushSave()
  }, [])
  const handleTagsApplied = useCallback(async (outlinePaths: string[]) => {
    const talk = activeTalkRef.current
    if (!talk || !outlinePaths.includes(talk.outlinePath)) return
    const fresh = await window.tw.talk.readOutline(talk.outlinePath)
    if (fresh == null) {
      notify('Tags written on disk, but the outline could not be reloaded — reopen this Talk before editing.', 'error')
      return
    }
    if (fresh === outlineContentRef.current) return
    if (editorReplaceRef.current) editorReplaceRef.current(fresh)
    else { setOutlineContent(fresh); setReorderNonce((n) => n + 1) }
  }, [])

  // "Tag current slide…" (command palette): the SAME locked picker, anchored under the toolbar,
  // applying to the slide the cursor/strip is on. The ⌘K editor slide menu arrives in a later
  // stage — until then the palette is the keyboard path.
  const [tagSlide, setTagSlide] = useState<{ id: string | null; heading: string; occurrence: number; tags: string[] } | null>(null)
  const [tagSlideBusy, setTagSlideBusy] = useState(false)

  // Keep overlayOpenRef honest: any overlay that can sit over the editor blocks the slide
  // context menu (and lets ⌘K fall through untouched, per the no-swallow rule).
  useEffect(() => {
    overlayOpenRef.current =
      browserOpen || paletteOpen || searchOpen || archiveOpen || iconPickerOpen || helpOpen ||
      cmdMenuOpen || abstractOpen || deckDesignOpen || embedCheckOpen ||
      explainIndex != null || whereUsedId != null || imageMetaId != null ||
      adoptTarget != null || mergeRequest != null || tagSlide != null || slideMenu != null
  }, [
    browserOpen, paletteOpen, searchOpen, archiveOpen, iconPickerOpen, helpOpen, cmdMenuOpen,
    abstractOpen, deckDesignOpen, embedCheckOpen, explainIndex, whereUsedId, imageMetaId,
    adoptTarget, mergeRequest, tagSlide, slideMenu
  ])

  // Open the slide context menu anchored near the caret's slide: the editor's live cursor
  // coordinates (CodeMirror coordsAtPos) when the caret is in the viewport, else under the
  // toolbar — never nowhere.
  const openSlideMenu = useCallback((opts: { startAtFirst: boolean; withText: boolean; at?: { x: number; y: number } }) => {
    let anchor = opts.at ?? editorCmdsRef.current?.cursorCoords() ?? null
    if (!anchor) {
      const bar = document.querySelector('.workspace-toolbar')?.getBoundingClientRect()
      anchor = bar ? { x: bar.left + 16, y: bar.bottom + 8 } : { x: 80, y: 80 }
    }
    setSlideMenu({ x: anchor.x, y: anchor.y, startAtFirst: opts.startAtFirst, withText: opts.withText })
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
      await editorCmdsRef.current?.flushSave()
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
      await handleTagsApplied(res.applied.map((a) => a.outline))
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
  // version to push across the other talks carrying this id (reuses adoptTarget + handleAdopted).
  function handleAdoptCurrent(slideId: string, currentMarkdown: string): void {
    const talk = activeTalkRef.current
    setAdoptTarget({
      slideId,
      version: { file: '__current__', markdown: currentMarkdown, savedAt: Date.now(), talk: talk?.slug ?? '', canonical: false }
    })
  }

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

  // Hand App an "adopt outline text written on disk into the live buffer" fn (Metadata panel,
  // ADR-0036) — the same adoption move publish-handout does with its updatedOutline.
  useEffect(() => {
    registerAdoptOutline?.((content: string) => {
      if (content === outlineContentRef.current) return
      if (editorReplaceRef.current) editorReplaceRef.current(content)
      else { setOutlineContent(content); setReorderNonce((n) => n + 1) }
      setLastSaved(new Date())
    })
  }, [registerAdoptOutline])

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
          pushTo.current.push(outlineContentRef.current)
          window.tw.talk.writeOutline(talk.outlinePath, text).then((res) => {
            if (!res || res.ok !== true) notify('Undo applied on screen but could not be written to disk.', 'error', 'save-failed')
          })
          setOutlineContent(text)
          setLastSaved(new Date())
          setReorderNonce((n) => n + 1)
        } else if (e.shiftKey) editorCmdsRef.current?.redo()
        else editorCmdsRef.current?.undo()
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
        const t = activeTalkRef.current
        if (t) {
          let startSlideId: string | undefined
          if (e.shiftKey) {
            startSlideId = currentSlideId() ?? undefined
            if (!startSlideId) notify('This slide isn’t stamped yet — starting from the top. Save the outline to enable present-from-here.', 'info')
          }
          void window.tw.talk
            .present(t.outlinePath, outlineContentRef.current, 'presenter', startSlideId)
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
      // ⌘⇧P opens the command palette (all app commands). Capture + stopPropagation.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault()
        e.stopPropagation()
        setCmdMenuOpen(prev => !prev)
        return
      }
      // ⌘P uses the same registered dispatch channel as Deck → Inspector and the command palette.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault()
        e.stopPropagation()
        runRegisteredCommand('toggle-inspector')
        return
      }
      // ⌘N opens a NEW editor window (work on two presentations at once). Not a default menu
      // accelerator, so a window keydown owns it. A given talk can only be active in one window, so
      // the second window opens empty and you pick a different talk (see the same-talk guard).
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault()
        e.stopPropagation()
        void window.tw.windows?.open?.()
        return
      }
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
      if (content == null) return
      await window.tw.present.rebuild(deckWcId, outlinePath, content, slideId)
    })
    return off
  }, [])

  // Reset per-talk state when talk changes. Also drops any active Focus — switching talks must
  // never leave the scoped editor pointing at the previous talk's offsets.
  useEffect(() => {
    setCompiledSlides(null)
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
    const outlinePath = activeTalk.outlinePath
    if (compileTimer.current) clearTimeout(compileTimer.current)
    compileTimer.current = setTimeout(async () => {
      // setCompiling belongs INSIDE the timer: calling it per keystroke forced a full
      // WorkspaceLayout re-render on every character typed during the debounce window.
      setCompiling(true)
      const slides = await window.tw.talk.compile(outlinePath, outlineContent)
      // Surface a compile failure instead of silently showing the client-side fallback strip.
      if (slides === null) {
        notify('Couldn’t compile this talk — the html-presentations compiler wasn’t found or errored. Slides/previews won’t update.', 'error', 'compile-fail')
      } else {
        // The error toast is persistent — clear it once a compile succeeds again, so it can't
        // keep accusing a talk that has since recovered.
        dismissToast('compile-fail')
      }
      setCompiledSlides(slides)
      setCompiling(false)
      // Thumbnails: do not block the strip. A null map = the render couldn't run at all.
      window.tw.talk
        .thumbnails(outlinePath, outlineContent)
        .then((map) => {
          setThumbnails(map)
          if (map && slides && slides.length) {
            // Slides whose preview couldn't render (e.g. an image too slow to decode) are NOT cached
            // — surface the count so a blank strip card isn't a silent mystery.
            const missing = slides.filter((s) => s.content_hash && !(map[s.render_hash || ''] || map[s.content_hash || ''])).length
            if (missing > 0) notify(`${missing} slide preview${missing === 1 ? '' : 's'} couldn’t render — use the Refresh button to retry.`, 'warning', 'thumb-missing')
          }
        })
        .catch(() => { setThumbnails(null); notify('Slide previews failed to render.', 'warning', 'thumb-missing') })
    }, 900)
    return () => {
      if (compileTimer.current) clearTimeout(compileTimer.current)
    }
  }, [outlineContent, activeTalk?.outlinePath])

  // Word count effect
  useEffect(() => {
    setWordCount(outlineContent.split(/\s+/).filter(Boolean).length)
  }, [outlineContent])

  async function handlePresent(mode: 'window' | 'presenter' | 'audience' = 'window') {
    if (!activeTalk || !outlineContent) return
    const result = await window.tw.talk.present(activeTalk.outlinePath, outlineContent, mode)
    if (result && result.success === false) notify('Present failed: ' + (result.error || 'unknown error'), 'error')
  }

  // Presenter view starting on the slide you're currently on (⇧F5 / Present menu). An unstamped
  // current slide has no {id=…} to deep-link to, so it falls back to the top with a hint.
  async function presentFromHere() {
    if (!activeTalk || !outlineContent) return
    const id = currentSlideId()
    if (!id) notify('This slide isn’t stamped yet — starting from the top. Save the outline to enable present-from-here.', 'info')
    const result = await window.tw.talk.present(activeTalk.outlinePath, outlineContent, 'presenter', id ?? undefined)
    if (result && result.success === false) notify('Present failed: ' + (result.error || 'unknown error'), 'error')
  }

  // The ⌘L layout picker, also reachable from the toolbar Insert → Layout. A bare trigger lands on
  // the slide's Trigger line; a multi-line template is spliced as a new block at the caret.
  function openLayoutPicker(): void {
    setPaletteQuery('')
    setPaletteContext(editorLayoutContextRef.current?.() ?? null)
    setPaletteOpen(true)
  }

  async function handleBuild() {
    if (!activeTalk || !outlineContent) return
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
  // STAMPS handout_url into the outline, so we adopt the returned `updatedOutline` in place FIRST —
  // otherwise the editor's debounced autosave would overwrite the stamp it just wrote.
  async function handlePublishHandout() {
    if (!activeTalk || !outlineContent) return
    setBuildStatus('building')
    setPublishElapsed(0)
    setPublishing(true)
    const ticker = setInterval(() => setPublishElapsed((s) => s + 1), 1000)
    try {
      const res = await window.tw.talk.publishHandout(activeTalk.outlinePath, outlineContent)
      if (res?.updatedOutline && res.updatedOutline !== outlineContentRef.current) {
        if (editorReplaceRef.current) editorReplaceRef.current(res.updatedOutline)
        else { setOutlineContent(res.updatedOutline); setReorderNonce((n) => n + 1) }
        setLastSaved(new Date())
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

  // Manual rebuild (the escape hatch Dominik asked for): wipe this talk's thumbnail cache, then
  // recompile + re-render thumbnails from scratch. For when a preview ever looks stale/wrong.
  async function handleRefresh() {
    if (!activeTalk) return
    await window.tw.talk.clearThumbCache(activeTalk.slug)
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
  // originals (recoverable). The in-place content update triggers a fresh compile → faster previews.
  async function handleOptimizeImages() {
    if (!activeTalk) return
    notify('Optimizing images…', 'info', 'optimize')
    const res = await window.tw.talk.optimizeImages(activeTalk.outlinePath, outlineContentRef.current)
    if (!res?.success) {
      notify('Image optimization failed: ' + (res?.error || 'unknown error'), 'error', 'optimize')
      return
    }
    if ((res.converted ?? 0) > 0 && res.newContent) {
      if (editorReplaceRef.current) editorReplaceRef.current(res.newContent)
      else { setOutlineContent(res.newContent); setReorderNonce((n) => n + 1) }
      setLastSaved(new Date())
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

  // Drag-reorder: ask the compiler lib for the rewritten outline, persist it to disk, then apply
  // the new text IN PLACE via the editor's replace-doc channel. The old remount path (reorderNonce)
  // wiped CodeMirror's history, so a drag could never be ⌘Z'd — and destroyed all pre-drag typing
  // undo with it. The in-place dispatch records the move in CM history like ⌘⇧↑/↓ moves already are.
  async function handleReorder(from: number, to: number) {
    if (!activeTalk) return
    // Flush any pending in-memory edits FIRST: the reorder IPC reads the file from
    // disk, so an unflushed autosave would be silently dropped by the rewrite.
    await window.tw.talk.writeOutline(activeTalk.outlinePath, outlineContent)
    const newText = await window.tw.outline.reorder(activeTalk.outlinePath, from, to)
    if (newText == null) return
    // Snapshot the pre-reorder text for the GRID-mode ⌘Z stack (no editor focus there); a fresh
    // move invalidates any redo. In "both" view the CM history is the undo authority.
    reorderUndoRef.current.push(outlineContentRef.current)
    if (reorderUndoRef.current.length > 50) reorderUndoRef.current.shift()
    reorderRedoRef.current = []
    notifyCollisions(await window.tw.talk.writeOutline(activeTalk.outlinePath, newText))
    setLastSaved(new Date())
    if (editorReplaceRef.current) {
      editorReplaceRef.current(newText) // docChanged → onContentChange → compile/strip refresh
    } else {
      setOutlineContent(newText)
      setReorderNonce((n) => n + 1)
    }
  }

  // Cross-Talk reuse insert (ADR-0013). The Editor registers an imperative
  // insert-at-cursor channel (editorInsertRef); we splice the imported slide
  // at the live caret. Provenance is implicit: the block keeps its `{id=…}`
  // verbatim and the ledger records the arrival on save (ADR-0032). The Editor's
  // docChanged then drives onContentChange (→ outlineContentRef), and we flush
  // that post-insert text to disk right away rather than waiting on the Editor's
  // debounced autosave. We do NOT bump reorderNonce: that would remount the Editor
  // and re-read from disk, discarding the in-memory insert. Falls back to an
  // EOF-append only if the Editor has not registered an insert channel.
  async function handleSearchInsert(markdown: string, _fromSlug: string, sourceOutlinePath?: string) {
    if (!activeTalk) return
    // Cross-talk reuse: materialize the slide's relative images into the vault pool first, so they
    // resolve in THIS talk (a relative assets/ ref points at the SOURCE talk and would go grey).
    let md = markdown
    if (sourceOutlinePath) {
      try {
        const mat = await window.tw.talk.materializeSlideAssets(sourceOutlinePath, markdown)
        if (mat?.success) md = mat.markdown
      } catch { /* fall back to the raw markdown */ }
    }
    const block = md.replace(/\s*$/, '')

    const insertFn = editorInsertRef.current
    if (insertFn) {
      insertFn(block)
      // Let React commit the docChanged → onContentChange → outlineContentRef
      // update, then flush the new text to disk so a read-back sees it.
      await new Promise((r) => setTimeout(r, 0))
      const newText = outlineContentRef.current
      notifyCollisions(await window.tw.talk.writeOutline(activeTalk.outlinePath, newText))
      setLastSaved(new Date())
      return
    }

    // Fallback: no insert channel — append at EOF (legacy behaviour).
    const trimmed = outlineContent.replace(/\s*$/, '')
    const newText = `${trimmed}\n\n${block}\n`
    notifyCollisions(await window.tw.talk.writeOutline(activeTalk.outlinePath, newText))
    setOutlineContent(newText)
    setLastSaved(new Date())
    setReorderNonce((n) => n + 1)
  }

  // Insert SEVERAL searched slides at once (multi-select), each its own block,
  // at the caret in result order. Inserts via the same channel, then flushes once.
  async function handleSearchInsertMany(items: { markdown: string; fromSlug: string; sourceOutlinePath?: string }[]) {
    if (!activeTalk || items.length === 0) return
    const insertFn = editorInsertRef.current
    // Materialize each slide's relative images into the vault pool (cross-talk reuse) before insert.
    const mdById = await Promise.all(items.map(async (it) => {
      if (!it.sourceOutlinePath) return it.markdown
      try {
        const mat = await window.tw.talk.materializeSlideAssets(it.sourceOutlinePath, it.markdown)
        return mat?.success ? mat.markdown : it.markdown
      } catch { return it.markdown }
    }))
    const blocks = items.map((_it, i) => mdById[i].replace(/\s*$/, ''))
    if (insertFn) {
      insertFn(blocks.join('\n\n'))
      await new Promise((r) => setTimeout(r, 0))
      notifyCollisions(await window.tw.talk.writeOutline(activeTalk.outlinePath, outlineContentRef.current))
      setLastSaved(new Date())
      notify(`Inserted ${items.length} slide${items.length === 1 ? '' : 's'}.`, 'success')
      return
    }
    const trimmed = outlineContent.replace(/\s*$/, '')
    const newText = `${trimmed}\n\n${blocks.join('\n\n')}\n`
    notifyCollisions(await window.tw.talk.writeOutline(activeTalk.outlinePath, newText))
    setOutlineContent(newText)
    setLastSaved(new Date())
    setReorderNonce((n) => n + 1)
    notify(`Inserted ${items.length} slides.`, 'success')
  }

  // Archive image insert (ADR-0019 archive reuse). ArchiveImageSearch already copied the
  // chosen archive image into the current vault's _assets (content-addressed) and resolved
  // its id; we splice `![](img-<id>)` at the live caret via the same imperative
  // insert-at-cursor channel the cross-talk search uses, then flush to disk right away so a
  // read-back sees it (the Editor's own autosave is debounced 1.5s, too slow).
  async function handleArchiveInsert(imgId: string) {
    if (!activeTalk) return
    // importImage already returns a full `img-<hash>` id — do NOT re-prefix (that produced
    // the `img-img-…` refs that the inline-image widget regex could not match).
    const id = imgId.startsWith('img-') ? imgId : `img-${imgId}`
    const markdown = `![](${id})`
    const insertFn = editorInsertRef.current
    if (insertFn) {
      insertFn(markdown)
      await new Promise((r) => setTimeout(r, 0))
      const newText = outlineContentRef.current
      notifyCollisions(await window.tw.talk.writeOutline(activeTalk.outlinePath, newText))
      setLastSaved(new Date())
      return
    }
    // Fallback: no insert channel — append at EOF.
    const trimmed = outlineContent.replace(/\s*$/, '')
    const newText = `${trimmed}\n\n${markdown}\n`
    notifyCollisions(await window.tw.talk.writeOutline(activeTalk.outlinePath, newText))
    setOutlineContent(newText)
    setLastSaved(new Date())
    setReorderNonce((n) => n + 1)
  }

  // Icon pick (ADR-0021). The IconPicker resolved a glyph key; we pin it to the caret's current
  // top-level list bullet. The editor's registered reader gives us {heading, occurrence, itemIndex}
  // for the live caret; the main process rewrites the in-memory outline (NOT the on-disk file,
  // which lags the debounced autosave) via setListItemIcon. The rewrite is a tiny `{icon=…}` token
  // addition, so we apply it IN PLACE via the editor's replace-doc channel (preserving caret +
  // scroll) instead of bumping reorderNonce — a remount snapped the editor to the top of the file
  // (it reloaded fresh + the focusLine effect yanked the caret to the last strip slide). The
  // in-place replace's docChanged drives onContentChange → compile/strip refresh. We still flush to
  // disk right away so a read-back sees the token. No-op with a hint when the caret is not in a bullet.
  async function handleIconPicked(iconKey: string) {
    if (!activeTalk) return
    const ctx = iconContextRef.current?.() ?? null
    if (!ctx) {
      notify('Place the caret in a top-level list item first — an icon pins to a bullet.', 'info', 'icon-pick')
      return
    }
    const newText = await window.tw.outline.setItemIcon(
      outlineContentRef.current,
      ctx.slideHeading,
      ctx.slideOccurrence,
      ctx.itemIndex,
      iconKey
    )
    if (newText == null) {
      notify('Couldn’t pin the icon to that item — the outline was left unchanged.', 'warning', 'icon-pick')
      return
    }
    notifyCollisions(await window.tw.talk.writeOutline(activeTalk.outlinePath, newText))
    setLastSaved(new Date())
    // Apply in place (no remount → no jump-to-top). Falls back to a remount only if the editor
    // never registered a replace channel.
    if (editorReplaceRef.current) {
      editorReplaceRef.current(newText)
    } else {
      setOutlineContent(newText)
      setReorderNonce((n) => n + 1)
    }
  }

  // After an adoption (PropagationChecklist): if the CURRENT outline was among the replaced
  // targets, its file changed on disk behind the editor's back — re-read it and apply via the
  // same in-place replace channel the icon/publish flows use (preserves caret + scroll; the
  // reorderNonce remount is only the no-channel fallback, exactly like handlePublishHandout).
  async function handleAdopted(result: { replaced: { talk: string; outline: string }[] }): Promise<void> {
    const talk = activeTalkRef.current
    if (!talk) return
    const root = vaultRoot.replace(/\/$/, '')
    if (!result.replaced.some((r) => `${root}/${r.outline}` === talk.outlinePath)) return
    const fresh = await window.tw.talk.readOutline(talk.outlinePath)
    if (fresh == null) {
      // The adopted file is on disk but the editor still holds pre-adopt text — the next
      // debounced autosave would silently write that stale text back OVER the adoption.
      // Surface it loudly; nothing here can safely repair the reload.
      notify('Adopted on disk, but the outline could not be reloaded — reopen this Talk before editing.', 'error')
      return
    }
    if (fresh === outlineContentRef.current) return
    if (editorReplaceRef.current) {
      editorReplaceRef.current(fresh)
    } else {
      setOutlineContent(fresh)
      setReorderNonce((n) => n + 1)
    }
  }

  function handleDeckDesignSave(newOutline: string) {
    setOutlineContent(newOutline)
    if (editorReplaceRef.current) editorReplaceRef.current(newOutline)
    window.tw.talk.writeOutline(activeTalk!.outlinePath, newOutline).then((res) => {
      if (!res || res.ok !== true) notify('Design change applied on screen but could not be written to disk.', 'error', 'save-failed')
    })
    setLastSaved(new Date())
  }

  // Every generated palette, native-menu, and toolbar item reaches renderer behaviour through
  // this typed handler map. It is assigned before the empty-state return because the Talk-free
  // Tools menu uses the same registered commands.
  commandHandlersRef.current = {
    refresh: () => { void handleRefresh() },
    'optimize-images': () => { void handleOptimizeImages() },
    'ocr-index': () => { void handleOcrIndex() },
    'check-embeds': () => setEmbedCheckOpen(true),
    'where-used': openWhereUsed,
    'focus-slide': () => enterFocus(activeSlideRef.current),
    'toggle-inspector': toggleInspector,
    studio: () => window.dispatchEvent(new Event('tw-open-studio')),
    history: () => window.dispatchEvent(new Event('tw-open-history')),
    'plan-run': () => {
      window.dispatchEvent(new Event('tw-open-history'))
      window.setTimeout(() => window.dispatchEvent(new Event('tw-plan-run')), 0)
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
    layout: openLayoutPicker,
    image: () => setArchiveOpen(true),
    search: () => setBrowserOpen(true),
    'icon-picker': () => setIconPickerOpen(true),
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
    'delete-slide': handleDeleteSlide,
    help: () => setHelpOpen(true),
    settings: () => onOpenSettings?.()
  }

  const toolbarItems = (menu: ToolbarMenuName, excludedHandlerIds: string[] = []): MenuItem[] =>
    toolbarCommands(menu).flatMap((registered) => {
      if (excludedHandlerIds.includes(registered.handlerId)) return []
      const handler = commandHandlersRef.current?.[registered.handlerId as PaletteCommandHandlerId]
      if (!handler) {
        if (import.meta.env.DEV) throw new Error(`Toolbar command has no renderer handler: ${registered.handlerId}`)
        return []
      }
      return [{
        icon: registered.toolbar!.icon,
        label: registered.label,
        onClick: handler,
        hint: commandShortcutLabel(registered) || undefined
      }]
    })

  // onSaved is ALSO a dep of that registration effect — inline it and every save-path
  // re-render re-arms the same loop the stable registerEditorCommands exists to break.
  const handleEditorSaved = useCallback(() => { setLastSaved(new Date()); setDirty(false) }, [])

  function applyOption(entry: LayoutDef | undefined, group: OptionGroup, token: string, targetHeadingLine?: number, targetSlideId?: string | null): string | null {
    const isEditorMounted = paneState !== 'strip'
    if (isEditorMounted) {
      return editorApplyOptionRef.current?.(entry, group, token, targetHeadingLine, targetSlideId) ?? null
    }

    const talk = activeTalkRef.current
    const headingLine = targetHeadingLine ?? slideLinesRef.current[activeSlideRef.current] ?? null
    if (!talk || headingLine == null) return null
    const next = applyInspectorOptionToOutline(outlineContentRef.current, headingLine, group, token)
    if (next == null || next === outlineContentRef.current) return next

    outlineContentRef.current = next
    setOutlineContent(next)
    setDirty(true)
    if (inspectorSaveTimer.current) clearTimeout(inspectorSaveTimer.current)
    const outlinePath = talk.outlinePath
    inspectorSaveTimer.current = setTimeout(() => {
      inspectorSaveTimer.current = null
      window.tw.talk.writeOutline(outlinePath, next).then((saved) => {
        if (!saved || saved.ok !== true) return
        notifyCollisions(saved)
        if (activeTalkRef.current?.outlinePath === outlinePath && outlineContentRef.current === next) {
          setLastSaved(new Date())
          setDirty(false)
        }
      })
    }, INSPECTOR_AUTOSAVE_MS)
    return next
  }

  function applyInspectorOption(entry: LayoutDef | undefined, group: OptionGroup, token: string): string | null {
    const headingLine = headingLineForSlideId(
      outlineContentRef.current,
      inspectedSlideIdRef.current
    )
    if (headingLine == null) return null
    // In both mode CodeMirror remains the undo/autosave authority; in strip mode the existing
    // unmounted-editor fallback applies. Both paths receive the ID-derived heading explicitly.
    inspectorCommitInProgressRef.current = true
    try {
      return applyOption(entry, group, token, headingLine, inspectedSlideIdRef.current)
    } finally {
      // CodeMirror reports mapped selections synchronously with the commit dispatch. Release after
      // that dispatch settles so the next real pointer/keyboard cursor move follows immediately.
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
  const editorKey = `${activeTalk.outlinePath}#${reorderNonce}`

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
      registerLayoutContext={(fn) => { editorLayoutContextRef.current = fn }}
      registerApplyLayout={(fn) => { editorApplyLayoutRef.current = fn }}
      registerApplyOption={(fn) => { editorApplyOptionRef.current = fn }}
      focusLine={focusLine}
      onCursorLine={handleCursorLine}
      onImageWidgetClick={(id) => setImageMetaId(id)}
      registerInsert={(fn) => { editorInsertRef.current = fn }}
      registerEditorCommands={registerEditorCommands}
      registerIconContext={(fn) => { iconContextRef.current = fn }}
      registerReplaceDoc={(fn) => { editorReplaceRef.current = fn }}
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
  const editorPane = (
    <div className="pane pane--editor">
      <div className="editor-portal-slot" ref={attachEditorSlot} />
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

  const inspectorPane = (
    <div className="pane pane--inspector">
      <Inspector
        talk={activeTalk}
        compiledSlides={compiledSlides}
        outlineContent={outlineContent}
        activeIndex={inspectedSlideIndex}
        headingLine={slideLines[inspectedSlideIndex] ?? null}
        onPrev={() => handleSelectInspectorSlide(navigateInspectorSlide(inspectedSlideIndex, -1, compiledSlides?.length ?? 0))}
        onNext={() => handleSelectInspectorSlide(navigateInspectorSlide(inspectedSlideIndex, 1, compiledSlides?.length ?? 0))}
        onEdit={() => handleEditSlide(inspectedSlideIndex)}
        onExplain={() => setExplainIndex(inspectedSlideIndex)}
        onCommitOption={applyInspectorOption}
      />
    </div>
  )

  const stripPane = (
    <div className="pane pane--strip">
      <SlideStrip
        talk={activeTalk}
        compiledSlides={compiledSlides}
        outlineContent={outlineContent}
        thumbnails={thumbnails}
        activeIndex={activeSlide}
        onSelectSlide={handleSelectSlide}
        onEdit={handleEditSlide}
        onReorder={handleReorder}
        onExplain={(i) => setExplainIndex(i)}
      />
    </div>
  )

  const stripSurface = inspectorMode ? inspectorPane : stripPane

  const gridPane = (
    <div className="pane pane--grid">
      <GridView
        talk={activeTalk}
        compiledSlides={compiledSlides}
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
          <ToolbarMenu
            icon="share"
            label="Share"
            title="Export, build, or publish this talk"
            items={[
              { icon: 'handout', label: 'Handout (reveal in Finder)', onClick: handleExportHandout },
              { icon: 'html', label: 'HTML presentation (reveal in Finder)', onClick: handleBuild },
              { icon: 'publish', label: 'Publish to Cloudflare', onClick: handlePublishHandout }
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

      <div className={`workspace-panes workspace-panes--${gridMode ? 'grid' : paneState}`}>
        {gridMode ? (
          gridPane
        ) : (
          <>
            {paneState === 'editor' && editorPane}
            {paneState === 'strip' && stripSurface}
            {paneState === 'both' && (
              <ResizablePanes
                left={editorPane}
                right={stripSurface}
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
      />
      </>
      ) : (
        <SlideFocus
          talk={activeTalk}
          vaultRoot={vaultRoot}
          slideIndex={focusSlide}
          slideCount={compiledSlides?.length ?? 0}
          section={readableSectionLabel(compiledSlides, focusSlide)}
          slideTitle={focusRow?.nav_title || focusRow?.title || ''}
          compiledSlideId={focusRow?.slide_id || ''}
          headingLine={slideLines[focusSlide] ?? null}
          outlineContent={outlineContent}
          editorSlotRef={attachEditorSlot}
          onPrev={() => focusStep(-1)}
          onNext={() => focusStep(1)}
          onExit={exitFocus}
          onAdoptCurrent={handleAdoptCurrent}
          onDetach={handleDetach}
          onShowOutlineLine={() => { const l = slideLinesRef.current[focusSlide]; if (l != null) setFocusLine({ line: l, takeFocus: true }) }}
          suspendKeys={helpOpen || adoptTarget != null}
        />
      )}
      <CommandPalette
        isOpen={paletteOpen}
        query={paletteQuery}
        context={paletteContext}
        onClose={() => { setPaletteOpen(false); setPaletteContext(null); focusEditor() }}
        onCommit={(initial, selected) => {
          editorApplyLayoutRef.current?.(initial, selected)
          setPaletteOpen(false)
          setPaletteContext(null)
          setPaletteQuery('')
          focusEditor()
        }}
        onCommitOption={(entry, group, token) => editorApplyOptionRef.current?.(entry, group, token) ?? null}
        onInsertComponent={(text) => editorInsertRef.current?.(text)}
      />
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
        vaultRoot={vaultRoot}
        onOpenHelp={() => setHelpOpen(true)}
        suspendKeys={helpOpen || adoptTarget != null || mergeRequest != null}
        onAdoptVersion={(slideId, version) => setAdoptTarget({ slideId, version })}
        onRequestMerge={(req) => setMergeRequest(req)}
        refreshNonce={mergeNonce}
        registerFocusSearch={(fn) => { browserFocusSearchRef.current = fn }}
        flushBeforeTagWrite={flushBeforeTagWrite}
        onTagsApplied={handleTagsApplied}
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
        <PropagationChecklist
          isOpen
          onClose={() => setAdoptTarget(null)}
          slideId={adoptTarget.slideId}
          adoptVersion={adoptTarget.version}
          currentOutlinePath={activeTalk?.outlinePath ?? null}
          vaultRoot={vaultRoot}
          onAdopted={handleAdopted}
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
      {whereUsedId && (
        <WhereUsedPanel slideId={whereUsedId} onClose={() => setWhereUsedId(null)} />
      )}
      <EmbedCheckPanel
        isOpen={embedCheckOpen}
        onClose={() => setEmbedCheckOpen(false)}
        outlinePath={activeTalk.outlinePath}
        content={outlineContent}
      />
      <CommandMenu
        isOpen={cmdMenuOpen}
        onClose={() => setCmdMenuOpen(false)}
        commands={paletteCommands().map((command): Command => ({
          id: command.id,
          title: command.label,
          hint: commandShortcutLabel(command),
          keywords: command.palette.keywords,
          run: () => runRegisteredCommand(command.handlerId)
        }))}
      />
      {slideMenu && (
        <SlideContextMenu
          x={slideMenu.x}
          y={slideMenu.y}
          startAtFirst={slideMenu.startAtFirst}
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
