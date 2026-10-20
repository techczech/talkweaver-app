// The Guide's ten chapters (onboarding 0.38.1 ticket 08), derived from the registries and never
// typed per chapter: a chapter is a task group, its rows are the commands in that group that exist
// in this build (ticket 01's table), and a command that is not in the build never appears.
//
// What counts:
//   - every registry command that carries a task group (the 47 keys inside a surface carry none:
//     lock decision 13);
//   - the presenter palette's entries that have no key of their own (`presenter-palette.<id>`);
//   - minus the live commands (sub-groups "Live audience, polls and questions" and "Live board"):
//     they cannot be tried without a connection, so they are listed apart and not counted
//     (lock decision 7);
//   - with MERGED_ROWS folded into one row each. A merged row is ticked when ANY of its commands
//     has run; a member the build lacks is skipped, so a row never counts a command that is absent.
//
// Strings (CHAPTER_TALK, the icons, the live note) are copied from the locked drawing's text module;
// scripts/test-guide-chapters.mjs checks them against it, so a wording change happens there first.
import { COMMAND_REGISTRY } from './command-registry.ts'
import { PRESENTER_PALETTE } from './presenter-palette.ts'
import { TASK_GROUPS, TASK_GROUP_TABLE, taskGroupFields, type TaskGroup } from './task-groups.ts'

/** The two sub-groups whose commands need the live service (0.39): listed apart, never counted. */
export const LIVE_SUBGROUPS: readonly string[] = ['Live audience, polls and questions', 'Live board (added)']

/** CHAPTER_TALK in the drawing's text module: the practice talk and section of each chapter. */
export const CHAPTER_TALK: Readonly<Record<TaskGroup, readonly [string, string]>> = {
  'Write the outline': ['The Saturday market', '01 Write the outline'],
  'Build a slide': ['The Saturday market', '02 Build a slide'],
  'Reuse slides': ['Garden notes', '03 Reuse slides'],
  'See the talk': ['The Saturday market', '04 See the talk'],
  'Shape the talk': ['Walking the old town', '05 Shape the talk'],
  'Present': ['Lightning round', '06 Present'],
  'Share': ['Lightning round', '07 Share'],
  'Manage talks': ['Harvest supper (draft)', '08 Manage talks'],
  'Check and repair': ['Harvest supper (draft)', '09 Check and repair'],
  'Set up TalkWeaver': ['Harvest supper (draft)', '10 Set up TalkWeaver']
}

/** ICONS in the drawing's text module: the lucide icon of each chapter. */
export const CHAPTER_ICONS: Readonly<Record<TaskGroup, string>> = {
  'Write the outline': 'pen-line',
  'Build a slide': 'layout-template',
  'Reuse slides': 'library',
  'See the talk': 'eye',
  'Shape the talk': 'route',
  'Present': 'presentation',
  'Share': 'share',
  'Manage talks': 'folders',
  'Check and repair': 'stethoscope',
  'Set up TalkWeaver': 'sliders-horizontal'
}

/**
 * The order of each chapter's sub-groups: the command map's own order (the drawing's), then the
 * sub-groups ticket 01 added, in the order they came. A sub-group not named here is appended at the
 * end, in the order it is met.
 */
export const SUBGROUP_ORDER: Readonly<Record<TaskGroup, readonly string[]>> = {
  'Write the outline': ['Format text', 'Fold', 'Headings and levels', 'Lists', 'Reorder slides and items', 'Undo and redo'],
  'Build a slide': ['Inspector', 'Layouts', 'Images and icons', 'Objects', 'Components'],
  'Reuse slides': ['Where used and versions', 'Find a talk', 'Slides from other talks', 'Tags'],
  'See the talk': ['Views (editor, strip, grid)', 'Focus on a slide', 'Sidebar and outline search'],
  'Shape the talk': ['Plan a run', 'Pathways', 'Deck design', 'Metadata and abstract'],
  'Present': ['Open presenter and audience', 'Live audience, polls and questions', 'Move through slides', 'Timer', 'Recording', 'Display modes', 'Speaker notes (added)', 'Live board (added)', 'Help and commands'],
  'Share': ['Handout', 'HTML presentation', 'Publish', 'Share for comments'],
  'Manage talks': ['Importer, Studio, History', 'Windows', 'Talks panel', 'Vaults', 'Scripts and notes'],
  'Check and repair': ['Optimise images', 'Index image text', 'Check embeds', 'Layout Doctor'],
  'Set up TalkWeaver': ['Command palette', 'Shortcuts', 'Settings', 'Get started']
}

/**
 * Rows that are one idea in several commands. `pair`: two keys for one idea (larger/smaller,
 * faster/slower), drawn with two key caps. `variants`: the choices of one setting, drawn as one row
 * naming the variants. The label is what the row says. Ids are command ids.
 */
export interface MergedRow { label: string; kind: 'pair' | 'variants'; ids: readonly string[] }

