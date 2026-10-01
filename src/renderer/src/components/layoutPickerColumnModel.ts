// =============================================================================
// The docked layout picker's model (ADR-0032; locked mockup states S1, S2, S7–S10, S12).
//
// Pure: no React, no Electron. The picker column (LayoutPickerColumn.tsx) holds a `PickerState`, asks
// `pickerView` for what to draw, and sends `reducePicker` the keys the mockup's keyboard map names:
//
//   type        → { type: 'query' }     filter by name, aliases and the when-it-fits line; top match highlighted
//   ↑ ↓ ← →     → { type: 'move' }      rows and along a row; on a purpose ← closes and → opens it
//   Tab         → { type: 'next-group' } Recent → Suggested → All layouts
//   ↵           → { type: 'activate' }  on a purpose: open or close (a layout is kept with `pickerCommit`)
//
// What the highlighted row means for the slide is answered by `pickerTry` (a layout to preview, or
// null) and `pickerCommit` (the layout ↵ keeps, or why it cannot). The Trigger-line write itself is
// the `set-layout` verb (src/shared/layout-verbs.ts); this module never touches outline text.
// =============================================================================
import {
  LAYOUTS,
  isPickerEligible,
  type LayoutDef,
  type LayoutPurpose
} from '../../../shared/layout-registry/entries.ts'
import { winningAuthoredLayout } from '../../../shared/layout-registry/vocabulary.ts'
import { readOutlineSlides } from '../../../shared/feedback-accept.ts'
import {
  canTakeAllLayouts,
  readSlideShape,
  recentLayouts,
  suggestLayouts,
  type LayoutSuggestion,
  type SlideRef
} from '../../../shared/layout-verbs.ts'
import { logicalTriggerBlockAfterHeading } from '../../../shared/trigger-line.ts'

export const PICKER_PURPOSES: readonly LayoutPurpose[] = ['Everyday', 'Structure', 'Diagrams', 'Modes', 'Specialised']
export const MAX_RECENT = 6
/** Pictures across in the Suggested group: five in the ordinary column, three when it is at its minimum width. */
export const SUGGESTED_COLUMNS_WIDE = 5
export const SUGGESTED_COLUMNS_NARROW = 3
/** Cards across in an opened purpose and in the section container group. */
export const CARD_COLUMNS = 2

export interface PickerEntry {
  name: string
  label: string
  purpose: LayoutPurpose
  kind: LayoutDef['kind']
  /** The one-line "when it fits" (registry copy). */
  fits: string
  aliases: string[]
  /** False when the slide cannot take the layout: the row is greyed and shows `reason`. */
  usable: boolean
  reason: string | null
}

export interface PickerCatalog {
  /** Every layout the picker offers, in registry order. */
  entries: PickerEntry[]
  recent: string[]
  suggested: LayoutSuggestion[]
  /** The slide has a heading and no body: suggestions give way to starting points (⌘↵). */
  headingOnly: boolean
  /** The slide is a `##` divider or holds child slides: how its slides are shown is chosen apart. */
  container: { slides: number } | null
  /** The slide's own layout, for the header's "now …". */
  currentLabel: string
  currentName: string | null
}

export interface CatalogInput {
  outline: string
  slide: SlideRef
  /** Layouts kept from the picker in this session, most recent first. */
  sessionRecent?: readonly string[]
}

function entryFor(def: LayoutDef, taken: ReturnType<typeof canTakeAllLayouts>): PickerEntry {
  const verdict = taken.get(def.name)
  return {
    name: def.name,
    label: def.label,
    purpose: def.purpose,
    kind: def.kind,
    fits: def.whenItFits ?? def.description,
    aliases: def.aliases,
    usable: !verdict || verdict.ok,
    reason: verdict && !verdict.ok ? verdict.reason : null
  }
}

/** How many slides sit under a container heading (its descendants, down to the next heading of its level or above). */
function slidesUnder(outline: string, slide: SlideRef): number {
  const read = readOutlineSlides(outline)
  const at = read.slides.findIndex((candidate) => typeof slide === 'string' ? candidate.id === slide : candidate.line === slide.headingLine)
  if (at < 0) return 0
  let count = 0
  for (let index = at + 1; index < read.slides.length; index += 1) {
    if (read.slides[index].level <= read.slides[at].level) break
    if (!read.slides[index].folded) count += 1
  }
  return count
}

