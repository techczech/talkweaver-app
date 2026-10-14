// Actions here (onboarding 0.38.1 ticket 03): the rows ⌘K lists at a place. One list, shared by the
// panel at the caret, the status-bar chip's count and the keyboard sheet's Here section (ticket 04).
//
// The rows are `actionsAt(place)` (ticket 02: the drawn list, in the drawn order) followed, inside
// each task group, by the rows the old ⌘K context menu offered at that place and the place table
// does not: CARRIED_ROWS (rows with no registry command, or run by their own handler) and
// `carriedCommandIds` (registry commands the old menu offered at more places than the table). This is
// the "replaces the context menu without losing rows" rule of the ticket. Deleting an entry here
// removes the row; the tests count the rows from this data, never from a typed number.
import { COMMAND_REGISTRY, MOVE_TO_COMMAND_IDS, QUOTE_FORM_COMMAND_IDS, type CommandDefinition } from './command-registry.ts'
import { actionsAt, type PlaceRow } from './place.ts'
import type { Place } from './command-places.ts'
import { TASK_GROUPS, type TaskGroup } from './task-groups.ts'

/** The places in the outline editor where the old slide menu opened (⌘K and right-click). */
export const SLIDE_MENU_PLACES: readonly Place[] = ['slide-heading', 'layout-line', 'slide-text', 'list', 'quotation']

/** Where a quote slide's Quote form commands are offered: every place on the slide, and its card in the strip. */
const QUOTE_FORM_PLACES: readonly Place[] = ['slide-heading', 'layout-line', 'slide-text', 'list', 'quotation', 'strip-slide']
/** Where Move slide to… and Move section to… are offered: every place on a slide, and its card in the strip or grid. */
export const MOVE_TO_PLACES: readonly Place[] = ['slide-heading', 'layout-line', 'slide-text', 'list', 'quotation', 'strip-slide']
/**
 * Collapse all sections / Expand all sections: not rows of the drawn place table either; offered at
 * the same places as Move … to…, so typing the name in Actions here finds them on a slide, on a row
 * of the Slide outline and on a card of the strip or grid.
 */
export const SECTION_FOLD_COMMAND_IDS: readonly string[] = ['outline-collapse-all', 'outline-expand-all']
/**
 * App-wide editing basics. Every text field has them, the menus and the palette keep them, and they
 * are not offered by place (owner check 10 Oct: "trivial actions such as copy/paste that are universal").
 */
export const UNIVERSAL_COMMAND_IDS: ReadonlySet<string> = new Set([
  'cut', 'copy', 'paste', 'undo', 'redo', 'select-all', 'selectAll', 'editor.undo', 'editor.redo', 'editor.select-all'
])

/** Registry commands the old slide menu carried; each is offered at every slide place of the editor. */
export const OLD_SLIDE_MENU_COMMANDS: readonly string[] = [
  'layout', 'icon-picker', 'image', 'tag-slide',
  'insert-object-table', 'insert-object-mindmap', 'insert-object-chart',
  'insert-object-mermaid', 'insert-object-diagram', 'insert-object-svg',
  'format-bold', 'format-italic', 'format-inline-code', 'format-highlight',
  'format-strikethrough', 'format-underline', 'format-link',
  'focus-slide', 'where-used', 'delete-slide'
]

/** Registry commands that are the dangerous row of their menu (drawn red, as the old menus did). */
const DANGER_COMMANDS: ReadonlySet<string> = new Set(['delete-slide', 'browser.delete-talk'])

export type VaultState = 'open' | 'closed' | 'unavailable'

export interface CarriedRow {
  id: string
  label: string
  taskGroup: TaskGroup
  places: readonly Place[]
  /** Only for these Talks-panel rows (a folder row and a vault row are both "on a vault"). */
  rows?: readonly Exclude<PlaceRow, null>[]
  /** Only for a vault in one of these states. */
  vault?: readonly VaultState[]
  /** The registry shortcut whose effective chord the row shows. */
  shortcutId?: string
  /** A chord the platform owns, shown as typed. */
  fixedChord?: string
  danger?: boolean
  /** Extra words the filter matches, beside the label and the task group. */
  keywords?: readonly string[]
}

