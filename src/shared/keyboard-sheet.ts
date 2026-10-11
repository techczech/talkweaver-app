// The ⌘/ keyboard sheet's data (onboarding 0.38.1 ticket 04). Pure: the place, the registry and the
// chord labels in, the sections out. The sheet is generated from the registries; typing a command
// anywhere else adds it here.
//
//   1. Here: the current place's rows, the list Actions here (⌘K) shows for the same place. The count
//      shown is the length of that list. With no talk open there is no Here.
//   2. The ten task groups, in order, each with its count and its sub-groups.
//   3. After them, the keys inside a picker, pathway or importer view under each surface's own
//      heading (lock decision 13); they are in no task group and in no count.
//   4. A filter over every command by label, keyword, task group and sub-group.
//
// The presenter's keys (scope 'presenter') are the presenter's own generated sheet, not this one.
import { COMMAND_REGISTRY, type CommandDefinition } from './command-registry.ts'
import { actionRowsAt, type ActionRow, type ActionsContext } from './actions-here.ts'
import { PLACE_LABELS, type Place } from './command-places.ts'
import { TASK_GROUPS, type TaskGroup } from './task-groups.ts'

export interface SheetRow {
  /** The command id, or a carried row's id. */
  key: string
  label: string
  taskGroup: TaskGroup | null
  subgroup: string | null
  /** The effective chord text, or "no key". */
  chord: string
  /** The chord this one replaced (its default, or "no key"), when the person rebound it. */
  was: string | null
  /** Offered a Run action: no chord, and the shared route can run it. */
  run: boolean
  /** The registry command, or null for a carried row. */
  commandId: string | null
  keywords: readonly string[]
}

export interface SheetSubgroup { name: string; count: number }

export interface SheetGroup {
  taskGroup: TaskGroup
  count: number
  subgroups: SheetSubgroup[]
  rows: SheetRow[]
}

export interface SheetSurface { surface: string; rows: SheetRow[] }

export interface SheetHere {
  place: Place
  /** "Here: on a slide heading" */
  heading: string
  count: number
  rows: SheetRow[]
}

export interface SheetData {
  here: SheetHere | null
  groups: SheetGroup[]
  surfaces: SheetSurface[]
  /** The section the sheet opens on: 'here' when there is one, else the first task group. */
  opensOn: 'here' | TaskGroup
}

export interface SheetInput {
  /** The place, or null with no talk open (no Here section). */
  place: Place | null
  context?: ActionsContext
  registry?: readonly CommandDefinition[]
  /** The effective chord for a shortcut id ('' or 'no default' when unbound). */
  chordOf: (shortcutId: string) => string
  /** The registry's own chord for a shortcut id ('no default' when it has none). */
  defaultChordOf: (shortcutId: string) => string
  /** Can the shared route run this command from the sheet? (the palette's listed commands) */
  canRun: (commandId: string) => boolean
  /** Can a carried row (no registry command) be run from the sheet at this place? */
  canRunCarried?: (key: string) => boolean
}

const NO_KEY = 'no key'
const asChord = (text: string): string => (!text || text === 'no default' ? NO_KEY : text)

/** "On a slide heading" reads "Here: on a slide heading". */
export function hereHeading(place: Place): string {
  const words = PLACE_LABELS[place]
  return `Here: ${words.charAt(0).toLowerCase()}${words.slice(1)}`
}

function sheetRow(
  key: string, label: string, commandId: string | null, shortcutId: string | null, fixedChord: string | null,
  fields: { taskGroup: TaskGroup | null; subgroup: string | null }, keywords: readonly string[], input: SheetInput
): SheetRow {
  const chord = fixedChord ?? (shortcutId ? asChord(input.chordOf(shortcutId)) : NO_KEY)
  let was: string | null = null
  if (!fixedChord && shortcutId) {
    const effective = asChord(input.chordOf(shortcutId))
    const original = asChord(input.defaultChordOf(shortcutId))
    if (effective !== original) was = original
  }
  const runnable = commandId ? input.canRun(commandId) : (input.canRunCarried?.(key) ?? false)
  return { key, label, taskGroup: fields.taskGroup, subgroup: fields.subgroup, chord, was, run: chord === NO_KEY && runnable, commandId, keywords }
}

function rowOfAction(row: ActionRow, input: SheetInput, registry: readonly CommandDefinition[]): SheetRow {
  const command = row.commandId ? registry.find((candidate) => candidate.id === row.commandId) : undefined
  return sheetRow(
    row.key, row.label, row.commandId, row.shortcutId, row.fixedChord,
    { taskGroup: row.taskGroup, subgroup: command?.subgroup ?? null }, row.keywords, input
  )
}

function rowOfCommand(command: CommandDefinition, input: SheetInput): SheetRow {
  return sheetRow(
    command.id, labelOf(command), command.id, command.shortcutId ?? null, null,
    { taskGroup: command.taskGroup as TaskGroup, subgroup: command.subgroup ?? null }, command.palette.keywords, input
  )
}

const labelOf = (command: CommandDefinition): string => command.label.replace(/\s+\([^()]*\)\s*$/, '')

/** The sheet's sections. */
export function keyboardSheet(input: SheetInput): SheetData {
  const registry = input.registry ?? COMMAND_REGISTRY
  const listed = registry.filter((command) => command.scope !== 'presenter')
  const groups: SheetGroup[] = TASK_GROUPS.map((taskGroup) => {
    const rows = listed.filter((command) => command.taskGroup === taskGroup).map((command) => rowOfCommand(command, input))
    const order: string[] = []
    for (const row of rows) if (row.subgroup && !order.includes(row.subgroup)) order.push(row.subgroup)
    rows.sort((a, b) => order.indexOf(a.subgroup ?? '') - order.indexOf(b.subgroup ?? ''))
    return {
      taskGroup,
      count: rows.length,
      subgroups: order.map((name) => ({ name, count: rows.filter((row) => row.subgroup === name).length })),
      rows
    }
  })
  const surfaces: SheetSurface[] = []
  for (const command of listed) {
    if (command.taskGroup || !command.surface) continue
    let surface = surfaces.find((candidate) => candidate.surface === command.surface)
    if (!surface) { surface = { surface: command.surface, rows: [] }; surfaces.push(surface) }
    surface.rows.push(sheetRow(command.id, labelOf(command), command.id, command.shortcutId ?? null, null, { taskGroup: null, subgroup: null }, command.palette.keywords, input))
  }
  let here: SheetHere | null = null
  if (input.place) {
    const rows = actionRowsAt(input.place, input.context ?? {}, registry).map((row) => rowOfAction(row, input, registry))
    here = { place: input.place, heading: hereHeading(input.place), count: rows.length, rows }
  }
  return { here, groups, surfaces, opensOn: here ? 'here' : TASK_GROUPS[0] }
}

/** The filter over every command: each word in the label, a keyword, the task group or the sub-group. */
export function searchSheet(data: SheetData, query: string): SheetRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  const all = [...data.groups.flatMap((group) => group.rows), ...data.surfaces.flatMap((surface) => surface.rows.map((row) => ({ ...row, subgroup: surface.surface })))]
  return all.filter((row) => {
    const haystack = [row.label, row.taskGroup ?? '', row.subgroup ?? '', ...row.keywords].join(' ').toLowerCase()
    return words.every((word) => haystack.includes(word))
  })
}