function triggerLineOf(outline: string, slide: SlideRef): string {
  const read = readOutlineSlides(outline)
  const found = read.slides.find((candidate) => typeof slide === 'string' ? candidate.id === slide : candidate.line === slide.headingLine)
  if (!found) return ''
  return logicalTriggerBlockAfterHeading(read.lines, found.start)?.line ?? ''
}

export function buildPickerCatalog({ outline, slide, sessionRecent = [] }: CatalogInput): PickerCatalog {
  const taken = canTakeAllLayouts(outline, slide)
  const entries = LAYOUTS.filter(isPickerEligible).map((def) => entryFor(def, taken))
  const shape = readSlideShape(outline, slide)
  const read = readOutlineSlides(outline)
  const found = read.slides.find((candidate) => typeof slide === 'string' ? candidate.id === slide : candidate.line === slide.headingLine)
  const isContainer = shape.level === 2 || Boolean(found && (found.opensSection || found.container))
  const layoutNames = new Set(entries.filter((entry) => entry.kind !== 'modifier').map((entry) => entry.name))
  const recent: string[] = []
  for (const name of [...sessionRecent, ...recentLayouts(outline)]) {
    if (layoutNames.has(name) && !recent.includes(name)) recent.push(name)
  }
  const authored = winningAuthoredLayout(triggerLineOf(outline, slide))?.layout ?? null
  const current = authored ? LAYOUTS.find((def) => def.name === authored) : undefined
  return {
    entries,
    recent: recent.slice(0, MAX_RECENT),
    suggested: isContainer || shape.headingOnly ? [] : suggestLayouts(outline, slide),
    headingOnly: shape.headingOnly,
    container: isContainer ? { slides: slidesUnder(outline, slide) } : null,
    currentLabel: current?.label ?? 'Automatic',
    currentName: current?.name ?? null
  }
}

// ── Search ────────────────────────────────────────────────────────────────────────────────────

function fieldScore(field: string, token: string, starts: number, contains: number): number {
  const at = field.toLowerCase().indexOf(token)
  if (at < 0) return 0
  if (at === 0) return starts
  return /[\s\-/]/.test(field[at - 1] ?? '') ? starts - 10 : contains
}

/** Entries matching every word of `query` in the name, an alias or the when-it-fits line, best match first. */
export function searchPickerEntries(entries: readonly PickerEntry[], query: string): PickerEntry[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!tokens.length) return [...entries]
  const scored: Array<{ entry: PickerEntry; score: number }> = []
  for (const entry of entries) {
    let total = 0
    let every = true
    for (const token of tokens) {
      const score = Math.max(
        fieldScore(entry.label, token, 100, 70),
        fieldScore(entry.name, token, 100, 70),
        ...entry.aliases.map((alias) => fieldScore(alias, token, 60, 50)),
        fieldScore(entry.fits, token, 20, 20)
      )
      if (score === 0) { every = false; break }
      total += score
    }
    if (every) scored.push({ entry, score: total })
  }
  return scored
    .sort((a, b) => b.score - a.score || a.entry.label.length - b.entry.label.length || a.entry.label.localeCompare(b.entry.label))
    .map(({ entry }) => entry)
}

// ── State, view, keys ─────────────────────────────────────────────────────────────────────────

export type PickerGroupId = 'recent' | 'suggested' | 'container' | 'all' | 'results'

export type PickerStop =
  | { kind: 'layout'; name: string; group: PickerGroupId }
  | { kind: 'purpose'; purpose: LayoutPurpose; count: number; open: boolean }

export interface PickerBlock {
  /** A purpose's header row, when the block is one. */
  header?: Extract<PickerStop, { kind: 'purpose' }>
  /** Rows of layout stops (chips, pictures, cards or list rows), shown when the block is open. */
  rows: Array<Array<Extract<PickerStop, { kind: 'layout' }>>>
}

