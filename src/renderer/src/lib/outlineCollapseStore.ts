// The collapse state of every talk's outline, held outside React so the sidebar outline and the grid
// share one state, and so it outlives either component (switching the sidebar to Talks and back,
// switching to the grid and back). The model is outlineCollapse.ts; this file holds it per talk,
// tells subscribers, and remembers it in localStorage, bounded (see MAX_TALKS / MAX_KEYS_PER_TALK).
// Nothing here touches the talk's text.
import { useCallback, useSyncExternalStore } from 'react'
import { slideRows } from '../extensions/slideOutline'
import {
  adoptRows, ancestorKeys, collapseAll as modelCollapseAll, emptySaved, expandKeys, keyRows, parseSaved,
  putTalk, reconcile, serialiseSaved, toggleKey, toggleSubtree as modelToggleSubtree,
  type CollapseState, type KeyedRow, type SavedStore
} from './outlineCollapse'

export const STORAGE_KEY = 'tw-outline-collapse-v1'

/** What a component renders from. A new object whenever anything in it changes. */
export interface CollapseSnapshot {
  /** The outline as last published for this talk. */
  rows: readonly KeyedRow[]
  collapsed: ReadonlySet<string>
  /** Bumped by every reveal: the row with `revealKey` was asked to be shown and scrolled to. */
  revealSeq: number
  revealKey: string | null
  /** Bumped by every Collapse all / Expand all: lets the grid apply it to groups with no outline section. */
  bulkSeq: number
  bulkCollapsed: boolean
}

interface TalkEntry {
  state: CollapseState
  rows: readonly KeyedRow[]
  content: string | null
  snapshot: CollapseSnapshot
  /** Saved keys not yet matched against a published outline. */
  pendingSaved: ReadonlySet<string> | null
}

const talks = new Map<string, TalkEntry>()
const listeners = new Set<() => void>()
let storage: Pick<Storage, 'getItem' | 'setItem'> | null = null
let storageResolved = false
let clock: () => number = () => Date.now()

function theStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  if (!storageResolved) {
    storageResolved = true
    try { storage = storage ?? globalThis.localStorage ?? null } catch { storage = null }
  }
  return storage
}

/** Tests: replace the storage and clock, and forget everything held in memory (as an app restart does). */
// Collapsed grid groups that are no outline section (the slides before the first section, the closing
// slide): per talk, for this session only. Kept here, outside the grid, so leaving the grid and coming
// back shows the same groups collapsed.
const gridOnly = new Map<string, Set<string>>()
export function gridOnlyCollapsed(talkKey: string): Set<string> {
  return gridOnly.get(talkKey) ?? new Set()
}
export function setGridOnlyCollapsed(talkKey: string, value: Set<string>): void {
  if (!talkKey) return
  if (value.size > 0) gridOnly.set(talkKey, value)
  else gridOnly.delete(talkKey)
}

export function resetOutlineCollapseForTests(options: { storage?: Pick<Storage, 'getItem' | 'setItem'> | null; now?: () => number } = {}): void {
  talks.clear()
  gridOnly.clear()
  storage = options.storage ?? null
  storageResolved = options.storage !== undefined
  clock = options.now ?? (() => Date.now())
}

function readSaved(): SavedStore {
  try { return parseSaved(theStorage()?.getItem(STORAGE_KEY)) } catch { return emptySaved() }
}

function persist(talkKey: string, keys: ReadonlySet<string>): void {
  if (!talkKey) return
  try {
    const s = theStorage()
    if (s) s.setItem(STORAGE_KEY, serialiseSaved(putTalk(readSaved(), talkKey, keys, clock())))
  } catch { /* not remembered */ }
}

function snapshotOf(e: Pick<TalkEntry, 'rows' | 'state'>, prev?: CollapseSnapshot, patch: Partial<CollapseSnapshot> = {}): CollapseSnapshot {
  return {
    rows: e.rows,
    collapsed: e.state.collapsed,
    revealSeq: prev?.revealSeq ?? 0,
    revealKey: prev?.revealKey ?? null,
    bulkSeq: prev?.bulkSeq ?? 0,
    bulkCollapsed: prev?.bulkCollapsed ?? false,
    ...patch
  }
}

function entryFor(talkKey: string): TalkEntry {
  let e = talks.get(talkKey)
  if (!e) {
    const saved = talkKey ? readSaved().talks[talkKey] : undefined
    const keys = new Set(saved?.keys ?? [])
    const state: CollapseState = { collapsed: new Set(), ghosts: [] }
    e = { state, rows: [], content: null, snapshot: snapshotOf({ rows: [], state }), pendingSaved: keys.size > 0 ? keys : null }
    // Until an outline is published the saved keys are what is collapsed.
    if (keys.size > 0) {
      e.state = { collapsed: keys, ghosts: [] }
      e.snapshot = snapshotOf(e)
    }
    talks.set(talkKey, e)
  }
  return e
}

