// Which sections of a talk's outline are collapsed: the pure model (no React, no storage, no DOM).
// scripts/test-outline-collapse.mjs imports this file directly. The per-talk store that holds the
// state and remembers it is outlineCollapseStore.ts.
//
// The state is a set of KEYS, not line numbers. A key names a heading in a way that survives edits:
//   - `id:<id>` when the slide/section carries an `{id=…}`;
//   - otherwise `h<level>:<text>`;
// and a second heading with the same identity gets `~1`, a third `~2`, … in document order (the
// first keeps the bare key, so adding a twin later does not rename the original).
// When the outline changes, `reconcile` moves the flags from the old rows to the new ones.

export interface OutlineRowLike {
  line: number
  level: number
  text: string
  id: string | null
  /** Numbered leaf slides carry a number; sections and the deck title do not. */
  slideNo: number | null
}

export interface KeyedRow {
  key: string
  /** The key without its occurrence suffix. */
  base: string
  line: number
  level: number
  text: string
  /** Has a deeper heading after it, so it can be collapsed. */
  section: boolean
  /** A numbered slide (counted in a collapsed section's total). */
  slide: boolean
}

export function keyRows(rows: readonly OutlineRowLike[]): KeyedRow[] {
  const seen = new Map<string, number>()
  return rows.map((r, i) => {
    const base = r.id ? `id:${r.id}` : `h${r.level}:${r.text}`
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return {
      key: n === 0 ? base : `${base}~${n}`,
      base,
      line: r.line,
      level: r.level,
      text: r.text,
      section: i + 1 < rows.length && rows[i + 1].level > r.level,
      slide: r.slideNo != null
    }
  })
}

// ── Reading the rows ──

/** Index one past the last row inside the section at `index` (its subtree). */
function subtreeEnd(rows: readonly KeyedRow[], index: number): number {
  let end = index + 1
  while (end < rows.length && rows[end].level > rows[index].level) end += 1
  return end
}

export function sectionKeys(rows: readonly KeyedRow[]): string[] {
  return rows.filter((r) => r.section).map((r) => r.key)
}

/** The section at `key` and every section inside it. */
export function subtreeSectionKeys(rows: readonly KeyedRow[], key: string): string[] {
  const i = rows.findIndex((r) => r.key === key)
  if (i < 0) return []
  return rows.slice(i, subtreeEnd(rows, i)).filter((r) => r.section).map((r) => r.key)
}

/** How many numbered slides sit inside the section at `key`. */
export function slideCount(rows: readonly KeyedRow[], key: string): number {
  const i = rows.findIndex((r) => r.key === key)
  if (i < 0) return 0
  return rows.slice(i + 1, subtreeEnd(rows, i)).filter((r) => r.slide).length
}

/** Row index containing source line `line`: the last heading at or before it. */
export function rowIndexAtLine(rows: readonly KeyedRow[], line: number): number {
  let best = -1
  for (let i = 0; i < rows.length; i += 1) if (rows[i].line <= line) best = i
  return best
}

/** The sections above the row at `index`, nearest last. */
export function ancestorKeysOfIndex(rows: readonly KeyedRow[], index: number): string[] {
  if (index < 0 || index >= rows.length) return []
  const out: string[] = []
  let level = rows[index].level
  for (let i = index - 1; i >= 0 && level > 1; i -= 1) {
    if (rows[i].level < level) { out.unshift(rows[i].key); level = rows[i].level }
  }
  return out
}

export function ancestorKeys(rows: readonly KeyedRow[], line: number): string[] {
  return ancestorKeysOfIndex(rows, rowIndexAtLine(rows, line))
}

/** Lines hidden by a collapsed ancestor, at any depth. */
export function hiddenLines(rows: readonly KeyedRow[], collapsed: ReadonlySet<string>): Set<number> {
  const hidden = new Set<number>()
  let collapseAtLevel: number | null = null
  for (const r of rows) {
    if (collapseAtLevel !== null && r.level > collapseAtLevel) { hidden.add(r.line); continue }
    collapseAtLevel = null
    if (r.section && collapsed.has(r.key)) collapseAtLevel = r.level
  }
  return hidden
}

/** The outermost collapsed section hiding the row at `line`, or null when the row is visible. */
export function hidingSectionLine(rows: readonly KeyedRow[], collapsed: ReadonlySet<string>, line: number): number | null {
  const index = rowIndexAtLine(rows, line)
  if (index < 0) return null
  for (const k of ancestorKeysOfIndex(rows, index)) {
    if (collapsed.has(k)) return rows.find((r) => r.key === k)?.line ?? null
  }
  return null
}

