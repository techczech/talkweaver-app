// Metadata surface view models (Composition Ticket 9) — the ONE seam both metadata surfaces
// render from.
//
// Deck settings (`DeckDesignPanel.tsx`) and the outline's frontmatter table
// (`extensions/frontmatterTable.ts`) used to decide independently what control a key deserves,
// what to call it and whether to explain it. They disagreed: the frontmatter table carried a
// private list of 15 keys with its own labels, its own raw-value selects and no explanations at
// all, while Deck settings documented a closed vocabulary's choices only as a hover tooltip.
//
// Everything a surface needs is derived here, from the registry alone:
//   • which control the key's vocabulary demands (picker / toggle / number / url / text / map),
//   • the option list with every option's own explanation, ready to render EXPANDED,
//   • whether the present value is off-vocabulary ("custom: …") and therefore needs a way back,
//   • whether the key is TalkWeaver's to write (read-only, with the consequence named),
//   • the group order, taken from the registry's own order — never from a component.
//
// Keep this file plain, erasable-syntax TypeScript (interfaces + const data; no enums, no
// namespaces): the renderer, the main process AND `scripts/test-metadata-surfaces.mjs` import it,
// the last under Node's native type stripping.

import {
  METADATA_REGISTRY,
  type MetadataEntry,
  type MetadataVocabulary
} from './metadata-registry.ts'
import { INPUT_OVERRIDES, SWATCHES } from './layout-registry/deck-options.ts'

/**
 * What a surface must render for a field. `segmented` and `select` are both pickers — the split is
 * purely about how many documented choices fit in a row.
 */
export type SurfaceControl = 'segmented' | 'select' | 'toggle' | 'number' | 'url' | 'text' | 'map'

/** Every control that offers the vocabulary as choices rather than as typing. */
export const PICKER_CONTROLS: SurfaceControl[] = ['segmented', 'select']

/** Above this many documented choices a picker becomes a select instead of a segmented row. */
export const SEGMENTED_LIMIT = 5

/** Heading for the read-only section holding keys TalkWeaver writes for itself. */
export const SYSTEM_GROUP_LABEL = 'Managed by TalkWeaver'

/** Heading for frontmatter keys present in the outline that the registry does not declare. */
export const UNKNOWN_GROUP_LABEL = 'Other keys in this outline'

/** Prefix on the read-only note shown against every system-owned field. */
export const SYSTEM_NOTE_PREFIX = 'Set by TalkWeaver'

export interface SurfaceOptionModel {
  /** The literal written to the outline; '' means the key is removed. */
  value: string
  label: string
  /** What choosing this value actually does — shown on hover/focus AND in the expanded list. */
  explanation: string
  swatch?: string
  selected: boolean
}

export interface SurfaceFieldModel {
  key: string
  aliases: string[]
  label: string
  /** The registry's explanation for the key — surfaces render this inline, under the control. */
  explanation: string
  group: string
  control: SurfaceControl
  /** Unit shown beside a number/duration input (e.g. 'minutes left'). */
  unit?: string
  placeholder?: string
  /** The value currently in the outline, '' when the key is absent. */
  value: string
  /** True when the key is physically present in the outline. */
  present: boolean
  /** The documented choices, or null for a typed field. */
  options: SurfaceOptionModel[] | null
  /** Set when the outline holds a value outside a closed vocabulary. */
  custom: { value: string; label: string } | null
  readOnly: boolean
  ownership: 'user' | 'system'
  /** For a system key: what breaks if it is changed or deleted. */
  note: string | null
  /** True when the key is not declared in the registry at all. */
  unregistered: boolean
}

export interface SurfaceGroupModel {
  key: string
  label: string
  readOnly: boolean
  fields: SurfaceFieldModel[]
}

export interface DeckSettingsModel {
  groups: SurfaceGroupModel[]
  /** Frontmatter keys in the outline that no registry entry claims — preserved, never edited. */
  unknown: Array<{ key: string; value: string }>
  fieldCount: number
}

