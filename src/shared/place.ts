// Place: what the caret or the selected row is on (onboarding 0.38.1 ticket 02, lock decision 15).
// The status-bar chip names it and counts its commands; Actions here (⌘K, ticket 03) and the
// keyboard sheet's Here section (ticket 04) list the same commands, from `actionsAt`.
//
// THE RULES
//
// 1. ONE ANSWER. `placeAt` returns exactly one of the ten places. The first rule that matches decides:
//      a. Keyboard focus in the Talks panel with a row focused: the row's place. A talk row is "on a
//         talk"; a vault row and a folder row are "on a vault" (the ten places have no folder; a
//         folder row offers the same container commands as a vault row: new talk, new folder, open
//         in a new window, sort, filter).
//      b. Keyboard focus in the slide strip or the grid: "on a slide in the strip".
//      c. Otherwise the outline editor's place, from the line under the caret (rule 2). With a
//         selection, the line of the selection's head (where the caret is drawn) decides; a
//         selection is not a place of its own.
//    Focus anywhere else (a dialog, the toolbar, the status bar itself) keeps the last answer.
//
// 2. THE OUTLINE LINE, innermost construct first:
//      a. In the metadata: the file opens with `---` and the caret's line is that line, or comes
//         before the closing `---`, or is that closing line.
//      b. `# ` at the start of the line: on the talk title.
//      c. `## ` to `###### ` at the start of the line: on a slide heading (the compiler's
//         heading-is-slide law, PROTECTED_HEADING_RE). A heading carrying a trailing `{id=…}` is
//         still a heading.
//      d. A line made only of `{…}` groups (`{statement}`, `{id=s1}`): on a layout line (the
//         compiler's TRIGGER_LINE_RE).
//      e. Quotation and list markers at the start of the line are read left to right; the LAST one
//         is the innermost construct and wins: `> - item` is in a list, `- > words` is in a
//         quotation, `> > words` is in a quotation. A heading or `{…}` after a marker belongs to the
//         quotation or list (the compiler reads neither as a slide heading or layout line there).
//      f. Anything else, a blank line included, is in slide text.
//
// 3. PURE AND CHEAP. `placeOfLine` reads the caret's line and, only when the file opens with
//    `---`, at most the lines from 2 to the caret's line, never beyond METADATA_SCAN_LINES. It never
//    parses the outline. It runs on every selection change.
//
// 4. THE COUNT IS THE LIST. `actionsAt(place)` is the one list; the chip shows its length.
import { TRIGGER_LINE_RE } from '../../compiler/scripts/lib/trigger-tokenizer.mjs'
import { COMMAND_REGISTRY, type CommandDefinition } from './command-registry.ts'
import { COMMAND_PLACES, PLACE_LABELS, offeredAt, type Place } from './command-places.ts'
import { TASK_GROUPS } from './task-groups.ts'

export { PLACES, PLACE_LABELS, type Place } from './command-places.ts'

/** The metadata block is searched for its closing `---` no further than this line. */
export const METADATA_SCAN_LINES = 200

/** Where the keyboard is, for the place: the outline editor, the slide strip (or grid), the Talks panel. */
export type PlaceFocus = 'editor' | 'strip' | 'talks'

/** The kind of the focused Talks-panel row, or null when no row is focused. */
export type PlaceRow = 'talk' | 'folder' | 'vault' | null

/**
 * The outline editor's place from the caret's line. `lineAt(n)` returns the text of 1-based line n;
 * it is called for line 1 and, when that is `---`, for lines 2 to the caret's line (bounded).
 */
export function placeOfLine(text: string, lineNumber: number, lineAt: (n: number) => string): Place {
  if (inMetadata(lineNumber, lineAt)) return 'metadata'
  if (/^# /.test(text) || text === '#') return 'talk-title'
  if (/^#{2,6} /.test(text)) return 'slide-heading'
  const trimmed = text.trim()
  if (TRIGGER_LINE_RE.test(trimmed)) return 'layout-line'
  const innermost = innermostMarker(text)
  if (innermost === 'list') return 'list'
  if (innermost === 'quotation') return 'quotation'
  return 'slide-text'
}

function inMetadata(lineNumber: number, lineAt: (n: number) => string): boolean {
  if (lineNumber > METADATA_SCAN_LINES) return false
  if (lineAt(1) !== '---') return false
  if (lineNumber === 1) return true
  for (let n = 2; n < lineNumber; n += 1) {
    if (lineAt(n) === '---') return false // the block closed above the caret
  }
  return true
}

const LIST_MARKER = /^(?:[-*+]|\d{1,9}[.)])(?:\s+|$)/
const QUOTE_MARKER = /^>\s?/

/** The last list or quotation marker at the start of the line, or null when there is none. */
function innermostMarker(text: string): 'list' | 'quotation' | null {
  let rest = text.replace(/^\s+/, '')
  let last: 'list' | 'quotation' | null = null
  for (let guard = 0; guard < 32 && rest.length > 0; guard += 1) {
    const quote = rest.match(QUOTE_MARKER)
    if (quote) { last = 'quotation'; rest = rest.slice(quote[0].length).replace(/^\s+/, ''); continue }
    const list = rest.match(LIST_MARKER)
    // `---` and `***` are rules, not list items; a lone `-` with text after a space is a list item.
    if (list && !/^([-*_])\s*\1\s*\1/.test(rest)) { last = 'list'; rest = rest.slice(list[0].length); continue }
    break
  }
  return last
}

/** The one place: the focused Talks-panel row, the strip, or the outline editor's place (rule 1). */
export function placeAt(input: { focus: PlaceFocus; row: PlaceRow; editorPlace: Place }): Place {
  if (input.focus === 'talks' && input.row) return input.row === 'talk' ? 'talk' : 'vault'
  if (input.focus === 'strip') return 'strip-slide'
  return input.editorPlace
}

const GROUP_INDEX = new Map<string, number>(TASK_GROUPS.map((group, index) => [group, index]))

/**
 * The commands offered at a place, in Actions-here order: by task group (TASK_GROUPS order), then
 * in the order of command-places.ts. The chip's count is this list's length.
 */
export function actionsAt(place: Place, registry: readonly CommandDefinition[] = COMMAND_REGISTRY): CommandDefinition[] {
  const order = placeOrder()
  return registry
    .filter((command) => offeredAt(command.places, place))
    .sort((a, b) =>
      (GROUP_INDEX.get(a.taskGroup ?? '') ?? 99) - (GROUP_INDEX.get(b.taskGroup ?? '') ?? 99) ||
      (order.get(a.id) ?? 9999) - (order.get(b.id) ?? 9999))
}

let placeOrderCache: Map<string, number> | null = null
function placeOrder(): Map<string, number> {
  if (!placeOrderCache) placeOrderCache = new Map(Object.keys(COMMAND_PLACES).map((id, index) => [id, index]))
  return placeOrderCache
}

/** "On a slide heading" — the chip's place words. */
export function placeLabel(place: Place): string {
  return PLACE_LABELS[place]
}

/** "14 actions", "1 action". */
export function actionCountText(count: number): string {
  return `${count} ${count === 1 ? 'action' : 'actions'}`
}