export const MERGED_ROWS: readonly MergedRow[] = [
  { label: 'Slide text larger / smaller', kind: 'pair', ids: ['presenter.font-larger', 'presenter.font-smaller'] },
  { label: 'Notes scroll faster / slower', kind: 'pair', ids: ['presenter-palette.notes-faster', 'presenter-palette.notes-slower'] },
  { label: 'Notes placement: off · bottom · sidebar · top band · camera column', kind: 'variants', ids: ['presenter-palette.notes-off', 'presenter-palette.notes-bottom', 'presenter-palette.notes-sidebar', 'presenter-palette.notes-top-band', 'presenter-palette.notes-camera-column'] },
  { label: 'Notes scroll: by hand · automatically', kind: 'variants', ids: ['presenter-palette.notes-scroll-hand', 'presenter-palette.notes-scroll-auto'] },
  { label: 'Pen tool: Freehand · Arrow · Rectangle', kind: 'variants', ids: ['presenter-palette.pen-freehand', 'presenter-palette.pen-arrow', 'presenter-palette.pen-rectangle'] }
]

/**
 * Commands that stay in the palette and the menus but are not rows of any chapter. Presentation window
 * and Audience view are editor-side launches that Launch audience (F5) covers (owner check 10 Oct:
 * "not a command in here and duplicates audience launch").
 */
export const CHAPTER_EXCLUDED: ReadonlySet<string> = new Set([
  'present-window', 'present-audience',
  // Plain editing view ticket 01: the two tabs are named in the Guide by ticket 10, not by a practice row yet.
  'view-plain', 'view-markdown',
  // Plain editing view ticket 04: the margin menus' palette entries; ticket 10 writes them into the Guide.
  'change-heading-level', 'change-slide-layout',
  // Quote forms (ADR-0038): "Quote form: …" are palette commands for one layout's option; the Inspector's
  // control is the way a person meets them, so the practice talks do not count seven rows for them.
  'quote-form-auto', 'quote-form-plain', 'quote-form-tweet', 'quote-form-video', 'quote-form-book', 'quote-form-paper', 'quote-form-web',
  // Collapse all / Expand all sections: two buttons on the Slides outline and the grid, also in the palette.
  // The buttons are how a person meets them; no row of See the talk until the practice talk has a Try it for them.
  'outline-collapse-all', 'outline-expand-all',
  // Move slide to… / Move section to…: rows of the slide and section context menus (Slides outline, grid), also in
  // the palette and Actions here. No row of Write the outline until the practice talk has a Try it for them.
  'move-slide-to', 'move-section-to',
  // Work files ticket 30: the Tools window's commands (Sessions, Published pages, Work files, and what the Run
  // on show can do) and the two Attach commands. No chapter row and no practice line yet (ticket 30 left them
  // out while pre-work was hidden); they are on the ⌘/ sheet and in the Tools window's palette.
  'tools-view-sessions', 'tools-view-published', 'tools-view-workfiles', 'tools-plan-run', 'tools-edit-plan', 'tools-plan-like-this',
  'tools-publish', 'tools-unpublish', 'tools-go-live', 'tools-open-run', 'tools-copy-link', 'tools-copy-invitation', 'tools-new-work-file',
  'attach-prework', 'attach-postwork'
])

/** A command this module reads. The registry's `CommandDefinition` satisfies it (with `taskGroup` set). */
export interface ChapterCommand {
  id: string
  label: string
  taskGroup: TaskGroup | null
  subgroup: string | null
  /** The shortcut-registry id whose chord the row shows, when the command has a key. */
  shortcutId?: string
  handlerId?: string
}

/** The commands the chapters are derived from: the registry's grouped commands, then the presenter palette's key-less entries. */
export function chapterCommands(): ChapterCommand[] {
  const out: ChapterCommand[] = COMMAND_REGISTRY
    .filter((command) => command.taskGroup !== null)
    .map((command) => ({ id: command.id, label: command.label, taskGroup: command.taskGroup, subgroup: command.subgroup, shortcutId: command.shortcutId, handlerId: command.handlerId }))
  for (const [, entries] of PRESENTER_PALETTE) {
    for (const entry of entries) {
      if (entry.shortcut) continue
      const id = `presenter-palette.${entry.id}`
      const fields = taskGroupFields(id)
      if (fields.taskGroup) out.push({ id, label: entry.name, taskGroup: fields.taskGroup, subgroup: fields.subgroup })
    }
  }
  return out
}

/** One row of a chapter's This chapter list. `ids` are the commands it stands for (one, unless merged). */
export interface ChapterRow {
  /** The first member's id: the row's key. */
  id: string
  label: string
  ids: readonly string[]
  merged: MergedRow['kind'] | null
  subgroup: string
  /** Shortcut-registry ids whose chords the row shows (one per member that has a key). */
  shortcutIds: readonly string[]
}
export interface ChapterSubgroup { name: string; rows: ChapterRow[] }
export interface Chapter {
  task: TaskGroup
  /** The counted rows, by sub-group, in list order. */
  subgroups: ChapterSubgroup[]
  /** The counted rows, flat. */
  rows: ChapterRow[]
  /** The live rows: listed apart, never counted. */
  live: ChapterRow[]
}