export interface FrontmatterSurfaceModel {
  /** One row per key present in the outline, in document order. */
  rows: SurfaceFieldModel[]
  /** Registry keys not yet in the outline, in registry order, for the "add field" control. */
  addable: Array<{ key: string; label: string; group: string; explanation: string }>
}

/** The shape both surfaces already have to hand: parsed `key: value` frontmatter pairs. */
export interface SurfacePair {
  key: string
  value: string
}

function groupKeyFor(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
}

interface ClosedChoice {
  value: string
  label: string
  explanation: string
}

function closedOptions(vocabulary: MetadataVocabulary): ClosedChoice[] | null {
  return vocabulary.kind === 'closed' ? vocabulary.options : null
}

/** Which control the entry's own declaration demands. A closed vocabulary is always a picker. */
export function controlForEntry(entry: MetadataEntry): SurfaceControl {
  const options = closedOptions(entry.vocabulary)
  if (options) return options.length > SEGMENTED_LIMIT ? 'select' : 'segmented'
  const hint = INPUT_OVERRIDES[entry.key]
  if (hint?.type === 'url') return 'url'
  if (hint?.type === 'number') return 'number'
  if (entry.type === 'map') return 'map'
  if (entry.type === 'boolean') return 'toggle'
  if (entry.type === 'number') return 'number'
  return 'text'
}

/**
 * One field, ready to render. `value` is the raw outline value ('' when the key is absent);
 * `present` says which of those two it is, so a picker can distinguish "unset" from "set to ''".
 */
export function frontmatterFieldViewModel(
  entry: MetadataEntry,
  value: string,
  present?: boolean
): SurfaceFieldModel {
  const raw = value ?? ''
  const isPresent = present ?? raw !== ''
  const control = controlForEntry(entry)
  const declared = closedOptions(entry.vocabulary)
  const hint = INPUT_OVERRIDES[entry.key]
  const swatched = entry.key === 'palette' || entry.key === 'colour'
  const options = declared
    ? declared.map((option) => ({
        value: option.value,
        label: option.label,
        explanation: option.explanation,
        swatch: swatched ? SWATCHES[option.value] : undefined,
        selected: option.value === raw
      }))
    : null
  const custom = options && !options.some((option) => option.selected) && raw !== ''
    ? { value: raw, label: `custom: ${raw}` }
    : null
  return {
    key: entry.key,
    aliases: entry.aliases ?? [],
    label: entry.label,
    explanation: entry.explanation,
    group: entry.group ?? (entry.ownership === 'system' ? SYSTEM_GROUP_LABEL : 'Other'),
    control,
    unit: hint?.unit,
    placeholder: hint?.placeholder,
    value: raw,
    present: isPresent,
    options,
    custom,
    readOnly: entry.ownership === 'system',
    ownership: entry.ownership,
    note: entry.ownership === 'system'
      ? `${SYSTEM_NOTE_PREFIX}. If it is removed: ${entry.deleteConsequence ?? 'TalkWeaver loses what it recorded here.'}`
      : null,
    unregistered: false
  }
}

/** A row for a key the registry does not declare: shown, preserved, never re-typed by us. */
export function unregisteredFieldViewModel(key: string, value: string): SurfaceFieldModel {
  return {
    key,
    aliases: [],
    label: key,
    explanation:
      'Not a TalkWeaver key — nothing reads it. It is preserved byte-for-byte in the outline; edit it only if you know what put it there.',
    group: UNKNOWN_GROUP_LABEL,
    control: value.includes('\n') ? 'map' : 'text',
    value,
    present: true,
    options: null,
    custom: null,
    readOnly: false,
    ownership: 'user',
    note: null,
    unregistered: true
  }
}

function valueFor(entry: MetadataEntry, pairs: ReadonlyArray<SurfacePair>): { value: string; present: boolean } {
  const spellings = [entry.key, ...(entry.aliases ?? [])]
  const pair = pairs.find((candidate) => spellings.includes(candidate.key))
  return pair ? { value: pair.value, present: true } : { value: '', present: false }
}