/** Rows the old context menus offered that have no registry command of their own. */
export const CARRIED_ROWS: readonly CarriedRow[] = [
  { id: 'explain-rendering', label: 'Explain rendering', taskGroup: 'See the talk', places: [...SLIDE_MENU_PLACES, 'strip-slide'] },
  // Present from here is not place-bound in the table (lock decision 11); the old menu offered it on a slide.
  { id: 'present-from-here', label: 'Present from here', taskGroup: 'Present', places: SLIDE_MENU_PLACES, shortcutId: 'app.present-current' },
  // The whole slide (or the whole section, on a section's title): the rows of the slide and section
  // context menus. They are not the universal text Cut, Copy and Paste (UNIVERSAL_COMMAND_IDS), which
  // stay out; they show no chord, because in the editor ⌘X, ⌘C and ⌘V work on the selected text.
  { id: 'slide-cut', label: 'Cut slide', taskGroup: 'Write the outline', places: MOVE_TO_PLACES, keywords: ['section', 'clipboard', 'whole'] },
  { id: 'slide-copy', label: 'Copy slide', taskGroup: 'Write the outline', places: MOVE_TO_PLACES, keywords: ['section', 'clipboard', 'whole'] },
  { id: 'slide-paste-after', label: 'Paste slide after', taskGroup: 'Write the outline', places: MOVE_TO_PLACES, keywords: ['section', 'clipboard', 'whole'] },
  // A talk row.
  { id: 'talk.metadata', label: 'Metadata…', taskGroup: 'Shape the talk', places: ['talk'] },
  { id: 'talk.reveal', label: 'Reveal in Finder', taskGroup: 'Manage talks', places: ['talk'] },
  { id: 'talk.open-file', label: 'Open outline file', taskGroup: 'Manage talks', places: ['talk'] },
  { id: 'talk.copy-path', label: 'Copy file path', taskGroup: 'Manage talks', places: ['talk'] },
  // A folder row.
  { id: 'folder.rename', label: 'Rename folder…', taskGroup: 'Manage talks', places: ['vault'], rows: ['folder'], shortcutId: 'browser.rename' },
  { id: 'folder.delete', label: 'Delete folder…', taskGroup: 'Manage talks', places: ['vault'], rows: ['folder'], danger: true },
  // A vault row (its ⋯ menu).
  { id: 'vault.open', label: 'Open vault', taskGroup: 'Manage talks', places: ['vault'], rows: ['vault'], vault: ['closed'] },
  { id: 'vault.edit', label: 'Edit this vault…', taskGroup: 'Manage talks', places: ['vault'], rows: ['vault'], vault: ['open'] },
  { id: 'vault.only', label: 'Show only this vault', taskGroup: 'Manage talks', places: ['vault'], rows: ['vault'], vault: ['open'] },
  { id: 'vault.reveal', label: 'Reveal in Finder', taskGroup: 'Manage talks', places: ['vault'], rows: ['vault'], vault: ['open'] },
  { id: 'vault.close', label: 'Close vault', taskGroup: 'Manage talks', places: ['vault'], rows: ['vault'], vault: ['open', 'unavailable'], danger: true }
]

export interface ActionRow {
  /** The command id, or the carried row's id. */
  key: string
  /** The label as the panel shows it (a trailing explanation in brackets is left out). */
  label: string
  taskGroup: TaskGroup
  /** The registry command this row runs, or null for a carried row run by its own handler. */
  commandId: string | null
  shortcutId: string | null
  fixedChord: string | null
  keywords: readonly string[]
  danger: boolean
  carried: boolean
}

export interface ActionsContext {
  /** The kind of the focused Talks-panel row, when the place is "on a talk" or "on a vault". */
  row?: PlaceRow
  /** The vault row's state; an unopened or missing vault offers only its own rows. Default 'open'. */
  vault?: VaultState
  /** The slide at the caret (or the selected strip slide) is a quote slide; the Quote form commands are offered only then. */
  quoteSlide?: boolean
}

export interface ActionGroup {
  taskGroup: TaskGroup
  rows: ActionRow[]
}

/** "Focus on this slide (scoped editing + live preview)" shows as "Focus on this slide". */
export function actionLabel(label: string): string {
  return label.replace(/\s+\([^()]*\)\s*$/, '')
}

const GROUP_INDEX = new Map<string, number>(TASK_GROUPS.map((group, index) => [group, index]))

function rowOfCommand(command: CommandDefinition, carried: boolean): ActionRow {
  return {
    key: command.id,
    label: actionLabel(command.label),
    taskGroup: (command.taskGroup ?? 'Set up TalkWeaver') as TaskGroup,
    commandId: command.id,
    shortcutId: command.shortcutId ?? null,
    fixedChord: null,
    keywords: command.palette.keywords,
    danger: DANGER_COMMANDS.has(command.id),
    carried
  }
}

function rowOfCarried(row: CarriedRow): ActionRow {
  return {
    key: row.id,
    label: row.label,
    taskGroup: row.taskGroup,
    commandId: null,
    shortcutId: row.shortcutId ?? null,
    fixedChord: row.fixedChord ?? null,
    keywords: row.keywords ?? [],
    danger: row.danger === true,
    carried: true
  }
}