function commit(talkKey: string, e: TalkEntry, state: CollapseState, patch: Partial<CollapseSnapshot> = {}, save = true): void {
  const changedSet = state.collapsed !== e.state.collapsed
  e.state = state
  e.snapshot = snapshotOf(e, e.snapshot, patch)
  if (changedSet && save) persist(talkKey, state.collapsed)
  for (const l of [...listeners]) l()
}

// ── Reading ──

export function subscribeOutlineCollapse(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function getCollapseSnapshot(talkKey: string): CollapseSnapshot {
  return entryFor(talkKey).snapshot
}

// ── Publishing the outline (the workspace does this on every change of the talk's text) ──

export function publishOutline(talkKey: string, content: string): void {
  const e = entryFor(talkKey)
  if (e.content === content) return
  e.content = content
  const rows = keyRows(slideRows(content))
  if (rows.length === 0) return // not loaded yet, or a talk with no headings: keep what is remembered
  const prevRows = e.rows
  e.rows = rows
  let state: CollapseState
  const adopting = e.pendingSaved !== null
  if (e.pendingSaved) {
    // Saved keys that match no row yet stay as ghosts; rewrite the entry as it was so it counts as used.
    persist(talkKey, e.pendingSaved)
    state = adoptRows(rows, e.pendingSaved)
    e.pendingSaved = null
  } else {
    state = reconcile(prevRows, rows, e.state)
  }
  // The rows changed even when the collapsed set did not: a new snapshot, and a save only if the set moved.
  const setChanged = state.collapsed.size !== e.state.collapsed.size || [...state.collapsed].some((k) => !e.state.collapsed.has(k))
  commit(talkKey, e, setChanged ? state : { ...state, collapsed: e.state.collapsed }, {}, !adopting)
}

// ── Changing ──

function change(talkKey: string, next: (rows: readonly KeyedRow[], collapsed: ReadonlySet<string>) => Set<string>, patch: Partial<CollapseSnapshot> = {}): void {
  const e = entryFor(talkKey)
  const collapsed = next(e.rows, e.state.collapsed)
  const same = collapsed.size === e.state.collapsed.size && [...collapsed].every((k) => e.state.collapsed.has(k))
  if (same && Object.keys(patch).length === 0) return
  commit(talkKey, e, same ? e.state : { ...e.state, collapsed }, patch)
}

export function toggleSection(talkKey: string, key: string): void {
  change(talkKey, (_rows, c) => toggleKey(c, key))
}

export function setSectionCollapsed(talkKey: string, key: string, collapsed: boolean): void {
  change(talkKey, (_rows, c) => {
    if (c.has(key) === collapsed) return new Set(c)
    return toggleKey(c, key)
  })
}

/** Option-click on a caret. */
export function toggleSectionTree(talkKey: string, key: string): void {
  change(talkKey, (rows, c) => modelToggleSubtree(rows, c, key))
}

export function collapseAllSections(talkKey: string): void {
  const e = entryFor(talkKey)
  change(talkKey, (rows) => modelCollapseAll(rows), { bulkSeq: e.snapshot.bulkSeq + 1, bulkCollapsed: true })
}

export function expandAllSections(talkKey: string): void {
  const e = entryFor(talkKey)
  change(talkKey, () => new Set(), { bulkSeq: e.snapshot.bulkSeq + 1, bulkCollapsed: false })
}

/** Open every section above the row holding source line `line`, and ask the outline to scroll to it. */
export function revealLine(talkKey: string, line: number, content?: string): void {
  if (content !== undefined) publishOutline(talkKey, content)
  const e = entryFor(talkKey)
  const rowKey = e.rows.filter((r) => r.line <= line).pop()?.key ?? null
  const above = ancestorKeys(e.rows, line)
  const collapsed = expandKeys(e.state.collapsed, above)
  commit(talkKey, e, collapsed.size === e.state.collapsed.size ? e.state : { ...e.state, collapsed }, {
    revealSeq: e.snapshot.revealSeq + 1,
    revealKey: rowKey
  })
}

/** Open the given sections (the grid reveals the group a jump landed in). */
export function revealKeys(talkKey: string, keys: readonly string[]): void {
  const e = entryFor(talkKey)
  const collapsed = expandKeys(e.state.collapsed, keys)
  if (collapsed.size === e.state.collapsed.size) return
  commit(talkKey, e, { ...e.state, collapsed }, { revealSeq: e.snapshot.revealSeq + 1, revealKey: null })
}

// ── React ──

export function useOutlineCollapse(talkKey: string | null | undefined): CollapseSnapshot {
  const key = talkKey ?? ''
  const get = useCallback(() => getCollapseSnapshot(key), [key])
  return useSyncExternalStore(subscribeOutlineCollapse, get, get)
}