/** The active frontmatter entries a surface may show, user-editable first, system last. */
export function surfaceEntries(registry: MetadataEntry[]): MetadataEntry[] {
  const active = registry.filter((entry) => entry.location === 'frontmatter' && !entry.since)
  return [
    ...active.filter((entry) => entry.ownership === 'user'),
    ...active.filter((entry) => entry.ownership === 'system')
  ]
}

/**
 * Every frontmatter field the Deck settings panel renders, grouped in registry order. System keys
 * land in their own read-only group at the end; unrecognised outline keys come back separately.
 */
export function deckSettingsViewModel(
  registry: MetadataEntry[],
  currentFrontmatter: ReadonlyArray<SurfacePair>
): DeckSettingsModel {
  const pairs = currentFrontmatter ?? []
  const order: string[] = []
  const grouped = new Map<string, SurfaceFieldModel[]>()
  for (const entry of surfaceEntries(registry)) {
    const { value, present } = valueFor(entry, pairs)
    const field = frontmatterFieldViewModel(entry, value, present)
    if (!grouped.has(field.group)) {
      grouped.set(field.group, [])
      order.push(field.group)
    }
    ;(grouped.get(field.group) as SurfaceFieldModel[]).push(field)
  }
  const claimed = new Set<string>()
  for (const entry of surfaceEntries(registry)) {
    claimed.add(entry.key)
    for (const alias of entry.aliases ?? []) claimed.add(alias)
  }
  const groups = order.map((label) => {
    const fields = grouped.get(label) as SurfaceFieldModel[]
    return { key: groupKeyFor(label), label, readOnly: fields.every((field) => field.readOnly), fields }
  })
  return {
    groups,
    unknown: pairs.filter((pair) => !claimed.has(pair.key)).map((pair) => ({ key: pair.key, value: pair.value })),
    fieldCount: groups.reduce((total, group) => total + group.fields.length, 0)
  }
}

/**
 * The outline's inline frontmatter table: one row per key actually written in the document, in
 * document order, plus the registry keys still available to add.
 */
export function frontmatterSurfaceViewModel(
  registry: MetadataEntry[],
  currentFrontmatter: ReadonlyArray<SurfacePair>
): FrontmatterSurfaceModel {
  const pairs = currentFrontmatter ?? []
  const entries = surfaceEntries(registry)
  const bySpelling = new Map<string, MetadataEntry>()
  for (const entry of entries) {
    bySpelling.set(entry.key, entry)
    for (const alias of entry.aliases ?? []) bySpelling.set(alias, entry)
  }
  const rows = pairs.map((pair) => {
    const entry = bySpelling.get(pair.key)
    return entry
      ? frontmatterFieldViewModel(entry, pair.value, true)
      : unregisteredFieldViewModel(pair.key, pair.value)
  })
  const present = new Set(pairs.map((pair) => pair.key))
  const addable = entries
    .filter((entry) => entry.ownership === 'user')
    .filter((entry) => ![entry.key, ...(entry.aliases ?? [])].some((spelling) => present.has(spelling)))
    .map((entry) => ({
      key: entry.key,
      label: entry.label,
      group: entry.group ?? 'Other',
      explanation: entry.explanation
    }))
  return { rows, addable }
}

/** The value a newly added field starts at: the vocabulary's default option, or empty. */
export function initialValueFor(entry: MetadataEntry): string {
  const options = closedOptions(entry.vocabulary)
  if (!options) return ''
  const nonEmpty = options.find((option) => option.value !== '')
  return nonEmpty ? nonEmpty.value : ''
}

/** Convenience for surfaces that do not want to pass the registry around. */
export function defaultDeckSettingsViewModel(
  currentFrontmatter: ReadonlyArray<SurfacePair>
): DeckSettingsModel {
  return deckSettingsViewModel(METADATA_REGISTRY, currentFrontmatter)
}

// ── Presenter identity and deck defaults (Ticket 9b) ──────────────────────────
//
// Dominik, 2026-09-11: "have options for consistent metadata in settings so I don't have to
// retype my name as author, email etc." One app-level map of registry key → value lives in
// Settings; every place that could apply it goes through `applyMetadataDefaults` so the rule
// "never overwrite what the author wrote, unless they ask" is stated once.

