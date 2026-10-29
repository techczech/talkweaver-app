// Slide Scratchpad store: the one module that reads and writes a talk's scratch folder state.
//
//   <talk folder>/scratchpad/                          agents drop .svg .html .htm .png .jpg .jpeg .webp .gif here
//   <talk folder>/scratchpad/<file>.json               optional sidecar: { title, description, sources }
//   <talk folder>/scratchpad/scratchpad-state.json     app-owned state (this module is its only writer)
//
// Invariants (spec § Invariants):
//   - Agent files are read-only: nothing here writes, renames or deletes anything but the state file
//     (and the `scratchpad-state.broken-<time>.json` copy of a state file that could not be used).
//   - The state file is written atomically (temp file in the same folder, then rename), only when it changed.
//   - A state file that cannot be used is copied to scratchpad-state.broken-<time>.json, the panel falls back
//     to the folder's files as ungrouped active items, and the notice says what was lost.
//   - A state file that exists but cannot be read, is not a regular file (a link is never followed), or could not
//     be copied aside is never overwritten: that load shows the files read-only and changes are refused.
//   - A scratch folder that is itself a link is not used at all (no list, no read, no write; a notice says so).
//   - Items are only ever added, re-statused, re-grouped, marked inserted (ticket 2: when, and into which slide),
//     or (state only) removed when their file is missing. The outline is never this module's business.
// Every operation runs one after another (a queue), so two clicks never interleave their read-modify-write.
// scratchpad-disk.ts pins filesystem authority in a child working directory and returns private checked
// snapshots; deferred previews/imports never reopen an agent-writable path. State/recovery writes are
// relative to the held directory and every state write is read back there before the queue advances.
import { createHash, randomBytes } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { createScratchpadDisk, type ScratchDiskScan, type ScratchFileIdentity } from './scratchpad-disk.ts'
import { extname, join } from 'node:path'
import { contentTextFor, MAX_CONTENT_CHARS } from './scratchpad-text.ts'
import {
  scratchOrder, newestFirst, FILE_KIND_BY_EXTENSION, SCRATCH_FOLDER_NAME, STATE_FILE_NAME, titleFromFileName,
  type ScratchFileKind, type ScratchGroup, type ScratchItem, type ScratchSlide, type ScratchSlideInput,
  type ScratchSnapshot, type ScratchSource, type ScratchState, type ScratchStateItem, type ScratchStatus
} from '../shared/scratchpad.ts'

export interface ScratchpadStoreOptions {
  now?: () => Date
  newItemId?: () => string
  newGroupId?: () => string
  /** An image address for the checked private snapshot (never the agent-writable source path). */
  fileUrlFor?: (absolutePath: string) => string | undefined
  /** The words an HTML page rendered (captured in the hidden window), '' until captured; merged into the search text. */
  renderedTextFor?: (absolutePath: string) => string
}

export interface ScratchpadStore {
  readonly folder: string
  /** Scans the folder, merges it into the state (writing the state when that changed it) and answers the whole panel. */
  load(): Promise<ScratchSnapshot>
  addSlides(inputs: readonly ScratchSlideInput[]): Promise<{ snapshot: ScratchSnapshot; added: number; skipped: number }>
  /** Atomically saves every snapshot and its dated group; rejects the entire batch on any invalid input. */
  setAside(inputs: readonly ScratchSlideInput[]): Promise<ScratchSnapshot>
  setSort(sort: 'newest' | 'manual'): Promise<ScratchSnapshot>
  reorder(visible: readonly string[], next: readonly string[]): Promise<ScratchSnapshot>
  setStatus(ids: readonly string[], status: ScratchStatus): Promise<ScratchSnapshot>
  /** group === null moves to Ungrouped. Rejects an unknown group id. */
  setGroup(ids: readonly string[], group: string | null): Promise<ScratchSnapshot>
  createGroup(name: string): Promise<{ snapshot: ScratchSnapshot; group: ScratchGroup }>
  /** Takes "File missing" items out of the state. Items whose file exists are left alone. State only. */
  removeMissing(ids: readonly string[]): Promise<ScratchSnapshot>
  /** A private copy of the checked agent file, retaining its name and bytes; else null. */
  fileFor(id: string): Promise<{ path: string; name: string; kind: ScratchFileKind } | null>
  /** The item as the state holds it now (a picked slide's snapshot, for an insert), or null. */
  itemFor(id: string): Promise<ScratchStateItem | null>
  /** After an insert: when, and the title of the slide it went into. Nothing else about the item changes. */
  markInserted(id: string, slideTitle: string): Promise<ScratchSnapshot>
  markInsertedMany(records: readonly { id: string; title: string }[]): Promise<ScratchSnapshot>
}