export interface PickerGroup {
  id: PickerGroupId
  heading: string
  caption: string
  shape: 'chips' | 'pictures' | 'list' | 'cards' | 'purposes' | 'note'
  /** For a `note` group: the sentence shown instead of rows, and its bold opening (S6). */
  note?: string
  noteLead?: string
  blocks: PickerBlock[]
}

export interface PickerView {
  groups: PickerGroup[]
  /** Every stop, row by row, in the order the arrow keys walk them. */
  rows: PickerStop[][]
  noResults: boolean
  total: number
}

export interface PickerState {
  query: string
  /** Purposes opened in All layouts. */
  open: LayoutPurpose[]
  /** The highlighted stop (see `stopKey`); null while nothing is highlighted (focus is in the box). */
  cursor: string | null
}

export const initialPickerState = (): PickerState => ({ query: '', open: [], cursor: null })

export const stopKey = (stop: PickerStop): string => stop.kind === 'purpose' ? `purpose:${stop.purpose}` : `layout:${stop.group}:${stop.name}`

export interface ViewOptions { suggestedColumns?: number }

function chunk<T>(items: T[], size: number): T[][] {
  const rows: T[][] = []
  for (let index = 0; index < items.length; index += size) rows.push(items.slice(index, index + size))
  return rows
}

function layoutStops(names: string[], group: PickerGroupId): Array<Extract<PickerStop, { kind: 'layout' }>> {
  return names.map((name) => ({ kind: 'layout', name, group }))
}

function purposeBlocks(catalog: PickerCatalog, state: PickerState, excludeKind?: PickerEntry['kind']): PickerBlock[] {
  return PICKER_PURPOSES.map((purpose): PickerBlock | null => {
    const inPurpose = catalog.entries.filter((entry) => entry.purpose === purpose && entry.kind !== excludeKind)
    if (!inPurpose.length) return null
    const open = state.open.includes(purpose)
    return {
      header: { kind: 'purpose', purpose, count: inPurpose.length, open },
      rows: open ? chunk(layoutStops(inPurpose.map((entry) => entry.name), 'all'), CARD_COLUMNS) : []
    }
  }).filter((block): block is PickerBlock => block !== null)
}

export function pickerView(catalog: PickerCatalog, state: PickerState, options: ViewOptions = {}): PickerView {
  const groups: PickerGroup[] = []
  const query = state.query.trim()
  if (query) {
    const found = searchPickerEntries(catalog.entries, query)
    if (found.length) {
      groups.push({
        id: 'results', heading: 'Layouts', caption: String(found.length), shape: 'list',
        blocks: [{ rows: layoutStops(found.map((entry) => entry.name), 'results').map((stop) => [stop]) }]
      })
    }
  } else if (catalog.container) {
    const containers = catalog.entries.filter((entry) => entry.kind === 'container')
    groups.push({
      id: 'container', heading: `Show its ${catalog.container.slides} slides as`, caption: 'container', shape: 'cards',
      blocks: [{ rows: chunk(layoutStops(containers.map((entry) => entry.name), 'container'), SUGGESTED_COLUMNS_WIDE) }]
    })
    groups.push({
      id: 'all', heading: 'This divider', caption: 'the ## slide itself', shape: 'purposes',
      blocks: purposeBlocks(catalog, state, 'container')
    })
  } else {
    if (catalog.recent.length) {
      groups.push({
        id: 'recent', heading: 'Recent', caption: '', shape: 'chips',
        blocks: [{ rows: [layoutStops(catalog.recent, 'recent')] }]
      })
    }
    if (catalog.suggested.length) {
      groups.push({
        id: 'suggested', heading: 'Suggested', caption: catalog.suggested[0].why, shape: 'pictures',
        blocks: [{ rows: chunk(layoutStops(catalog.suggested.map((suggestion) => suggestion.layout), 'suggested'), options.suggestedColumns ?? SUGGESTED_COLUMNS_WIDE) }]
      })
    } else {
      groups.push({
        id: 'suggested', heading: 'Suggested', caption: catalog.headingOnly ? 'heading only' : '', shape: 'note',
        noteLead: catalog.headingOnly ? 'Nothing to suggest for a heading alone.' : 'No layout stands out for this slide.',
        note: catalog.headingOnly
          ? 'Write a few points and suggestions appear here. ⌘↵ on any layout below adds its starter text.'
          : 'Browse them all below.',
        blocks: []
      })
    }
    groups.push({ id: 'all', heading: 'All layouts', caption: String(catalog.entries.length), shape: 'purposes', blocks: purposeBlocks(catalog, state) })
  }
  const rows: PickerStop[][] = []
  for (const group of groups) {
    for (const block of group.blocks) {
      if (block.header) rows.push([block.header])
      rows.push(...block.rows)
    }
  }
  return { groups, rows, noResults: Boolean(query) && groups.length === 0, total: catalog.entries.length }
}