/** The Settings store's shape: registry key → the value to pre-fill. Blank means "no default". */
export type MetadataDefaults = Record<string, string>

export interface MetadataDefaultEdit {
  key: string
  aliases: string[]
  value: string
}

export interface MetadataDefaultsResult {
  /** Ready for `editFrontmatterText` — in registry order, never an empty value. */
  edits: MetadataDefaultEdit[]
  /** Keys left alone because the outline already holds an authored value (fill-missing). */
  skipped: string[]
}

/** Entries Settings may hold a default for, filtered to this registry. */
export function defaultableSurfaceEntries(registry: MetadataEntry[]): MetadataEntry[] {
  return registry.filter(
    (entry) =>
      entry.defaultable === true &&
      entry.ownership === 'user' &&
      entry.location === 'frontmatter' &&
      !entry.since
  )
}

/** The Settings section's fields, grouped and ordered by the registry — same rules as a deck. */
export function metadataDefaultsViewModel(
  registry: MetadataEntry[],
  defaults: MetadataDefaults
): SurfaceGroupModel[] {
  const stored = defaults ?? {}
  const order: string[] = []
  const grouped = new Map<string, SurfaceFieldModel[]>()
  for (const entry of defaultableSurfaceEntries(registry)) {
    const value = typeof stored[entry.key] === 'string' ? stored[entry.key] : ''
    const field = frontmatterFieldViewModel(entry, value, value !== '')
    if (!grouped.has(field.group)) {
      grouped.set(field.group, [])
      order.push(field.group)
    }
    ;(grouped.get(field.group) as SurfaceFieldModel[]).push(field)
  }
  return order.map((label) => ({
    key: groupKeyFor(label),
    label,
    readOnly: false,
    fields: grouped.get(label) as SurfaceFieldModel[]
  }))
}

/** Only defaultable keys, trimmed; a blank default is dropped rather than stored as ''. */
export function normaliseMetadataDefaults(
  registry: MetadataEntry[],
  patch: MetadataDefaults
): MetadataDefaults {
  const allowed = new Set(defaultableSurfaceEntries(registry).map((entry) => entry.key))
  const next: MetadataDefaults = {}
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!allowed.has(key)) continue
    const trimmed = typeof value === 'string' ? value.trim() : ''
    if (trimmed !== '') next[key] = trimmed
  }
  return next
}

/**
 * Work out which defaults should be written into an outline.
 *
 * 'fill-missing' is the only mode anything applies on its own: a key the author has already
 * written keeps its value, whatever the default says. 'overwrite' exists for an explicit click
 * ("use the default here", "fill from defaults" on a field the user chose). A blank default never
 * produces an edit in either mode — it must never write an empty key into an outline.
 */
export function applyMetadataDefaults(
  frontmatter: ReadonlyArray<SurfacePair>,
  defaults: MetadataDefaults,
  options: { mode: 'fill-missing' | 'overwrite'; registry?: MetadataEntry[]; only?: string[] }
): MetadataDefaultsResult {
  const registry = options.registry ?? METADATA_REGISTRY
  const pairs = frontmatter ?? []
  const stored = defaults ?? {}
  const only = options.only ? new Set(options.only) : null
  const edits: MetadataDefaultEdit[] = []
  const skipped: string[] = []
  for (const entry of defaultableSurfaceEntries(registry)) {
    if (only && !only.has(entry.key)) continue
    const value = typeof stored[entry.key] === 'string' ? stored[entry.key].trim() : ''
    if (value === '') continue
    const spellings = [entry.key, ...(entry.aliases ?? [])]
    const existing = pairs.find((pair) => spellings.includes(pair.key))
    const authored = existing != null && existing.value.trim() !== ''
    if (authored && options.mode === 'fill-missing') {
      skipped.push(entry.key)
      continue
    }
    if (existing && existing.value.trim() === value) continue
    edits.push({ key: entry.key, aliases: entry.aliases ?? [], value })
  }
  return { edits, skipped }
}