const MAX_TITLE = 200
const MAX_DESCRIPTION = 2000
const MAX_GROUP_NAME = 80
const MAX_SLIDE_MARKDOWN = 400_000

const stampFor = (d: Date): string => d.toISOString().replace(/[:.]/g, '-')
const hex = (bytes: number): string => randomBytes(bytes).toString('hex')
const readOnlyId = (name: string): string => `sp-ro-${createHash('sha256').update(name).digest('hex').slice(0, 12)}`

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
const isoOrNull = (value: unknown): string | null => (typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null)

/** A bare file name inside the scratch folder: no separator, no dot-start, no `..`. */
function plainName(name: unknown): name is string {
  return typeof name === 'string' && name !== '' && !/[\\/\0]/.test(name) && !name.startsWith('.') && name !== STATE_FILE_NAME
}

function slideFrom(value: unknown): ScratchSlide | null {
  if (!isRecord(value)) return null
  const text = (key: string): string | null => (typeof value[key] === 'string' ? (value[key] as string) : null)
  const talkPath = text('talkPath'); const talkTitle = text('talkTitle'); const slideId = text('slideId')
  const title = text('title'); const markdown = text('markdown'); const thumbKey = text('thumbKey')
  if (talkPath === null || talkTitle === null || slideId === null || title === null || markdown === null || thumbKey === null) return null
  const slide: ScratchSlide = { talkPath, talkTitle, slideId, title, markdown, thumbKey }
  if (typeof value.talkSlug === 'string') slide.talkSlug = value.talkSlug
  if (typeof value.vaultId === 'string') slide.vaultId = value.vaultId
  return slide
}

function itemFrom(value: unknown): ScratchStateItem | null {
  if (!isRecord(value)) return null
  const { id, kind, status } = value
  if (typeof id !== 'string' || id === '') return null
  if (kind !== 'slide' && kind !== 'file') return null
  if (status !== 'active' && status !== 'kept' && status !== 'rejected') return null
  const addedAt = isoOrNull(value.addedAt)
  const batch = isRecord(value.batch) ? value.batch : null
  const batchAt = batch ? isoOrNull(batch.at) : null
  if (!addedAt || !batch || !batchAt) return null
  const source = batch.source === 'agent' ? 'agent' : batch.source === 'slide-browser' ? 'slide-browser' : null
  if (!source) return null
  const item: ScratchStateItem = {
    id, kind, addedAt, batch: { source, at: batchAt },
    group: typeof value.group === 'string' ? value.group : null, status
  }
  if (kind === 'file') {
    if (!plainName(value.file)) return null
    item.file = value.file
  } else {
    const slide = slideFrom(value.slide)
    if (!slide) return null
    item.slide = slide
  }
  // Ticket 2: where it was last inserted. Optional; an unreadable value is dropped, never the item.
  const insertedAt = isoOrNull(value.insertedAt)
  if (insertedAt) {
    item.insertedAt = insertedAt
    if (typeof value.insertedInto === 'string') item.insertedInto = value.insertedInto.slice(0, MAX_TITLE)
  }
  return item
}

interface ParsedState { state: ScratchState; problems: string[] }

