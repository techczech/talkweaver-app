// Cut, copy, paste and "Move … to…" of whole slides in the CodeMirror editor. The block arithmetic is
// slideBlockOps.ts (pure, table-tested); this file turns it into one transaction per operation and
// says what happened in a toast.
//
// The guard (idProtect.ts) is not weakened: a whole-slide cut is its own transaction with the user
// event SLIDE_CUT_EVENT, exempted from the heading guard exactly as `delete.slide` is (the id guard
// still checks it, and passes it because the heading goes with its id line). Every other cut,
// Backspace and Delete go through the guard as before.
//
// Line numbers are 1-based heading lines of the editor's current text.
import { EditorView } from '@codemirror/view'
import { EditorSelection, type Extension } from '@codemirror/state'
import { isolateHistory } from '@codemirror/commands'
import { notify } from '../lib/notify'
import { minimalChange } from '../lib/minimalChange'
import { moveMessage } from '../lib/moveDestinations'
import { mintEditorSlideId } from './inlineTriggerCommitModel'
import { deleteSlideAtCursor } from './outliner'
import { slideRows } from './slideOutline'
import {
  blockAt, caretPastePlace, copyBlock, cutBlock, headingLineAt, isOwnSlideClip, isSlideClip, isTitleClip, moveBlock, pasteSlides, rememberSlideClip,
  touchesTitleLine, widenToBlocks,
  type MoveTarget, type PastePlace
} from './slideBlockOps'

/** The user event of a whole-slide cut (a `delete.cut`, so history and listeners read it as a cut). */
export const SLIDE_CUT_EVENT = 'delete.cut.slide'

const TOAST_KEY = 'slide-clipboard'
/** Said when a whole-slide cut is asked of the talk's title (a level-1 heading). */
export const TITLE_CUT_REFUSED = 'The talk’s title can’t be cut.'
/** Said when a slide paste is asked for and the clipboard is not a slide this app cut or copied. */
export const NOTHING_TO_PASTE = 'Nothing to paste. Cut or copy a slide first.'
const quoted = (title: string): string => `“${title}”`
const kindOf = (section: boolean): string => (section ? 'section' : 'slide')
const mint = (taken: Set<string>): string => mintEditorSlideId(Math.random, taken)
// One undo step each, never joined to the edit before or after it.
const ownStep = (): ReturnType<typeof isolateHistory.of> => isolateHistory.of('full')

/**
 * Cut the slide or section headed at `headingLine`. Returns the Markdown for the clipboard, or null
 * when nothing was cut. Every whole-slide cut (the editor's ⌘X, the commands, the outline and grid
 * menus and keys) is this function, so the refusal of the talk's title is here and nowhere else.
 */
export function cutSlideAt(view: EditorView, headingLine: number): string | null {
  if (view.state.readOnly) return null
  const before = view.state.doc
  if (blockAt(before.toString(), headingLine)?.level === 1) {
    notify(TITLE_CUT_REFUSED, 'info', TOAST_KEY)
    return null
  }
  const cut = cutBlock(before.toString(), headingLine)
  if (!cut) return null
  view.dispatch({
    changes: { from: cut.from, to: cut.to, insert: '' },
    selection: EditorSelection.cursor(Math.min(cut.from, before.length - (cut.to - cut.from))),
    userEvent: SLIDE_CUT_EVENT,
    annotations: ownStep(),
    scrollIntoView: true
  })
  if (view.state.doc === before) return null // refused (e.g. outside the slide in Slide Focus)
  rememberSlideClip(cut.clip)
  notify(`Cut ${kindOf(cut.block.section)} ${quoted(cut.block.title)}. Paste with ⌘V.`, 'info', TOAST_KEY)
  return cut.clip
}

/** The Markdown of the slide or section headed at `headingLine`, for the clipboard. The talk is not changed. */
export function copySlideAt(view: EditorView, headingLine: number): string | null {
  const copy = copyBlock(view.state.doc.toString(), headingLine)
  if (!copy) return null
  // The talk's title: its text is copied, but it is not a slide to paste (pasting it is ordinary text).
  if (copy.block.level > 1) rememberSlideClip(copy.clip)
  notify(`Copied ${kindOf(copy.block.section)} ${quoted(copy.block.title)}. Paste with ⌘V.`, 'info', TOAST_KEY)
  return copy.clip
}