function carriedRowApplies(row: CarriedRow, place: Place, context: ActionsContext): boolean {
  if (!row.places.includes(place)) return false
  if (row.rows && (!context.row || !row.rows.includes(context.row))) return false
  if (row.vault && !row.vault.includes(context.vault ?? 'open')) return false
  return true
}

/**
 * Every row Actions here offers at a place, in order: by task group, the drawn rows first and then
 * the carried ones. The status-bar chip counts this list and the keyboard sheet's Here shows it.
 */
export function actionRowsAt(place: Place, context: ActionsContext = {}, registry: readonly CommandDefinition[] = COMMAND_REGISTRY): ActionRow[] {
  const notUniversal = (command: CommandDefinition): boolean => !UNIVERSAL_COMMAND_IDS.has(command.id)
  const ownRowsOnly = place === 'vault' && context.row === 'vault' && (context.vault ?? 'open') !== 'open'
  const core = ownRowsOnly ? [] : actionsAt(place, registry)
  const coreIds = new Set(core.map((command) => command.id))
  const carriedCommands = ownRowsOnly || !SLIDE_MENU_PLACES.includes(place)
    ? []
    : registry.filter((command) => OLD_SLIDE_MENU_COMMANDS.includes(command.id) && !coreIds.has(command.id) && notUniversal(command))
  const ranked: Array<{ row: ActionRow; rank: number; order: number }> = [
    ...core.filter(notUniversal).map((command, order) => ({ row: rowOfCommand(command, false), rank: 0, order })),
    // The Quote form commands: a quote slide's own rows, at the slide-wide places, after the drawn rows of their group.
    ...(context.quoteSlide === true && QUOTE_FORM_PLACES.includes(place)
      ? registry.filter((command) => (QUOTE_FORM_COMMAND_IDS as readonly string[]).includes(command.id)).map((command, order) => ({ row: rowOfCommand(command, false), rank: 0.5, order }))
      : []),
    // Move slide to… / Move section to…: after the drawn rows of Write the outline, on a slide.
    ...(!ownRowsOnly && MOVE_TO_PLACES.includes(place)
      ? registry.filter((command) => (MOVE_TO_COMMAND_IDS as readonly string[]).includes(command.id) || SECTION_FOLD_COMMAND_IDS.includes(command.id)).map((command, order) => ({ row: rowOfCommand(command, true), rank: 0.6, order }))
      : []),
    ...carriedCommands
      .sort((a, b) => OLD_SLIDE_MENU_COMMANDS.indexOf(a.id) - OLD_SLIDE_MENU_COMMANDS.indexOf(b.id))
      .map((command, order) => ({ row: rowOfCommand(command, true), rank: 1, order })),
    ...CARRIED_ROWS.filter((row) => carriedRowApplies(row, place, context))
      .map((row, order) => ({ row: rowOfCarried(row), rank: 2, order }))
  ]
  return ranked
    .sort((a, b) =>
      (GROUP_INDEX.get(a.row.taskGroup) ?? 99) - (GROUP_INDEX.get(b.row.taskGroup) ?? 99) ||
      a.rank - b.rank || a.order - b.order)
    .map((entry) => entry.row)
}

/** The rows under their task-group headings, in task-group order. */
export function groupActionRows(rows: readonly ActionRow[]): ActionGroup[] {
  const groups: ActionGroup[] = []
  for (const row of rows) {
    const last = groups[groups.length - 1]
    if (last && last.taskGroup === row.taskGroup) last.rows.push(row)
    else groups.push({ taskGroup: row.taskGroup, rows: [row] })
  }
  return groups
}

/** The filter: every word of the query appears in the label, a keyword or the task group's name. */
export function filterActionRows(rows: readonly ActionRow[], query: string): ActionRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return [...rows]
  return rows.filter((row) => {
    const haystack = [row.label, row.taskGroup, ...row.keywords].join(' ').toLowerCase()
    return words.every((word) => haystack.includes(word))
  })
}

/** The chord text a row shows. `chordOf` gives the effective label for a shortcut id ('' or 'no default' when unbound). */
export function rowChordText(row: ActionRow, chordOf: (shortcutId: string) => string): string {
  if (row.fixedChord) return row.fixedChord
  if (row.shortcutId) {
    const text = chordOf(row.shortcutId)
    if (text && text !== 'no default') return text
  }
  return 'no key'
}

/** `No “publish” action here`. */
export function noMatchText(query: string): string {
  return `No “${query.trim()}” action here`
}

/** The hint beside the highlighted All commands… row when the filter has no match. */
export function allCommandsHint(query: string): string {
  return `Return opens the palette with “${query.trim()}” kept`
}

/** The palette's chord as the last row draws it: the registry's "⌘⇧P" reads "⇧⌘P" there (state 12). */
export function paletteChordText(label: string): string {
  return label === '\u2318\u21E7P' ? '\u21E7\u2318P' : label
}