/** Reads the state text. Anything unusable is reported in `problems` and dropped; the rest is kept. */
function parseState(text: string): ParsedState {
  const empty: ScratchState = { version: 1, groups: [], items: [] }
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return { state: empty, problems: ['the file is not valid JSON'] } }
  if (!isRecord(raw)) return { state: empty, problems: ['the file does not hold a state object'] }
  if (raw.version !== 1) return { state: empty, problems: [`its version is ${JSON.stringify(raw.version)}, not 1`] }
  const problems: string[] = []
  const groups: ScratchGroup[] = []
  const rawGroups = Array.isArray(raw.groups) ? raw.groups : (problems.push('its group list is missing'), [])
  for (const g of rawGroups) {
    if (isRecord(g) && typeof g.id === 'string' && g.id !== '' && typeof g.name === 'string' && g.name.trim() !== '' && !groups.some((x) => x.id === g.id)) {
      groups.push({ id: g.id, name: g.name })
    } else problems.push('a group was unreadable')
  }
  const items: ScratchStateItem[] = []
  const seenIds = new Set<string>()
  const seenFiles = new Set<string>()
  const rawItems = Array.isArray(raw.items) ? raw.items : (problems.push('its item list is missing'), [])
  for (const entry of rawItems) {
    const item = itemFrom(entry)
    if (!item || seenIds.has(item.id) || (item.file !== undefined && seenFiles.has(item.file))) { problems.push('an item was unreadable or repeated'); continue }
    seenIds.add(item.id)
    if (item.file !== undefined) seenFiles.add(item.file)
    // A group that no longer exists puts the item back in Ungrouped; that is said too.
    if (item.group !== null && !groups.some((g) => g.id === item.group)) { item.group = null; problems.push('an item named a group that is not in the list') }
    items.push(item)
  }
  return { state: { version: 1, groups, items, ...(Array.isArray(raw.order) && raw.order.every(id => typeof id === 'string') ? { order: scratchOrder(items, raw.order as string[]) } : {}), ...(raw.sort === 'manual' || raw.sort === 'newest' ? { sort: raw.sort } : {}) }, problems }
}

interface FolderFile { name: string; path: string; kind: ScratchFileKind; mtime: Date; sidecar: string | null }

function readSidecar(text: string | null): { title?: string; description?: string; sources: ScratchSource[] } {
  try {
    if (text === null) return { sources: [] }
    const raw: unknown = JSON.parse(text)
    if (!isRecord(raw)) return { sources: [] }
    const sources: ScratchSource[] = []
    if (Array.isArray(raw.sources)) {
      for (const s of raw.sources) {
        if (isRecord(s) && typeof s.url === 'string' && /^https?:\/\//i.test(s.url)) {
          sources.push({ label: typeof s.label === 'string' && s.label.trim() !== '' ? s.label.trim().slice(0, MAX_TITLE) : s.url, url: s.url })
        }
      }
    }
    const title = typeof raw.title === 'string' && raw.title.trim() !== '' ? raw.title.trim().slice(0, MAX_TITLE) : undefined
    const description = typeof raw.description === 'string' ? raw.description.trim().slice(0, MAX_DESCRIPTION) : undefined
    return { title, description, sources }
  } catch { return { sources: [] } }
}

const serialise = (state: ScratchState): string => `${JSON.stringify(state, null, 2)}\n`

/** Static extraction stays as the fallback; the rendered words (when captured) are added after it, both capped. */
export function mergedText(staticText: string, rendered: string): string {
  return rendered ? `${staticText} ${rendered}`.trim().slice(0, 2 * MAX_CONTENT_CHARS) : staticText
}

