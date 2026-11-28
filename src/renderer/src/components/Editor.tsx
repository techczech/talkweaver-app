import { slideFiles } from '../../../shared/slide-handling/query'
declare const __TW_SECURITY_TEST__: boolean
import { scratchDropExtension } from '../extensions/scratchDrop'
import type { SlidePlace } from '../../../shared/slide-handling/place'
import { runActionBarEditing } from './actionBar/editing-command'
import { boardStarterInsertion, mintBoardSlideId } from '../../../../compiler/scripts/lib/board-slide.mjs'
import { useEffect, useRef, useCallback } from 'react'
import { imageWidgetExtension, imagePlacementsChanged, editorImageUrl } from '../extensions/imageWidget'
import { cardMediaFacet } from '../extensions/objectBlocks/cardWidgets'
import { insertSpeakerNotes, objectDeletionNotices, objectStatusRequests } from '../extensions/objectBlocks/commands'
import { objectStatusSource, setObjectStatuses, type CardFileStatus } from '../extensions/objectBlocks/status'
import { cardActionHost } from '../extensions/objectBlocks/cardActions'
import { HTML_PAGE_INSERT_TEXT } from '../lib/insertHtmlPage'
import { imagePlacementForLine, type PlacementRow } from '../../../shared/image-placement.ts'
import {
  getCursorListItemContext,
  headingPromotionReason,
  minimalChange,
  moveNode,
  reLevel,
  moveBlockTo,
  moveBlockToEnd,
  moveBlockInto,
  normalizeTriggersCommand,
  setQuoteFormAtCursor,
  deleteSlideAtCursor,
  goToSectionChild,
  startBodyWithBullet,
  type CursorListItemContext
} from '../extensions/outliner'
import { eventMatchesEffectiveShortcut } from '../keymap/store'
import { markdownEditingKeymap, markdownEditingLanguage } from '../extensions/markdownEditing'
import { mountMarkdownSourceEditor } from '../objects/markdown-source-editor'
import { EDITOR_COMMANDS } from '../keymap/registry'
import { placeOfLine, type Place } from '../../../shared/place.ts'
import { outlineFolding, outlineFoldService, revealFoldedLine } from '../extensions/outlineFold'
import { frontmatterTableExtension } from '../extensions/frontmatterTable'
import { setWorkStripsData, workStripHandlersFacet } from '../extensions/workStrips'
import { loadWorkStripsData } from '../lib/workStripsData'
import { inlineMarkExtension } from '../extensions/inlineMark'
import { keyCapExtension } from '../extensions/keyCap'
import {
  canRunInlineFormatting,
  exactTextWrite,
  insertionCaret,
  insertionPlace,
  lineCommandUnavailable,
  objectBlocksExtension,
  runLineCommand,
  setOpenObjectBlock,
  sourceObjectPreviews,
  videoSourceDuration,
  type VideoSourceDuration,
  type ConsumeInsertFence
} from '../extensions/objectBlocks/field'
import { Decoration, EditorView, type DecorationSet, keymap, highlightActiveLine, showPanel, showTooltip } from '@codemirror/view'
import { ChangeSet, EditorState, EditorSelection, Prec, Compartment, Annotation, StateEffect, StateField, Transaction } from '@codemirror/state'
import { history, isolateHistory } from '@codemirror/commands'
import { editorBaseKeymap } from '../extensions/editorBaseKeymap'
import { search, highlightSelectionMatches, openSearchPanel, gotoLine } from '@codemirror/search'
import { commandRan } from '../commands/command-ran'
import { viewModeExtension, type PlainViewOptions } from '../extensions/plainView'
import { plainTypeExtension } from '../extensions/plainView/theme'
import { plainIconTools, type PlainIconTools } from '../extensions/plainView/iconTools'
import { PLAIN_LOOK_DEFAULT, type PlainLook } from '../../../shared/plain-view-look'
import { setMarginLabels, caretHeadingTarget, focusHeading, type MarginMenuHandlers } from '../extensions/plainView/margin'
import type { MarginLabel } from '../../../shared/plain-view-margin'
import type { EditorViewMode } from '../../../shared/editor-view-mode'
import {
  foldGutter,
  foldAll,
  unfoldAll
} from '@codemirror/language'
import type { TalkInfo } from '../../../preload/index'
import { notify } from '../lib/notify'
import { queueOutlineWrite } from '../lib/saveQueue'
import { lookForRecovery, noteOutlineSaveReply, outlineDiskChanges } from '../lib/outlineDiskChange'
import { replaceDocTransaction } from '../lib/replaceDocTransaction'
import { isSlideMergeReviewOpen, slideMergeHistory, slideMergeSaveReply, slideMergeTransaction } from '../lib/slideMergeTransaction'
import type { EditorDocumentReply, EditorDocumentRequestBody } from '../../../shared/editor-document'

import { clipboardHasText, htmlClipboardText } from '../lib/clipboardText'
import { adoptSavedText, isSaveStep, redoWithSave, savedTextAdopted, savedTextAdoption, undoWithSave } from '../extensions/savedTextAdoption'
import { editorRevision } from '../lib/editorRevision'
import { CLOSE_FREEZE_EVENT, closeFreezeText, type CloseFreezeDetail } from '../lib/closeFreezeEvent'
import { saveTidyUp, textForSave } from '../extensions/saveTidyUp'
import { captureOutlineIdentity, preserveHeadingOwners, outlineSaveIdentity, type OutlineIdentityReceipt } from '../extensions/outlineSaveIdentity'
import { triggerCompleteExtension, type TriggerCompleteOptions } from '../extensions/triggerComplete'
import { closeCompletion } from '@codemirror/autocomplete'
import { tokenProtectExtension } from '../extensions/idProtect'
import {
  copySlideAt, cutSlideAt, deleteSlideAt, moveSlideTo, pasteSlideTextAtCaret, pasteSlidesAfter, slideCutCopyExtension, wouldPasteAsSlides
} from '../extensions/slideCutPaste'
import { researchDropHandlers, researchInsertionMarker } from '../extensions/researchDrop'
import { blockAnchorAfterLine, insertAtCaretLine, insertBlockAfterLine, pasteAtHeadingEnd, pasteBlockAtSelection, pasteTextAtSelection } from '../extensions/headingEndInsert'
import type { MoveTarget } from '../extensions/slideBlockOps'
import type { SlideRef } from '../../../shared/slide-handling/blocks'
import { quoteLinkFormExtension } from '../extensions/quoteLinkForm'
import { markdownHeadingStyles, setMarkdownHeadings, type MarkdownHeadingKind } from '../extensions/markdownHeadings'
import { setTextFitNotes, textFitWarningExtension } from '../extensions/textFitWarning'
import type { TextFitNote } from '../../../shared/text-fit-notes.ts'
import { LayoutVerbError, reconcileSlideDesign, type QuoteFormChoice } from '../../../shared/layout-verbs'
import { flashTriggerEchoAt, triggerEchoChange } from '../extensions/triggerEcho'
import {
  commitLayoutSelection,
  commitQuoteFormOption,
  provisionalTriggerAtCursor,
  selectionFromTriggerLine,
  toggleLayoutSelection,
  type LayoutPickerContext
} from './layoutPickerModel'
import { LAYOUTS, type LayoutDef, type OptionGroup } from '../data/layouts'
import { commitOptionSelection, headingHasChildSlides, logicalTriggerBlockAfterHeading, reportTriggerMergeWarnings } from '../../../shared/trigger-line'
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
  currentFocusRange,
  focusScopeExtension,
  inSlideTextPanel,
  slideTextInput,
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
  const at = pos === 'caret' ? insertionCaret(view.state) : insertionPlace(view.state, pos)
  // After the line, or under a heading's id and layout lines (headingEndInsert.ts).
  insertBlockAfterLine(view, at, '\n' + md + '\n', { caret: ('\n' + md).length })
}

/** Whole-slide operations by heading line (1-based), run in the editor's buffer. */
export interface SlideBlockOps {
  cut: (line: number) => string | null
  copy: (line: number) => string | null
  /** After the slide or section on `afterLine`; at the end of the talk when null. */
  paste: (clip: string, afterLine: number | null) => number | null | Promise<number | null>
  /** `cardRef`: a grid card's heading (slideRefOf), checked against the buffer by the move core. */
  moveTo: (fromLine: number, target: MoveTarget, cardRef?: SlideRef) => number | null
  delete: (line: number) => void
}