/**
 * Paste the slide blocks in `clip` as whole slides at `place`. A pasted slide whose id is already in
 * the talk gets a fresh one in the same step. Returns the 1-based line of the first pasted heading,
 * or null when nothing was pasted (the clip is not slides, or the place is gone). The callers decide
 * that the clipboard is a slide this app cut or copied (isOwnSlideClip); this checks the shape only,
 * because `clip` may be that text with its image references rewritten for this talk.
 */
export function pasteSlidesAt(view: EditorView, clip: string, place: PastePlace): number | null {
  if (view.state.readOnly) return null
  if (!isSlideClip(clip) || isTitleClip(clip)) {
    notify(NOTHING_TO_PASTE, 'info', TOAST_KEY)
    return null
  }
  const before = view.state.doc
  const paste = pasteSlides(before.toString(), clip, place, mint)
  if (!paste) return null
  const headingFrom = paste.text.split('\n').slice(0, paste.line - 1).reduce((n, l) => n + l.length + 1, 0)
  view.dispatch({
    changes: { from: paste.from, insert: paste.insert },
    selection: EditorSelection.cursor(headingFrom),
    userEvent: 'input.paste',
    annotations: ownStep(),
    scrollIntoView: true
  })
  if (view.state.doc === before) return null
  const what = paste.count === 1 ? `${kindOf(paste.section)} ${quoted(paste.title)}` : `${paste.count} slides`
  const where = paste.anchor ? `${paste.anchor.relation} ${quoted(paste.anchor.title)}` : 'at the end of the talk'
  notify(`Pasted ${what} ${where}.`, 'info', TOAST_KEY)
  return paste.line
}

/**
 * Paste after the slide or section headed at `afterLine`; at the end of the talk when it is null.
 * Only text this app last wrote with a whole-slide cut or copy is pasted; for anything else nothing
 * changes and the toast says so.
 */
export function pasteSlidesAfter(view: EditorView, clip: string, afterLine: number | null): number | null {
  if (view.state.readOnly) return null
  if (!isOwnSlideClip(clip)) {
    notify(NOTHING_TO_PASTE, 'info', TOAST_KEY)
    return null
  }
  const text = view.state.doc.toString()
  return pasteSlidesAt(view, clip, afterLine != null && blockAt(text, afterLine) ? { after: afterLine } : 'end')
}

/**
 * Clipboard text pasted with the caret (no selection) on a heading line or between slides: when it
 * is a slide this app cut or copied, it goes in as whole slides after the current slide. False =
 * not handled, paste it as ordinary text. `clipboardText` is the text as the clipboard held it, when
 * `text` is that text rewritten (image references materialised for this talk).
 */
export function pasteSlideTextAtCaret(view: EditorView, text: string, clipboardText: string = text): boolean {
  const sel = view.state.selection
  if (sel.ranges.length !== 1 || !sel.main.empty || !isOwnSlideClip(clipboardText) || !isSlideClip(text)) return false
  const place = caretPastePlace(view.state.doc.toString(), view.state.doc.lineAt(sel.main.head).number)
  if (!place) return false
  pasteSlidesAt(view, text, place)
  return true
}
/** Whether pasteSlideTextAtCaret would take this text (asked before the text is fetched or rewritten). */
export function wouldPasteAsSlides(view: EditorView, text: string): boolean {
  const sel = view.state.selection
  if (sel.ranges.length !== 1 || !sel.main.empty || !isOwnSlideClip(text)) return false
  return caretPastePlace(view.state.doc.toString(), view.state.doc.lineAt(sel.main.head).number) != null
}

/**
 * Move the slide or section headed at `fromLine` to `target`: one minimal change (one undo step),
 * the caret on the moved heading. Returns its new 1-based line, or null when nothing moved.
 */
