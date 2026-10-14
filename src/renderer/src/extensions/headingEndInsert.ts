// Text with a line break put in at the END of a heading line: the heading's id line and the other
// trigger-only lines under it stay directly under the heading.
//
// THE INVARIANT: a heading's Trigger block (its `{id=…}` and layout lines, as
// logicalTriggerBlockAfterHeading in src/shared/trigger-line.ts reads it) is still directly under
// that heading after an ordinary paste or Enter with the caret at the end of the heading line.
// 0.38.3-preview.12: `# install\nnpm i foo` pasted at the end of `### Slide 3.0` put `npm i foo`
// between the title and `{id=s3-0}`; the id was stranded under a body line and the next save gave
// the heading a new one, so the slide's identity changed.
//
// What happens instead: the first line of the inserted text stays on the heading line, and the rest
// goes in AFTER the last line of the Trigger block. For Enter the inserted text is one line break,
// so the new empty line and the caret are after the block. One transaction, one undo step.
//
// This is a handler the paste handler (Editor.tsx) and the Enter command (outliner.ts
// enterFromHeading) call before they dispatch. It is not a transaction filter and rewrites nobody
// else's change. It only acts on: one caret, no selection, at the end of a heading line outside a
// code fence, whose Trigger block exists. Everything else is left to the caller's ordinary path
// (a line break inserted in the MIDDLE of a title still splits the title, as before).
//
// A BLOCK (a picture or clip line, a fenced SVG, a table, an object, a dropped file, an imported
// slide) is not prose: none of it belongs on the title. It goes in whole after the last line of the
// Trigger block, starting on its own line, and the heading line is not touched. Two entries:
// insertBlockAfterLine for the paths that put a block after the line at a position (the caret may be
// anywhere on the heading line), and insertBlockAtHeadingEnd for a block pasted as text with the
// caret at the end of the heading line. Both take the place from blockAnchorAfterLine, so no caller
// works the position out itself.
//
// WHOLE SLIDES put in at the caret (the slide picker's insert, a slide from another talk; text whose
// first line is a heading) with the caret on a heading line are not put under that heading's id
// line: that would give the heading's own body to the new slide. They go after the whole block of
// the caret's heading, where a whole-slide paste "after this slide" lands (slideBlockOps.ts
// pasteSlides). caretLineInsertion is the one place that decides between the two.
// scripts/test-protected-lines.mjs tests it.
import { EditorSelection, Facet, type EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { isBareUrl, PARAGRAPH_STOP_RE } from '../../../../compiler/scripts/lib/02-triggers-layout.mjs'
import { LAYOUTS } from '../../../shared/layout-registry/entries'
import { headingLevels } from '../../../shared/heading-lines'
import { logicalTriggerBlockAfterHeading } from '../../../shared/trigger-line'
import { isSlideClip, isTalkTitleLine, isTitleClip, pasteSlides, startOfTalkPlace } from './slideBlockOps'

/**
 * "The caret is at the end of its line" for a view that hides text at the end of a line. The Plain
 * view hides a title's trailing `{…}` groups and rests the caret before them, at the end of the
 * title's visible text; it answers here with the line's end for such a caret (plainView/
 * iconPictures.ts lineEndPastTokens), and null for any other. Without it a paste there went in
 * before the hidden groups and carried them, and the id line under the title, down under the
 * pasted text. The first line of pasted prose still goes in at the caret, before the groups.
 */
export const lineEndCarets = Facet.define<(state: EditorState) => number | null>()

function caretAsLineEnd(state: EditorState): number {
  for (const read of state.facet(lineEndCarets)) {
    const end = read(state)
    if (end !== null) return end
  }
  return state.selection.main.head
}

export interface HeadingEndInsertion {
  /** Pure insertions, positions in the text before the change, in document order. */
  changes: Array<{ from: number; insert: string }>
  /** The caret after the change (a position in the text after it): the end of the inserted text. */
  cursor: number
}

interface LineUnderHeadingRule {
  /** The end of the line that holds the position. */
  lineEnd: number
  /** The end of the last line of the Trigger block, when that line is a heading (outside a code fence) with a Trigger block under it. */
  blockEnd: number | null
  /** The Trigger block's last line is the last line of the text. */
  blockEndsText: boolean
}

/** The line that holds `pos`: its 0-based index and the position of its end. */
function lineAt(lines: readonly string[], pos: number): { index: number; lineEnd: number } {
  let index = 0
  let lineFrom = 0
  while (index < lines.length - 1 && lineFrom + lines[index].length < pos) {
    lineFrom += lines[index].length + 1
    index += 1
  }
  return { index, lineEnd: lineFrom + lines[index].length }
}

/** A heading line as src/shared/heading-lines.ts reads it (outside code fences, the frontmatter and
 *  HTML comments). One scan of the text per insertion; it is asked of one line. */
const isHeadingLine = (lines: string[], index: number): boolean => headingLevels(lines)[index] > 0

function lineUnderHeadingRule(text: string, pos: number): LineUnderHeadingRule {
  const lines = text.split('\n')
  const { index, lineEnd } = lineAt(lines, pos)
  const none = { lineEnd, blockEnd: null, blockEndsText: false }
  if (!isHeadingLine(lines, index)) return none
  const block = logicalTriggerBlockAfterHeading(lines, index)
  if (!block) return none
  let blockEnd = lineEnd
  for (let i = index + 1; i < block.end; i += 1) blockEnd += 1 + lines[i].length
  return { lineEnd, blockEnd, blockEndsText: block.end >= lines.length }
}

/**
 * How `insert` goes in at `pos`, or null when this rule does not apply: `insert` has no line break,
 * `pos` is not the end of a heading line, the line is inside a code fence, or the heading has no
 * Trigger block under it. `end` is `pos` as the end of its line when a view counts it as one
 * (lineEndCarets); the first line of `insert` goes in at `pos` all the same.
 */
export function headingEndInsertion(text: string, pos: number, insert: string, end = pos): HeadingEndInsertion | null {
  const lf = insert.replace(/\r\n?/g, '\n')
  const br = lf.indexOf('\n')
  if (br < 0) return null
  const at = lineUnderHeadingRule(text, pos)
  if (end !== at.lineEnd || at.blockEnd === null) return null
  const first = lf.slice(0, br)
  const rest = lf.slice(br + 1)
  // After the block's last line: at the start of the line that follows it (that line, the body or
  // the next heading, moves down whole), or at the end of the text when the block ends it. Neither
  // place is inside the id token or the heading, so the id and heading guard passes both.
  const after = at.blockEnd
  const atEnd = at.blockEndsText
  const tail = atEnd ? { from: after, insert: '\n' + rest } : { from: after + 1, insert: rest + '\n' }
  const cursor = tail.from + first.length + (atEnd ? 1 : 0) + rest.length
  return { changes: first === '' ? [tail] : [{ from: pos, insert: first }, tail], cursor }
}

/**
 * Put `text` in at the caret under the rule above. False when the rule does not apply (nothing was
 * dispatched: the caller inserts as it always did). True when it did, also when a guard refused the
 * change, so the caller never falls back to the insertion this rule replaces.
 */
export function insertAtHeadingEnd(view: EditorView, text: string, userEvent: string): boolean {
  const sel = view.state.selection
  if (view.state.readOnly || sel.ranges.length !== 1 || !sel.main.empty) return false
  const plan = headingEndInsertion(view.state.doc.toString(), sel.main.head, text, caretAsLineEnd(view.state))
  if (!plan) return false
  view.dispatch({ changes: plan.changes, selection: EditorSelection.cursor(plan.cursor), userEvent, scrollIntoView: true })
  return true
}

/**
 * Where a block put in "after the line that holds `pos`" starts from: the end of that line, or, when
 * the line is a heading (outside a code fence) with a Trigger block under it, the end of the block's
 * last line. `pos` may be anywhere on the line. An insertion here that starts with a line break
 * leaves the heading and its id and layout lines as they are.
 */
export function blockAnchorAfterLine(text: string, pos: number): number {
  const at = lineUnderHeadingRule(text, pos)
  return at.blockEnd ?? at.lineEnd
}

/**
 * Put a block in after the line that holds `pos` (blockAnchorAfterLine): one transaction, one undo
 * step. `insert` is the whole inserted text and starts with the line break that puts the block on
 * its own line. `caret` is the caret's distance from the place of insertion (as each caller counted
 * it from the end of the line); without it the selection is left to map through the change.
 * Returns the place of insertion.
 */
export function insertBlockAfterLine(
  view: EditorView,
  pos: number,
  insert: string,
  options: { caret?: number; scrollIntoView?: boolean } = {}
): number {
  const from = blockAnchorAfterLine(view.state.doc.toString(), pos)
  view.dispatch({
    changes: { from, insert },
    ...(options.caret === undefined ? {} : { selection: EditorSelection.cursor(from + options.caret) }),
    ...(options.scrollIntoView ? { scrollIntoView: true } : {})
  })
  return from
}

/**
 * A block pasted as text (a fenced SVG, a table, a picture line) with the caret at the end of a
 * heading line that has a Trigger block: the whole block goes in after the block's last line, on its
 * own line, and the caret is at the end of it. False when that is not the case (nothing dispatched).
 */
export function insertBlockAtHeadingEnd(view: EditorView, text: string, userEvent: string): boolean {
  const sel = view.state.selection
  if (view.state.readOnly || sel.ranges.length !== 1 || !sel.main.empty) return false
  const at = lineUnderHeadingRule(view.state.doc.toString(), sel.main.head)
  if (caretAsLineEnd(view.state) !== at.lineEnd || at.blockEnd === null) return false
  const insert = '\n' + text.replace(/\r\n?/g, '\n')
  view.dispatch({
    changes: { from: at.blockEnd, insert },
    selection: EditorSelection.cursor(at.blockEnd + insert.length),
    userEvent,
    scrollIntoView: true
  })
  return true
}

export interface CaretLineInsertion {
  /** One pure insertion: the text after it is `text.slice(0, from) + insert + text.slice(from)`. */
  from: number
  insert: string
  /** The caret after the change (a position in the text after it). */
  cursor: number
}

/**
 * Where whole slides (`block`: text whose first line is a slide heading) go when the caret is on a
 * heading line outside a code fence: after the whole block of that heading (its body, and its slides
 * when it is a section), with the blank lines a whole-slide paste "after this slide" puts round them,
 * and never before the talk's title (slideBlockOps.ts pasteSlides decides all of it). The slides go
 * in exactly as given: unlike a paste, an id the talk already has is NOT replaced here (the insert
 * channel keeps ids as they came and the save reports a collision, as it does on a body line). The
 * caret ends at the end of the last inserted line. Null when this is not that case.
 *
 * With the caret on the talk's TITLE (its level-1 line, where a freshly opened talk has its caret)
 * the title's block is the whole talk, so "after it" would be the end of the talk. The slides go
 * to the start of the talk instead: after the title's own lines (its id and layout lines, any text
 * of its own) and before the first slide or section, where "Move … to… Start of talk" lands
 * (slideBlockOps.ts startOfTalkPlace); the end of the talk only when it has no slide yet.
 */
function slidesAfterCaretHeading(text: string, pos: number, block: string): CaretLineInsertion | null {
  if (!isSlideClip(block) || isTitleClip(block)) return null
  const lines = text.split('\n')
  const { index } = lineAt(lines, pos)
  if (!isHeadingLine(lines, index)) return null
  // pasteSlides re-ids a collision through the minter. Each minted id is a marker, put back to the
  // id it replaced, so the inserted text is the given text.
  let n = 0
  const marker = (taken: Set<string>): string => {
    let id = ''
    do { id = `tw-insert-keeps-id-${n}`; n += 1 } while (taken.has(id))
    return id
  }
  const place = isTalkTitleLine(text, index + 1) ? startOfTalkPlace(text) : { after: index + 1 }
  const paste = pasteSlides(text, block, place, marker)
  if (!paste) return null
  let insert = paste.insert
  for (const { from: id, to } of paste.reIds) insert = insert.split(`{id=${to}}`).join(`{id=${id}}`)
  return { from: paste.from, insert, cursor: paste.from + insert.length - (/\n*$/.exec(insert)?.[0].length ?? 0) }
}

/**
 * How `source` (a component, a picture line, or one or more whole slides) goes in "at the caret" at
 * `pos`. Whole slides with the caret on a heading line: after that heading's whole block
 * (slidesAfterCaretHeading). Everything else: after the line that holds `pos` (blockAnchorAfterLine,
 * so under a heading's id and layout lines), a blank line before it, the caret after it.
 */
export function caretLineInsertion(text: string, pos: number, source: string): CaretLineInsertion {
  const block = source.replace(/^\n+/, '').replace(/\n+$/, '')
  const slides = slidesAfterCaretHeading(text, pos, block)
  if (slides) return slides
  const insert = '\n\n' + block + '\n'
  const from = blockAnchorAfterLine(text, pos)
  return { from, insert, cursor: from + insert.length }
}

/** Put `source` in at the caret as caretLineInsertion says: one transaction, one undo step. */
export function insertAtCaretLine(view: EditorView, source: string): void {
  const plan = caretLineInsertion(view.state.doc.toString(), view.state.selection.main.head, source)
  view.dispatch({ changes: { from: plan.from, insert: plan.insert }, selection: EditorSelection.cursor(plan.cursor), scrollIntoView: true })
}

// The words of the component lines the Insert menu writes (`[QR: …]`, `[Action: …]`, `[Embed: …]`),
// read off the layout registry's component entries.
let componentWords: Set<string> | null = null
function registeredComponentWords(): Set<string> {
  componentWords ??= new Set(LAYOUTS.flatMap((entry) => {
    const word = entry.kind === 'component' ? /^\[([A-Za-z]+):/.exec(entry.trigger)?.[1] : undefined
    return word ? [word.toLowerCase()] : []
  }))
  return componentWords
}

const COMPONENT_LINE_MAX = 2000

/**
 * A line that is only a component: `[Word: …]` (optionally the `(url)` of an action and trailing
 * `{…}` groups) whose word the layout registry lists as a component or the compiler's lexer ends a
 * paragraph at (PARAGRAPH_STOP_RE: Embed, Simulation, Video), or a URL alone on its line (the
 * registry's auto-embed component, by the compiler's isBareUrl).
 */
function isComponentLine(line: string): boolean {
  const t = line.trim()
  // A line this long is prose. The pattern below backtracks quadratically on a long run of `]{`
  // (20,000 of them took 314 ms); at 2,000 characters the worst case is a few milliseconds.
  if (t.length > COMPONENT_LINE_MAX) return false
  if (isBareUrl(t)) return true
  const m = /^\[([A-Za-z]+):\s*\S.*\](?:\(\S+?\))?(?:\s*\{[^}]*\})*$/.exec(t)
  return m !== null && (registeredComponentWords().has(m[1].toLowerCase()) || PARAGRAPH_STOP_RE.test(t))
}

// A fence opener: three or more backticks (no backtick after them on the line: `` ```a``` `` is
// inline code) or three or more tildes, with an optional info string.
const FENCE_OPENER_RE = /^ {0,3}(?:`{3,}[^`]*|~{3,}.*)$/
// A table's separator row: `|---|---|`, colons allowed, the outer pipes optional.
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/
// An HTML block opener: `<tag` (then a space, `/`, `>` or the end of the line), `</tag` or `<!`.
// `<https://example.com>` is a link, not a tag.
const HTML_OPENER_RE = /^ {0,3}<(?:[A-Za-z][A-Za-z0-9-]*(?=[\s/>]|$)|\/[A-Za-z]|!)/
const PICTURE_LINE_RE = /^!\[[^\]]*\]\([^)]*\)(?:\{[^}]*\})*\s*$/

