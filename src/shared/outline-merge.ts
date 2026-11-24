// Structural three-way merge in the editor’s canonical text format. Ambiguity is a choice, never a guess.
import { listSlideBlocks } from '../../compiler/scripts/lib/slide-blocks.mjs'
import { headingTitle, ID_TOKEN_RE, preContentWindow, resolveSlideId } from '../../compiler/scripts/lib/slide-id.mjs'

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

function trailingMissingKeys(keys: readonly string[], present: ReadonlyMap<string, unknown>): Set<string> {
  const missing = new Set<string>()
  for (let i = keys.length - 1; i >= 0 && !present.has(keys[i]); i--) missing.add(keys[i])
  return missing
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
  const trailingDiskDeletions = trailingMissingKeys(b.slice(1).map(block => block.key), dm)
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

export type SlideMergeSide = 'mine' | 'disk'
export type SlideMergeChoice = SlideMergeSide | 'both'
export type SlideMergeChoices = Readonly<Record<string, SlideMergeChoice>>
export type SlideMergeChange = 'changed-here' | 'changed-on-disk' | 'changed-in-both'
export type SlideMergeStatus = SlideMergeChange | 'added-here' | 'added-on-disk' | 'removed-here' | 'removed-on-disk'

export interface SlideMergeVersion {
  id?: string
  title: string
  depth: number
  /** One-based slide number and source line in this version of the outline. */
  number: number
  line: number
  text: string
}

export interface SlideMergeDiffSpan {
  kind: 'same' | 'removed' | 'added'
  text: string
}

interface SlideMergeItem {
  key: string
  base?: SlideMergeVersion
  mine?: SlideMergeVersion
  disk?: SlideMergeVersion
}

export interface SlideMergeRow extends SlideMergeItem {
  status: SlideMergeStatus
  defaultChoice?: SlideMergeSide
  diskDiscardsWindowEdits: boolean
  diff: SlideMergeDiffSpan[]
}

export interface SlideMergeDetails {
  key: 'talk-details'
  base: string
  mine: string
  disk: string
  status: SlideMergeChange
  defaultChoice?: SlideMergeSide
  diskDiscardsWindowEdits: boolean
  diff: SlideMergeDiffSpan[]
}

export interface SlideMergeOrder {
  key: 'slide-order'
  status: SlideMergeChange
  defaultChoice?: SlideMergeSide
}

interface SlideMergeSnapshot {
  source: string
  details: string
  slides: ReadonlyMap<string, SlideMergeVersion>
  duplicateIds: readonly string[]
}

export interface SlideMergePlan {
  rows: readonly SlideMergeRow[]
  details: SlideMergeDetails | null
  order: SlideMergeOrder | null
  versions: { base: SlideMergeSnapshot; mine: SlideMergeSnapshot; disk: SlideMergeSnapshot }
  orders: Record<SlideMergeSide, readonly string[]>
  duplicateIds: readonly string[]
}

export type SlideMergeResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'unresolved' | 'invalid-choice'; keys: string[] }
  | { ok: false; reason: 'duplicate-ids'; ids: string[] }
  | { ok: false; reason: 'unsafe-structure' }

// Ignoring line-ending and inter-slide padding differences in the comparison keeps an append
// from looking like an edit to the previous slide. The slices themselves retain their bytes.
const comparable = (text: string): string => normalizeOutlineMergeText(text).replace(/\n+$/, '')
const sourceLines = (text: string): string[] => text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? []