// ── Changing the set (each returns a new set; the input is never changed) ──

/** The talk's level-1 title row: the only level-1 heading, when it is the first row. Null otherwise. */
export function titleRowKey(rows: readonly KeyedRow[]): string | null {
  if (rows.length === 0 || rows[0].level !== 1) return null
  return rows.filter((r) => r.level === 1).length === 1 ? rows[0].key : null
}

/** Collapse every section and subsection except the talk's level-1 title row, so the title and its
 *  top-level sections stay in view. The title can still be collapsed by hand. */
export function collapseAll(rows: readonly KeyedRow[]): Set<string> {
  const title = titleRowKey(rows)
  return new Set(sectionKeys(rows).filter((k) => k !== title))
}

export function expandAll(): Set<string> {
  return new Set()
}

export function toggleKey(collapsed: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(collapsed)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}

/** Option-click: collapse the section and every section inside it, or open them all. The direction
 *  follows the clicked section: collapsed -> open everything inside, open -> collapse everything. */
export function toggleSubtree(rows: readonly KeyedRow[], collapsed: ReadonlySet<string>, key: string): Set<string> {
  const keys = subtreeSectionKeys(rows, key)
  const next = new Set(collapsed)
  const opening = collapsed.has(key)
  for (const k of keys) {
    if (opening) next.delete(k)
    else next.add(k)
  }
  return next
}

export function expandKeys(collapsed: ReadonlySet<string>, keys: readonly string[]): Set<string> {
  const next = new Set(collapsed)
  for (const k of keys) next.delete(k)
  return next
}

// ── Following the sections through an edit ──

export const MAX_GHOSTS = 100

export interface CollapseState {
  /** Keys of rows in the current outline that are collapsed. */
  collapsed: Set<string>
  /** Keys of collapsed sections that vanished from the outline (deleted, or text changed under an
   *  unlucky edit). If a row with the same key comes back (undo), it is collapsed again. Session
   *  only; never saved. Oldest first. */
  ghosts: string[]
}

function sameKeys(a: readonly KeyedRow[], b: readonly KeyedRow[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i].key !== b[i].key) return false
  return true
}

/** Best order-keeping alignment of two index lists by `base`; returns matched [oldRow, newRow] pairs.
 *  A match is worth more when the rows around the two headings also agree, so of several identical
 *  headings the one in the same place in the outline is the one matched. */
function lcsPairs(
  oldRows: readonly KeyedRow[], oldIdx: readonly number[],
  newRows: readonly KeyedRow[], newIdx: readonly number[]
): Array<[number, number]> {
  const n = oldIdx.length
  const m = newIdx.length
  if (n === 0 || m === 0) return []
  const below = (rows: readonly KeyedRow[], at: number): Set<string> => {
    const out = new Set<string>()
    for (let k = at + 1; k < rows.length && rows[k].level > rows[at].level; k += 1) out.add(rows[k].base)
    return out
  }
  const weight = (i: number, j: number): number => {
    const o = oldIdx[i]
    const w = newIdx[j]
    if (oldRows[o].base !== newRows[w].base) return 0
    let score = 4 + (oldRows[o - 1]?.base === newRows[w - 1]?.base ? 1 : 0) + (oldRows[o + 1]?.base === newRows[w + 1]?.base ? 1 : 0)
    // Headings that hold the same slides are the same heading.
    const inNew = below(newRows, w)
    for (const b of below(oldRows, o)) if (inNew.has(b)) score += 2
    return score
  }
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      const w = weight(i, j)
      table[i][j] = Math.max(table[i + 1][j], table[i][j + 1], w > 0 ? table[i + 1][j + 1] + w : 0)
    }
  }
  const out: Array<[number, number]> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    const w = weight(i, j)
    if (w > 0 && table[i][j] === table[i + 1][j + 1] + w) { out.push([oldIdx[i], newIdx[j]]); i += 1; j += 1 }
    else if (table[i + 1][j] >= table[i][j + 1]) i += 1
    else j += 1
  }
  return out
}

/** Which old row each new row is (newIndex -> oldIndex). Rows are the same section when:
 *  1. their identity occurs exactly once on each side (this follows a section through any move);
 *  2. they line up in order among the rest (duplicates, and everything around an edit);
 *  3. a gap between two matched rows holds the same number of old and new rows of the same levels:
 *     the heading was renamed in place. */
