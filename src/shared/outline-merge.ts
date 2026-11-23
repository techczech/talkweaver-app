// Structural three-way merge in the editor’s canonical text format. Ambiguity is a choice, never a guess.
import { listSlideBlocks } from '../../compiler/scripts/lib/slide-blocks.mjs'
import { headingTitle, resolveSlideId } from '../../compiler/scripts/lib/slide-id.mjs'

export interface OutlineMergeConflict { id: string; label: string; base: string; mine: string; disk: string; mineDeleted?: boolean; diskDeleted?: boolean }
export interface OutlineMerge { parts: Array<{ text: string } | { conflict: OutlineMergeConflict }>; conflicts: OutlineMergeConflict[] }
interface Block { key: string; label: string; text: string }
interface Edit { from: number; to: number; insert: string[] }
export const normalizeOutlineMergeText = (text: string): string => text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
const linesOf = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? []

// LCS is bounded per block; a huge rewritten slide becomes an explicit conflict.
function edits(base: string[], next: string[]): Edit[] | null {
  let prefix = 0
  while (prefix < base.length && prefix < next.length && base[prefix] === next[prefix]) prefix++
  let end = base.length, nextEnd = next.length
  while (end > prefix && nextEnd > prefix && base[end - 1] === next[nextEnd - 1]) { end--; nextEnd-- }
  const n = end - prefix, m = nextEnd - prefix
  if (!n && !m) return []
  if ((n + 1) * (m + 1) > 2_000_000) return null
  const width = m + 1
  const table = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    table[i * width + j] = base[prefix + i] === next[prefix + j]
      ? table[(i + 1) * width + j + 1] + 1
      : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
  }
  const result: Edit[] = []
  let i = 0, j = 0, current: Edit | null = null
  while (i < n || j < m) {
    if (i < n && j < m && base[prefix + i] === next[prefix + j]) {
      if (current) { result.push(current); current = null }
      i++; j++; continue
    }
    current ??= { from: prefix + i, to: prefix + i, insert: [] }
    if (j < m && (i === n || table[i * width + j + 1] >= table[(i + 1) * width + j])) current.insert.push(next[prefix + j++])
    else { i++; current.to = prefix + i }
  }
  if (current) result.push(current)
  return result
}

function overlaps(a: Edit, b: Edit): boolean {
  if (a.from === a.to || b.from === b.to) return a.from <= b.to && b.from <= a.to
  return a.from < b.to && b.from < a.to
}

function mergeLines(base: string, mine: string, disk: string): string | null {
  if (mine === disk || disk === base) return mine
  if (mine === base) return disk
  const original = linesOf(base)
  const a = edits(original, linesOf(mine)), b = edits(original, linesOf(disk))
  if (!a || !b) return null
  const combined = [...a]
  for (const incoming of b) {
    const touching = a.filter(edit => overlaps(edit, incoming))
    if (touching.length) {
      if (touching.length !== 1 || touching[0].from !== incoming.from || touching[0].to !== incoming.to ||
          touching[0].insert.join('') !== incoming.insert.join('')) return null
    } else combined.push(incoming)
  }
  combined.sort((x, y) => x.from - y.from)
  const result: string[] = []
  let at = 0
  for (const edit of combined) { result.push(...original.slice(at, edit.from), ...edit.insert); at = edit.to }
  result.push(...original.slice(at))
  return result.join('')
}

function blocks(text: string): Block[] | null {
  const lines = text.split('\n'), bytes = linesOf(text)
  const headings = listSlideBlocks(text)
  const result: Block[] = [{ key: 'preamble', label: 'Talk title and metadata', text: bytes.slice(0, headings[0]?.start ?? bytes.length).join('') }]
  for (let i = 0; i < headings.length; i++) {
    const block = headings[i]
    const end = headings[i + 1]?.start ?? bytes.length
    const id = resolveSlideId(lines, block.start, block.end)?.id
    result.push({ key: id ? `id:${id}` : `heading:${block.heading}`, label: headingTitle(block.heading), text: bytes.slice(block.start, end).join('') })
  }
  return new Set(result.map(block => block.key)).size === result.length ? result : null
}