/**
 * Text whose first line is a block, not prose. Detected: a code fence opener (backticks or tildes);
 * a table row (a line starting with `|` whose NEXT line is a separator row); a line that is only a
 * picture or clip; a line that is only a component (`[Embed: …]`, `[Simulation: …]`, `[Video: …]`,
 * `[QR: …]`, `[Action: …]`, a URL alone); an HTML block opener. Not detected, so prose: a line that
 * merely starts with `|` or with inline code, a picture or component inside a sentence, a heading,
 * a list, a quotation, a table written without its leading `|`.
 */
export function startsWithBlockLine(text: string): boolean {
  const [first, second] = text.replace(/\r\n?/g, '\n').split('\n', 2)
  if (FENCE_OPENER_RE.test(first) || PICTURE_LINE_RE.test(first) || HTML_OPENER_RE.test(first)) return true
  if (/^\s*\|/.test(first) && second !== undefined && second.includes('|') && TABLE_SEPARATOR_RE.test(second)) return true
  return isComponentLine(first)
}

/**
 * Pasted text with the caret at the end of a heading line that has a Trigger block: a block goes in
 * whole under the Trigger block, prose keeps its first line on the title. False when neither rule
 * applies (nothing dispatched).
 */
export function pasteAtHeadingEnd(view: EditorView, text: string): boolean {
  if (startsWithBlockLine(text)) return insertBlockAtHeadingEnd(view, text, 'input.paste')
  return insertAtHeadingEnd(view, text, 'input.paste')
}

/** Pasted text replacing the selection: under the rules above when one applies, as CodeMirror's replaceSelection otherwise. */
export function pasteTextAtSelection(view: EditorView, text: string): void {
  if (!pasteAtHeadingEnd(view, text)) view.dispatch(view.state.replaceSelection(text))
}

/** A pasted block (a fenced SVG, a table) replacing the selection: under the Trigger block at a heading end, as CodeMirror's replaceSelection otherwise. */
export function pasteBlockAtSelection(view: EditorView, text: string): void {
  if (!insertBlockAtHeadingEnd(view, text, 'input.paste')) view.dispatch(view.state.replaceSelection(text))
}