interface Props {
  onResearchDrop?: (file: string) => void
  showResearchInsertion?: boolean
  talk: TalkInfo
  content: string
  onContentChange: (content: string, adoptedFrom?: string) => void
  onSaved?: () => void
  /** Save-health signal: true on a real user edit (autosave pending), false once it reaches disk.
   *  A refused/failed save never reports false — the status bar keeps showing unsaved. */
  onDirty?: (dirty: boolean) => void
  vaultRoot?: string | null
  /** Jump target. takeFocus=true moves keyboard focus into the editor (sidebar/⌘E jumps);
   *  false only aims the viewport/caret (strip card clicks keep their own keyboard nav). */
  focusLine?: { line: number; takeFocus: boolean; editTitle?: boolean; selectPlaceholder?: boolean } | null
  // Slide Focus (ADR-0032, Task 8): when set, the editor shows/edits ONLY this slide's line range
  // (absolute doc offsets [from, to)); every other line is hidden and edit-guarded — a scoped view
  // onto the SAME outline doc, never a copy. null / undefined = normal full-outline editing (today's
  // behaviour, fully inert). Task 9 drives this from the Slide Focus surface.
  focusRange?: FocusRange | null
  /** The Slide text panel treats typed and pasted heading markers as literal text. */
  slideTextPanel?: boolean
  showSourceObjectPreviews?: boolean
  /** ADR-0033 §1: heading lines of slides whose text cannot fit at the readable minimum. */
  textFitNotes?: readonly TextFitNote[]
  /** Heading line of each compiled slide (strip order): the gutter numbers those lines, nothing else. */
  markdownHeadings?: ReadonlyMap<number, MarkdownHeadingKind>
  markerSourceDuration?: VideoSourceDuration
  pictureProgress?: PictureProgress
  pictureDropLines?: { pointer: number; heading: number | null } | null
  /** Plain view's margin: what each heading line is called (Talk, Section, Slide n) and its layout name. */
  marginLabels?: readonly MarginLabel[]
  /** Compiled slide rows: each carries the compiler's image placements for the editor's image labels. */
  placementRows?: readonly PlacementRow[] | null
  onCursorLine?: (line: number, editedText?: string, scopedHeadingLine?: number) => void
  onNewHeading?: TriggerCompleteOptions['onNewHeading']
  onSectionChild?: (line: number) => void
  onHistoryLine?: (line: number, outline: string) => void
  startWithBullet?: boolean
  /** Onboarding ticket 02: the place of the caret's line (shared/place.ts), reported when it changes. */
  onPlace?: (place: Place, promoteHeadingReason: string | undefined) => void
  /** Whether the caret's line commands (lists, heading levels) have nothing to act on: a closed object
   *  is selected. Reported when it changes. */
  onLineCommandsUnavailable?: (unavailable: boolean) => void
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
  onInsertObjectMenu?: (coords: { x: number; y: number }, consumeFence: ConsumeInsertFence) => void
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
    /** Await pending writes and stamped-text adoption; reject a refused save. */
    settleSave: (signal?: AbortSignal) => Promise<void>
    /** Write the current text even when it looks saved (a close's 'resave', ADR-0044 §6); false when not written. */
    forceSave: (signal?: AbortSignal) => Promise<boolean>
    cancelDebouncedSave: (outlinePath: string) => void
    commitSlideMerge: CommitSlideMerge
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
    pointAtCoords: (x: number, y: number) => { pos: number; line: number } | null
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
    goToLine: () => void
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
  // still the text the save was made from. `fromDisk` adopts Reload text as the clean baseline
  // without autosave; `diskBase` keeps a merged buffer dirty until saved. Adoption maps existing
  // undo steps through its changes without making the external edits themselves undoable.
  registerReplaceDoc?: (fn: ReplaceEditorDoc) => void
  // The buffer's live text, the talk it belongs to and the caret (selection head offset), or null
  // while that talk's text is not loaded (one-writer spec D1: a mutation of the open talk reads THIS,
  // never the React mirror of it; the section insert places itself from the caret).
  registerReadDoc?: (fn: ReadEditorDoc) => void
  // ⌘L layout picker: places a bare layout trigger on the CURRENT slide's Trigger line (no slash to
  // clean up). The parent opens the picker and calls this with the chosen trigger.
  registerLayoutContext?: (fn: () => LayoutPickerContext | null) => void
  registerApplyLayout?: (fn: (initial: LayoutDef[], selected: LayoutDef[]) => void) => void
  registerApplyOption?: (fn: (group: OptionGroup, token: string, headingLine?: number, slideId?: string | null, compiledLayout?: string) => string | null) => void
  // Protected-token click (2026-07-03): clicking a `{…}` chip reports the token instead of
  // placing a cursor inside it — the parent routes id → where-used panel, trigger → ⌘L picker.
  onProtectedTokenClick?: (token: string, kind: 'id' | 'trigger') => void
  // Slide outline once per opened talk — armed only for opens that came from the Talks panel):
  //   1. the first pointerdown anywhere in the editor surface (.cm-editor, incl. .cm-content);
  //   2. the first document change made by the USER (typing/paste/drop — the keyboard-only path,
  //      "first keydown that changes the document"; programmatic dispatches carry no input
  //      userEvent and never fire this).
  // Fired AT MOST as often as the parent cares: it is a plain notification, it never consumes the
  // underlying event, and per-mount dedup is the parent's business (it consumes on first hit).
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
  /** The pre-work and post-work strips' "Plan a Run": opens the plan sheet for this talk. */
  onPlanRun?: () => void
}

// Outliner keyboard extension (ADR-0019). Built from the single-source-of-truth registry (+ any
// user overrides from Settings) so the bindings and the Ctrl-/ help popup can never drift. Held in
// a Compartment so a Settings change re-binds live, without remounting the editor. Bound at highest
// precedence so the chords override CodeMirror's default selection-extension bindings. The registry
// documents WHY these chords were chosen (no Ctrl+Arrow — macOS reserves it for Mission Control).

// What the Plain view needs from the app: where icon pictures come from (the same bridge the icon picker uses).
function plainViewOptions(menus: MarginMenuHandlers): PlainViewOptions {
  const icons = (window as unknown as { tw?: { icons?: { svg?: (key: string) => Promise<string | null> } } }).tw?.icons
  return { ...menus, hideLayoutCodes: true, ...(icons?.svg ? { iconSvg: (key: string) => icons.svg!(key) } : {}) }
}

export type { PlainIconTools }

export type ReplaceEditorDoc = (text: string, opts?: {
  save?: boolean
  savedFrom?: string
  reviewedLayoutRepair?: true
  ownUndoStep?: boolean
  headingOrder?: readonly number[]
  fromDisk?: boolean
  diskBase?: string
  diskHash?: string
}) => string | null

export type CommitSlideMerge = (request: Extract<EditorDocumentRequestBody, { kind: 'slide-merge' }>) => Promise<EditorDocumentReply>

export type ReadEditorDoc = (options?: { discardProvisionalTrigger?: boolean; authoredOnly?: boolean; saveText?: string }) => {
  path: string
  text: string
  caret: number
  base: string | null
  dirty: boolean
  epoch: object
  diskHash?: string
  saveIdentity?: OutlineIdentityReceipt
} | null

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
// The view compartment holds what Plain replaces: the theme and the highlight (extensions/plainView).
// Markdown mode puts today's warm-paper code-font theme and default highlight back, unchanged.
const viewCompartment = new Compartment()
// The Plain tab's font and text size. Empty in Markdown mode, so that tab stays exactly as it was.
const plainTypeCompartment = new Compartment()
const videoSourceDurationCompartment = new Compartment()
type PictureProgress = { message: string; pos?: number }
const setPictureProgress = StateEffect.define<PictureProgress | undefined>()
const pictureProgressField = StateField.define<PictureProgress | undefined>({
  create: () => undefined,
  update(progress, transaction) {
    for (const effect of transaction.effects) if (effect.is(setPictureProgress)) return effect.value
    return progress?.pos !== undefined && transaction.docChanged
      ? { ...progress, pos: transaction.changes.mapPos(progress.pos, 1) }
      : progress
  },
  provide: field => showTooltip.compute([field, 'selection'], state => {
    const progress = state.field(field)
    return progress ? {
      pos: progress.pos ?? state.selection.main.head,
      create(view) {
        const dom = view.dom.ownerDocument.createElement('div')
        dom.className = 'tw-picture-progress'
        dom.setAttribute('aria-hidden', 'true')
        dom.textContent = progress.message
        return { dom }
      }
    } : null
  })
})

const setPictureDropMarks = StateEffect.define<DecorationSet>()
const pictureDropMarks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, transaction) {
    for (const effect of transaction.effects) if (effect.is(setPictureDropMarks)) return effect.value
    return transaction.docChanged ? marks.map(transaction.changes) : marks
  },
  provide: field => EditorView.decorations.from(field)
})

