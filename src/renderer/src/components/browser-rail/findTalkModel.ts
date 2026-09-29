// "Find a talk" in the slide picker (ADR-0029 §4; ticket talk-search 05; frames K1–K4), as pure
// functions: the result rows (the file list's own rows over the shared talk search, so the same
// query gives the same talks in the same order), the scope moves (↵ picks and replaces, ⌘↵ adds
// beside, a chip's × removes), the chips the box shows, and which keys the box keeps from the
// picker's grid keys. No React or DOM here.
import type { TalkInfo } from '../../../../preload/index'
import type { TalkSearchHit } from '../../../../shared/talk-search'
import { flattenSearchHits } from '../talklist/model'
import { type ScopeEntry, scopeKeyOf } from './railModel'

export interface FindTalkRow {
  key: string
  talk: TalkInfo
  hit: TalkSearchHit
  /** The talk being edited: listed and marked, never scoped (its slides are never on the table). */
  current: boolean
}

/** The results "Find a talk" lists: exactly the file list's search rows, in its order. */
export function findTalkRows(hits: TalkSearchHit[], listed: Map<string, TalkInfo>, currentTalkSlug: string): FindTalkRow[] {
  const rows: FindTalkRow[] = []
  for (const row of flattenSearchHits(hits, listed)) {
    if (row.kind !== 'talk' || !row.hit) continue
    rows.push({ key: row.key, talk: row.talk, hit: row.hit, current: !!currentTalkSlug && row.talk.slug === currentTalkSlug })
  }
  return rows
}

/** Where the highlight starts: the first talk that can be picked (the current talk cannot). */
export function firstPickable(rows: FindTalkRow[]): number {
  const i = rows.findIndex((r) => !r.current)
  return i < 0 ? 0 : i
}

export function talkEntry(talk: Pick<TalkInfo, 'slug' | 'title'>): ScopeEntry {
  return { kind: 'talk', talk: talk.slug, talkTitle: talk.title || talk.slug }
}

/** The scope plus which of its entries came from "Find a talk" (scope keys): those show as chips. */
export interface FindScope {
  scope: ScopeEntry[]
  picked: string[]
}

/** ↵: the talk alone, whole and in outline order — the scope is replaced, the slide search kept. */
export function pickTalk(_state: FindScope, entry: ScopeEntry): FindScope {
  return { scope: [entry], picked: [scopeKeyOf(entry)] }
}

/** ⌘↵: the talk beside what is open, as ⌘-click adds it — appended, never toggled out. Past
 *  three talks the grid falls back to sequential, as it does for ⌘-click: there is no fourth
 *  column. */
export function addTalkBeside(state: FindScope, entry: ScopeEntry): FindScope {
  const key = scopeKeyOf(entry)
  const picked = state.picked.includes(key) ? state.picked : [...state.picked, key]
  if (state.scope.some((e) => scopeKeyOf(e) === key)) return { scope: state.scope, picked }
  return { scope: [...state.scope, entry], picked }
}

/** A chip's ×: that talk leaves the scope; the last one gone leaves the picker unscoped. */
export function removeFindChip(state: FindScope, key: string): FindScope {
  return {
    scope: state.scope.filter((e) => scopeKeyOf(e) !== key),
    picked: state.picked.filter((k) => k !== key)
  }
}

/** The chips in the box: the scope's talks that were picked from "Find a talk", in scope order.
 *  A talk the tree scoped (or one since removed from the scope) shows no chip. */
export function findChips(state: FindScope): ScopeEntry[] {
  return state.scope.filter((e) => e.kind === 'talk' && state.picked.includes(scopeKeyOf(e)))
}

/** Picks whose talk has left the scope (the tree replaced it, a scope row's × removed it). */
export function prunePicked(state: FindScope): string[] {
  const keys = new Set(state.scope.map(scopeKeyOf))
  const kept = state.picked.filter((k) => keys.has(k))
  return kept.length === state.picked.length ? state.picked : kept
}

/** Keys the box handles itself, so the picker's grid keys (↑↓ move the grid, ⌘↵ inserts, Esc
 *  closes, Tab cycles) leave them alone while it is focused. */
export function findBoxOwnsKey(key: string, box: { value: string; listing: boolean; completing: boolean }): boolean {
  if (box.completing && (key === 'ArrowUp' || key === 'ArrowDown' || key === 'Enter' || key === 'Tab' || key === 'Escape')) return true
  if (key === 'Escape' || key === 'Enter') return box.value !== '' || box.listing
  if (key === 'ArrowUp' || key === 'ArrowDown') return box.listing
  return false
}