export function matchRows(oldRows: readonly KeyedRow[], newRows: readonly KeyedRow[]): Map<number, number> {
  const pairs = new Map<number, number>()
  const countOld = new Map<string, number>()
  const countNew = new Map<string, number>()
  for (const r of oldRows) countOld.set(r.base, (countOld.get(r.base) ?? 0) + 1)
  for (const r of newRows) countNew.set(r.base, (countNew.get(r.base) ?? 0) + 1)
  const oldByBase = new Map<string, number>()
  oldRows.forEach((r, i) => { if (countOld.get(r.base) === 1) oldByBase.set(r.base, i) })
  newRows.forEach((r, j) => {
    if (countNew.get(r.base) === 1 && countOld.get(r.base) === 1) pairs.set(j, oldByBase.get(r.base)!)
  })

  const usedOld = new Set(pairs.values())
  const remOld = oldRows.map((_, i) => i).filter((i) => !usedOld.has(i))
  const remNew = newRows.map((_, j) => j).filter((j) => !pairs.has(j))
  for (const [i, j] of lcsPairs(oldRows, remOld, newRows, remNew)) pairs.set(j, i)

  // Renames: walk both lists; between matched rows, an equal-sized gap of equal levels is a rename.
  const matchedOld = new Set(pairs.values())
  const anchors: Array<[number, number]> = [[-1, -1], ...[...pairs.entries()].map(([j, i]) => [i, j] as [number, number]).sort((a, b) => a[0] - b[0]), [oldRows.length, newRows.length]]
  // Moves can make anchors cross; only use anchors that increase on both sides.
  const mono: Array<[number, number]> = [anchors[0]]
  for (const a of anchors.slice(1)) if (a[1] > mono[mono.length - 1][1]) mono.push(a)
  for (let k = 0; k + 1 < mono.length; k += 1) {
    const oldGap: number[] = []
    for (let i = mono[k][0] + 1; i < mono[k + 1][0]; i += 1) if (!matchedOld.has(i)) oldGap.push(i)
    const newGap: number[] = []
    for (let j = mono[k][1] + 1; j < mono[k + 1][1]; j += 1) if (!pairs.has(j)) newGap.push(j)
    if (oldGap.length === 0 || oldGap.length !== newGap.length) continue
    if (oldGap.every((i, x) => oldRows[i].level === newRows[newGap[x]].level)) {
      oldGap.forEach((i, x) => { pairs.set(newGap[x], i); matchedOld.add(i) })
    }
  }
  return pairs
}

/** First sight of an outline for a talk (state restored from storage, no earlier rows to compare):
 *  keep the saved keys that match a row; keep the rest as ghosts, so a stale first read cannot wipe
 *  what was saved. */
export function adoptRows(newRows: readonly KeyedRow[], saved: ReadonlySet<string>): CollapseState {
  const present = new Set(newRows.map((r) => r.key))
  const collapsed = new Set<string>()
  const ghosts: string[] = []
  for (const k of saved) {
    if (present.has(k)) collapsed.add(k)
    else ghosts.push(k)
  }
  return { collapsed, ghosts: ghosts.slice(-MAX_GHOSTS) }
}

/** The outline changed from `oldRows` to `newRows`: every collapsed section stays collapsed, wherever
 *  it went, and no other row becomes collapsed. An empty `newRows` (outline not loaded) changes
 *  nothing. */
export function reconcile(
  oldRows: readonly KeyedRow[], newRows: readonly KeyedRow[], state: CollapseState
): CollapseState {
  if (newRows.length === 0 || sameKeys(oldRows, newRows)) return state
  const pairs = matchRows(oldRows, newRows)
  const matchedOld = new Set(pairs.values())
  const collapsed = new Set<string>()
  const ghosts = state.ghosts.slice()
  newRows.forEach((r, j) => {
    const i = pairs.get(j)
    if (i !== undefined) {
      if (state.collapsed.has(oldRows[i].key)) collapsed.add(r.key)
      return
    }
    const g = ghosts.indexOf(r.key)
    if (g >= 0) { ghosts.splice(g, 1); collapsed.add(r.key) } // a deleted section is back (undo)
  })
  oldRows.forEach((r, i) => {
    if (!matchedOld.has(i) && state.collapsed.has(r.key) && !ghosts.includes(r.key)) ghosts.push(r.key)
  })
  return { collapsed, ghosts: ghosts.slice(-MAX_GHOSTS) }
}