/** The label a row shows: the command's name without a trailing parenthesis, as drawn. */
export const rowLabel = (label: string): string => label.replace(/ \(.*/, '')

/** Derive every chapter, in the ten-group order, from a command list (this build's by default). */
export function deriveChapters(commands: readonly ChapterCommand[] = chapterCommands(), merged: readonly MergedRow[] = MERGED_ROWS): Chapter[] {
  const byId = new Map(commands.map((command) => [command.id, command]))
  return TASK_GROUPS.map((task) => {
    const mine = commands.filter((command) => command.taskGroup === task && !CHAPTER_EXCLUDED.has(command.id))
    const seen = new Set<string>()
    const counted: ChapterRow[] = []
    const live: ChapterRow[] = []
    for (const command of mine) {
      if (seen.has(command.id)) continue
      const set = merged.find((entry) => entry.ids.includes(command.id))
      // The members of a set that this build has, in the set's own order, and that are in this task.
      const members = set ? set.ids.filter((id) => byId.get(id)?.taskGroup === task) : [command.id]
      members.forEach((id) => seen.add(id))
      const folded = set !== undefined && members.length > 1
      const row: ChapterRow = {
        id: members[0],
        label: folded ? set.label : rowLabel(command.label),
        ids: members,
        merged: folded ? set.kind : null,
        subgroup: command.subgroup ?? '',
        shortcutIds: members.flatMap((id) => { const s = byId.get(id)?.shortcutId; return s ? [s] : [] })
      }
      ;(LIVE_SUBGROUPS.includes(row.subgroup) ? live : counted).push(row)
    }
    const names = [...SUBGROUP_ORDER[task]]
    for (const row of counted) if (!names.includes(row.subgroup)) names.push(row.subgroup)
    const subgroups = names.map((name) => ({ name, rows: counted.filter((row) => row.subgroup === name) })).filter((group) => group.rows.length > 0)
    return { task, subgroups, rows: subgroups.flatMap((group) => group.rows), live }
  })
}

export const chapterFor = (chapters: readonly Chapter[], task: string): Chapter | undefined => chapters.find((chapter) => chapter.task === task)

/** The sub-group's display name: the drawing drops the "(added)" the map carries. */
export const subgroupLabel = (name: string): string => name.replace(' (added)', '')

/** A chord as a row shows it: all of a short one; the first two keys and "+N" for a long one (as drawn). */
export function shortChord(chord: string): string {
  const parts = chord.split(/ \/ | /)
  return parts.length > 2 ? `${parts.slice(0, 2).join(' ')} +${parts.length - 2}` : chord
}

/** The chords a row shows: every member's effective chord once each; a variants row shows none. */
export function rowChords(row: ChapterRow, chordOf: (shortcutId: string) => string): string[] {
  if (row.merged === 'variants') return []
  const out: string[] = []
  for (const id of row.shortcutIds) {
    const chord = chordOf(id)
    if (chord && chord !== 'no default' && !out.includes(chord)) out.push(chord)
  }
  return out
}

// ── Which command ran ───────────────────────────────────────────────────────────────────────────

const MAX_ID = 100

/**
 * The canonical command id of whatever a route reports: a registry command id, the shortcut id the
 * command carries (a key route reports that), its handler id (the native menu and the handler map
 * report that), or a presenter palette entry's `presenter-palette.<id>`. Null for an id that is
 * none of these, so a stray id never ticks anything.
 */
export function resolveCommandId(raw: unknown, commands: readonly ChapterCommand[] = chapterCommands()): string | null {
  if (typeof raw !== 'string' || raw === '' || raw.length > MAX_ID) return null
  const byId = commands.find((command) => command.id === raw)
  if (byId) return byId.id
  const byShortcut = commands.find((command) => command.shortcutId === raw)
  if (byShortcut) return byShortcut.id
  const byHandler = commands.find((command) => command.handlerId === raw)
  return byHandler ? byHandler.id : null
}

/** Which chapter holds a command (counted or live); undefined for a command in no chapter. */
export function chapterOfCommand(chapters: readonly Chapter[], id: string): Chapter | undefined {
  return chapters.find((chapter) => [...chapter.rows, ...chapter.live].some((row) => row.ids.includes(id)))
}

/** Is the command a live one: listed apart, never counted? */
export const isLiveCommand = (chapters: readonly Chapter[], id: string): boolean => chapters.some((chapter) => chapter.live.some((row) => row.ids.includes(id)))

/**
 * Commands that delete the person's own work. They tick only when run inside the example vault
 * (lock decision 12): progress must never reward deleting a talk of one's own. Canonical ids.
 */
export const DELETING_COMMANDS: ReadonlySet<string> = new Set(['delete-slide', 'browser.delete-talk', 'pathway.delete'])
