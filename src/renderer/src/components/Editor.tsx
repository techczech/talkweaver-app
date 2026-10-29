import { scratchDropExtension } from '../extensions/scratchDrop'
import type { SlidePlace } from '../../../shared/slide-handling/place'
import { runActionBarEditing } from './actionBar/editing-command'
import { boardStarterInsertion, mintBoardSlideId } from '../../../../compiler/scripts/lib/board-slide.mjs'
import { useEffect, useRef, useCallback } from 'react'
import { imageWidgetExtension, imagePlacementsChanged, editorImageUrl } from '../extensions/imageWidget'
import { cardMediaFacet } from '../extensions/objectBlocks/cardWidgets'
import { insertSpeakerNotes, objectDeletionNotices, objectStatusRequests } from '../extensions/objectBlocks/commands'
import { objectStatusSource, type CardFileStatus } from '../extensions/objectBlocks/status'
import { cardActionHost } from '../extensions/objectBlocks/cardActions'
import { HTML_PAGE_INSERT_TEXT } from '../lib/insertHtmlPage'
import { imagePlacementForLine, type PlacementRow } from '../../../shared/image-placement.ts'
import {
  getCursorListItemContext,
  minimalChange,
  moveNode,
  reLevel,
  moveBlockTo,
  moveBlockToEnd,
  moveBlockInto,
  normalizeTriggersCommand,
  setQuoteFormAtCursor,
  deleteSlideAtCursor,
  type CursorListItemContext
} from '../extensions/outliner'
import {
  buildEditorKeyBindings,
  eventMatchesEffectiveShortcut,
  KEYMAP_CHANGED_EVENT
} from '../keymap/store'
import { EDITOR_COMMANDS } from '../keymap/registry'
import { placeOfLine, type Place } from '../../../shared/place.ts'
import { imageParagraphNoFold, outlineFoldService } from '../extensions/outlineFold'
import { frontmatterTableExtension } from '../extensions/frontmatterTable'
import { setWorkStripsData, workStripHandlersFacet } from '../extensions/workStrips'
import { loadWorkStripsData } from '../lib/workStripsData'
import { inlineMarkExtension } from '../extensions/inlineMark'
import { keyCapExtension } from '../extensions/keyCap'
import {
  canRunInlineFormatting,
  objectBlocksExtension,
  setOpenObjectBlock
} from '../extensions/objectBlocks/field'
import { EditorView, keymap, highlightActiveLine } from '@codemirror/view'
import { EditorState, EditorSelection, Prec, Compartment } from '@codemirror/state'
import { history } from '@codemirror/commands'
import { editorBaseKeymap } from '../extensions/editorBaseKeymap'
import { search, highlightSelectionMatches, openSearchPanel } from '@codemirror/search'
import { commandRan } from '../commands/command-ran'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { viewModeExtension, type PlainViewOptions } from '../extensions/plainView'
import { plainTypeExtension } from '../extensions/plainView/theme'
import { plainIconTools, type PlainIconTools } from '../extensions/plainView/iconTools'
import { PLAIN_LOOK_DEFAULT, type PlainLook } from '../../../shared/plain-view-look'
import { setMarginLabels, caretHeadingTarget, focusHeading, type MarginMenuHandlers } from '../extensions/plainView/margin'
import type { MarginLabel } from '../../../shared/plain-view-margin'
import type { EditorViewMode } from '../../../shared/editor-view-mode'
import {
  foldGutter,
  codeFolding,
  foldAll,
  unfoldAll
} from '@codemirror/language'
import type { TalkInfo } from '../../../preload/index'
import { notify } from '../lib/notify'
import { queueOutlineWrite } from '../lib/saveQueue'
import { lookForRecovery, noteOutlineSaveReply, outlineDiskChanges } from '../lib/outlineDiskChange'
import { replaceDocTransaction } from '../lib/replaceDocTransaction'
import { adoptSavedText, redoWithSave, savedTextAdoption, undoWithSave } from '../extensions/savedTextAdoption'
import { saveTidyUp, textForSave } from '../extensions/saveTidyUp'
import { triggerCompleteExtension } from '../extensions/triggerComplete'
import { tokenProtectExtension } from '../extensions/idProtect'
import {
  copySlideAt, cutSlideAt, deleteSlideAt, moveSlideTo, pasteSlideTextAtCaret, pasteSlidesAfter, slideCutCopyExtension, wouldPasteAsSlides
} from '../extensions/slideCutPaste'
import { researchDropHandlers, researchInsertionMarker } from '../extensions/researchDrop'
import { blockAnchorAfterLine, insertAtCaretLine, insertBlockAfterLine, pasteAtHeadingEnd, pasteBlockAtSelection, pasteTextAtSelection } from '../extensions/headingEndInsert'
import type { MoveTarget } from '../extensions/slideBlockOps'
import type { SlideRef } from '../../../shared/slide-handling/blocks'
import { quoteLinkFormExtension } from '../extensions/quoteLinkForm'
import { setSlideNumberLines, slideNumberGutterExtension } from '../extensions/slideNumberGutter'
import { setTextFitNotes, textFitWarningExtension } from '../extensions/textFitWarning'
import type { TextFitNote } from '../../../shared/text-fit-notes.ts'
import type { QuoteFormChoice } from '../../../shared/layout-verbs'
import { flashTriggerEchoAt, triggerEchoChange } from '../extensions/triggerEcho'
import {
  commitLayoutSelection,
  commitSlideOption,
  commitQuoteFormOption,
  provisionalTriggerAtCursor,
  selectionFromTriggerLine,
  toggleLayoutSelection,
  type LayoutPickerContext
} from './layoutPickerModel'
import { LAYOUTS, type LayoutDef, type OptionGroup } from '../data/layouts'
import { headingHasChildSlides, logicalTriggerBlockAfterHeading, reportTriggerMergeWarnings } from '../../../shared/trigger-line'
import { deckCommitContext } from '../../../shared/deck-frame'
import {
  planEditorTriggerCommit,
  prepareObjectInsertDocument
} from '../extensions/inlineTriggerCommitModel'
import { headingLineForSlideId } from './inspectorModel'
import {
  buildFencedObjectSource,
  isSvgFile,
  isSvgText,
  parseTablePaste,
  planObjectBlockSplice,
  tablePasteKind
} from '../../../shared/objects/insert-objects'
import type { ObjectInsertRequest } from '../../../shared/objects/insert-objects'
import {
  serialiseTable,
  type TableAlignment
} from '../../../shared/objects/object-markup'
import { sanitiseSvg } from '../../../shared/objects/sanitise-svg'
import {
  focusScopeExtension,
  setFocusRange,
  FOCUS_SCOPE_EVENT,
  type FocusRange
} from '../extensions/focusScope'

type AddVideoResult = {
  success: boolean
  id?: string
  origin?: 'gif' | 'video' | 'image'
  warning?: string
  error?: string
}

export type ObjectInsertKind = 'table' | 'mindmap' | 'chart' | 'mermaid' | 'diagram' | 'svg'
export type ObjectInsertHandler = (kind: ObjectInsertKind, request?: ObjectInsertRequest) => void
type ApplyLayoutOptions = { layoutTokenOverride?: string }

// Markdown for an ingested media result (ADR-0028). GIF-origin clips carry the EXPLICIT ambient set
// {autoplay}{loop}{muted} so the compiler maps tokens → <video> attributes mechanically (no "loop
// implies autoplay" inference). MP4 and static-GIF-fallback images get a bare ref (manual/controls).
function mediaMarkdown(res: AddVideoResult | null | undefined): string | null {
  if (!res || !res.success || !res.id) return null
  if (res.origin === 'gif') return '![](' + res.id + '){autoplay}{loop}{muted}'
  return '![](' + res.id + ')'
}

// Splice an ingested clip into the doc at `pos` (or the caret), surfacing failures/warnings as toasts
// so media ingestion never fails silently (ADR-0023).
function insertMediaResult(view: EditorView | null, res: AddVideoResult | null | undefined, pos: number | 'caret'): void {
  if (!res || !res.success) { notify('Could not add media: ' + (res?.error || 'unknown error'), 'error', 'addmedia'); return }
  if (res.warning) notify(res.warning, 'info', 'addmedia')
  const md = mediaMarkdown(res)
  if (!md || !view) return
  const at = pos === 'caret' ? view.state.selection.main.head : pos
  // After the line, or under a heading's id and layout lines (headingEndInsert.ts).
  insertBlockAfterLine(view, at, '\n' + md + '\n', { caret: ('\n' + md).length })
}

/** Whole-slide operations by heading line (1-based), run in the editor's buffer. */
export interface SlideBlockOps {
  cut: (line: number) => string | null
  copy: (line: number) => string | null
  /** After the slide or section on `afterLine`; at the end of the talk when null. */
  paste: (clip: string, afterLine: number | null) => number | null
  /** `cardRef`: a grid card's heading (slideRefOf), checked against the buffer by the move core. */
  moveTo: (fromLine: number, target: MoveTarget, cardRef?: SlideRef) => number | null
  delete: (line: number) => void
}

