// The Plain view's Command-I picker (PlainIconPicker.tsx): what it lists and how the arrows move.
// No React, no DOM apart from localStorage.
//
//   - The icons come from the app's one icon source, the bridge the Inspector's picker uses
//     (`window.tw.icons`): `names()` is the Lucide set in its own order, `search()` the compiler's
//     search over Lucide, the brands and Tabler, `svg()` the picture. No index is kept here.
//   - KNOWN icons: every key the bridge has handed over (the set's names, a search's hits). The
//     verb writes a key only when it is one of them (shared/icon-verbs.ts setLineIcon `known`),
//     so nothing typed or stored reaches the outline as an icon name.
//   - Recently used: the last icons inserted with this picker, most recent first, kept per app in
//     localStorage. A stored key is shown only once it is known.
import { ICON_KEY_RE } from '../../../shared/icon-verbs'

export const COLUMNS = 5
/** How many of the full set are drawn at first, and how many more each time the end comes near. */
export const PAGE = 60
export const RECENT_MAX = 10
const RECENT_KEY = 'tw-plain-icon-picker-recent'

export interface IconsBridge {
  search: (query: string) => Promise<Array<{ key: string; source: string }>>
  svg: (key: string) => Promise<string | null>
  names?: () => Promise<string[]>
}

export function iconsBridge(): IconsBridge | null {
  return (window as unknown as { tw?: { icons?: IconsBridge } }).tw?.icons ?? null
}

const known = new Set<string>()
/** Whether the bridge has handed this key over: the verb's `known`. */
export const isKnownIcon = (key: string): boolean => known.has(key)
export function rememberKnown(keys: readonly string[]): string[] {
  const good = keys.filter((key) => typeof key === 'string' && ICON_KEY_RE.test(key))
  for (const key of good) known.add(key)
  return good
}

let allNames: Promise<string[]> | null = null
/** The Lucide set, asked for once. Empty when the bridge has none (an older preload): search still works. */
export function loadAllIcons(): Promise<string[]> {
  if (!allNames) {
    const bridge = iconsBridge()
    allNames = (bridge?.names ? bridge.names().catch(() => []) : Promise.resolve([])).then((names) => rememberKnown(Array.isArray(names) ? names : []))
    void allNames.then((names) => { if (!names.length) allNames = null })
  }
  return allNames
}

export async function searchIcons(query: string): Promise<string[]> {
  const bridge = iconsBridge()
  if (!bridge) return []
  const hits = await bridge.search(query).catch(() => [])
  return rememberKnown((Array.isArray(hits) ? hits : []).map((hit) => hit?.key))
}

export function storedRecent(): string[] {
  try {
    const list = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? '[]') as unknown
    return Array.isArray(list) ? [...new Set(list.filter((key): key is string => typeof key === 'string' && ICON_KEY_RE.test(key)))].slice(0, RECENT_MAX) : []
  } catch {
    return []
  }
}

export function pushRecent(key: string): void {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify([key, ...storedRecent().filter((other) => other !== key)].slice(0, RECENT_MAX)))
  } catch { /* storage is full or off: the icon is still inserted */ }
}

/**
 * The stored recent icons that are known. A Lucide key is known once the set is loaded; a brand or
 * Tabler key is asked of the search, by its own name, and kept when the search returns that key.
 */
export async function knownRecent(): Promise<string[]> {
  await loadAllIcons()
  const out: string[] = []
  for (const key of storedRecent()) {
    if (!known.has(key) && !key.startsWith('lucide:')) await searchIcons(key.slice(key.indexOf(':') + 1))
    if (known.has(key)) out.push(key)
  }
  return out
}

export const iconName = (key: string): string => key.slice(key.indexOf(':') + 1)
const SETS: Record<string, string> = { lucide: 'Lucide', svgl: 'Brand', tabler: 'Tabler' }
export const iconSet = (key: string): string => SETS[key.slice(0, key.indexOf(':'))] ?? ''

// ── The grid the arrows move in ─────────────────────────────────────────────────────────────────

export const REMOVE = '__remove'
export interface Section { label: string; keys: readonly string[] }

/** Rows of stops, top to bottom: the Remove row alone (when there is one), then each section's icons in rows of COLUMNS. */
export function gridRows(sections: readonly Section[], withRemove: boolean): string[][] {
  const rows: string[][] = withRemove ? [[REMOVE]] : []
  for (const section of sections) {
    for (let i = 0; i < section.keys.length; i += COLUMNS) rows.push(section.keys.slice(i, i + COLUMNS).map((key) => `${section.label}\n${key}`))
  }
  return rows
}

/** A stop's icon key (a stop is named by its section too, so an icon in Recent and in All is two stops). */
export const stopKey = (stop: string): string => stop.slice(stop.indexOf('\n') + 1)

export type Move = 'left' | 'right' | 'up' | 'down'

/** The stop an arrow moves to. Left and right run on through the rows; up and down keep the column where the row has one. */
export function moveStop(rows: readonly string[][], from: string | null, move: Move): string | null {
  const flat = rows.flat()
  if (!flat.length) return null
  let r = rows.findIndex((row) => from !== null && row.includes(from))
  if (r < 0) return rows.find((row) => row[0] !== REMOVE)?.[0] ?? flat[0]
  const c = rows[r].indexOf(from!)
  if (move === 'left' || move === 'right') {
    const at = flat.indexOf(from!) + (move === 'right' ? 1 : -1)
    return flat[Math.max(0, Math.min(flat.length - 1, at))]
  }
  r += move === 'down' ? 1 : -1
  if (r < 0 || r >= rows.length) return from
  return rows[r][Math.min(c, rows[r].length - 1)]
}

/** Where the picker starts: the first match, or the first recent icon; never the Remove row. */
export function firstStop(rows: readonly string[][]): string | null {
  return rows.find((row) => row[0] !== REMOVE)?.[0] ?? null
}