export function moveSlideTo(view: EditorView, fromLine: number, target: MoveTarget): number | null {
  if (view.state.readOnly) return null
  const text = view.state.doc.toString()
  const rows = slideRows(text)
  const moved = moveBlock(text, fromLine, target)
  if (!moved) {
    const title = rows.find((r) => r.line === fromLine)?.text
    if (title) notify(`${quoted(title)} is already there.`, 'info', TOAST_KEY)
    return null
  }
  const ch = minimalChange(text, moved.text)
  const headingFrom = moved.text.split('\n').slice(0, moved.line - 1).reduce((n, l) => n + l.length + 1, 0)
  // No user event, like the drag moves (moveBlockTo): the text is only reordered.
  view.dispatch({
    changes: { from: ch.from, to: ch.to, insert: ch.insert },
    selection: EditorSelection.cursor(headingFrom),
    annotations: ownStep(),
    scrollIntoView: true
  })
  notify(moveMessage(rows, fromLine, target), 'info', TOAST_KEY)
  return moved.line
}

/** Delete the slide headed at `headingLine` (the Delete slide command, aimed at a line). */
export function deleteSlideAt(view: EditorView, headingLine: number): void {
  const doc = view.state.doc
  if (headingLine < 1 || headingLine > doc.lines) return
  view.dispatch({ selection: EditorSelection.cursor(doc.line(headingLine).from) })
  deleteSlideAtCursor(view)
}

// ── ⌘X / ⌘C in the editor (and the Edit menu and Actions here, which fire the same DOM events) ──

function widenedMessage(verb: 'Cut' | 'Copied', titles: readonly string[]): string {
  return titles.length === 1
    ? `${verb} the whole slide ${quoted(titles[0])}: its title was in the selection.`
    : `${verb} ${titles.length} whole slides: their titles were in the selection.`
}

function onCutOrCopy(event: ClipboardEvent, view: EditorView, cut: boolean): boolean {
  const sel = view.state.selection
  if (sel.ranges.length !== 1 || !event.clipboardData) return false
  if (cut && view.state.readOnly) return false
  const text = view.state.doc.toString()
  if (sel.main.empty) {
    // No selection, caret on a slide's heading (or its layout/trigger/id lines): the whole slide.
    const heading = headingLineAt(text, view.state.doc.lineAt(sel.main.head).number)
    if (heading == null) return false
    const clip = cut ? cutSlideAt(view, heading) : copySlideAt(view, heading)
    event.preventDefault()
    if (clip != null) event.clipboardData.setData('text/plain', clip)
    return true
  }
  // A selection holding an entire heading line takes that slide's whole block. A selection that
  // already ends at a block's end, or holds no entire heading line, is CodeMirror's own cut or copy.
  // A selection that touches the talk's title line (#) is never a whole-slide cut or copy. Copy is
  // CodeMirror's own: exactly the selected text, not recorded as a slide. A cut that holds an entire
  // heading line (the title's or a slide's) is refused whole: widened, or left to the heading guard,
  // it would take the title with the slides. A selection inside the title's text alone is ordinary text.
  const onTitle = touchesTitleLine(text, sel.main.from, sel.main.to)
  if (onTitle && !cut) return false
  const wide = widenToBlocks(text, sel.main.from, sel.main.to)
  if (onTitle && wide) {
    event.preventDefault()
    notify(TITLE_CUT_REFUSED, 'info', TOAST_KEY)
    return true
  }
  if (!wide || wide.to === sel.main.to) return false
  event.preventDefault()
  if (cut) {
    const before = view.state.doc
    // An ordinary cut of a wider range: the guard judges it (a title cut in half at its far end is still refused).
    view.dispatch({
      changes: { from: wide.from, to: wide.to, insert: '' },
      selection: EditorSelection.cursor(wide.from),
      userEvent: 'delete.cut',
      annotations: ownStep(),
      scrollIntoView: true
    })
    if (view.state.doc === before) return true
  }
  event.clipboardData.setData('text/plain', text.slice(wide.from, wide.to))
  rememberSlideClip(text.slice(wide.from, wide.to))
  notify(widenedMessage(cut ? 'Cut' : 'Copied', wide.titles), 'info', TOAST_KEY)
  return true
}

/** The editor's whole-slide cut and copy. Paste is called from the editor's one paste handler (Editor.tsx). */
export function slideCutCopyExtension(): Extension {
  return EditorView.domEventHandlers({
    cut: (event, view) => onCutOrCopy(event, view, true),
    copy: (event, view) => onCutOrCopy(event, view, false)
  })
}