interface Props {
  onResearchDrop?: (file: string) => void
  showResearchInsertion?: boolean
  talk: TalkInfo
  content: string
  onContentChange: (content: string) => void
  onSaved?: () => void
  /** Save-health signal: true on a real user edit (autosave pending), false once it reaches disk.
   *  A refused/failed save never reports false — the status bar keeps showing unsaved. */
  onDirty?: (dirty: boolean) => void
  vaultRoot?: string | null
  /** Jump target. takeFocus=true moves keyboard focus into the editor (sidebar/⌘E jumps);
   *  false only aims the viewport/caret (strip card clicks keep their own keyboard nav). */
  focusLine?: { line: number; takeFocus: boolean } | null
  // Slide Focus (ADR-0032, Task 8): when set, the editor shows/edits ONLY this slide's line range
  // (absolute doc offsets [from, to)); every other line is hidden and edit-guarded — a scoped view
  // onto the SAME outline doc, never a copy. null / undefined = normal full-outline editing (today's
  // behaviour, fully inert). Task 9 drives this from the Slide Focus surface.
  focusRange?: FocusRange | null
  /** ADR-0033 §1: heading lines of slides whose text cannot fit at the readable minimum. */
  textFitNotes?: readonly TextFitNote[]
  /** Heading line of each compiled slide (strip order): the gutter numbers those lines, nothing else. */
  slideLines?: ReadonlyArray<number | null>
  /** Plain view's margin: what each heading line is called (Talk, Section, Slide n) and its layout name. */
  marginLabels?: readonly MarginLabel[]
  /** Compiled slide rows: each carries the compiler's image placements for the editor's image labels. */
  placementRows?: readonly PlacementRow[] | null
  onCursorLine?: (line: number) => void
  /** Onboarding ticket 02: the place of the caret's line (shared/place.ts), reported when it changes. */
  onPlace?: (place: Place) => void
  onImageWidgetClick?: (id: string) => void
  /** Opens the app-wide generated shortcut sheet from a focused object editor. */
  onOpenHelp?: () => void
  // Imperative insert-at-cursor channel (ADR-0013 cross-talk reuse).
  // On mount, Editor calls registerInsert(fn). The parent stores `fn` and may call
  // it later — e.g. when the cross-talk search palette inserts a hit — with the
  // markdown to splice in. `fn(text)` inserts `text` at the CURRENT selection head
  // (surrounded by blank lines so the imported slide stays its own block) and the
  // resulting docChanged drives onContentChange + autosave, so the doc and on-disk
  // file stay in sync without the parent rewriting the whole outline. Unlike the
  // onSlashCommand insertFn (which replaces the trigger line in place), this is a
  // free insert at wherever the caret is. Editor re-registers if the prop changes.
  onScratchDrop?: (id: string, place: SlidePlace) => void
  registerInsert?: (fn: (text: string) => void) => void
  /** Registered object insertion door shared by the slide menu, command palette and `{` picker. */
  registerInsertObject?: (fn: ObjectInsertHandler) => void
  /** Diagram remains a layout family until its object renderer arrives. */
  onOpenObjectLayoutFamily?: (kind: 'chart' | 'diagram') => void
  /** Triple-backtick object door, anchored at the live editor coordinates. */
  onInsertObjectMenu?: (coords: { x: number; y: number }, consumeFence: () => void) => void
  // Lets the app drive editor-only commands (fold/unfold all) from the command palette.
  registerEditorCommands?: (cmds: {
    foldAll: () => void
    unfoldAll: () => void
    move: (line: number, dir: 'up' | 'down') => void
    reLevel: (line: number, dir: -1 | 1, withSubtree: boolean) => void
    moveTo: (fromLine: number, toLine: number) => void
    moveToEnd: (fromLine: number) => void
    moveInto: (fromLine: number, sectionLine: number) => void
    undo: () => void
    redo: () => void
    newSlide: () => void
    insertBoardSlide: () => number | null
    promoteHeading: () => void
    demoteHeading: () => void
    bulletedList: () => void
    numberedList: () => void
    normalizeTriggers: () => void
    setQuoteForm: (form: QuoteFormChoice, compiledLayoutAt?: (headingLine: number) => string | undefined) => void
    deleteSlide: () => void
    // Flush any pending debounced autosave to disk NOW and resolve once written. Slide Focus's
    // detach awaits this before calling ledger.detach so the engine reads the just-typed text, not
    // a stale on-disk copy (the progress ledger flagged this detach-vs-autosave race).
    flushSave: () => Promise<void>
    // Scroll the editor to reveal the current cursor (selection head) WITHOUT changing the selection,
    // and focus it. Used when a view switch re-shows the editor so it lands on the slide you're on
    // (the cursor is wherever strip/grid/outline navigation last put it) instead of snapping to the top.
    scrollCursorIntoView: () => void
    // Viewport coordinates of the caret (below the caret line), for anchoring the ⌘K slide
    // context menu near the caret's slide. Null when the caret is scrolled out of the viewport
    // (the caller falls back to a toolbar anchor).
    cursorCoords: () => { x: number; y: number } | null
    // Move the caret to the document position under viewport (x, y) — the right-click path of
    // the slide context menu, so "the current slide" is the slide under the pointer.
    placeCursorAtCoords: (x: number, y: number) => void
    // Clipboard for the slide context menu's Text rows. Cut/copy defer to the browser command
    // (CodeMirror's own clipboard handlers run); paste splices the clipboard text at the selection.
    cutSelection: () => void
    copySelection: () => void
    pasteClipboard: () => void
    // The selected text ('' when the caret is a point): the "Capture to research…" sheet's body.
    selectionText: () => string
    // Whole slides and sections, addressed by heading line (the Slides outline, the grid, the Move … to…
    // commands): extensions/slideCutPaste.ts. Each is one undo step and says what it did in a toast.
    // cut/copy return the Markdown for the clipboard; paste/moveTo return the heading's new line.
    slides: SlideBlockOps
    runFormat: (id: 'bold' | 'italic' | 'inline-code' | 'highlight' | 'strikethrough' | 'underline' | 'link') => void
  }) => void
  // Icon picker (ADR-0021): on mount Editor registers a reader that returns the CURRENT caret's
  // list-row context ({slideHeading, itemLine}) — or null when the caret is not
  // on a list row. The picker calls it when opened to know which bullet a chosen glyph pins to.
  registerIconContext?: (fn: () => CursorListItemContext | null) => void
  // Put programmatically-rewritten text into the buffer WITHOUT remounting, as one minimal change
  // (lib/minimalChange): the caret is mapped through it, the scroll anchor holds and the change is
  // one undoable step. With `save: true` (the workspace's buffer-first mutations, one-writer spec D1)
  // the caller saves the whole buffer at once, so the debounced autosave is superseded and the text
  // to save — position-normalised like every save boundary — is returned; null while no talk is
  // loaded. Without it the result is the buffer text and the normal autosave follows.
  // With `savedFrom` the text is what a save wrote for that sent text (tidied, ids stamped): it is
  // adopted as the save's own undo step (extensions/savedTextAdoption.ts), and only while the buffer is
  // still the text the save was made from.
  registerReplaceDoc?: (fn: (text: string, opts?: { save?: boolean; savedFrom?: string; ownUndoStep?: boolean }) => string | null) => void
  // The buffer's live text, the talk it belongs to and the caret (selection head offset), or null
  // while that talk's text is not loaded (one-writer spec D1: a mutation of the open talk reads THIS,
  // never the React mirror of it; the section insert places itself from the caret).
  registerReadDoc?: (fn: () => { path: string; text: string; caret: number } | null) => void
  // ⌘L layout picker: places a bare layout trigger on the CURRENT slide's Trigger line (no slash to
  // clean up). The parent opens the picker and calls this with the chosen trigger.
  registerLayoutContext?: (fn: () => LayoutPickerContext | null) => void
  registerApplyLayout?: (fn: (initial: LayoutDef[], selected: LayoutDef[]) => void) => void
  registerApplyOption?: (fn: (entry: LayoutDef | undefined, group: OptionGroup, token: string, headingLine?: number, slideId?: string | null, compiledLayout?: string) => string | null) => void
  // Protected-token click (2026-07-03): clicking a `{…}` chip reports the token instead of
  // placing a cursor inside it — the parent routes id → where-used panel, trigger → ⌘L picker.
  onProtectedTokenClick?: (token: string, kind: 'id' | 'trigger') => void
  // T29b: the editor's two ENGAGEMENT triggers, reported up (App switches the sidebar to the
  // Slide outline once per opened talk — armed only for opens that came from the Talks panel):
  //   1. the first pointerdown anywhere in the editor surface (.cm-editor, incl. .cm-content);
  //   2. the first document change made by the USER (typing/paste/drop — the keyboard-only path,
  //      "first keydown that changes the document"; programmatic dispatches carry no input
  //      userEvent and never fire this).
  // Fired AT MOST as often as the parent cares: it is a plain notification, it never consumes the
  // underlying event, and per-mount dedup is the parent's business (it consumes on first hit).
  onEditorEngaged?: () => void
  /** Plain editing view (spec T1): Plain or Markdown. Reconfigures `viewCompartment`; never remounts. */
  viewMode: EditorViewMode
  /** Plain tab font and text size (spec T13). Reconfigures `plainTypeCompartment`; never remounts. */
  plainLook?: PlainLook
  /** Plain margin (spec T8, T9): the margin word and the layout name were opened; `line` is the heading's 1-based line. */
  onMarginLevelMenu?: (line: number, anchor: DOMRect) => void
  onMarginLayoutMenu?: (line: number, anchor: DOMRect) => void
  /** Capture embed… from a web page card: the page, on the slide whose heading is on `headingLine` (1-based). */
  onCaptureEmbedAt?: (headingLine: number, pageUrl: string) => void
  registerHeadingTools?: (tools: HeadingTools) => void
  // The layout the compiler gave the compiled slide whose heading is on a line: the web form's link-edit rule (spec 3.1) needs it
  // for a quote-only slide with no `{quote}` token.
  compiledLayoutAt?: (headingLine: number) => string | undefined
  /** Plain view, Command-I: where the caret is, and the one write of a verified icon change. */
  registerPlainIconTools?: (tools: PlainIconTools) => void
  /** The pre-work and post-work strips' "Plan a run": opens the plan sheet for this talk. */
  onPlanRun?: () => void
}

// Outliner keyboard extension (ADR-0019). Built from the single-source-of-truth registry (+ any
// user overrides from Settings) so the bindings and the Ctrl-/ help popup can never drift. Held in
// a Compartment so a Settings change re-binds live, without remounting the editor. Bound at highest
// precedence so the chords override CodeMirror's default selection-extension bindings. The registry
// documents WHY these chords were chosen (no Ctrl+Arrow — macOS reserves it for Mission Control).
const keymapCompartment = new Compartment()

// What the Plain view needs from the app: where icon pictures come from (the same bridge the icon picker uses).
function plainViewOptions(menus: MarginMenuHandlers): PlainViewOptions {
  const icons = (window as unknown as { tw?: { icons?: { svg?: (key: string) => Promise<string | null> } } }).tw?.icons
  return { ...menus, ...(icons?.svg ? { iconSvg: (key: string) => icons.svg!(key) } : {}) }
}

export type { PlainIconTools }

/** The editor's handle on a heading, for the margin menus: where the caret's heading is, and putting the caret back on one. */
export interface HeadingTools {
  caretHeading: () => { line: number; anchor: DOMRect } | null
  focusHeading: (line: number) => void
  /** Speaker notes for the caret's slide, through the notes planner (Insert › Speaker notes). */
  insertNotes: () => boolean
}