function locate(view: PickerView, key: string | null): { row: number; col: number } | null {
  if (key === null) return null
  for (let row = 0; row < view.rows.length; row += 1) {
    const col = view.rows[row].findIndex((stop) => stopKey(stop) === key)
    if (col >= 0) return { row, col }
  }
  return null
}

export function highlightedStop(view: PickerView, state: PickerState): PickerStop | null {
  const at = locate(view, state.cursor)
  return at ? view.rows[at.row][at.col] : null
}

export type PickerAction =
  | { type: 'query'; query: string }
  | { type: 'move'; dir: 'up' | 'down' | 'left' | 'right' }
  | { type: 'next-group' }
  | { type: 'activate' }
  | { type: 'browse-all' }
  /** The pointer rested on a stop (or a click landed on one): highlight it. */
  | { type: 'point'; key: string }

/** The state after a key. `options` must be the ones the view was drawn with (the column width sets the Suggested row). */
export function reducePicker(catalog: PickerCatalog, state: PickerState, action: PickerAction, options: ViewOptions = {}): PickerState {
  switch (action.type) {
    case 'query': {
      const next: PickerState = { ...state, query: action.query, cursor: null }
      // The top match is highlighted at once; an emptied box highlights nothing.
      const first = action.query.trim() ? pickerView(catalog, next, options).rows[0]?.[0] : undefined
      return { ...next, cursor: first ? stopKey(first) : null }
    }
    case 'browse-all':
      return { ...state, query: '', cursor: null }
    case 'point':
      return locate(pickerView(catalog, state, options), action.key) ? { ...state, cursor: action.key } : state
    case 'move': {
      const view = pickerView(catalog, state, options)
      const at = locate(view, state.cursor)
      if (!at) {
        return action.dir === 'down' && view.rows[0] ? { ...state, cursor: stopKey(view.rows[0][0]) } : state
      }
      const stop = view.rows[at.row][at.col]
      if (action.dir === 'up') {
        return at.row === 0
          ? { ...state, cursor: null }
          : { ...state, cursor: stopKey(view.rows[at.row - 1][Math.min(at.col, view.rows[at.row - 1].length - 1)]) }
      }
      if (action.dir === 'down') {
        return at.row >= view.rows.length - 1
          ? state
          : { ...state, cursor: stopKey(view.rows[at.row + 1][Math.min(at.col, view.rows[at.row + 1].length - 1)]) }
      }
      if (stop.kind === 'purpose') {
        const open = state.open.includes(stop.purpose)
        if (action.dir === 'right' && !open) return { ...state, open: [...state.open, stop.purpose] }
        if (action.dir === 'left' && open) return { ...state, open: state.open.filter((purpose) => purpose !== stop.purpose) }
        return state
      }
      const col = at.col + (action.dir === 'right' ? 1 : -1)
      return col < 0 || col >= view.rows[at.row].length ? state : { ...state, cursor: stopKey(view.rows[at.row][col]) }
    }
    case 'next-group': {
      const view = pickerView(catalog, state, options)
      const firsts = view.groups
        .map((group) => group.blocks.find((block) => block.header || block.rows.length))
        .map((block) => block?.header ?? block?.rows[0]?.[0])
        .filter((stop): stop is PickerStop => Boolean(stop))
      if (!firsts.length) return state
      const at = locate(view, state.cursor)
      if (!at) return { ...state, cursor: stopKey(firsts[0]) }
      const here = view.rows[at.row][at.col]
      const groupIndex = groupOfStop(view, here)
      const target = firsts[(groupIndex + 1) % firsts.length] ?? firsts[0]
      return { ...state, cursor: stopKey(target) }
    }
    case 'activate': {
      const view = pickerView(catalog, state, options)
      const stop = highlightedStop(view, state)
      if (stop?.kind !== 'purpose') return state
      const open = state.open.includes(stop.purpose)
      return { ...state, open: open ? state.open.filter((purpose) => purpose !== stop.purpose) : [...state.open, stop.purpose] }
    }
  }
}