export function mergeOutline(base: string, mine: string, disk: string): OutlineMerge {
  base = normalizeOutlineMergeText(base); mine = normalizeOutlineMergeText(mine); disk = normalizeOutlineMergeText(disk)
  const result: OutlineMerge = { parts: [], conflicts: [] }
  const conflict = (id: string, label: string, b: string, m: string, d: string, deleted?: { mineDeleted?: boolean; diskDeleted?: boolean }): void => {
    const item = { id, label, base: b, mine: m, disk: d, ...deleted }
    result.conflicts.push(item); result.parts.push({ conflict: item })
  }
  if (mine === disk || disk === base || mine === base) {
    result.parts.push({ text: mine === base ? disk : mine }); return result
  }
  const b = blocks(base), m = blocks(mine), d = blocks(disk)
  const whole = (): OutlineMerge => { conflict('outline', 'Whole talk — structure changed', base, mine, disk); return result }
  if (!b || !m || !d) return whole()
  const bm = new Map(b.map(x => [x.key, x])), mm = new Map(m.map(x => [x.key, x])), dm = new Map(d.map(x => [x.key, x]))
  // A missing identity plus a new one can be a rename or stripped/replaced ID. We cannot
  // pair those blocks without guessing; presenting either as a deletion would corrupt choices.
  for (const side of [mm, dm]) {
    if (b.some(block => !side.has(block.key)) && [...side.keys()].some(key => !bm.has(key))) return whole()
  }
  // A paused truncate/write can look like an intentional tail deletion even after stable reads.
  // With unsaved local edits, require a choice for each trailing slide missing from disk.
  const trailingDiskDeletions = new Set<string>()
  for (let i = b.length - 1; i > 0 && !dm.has(b[i].key); i--) trailingDiskDeletions.add(b[i].key)
  // A deletion opposed by an edit must remain in the order so its two versions can be chosen.
  const restoreEditedDeletions = (side: Block[], other: Map<string, Block>): string[] => {
    const order = side.map(x => x.key)
    for (let i = b.length - 1; i >= 0; i--) {
      const key = b[i].key
      if (order.includes(key) || !other.has(key) || (other.get(key)!.text === b[i].text && !(side === d && trailingDiskDeletions.has(key)))) continue
      const next = b.slice(i + 1).find(x => order.includes(x.key))
      order.splice(next ? order.indexOf(next.key) : order.length, 0, key)
    }
    return order
  }
  // JSON encodes keys before the line merge: a heading cannot inject a fake order line.
  const encode = (keys: string[]): string => keys.map(key => JSON.stringify(key) + '\n').join('')
  const beforeOrder = b.map(x => x.key), localOrder = restoreEditedDeletions(m, dm), diskOrder = restoreEditedDeletions(d, mm)
  const onlyAppends = (keys: string[]): boolean => beforeOrder.every((key, i) => keys[i] === key)
  // Two independent appends have a safe deterministic order: local additions then disk additions.
  const order = onlyAppends(localOrder) && onlyAppends(diskOrder)
    ? encode([...new Set([...localOrder, ...diskOrder.slice(beforeOrder.length)])])
    : mergeLines(encode(beforeOrder), encode(localOrder), encode(diskOrder))
  if (order === null) return whole()
  const keys = linesOf(order).map(line => JSON.parse(line) as string)
  if (new Set(keys).size !== keys.length) return whole()
  for (const key of keys) {
    const before = bm.get(key), local = mm.get(key), external = dm.get(key)
    const bt = before?.text ?? '', mt = local?.text ?? '', dt = external?.text ?? ''
    const deletionConflict = !!before && ((!local && !!external && dt !== bt) || (!external && !!local && (mt !== bt || trailingDiskDeletions.has(key))))
    const text = deletionConflict ? null : mergeLines(bt, mt, dt)
    if (text === null) conflict(key, (local ?? external ?? before)!.label, bt, mt, dt, { ...(before && !local ? { mineDeleted: true } : {}), ...(before && !external ? { diskDeleted: true } : {}) })
    else result.parts.push({ text })
  }
  return result
}

/** Null until every conflict has an explicit resolution (empty string means delete). */
export function resolveOutlineMerge(merge: OutlineMerge, choices: Record<string, string>): string | null {
  if (merge.conflicts.some(item => !Object.hasOwn(choices, item.id))) return null
  const blocks = merge.parts.map(part => 'text' in part ? part.text : choices[part.conflict.id]).filter(Boolean)
  return blocks.map((text, i) => i < blocks.length - 1 && !text.endsWith('\n\n')
    ? text + (text.endsWith('\n') ? '\n' : '\n\n') : text).join('')
}