export function createScratchpadStore(talkDir: string, options: ScratchpadStoreOptions = {}, disk = createScratchpadDisk(talkDir)): ScratchpadStore {
  const now = options.now ?? ((): Date => new Date())
  const newItemId = options.newItemId ?? ((): string => `sp-${hex(6)}`)
  const newGroupId = options.newGroupId ?? ((): string => `g-${hex(4)}`)
  const folder = join(talkDir, SCRATCH_FOLDER_NAME)

  // One operation at a time.
  let queue: Promise<unknown> = Promise.resolve()
  function serial<T>(run: () => T | Promise<T>): Promise<T> {
    const next = queue.then(run, run)
    queue = next.catch(() => undefined)
    return next
  }

  /** The scratch folder itself: absent or a real folder is usable; a link (or anything else) is not, and nothing
   *  in it is read or written (a link could point anywhere). */
  function folderUsable(notices: string[]): boolean {
    let info
    try { info = lstatSync(folder) } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return true
      notices.push(`The Slide Scratchpad's folder could not be read (${error instanceof Error ? error.message : String(error)}), so the Slide Scratchpad is not available for this talk.`)
      return false
    }
    if (info.isDirectory() && !info.isSymbolicLink()) return true
    notices.push(`The Slide Scratchpad's folder is ${info.isSymbolicLink() ? 'a link' : 'not a folder'}, so the Slide Scratchpad is not available for this talk. Nothing in it was read or changed.`)
    return false
  }

  /** Reads the state file; a file that cannot be used is copied aside and its loss is described. `writable` is false
   *  when the state file must not be replaced on this load: it exists but could not be read, it is not a regular file
   *  (a link is never followed, read, copied or overwritten), or it was broken and could not be copied aside. */
  async function readState(notices: string[], scan: ScratchDiskScan): Promise<{ state: ScratchState; text: string | null; writable: boolean }> {
    const empty = (): ScratchState => ({ version: 1, groups: [], items: [] })
    const readOnly = 'The folder\'s files are shown as ungrouped items, and changes are not saved until the state file is fixed or removed.'
    if (scan.state.error) {
      notices.push(`The Slide Scratchpad's saved state could not be read (${scan.state.error}). ${readOnly}`)
      return { state: empty(), text: null, writable: false }
    }
    const text = scan.state.text
    if (text === null) return { state: empty(), text: null, writable: true }
    const parsed = parseState(text)
    if (parsed.problems.length > 0) {
      const broken = `scratchpad-state.broken-${stampFor(now())}.json`
      let kept = false
      try { await disk.backup(broken, text, scan.folder); kept = true } catch { /* say so below */ }
      const lost = parsed.state.groups.length === 0 && parsed.state.items.length === 0
        ? 'Its groups, choices and picked slides were not recovered; the folder\'s files are shown as ungrouped items.'
        : 'What could be read was kept; the rest was dropped.'
      notices.push(`The Slide Scratchpad's saved state had a problem (${[...new Set(parsed.problems)].join('; ')}). ${lost} ${kept ? `The original is kept as ${broken}.` : 'The original could not be copied aside, so it was left as it is and changes are not saved until it is fixed or removed.'}`)
      if (!kept) return { state: parsed.state, text, writable: false }
    }
    return { state: parsed.state, text, writable: true }
  }

  async function writeState(state: ScratchState, previous: string | null, folderId: ScratchFileIdentity | null): Promise<void> {
    const text = serialise(state)
    if (text !== previous) await disk.write(text, previous, folderId)
  }

  function folderFiles(scan: ScratchDiskScan): FolderFile[] {
    return scan.files.map((file) => ({ ...file, kind: FILE_KIND_BY_EXTENSION[extname(file.name).toLowerCase()], mtime: new Date(file.mtime) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Merges the folder into the state: new files become agent items stamped with this scan. */
  function merge(state: ScratchState, files: readonly FolderFile[], stableIds = false): ScratchState {
    const known = new Set(state.items.filter((i) => i.file !== undefined).map((i) => i.file))
    const fresh = files.filter((f) => !known.has(f.name))
    if (fresh.length === 0) return state
    const at = now().toISOString()
    const added: ScratchStateItem[] = fresh.map((f) => ({
      // Read-only (the state is not saved): an id made from the file name, so it names the same file on the next read.
      id: stableIds ? readOnlyId(f.name) : newItemId(), kind: 'file', addedAt: f.mtime.toISOString(), batch: { source: 'agent', at },
      group: null, status: 'active', file: f.name
    }))
    return { ...state, items: [...state.items, ...added] }
  }

  function view(state: ScratchState, files: readonly FolderFile[], notices: string[]): ScratchSnapshot {
    const byName = new Map(files.map((f) => [f.name, f]))
    const items: ScratchItem[] = state.items.map((item) => {
      if (item.kind === 'slide' && item.slide) {
        return { ...item, title: item.slide.title, description: '', sources: [], missing: false }
      }
      const name = item.file as string
      const file = byName.get(name)
      const kind = file?.kind ?? FILE_KIND_BY_EXTENSION[extname(name).toLowerCase()] ?? 'pic'
      const sidecar = file ? readSidecar(file.sidecar) : { sources: [] as ScratchSource[] }
      return {
        ...item,
        title: sidecar.title ?? titleFromFileName(name),
        description: sidecar.description ?? '',
        sources: sidecar.sources,
        fileKind: kind,
        missing: !file,
        fileUrl: file && kind !== 'html' ? options.fileUrlFor?.(file.path) : undefined,
        contentText: file ? mergedText(contentTextFor(file.path, kind), kind === 'html' ? options.renderedTextFor?.(file.path) ?? '' : '') || undefined : undefined
      }
    })
    return { groups: state.groups, items, notices, ...(state.order ? { order: scratchOrder(items, state.order) } : {}), ...(state.sort ? { sort: state.sort } : {}) }
  }

  /** The common frame of every operation: read, merge, change, write if changed, answer. A `read` (load) on a state
   *  that must not be written answers the files read-only; a change on it is refused, and nothing is written. */
  function operate<T>(mode: 'read' | 'change', change: (state: ScratchState, files: readonly FolderFile[]) => { state: ScratchState; result: T }): Promise<{ snapshot: ScratchSnapshot; result: T }> {
    return serial(async () => {
      const notices: string[] = []
      if (!folderUsable(notices)) {
        if (mode === 'change') throw new Error(notices[0])
        return { snapshot: { groups: [], items: [], notices }, result: change({ version: 1, groups: [], items: [] }, []).result }
      }
      const scan = await disk.scan(Object.keys(FILE_KIND_BY_EXTENSION))
      notices.push(...scan.notices)
      const { state: read, text, writable } = await readState(notices, scan)
      if (!writable && mode === 'change') throw new Error(`Nothing was changed. ${notices[0] ?? ''}`.trim())
      const files = folderFiles(scan)
      const merged = merge(read, files, !writable)
      const changed = change(merged, files)
      // A talk with no scratch folder and nothing in the state stays untouched on disk.
      const hasContent = changed.state.items.length > 0 || changed.state.groups.length > 0
      if (writable && (hasContent || text !== null)) {
        await writeState(changed.state, text, scan.folder)
      }
      return { snapshot: view(changed.state, files, notices), result: changed.result }
    })
  }

  /** The state as an action sees it (fileFor, itemFor): nothing from an unusable folder; a read-only state merged with
   *  the folder the way load() shows it, so the ids the panel holds still name their files. */
  async function current(): Promise<{ state: ScratchState; files: FolderFile[] }> {
    const notices: string[] = []
    if (!folderUsable(notices)) return { state: { version: 1, groups: [], items: [] }, files: [] }
    const scan = await disk.scan(Object.keys(FILE_KIND_BY_EXTENSION))
    const { state, writable } = await readState(notices, scan)
    const files = folderFiles(scan)
    return { state: writable ? state : merge(state, files, true), files }
  }

  const pickIds = (ids: readonly string[]): Set<string> => new Set(ids)

  return {
    folder,
    async load() { return (await operate('read', (state) => ({ state, result: null }))).snapshot },

    async addSlides(inputs) {
      const { snapshot, result } = await operate('change', (state) => {
        const at = now().toISOString()
        const items = [...state.items]
        let added = 0; let skipped = 0
        for (const input of inputs) {
          const slide = slideFrom(input)
          if (!slide || slide.markdown.length > MAX_SLIDE_MARKDOWN) { skipped++; continue }
          const twin = items.some((i) => i.kind === 'slide' && i.status === 'active' && i.slide?.talkPath === slide.talkPath && i.slide.slideId === slide.slideId && i.slide.markdown === slide.markdown)
          if (twin) { skipped++; continue }
          items.push({ id: newItemId(), kind: 'slide', addedAt: at, batch: { source: 'slide-browser', at }, group: null, status: 'active', slide })
          added++
        }
        return { state: added > 0 ? { ...state, items } : state, result: { added, skipped } }
      })
      return { snapshot, ...result }
    },

    async setAside(inputs) {
      // Validate everything before operating; addSlides deliberately skips invalid inputs and cannot protect a cut.
      const slides = inputs.map((input) => {
        const slide = slideFrom(input)
        if (!slide || slide.markdown.length > MAX_SLIDE_MARKDOWN || !/^#{2,6}\s/.test(slide.markdown)) throw new Error('A slide snapshot could not be saved. Nothing was set aside.')
        return slide
      })
      if (slides.length === 0) throw new Error('Choose slides to set aside.')
      return (await operate('change', (state) => {
        const at = now().toISOString()
        const name = `Set aside · ${at.slice(0, 10)}`
        const group = state.groups.find((g) => g.name === name) ?? { id: newGroupId(), name }
        const items = [...state.items]
        for (const slide of slides) {
          items.push({ id: newItemId(), kind: 'slide', addedAt: at, batch: { source: 'slide-browser', at }, group: group.id, status: 'active', slide })
        }
        return { state: { ...state, groups: state.groups.some((g) => g.id === group.id) ? state.groups : [...state.groups, group], items }, result: null }
      })).snapshot
    },

    async setStatus(ids, status) {
      if (status !== 'active' && status !== 'kept' && status !== 'rejected') throw new Error('Unknown status')
      const pick = pickIds(ids)
      return (await operate('change', (state) => ({
        state: { ...state, items: state.items.map((i) => (pick.has(i.id) && i.status !== status ? { ...i, status } : i)) }, result: null
      }))).snapshot
    },

    async setGroup(ids, group) {
      const pick = pickIds(ids)
      return (await operate('change', (state) => {
        if (group !== null && !state.groups.some((g) => g.id === group)) throw new Error('That group is not in the Slide Scratchpad any more.')
        return { state: { ...state, items: state.items.map((i) => (pick.has(i.id) && i.group !== group ? { ...i, group } : i)) }, result: null }
      })).snapshot
    },

    async createGroup(name) {
      const clean = String(name).replace(/\s+/g, ' ').trim().slice(0, MAX_GROUP_NAME)
      if (clean === '') throw new Error('A group needs a name.')
      const { snapshot, result } = await operate('change', (state) => {
        const twin = state.groups.find((g) => g.name.toLowerCase() === clean.toLowerCase())
        if (twin) return { state, result: twin }
        const group = { id: newGroupId(), name: clean }
        return { state: { ...state, groups: [...state.groups, group] }, result: group }
      })
      return { snapshot, group: result }
    },

    async removeMissing(ids) {
      const pick = pickIds(ids)
      return (await operate('change', (state, files) => {
        const present = new Set(files.map((f) => f.name))
        return { state: { ...state, items: state.items.filter((i) => !(pick.has(i.id) && i.kind === 'file' && !present.has(i.file as string))) }, result: null }
      })).snapshot
    },

    async fileFor(id) {
      return serial(async () => {
        const { state, files } = await current()
        const item = state.items.find((i) => i.id === id)
        if (!item || item.kind !== 'file') return null
        const file = files.find((f) => f.name === item.file)
        if (!file) return null
        return { path: file.path, name: file.name, kind: file.kind }
      })
    },

    async itemFor(id) {
      return serial(async () => (await current()).state.items.find((i) => i.id === id) ?? null)
    },

    async setSort(sort) {
      if (sort !== 'newest' && sort !== 'manual') throw new Error('Choose a sort order.')
      return (await operate('change', state => ({ state: { ...state, sort, order: scratchOrder(state.items, state.order ?? [...state.items].sort(newestFirst).map(item => item.id)) }, result: null }))).snapshot
    },

    async reorder(visible, next) {
      if (!visible.length || new Set(visible).size !== visible.length || next.length !== visible.length || new Set(next).size !== next.length || next.some(id => !visible.includes(id))) throw new Error('The selection is invalid.')
      return (await operate('change', state => {
        const base = state.sort === 'manual' ? scratchOrder(state.items, state.order) : [...state.items].sort(newestFirst).map(item => item.id)
        const selected = new Set(visible)
        if (base.filter(id => selected.has(id)).join('\0') !== visible.join('\0')) throw new Error('The Scratchpad order changed. Try the move again.')
        let at = 0
        const order = base.map(id => selected.has(id) ? next[at++] : id)
        return { state: { ...state, sort: 'manual', order }, result: null }
      })).snapshot
    },

    async markInsertedMany(records) {
      return (await operate('change', state => {
        if (!records.length || records.some(record => !state.items.some(item => item.id === record.id))) throw new Error('An item is not in the Slide Scratchpad any more.')
        const titles = new Map(records.map(record => [record.id, record.title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE)]))
        const at = now().toISOString()
        return { state: { ...state, items: state.items.map(item => titles.has(item.id) ? { ...item, insertedAt: at, insertedInto: titles.get(item.id) } : item) }, result: null }
      })).snapshot
    },

    async markInserted(id, slideTitle) {
      const title = String(slideTitle ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE)
      return (await operate('change', (state) => {
        if (!state.items.some((i) => i.id === id)) throw new Error('That item is not in the Slide Scratchpad any more.')
        const at = now().toISOString()
        return { state: { ...state, items: state.items.map((i) => (i.id === id ? { ...i, insertedAt: at, insertedInto: title } : i)) }, result: null }
      })).snapshot
    }
  }
}
