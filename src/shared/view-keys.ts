// The keys of a whole view, for the ⌘/ keyboard sheet (house rule R13: one generated cheat sheet, scoped
// to where you are; no resident key legends and no hand-written per-view sheets). Each view lists the
// shortcut registry's keys for its scope, plus the few keys that are not in the registry yet (the
// Studio and History players, Slide focus, a pathway's drag handles); those sit in EXTRA below, in
// this one place, and move into the registry when they get commands.
import { shortcutsForScope, type ShortcutScope } from './shortcut-registry.ts'

export type ViewKeysId =
  | 'talks' | 'slide-picker' | 'studio' | 'runs' | 'notes' | 'importer' | 'slide-focus' | 'image-drawer' | 'pathways'

export interface ViewKeyRow {
  /** The shortcut id when the row comes from the registry, so a rebound chord shows here too. */
  shortcutId: string | null
  label: string
  /** The default chord text; the sheet swaps in the live one for a registry row. */
  keys: string
}

export interface ViewKeysSection {
  id: ViewKeysId
  /** "Studio keys" in the sheet's nav. */
  title: string
  rows: ViewKeyRow[]
}

interface ViewDefinition {
  id: ViewKeysId
  title: string
  scopes: readonly ShortcutScope[]
  extra: ReadonlyArray<readonly [label: string, keys: string]>
}

const VIEWS: readonly ViewDefinition[] = [
  { id: 'talks', title: 'Talks list', scopes: ['browser'], extra: [['Actions menu for the focused item', '⌘K']] },
  { id: 'slide-picker', title: 'Slide Browser', scopes: ['slide-picker'], extra: [['Select a range of slides', '⇧ click'], ['Scope the rail to a talk or section', 'click'], ['Add to the scope', '⌘ click'], ['All shortcuts', '?']] },
  {
    id: 'studio', title: 'Studio', scopes: ['studio'],
    extra: [
      ['Play / pause', 'Space'], ['Previous slide', '←'], ['Next slide', '→'], ['Nudge back 5 s', ','], ['Nudge on 5 s', '.'],
      ['Previous transcript segment', '['], ['Next transcript segment', ']'], ['Trim or restore the current segment', 'T'], ['Jump to start', '0'],
      ['Previous or next recording', '↑ ↓'], ['Upload this recording', 'U'], ['Search recordings', '⌘F'],
      ['Start or stop recording (in the presenter)', '⇧R'], ['Pause or resume recording (in the presenter)', '⇧P'],
      ['Keyboard shortcuts', '?'], ['Close Studio', 'Esc']
    ]
  },
  {
    id: 'runs', title: 'Runs', scopes: [],
    extra: [
      ['Studio', '⌘1'], ['Runs', '⌘4'], ['Settings', '⌘,'], ['Move through the list', '↑ ↓'], ['Search', '⌘F'],
      ['Show only Runs with a recording', 'F'], ['Cycle grouping', 'G'], ['Re-check every handout', 'R'],
      ['Open the recording in Studio', '↵'], ['Copy the handout link', 'C'], ['Open the handout', 'O'],
      ['Re-check whether it is still live', 'L'], ['Edit the context label', 'E'], ['Upload the local audio', 'U'], ['Start or stop recording (in the presenter)', '⇧R'], ['Pause or resume recording (in the presenter)', '⇧P'],
      ['Save the Run (in the presenter)', 'L'], ['Keyboard shortcuts', '?'], ['Close or step back out', 'Esc']
    ]
  },
  { id: 'notes', title: 'Manage notes', scopes: ['talktext'], extra: [['Back or forward 5 s (Script)', ', .'], ['Play / pause (Script)', 'Space'], ['Save an edit', '⌘↵']] },
  { id: 'importer', title: 'Importer', scopes: ['importer'], extra: [] },
  {
    id: 'slide-focus', title: 'Slide focus', scopes: [],
    extra: [['Previous or next slide', '← →'], ['Versions of this slide', 'V'], ['Adopt the current version in other talks', 'A'], ['Detach as a new slide', '⇧D'], ['Back to where you came from', 'Esc'], ['Keyboard shortcuts', '?']]
  },
  { id: 'image-drawer', title: 'Image drawer', scopes: ['image-drawer'], extra: [['Drag an image onto the slide', 'drag']] },
  { id: 'pathways', title: 'Pathways', scopes: ['pathway'], extra: [['Reorder slides', 'drag'], ['Remove a slide from this pathway only (the talk keeps it)', '×']] }
]

/** The sections, in the sheet's order. Registry rows come first, then the rows that have no registry entry. */
export function viewKeySections(): ViewKeysSection[] {
  return VIEWS.map((view) => {
    const rows: ViewKeyRow[] = []
    const seen = new Set<string>()
    for (const scope of view.scopes) {
      for (const entry of shortcutsForScope(scope)) {
        if (entry.unbound) continue
        const row: ViewKeyRow = { shortcutId: entry.id, label: entry.label, keys: entry.keys }
        seen.add(`${row.label}|${row.keys}`)
        rows.push(row)
      }
    }
    for (const [label, keys] of view.extra) if (!seen.has(`${label}|${keys}`)) rows.push({ shortcutId: null, label, keys })
    return { id: view.id, title: view.title, rows }
  })
}