// ── Sharing with the grid ──
// The grid groups slides by the `section` string of the compiled slides. For a talk written as an
// outline that string is the section's ID, not its text: the `{id=…}` of the `##` heading when it
// has one, else a slug the compiler makes from the title ("Section 2" -> "section-2"). Other sources
// (imports) carry the section's title there. The group's own title (from its section-title slide)
// is the heading text either way.
//
// Each group maps to one outline section, and no section to two groups:
//   1. the section whose id is the group's `section` string;
//   2. else the next unused section whose text is the group's title, or its `section` string
//      (the nth group with a given text to the nth such heading);
//   3. else the next unused section whose text makes the group's `section` string as a slug.
// A group that matches none (slides before the first section, the closing slide, a heading whose
// compiled title differs from its source) maps to null.

export interface GridGroupLike {
  /** The compiled slides' `section` value: an id, a slug, or a title. */
  section: string
  /** The group's display title, when it has one of its own. */
  title?: string
}

const normalise = (s: string): string => s.replace(/\{[^}]*\}/g, '').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
const slug = (s: string): string => normalise(s).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')

export function matchGroupsToSections(rows: readonly KeyedRow[], groups: ReadonlyArray<string | GridGroupLike>): Array<string | null> {
  const level2 = rows.filter((r) => r.section && r.level === 2)
  const pool = level2.length > 0 ? level2 : rows.filter((r) => r.section)
  const list = groups.map((g) => (typeof g === 'string' ? { section: g, title: undefined } : g))
  const out: Array<string | null> = list.map(() => null)
  const used = new Set<string>()
  const take = (gi: number, fits: (r: KeyedRow) => boolean): void => {
    if (out[gi] !== null || !list[gi].section) return
    const r = pool.find((row) => !used.has(row.key) && fits(row))
    if (r) { out[gi] = r.key; used.add(r.key) }
  }
  // By id first, for every group, so a heading with an id is never taken by a same-titled twin.
  list.forEach((g, gi) => take(gi, (r) => r.base === `id:${g.section}`))
  list.forEach((g, gi) => {
    const texts = new Set([g.title, g.section].filter((t): t is string => !!t).map(normalise))
    take(gi, (r) => texts.has(normalise(r.text)))
  })
  list.forEach((g, gi) => take(gi, (r) => slug(r.text) !== '' && slug(r.text) === g.section.toLowerCase()))
  return out
}

// ── Remembering ──

export const MAX_TALKS = 80
export const MAX_KEYS_PER_TALK = 400

export interface SavedTalk { keys: string[]; at: number }
export interface SavedStore { v: 1; talks: Record<string, SavedTalk> }

export function emptySaved(): SavedStore {
  return { v: 1, talks: {} }
}

export function serialiseSaved(store: SavedStore): string {
  return JSON.stringify(store)
}

/** Tolerant: anything that is not a well-formed store reads as empty. */
export function parseSaved(raw: string | null | undefined): SavedStore {
  if (!raw) return emptySaved()
  try {
    const data = JSON.parse(raw) as unknown
    if (!data || typeof data !== 'object' || (data as SavedStore).v !== 1) return emptySaved()
    const talks: Record<string, SavedTalk> = {}
    for (const [k, v] of Object.entries((data as SavedStore).talks ?? {})) {
      if (v && Array.isArray(v.keys) && typeof v.at === 'number') {
        talks[k] = { keys: v.keys.filter((x) => typeof x === 'string').slice(0, MAX_KEYS_PER_TALK), at: v.at }
      }
    }
    return { v: 1, talks }
  } catch {
    return emptySaved()
  }
}

/** Record a talk's collapsed keys and when it was last used. An empty set removes the talk's entry
 *  (nothing to remember). The least recently used talks beyond MAX_TALKS are dropped. */
export function putTalk(store: SavedStore, talkKey: string, keys: Iterable<string>, now: number): SavedStore {
  const talks = { ...store.talks }
  const list = [...keys].slice(0, MAX_KEYS_PER_TALK)
  if (list.length === 0) delete talks[talkKey]
  else talks[talkKey] = { keys: list, at: now }
  const names = Object.keys(talks)
  if (names.length > MAX_TALKS) {
    names.sort((a, b) => talks[b].at - talks[a].at)
    for (const dropped of names.slice(MAX_TALKS)) delete talks[dropped]
  }
  return { v: 1, talks }
}