function slideMergeSnapshot(source: string): SlideMergeSnapshot {
  const bom = source.startsWith('\uFEFF') ? '\uFEFF' : ''
  const bytes = sourceLines(source.slice(bom.length))
  const normalized = normalizeOutlineMergeText(source)
  const lines = normalized.split('\n')
  // Mirror the compiler's front-matter masking so YAML comments cannot become slides.
  const fmEnd = /^---\s*$/.test(lines[0]) ? lines.findIndex((line, i) => i > 0 && /^---\s*$/.test(line)) : -1
  const scan = fmEnd === -1 ? normalized : lines.map((line, i) => i <= fmEnd ? '' : line).join('\n')
  const blocks = listSlideBlocks(scan)
  const headingCounts = new Map<string, number>()
  const slides = new Map<string, SlideMergeVersion>()
  const duplicateIds = new Set<string>()
  for (const [i, block] of blocks.entries()) {
    const id = resolveSlideId(lines, block.start, block.end)?.id
    const title = headingTitle(block.heading)
    const occurrence = id ? 0 : (headingCounts.get(title) ?? 0) + 1
    if (!id) headingCounts.set(title, occurrence)
    let key = id ? `id:${id}` : `heading:${JSON.stringify([title, occurrence])}`
    if (id && slides.has(key)) {
      duplicateIds.add(id)
      key = `duplicate:${JSON.stringify([id, i + 1])}`
    }
    const text = bytes.slice(block.start, blocks[i + 1]?.start ?? bytes.length).join('')
    const depth = block.heading.match(/^#+/)![0].length
    slides.set(key, { id, title, depth, number: i + 1, line: block.start + 1, text })
  }
  return { source, details: bom + bytes.slice(0, blocks[0]?.start ?? bytes.length).join(''), slides, duplicateIds: [...duplicateIds] }
}

type UnstampedEntry = [string, SlideMergeVersion]

function unstampedByTitle(snapshot: SlideMergeSnapshot): Map<string, UnstampedEntry[]> {
  const groups = new Map<string, UnstampedEntry[]>()
  for (const entry of snapshot.slides) {
    const [, slide] = entry
    if (slide.id) continue
    const group = groups.get(slide.title) ?? []
    group.push(entry)
    groups.set(slide.title, group)
  }
  return groups
}

function keysByText(entries: readonly UnstampedEntry[]): Map<string, string[]> {
  const groups = new Map<string, string[]>()
  for (const [key, slide] of [...entries].reverse()) {
    const text = comparable(slide.text)
    const group = groups.get(text) ?? []
    group.push(key)
    groups.set(text, group)
  }
  return groups
}

function alignUnstamped(base: SlideMergeSnapshot, mine: SlideMergeSnapshot, disk: SlideMergeSnapshot) {
  const groups = { base: unstampedByTitle(base), mine: unstampedByTitle(mine), disk: unstampedByTitle(disk) }
  const mineKeys = new Map<string, string>(), diskKeys = new Map<string, string>()
  for (const title of new Set([...groups.mine.keys(), ...groups.disk.keys()])) {
    const before = groups.base.get(title) ?? [], here = groups.mine.get(title) ?? [], there = groups.disk.get(title) ?? []
    const beforeByText = keysByText(before), diskByText = keysByText(there)
    const free = new Set(before.map(([key]) => key))
    const pairs = here.flatMap(([key, slide]) => {
      const text = comparable(slide.text)
      const other = diskByText.get(text)?.pop()
      if (!other) return []
      const baseKey = beforeByText.get(text)?.pop()
      if (baseKey) free.delete(baseKey)
      return [{ mine: key, disk: other, base: baseKey }]
    })
    // Exact text present on both sides always survives. A base position is only evidence
    // when that pane has the same number of occurrences as the base.
    for (const pair of pairs) {
      const eligible = [here.length === before.length ? pair.mine : undefined, there.length === before.length ? pair.disk : undefined]
      const position = eligible.find(key => key && free.has(key))
      const key = pair.base ?? position ?? `agreed:${pair.mine}`
      free.delete(key)
      mineKeys.set(pair.mine, key)
      diskKeys.set(pair.disk, key)
    }
    const assignUnpaired = (side: SlideMergeSide, entries: UnstampedEntry[], keys: Map<string, string>): void => {
      const candidates = [...free]
      let at = 0
      for (const [key] of entries) {
        if (keys.has(key)) continue
        keys.set(key, (entries.length === before.length ? candidates[at++] : undefined) ?? `${side}:${key}`)
      }
    }
    assignUnpaired('mine', here, mineKeys)
    assignUnpaired('disk', there, diskKeys)
  }
  const aligned = (snapshot: SlideMergeSnapshot, keys: Map<string, string>): SlideMergeSnapshot => ({
    ...snapshot, slides: new Map([...snapshot.slides].map(([key, slide]) => [keys.get(key) ?? key, slide]))
  })
  const ambiguous = (side: SlideMergeSide, slide: SlideMergeVersion): boolean => {
    if (slide.id) return false
    const b = groups.base.get(slide.title)?.length ?? 0
    const count = groups[side].get(slide.title)?.length ?? 0
    return count !== b && (count > 1 || b > 1)
  }
  return { mine: aligned(mine, mineKeys), disk: aligned(disk, diskKeys), ambiguous }
}

// A stable read can still catch a writer paused after truncating. A UTF-8 cut can decode
// its final partial character as U+FFFD, which is also evidence of a possible prefix.
function looksLikeTruncatedPrefix(reference: string, disk: string): boolean {
  const prefix = disk.endsWith('\uFFFD') ? disk.slice(0, -1) : disk
  return prefix.length < reference.length && reference.startsWith(prefix)
}

function compareSides(base: string | undefined, mine: string | undefined, disk: string | undefined): SlideMergeChange {
  return base === disk ? 'changed-here' : base === mine ? 'changed-on-disk' : 'changed-in-both'
}

function mergeWordDiff(mine: string, disk: string): SlideMergeDiffSpan[] {
  const tokens = (text: string): string[] => text.match(/\s+|[\p{L}\p{N}\p{M}_]+|[^\s]/gu) ?? []
  const a = tokens(mine), b = tokens(disk)
  const patch = edits(a, b) ?? [{ from: 0, to: a.length, insert: b }]
  const spans: SlideMergeDiffSpan[] = []
  let at = 0
  const add = (kind: SlideMergeDiffSpan['kind'], text: string): void => {
    if (text) spans.push({ kind, text })
  }
  for (const edit of patch) {
    add('same', a.slice(at, edit.from).join(''))
    add('removed', a.slice(edit.from, edit.to).join(''))
    add('added', edit.insert.join(''))
    at = edit.to
  }
  add('same', a.slice(at).join(''))
  return spans
}

// Insert keys in runs before their next surviving neighbour. Choosing an order preserves the
// relative order of every slide on that side, and a version chosen from the other side still
// has a place even if it was deleted from the chosen order.
function includeMissing(order: string[], source: readonly string[]): void {
  const present = new Set(order)
  let next: string | undefined
  for (let i = source.length - 1; i >= 0; i--) {
    const key = source[i]
    if (!present.has(key)) {
      order.splice(next === undefined ? order.length : order.indexOf(next), 0, key)
      present.add(key)
    }
    next = key
  }
}

function compareSlideOrder(base: SlideMergeSnapshot, mine: SlideMergeSnapshot, disk: SlideMergeSnapshot): SlideMergeOrder | null {
  const reordered = (side: SlideMergeSnapshot): boolean => {
    const original = [...base.slides.keys()].filter(key => side.slides.has(key))
    return [...side.slides.keys()].filter(key => base.slides.has(key)).some((key, i) => key !== original[i])
  }
  const here = reordered(mine), there = reordered(disk)
  const onBoth = (side: SlideMergeSnapshot, other: SlideMergeSnapshot) => [...side.slides.keys()].filter(key => other.slides.has(key))
  const diskCommon = onBoth(disk, mine)
  const sameOrder = onBoth(mine, disk).every((key, i) => key === diskCommon[i])
  if (!here && !there && sameOrder) return null
  if (here && !there) return { key: 'slide-order', status: 'changed-here', defaultChoice: 'mine' }
  if (!here && there) return { key: 'slide-order', status: 'changed-on-disk', defaultChoice: 'disk' }
  return { key: 'slide-order', status: 'changed-in-both', ...(sameOrder ? { defaultChoice: 'mine' } : {}) }
}

export function planSlideMerge(baseText: string, mineText: string, diskText: string): SlideMergePlan {
  const base = slideMergeSnapshot(baseText)
  const { mine, disk, ambiguous } = alignUnstamped(base, slideMergeSnapshot(mineText), slideMergeSnapshot(diskText))
  const baseOrder = [...base.slides.keys()]
  const baseKeys = baseOrder.filter(key => mine.slides.has(key) || disk.slides.has(key))
  const normalizedBase = normalizeOutlineMergeText(baseText)
  const windowEdited = normalizeOutlineMergeText(mineText) !== normalizedBase
  const allSlidesMissing = base.slides.size > 0 && disk.slides.size === 0
  const truncated = windowEdited && looksLikeTruncatedPrefix(normalizedBase, normalizeOutlineMergeText(diskText))
  const trailing = windowEdited ? trailingMissingKeys(baseOrder, disk.slides) : new Set<string>()
  const lastDiskKey = windowEdited ? [...disk.slides.keys()].at(-1) : undefined
  const orderFrom = (primary: SlideMergeSnapshot, secondary: SlideMergeSnapshot): string[] => {
    const keys = [...primary.slides.keys()]
    includeMissing(keys, baseKeys)
    includeMissing(keys, [...secondary.slides.keys()])
    return keys
  }
  const orders = { mine: orderFrom(mine, disk), disk: orderFrom(disk, mine) }
  const order = compareSlideOrder(base, mine, disk)
  if (order && (allSlidesMissing || (truncated && order.defaultChoice === 'disk'))) order.defaultChoice = undefined
  const rows: SlideMergeRow[] = []
  for (const key of orders[order?.defaultChoice ?? 'mine']) {
    const b = base.slides.get(key), m = mine.slides.get(key), d = disk.slides.get(key)
    const bt = b && comparable(b.text), mt = m && comparable(m.text), dt = d && comparable(d.text)
    if (mt === dt) continue
    const change = compareSides(bt, mt, dt)
    let status: SlideMergeStatus = change
    let defaultChoice: SlideMergeSide | undefined = change === 'changed-here' ? 'mine' : change === 'changed-on-disk' ? 'disk' : undefined
    if (!m || !d) {
      status = m ? (b ? 'removed-on-disk' : 'added-here') : (b ? 'removed-here' : 'added-on-disk')
      // Keep an unedited block when its positional match is uncertain. A competing
      // edit and deletion already require a choice, even with an uncertain match.
      if (b && defaultChoice) {
        if (m && ambiguous('disk', b)) defaultChoice = 'mine'
        if (d && ambiguous('mine', b)) defaultChoice = 'disk'
      }
    }
    // A paused write can end in an edited block that matches neither complete version.
    // In a dirty window, require a choice for the last changed or added disk block.
    const unconfirmedDiskTail = key === lastDiskKey &&
      (status === 'changed-on-disk' || status === 'changed-in-both' || status === 'added-on-disk')
    if (allSlidesMissing || trailing.has(key) || unconfirmedDiskTail || (truncated && bt !== dt)) defaultChoice = undefined
    rows.push({ key, base: b, mine: m, disk: d, status, defaultChoice, diskDiscardsWindowEdits: mt !== bt, diff: mergeWordDiff(m?.text ?? '', d?.text ?? '') })
  }
  const bd = comparable(base.details), md = comparable(mine.details), dd = comparable(disk.details)
  const detailStatus = compareSides(bd, md, dd)
  const unconfirmedDiskDetails = disk.slides.size === 0 && bd !== dd
  const details: SlideMergeDetails | null = md === dd ? null : {
    key: 'talk-details', base: base.details, mine: mine.details, disk: disk.details, status: detailStatus,
    defaultChoice: unconfirmedDiskDetails
      ? undefined : detailStatus === 'changed-here' ? 'mine' : detailStatus === 'changed-on-disk' ? 'disk' : undefined,
    diskDiscardsWindowEdits: md !== bd, diff: mergeWordDiff(mine.details, disk.details)
  }
  const duplicateIds = [...new Set([...base.duplicateIds, ...mine.duplicateIds, ...disk.duplicateIds])]
  return { rows, details, order, versions: { base, mine, disk }, orders, duplicateIds }
}

// Allocate only for Keep both, in the ledger's five-character alphabet. Start at a deterministic
// hash of the three source snapshots and probe past any ID already mentioned in those snapshots.
function copyIdAllocator(sources: readonly string[], reservedIds: Iterable<string>): () => string {
  let seed = 2166136261
  const taken = new Set(reservedIds)
  for (const source of sources) {
    for (let i = 0; i < source.length; i++) seed = Math.imul(seed ^ source.charCodeAt(i), 16777619)
    for (const match of source.matchAll(new RegExp(ID_TOKEN_RE.source, 'g'))) taken.add(match[1])
  }
  const size = 36 ** 5
  let next = (seed >>> 0) % size
  return () => {
    for (let probe = 0; probe < size; probe++) {
      const id = next.toString(36).padStart(5, '0')
      next = (next + 1) % size
      if (taken.has(id)) continue
      taken.add(id)
      return id
    }
    throw new Error('No unused slide ID is available.')
  }
}

function copySlide(text: string, id: string, depth: number): string {
  const lines = sourceLines(text)
  const resolved = resolveSlideId(lines, 0)
  const { end } = preContentWindow(lines, 0)
  const allIds = new RegExp(ID_TOKEN_RE.source, 'g')
  for (let i = 0; i < end; i++) {
    let keep = resolved?.line === i
    const original = lines[i]
    const cleaned = original.replace(allIds, () => {
      if (!keep) return ''
      keep = false
      return `{id=${id}}`
    })
    lines[i] = cleaned !== original && !cleaned.trim() ? '' : cleaned
  }
  // A disk copy with a different depth must not close any of the window's ancestors.
  lines[0] = lines[0].replace(/^#+/, '#'.repeat(depth))
  if (!resolved) lines[0] = lines[0].replace(/[^\r\n]+/, heading => `${heading} {id=${id}}`)
  return lines.join('')
}

/** Supply the destination vault's known ledger IDs when it is available to the caller. */
export function applySlideMerge(plan: SlideMergePlan, choices: SlideMergeChoices = {}, reservedIds: Iterable<string> = []): SlideMergeResult {
  const { base, mine, disk } = plan.versions
  if (plan.duplicateIds.length) return { ok: false, reason: 'duplicate-ids', ids: [...plan.duplicateIds] }
  const rows = new Map(plan.rows.map(row => [row.key, row]))
  const applicable = [...plan.rows, ...(plan.details ? [plan.details] : []), ...(plan.order ? [plan.order] : [])]
  const selected = new Map(applicable.map(row => [row.key, Object.hasOwn(choices, row.key) ? choices[row.key] : row.defaultChoice]))
  const invalid = Object.keys(choices).filter(key => {
    if (!selected.has(key)) return true
    const choice = choices[key], row = rows.get(key)
    return choice !== 'mine' && choice !== 'disk' && !(choice === 'both' && row?.mine && row.disk)
  })
  if (invalid.length) return { ok: false, reason: 'invalid-choice', keys: invalid }
  const unresolved = applicable.filter(row => !selected.get(row.key)).map(row => row.key)
  if (unresolved.length) return { ok: false, reason: 'unresolved', keys: unresolved }

  // A unanimous choice reproduces that snapshot, including its exact separators and EOF.
  if (applicable.every(row => selected.get(row.key) === 'mine')) return { ok: true, text: mine.source }
  if (applicable.every(row => selected.get(row.key) === 'disk')) return { ok: true, text: disk.source }

  let text = selected.get('talk-details') === 'disk' ? disk.details : mine.details
  let line = sourceLines(text).length + 1
  const newline = mine.source.match(/\r\n|\r|\n/)?.[0] ?? disk.source.match(/\r\n|\r|\n/)?.[0] ?? '\n'
  const expected: Array<{ line: number; id?: string }> = []
  const append = (source: string, id?: string): void => {
    if (text && text !== '\uFEFF' && !/[\r\n]$/.test(text)) text += newline
    if (text === '\uFEFF') line = 1
    expected.push({ line, id })
    text += source
    line += sourceLines(source).length
  }

  let freshId: (() => string) | undefined
  const pending: Array<{ slide: SlideMergeVersion; depth: number; id: string }> = []
  const flushCopies = (nextDepth: number): void => {
    while (pending.length && pending.at(-1)!.depth >= nextDepth) {
      const copy = pending.pop()!
      append(copySlide(copy.slide.text, copy.id, copy.depth), copy.id)
    }
  }
  for (const key of plan.orders[selected.get('slide-order') === 'disk' ? 'disk' : 'mine']) {
    const choice = selected.get(key)
    const slide = choice === 'disk' ? disk.slides.get(key) : mine.slides.get(key)
    if (!slide) continue
    flushCopies(slide.depth)
    append(slide.text, slide.id)
    if (choice === 'both') {
      freshId ??= copyIdAllocator([base.source, mine.source, disk.source], reservedIds)
      pending.push({ slide: disk.slides.get(key)!, depth: slide.depth, id: freshId() })
    }
  }
  flushCopies(0)
  // A terminal open fence or comment in one source can swallow the next chosen slide. Confirm
  // that every chosen block is still addressable at its intended line in the assembled outline.
  const output = slideMergeSnapshot(text)
  const slides = [...output.slides.values()]
  if (output.duplicateIds.length || slides.length !== expected.length ||
      slides.some((slide, i) => slide.line !== expected[i].line || slide.id !== expected[i].id)) {
    return { ok: false, reason: 'unsafe-structure' }
  }
  return { ok: true, text }
}