/** Index, among the groups that have stops, of the group a stop belongs to. */
function groupOfStop(view: PickerView, stop: PickerStop): number {
  const key = stopKey(stop)
  let index = 0
  for (const group of view.groups) {
    let hasStops = false
    let holds = false
    for (const block of group.blocks) {
      if (block.header) { hasStops = true; if (stopKey(block.header) === key) holds = true }
      for (const row of block.rows) { hasStops = true; if (row.some((candidate) => stopKey(candidate) === key)) holds = true }
    }
    if (!hasStops) continue
    if (holds) return index
    index += 1
  }
  return 0
}

/** The layout to show on the slide while it is highlighted (a preview; nothing is written), or null. */
export function pickerTry(catalog: PickerCatalog, view: PickerView, state: PickerState): string | null {
  const stop = highlightedStop(view, state)
  if (stop?.kind !== 'layout') return null
  const entry = catalog.entries.find((candidate) => candidate.name === stop.name)
  return entry?.usable ? entry.name : null
}

export type PickerCommit = { layout: string } | { blocked: string }

/** What ↵ keeps: the highlighted layout, or the reason it cannot be kept. Null when nothing is highlighted or a purpose is (↵ opens it). */
export function pickerCommit(catalog: PickerCatalog, view: PickerView, state: PickerState): PickerCommit | null {
  const stop = highlightedStop(view, state)
  if (stop?.kind !== 'layout') return null
  const entry = catalog.entries.find((candidate) => candidate.name === stop.name)
  if (!entry) return null
  return entry.usable ? { layout: entry.name } : { blocked: entry.reason ?? 'Not available on this slide' }
}

/** The session's recent layouts after `name` is kept: it moves to the front. */
export function rememberLayout(recent: readonly string[], name: string): string[] {
  return [name, ...recent.filter((candidate) => candidate !== name)].slice(0, MAX_RECENT)
}

// ── Own-slide pictures and the try timing ─────────────────────────────────────────────────────

/** Waits before a highlight becomes a try on the preview (mockup keyboard map): keys at once, typing a third of a second, a resting pointer a quarter. */
export const TRY_DELAY_MS = { keys: 40, typing: 300, pointer: 250 } as const
export type TryCause = keyof typeof TRY_DELAY_MS

/**
 * The layouts to draw as the author's own slide, in the order to ask: the Suggested ones first, then the
 * ones whose rows are on screen. A layout the slide cannot take is never asked for (it shows its sample).
 */
export function ownPictureWanted(catalog: PickerCatalog, visible: readonly string[]): string[] {
  const usable = new Set(catalog.entries.filter((entry) => entry.usable).map((entry) => entry.name))
  const names: string[] = []
  for (const name of [...catalog.suggested.map((suggestion) => suggestion.layout), ...visible]) {
    if (usable.has(name) && !names.includes(name)) names.push(name)
  }
  return names
}

/**
 * The catalog with the render's verdicts laid over it: a layout the own-slide render says cannot take
 * this text (`layout:variant-thumbnail` → `cannot-take`) becomes unusable with that reason, exactly as
 * a registry verdict does, so the row is aria-disabled, ↵ cannot keep it (`pickerCommit` → blocked),
 * a try does not show it and its tooltip gives the reason, not the "fits" line.
 */
export function withRenderVerdicts(catalog: PickerCatalog, verdicts: Readonly<Record<string, string>>): PickerCatalog {
  if (!catalog.entries.some((entry) => entry.usable && verdicts[entry.name] !== undefined)) return catalog
  return {
    ...catalog,
    entries: catalog.entries.map((entry) => (entry.usable && verdicts[entry.name] !== undefined
      ? { ...entry, usable: false, reason: verdicts[entry.name] }
      : entry))
  }
}