/** A transaction allowed through a close's freeze (Reload's text, chosen on the close's own sheet). */
const closeFreezeExempt = Annotation.define<boolean>()
const provisionalRollback = Annotation.define<boolean>()

/** While closing: not editable, read-only for every command, and a line at the top saying why (ADR-0044 §6). */
function closeFreezeExtension(update: boolean) {
  return [
    EditorView.editable.of(false),
    EditorState.readOnly.of(true),
    showPanel.of(() => {
      const dom = document.createElement('div')
      dom.className = 'tw-close-freeze'
      dom.setAttribute('role', 'status')
      dom.setAttribute('data-close-freeze', update ? 'update' : 'close')
      dom.textContent = closeFreezeText(update)
      return { dom, top: true }
    }),
  ]
}

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
  slideTextPanel = false,
  showSourceObjectPreviews = true,
  textFitNotes,
  markdownHeadings,
  markerSourceDuration,
  pictureProgress,
  pictureDropLines,
  marginLabels,
  placementRows,
  onCursorLine,
  onHistoryLine,
  onNewHeading,
  onSectionChild,
  startWithBullet = false,
  onPlace,
  onLineCommandsUnavailable,
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
  const moveFrozenRef = useRef(false)
  const mergeSavingRef = useRef(false)
  const loadFrozenRef = useRef(true)
  // Closing (ADR-0044 §6, rules B and D; lib/closeFreeze.ts): from the close request until the window closes, or the
  // close is called off, the person's edits are refused. Only Reload's text and the adoption of a save's ids pass.
  const closeFrozenRef = useRef(false)
  const closeFreezeCompartment = useRef(new Compartment())
  const loadEpochRef = useRef(0)
  useEffect(() => {
    const freeze = (event:Event) => {
      moveFrozenRef.current = (event as CustomEvent<boolean>).detail
      // Revocation also invalidates a read already in flight, even at the same path.
      if (moveFrozenRef.current) loadEpochRef.current += 1
    }
    window.addEventListener('tw-freeze-moved-editor', freeze)
    return () => window.removeEventListener('tw-freeze-moved-editor', freeze)
  }, [])
  useEffect(() => {
    const onCloseFreeze = (event: Event) => {
      const { frozen, update } = (event as CustomEvent<CloseFreezeDetail>).detail
      closeFrozenRef.current = frozen
      const view = viewRef.current
      if (!view) return
      view.dispatch({ effects: closeFreezeCompartment.current.reconfigure(frozen ? closeFreezeExtension(update) : []) })
      if (frozen) view.contentDOM.blur()
    }
    window.addEventListener(CLOSE_FREEZE_EVENT, onCloseFreeze)
    return () => window.removeEventListener(CLOSE_FREEZE_EVENT, onCloseFreeze)
  }, [])
  const viewRef = useRef<EditorView | null>(null)
  const movedBufferRef = useRef<{to:string; diskText:string; text:string} | null>(null)
  useEffect(() => {
    const adopt = (event:Event) => {
      const {from,to,diskText} = (event as CustomEvent<{from:string;to:string;diskText:string}>).detail
      if (currentTalkRef.current === from && loadedPathRef.current === from && moveFrozenRef.current && viewRef.current)
        movedBufferRef.current = {to,diskText,text:viewRef.current.state.doc.toString()}
    }
    window.addEventListener('tw-adopt-moved-buffer', adopt)
    return () => window.removeEventListener('tw-adopt-moved-buffer', adopt)
  }, [])

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
  // A debounce is only scheduled work, not evidence that a write succeeded. Keep the last
  // acknowledged text independently; replace this object on load/Reload to invalidate old replies.
  const cleanDocumentRef = useRef<{ text: string | null; dirty: boolean; diskHash?: string; pending?: Promise<boolean> & { text: string; doc: EditorState['doc'] } }>({ text: null, dirty: false })
  const acknowledgedIds = useRef(new WeakMap<object, string>())
  const adoptingDiskRef = useRef(false)
  // The replace seam's last save (`save: true`): the text it returned to be written, and the editor's
  // text it was tidied from, so the adoption of what was written (`savedFrom`) replaces the latter.
  const seamSaveRef = useRef<{ sent: string; doc: EditorState['doc']; identity: OutlineIdentityReceipt } | null>(null)
  // Every outline write this editor sends goes through the outline's shared queue (lib/saveQueue):
  // one write in flight at a time per file, in the order made, shared with the workspace's writes
  // (ticket 07 — a stale autosave or workspace write can never land after a newer save).
  const provisionalTriggerRef = useRef<{ before: string; from: number; to: number; epoch: object } | null>(null)
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
  function recordSlideCopy(clip: string | null): string | null {
    if (clip && slideFiles(clip).some(({ ref }) => ref)) {
      void window.tw.talk.rememberSlideCopy?.(currentTalkRef.current, clip).catch(() => {})
    }
    return clip
  }
  // Data-loss guard (2026-07-05): the path whose REAL content is loaded and live in the doc, or null
  // while a load is in flight. The editor is remounted on every talk switch (and nothing else), so a
  // fresh instance starts with `doc: ''`; autosave must stay OFF during that transient (and during the
  // load's own content-replacing dispatch) so the empty doc can never be mistaken for a user edit and
  // written to disk. Set null when a load starts; set to the path only AFTER its content is dispatched.
  const loadedPathRef = useRef<string | null>(null)
  const onCursorLineRef = useRef(onCursorLine)
  const onNewHeadingRef = useRef(onNewHeading)
  onNewHeadingRef.current = onNewHeading
  const onSectionChildRef = useRef(onSectionChild)
  onSectionChildRef.current = onSectionChild
  const onHistoryLineRef = useRef(onHistoryLine)
  useEffect(() => { onHistoryLineRef.current = onHistoryLine }, [onHistoryLine])
  useEffect(() => { onCursorLineRef.current = onCursorLine }, [onCursorLine])
  const onPlaceRef = useRef(onPlace)
  useEffect(() => { onPlaceRef.current = onPlace }, [onPlace])
  const lastPlaceRef = useRef<{ place: Place; promoteHeadingReason: string | undefined } | null>(null)
  const onLineCommandsUnavailableRef = useRef(onLineCommandsUnavailable)
  useEffect(() => { onLineCommandsUnavailableRef.current = onLineCommandsUnavailable }, [onLineCommandsUnavailable])
  const lastLineCommandsUnavailableRef = useRef(false)
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
  // Capture text and heading owners from the same state before entering the queue.
  // `revision`: the editor's revision of `source` (lib/editorRevision.ts), sent with the save: what a close confirms
  // against. `force`: write even when the same text is being written (a close's 'resave').
  const writeQueued = useCallback((outlinePath: string, state: EditorState, revision: number = editorRevision.current(), force = false): Promise<boolean> => {
    // Every immediate write supersedes the debounce, including a settle continuation after IPC.
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
    const baseline = cleanDocumentRef.current
    const source = state.doc.toString()
    const text = textForSave(state, source)
    if (!force && baseline.pending?.text === text && baseline.pending.doc === state.doc) return baseline.pending
    const identity = captureOutlineIdentity(state, text, acknowledgedIds.current)
    // Track the entire write, including synchronous stamped-content adoption, on the same
    // acknowledged-document state that load/Reload invalidates. The queue alone ends before adoption.
    const pending = Object.assign((async () => {
      // The person discarded this talk (removed on disk): it is never saved again from this editor.
      if (outlineDiskChanges.isDiscarded(outlinePath)) return false
      // Adoption invalidates any pre-merge flush that waited behind disk acceptance.
      const res = await queueOutlineWrite(outlinePath, async () => {
        if (cleanDocumentRef.current !== baseline) return false
        const reply = await window.tw.talk.writeOutline(outlinePath, text, {
          revision, expectedDiskHash: baseline.diskHash, identity: identity.options()
        })
        if (reply && reply.ok && cleanDocumentRef.current === baseline) identity.acknowledge(reply.content ?? text)
        return reply
      })
      if (cleanDocumentRef.current !== baseline) return !!res && res.ok === true
      // Save-indicator honesty (2026-07-05): only stamp "saved" on a REAL write. If the main-process
      // backstop refused (structurally-empty over a non-empty file), the disk is unchanged — say so
      // instead of a false "saved just now". `res === false` is an IO failure (also not a save).
      if (res && res.ok === true) {
        onSaved?.()
        // Stamped-id adoption (see adoptStampedContent). On the talk-switch flush path the view may
        // already be torn down or repointed — the helper's viewRef/doc-unchanged guards make that a
        // safe no-op (disk is stamped either way; the reload will read the stamped file).
        if (cleanDocumentRef.current === baseline && loadedPathRef.current === outlinePath) {
          const sameDocument = viewRef.current?.state.doc === state.doc
          if (sameDocument) adoptStampedContent(source, text, res)
          const saved = typeof res.content === 'string' ? res.content : text
          delete baseline.diskHash
          baseline.text = viewRef.current?.state.toText(saved).toString() ?? saved
          // Undo may deliberately decline stamped-id adoption to preserve redo. A successful write
          // acknowledges that unchanged source too; only an edit made during the write needs saving again.
          baseline.dirty = !sameDocument
          onDirtyRef.current?.(baseline.dirty)
        }
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
      } else if (res && res.ok === false && res.refused === 'ownership') {
        notify('This talk’s editing access changed, so it was not saved. Your edits remain in the editor. Reopen the talk when its vault is available to continue saving.', 'warning', 'save-ownership')
      } else if (res && res.ok === false) {
        notify('Save skipped — the app refused to overwrite the outline with empty content. Your file on disk is unchanged.', 'warning', 'save-refused')
      } else {
        // IO failure (write threw: permissions, disk, file vanished). Without this the status
        // bar keeps ageing "Saved Xm ago" while every keystroke is silently lost.
        notify('Save FAILED — the outline could not be written to disk. Your recent edits are not saved.', 'error', 'save-failed')
      }
      return false
    })(), { text, doc: state.doc })
    baseline.pending = pending
    const finished = () => { if (baseline.pending === pending) baseline.pending = undefined }
    void pending.then(finished, finished)
    return pending
  }, [onSaved, adoptStampedContent])

  const scheduleAutosave = useCallback(
    function schedule(outlinePath: string, content: string) {
      // NEVER autosave an empty / whitespace-only doc: an outline never legitimately becomes empty via
      // autosave, so this can only ever be the remount/`doc:''` transient (data-loss guard). The main
      // process also refuses an empty-over-nonempty write — belt-and-braces.
      if (content.trim() === '') return
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      const baseline = cleanDocumentRef.current
      const revision = editorRevision.current() // the revision of `content`
      saveTimerRef.current = setTimeout(async () => {
        saveTimerRef.current = null
        const view = viewRef.current
        if (!view || cleanDocumentRef.current !== baseline || !baseline.dirty ||
            loadedPathRef.current !== outlinePath || currentTalkRef.current !== outlinePath) return
        // Completion or dismissal will schedule the authored text once the picker closes.
        if (provisionalTriggerRef.current?.epoch === baseline) return
        const current = view.state.doc.toString()
        if (current !== content) { schedule(outlinePath, current); return }
        // Tidied, except straight after an undo or a redo (extensions/saveTidyUp.ts), here and at the
        // two saves below. The editor is not tidied first: the tidy-up comes back with the save's ids.
        await writeQueued(outlinePath, view.state, revision)
      }, 1500)
    },
    [writeQueued]
  )

  const rollbackProvisionalTrigger = useCallback((view: EditorView): boolean => {
    const provisional = provisionalTriggerRef.current
    if (!provisional) return false
    if (moveFrozenRef.current || loadFrozenRef.current || closeFrozenRef.current) return false
    provisionalTriggerRef.current = null
    // A picker snapshot belongs to the document it opened in, never a later disk adoption/load.
    if (provisional.epoch !== cleanDocumentRef.current) return false
    const current = view.state.doc.toString()
    const change = minimalChange(current, provisional.before)
    view.dispatch({
      changes: { from: change.from, to: change.to, insert: change.insert },
      selection: EditorSelection.cursor(Math.min(provisional.from, provisional.before.length)),
      // The text as it was before the provisional trigger, byte for byte.
      annotations: [exactTextWrite.of(true), provisionalRollback.of(true)]
    })
    const path = loadedPathRef.current
    if (path && path === currentTalkRef.current && cleanDocumentRef.current.dirty) {
      scheduleAutosave(path, view.state.doc.toString())
    }
    return true
  }, [scheduleAutosave])

  // Mount editor once
  useEffect(() => {
    if (!containerRef.current) return

    const view = new EditorView({
      parent: containerRef.current,
      dispatchTransactions: (transactions, editor) => {
        // Native Edit → Undo can still reach CodeMirror behind a modal, and history
        // transactions bypass transaction filters. Only Apply may change this review's input.
        if (transactions.some(tr => tr.isUserEvent('undo') || tr.isUserEvent('redo')) &&
            (mergeSavingRef.current || isSlideMergeReviewOpen())) return
        editor.update(transactions)
      },
      state: EditorState.create({
        doc: '',
        extensions: [
          EditorState.transactionFilter.of(tr => (moveFrozenRef.current || loadFrozenRef.current || (closeFrozenRef.current && !tr.annotation(savedTextAdopted) && !tr.annotation(closeFreezeExempt))) && tr.docChanged ? [] : tr),
          EditorState.transactionFilter.of(tr => mergeSavingRef.current && tr.docChanged ? [] : tr),
          closeFreezeCompartment.current.of([]),
          researchMarkerCompartment.current.of(showResearchInsertion ? researchInsertionMarker : []),
          scratchDropExtension((id, place) => scratchDropRef.current?.(id, place)),
          EditorView.domEventHandlers(researchDropHandlers(file => researchDropRef.current?.(file))),
          EditorView.domEventHandlers({
            paste(event: ClipboardEvent) {
              const clipboard = event.clipboardData
              if (!clipboard) return false
              const items = Array.from(clipboard.items)
              const mixedImage = clipboardHasText(clipboard) && items.some(item => item.kind === 'file' && item.type.startsWith('image/'))
              // A workspace paste delegated to CodeMirror still passes through this older media handler.
              for (const item of mixedImage ? [] : items) {
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
                      const pos = insertionCaret(viewRef.current.state)
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
              const plain = clipboard.getData('text/plain')
              const text = plain || (mixedImage ? htmlClipboardText(clipboard) : '')
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
              const carriesPastedAssets = (text && slideFiles(text).some(({ ref }) => ref)) || /!\[[^\]]*\]\(assets\/[^)]+\.(?:png|jpe?g|gif|webp)\)/i.test(text)
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
              const pastedText = text
              if (pastedText && carriesPastedAssets) {
                event.preventDefault()
                // Whole slides pasted on a heading line or between slides go in as whole slides
                // (slideCutPaste.ts); anywhere else the text replaces the selection as before.
                const pasteTarget = currentTalkRef.current
                const put = (markdown: string): void => {
                  if (currentTalkRef.current !== pasteTarget) return
                  const v = viewRef.current
                  if (v && !pasteSlideTextAtCaret(v, markdown, pastedText)) pasteTextAtSelection(v, markdown)
                }
                window.tw.talk
                  .materializePastedAssets(pastedText, pasteTarget)
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
              if (!plain && text && viewRef.current) {
                event.preventDefault()
                pasteTextAtSelection(viewRef.current, text)
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
                  insertBlockAfterLine(current, insertionPlace(current.state, dropPos), insert, { caret: insert.length })
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
                    insertBlockAfterLine(viewRef.current, insertionPlace(viewRef.current.state, dropPos), picture + '\n', { caret: picture.length })
                  } else if (!result) {
                    notify('Could not add the dropped image — it was not added to the outline.', 'error', 'addmedia')
                  }
                }).catch((e) => { console.error(e); notify('Could not add the dropped image — it was not added to the outline.', 'error', 'addmedia') })
                return true
              }
              return false
            }
          }),
          markdownHeadingStyles,
          pictureDropMarks,
          pictureProgressField,
          historyCompartment.of(history({ minDepth: 200 })),
          // A web link pasted or typed into a quote slide's source line makes the slide a web page in the same undo step (spec 3.1).
          quoteLinkFormExtension(() => compiledLayoutAtRef.current),
          highlightActiveLine(),
          markdownEditingLanguage,
          // Folding: collapse any heading section or list subtree (gutter arrows + Ctrl-Shift-[/]).
          outlineFolding,
          foldGutter(),
          outlineFoldService,
          // {-triggered autocomplete for layout triggers and frame modifiers (Tier 1).
          // The opening token is provisional until a completion closes it. Escape and click-away
          // restore the byte-exact pre-picker document, before autosave/id stamping can see it.
          // The extension comes first at highest precedence so scene C can use the first Escape to
          // back up from options; when no chained step is active, the rollback binding below wins.
          triggerCompleteExtension({
            isMarkdown: () => viewModeRef.current === 'markdown',
            onNewHeading: (kind, heading) => onNewHeadingRef.current?.(kind, heading),
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
          slideCutCopyExtension(recordSlideCopy),
          // Slide Focus scoped view (ADR-0032, Task 8). Inert until a range is set (via the
          // focusRange prop / setFocusRange effect); then hides every line outside the focused
          // block, guards edits from touching outside it, and keeps the caret inside — composing
          // with tokenProtectExtension above (all id/trigger/heading guards stay active in-band).
          focusScopeExtension(),
          // Amber mark + inline note on the heading of a slide whose text is too long (ADR-0033 §1).
          textFitWarningExtension,
          // YAML frontmatter rendered as a typed table (raw ↔ table toggle).
          frontmatterTableExtension(),
          // The strips' buttons (ticket 08): Plan a Run opens the workspace's plan sheet; Open run goes to Sessions.
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
            mountSource: mountMarkdownSourceEditor,
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
              return new Map(answer.statuses.map((s): [string, CardFileStatus] => [s.ref, { state: s.state, path: s.path, repairTitle: s.repairTitle, repairCandidates: s.repairCandidates }]))
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
            copyPage: async (ref, expectedTitle) => {
              const outlinePath = currentTalkRef.current
              try {
                if (!await window.tw.objects.repairWidget(outlinePath, ref, expectedTitle)) throw new Error('Copy refused')
                if (currentTalkRef.current !== outlinePath) return
                viewRef.current?.dispatch({ effects: setObjectStatuses.of(new Map([[ref, { state: 'present' }]])) })
                window.dispatchEvent(new CustomEvent('tw:widget-repaired', { detail: outlinePath }))
              } catch {
                notify('Couldn’t copy the widget into this talk.', 'warning', 'copy-widget')
              }
            },
            readPage: async (src) => {
              const outlinePath = currentTalkRef.current
              if (!outlinePath) return null
              const html = await window.tw.objects.staticPreview(outlinePath, src)
              return currentTalkRef.current === outlinePath ? html : null
            },
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
          keymap.of(editorBaseKeymap.filter(binding => binding.run !== gotoLine)),
          markdownEditingKeymap('outline'),
          goToSectionChild.of(line => onSectionChildRef.current?.(line)),
          viewCompartment.of([sourceObjectPreviews.of(showSourceObjectPreviews), startBodyWithBullet.of(startWithBullet), slideTextInput.of(slideTextPanel), viewModeExtension(viewModeRef.current, plainViewOptions(marginMenuHandlers))]),
          videoSourceDurationCompartment.of([]),
          plainTypeCompartment.of(viewModeRef.current === 'plain' ? plainTypeExtension(plainLookRef.current) : []),
          EditorView.updateListener.of((update) => {
            let authoredEdit: string | undefined
            if (update.docChanged) {
              if (mergeSavingRef.current) return
              const content = update.state.doc.toString()
              if (adoptingDiskRef.current) { onContentChange(content); return }
              if (update.transactions.some(tr => tr.annotation(provisionalRollback))) return
              const head = update.state.selection.main.head
              const provisional = provisionalTriggerAtCursor(content, head)
              if (provisional) {
                const pending = provisionalTriggerRef.current
                const existing = pending?.epoch === cleanDocumentRef.current ? pending : null
                provisionalTriggerRef.current = {
                  before: existing?.before ?? update.startState.doc.toString(),
                  from: existing?.from ?? provisional.from,
                  to: provisional.to,
                  epoch: cleanDocumentRef.current
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
              const fromSave = update.transactions.some(tr => tr.annotation(savedTextAdopted))
              authoredEdit = content
              onContentChange(content, fromSave ? update.startState.doc.toString() : undefined)
              // Autosave ONLY once this talk's real content is loaded AND the doc still belongs to the
              // active talk — never during the fresh-mount `doc:''` transient or the load's own initial
              // content dispatch (data-loss guard, 2026-07-05). scheduleAutosave also skips empty text.
              if (loadedPathRef.current && loadedPathRef.current === currentTalkRef.current) {
                // A change of the person's raises the revision; taking a save's ids back in does not (it is the text
                // that save wrote).
                if (!fromSave) editorRevision.bump()
                cleanDocumentRef.current.dirty = true
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
            if ((update.selectionSet || (update.docChanged && viewModeRef.current === 'markdown')) && onCursorLineRef.current) {
              const head = update.state.selection.main.head
              const lineNumber = update.state.doc.lineAt(head).number
              const scope = inSlideTextPanel(update.state) ? currentFocusRange(update.state) : null
              const scopedHeadingLine = scope ? update.state.doc.lineAt(scope.from).number : undefined
              onCursorLineRef.current(lineNumber, authoredEdit, scopedHeadingLine)
            }

            // The scoped editor clamps a history transaction's selection to its current slide.
            // Follow the actual authored change, leaving any accompanying save-stamp step out.
            if (update.docChanged && onHistoryLineRef.current) {
              const index = update.transactions.findIndex(tr =>
                tr.docChanged && (tr.isUserEvent('undo') || tr.isUserEvent('redo')) && !isSaveStep(tr))
              if (index >= 0) {
                const historyChange = update.transactions[index]
                let position: number | null = null
                historyChange.changes.iterChangedRanges((_from, _to, fromAfter, toAfter) => {
                  if (position !== null) return
                  position = fromAfter
                  const lineAfter = historyChange.newDoc.lineAt(fromAfter)
                  // Removing an appended object can expose the following slide's heading at the
                  // splice. The removed text was in the preceding slide.
                  if (fromAfter > 0 && fromAfter === toAfter && fromAfter === lineAfter.from &&
                      /^#{1,6}[\t ]/.test(lineAfter.text)) position = fromAfter - 1
                })
                if (position !== null) {
                  for (const tr of update.transactions.slice(index + 1)) position = tr.changes.mapPos(position)
                  const { doc } = update.state
                  const changedLine = doc.lineAt(position).number
                  // Slide Focus can dispatch a final caret clamp inside this update.
                  // Follow the changed slide after that last report from the old scope.
                  queueMicrotask(() => {
                    if (viewRef.current !== update.view || update.view.state.doc !== doc) return
                    onHistoryLineRef.current?.(changedLine, doc.toString())
                  })
                }
              }
            }

            // Report place and heading availability together, including changes between heading levels.
            // Both start with the caret's line; only top heading candidates need the source heading map.
            if ((update.selectionSet || update.docChanged) && onPlaceRef.current) {
              const doc = update.state.doc
              const line = doc.lineAt(update.state.selection.main.head)
              const place = placeOfLine(line.text, line.number, (n) => (n >= 1 && n <= doc.lines ? doc.line(n).text : ''))
              const promoteHeadingReason = headingPromotionReason(update.state)
              if (place !== lastPlaceRef.current?.place || promoteHeadingReason !== lastPlaceRef.current.promoteHeadingReason) {
                lastPlaceRef.current = { place, promoteHeadingReason }
                onPlaceRef.current(place, promoteHeadingReason)
              }
            }
            if ((update.selectionSet || update.docChanged) && onLineCommandsUnavailableRef.current) {
              const unavailable = lineCommandUnavailable(update.state)
              if (unavailable !== lastLineCommandsUnavailableRef.current) {
                lastLineCommandsUnavailableRef.current = unavailable
                onLineCommandsUnavailableRef.current(unavailable)
              }
            }
          }),
          // Keeps a save's adopted text marked as the save's undo step, and sends the Edit menu's
          // Undo and Redo through the undo that takes that step with the change below it.
          savedTextAdoption(),
          slideMergeHistory,
          saveTidyUp(),
          outlineSaveIdentity,
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
    // Supported EditorView reference; compiled out of production builds.
    const testWindow = window as Window & { __twSecurityEditorText?: () => string }
    const readTestDocument = (): string => view.state.doc.toString()
    if (__TW_SECURITY_TEST__) testWindow.__twSecurityEditorText = readTestDocument

    return () => {
      // Cancel any pending autosave from THIS instance before it unmounts. A stale timer that fired
      // after the remount could write into the next instance's `doc:''` transient, or clobber the
      // authoritative text a reorder/detach/publish flow just wrote to disk before remounting — those
      // flows persist their own content, so the editor's pending save is redundant here (data-loss
      // guard, 2026-07-05).
      if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
      if (__TW_SECURITY_TEST__ && testWindow.__twSecurityEditorText === readTestDocument) delete testWindow.__twSecurityEditorText
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

  // Slide Focus (ADR-0032, Task 8): push the focusRange prop into the editor's focus-scope field via
  // an effect — no remount, no compartment churn. undefined/null exits focus (the extension is then
  // fully inert). Task 9 supplies this prop from the Slide Focus surface; today nothing sets it.
  // Plain / Markdown tab: swap the compartment's contents. The document, selection, scroll and
  // history are untouched (reconfigure changes extensions only).
  useEffect(() => {
    const enteringOutline = viewModeRef.current !== viewMode && viewMode === 'plain' && !slideTextPanel
    viewModeRef.current = viewMode
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: [
      viewCompartment.reconfigure([sourceObjectPreviews.of(showSourceObjectPreviews), startBodyWithBullet.of(startWithBullet), slideTextInput.of(slideTextPanel), viewModeExtension(viewMode, plainViewOptions(marginMenuHandlers))]),
      plainTypeCompartment.reconfigure(viewMode === 'plain' ? plainTypeExtension(plainLookRef.current) : [])
    ] })
    // On entering Outline from Markdown the caret may be on a line Outline hides. Slide view
    // installs its own range next; reporting the old caret here can select a different slide.
    if (enteringOutline) view.dispatch({ selection: view.state.selection, userEvent: 'select' })
  }, [viewMode, startWithBullet, slideTextPanel, showSourceObjectPreviews])

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: videoSourceDurationCompartment.reconfigure(markerSourceDuration ? videoSourceDuration.of(markerSourceDuration) : [])
    })
  }, [markerSourceDuration, talk.outlinePath])

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

  useEffect(() => {
    const view = viewRef.current
    if (view) setMarkdownHeadings(view, viewMode === 'markdown' ? markdownHeadings : undefined)
  }, [talk.outlinePath, viewMode, markdownHeadings])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const lines = pictureDropLines && viewMode === 'markdown'
      ? [...new Set([pictureDropLines.pointer, pictureDropLines.heading])].filter(
        (line): line is number => line !== null && line >= 1 && line <= view.state.doc.lines
      ) : []
    const marks = lines.map(line => Decoration.line({ class: 'cm-picture-drop-target' }).range(view.state.doc.line(line).from))
    if (!marks.length && view.state.field(pictureDropMarks).size === 0) return
    view.dispatch({ effects: setPictureDropMarks.of(Decoration.set(marks, true)) })
  }, [pictureDropLines, viewMode, talk.outlinePath])

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
    const epoch = ++loadEpochRef.current
    let active = true
    const ownsLoad = () => active && loadEpochRef.current === epoch && currentTalkRef.current === talk.outlinePath
    loadFrozenRef.current = true
    currentTalkRef.current = talk.outlinePath
    // Autosave stays OFF until this talk's content is actually in the doc, and any timer still pending
    // from the previous talk/instance is cancelled — so neither the empty transient nor a stale save
    // can write during the load (data-loss guard, 2026-07-05).
    loadedPathRef.current = null
    cleanDocumentRef.current = { text: null, dirty: false }
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
    const pathAtLoad = talk.outlinePath
    const movedBuffer = movedBufferRef.current
    movedBufferRef.current = null
    async function load() {
      // forEditor: the text loaded here is what the external-change guard compares the file against.
      // The loaded text is the file's at the revision now: the load itself is not a change of the person's.
      const content = await window.tw.talk.readOutline(pathAtLoad, { forEditor: true, revision: editorRevision.current() })
      if (content === null && ownsLoad()) {
        notify('This talk could not be opened: it is not in your current vault, or its file could not be read.', 'warning', 'talk-not-read')
      }
      // Guard the whole apply against a remount that happened while readOutline was in flight: only
      // apply if the view is still alive AND still bound to the path we read (currentTalkRef moved on
      // otherwise). The content-replacing dispatch runs while loadedPathRef is null, so its docChanged
      // never triggers autosave; we mark the path loaded ONLY after that dispatch lands.
      if (viewRef.current && content !== null && ownsLoad()) {
        // Preserve the mounted document only when the destination still holds the move's bytes.
        // A newer destination uses the existing explicit recovery choice instead.
        if (movedBuffer?.to === pathAtLoad && movedBuffer.diskText === content && viewRef.current.state.doc.toString() === movedBuffer.text) {
          cleanDocumentRef.current = { text: viewRef.current.state.toText(content).toString(), dirty: viewRef.current.state.doc.toString() !== viewRef.current.state.toText(content).toString() }
          // The moved text differs from the file: it is a revision the file does not have yet.
          if (cleanDocumentRef.current.dirty) editorRevision.bump()
          loadedPathRef.current = pathAtLoad
          loadFrozenRef.current = false
          moveFrozenRef.current = false
          outlineDiskChanges.loaded(pathAtLoad)
          onContentChange(movedBuffer.text)
          return
        }
        viewRef.current.dispatch({
          changes: { from: 0, to: viewRef.current.state.doc.length, insert: content },
          selection: { anchor: 0 },
          filter: false // Only the owning load may replace text while mutation admission is closed.
        })
        // RESET the undo stack across the talk boundary: detach + re-attach history() so the
        // load dispatch above (and every edit belonging to the PREVIOUS talk) is not undoable
        // in this one. ⌘Z in a freshly opened talk must be a no-op, never a revert-to-empty.
        viewRef.current.dispatch({ effects: historyCompartment.reconfigure([]) })
        viewRef.current.dispatch({ effects: historyCompartment.reconfigure(history({ minDepth: 200 })) })
        cleanDocumentRef.current = { text: viewRef.current.state.doc.toString(), dirty: false }
        loadedPathRef.current = pathAtLoad
        loadFrozenRef.current = false
        moveFrozenRef.current = false
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
    void load().catch(() => {
      if (ownsLoad()) notify('This talk could not be opened: it is not in your current vault, or its file could not be read.', 'warning', 'talk-not-read')
    })
    // Failed reads stay mutation-frozen; a subsequent load gets its own epoch.
    return () => { active = false }
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
      insertAtCaretLine(view, text, insertionCaret(view.state))
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
      // With an object selected, the new one goes after it, never into it (insertionCaret).
      const doc = view.state.doc.toString()
      const prepared = prepareObjectInsertDocument(doc, insertionCaret(view.state), request?.replace)
      // A caret inside the heading does not map past a Trigger-line insertion at heading.to.
      // Every object block goes below the heading's id and layout lines (headingEndInsert.ts), so
      // the id line stays directly under its heading.
      const splice = planObjectBlockSplice(
        prepared.doc,
        blockAnchorAfterLine(prepared.doc, prepared.at),
        block,
        openOffset
      )
      // Stamping the slide and replacing any picker text belong to the same Undo as insertion.
      const insert = { from: splice.from, to: splice.to, insert: splice.insert }
      const changes = doc === prepared.doc ? insert
        : view.state.changes(minimalChange(doc, prepared.doc)).compose(ChangeSet.of(insert, prepared.doc.length))
      view.dispatch({
        changes,
        selection: { anchor: splice.openFrom },
        annotations: isolateHistory.of('full'),
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
      promoteHeading: () => { const v = viewRef.current; if (v) runLineCommand(v, (target) => reLevel(target, -1, false)) },
      demoteHeading: () => { const v = viewRef.current; if (v) runLineCommand(v, (target) => reLevel(target, 1, false)) },
      bulletedList: () => { const v = viewRef.current; if (v) runActionBarEditing(v, 'bulleted-list') },
      numberedList: () => { const v = viewRef.current; if (v) runActionBarEditing(v, 'numbered-list') },
      normalizeTriggers: () => { const v = viewRef.current; if (v) normalizeTriggersCommand(v) },
      setQuoteForm: (form, compiledLayoutAt) => { const v = viewRef.current; if (v) { setQuoteFormAtCursor(v, form, compiledLayoutAt); v.focus() } },
      deleteSlide: () => { const v = viewRef.current; if (v) { deleteSlideAtCursor(v); v.focus() } },
      // Cancel the pending debounce and write the CURRENT doc immediately, so a caller that reads the
      // file straight after (detach) never races the 1.5s autosave. No-op-safe when nothing is pending.
      flushSave: async () => {
        // Opening, reading or switching views is not an edit. In particular, do not tidy layout
        // lines (and thereby stamp ids) in an untouched file when leaving it or pressing Save.
        // Position normalisation still runs for actual pending edits, as it does for autosave.
        if (saveTimerRef.current) {
          clearTimeout(saveTimerRef.current)
          saveTimerRef.current = null
        }
        const v = viewRef.current
        if (!v) return
        const current = v.state.doc.toString()
        if (!cleanDocumentRef.current.dirty) return
        // Never flush an empty doc (a fresh-mount transient before load) or one whose content isn't the
        // loaded talk's yet — the caller (detach / switch) only needs the just-typed real text.
        if (current.trim() === '' || loadedPathRef.current !== currentTalkRef.current) return
        await writeQueued(currentTalkRef.current, v.state)
      },
      // Capture binds its slide identity only after the acknowledged bytes (including minted IDs)
      // are adopted. Reuse dirty/acknowledged tracking: a timer is not a save receipt.
      settleSave: async (signal) => {
        const path = currentTalkRef.current
        const baseline = cleanDocumentRef.current
        for (;;) {
          signal?.throwIfAborted()
          if (saveTimerRef.current) {
            clearTimeout(saveTimerRef.current)
            saveTimerRef.current = null
          }
          const pending = baseline.pending
          if (pending && !await pending) throw new Error('The talk was not saved')
          signal?.throwIfAborted()
          if (baseline.pending && baseline.pending !== pending) continue
          const v = viewRef.current
          if (!v || cleanDocumentRef.current !== baseline || loadedPathRef.current !== path || currentTalkRef.current !== path)
            throw new Error('The open talk changed while saving')
          if (!baseline.dirty) return
          const current = v.state.doc.toString()
          if (!current.trim() || !await writeQueued(path, v.state))
            throw new Error('The talk was not saved')
          // Typing during the IPC can defer adoption. Save that newer buffer before binding an ID.
        }
      },
      forceSave: async (signal) => {
        signal?.throwIfAborted()
        if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
        const path = currentTalkRef.current
        const baseline = cleanDocumentRef.current
        await baseline.pending?.catch(() => false)
        signal?.throwIfAborted()
        const v = viewRef.current
        if (cleanDocumentRef.current !== baseline || currentTalkRef.current !== path) return false
        if (!v || loadedPathRef.current !== path) return false
        const current = v.state.doc.toString()
        if (current.trim() === '') return false
        return await writeQueued(path, v.state, editorRevision.current(), true)
      },
      cancelDebouncedSave: outlinePath => {
        if (loadedPathRef.current !== outlinePath || !saveTimerRef.current) return
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      },
      commitSlideMerge: ({ outlinePath, base, next, generation, deadline }) => queueOutlineWrite(outlinePath, async () => {
        const save = slideMergeSaveReply(generation)
        if (Date.now() >= deadline) return { ok: false, error: 'This merge review expired.' }
        const view = viewRef.current
        const active = () => viewRef.current === view && loadedPathRef.current === outlinePath && currentTalkRef.current === outlinePath
        const before = view?.state
        if (!view || !before || !active() || moveFrozenRef.current || loadFrozenRef.current || closeFrozenRef.current ||
            outlineDiskChanges.isDiscarded(outlinePath) || before.doc.toString() !== base) {
          return { ok: false, moved: true, error: 'The editor changed during the review. Open a new review to merge its current text.' }
        }
        if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
        seamSaveRef.current = null
        closeCompletion(view)
        const previous = cleanDocumentRef.current
        const staged = { text: previous.text, diskHash: previous.diskHash, dirty: true }
        cleanDocumentRef.current = staged // invalidate autosaves queued against the previous editor epoch
        provisionalTriggerRef.current = null
        const transaction = slideMergeTransaction(view.state, next)
        mergeSavingRef.current = true
        let refused = false
        try {
          view.dispatch(transaction)
          const text = view.state.doc.toString()
          const identity = captureOutlineIdentity(view.state, text, acknowledgedIds.current)
          let outcome: 'saved' | 'refused' | 'unconfirmed' = 'unconfirmed'
          try {
            const write = window.tw.talk.writeOutline(outlinePath, text, {
              revision: transaction.docChanged ? editorRevision.bump() : editorRevision.current(),
              slideMergeGeneration: generation,
            }).then(reply => reply && reply.ok ? 'saved' as const : 'refused' as const)
            const fallback = save?.then(reply => reply.ok ? 'saved' as const
              : reply.reason === 'save-timeout' ? 'refused' as const : 'unconfirmed' as const)
            outcome = await (fallback ? Promise.race([write, fallback]) : write)
          } catch {
            // The file may already hold the merge. Keep the staged text dirty for the next guarded save.
          }
          if (outcome === 'refused') {
            refused = true
            return { ok: false, error: 'The reviewed merge could not be saved.' }
          }
          const saved = outcome === 'saved'
          if (active() && cleanDocumentRef.current === staged) {
            if (saved) {
              identity.acknowledge(text)
              cleanDocumentRef.current = { text, dirty: false }
            }
            onContentChange(text)
            onDirtyRef.current?.(!saved)
            if (saved) onSaved?.()
          }
          return saved ? { ok: true, text } : { ok: false, error: 'The merge save could not be confirmed.' }
        } finally {
          mergeSavingRef.current = false
          if (refused && active() && cleanDocumentRef.current === staged) {
            // Restore the prior document AND history. An undo here would leave the refused merge
            // available as Redo, allowing its stale choices to be saved as an ordinary edit.
            view.setState(before)
            cleanDocumentRef.current = { text: previous.text, diskHash: previous.diskHash, dirty: previous.dirty }
          }
        }
      }),
      scrollCursorIntoView: () => {
        const v = viewRef.current
        if (!v) return
        const head = v.state.selection.main.head
        v.dispatch({ effects: EditorView.scrollIntoView(head, { y: 'start' }) })
        // Apply the scroll now. CodeMirror's next hit-test would otherwise flush this measure
        // and scroll under a pointer aimed at the previous viewport.
        v.coordsAtPos(head)
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
      pointAtCoords: (x, y) => {
        const view = viewRef.current
        const pos = view?.posAtCoords({ x, y }, false)
        return view && pos != null ? { pos, line: view.state.doc.lineAt(pos).number } : null
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
          const pasteTarget = currentTalkRef.current
          // Same source-talk asset rule as the DOM paste handler: relative image refs are
          // materialised into the vault pool so a pasted slide's images resolve here too.
          if (slideFiles(text).some(({ ref }) => ref) || /!\[[^\]]*\]\(assets\/[^)]+\.(?:png|jpe?g|gif|webp)\)/i.test(text)) {
            try {
              const res = await window.tw.talk.materializePastedAssets(text, pasteTarget)
              text = res?.markdown ?? text
            } catch { /* fall back to the raw text */ }
          }
          if (currentTalkRef.current !== pasteTarget) return
          const view = viewRef.current
          if (view && !pasteSlideTextAtCaret(view, text, clipboardText)) pasteTextAtSelection(view, text)
        }).catch(() => notify('Couldn’t read the clipboard — paste with ⌘V instead.', 'warning'))
      },
      slides: {
        cut: (line) => { const v = viewRef.current; return v ? recordSlideCopy(cutSlideAt(v, line)) : null },
        copy: (line) => { const v = viewRef.current; return v ? recordSlideCopy(copySlideAt(v, line)) : null },
        paste: (clip, afterLine) => {
          const view = viewRef.current
          if (!view) return null
          if (!slideFiles(clip).some(({ ref }) => ref)) return pasteSlidesAfter(view, clip, afterLine)
          const target = currentTalkRef.current
          const doc = view.state.doc
          return window.tw.talk.materializePastedAssets(clip, target).then((answer) => {
            if (!answer?.success || viewRef.current !== view || view.state.doc !== doc || currentTalkRef.current !== target) {
              notify('The slide files could not be pasted into this talk.', 'warning', 'slide-clipboard')
              return null
            }
            return pasteSlidesAfter(view, answer.markdown, afterLine, clip)
          }).catch(() => { notify('The slide files could not be pasted into this talk.', 'warning', 'slide-clipboard'); return null })
        },
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
      goToLine: () => {
        const v = viewRef.current
        if (v?.dom.isConnected) gotoLine(v)
      },
    }
    registerEditorCommands?.(cmds)
  }, [registerEditorCommands, writeQueued, onContentChange, onSaved])

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
    registerApplyOption?.((group, token, headingLine, slideId, compiledLayout) => {
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
        ? headingLineForSlideId(v.state.doc.toString(), slideId, group.key === 'arrival-mode')
        : headingLine ?? null
      if (slideId != null && ownHeadingLine == null) return null
      const current = target(ownHeadingLine ?? undefined)
      if (!current) return null
      const doc = v.state.doc.toString()
      const slide = { headingLine: current.headingLine }
      const cleanDesign = (text: string): string | null => {
        if (!/^#{2,6}\s/.test(v.state.doc.line(current.headingLine).text)) return text
        try {
          return reconcileSlideDesign(text, slide, compiledLayout, undefined, [{ group: group.key, token }])
        } catch (error) {
          notify(error instanceof LayoutVerbError ? error.detail : 'The change could not be applied to this slide.', 'warning')
          return null
        }
      }
      const original = current.trigger?.text ?? ''
      // Quote form: the verb, so an inferred quote slide never gains a `{quote}` token (see commitQuoteFormOption).
      if (group.key === 'quote-form') {
        const written = commitQuoteFormOption(doc, current.headingLine, token, compiledLayout)
        if (written) {
          if (written.outline !== doc) {
            const reconciled = cleanDesign(written.outline)
            if (reconciled == null) return null
            const spec = replaceDocTransaction(doc, reconciled, { ownUndoStep: true })
            if (spec) v.dispatch(spec)
          }
          return written.triggerLine
        }
      }
      // The Inspector edits the chosen option. Layout choices use their own transaction.
      const next = commitOptionSelection(original, group, token, deckCommitContext(doc, current.headingLine))
      const heading = v.state.doc.line(current.headingLine)
      // Old outlines can still carry the arrival token in the heading's trailing groups.
      const headingText = group.key === 'arrival-mode' && token === ''
        ? commitOptionSelection(heading.text, group, '', { trailingGroupsOnly: true, resetToInherited: true })
        : heading.text
      const headingChange = headingText === heading.text ? [] : [{ from: heading.from, to: heading.to, insert: headingText }]
      const plan = next === original && !current.needsMerge
        ? { changes: [], warnings: [] }
        : planEditorTriggerCommit(doc, current.headingLine, () => next)
      if (!headingChange.length && !plan.changes.length) return original
      reportTriggerMergeWarnings(plan.warnings)
      const transaction = v.state.update({ changes: [...headingChange, ...plan.changes], annotations: isolateHistory.of('full') })
      const writtenDoc = transaction.newDoc.toString()
      const reconciled = cleanDesign(writtenDoc)
      if (reconciled == null) return null
      if (reconciled !== writtenDoc) {
        const spec = replaceDocTransaction(doc, reconciled, { ownUndoStep: true })
        if (spec) v.dispatch(spec)
        return next
      }
      const echo = triggerEchoChange(original, next)
      const written = echo
        ? plan.changes.find((change) => change.insert.includes(next))
        : undefined
      const echoPosition = echo && written
        ? written.from + echo.from + headingText.length - heading.text.length
        : null
      v.dispatch(transaction)
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
      if (!view || mergeSavingRef.current) return null
      const loaded = !!loadedPathRef.current && loadedPathRef.current === currentTalkRef.current
      // A save-bound change needs the talk's real text in the doc: before the load lands the doc is a
      // transient the load will replace, so the change (and its save) would be lost or wrong.
      if ((opts?.save || opts?.fromDisk) && !loaded) return null
      if (opts?.fromDisk) {
        if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
        seamSaveRef.current = null
        // Cancel the old picker without replaying its pre-adoption document. Queued rollback
        // callbacks lose their snapshot identity too, and completion cannot apply an old range.
        provisionalTriggerRef.current = null
        closeCompletion(view)
        // Normalize before finding the minimal span: splitting a CRLF at a common LF suffix
        // would otherwise insert an extra newline when CodeMirror decodes the inserted CR.
        const normalized = view.state.toText(text.replace(/^\uFEFF/, '')).toString()
        const spec = replaceDocTransaction(view.state.doc.toString(), normalized, { ownUndoStep: true })
        adoptingDiskRef.current = true
        // Reload's text passes a close's freeze: the person chose it on the close's own sheet.
        try { if (spec) view.dispatch(spec, { annotations: [closeFreezeExempt.of(true), Transaction.addToHistory.of(false)] }) } finally { adoptingDiskRef.current = false }
        const diskBase = view.state.toText((opts.diskBase ?? text).replace(/^\uFEFF/, '')).toString()
        cleanDocumentRef.current = { text: diskBase, diskHash: opts.diskHash, dirty: view.state.doc.toString() !== diskBase }
        onDirtyRef.current?.(cleanDocumentRef.current.dirty)
        return view.state.doc.toString()
      }
      // The text a save wrote for `savedFrom`: adopted as the save's undo step, and only while the
      // buffer is still the text that save was made from (savedTextAdoption.ts). When this seam's
      // save branch below sent `savedFrom` tidied, that is the text before the tidy-up.
      if (typeof opts?.savedFrom === 'string') {
        const pending = seamSaveRef.current
        const sameSave = pending?.sent === opts.savedFrom
        const sameDocument = sameSave ? pending.doc === view.state.doc : opts.savedFrom === view.state.doc.toString()
        if (sameSave) seamSaveRef.current = null
        if (sameDocument) adoptSavedText(view, view.state.doc.toString(), text)
        delete cleanDocumentRef.current.diskHash
        cleanDocumentRef.current.text = view.state.toText(text).toString()
        cleanDocumentRef.current.dirty = !sameDocument
        onDirtyRef.current?.(cleanDocumentRef.current.dirty)
        return view.state.doc.toString()
      }
      // While closing, a command's edit is refused (rule B): the caller is told nothing was applied.
      if (closeFrozenRef.current) return null
      const spec = replaceDocTransaction(view.state.doc.toString(), text, { ownUndoStep: opts?.ownUndoStep })
      if (spec) view.dispatch(spec, { effects: opts?.headingOrder ? preserveHeadingOwners.of(opts.headingOrder) : undefined })
      if (!opts?.save) return view.state.doc.toString()
      // The caller saves the whole buffer now: the debounced autosave this dispatch (or an earlier
      // keystroke) scheduled is superseded. Same position-only normalisation as flushSave.
      if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
      // The editor is not tidied here: the caller adopts what the save wrote (`savedFrom` above), and
      // the tidy-up comes back with the save's ids as one undo step.
      const current = view.state.doc.toString()
      if (opts.reviewedLayoutRepair && current !== text) return null
      // Layout Doctor has already tidied and reviewed the selected slide’s exact text.
      const normalized = opts.reviewedLayoutRepair ? current : textForSave(view.state, current)
      seamSaveRef.current = { sent: normalized, doc: view.state.doc, identity: captureOutlineIdentity(view.state, normalized, acknowledgedIds.current) }
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
    registerReadDoc(options => {
      const view = viewRef.current
      if (!view || !loadedPathRef.current || loadedPathRef.current !== currentTalkRef.current) return null
      if (options?.discardProvisionalTrigger && provisionalTriggerRef.current) {
        // A notes input can dispatch before the deferred blur rollback. Plan the edit against
        // the authored buffer so that rollback can only remove the unfinished layout code.
        rollbackProvisionalTrigger(view)
        if (provisionalTriggerRef.current) return null
        closeCompletion(view)
      }
      const provisional = provisionalTriggerRef.current
      const text = options?.authoredOnly && provisional?.epoch === cleanDocumentRef.current
        ? provisional.before : view.state.doc.toString()
      const pending = seamSaveRef.current
      const saveIdentity = pending && options?.saveText === pending.sent ? pending.identity : undefined
      return { path: currentTalkRef.current, text, caret: view.state.selection.main.head, base: cleanDocumentRef.current.text, dirty: cleanDocumentRef.current.dirty, epoch: cleanDocumentRef.current, diskHash: cleanDocumentRef.current.diskHash, saveIdentity }
    })
  }, [registerReadDoc, rollbackProvisionalTrigger])

  useEffect(() => {
    viewRef.current?.dispatch({ effects: setPictureProgress.of(pictureProgress) })
  }, [pictureProgress])

  // Scroll to + place the cursor at focusLine (1-based) whenever it changes.
  useEffect(() => {
    if (focusLine == null) return
    const view = viewRef.current
    if (!view) return
    const clamped = Math.max(1, Math.min(focusLine.line, view.state.doc.lines))
    const line = view.state.doc.line(clamped)
    const prefix = focusLine.editTitle ? line.text.match(/^#{1,6}[ 	]+/)?.[0].length ?? 0 : 0
    // An untitled divider reserves its second space to separate the name from its ID while typing.
    const reservedSpace = focusLine.editTitle && /^#{2,6} {2}\{id=[\w-]+\}$/.test(line.text) ? 1 : 0
    const anchor = line.from + prefix - reservedSpace
    const head = focusLine.selectPlaceholder && line.text[prefix] === '—' ? anchor + 1 : anchor
    const reveal = viewMode === 'markdown' ? revealFoldedLine(view.state, line.from) : []
    view.dispatch({
      selection: { anchor, head },
      // 'start' parks the target line at the TOP of the editor viewport — matching the slide
      // strip/preview, which already scrolls the selected card to the top. 'center' left the
      // jumped-to slide mid-screen, which read as inconsistent with the previews.
      effects: focusRange && startWithBullet ? reveal
        : [...reveal, EditorView.scrollIntoView(line.from, { y: 'start' })]
    })
    if (focusLine.takeFocus) view.focus()
  }, [focusLine])

  return <div ref={containerRef} className="editor-container" data-place-region="editor" />
}