// history() lives in a Compartment so a talk switch can RESET the undo stack: detaching and
// re-attaching the extension discards its state. Without this, the load's content-replacing
// dispatch is itself undoable — ⌘Z right after opening a talk reverted the doc to the previous
// talk's text (or empty), and with the path marked loaded, autosave could write THAT to the
// new talk's file (live finding 2026-07-11; same hazard class as the 2026-07-05 empty write —
// and the cross-talk variant would sail past the empty-over-nonempty backstop).
const historyCompartment = new Compartment()
function outlinerKeymapExtension() {
  return keymapCompartment.of(Prec.highest(keymap.of(buildEditorKeyBindings())))
}

// The view compartment holds what Plain replaces: the theme and the highlight (extensions/plainView).
// Markdown mode puts today's warm-paper code-font theme and default highlight back, unchanged.
const viewCompartment = new Compartment()
// The Plain tab's font and text size. Empty in Markdown mode, so that tab stays exactly as it was.
const plainTypeCompartment = new Compartment()

export default function Editor({
  onResearchDrop,
  showResearchInsertion = false,
  talk,
  onContentChange,
  onSaved,
  onDirty,
  vaultRoot,
  focusLine,
  focusRange,
  textFitNotes,
  slideLines,
  marginLabels,
  placementRows,
  onCursorLine,
  onPlace,
  onImageWidgetClick,
  onOpenHelp,
  onScratchDrop,
  registerInsert,
  registerInsertObject,
  onOpenObjectLayoutFamily,
  onInsertObjectMenu,
  registerEditorCommands,
  registerIconContext,
  registerReplaceDoc,
  registerReadDoc,
  registerLayoutContext,
  registerApplyLayout,
  registerApplyOption,
  onProtectedTokenClick,
  onEditorEngaged,
  viewMode,
  plainLook = PLAIN_LOOK_DEFAULT,
  onMarginLevelMenu,
  onMarginLayoutMenu,
  onCaptureEmbedAt,
  registerHeadingTools,
  compiledLayoutAt,
  registerPlainIconTools,
  onPlanRun
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const researchMarkerCompartment = useRef(new Compartment())
  useEffect(() => { viewRef.current?.dispatch({ effects: researchMarkerCompartment.current.reconfigure(showResearchInsertion ? researchInsertionMarker : []) }) }, [showResearchInsertion])
  const onPlanRunRef = useRef(onPlanRun)
  onPlanRunRef.current = onPlanRun
  const viewModeRef = useRef<EditorViewMode>(viewMode)
  const plainLookRef = useRef<PlainLook>(plainLook)
  plainLookRef.current = plainLook
  // The margin's menu callbacks read the latest props at click time, so a render never rebuilds the extension.
  const captureEmbedAtRef = useRef(onCaptureEmbedAt)
  captureEmbedAtRef.current = onCaptureEmbedAt
  const marginMenusRef = useRef({ onMarginLevelMenu, onMarginLayoutMenu })
  marginMenusRef.current = { onMarginLevelMenu, onMarginLayoutMenu }
  const marginMenuHandlers = useRef<MarginMenuHandlers>({
    onLevelMenu: (line, anchor) => marginMenusRef.current.onMarginLevelMenu?.(line, anchor),
    onLayoutMenu: (line, anchor) => marginMenusRef.current.onMarginLayoutMenu?.(line, anchor)
  }).current
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The replace seam's last save (`save: true`): the text it returned to be written, and the editor's
  // text it was tidied from, so the adoption of what was written (`savedFrom`) replaces the latter.
  const seamSaveRef = useRef<{ sent: string; source: string } | null>(null)
  // Every outline write this editor sends goes through the outline's shared queue (lib/saveQueue):
  // one write in flight at a time per file, in the order made, shared with the workspace's writes
  // (ticket 07 — a stale autosave or workspace write can never land after a newer save).
  const provisionalTriggerRef = useRef<{ before: string; from: number; to: number } | null>(null)
  const rollingBackProvisionalRef = useRef(false)
  const applyLayoutRef = useRef<(
    (
      initial: LayoutDef[],
      selected: LayoutDef[],
      options?: ApplyLayoutOptions
    ) => void
  ) | null>(null)
  const insertObjectRef = useRef<ObjectInsertHandler | null>(null)
  const onOpenObjectLayoutFamilyRef = useRef(onOpenObjectLayoutFamily)
  useEffect(() => { onOpenObjectLayoutFamilyRef.current = onOpenObjectLayoutFamily }, [onOpenObjectLayoutFamily])
  const onInsertObjectMenuRef = useRef(onInsertObjectMenu)
  useEffect(() => { onInsertObjectMenuRef.current = onInsertObjectMenu }, [onInsertObjectMenu])
  const currentTalkRef = useRef<string>('')
  // Data-loss guard (2026-07-05): the path whose REAL content is loaded and live in the doc, or null
  // while a load is in flight. The editor is remounted on every talk switch (and nothing else), so a
  // fresh instance starts with `doc: ''`; autosave must stay OFF during that transient (and during the
  // load's own content-replacing dispatch) so the empty doc can never be mistaken for a user edit and
  // written to disk. Set null when a load starts; set to the path only AFTER its content is dispatched.
  const loadedPathRef = useRef<string | null>(null)
  const onCursorLineRef = useRef(onCursorLine)
  useEffect(() => { onCursorLineRef.current = onCursorLine }, [onCursorLine])
  const onPlaceRef = useRef(onPlace)
  useEffect(() => { onPlaceRef.current = onPlace }, [onPlace])
  const lastPlaceRef = useRef<Place | null>(null)
  const onDirtyRef = useRef(onDirty)
  useEffect(() => { onDirtyRef.current = onDirty }, [onDirty])
  const placementRowsRef = useRef(placementRows)
  const placementMemo = useRef<{ doc: unknown; rows: unknown; text: string } | null>(null)
  const onImageWidgetClickRef = useRef(onImageWidgetClick)
  useEffect(() => { onImageWidgetClickRef.current = onImageWidgetClick }, [onImageWidgetClick])
  const onOpenHelpRef = useRef(onOpenHelp)
  useEffect(() => { onOpenHelpRef.current = onOpenHelp }, [onOpenHelp])
  const onProtectedTokenClickRef = useRef(onProtectedTokenClick)
  useEffect(() => { onProtectedTokenClickRef.current = onProtectedTokenClick }, [onProtectedTokenClick])
  const scratchDropRef = useRef(onScratchDrop)
  scratchDropRef.current = onScratchDrop
  const researchDropRef = useRef(onResearchDrop)
  researchDropRef.current = onResearchDrop
  // Ref, not closure: the engagement triggers live in the mount-once view (domEventHandlers +
  // updateListener below), so a prop re-render must be visible there without re-creating the view.
  const onEditorEngagedRef = useRef(onEditorEngaged)
  useEffect(() => { onEditorEngagedRef.current = onEditorEngaged }, [onEditorEngaged])
  const compiledLayoutAtRef = useRef(compiledLayoutAt)
  useEffect(() => { compiledLayoutAtRef.current = compiledLayoutAt }, [compiledLayoutAt])

  // Heading-is-slide (Task 8): a save may come back with `content` — the STAMPED text the main
  // process actually wrote ({id=…} minted for id-less headings); without it the save wrote the text
  // sent, which is the editor's text tidied (textForSave). What was written is adopted into the buffer
  // so the NEXT save sends already-stamped text; without adoption every save would re-send the
  // unstamped buffer (id churn is then only held off by the main process's id-reuse fallback).
  // Adoption is dropped when the doc moved on during the IPC round-trip — a change computed against
  // stale text could clobber what the user just typed; convergence then relies on id reuse until
  // a quieter save lands. The dispatch preserves caret + scroll and DOES re-enter the updateListener
  // → one follow-up autosave of the stamped text — a fixpoint (stamping stamped text is a no-op),
  // never a loop.
  const adoptStampedContent = useCallback((sourceText: string, sentText: string, res: { ok: boolean; content?: string } | false) => {
    if (!res || res.ok !== true) return
    const savedText = typeof res.content === 'string' ? res.content : sentText
    if (savedText === sourceText) return
    const view = viewRef.current
    if (!view) return
    if (view.state.doc.toString() !== sourceText) return // doc moved on while saving: drop, don't clobber
    // One undo step of its own, the tidy-up and the ids together (extensions/savedTextAdoption.ts):
    // ⌘Z takes it back with the user's change below it. CodeMirror maps the live selection through it.
    adoptSavedText(view, sourceText, savedText)
  }, [])

  // Writes `text` to `outlinePath` through the save queue and reports the outcome to the person as
  // every editor save does. Resolves true only when the main process confirms the bytes were written.
  // `source` is the editor's text the save was made from (`text` is it tidied, textForSave); what was
  // written is adopted in its place while the editor still holds it.
  const writeQueued = useCallback(async (outlinePath: string, text: string, source: string = text): Promise<boolean> => {
    // The person discarded this talk (removed on disk): it is never saved again from this editor.
    if (outlineDiskChanges.isDiscarded(outlinePath)) return false
    const res = await queueOutlineWrite(outlinePath, () => window.tw.talk.writeOutline(outlinePath, text))
    // Save-indicator honesty (2026-07-05): only stamp "saved" on a REAL write. If the main-process
    // backstop refused (structurally-empty over a non-empty file), the disk is unchanged — say so
    // instead of a false "saved just now". `res === false` is an IO failure (also not a save).
    if (res && res.ok === true) {
      onSaved?.()
      // Stamped-id adoption (see adoptStampedContent). On the talk-switch flush path the view may
      // already be torn down or repointed — the helper's viewRef/doc-unchanged guards make that a
      // safe no-op (disk is stamped either way; the reload will read the stamped file).
      adoptStampedContent(source, text, res)
      return true
    }
    // External-change guard: the file differs from what this editor holds. The bar at the top of the
    // talk offers the choice; the typing stays in the editor (and in main's recovery copy). A talk
    // switch or a close waits for that choice (useOutlineDiskChange), so a save for a talk this editor
    // no longer shows is rare; it gets words of its own.
    if (noteOutlineSaveReply(res)) {
      if (currentTalkRef.current !== outlinePath || !viewRef.current) {
        notify('Your last edits to the talk you left were not saved: its file differs on disk. They are kept as unsaved text; open the talk again to restore them.', 'warning', 'changed-on-disk')
      }
      return false
    }
    if (res && res.ok === false && res.refused === 'outside-vault') {
      // The talk is not in the current vault (the vault root changed while this window held it).
      notify(res.error || 'This talk is not in your current vault; it was not saved. Switch back to that vault to keep editing it.', 'error', 'save-failed')
    } else if (res && res.ok === false) {
      notify('Save skipped — the app refused to overwrite the outline with empty content. Your file on disk is unchanged.', 'warning', 'save-refused')
    } else {
      // IO failure (write threw: permissions, disk, file vanished). Without this the status
      // bar keeps ageing "Saved Xm ago" while every keystroke is silently lost.
      notify('Save FAILED — the outline could not be written to disk. Your recent edits are not saved.', 'error', 'save-failed')
    }
    return false
  }, [onSaved, adoptStampedContent])

  const scheduleAutosave = useCallback(
    (outlinePath: string, content: string) => {
      // NEVER autosave an empty / whitespace-only doc: an outline never legitimately becomes empty via
      // autosave, so this can only ever be the remount/`doc:''` transient (data-loss guard). The main
      // process also refuses an empty-over-nonempty write — belt-and-braces.
      if (content.trim() === '') return
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = setTimeout(async () => {
        saveTimerRef.current = null
        const view = viewRef.current
        // Tidied, except straight after an undo or a redo (extensions/saveTidyUp.ts), here and at the
        // two saves below. The editor is not tidied first: the tidy-up comes back with the save's ids.
        const normalized = textForSave(view?.state, content)
        await writeQueued(outlinePath, normalized, content)
      }, 1500)
    },
    [writeQueued]
  )

  // Mount editor once
  useEffect(() => {
    if (!containerRef.current) return

    const rollbackProvisionalTrigger = (view: EditorView): boolean => {
      const provisional = provisionalTriggerRef.current
      if (!provisional) return false
      provisionalTriggerRef.current = null
      rollingBackProvisionalRef.current = true
      const current = view.state.doc.toString()
      const change = minimalChange(current, provisional.before)
      view.dispatch({
        changes: { from: change.from, to: change.to, insert: change.insert },
        selection: EditorSelection.cursor(Math.min(provisional.from, provisional.before.length))
      })
      return true
    }

    const view = new EditorView({
      parent: containerRef.current,
      state: EditorState.create({
        doc: '',
        extensions: [
          researchMarkerCompartment.current.of(showResearchInsertion ? researchInsertionMarker : []),
          scratchDropExtension((id, place) => scratchDropRef.current?.(id, place)),
          EditorView.domEventHandlers(researchDropHandlers(file => researchDropRef.current?.(file))),
          EditorView.domEventHandlers({
            // T29b engagement trigger 1: the first pointerdown in the editor surface — clicks in
            // the text, the gutter, any widget chrome (observational only; never consumes).
            pointerdown() {
              onEditorEngagedRef.current?.()
              return false
            },
            paste(event: ClipboardEvent) {
              const items = event.clipboardData?.items
              if (!items) return false
              for (const item of Array.from(items)) {
                const isGif = item.type === 'image/gif'
                const isVideo = item.type.startsWith('video/')
                // Video + animated-GIF route to the media pipeline (ADR-0028); GIFs must NOT go
                // through the image path (sharp would flatten them to a single WebP frame).
                if (isVideo || isGif) {
                  event.preventDefault()
                  const blob = item.getAsFile()
                  if (!blob) return true
                  const ext = isGif ? 'gif' : item.type.replace('video/', '')
                  blob.arrayBuffer().then(async (bytes) => {
                    const res = await window.tw.asset.addVideo({ bytes, ext })
                    insertMediaResult(viewRef.current, res, 'caret')
                  }).catch(console.error)
                  return true
                }
                if (item.type.startsWith('image/')) {
                  event.preventDefault()
                  const blob = item.getAsFile()
                  if (!blob) return true
                  const ext = item.type.replace('image/', '').replace('jpeg', 'jpg')
                  blob.arrayBuffer().then(async (arrayBuffer) => {
                    const result = await window.tw.asset.pasteImage(arrayBuffer, ext, currentTalkRef.current ?? undefined)
                    if (result && viewRef.current) {
                      const pos = viewRef.current.state.selection.main.head
                      const id = result.id  // already "img-XXXXXXX"
                      // On a heading line the picture goes under the heading's id and layout lines, not between them.
                      insertBlockAfterLine(viewRef.current, pos, '\n![](' + id + ')\n')
                    } else if (!result) {
                      // Same never-fail-silently rule as clips (ADR-0023) — a paste that inserts
                      // nothing with no feedback reads as "the paste didn't register".
                      notify('Could not paste the image — it was not added to the outline.', 'error', 'addmedia')
                    }
                  }).catch((e) => { console.error(e); notify('Could not paste the image — it was not added to the outline.', 'error', 'addmedia') })
                  return true
                }
              }
              const text = event.clipboardData?.getData('text/plain') ?? ''
              // Whole slides going in as slides are not read as an SVG or a table to convert.
              const asSlides = Boolean(text && viewRef.current && wouldPasteAsSlides(viewRef.current, text))
              if (text && !asSlides && isSvgText(text)) {
                event.preventDefault()
                const result = sanitiseSvg(text.trim())
                if ('error' in result) {
                  notify('Pasted SVG was rejected: ' + result.error, 'error', 'objects')
                  return true
                }
                const v = viewRef.current
                if (!v) return true
                pasteBlockAtSelection(v, '```svg\n' + result.svg + '\n```\n')
                return true
              }
              const carriesPastedAssets = /!\[[^\]]*\]\(assets\/[^)]+\.(?:png|jpe?g|gif|webp)\)/i.test(text)
              const pasteTableKind = carriesPastedAssets || asSlides ? null : tablePasteKind(text)
              if (text && pasteTableKind) {
                event.preventDefault()
                const cells = parseTablePaste(text)
                const model = {
                  cells,
                  alignments: Array(cells[0]?.length ?? 1).fill('left') as TableAlignment[]
                }
                const v = viewRef.current
                if (!v) return true
                pasteBlockAtSelection(v, serialiseTable(model) + '\n')
                return true
              }
              // Text paste of slide markdown: relative image refs (assets/X.png) come from the
              // SOURCE talk and would go grey here. Materialise them into the vault pool (img-<hash>)
              // by filename so a pasted SEQUENCE's images resolve (the picker does this per-slide;
              // text paste didn't). Only intercept when the text actually carries such refs.
              const pastedText = event.clipboardData?.getData('text/plain')
              if (pastedText && carriesPastedAssets) {
                event.preventDefault()
                // Whole slides pasted on a heading line or between slides go in as whole slides
                // (slideCutPaste.ts); anywhere else the text replaces the selection as before.
                const put = (markdown: string): void => {
                  const v = viewRef.current
                  if (v && !pasteSlideTextAtCaret(v, markdown, pastedText)) pasteTextAtSelection(v, markdown)
                }
                window.tw.talk
                  .materializePastedAssets(pastedText)
                  .then((res) => put(res?.markdown ?? pastedText))
                  .catch(() => put(pastedText))
                return true
              }
              if (pastedText && asSlides && viewRef.current) {
                event.preventDefault()
                pasteSlideTextAtCaret(viewRef.current, pastedText)
                return true
              }
              // Text with a line break pasted with the caret at the end of a slide title: its first line
              // stays on the title, the rest goes under the title's id and layout lines. Text whose first
              // line is a block goes under them whole (headingEndInsert.ts startsWithBlockLine). A block
              // is: a code fence opener (backticks or tildes), a table row followed by its separator row,
              // a line that is only a picture or clip, a line that is only a component ([Embed: …],
              // [Simulation: …], [Video: …], [QR: …], [Action: …], a URL alone), an HTML block opener.
              // Not a block (so prose, first line on the title): a line that merely starts with `|` or
              // with inline code, a picture or component inside a sentence, a heading, a list, a
              // quotation. Anything else is CodeMirror's own paste.
              if (pastedText && viewRef.current && pasteAtHeadingEnd(viewRef.current, pastedText)) {
                event.preventDefault()
                return true
              }
              return false
            },
            // Drag-and-drop a media FILE into the editor → store + insert at the drop point.
            // Video/GIF go to the media pipeline (by path, so we never pipe big bytes over IPC);
            // images keep the existing path. Text drags are left to CodeMirror's drag-to-move.
            drop(event: DragEvent, view) {
              const files = event.dataTransfer?.files
              if (!files || files.length === 0) return false
              const arr = Array.from(files)
              const mediaFile = arr.find((f) => f.type.startsWith('video/') || f.type === 'image/gif')
              const svgFile = arr.find(isSvgFile)
              const imageFile = arr.find((f) =>
                f.type.startsWith('image/') && f.type !== 'image/gif' && !isSvgFile(f)
              )
              const v = viewRef.current
              const dropPos = v ? (v.posAtCoords({ x: event.clientX, y: event.clientY }) ?? v.state.selection.main.head) : 0
              if (mediaFile) {
                event.preventDefault()
                const ext = mediaFile.type === 'image/gif' ? 'gif'
                  : (mediaFile.type.replace('video/', '') || (mediaFile.name.split('.').pop() || '').toLowerCase())
                const path = window.tw.asset.pathForFile(mediaFile)
                window.tw.asset.addVideo({ path, ext })
                  .then((res) => insertMediaResult(viewRef.current, res, dropPos))
                  .catch((e) => { console.error(e); notify('Could not add the dropped clip — it was not added to the outline.', 'error', 'addmedia') })
                return true
              }
              if (svgFile) {
                event.preventDefault()
                svgFile.text().then((text) => {
                  const result = sanitiseSvg(text.trim())
                  if ('error' in result) {
                    notify('Dropped SVG was rejected: ' + result.error, 'error', 'objects')
                    return
                  }
                  const current = viewRef.current
                  if (!current) return
                  const insert = '\n\n```svg\n' + result.svg + '\n```\n'
                  insertBlockAfterLine(current, dropPos, insert, { caret: insert.length })
                }).catch((error) => {
                  console.error(error)
                  notify('Dropped SVG was rejected: the file could not be read', 'error', 'objects')
                })
                return true
              }
              if (imageFile) {
                event.preventDefault()
                const ext = imageFile.type.replace('image/', '').replace('jpeg', 'jpg')
                imageFile.arrayBuffer().then(async (buf) => {
                  const result = await window.tw.asset.pasteImage(buf, ext, currentTalkRef.current ?? undefined)
                  if (result && viewRef.current) {
                    const picture = '\n![](' + result.id + ')'
                    insertBlockAfterLine(viewRef.current, dropPos, picture + '\n', { caret: picture.length })
                  } else if (!result) {
                    notify('Could not add the dropped image — it was not added to the outline.', 'error', 'addmedia')
                  }
                }).catch((e) => { console.error(e); notify('Could not add the dropped image — it was not added to the outline.', 'error', 'addmedia') })
                return true
              }
              return false
            }
          }),
          slideNumberGutterExtension,
          historyCompartment.of(history({ minDepth: 200 })),
          // A web link pasted or typed into a quote slide's source line makes the slide a web page in the same undo step (spec 3.1).
          quoteLinkFormExtension(() => compiledLayoutAtRef.current),
          highlightActiveLine(),
          markdown({ base: markdownLanguage, codeLanguages: languages, extensions: [imageParagraphNoFold] }),
          // Folding: collapse any heading section or list subtree (gutter arrows + Ctrl-Shift-[/]).
          codeFolding(),
          foldGutter(),
          outlineFoldService,
          // {-triggered autocomplete for layout triggers and frame modifiers (Tier 1).
          // The opening token is provisional until a completion closes it. Escape and click-away
          // restore the byte-exact pre-picker document, before autosave/id stamping can see it.
          // The extension comes first at highest precedence so scene C can use the first Escape to
          // back up from options; when no chained step is active, the rollback binding below wins.
          triggerCompleteExtension({
            onInsertObject: (kind, request) => {
              // The object splice owns removal of a provisional chart token. Clear the rollback
              // record first so its queued guard cannot restore the superseded picker bytes.
              provisionalTriggerRef.current = null
              insertObjectRef.current?.(kind, request)
            }
          }),
          Prec.highest(keymap.of([{
            key: 'Escape',
            run: (view) => rollbackProvisionalTrigger(view)
          }])),
          EditorView.domEventHandlers({
            blur: (_event, view) => {
              setTimeout(() => {
                if (!view.hasFocus) rollbackProvisionalTrigger(view)
              }, 0)
              return false
            }
          }),
          // `{id=…}` and trigger-line tokens rendered as atomic, machine-managed chips — cursor
          // skips them, delete removes a whole token, ids can't be nibbled at all, and clicking a
          // chip opens the right editor surface (where-used / ⌘L picker) instead of a caret.
          tokenProtectExtension(() => onProtectedTokenClickRef.current ?? null),
          // ⌘X / ⌘C with the caret on a slide's heading take the whole slide; a selection holding a
          // whole title takes its slide with it (extensions/slideCutPaste.ts).
          slideCutCopyExtension(),
          // Slide Focus scoped view (ADR-0032, Task 8). Inert until a range is set (via the
          // focusRange prop / setFocusRange effect); then hides every line outside the focused
          // block, guards edits from touching outside it, and keeps the caret inside — composing
          // with tokenProtectExtension above (all id/trigger/heading guards stay active in-band).
          focusScopeExtension(),
          // Amber mark + inline note on the heading of a slide whose text is too long (ADR-0033 §1).
          textFitWarningExtension,
          // YAML frontmatter rendered as a typed table (raw ↔ table toggle).
          frontmatterTableExtension(),
          // The strips' buttons (ticket 08): Plan a run opens the workspace's plan sheet; Open run goes to Sessions.
          workStripHandlersFacet.of({
            planRun: () => onPlanRunRef.current?.(),
            openRun: (ref) => { void window.tw.tools.openRun(ref.talkSlug, ref.runId, ref.vaultId) }
          }),
          // ==mark== stays visible while authoring without changing the outline's Markdown source.
          inlineMarkExtension,
          // <kbd>⌘K</kbd> shows as a key cap off the caret's line, as its source on it (ticket 05).
          keyCapExtension,
          // RIVER object blocks: slide-white rendered widgets in the warm-paper outline flow.
          objectBlocksExtension({
            onInsertMenu: (coords, consumeFence) => onInsertObjectMenuRef.current?.(coords, consumeFence),
            cheatSheet: {
              isShortcut: (event) => eventMatchesEffectiveShortcut(event, 'app.help'),
              request: () => onOpenHelpRef.current?.(),
              isFinishShortcut: (event) =>
                eventMatchesEffectiveShortcut(event, 'editor.object-finish', 'object-finish'),
              isLeaveShortcut: (event) =>
                eventMatchesEffectiveShortcut(event, 'editor.object-leave', 'object-leave'),
              // Keys inside the object editors (row moves, Discard) are registered and rebindable.
              matches: (event, shortcutId) =>
                eventMatchesEffectiveShortcut(event, shortcutId, shortcutId.replace(/^editor\./, ''))
            }
          }),
          objectDeletionNotices,
          // Card file status (missing, outside the vault): main answers only for this window's own talk.
          objectStatusSource.of({
            scope: () => currentTalkRef.current,
            ask: async (refs) => {
              const outlinePath = currentTalkRef.current
              if (!outlinePath) return null
              const answer = await window.tw.objects.status(outlinePath, refs)
              if (!answer?.ok || currentTalkRef.current !== outlinePath) return null
              return new Map(answer.statuses.map((s): [string, CardFileStatus] => [s.ref, { state: s.state, path: s.path }]))
            }
          }),
          objectStatusRequests,
          // Card header actions: Open and Reveal through the shell channels (main checks the path again
          // then); Replace file through main's HTML page picker and copy, for this talk only.
          cardActionHost.of({
            openPath: (path) => window.tw.shell.openPath(path),
            showInFolder: (path) => window.tw.shell.showInFolder(path),
            openExternal: (url) => window.tw.shell.openExternal(url),
            copyText: (text) => navigator.clipboard.writeText(text),
            captureEmbed: (headingLine, pageUrl) => captureEmbedAtRef.current?.(headingLine, pageUrl),
            earlierViews: async (pageUrl) => {
              const talk = currentTalkRef.current
              if (!talk) return null
              const answer = await window.tw.objects.earlierViews(talk, pageUrl)
              return answer.ok && currentTalkRef.current === talk ? answer.views : null
            },
            chooseReplacementPage: async () => {
              const talk = currentTalkRef.current
              if (!talk) return null
              const choice = await window.tw.htmlPage.choose(talk)
              if (choice === null) return null
              if (!choice.ok) { notify(choice.message, 'error', 'card-replace'); return null }
              if (currentTalkRef.current !== talk) { notify(HTML_PAGE_INSERT_TEXT.talkChangedBeforeCopy, 'warning', 'card-replace'); return null }
              const result = await window.tw.htmlPage.import(choice.token, talk)
              if (!result.ok) { notify(result.message, 'error', 'card-replace'); return null }
              if (currentTalkRef.current !== talk) { notify(HTML_PAGE_INSERT_TEXT.talkChangedAfterCopy(result.embedPath), 'warning', 'card-replace'); return null }
              const named = result.localReferences.length ? ` ${HTML_PAGE_INSERT_TEXT.namedFiles(result.localReferences)}` : ''
              return { ref: result.embedPath, note: `${HTML_PAGE_INSERT_TEXT.onlyThisFile}${named}`, warn: result.localReferences.length > 0 }
            }
          }),
          // Saved-view thumbnails on a web page card: the image widget's own local resolver; never remote.
          cardMediaFacet.of({
            resolveImage: (src) => editorImageUrl(
              src,
              vaultRoot ?? null,
              currentTalkRef.current.replace(/\/[^/]*$/, '') || null
            )
          }),
          // Plain-text find (⌘F opens the search panel) + match highlighting.
          search({ top: true }),
          highlightSelectionMatches(),
          // ⌘F opens CodeMirror's find panel (Find in outline, app.find); the Guide counts it when it opened.
          keymap.of([{ key: 'Mod-f', run: (view) => { const opened = openSearchPanel(view); if (opened) commandRan('app.find'); return opened }, scope: 'editor search-panel' }]),
          // One list (extensions/editorBaseKeymap.ts): the Plain view's guard is built from the same one.
          keymap.of([...editorBaseKeymap]),
          outlinerKeymapExtension(),
          viewCompartment.of(viewModeExtension(viewModeRef.current, plainViewOptions(marginMenuHandlers))),
          plainTypeCompartment.of(viewModeRef.current === 'plain' ? plainTypeExtension(plainLookRef.current) : []),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              // T29b engagement trigger 2: a document change made BY THE USER — typing into an
              // already-focused editor is a keydown that edits the doc, so a keyboard-only user
              // engages exactly like a pointer user. Programmatic dispatches (load, adoption,
              // replaceDoc, undo) carry no 'input' userEvent and never fire this.
              if (update.transactions.some((tr) => tr.isUserEvent('input'))) onEditorEngagedRef.current?.()
              const content = update.state.doc.toString()
              if (rollingBackProvisionalRef.current) {
                rollingBackProvisionalRef.current = false
                return
              }
              const head = update.state.selection.main.head
              const provisional = provisionalTriggerAtCursor(content, head)
              if (provisional) {
                const existing = provisionalTriggerRef.current
                provisionalTriggerRef.current = {
                  before: existing?.before ?? update.startState.doc.toString(),
                  from: existing?.from ?? provisional.from,
                  to: provisional.to
                }
                return
              }
              const pending = provisionalTriggerRef.current
              if (pending && !content.slice(pending.from, head).includes('}')) {
                queueMicrotask(() => {
                  const currentView = viewRef.current
                  if (currentView && provisionalTriggerRef.current === pending) {
                    rollbackProvisionalTrigger(currentView)
                  }
                })
                return
              }
              // A completion inserted its closing brace: the edit is now authored and may cross
              // the parent/autosave boundary normally.
              provisionalTriggerRef.current = null
              onContentChange(content)
              // Autosave ONLY once this talk's real content is loaded AND the doc still belongs to the
              // active talk — never during the fresh-mount `doc:''` transient or the load's own initial
              // content dispatch (data-loss guard, 2026-07-05). scheduleAutosave also skips empty text.
              if (loadedPathRef.current && loadedPathRef.current === currentTalkRef.current) {
                onDirtyRef.current?.(true)
                scheduleAutosave(currentTalkRef.current, content)
              }
              // (The `/` auto-popup was removed — it left stray slashes behind. The layout picker is
              // now ⌘L, which places the trigger on the slide's Trigger line with no slash to clean up.
              // See registerInsertLayout below + WorkspaceLayout's global ⌘L handler.)
            }

            // Clicking elsewhere in the editor dismisses autocomplete without blurring CodeMirror.
            // Treat that exactly like backdrop click-away: the provisional token never becomes text.
            if (update.selectionSet && provisionalTriggerRef.current) {
              const pending = provisionalTriggerRef.current
              const head = update.state.selection.main.head
              if (head < pending.from || head > pending.to) {
                queueMicrotask(() => {
                  const currentView = viewRef.current
                  if (currentView && provisionalTriggerRef.current === pending) {
                    rollbackProvisionalTrigger(currentView)
                  }
                })
              }
            }

            // Report the 1-based line of the main cursor on selection change.
            if (update.selectionSet && onCursorLineRef.current) {
              const head = update.state.selection.main.head
              const lineNumber = update.state.doc.lineAt(head).number
              onCursorLineRef.current(lineNumber)
            }

            // The caret's place (onboarding ticket 02), read from the caret's line only: no parse.
            // Reported only when it changes, so typing within a line costs one regex pass.
            if ((update.selectionSet || update.docChanged) && onPlaceRef.current) {
              const doc = update.state.doc
              const line = doc.lineAt(update.state.selection.main.head)
              const place = placeOfLine(line.text, line.number, (n) => (n >= 1 && n <= doc.lines ? doc.line(n).text : ''))
              if (place !== lastPlaceRef.current) {
                lastPlaceRef.current = place
                onPlaceRef.current(place)
              }
            }
          }),
          // Keeps a save's adopted text marked as the save's undo step, and sends the Edit menu's
          // Undo and Redo through the undo that takes that step with the change below it.
          savedTextAdoption(),
          saveTidyUp(),
          imageWidgetExtension({
            vaultRoot: vaultRoot ?? null,
            // currentTalkRef holds the active outline path; derive its dir (reused across talks).
            talkDir: () => currentTalkRef.current.replace(/\/[^/]*$/, '') || null,
            onClick: (id) => onImageWidgetClickRef.current?.(id),
            placementForLine: (line, doc) => {
              const rows = placementRowsRef.current
              if (!rows) return null
              const memo = placementMemo.current
              const text = memo && memo.doc === doc ? memo.text : doc.toString()
              placementMemo.current = { doc, rows, text }
              return imagePlacementForLine(rows, text, line)
            }
          }),
          EditorView.lineWrapping
        ]
      })
    })

    viewRef.current = view

    return () => {
      // Cancel any pending autosave from THIS instance before it unmounts. A stale timer that fired
      // after the remount could write into the next instance's `doc:''` transient, or clobber the
      // authoritative text a reorder/detach/publish flow just wrote to disk before remounting — those
      // flows persist their own content, so the editor's pending save is redundant here (data-loss
      // guard, 2026-07-05).
      if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
      view.destroy()
      viewRef.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // The work files and Runs the strips under the Metadata table draw from (ticket 08), from the open talk's
  // vault (every open vault's Runs and the current vault's files only when the talk does not say). Read again when a
  // Run is saved, when the window regains focus and when a minute has passed (a window opens or closes).
  useEffect(() => {
    let cancelled = false
    const load = (): void => {
      void loadWorkStripsData(talk.slug, talk.vaultId).then((data) => {
        if (!cancelled) viewRef.current?.dispatch({ effects: setWorkStripsData.of(data) })
      })
    }
    load()
    const offMeta = window.tw.vault.onTalkMetaUpdated(load)
    window.addEventListener('tw-runs-changed', load)
    window.addEventListener('focus', load)
    const timer = window.setInterval(load, 60_000)
    return () => {
      cancelled = true
      offMeta()
      window.removeEventListener('tw-runs-changed', load)
      window.removeEventListener('focus', load)
      window.clearInterval(timer)
    }
  }, [talk.slug, talk.vaultId])

  // Re-bind the outliner keymap live when the user customises shortcuts in Settings.
  useEffect(() => {
    function reconfigure(): void {
      const v = viewRef.current
      if (!v) return
      v.dispatch({
        effects: keymapCompartment.reconfigure(Prec.highest(keymap.of(buildEditorKeyBindings())))
      })
    }
    window.addEventListener(KEYMAP_CHANGED_EVENT, reconfigure)
    return () => window.removeEventListener(KEYMAP_CHANGED_EVENT, reconfigure)
  }, [])

  // Slide Focus (ADR-0032, Task 8): push the focusRange prop into the editor's focus-scope field via
  // an effect — no remount, no compartment churn. undefined/null exits focus (the extension is then
  // fully inert). Task 9 supplies this prop from the Slide Focus surface; today nothing sets it.
  // Plain / Markdown tab: swap the compartment's contents. The document, selection, scroll and
  // history are untouched (reconfigure changes extensions only).
  useEffect(() => {
    viewModeRef.current = viewMode
    viewRef.current?.dispatch({ effects: [
      viewCompartment.reconfigure(viewModeExtension(viewMode, plainViewOptions(marginMenuHandlers))),
      plainTypeCompartment.reconfigure(viewMode === 'plain' ? plainTypeExtension(plainLookRef.current) : [])
    ] })
  }, [viewMode])

  // A change of font or size in Settings: only the type compartment is swapped; the caret stays.
  useEffect(() => {
    viewRef.current?.dispatch({ effects: plainTypeCompartment.reconfigure(viewModeRef.current === 'plain' ? plainTypeExtension(plainLook) : []) })
  }, [plainLook.font, plainLook.size])

  // The Plain margin's labels. Pushed again after a tab switch, because the margin's state lives in
  // the view compartment and starts empty when Plain comes back.
  const marginLabelsKey = JSON.stringify(marginLabels ?? [])
  useEffect(() => {
    const v = viewRef.current
    if (v && viewMode === 'plain') setMarginLabels(v, marginLabels ?? [])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marginLabelsKey, talk.outlinePath, viewMode])

  useEffect(() => {
    const v = viewRef.current
    if (v) setFocusRange(v, focusRange ?? null)
  }, [focusRange])

  // ADR-0033 §1: the too-long-text notes ride an effect, so a recompile marks the heading without a remount.
  useEffect(() => {
    const v = viewRef.current
    if (v) setTextFitNotes(v, textFitNotes ?? [])
  }, [textFitNotes, talk.outlinePath])

  // Image placement labels follow the compiler: redraw the previews when the compiled rows change.
  useEffect(() => {
    placementRowsRef.current = placementRows
    viewRef.current?.dispatch({ effects: imagePlacementsChanged.of(null) })
  }, [placementRows])

  // Slide numbers beside headings (replaces line numbers); same effect-driven refresh, no remount.
  // Keyed on the line list's CONTENT: slideLines is rebuilt on every keystroke but only changes
  // value on a recompile, and between compiles the gutter tracks edits itself.
  const slideLinesKey = (slideLines ?? []).join(',')
  useEffect(() => {
    const v = viewRef.current
    if (v) setSlideNumberLines(v, slideLines ?? [])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slideLinesKey, talk.outlinePath])

  // e2e seam (mirrors KEYMAP_CHANGED_EVENT): the diagnose harness drives focus by dispatching a
  // `tw-focus-scope` window event carrying {from,to} | null, so the scoped view can be exercised in
  // real Electron before Task 9's Slide Focus surface exists. Harmless in production (nobody else
  // dispatches it).
  useEffect(() => {
    function onFocusEvent(e: Event): void {
      const v = viewRef.current
      if (!v) return
      const detail = (e as CustomEvent).detail as FocusRange | null | undefined
      setFocusRange(v, detail ?? null)
    }
    window.addEventListener(FOCUS_SCOPE_EVENT, onFocusEvent)
    return () => window.removeEventListener(FOCUS_SCOPE_EVENT, onFocusEvent)
  }, [])

  // Load content when talk changes
  useEffect(() => {
    currentTalkRef.current = talk.outlinePath
    // Autosave stays OFF until this talk's content is actually in the doc, and any timer still pending
    // from the previous talk/instance is cancelled — so neither the empty transient nor a stale save
    // can write during the load (data-loss guard, 2026-07-05).
    loadedPathRef.current = null
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
    const pathAtLoad = talk.outlinePath
    async function load() {
      // forEditor: the text loaded here is what the external-change guard compares the file against.
      const content = await window.tw.talk.readOutline(pathAtLoad, { forEditor: true })
      if (content === null && currentTalkRef.current === pathAtLoad) {
        notify('This talk could not be opened: it is not in your current vault, or its file could not be read.', 'warning', 'talk-not-read')
      }
      // Guard the whole apply against a remount that happened while readOutline was in flight: only
      // apply if the view is still alive AND still bound to the path we read (currentTalkRef moved on
      // otherwise). The content-replacing dispatch runs while loadedPathRef is null, so its docChanged
      // never triggers autosave; we mark the path loaded ONLY after that dispatch lands.
      if (viewRef.current && content !== null && currentTalkRef.current === pathAtLoad) {
        viewRef.current.dispatch({
          changes: { from: 0, to: viewRef.current.state.doc.length, insert: content }
        })
        // RESET the undo stack across the talk boundary: detach + re-attach history() so the
        // load dispatch above (and every edit belonging to the PREVIOUS talk) is not undoable
        // in this one. ⌘Z in a freshly opened talk must be a no-op, never a revert-to-empty.
        viewRef.current.dispatch({ effects: historyCompartment.reconfigure([]) })
        viewRef.current.dispatch({ effects: historyCompartment.reconfigure(history({ minDepth: 200 })) })
        loadedPathRef.current = pathAtLoad
        // A fresh load: whatever the guard reported for this talk is settled by this text; then offer
        // any unsaved text a refused save kept (an earlier session ended before the person chose).
        outlineDiskChanges.loaded(pathAtLoad)
        void lookForRecovery(pathAtLoad, content, {
          store: outlineDiskChanges,
          recovery: (path) => window.tw.talk.outlineRecovery?.(path) ?? Promise.resolve(null),
          discardRecovery: (path) => window.tw.talk.discardOutlineRecovery?.(path) ?? Promise.resolve(false),
        })
        onContentChange(content)
      }
    }
    load()
  }, [talk.outlinePath]) // eslint-disable-line react-hooks/exhaustive-deps

  // Register the imperative insert-at-cursor channel (ADR-0013). We read the live
  // view from viewRef at call time so the splice always lands at the CURRENT caret,
  // however long after registration the parent invokes it. The text goes in after
  // the caret's line (with surrounding blank lines) as its own block; where exactly is
  // caretLineInsertion (headingEndInsert.ts). The resulting docChanged drives
  // onContentChange + autosave.
  useEffect(() => {
    if (!registerInsert) return
    registerInsert((text: string) => {
      const view = viewRef.current
      if (!view) return
      // On a heading line a component goes under the heading's id and layout lines; whole slides go
      // after the heading's whole block, so its body stays its own (headingEndInsert.ts).
      insertAtCaretLine(view, text)
      view.focus()
    })
  }, [registerInsert])

  // Every object insertion surface reaches this one live-caret function. The inserted source is
  // blank-line separated, and block-backed objects open immediately in the existing RIVER editor.
  useEffect(() => {
    if (!registerInsertObject) return
    const insertObject: ObjectInsertHandler = (kind, request) => {
      if (kind === 'diagram') {
        onOpenObjectLayoutFamilyRef.current?.(kind)
        return
      }
      const view = viewRef.current
      if (!view) return
      const entry = LAYOUTS.find((candidate) => candidate.name === kind)
      if (!entry?.object) return

      const ownsTrigger = kind === 'mindmap'
      if (ownsTrigger) {
        const lines = view.state.doc.toString().split('\n')
        const caretLine = view.state.doc.lineAt(view.state.selection.main.head).number
        let triggerLine = ''
        for (let n = caretLine; n >= 1; n -= 1) {
          if (!/^(#{1,6})\s/.test(lines[n - 1] ?? '')) continue
          triggerLine = logicalTriggerBlockAfterHeading(lines, n - 1)?.line ?? ''
          break
        }
        const initial = selectionFromTriggerLine(triggerLine, LAYOUTS)
        applyLayoutRef.current?.(
          initial,
          toggleLayoutSelection(initial, entry)
        )
      }

      const skeleton = entry.object.emptySkeleton()
      const chartToken = request?.triggerToken ?? 'chart=bar'
      const block = entry.object.storage === 'fence' && !/^\s*(?:`{3,}|~{3,})/.test(skeleton)
        ? buildFencedObjectSource(chartToken.replace(/^\{|\}$/g, ''), skeleton)
        : skeleton
      const openOffset = entry.object.storage === 'fence' ? block.indexOf('\n') + 1 : 0
      const prepared = prepareObjectInsertDocument(
        view.state.doc.toString(),
        view.state.selection.main.head,
        request?.replace
      )
      if (prepared.doc !== view.state.doc.toString()) {
        const change = minimalChange(view.state.doc.toString(), prepared.doc)
        view.dispatch({
          changes: change,
          selection: { anchor: prepared.at }
        })
      }
      const head = view.state.selection.main.head
      // A caret inside the heading does not map past a Trigger-line insertion at heading.to.
      // Every object block goes below the heading's id and layout lines (headingEndInsert.ts), so
      // the id line stays directly under its heading.
      const splice = planObjectBlockSplice(
        view.state.doc.toString(),
        blockAnchorAfterLine(view.state.doc.toString(), head),
        block,
        openOffset
      )
      view.dispatch({
        changes: { from: splice.from, to: splice.to, insert: splice.insert },
        selection: { anchor: splice.openFrom },
        effects: setOpenObjectBlock.of({ from: splice.blockFrom, to: splice.blockTo }),
        scrollIntoView: true
      })
      view.focus()
    }
    insertObjectRef.current = insertObject
    registerInsertObject(insertObject)
    return () => {
      if (insertObjectRef.current === insertObject) insertObjectRef.current = null
    }
  }, [registerInsertObject])

  // Expose fold/unfold-all so the command palette can collapse/expand the whole outline.
  useEffect(() => {
    const cmds: Parameters<NonNullable<typeof registerEditorCommands>>[0] = {
      foldAll: () => { const v = viewRef.current; if (v) { foldAll(v); v.focus() } },
      unfoldAll: () => { const v = viewRef.current; if (v) { unfoldAll(v); v.focus() } },
      move: (line, dir) => {
        const v = viewRef.current; if (!v) return
        const p = v.state.doc.line(Math.min(Math.max(line, 1), v.state.doc.lines)).from
        v.dispatch({ selection: EditorSelection.cursor(p) })
        moveNode(v, dir)
      },
      reLevel: (line, dir, withSubtree) => {
        const v = viewRef.current; if (!v) return
        const p = v.state.doc.line(Math.min(Math.max(line, 1), v.state.doc.lines)).from
        v.dispatch({ selection: EditorSelection.cursor(p) })
        reLevel(v, dir, withSubtree)
      },
      moveTo: (fromLine, toLine) => { const v = viewRef.current; if (v) moveBlockTo(v, fromLine, toLine) },
      moveToEnd: (fromLine) => { const v = viewRef.current; if (v) moveBlockToEnd(v, fromLine) },
      moveInto: (fromLine, sectionLine) => { const v = viewRef.current; if (v) moveBlockInto(v, fromLine, sectionLine) },
      // Undo/redo the editor's history — lets the grid/slides views route ⌘Z to a reorder they made
      // without the editor being focused. No view.focus() so the caller (e.g. grid) keeps focus.
      // The same undo and redo as ⌘Z and ⇧⌘Z (a save's step goes with the change it was made for).
      undo: () => { const v = viewRef.current; if (v) undoWithSave(v) },
      redo: () => { const v = viewRef.current; if (v) redoWithSave(v) },
      newSlide: () => { const v = viewRef.current; if (v) runActionBarEditing(v, 'new-slide') },
      // ADR-0032 (round-3 A1): the starter board after the current slide, its question selected.
      insertBoardSlide: () => {
        const v = viewRef.current; if (!v) return null
        // The starter carries its id from the start, so the Board section can edit it before the
        // first save stamps anything (a slide is found by its id).
        const text = v.state.doc.toString()
        const plan = boardStarterInsertion(text, v.state.selection.main.head, mintBoardSlideId(text))
        v.dispatch({
          changes: { from: plan.at, insert: plan.insert },
          selection: EditorSelection.range(plan.questionFrom, plan.questionTo),
          effects: EditorView.scrollIntoView(plan.questionFrom, { y: 'center' })
        })
        v.focus()
        return v.state.doc.lineAt(plan.questionFrom).number
      },
      promoteHeading: () => { const v = viewRef.current; if (v) reLevel(v, -1, false) },
      demoteHeading: () => { const v = viewRef.current; if (v) reLevel(v, 1, false) },
      bulletedList: () => { const v = viewRef.current; if (v) runActionBarEditing(v, 'bulleted-list') },
      numberedList: () => { const v = viewRef.current; if (v) runActionBarEditing(v, 'numbered-list') },
      normalizeTriggers: () => { const v = viewRef.current; if (v) normalizeTriggersCommand(v) },
      setQuoteForm: (form, compiledLayoutAt) => { const v = viewRef.current; if (v) { setQuoteFormAtCursor(v, form, compiledLayoutAt); v.focus() } },
      deleteSlide: () => { const v = viewRef.current; if (v) { deleteSlideAtCursor(v); v.focus() } },
      // Cancel the pending debounce and write the CURRENT doc immediately, so a caller that reads the
      // file straight after (detach) never races the 1.5s autosave. No-op-safe when nothing is pending.
      flushSave: async () => {
        // A pending edit is written immediately. Even without a pending debounce, this boundary applies
        // ADR-0020 D4's silent position-only normalisation before talk-switch/IO consumers proceed.
        const hadPendingSave = saveTimerRef.current !== null
        if (saveTimerRef.current) {
          clearTimeout(saveTimerRef.current)
          saveTimerRef.current = null
        }
        const v = viewRef.current
        if (!v) return
        const current = v.state.doc.toString()
        const text = textForSave(v.state, current)
        // Nothing pending and nothing to tidy: nothing to write. (The tidy-up comes back into the
        // editor with the save's ids, after the write: writeQueued.)
        if (text === current && !hadPendingSave) return
        // Never flush an empty doc (a fresh-mount transient before load) or one whose content isn't the
        // loaded talk's yet — the caller (detach / switch) only needs the just-typed real text.
        if (text.trim() === '' || loadedPathRef.current !== currentTalkRef.current) return
        await writeQueued(currentTalkRef.current, text, current)
      },
      scrollCursorIntoView: () => {
        const v = viewRef.current
        if (!v) return
        const head = v.state.selection.main.head
        v.dispatch({ effects: EditorView.scrollIntoView(head, { y: 'start' }) })
        v.focus()
      },
      cursorCoords: () => {
        const v = viewRef.current
        if (!v) return null
        const r = v.coordsAtPos(v.state.selection.main.head)
        return r ? { x: r.left, y: r.bottom + 4 } : null
      },
      placeCursorAtCoords: (x, y) => {
        const v = viewRef.current
        if (!v) return
        const pos = v.posAtCoords({ x, y })
        if (pos != null) v.dispatch({ selection: EditorSelection.cursor(pos) })
      },
      // Cut/copy re-focus the editor then run the browser command, so CodeMirror's own
      // clipboard handlers apply (same semantics as ⌘X/⌘C, including empty-selection rules).
      cutSelection: () => { const v = viewRef.current; if (v) { v.focus(); document.execCommand('cut') } },
      copySelection: () => { const v = viewRef.current; if (v) { v.focus(); document.execCommand('copy') } },
      selectionText: () => { const v = viewRef.current; if (!v) return ''; const { from, to } = v.state.selection.main; return v.state.sliceDoc(from, to) },
      pasteClipboard: () => {
        const v = viewRef.current
        if (!v) return
        v.focus()
        navigator.clipboard.readText().then(async (text) => {
          if (!text) return
          const clipboardText = text
          // Same source-talk asset rule as the DOM paste handler: relative image refs are
          // materialised into the vault pool so a pasted slide's images resolve here too.
          if (/!\[[^\]]*\]\(assets\/[^)]+\.(?:png|jpe?g|gif|webp)\)/i.test(text)) {
            try {
              const res = await window.tw.talk.materializePastedAssets(text)
              text = res?.markdown ?? text
            } catch { /* fall back to the raw text */ }
          }
          const view = viewRef.current
          if (view && !pasteSlideTextAtCaret(view, text, clipboardText)) pasteTextAtSelection(view, text)
        }).catch(() => notify('Couldn’t read the clipboard — paste with ⌘V instead.', 'warning'))
      },
      slides: {
        cut: (line) => { const v = viewRef.current; return v ? cutSlideAt(v, line) : null },
        copy: (line) => { const v = viewRef.current; return v ? copySlideAt(v, line) : null },
        paste: (clip, afterLine) => { const v = viewRef.current; return v ? pasteSlidesAfter(v, clip, afterLine) : null },
        moveTo: (fromLine, target, cardRef) => { const v = viewRef.current; return v ? moveSlideTo(v, fromLine, target, cardRef) : null },
        delete: (line) => { const v = viewRef.current; if (v) deleteSlideAt(v, line) }
      },
      runFormat: (id) => {
        const v = viewRef.current
        if (!v) return
        if (!canRunInlineFormatting(v.state)) return
        EDITOR_COMMANDS.find((command) => command.id === id)?.run(v)
        v.focus()
      },
    }
    registerEditorCommands?.(cmds)
  }, [registerEditorCommands, writeQueued])

  // Expose the caret's list-item context to the icon picker. Read from the LIVE view at call
  // time so it reflects wherever the caret is when the picker opens (not registration time).
  useEffect(() => {
    registerIconContext?.(() => {
      const v = viewRef.current
      return v ? getCursorListItemContext(v) : null
    })
  }, [registerIconContext])

  // The picker reads and writes the CURRENT heading's Trigger line through the shared ADR-0010
  // editor. Components/templates use the separate insert-at-cursor channel and never enter here.
  useEffect(() => {
    const target = (headingLine?: number): { headingLevel: number; headingLine: number; hasChildren: boolean; trigger: { text: string } | null; warnings: string[]; needsMerge: boolean } | null => {
      const v = viewRef.current
      if (!v) return null
      const doc = v.state.doc
      const caretLine = headingLine ?? doc.lineAt(v.state.selection.main.head).number
      if (caretLine < 1 || caretLine > doc.lines) return null
      for (let n = caretLine; n >= 1; n -= 1) {
        const heading = doc.line(n)
        const match = heading.text.match(/^(#{1,6})\s/)
        if (!match) continue
        const sourceLines = Array.from({ length: doc.lines }, (_, index) => doc.line(index + 1).text)
        const block = logicalTriggerBlockAfterHeading(sourceLines, n - 1)
        const trigger = block ? { text: block.line } : null
        const needsMerge = Boolean(block && (
          block.end > block.start + 1 || sourceLines[block.start] !== block.line
        ))
        return {
          headingLevel: match[1].length,
          headingLine: n,
          hasChildren: headingHasChildSlides(sourceLines, n - 1),
          trigger,
          warnings: block?.warnings ?? [],
          needsMerge
        }
      }
      return null
    }
    registerLayoutContext?.(() => {
      const current = target()
      return current ? {
        headingLevel: current.headingLevel,
        hasChildren: current.hasChildren,
        triggerLine: current.trigger?.text ?? ''
      } : null
    })
    const applyLayout = (
      initial: LayoutDef[],
      selected: LayoutDef[],
      options?: ApplyLayoutOptions
    ) => {
      const v = viewRef.current
      const current = target()
      if (!v || !current) return
      const next = commitLayoutSelection(
        current.trigger?.text ?? '',
        initial,
        selected,
        options?.layoutTokenOverride,
        deckCommitContext(v.state.doc.toString(), current.headingLine)
      )
      if (!next || (next === current.trigger?.text && !current.needsMerge)) return
      const plan = planEditorTriggerCommit(v.state.doc.toString(), current.headingLine, () => next)
      reportTriggerMergeWarnings(plan.warnings)
      const echo = triggerEchoChange(current.trigger?.text ?? '', next)
      const written = echo
        ? plan.changes.find((change) => change.insert.includes(next))
        : undefined
      const echoPosition = echo && written
        ? written.from + written.insert.indexOf(next) + echo.from
        : null
      v.dispatch({ changes: plan.changes })
      if (echo && echoPosition != null) {
        flashTriggerEchoAt(v, echoPosition, echo.token)
      }
      v.focus()
    }
    applyLayoutRef.current = applyLayout
    registerApplyLayout?.(applyLayout)
    registerApplyOption?.((entry, group, token, headingLine, slideId, compiledLayout) => {
      const v = viewRef.current
      if (!v) return null
      // Until this talk's text is loaded the doc is a transient the load will replace (and autosave
      // is off), so a commit now would silently vanish: refuse it instead.
      if (!loadedPathRef.current || loadedPathRef.current !== currentTalkRef.current) return null
      // Line numbers must NEVER cross text-identity boundaries: the caller computed headingLine
      // against ITS text (saved outline state), but this doc can differ transiently (adoption
      // mid-flight after a save). Re-derive the heading from the SLIDE ID against THIS doc; if
      // the id is not present here, REFUSE — a stale line number once wrote an option onto a
      // different slide's trigger line.
      const ownHeadingLine = slideId != null
        ? headingLineForSlideId(v.state.doc.toString(), slideId)
        : headingLine ?? null
      if (slideId != null && ownHeadingLine == null) return null
      const current = target(ownHeadingLine ?? undefined)
      if (!current) return null
      const original = current.trigger?.text ?? ''
      // Quote form: the verb, so an inferred quote slide never gains a `{quote}` token (see commitQuoteFormOption).
      if (group.key === 'quote-form') {
        const doc = v.state.doc.toString()
        const written = commitQuoteFormOption(doc, current.headingLine, token, compiledLayout)
        if (written) {
          if (written.outline !== doc) {
            const ch = minimalChange(doc, written.outline)
            v.dispatch({ changes: { from: ch.from, to: ch.to, insert: ch.insert } })
          }
          return written.triggerLine
        }
      }
      // T32: the ⌘L picker and the Inspector (editor mounted) sweep against the deck's choice.
      const next = commitSlideOption(v.state.doc.toString(), current.headingLine, original, entry, group, token)
      if (!next || (next === original && !current.needsMerge)) return original
      const plan = planEditorTriggerCommit(v.state.doc.toString(), current.headingLine, () => next)
      reportTriggerMergeWarnings(plan.warnings)
      const echo = triggerEchoChange(original, next)
      const written = echo
        ? plan.changes.find((change) => change.insert.includes(next))
        : undefined
      const echoPosition = echo && written
        ? written.from + written.insert.indexOf(next) + echo.from
        : null
      v.dispatch({ changes: plan.changes })
      if (echo && echoPosition != null) {
        flashTriggerEchoAt(v, echoPosition, echo.token)
      }
      return next
    })
    return () => {
      if (applyLayoutRef.current === applyLayout) applyLayoutRef.current = null
    }
  }, [registerApplyLayout, registerApplyOption, registerLayoutContext])

  // Put rewritten text into the buffer in place (registerReplaceDoc above): one minimal change, the
  // selection mapped through it by CodeMirror (a caret outside the changed span stays on its text —
  // restoring the old absolute offset moved it whenever bytes were inserted before it), no remount,
  // one undoable step. docChanged from this dispatch drives onContentChange (→ compile/strip).
  useEffect(() => {
    if (!registerReplaceDoc) return
    registerReplaceDoc((text, opts) => {
      const view = viewRef.current
      if (!view) return null
      const loaded = !!loadedPathRef.current && loadedPathRef.current === currentTalkRef.current
      // A save-bound change needs the talk's real text in the doc: before the load lands the doc is a
      // transient the load will replace, so the change (and its save) would be lost or wrong.
      if (opts?.save && !loaded) return null
      // The text a save wrote for `savedFrom`: adopted as the save's undo step, and only while the
      // buffer is still the text that save was made from (savedTextAdoption.ts). When this seam's
      // save branch below sent `savedFrom` tidied, that is the text before the tidy-up.
      if (typeof opts?.savedFrom === 'string') {
        const pending = seamSaveRef.current
        const source = pending && pending.sent === opts.savedFrom ? pending.source : opts.savedFrom
        if (pending && pending.sent === opts.savedFrom) seamSaveRef.current = null
        adoptSavedText(view, source, text)
        return view.state.doc.toString()
      }
      const spec = replaceDocTransaction(view.state.doc.toString(), text, { ownUndoStep: opts?.ownUndoStep })
      if (spec) view.dispatch(spec)
      if (!opts?.save) return view.state.doc.toString()
      // The caller saves the whole buffer now: the debounced autosave this dispatch (or an earlier
      // keystroke) scheduled is superseded. Same position-only normalisation as flushSave.
      if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
      // The editor is not tidied here: the caller adopts what the save wrote (`savedFrom` above), and
      // the tidy-up comes back with the save's ids as one undo step.
      const current = view.state.doc.toString()
      const normalized = textForSave(view.state, current)
      seamSaveRef.current = { sent: normalized, source: current }
      return normalized
    })
  }, [registerReplaceDoc])

  useEffect(() => {
    registerHeadingTools?.({
      caretHeading: () => (viewRef.current ? caretHeadingTarget(viewRef.current) : null),
      focusHeading: (line) => { if (viewRef.current) focusHeading(viewRef.current, line) },
      insertNotes: () => (viewRef.current ? insertSpeakerNotes(viewRef.current) : false)
    })
  }, [registerHeadingTools])

  useEffect(() => {
    registerPlainIconTools?.(plainIconTools(() => (loadedPathRef.current && loadedPathRef.current === currentTalkRef.current ? viewRef.current : null)))
  }, [registerPlainIconTools])

  useEffect(() => {
    if (!registerReadDoc) return
    registerReadDoc(() => {
      const view = viewRef.current
      if (!view || !loadedPathRef.current || loadedPathRef.current !== currentTalkRef.current) return null
      return { path: currentTalkRef.current, text: view.state.doc.toString(), caret: view.state.selection.main.head }
    })
  }, [registerReadDoc])

  // Scroll to + place the cursor at focusLine (1-based) whenever it changes.
  useEffect(() => {
    if (focusLine == null) return
    const view = viewRef.current
    if (!view) return
    const clamped = Math.max(1, Math.min(focusLine.line, view.state.doc.lines))
    const line = view.state.doc.line(clamped)
    view.dispatch({
      selection: { anchor: line.from },
      // 'start' parks the target line at the TOP of the editor viewport — matching the slide
      // strip/preview, which already scrolls the selected card to the top. 'center' left the
      // jumped-to slide mid-screen, which read as inconsistent with the previews.
      effects: EditorView.scrollIntoView(line.from, { y: 'start' })
    })
    if (focusLine.takeFocus) view.focus()
  }, [focusLine])

  return <div ref={containerRef} className="editor-container" data-place-region="editor" />
}
