// The Slide Scratchpad's IPC surface (window.tw.scratchpad, src/preload/index.ts). The renderer names no
// path: the talk is the one the sending window has open. One store per talk folder, so every window on it
// shares one queue. A window that subscribes gets `scratchpad:changed` with the whole snapshot whenever the
// scratch folder changes (debounced watch) or any window changes the state.
import { dirname } from 'node:path'
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import { createScratchpadStore, type ScratchpadStore, type ScratchpadStoreOptions } from './scratchpad-store.ts'
import { watchScratchFolder, type ScratchpadWatch } from './scratchpad-watch.ts'
import type { ScratchHtmlPreview } from './scratchpad-html.ts'
import { slideVisualFile, type VisualRequest } from './scratchpad-visual-import.ts'
import { scratchVisuals, visualNeedsCopy } from '../shared/scratchpad-insert.ts'
import type { ScratchPreparedInsert, ScratchReply, ScratchSlide, ScratchSlideInput, ScratchSnapshot, ScratchStatus, ScratchVisualImport } from '../shared/scratchpad.ts'

export interface ScratchpadIpcDeps {
  ipc: Pick<IpcMain, 'handle'>
  /** The outline path the sending window has open, or null. */
  outlinePathFor: (event: IpcMainInvokeEvent) => string | null
  storeOptions?: ScratchpadStoreOptions
  htmlPreview: (path: string) => Promise<ScratchHtmlPreview | { error: string }>
  /** A PNG data address of the page's thumbnail (captured once, cached), or null when there is none. */
  htmlThumb?: (path: string) => Promise<string | null>
  /** The words that page rendered, from the capture cache ('' until captured). When a thumbnail request makes them
   *  appear, every window on the talk gets a fresh snapshot so search can find them. */
  htmlText?: (path: string) => string
  /** Shows the folder in the file manager (creating it when absent); never runs under tests. */
  revealFolder: (folder: string) => void
  debounceMs?: number
  /** Insert visual only (ticket 2): copies a file into the open talk's vault and answers the line to insert
   *  (scratchpad-visual-import.ts). Never writes the outline; never writes the file it copies from. */
  importVisual?: (request: VisualRequest) => Promise<ScratchVisualImport>
  /** A picked slide's source talk (slideSourceOutline over the vault roots) and the root of the open vault that
   *  holds it (null when no open vault does); null when the talk cannot be named. */
  slideSource?: (slide: ScratchSlide, outlinePath: string) => { outlinePath: string; root: string | null } | null
}

const MAX_IDS = 5000
const NO_TALK = 'Open a talk first.'

const strings = (value: unknown): string[] | null =>
  Array.isArray(value) && value.length <= MAX_IDS && value.every((v) => typeof v === 'string') ? (value as string[]) : null

export function registerScratchpadIpc(deps: ScratchpadIpcDeps): { closeAll(): void } {
  const stores = new Map<string, ScratchpadStore>()
  const storeFor = (talkDir: string): ScratchpadStore => {
    let store = stores.get(talkDir)
    if (!store) { store = createScratchpadStore(talkDir, deps.storeOptions); stores.set(talkDir, store) }
    return store
  }
  const subscriptions = new Map<number, { talkDir: string; watch: ScratchpadWatch; sender: WebContents }>()
  /** Windows whose 'destroyed' already ends their subscription. */
  const hooked = new Set<number>()
  const talkDirOf = (event: IpcMainInvokeEvent): string | null => {
    const outline = deps.outlinePathFor(event)
    return outline ? dirname(outline) : null
  }
  const failure = (error: unknown): { ok: false; error: string } => ({ ok: false, error: error instanceof Error ? error.message : String(error) })

  /** Pushes a fresh snapshot to every window subscribed to this talk. */
  const publish = (talkDir: string, snapshot: ScratchSnapshot): void => {
    for (const sub of subscriptions.values()) {
      if (sub.talkDir === talkDir && !sub.sender.isDestroyed()) sub.sender.send('scratchpad:changed', snapshot)
    }
  }
  const unsubscribe = (id: number): void => {
    subscriptions.get(id)?.watch.close()
    subscriptions.delete(id)
  }

  const withTalk = async <T extends object>(event: IpcMainInvokeEvent, run: (store: ScratchpadStore, talkDir: string) => Promise<T>): Promise<ScratchReply<T>> => {
    const talkDir = talkDirOf(event)
    if (!talkDir) return { ok: false, error: NO_TALK }
    try { return { ok: true, ...(await run(storeFor(talkDir), talkDir)) } } catch (error) { return failure(error) }
  }
  /** A change made through this surface: apply it, then tell every window on the talk. */
  const change = (event: IpcMainInvokeEvent, run: (store: ScratchpadStore) => Promise<ScratchSnapshot>): Promise<ScratchReply<{ snapshot: ScratchSnapshot }>> =>
    withTalk(event, async (store, talkDir) => {
      const snapshot = await run(store)
      publish(talkDir, snapshot)
      return { snapshot }
    })

  deps.ipc.handle('scratchpad:subscribe', (event) => withTalk(event, async (store, talkDir) => {
    const sender = event.sender
    unsubscribe(sender.id)
    const watch = watchScratchFolder(talkDir, () => {
      void store.load().then((snapshot) => publish(talkDir, snapshot), () => undefined)
    }, deps.debounceMs)
    subscriptions.set(sender.id, { talkDir, watch, sender })
    // One 'destroyed' listener per window, however often it subscribes again (each talk switch does).
    if (!hooked.has(sender.id)) {
      const id = sender.id
      hooked.add(id)
      sender.once('destroyed', () => { hooked.delete(id); unsubscribe(id) })
    }
    return { snapshot: await store.load() }
  }))
  deps.ipc.handle('scratchpad:unsubscribe', (event) => { unsubscribe(event.sender.id); return { ok: true } })
  deps.ipc.handle('scratchpad:load', (event) => withTalk(event, async (store) => ({ snapshot: await store.load() })))

  deps.ipc.handle('scratchpad:add-slides', async (event, inputs: unknown) => {
    if (!Array.isArray(inputs) || inputs.length > MAX_IDS) return { ok: false, error: 'Choose slides to add.' }
    return withTalk(event, async (store, talkDir) => {
      const result = await store.addSlides(inputs as ScratchSlideInput[])
      publish(talkDir, result.snapshot)
      return result
    })
  })
  deps.ipc.handle('scratchpad:set-aside', (event, inputs: unknown, expectedOutline: unknown) => {
    // Identity guard only: the store still comes exclusively from the sending window's open talk.
    if (typeof expectedOutline !== 'string' || deps.outlinePathFor(event) !== expectedOutline) return { ok: false, error: 'The open talk changed. Nothing was set aside.' }
    if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > MAX_IDS) return { ok: false, error: 'Choose slides to set aside.' }
    return change(event, (store) => store.setAside(inputs as ScratchSlideInput[]))
  })
  deps.ipc.handle('scratchpad:set-sort', (event, sort: unknown, expectedOutline: unknown) => {
    if (expectedOutline !== deps.outlinePathFor(event) || (sort !== 'newest' && sort !== 'manual')) return { ok: false, error: 'The talk or sort order changed.' }
    return change(event, store => store.setSort(sort))
  })
  deps.ipc.handle('scratchpad:reorder', (event, visible: unknown, next: unknown, expectedOutline: unknown) => {
    const before = strings(visible); const after = strings(next)
    if (expectedOutline !== deps.outlinePathFor(event) || !before || !after) return { ok: false, error: 'The talk or selection changed.' }
    return change(event, store => store.reorder(before, after))
  })
  deps.ipc.handle('scratchpad:set-status', (event, ids: unknown, status: unknown) => {
    const list = strings(ids)
    if (!list || (status !== 'active' && status !== 'kept' && status !== 'rejected')) return { ok: false, error: 'Choose items and a status.' }
    return change(event, (store) => store.setStatus(list, status as ScratchStatus))
  })
  deps.ipc.handle('scratchpad:set-group', (event, ids: unknown, group: unknown) => {
    const list = strings(ids)
    if (!list || !(group === null || typeof group === 'string')) return { ok: false, error: 'Choose items and a group.' }
    return change(event, (store) => store.setGroup(list, group))
  })
  deps.ipc.handle('scratchpad:create-group', (event, name: unknown) => {
    if (typeof name !== 'string') return { ok: false, error: 'A group needs a name.' }
    return withTalk(event, async (store, talkDir) => {
      const result = await store.createGroup(name)
      publish(talkDir, result.snapshot)
      return result
    })
  })
  deps.ipc.handle('scratchpad:remove-missing', (event, ids: unknown) => {
    const list = strings(ids)
    if (!list) return { ok: false, error: 'Choose items.' }
    return change(event, (store) => store.removeMissing(list))
  })
  deps.ipc.handle('scratchpad:html-preview', (event, id: unknown) => {
    if (typeof id !== 'string') return { ok: false, error: 'Choose an item.' }
    return withTalk(event, async (store) => {
      const file = await store.fileFor(id)
      if (!file || file.kind !== 'html') throw new Error('This item has no page to preview.')
      const preview = await deps.htmlPreview(file.path)
      if ('error' in preview) throw new Error(preview.error)
      return preview
    })
  })
  deps.ipc.handle('scratchpad:html-thumb', (event, id: unknown) => {
    if (typeof id !== 'string') return { ok: false, error: 'Choose an item.' }
    return withTalk(event, async (store, talkDir) => {
      const file = await store.fileFor(id)
      if (!file || file.kind !== 'html' || !deps.htmlThumb) return { url: null as string | null }
      const had = Boolean(deps.htmlText?.(file.path))
      const url = await deps.htmlThumb(file.path)
      if (!had && deps.htmlText?.(file.path)) publish(talkDir, await store.load())
      return { url }
    })
  })
  // ── Inserting (ticket 2). Main copies files and names lines; the renderer writes the outline, through the
  // editor, only when the person clicked an Insert button. Nothing here reads or writes the outline. ──────────
  const outlineOf = (event: IpcMainInvokeEvent): string => deps.outlinePathFor(event) as string
  const slideItem = async (store: ScratchpadStore, id: unknown): Promise<ScratchSlide> => {
    const item = typeof id === 'string' ? await store.itemFor(id) : null
    if (!item || item.kind !== 'slide' || !item.slide) throw new Error('That slide is not in the Slide Scratchpad any more.')
    return item.slide
  }
  const visualReply = (reply: ScratchVisualImport): { line: string; page?: NonNullable<Extract<ScratchVisualImport, { ok: true }>['page']> } => {
    if (!reply.ok) throw new Error(reply.error)
    return reply.page ? { line: reply.line, page: reply.page } : { line: reply.line }
  }
  deps.ipc.handle('scratchpad:import-visual', (event, id: unknown) => {
    if (typeof id !== 'string') return { ok: false, error: 'Choose an item.' }
    return withTalk(event, async (store) => {
      if (!deps.importVisual) throw new Error('Inserting is not available.')
      const file = await store.fileFor(id)
      if (!file) throw new Error('The file is not in the scratch folder any more, so nothing was inserted.')
      return visualReply(await deps.importVisual({ kind: file.kind, path: file.path, outlinePath: outlineOf(event), from: `${store.folder.split(/[\\/]/).slice(-2).join('/')}/${file.name}` }))
    })
  })
  deps.ipc.handle('scratchpad:slide-source', (event, id: unknown) => withTalk(event, async (store) => {
    const slide = await slideItem(store, id)
    const source = deps.slideSource?.(slide, outlineOf(event)) ?? null
    if (!source) throw new Error(`The talk “${slide.talkTitle}” this slide came from cannot be found, so nothing was inserted.`)
    return { outlinePath: source.outlinePath }
  }))
  deps.ipc.handle('scratchpad:import-slide-visual', (event, id: unknown, ref: unknown) => {
    if (typeof ref !== 'string') return { ok: false, error: 'Choose a visual.' }
    return withTalk(event, async (store) => {
      if (!deps.importVisual) throw new Error('Inserting is not available.')
      const slide = await slideItem(store, id)
      // Only a file the snapshot itself names: the renderer cannot name any other.
      const visual = scratchVisuals(slide.markdown).find((v) => v.ref === ref && visualNeedsCopy(v))
      if (!visual) throw new Error('That visual is not on the slide.')
      const source = deps.slideSource?.(slide, outlineOf(event)) ?? null
      const file = source?.root ? slideVisualFile(source.outlinePath, visual.ref, source.root) : null
      if (!file) throw new Error(`The file ${visual.label} could not be found in the talk “${slide.talkTitle}”, so nothing was inserted.`)
      return visualReply(await deps.importVisual({ kind: visual.kind === 'page' ? 'html' : 'svg', path: file, outlinePath: outlineOf(event), from: `${slide.talkTitle}: ${visual.ref}` }))
    })
  })
  deps.ipc.handle('scratchpad:prepare-insert', (event, ids: unknown, expectedOutline: unknown) => {
    const list = strings(ids)
    const outline = deps.outlinePathFor(event)
    if (!outline || expectedOutline !== outline || !list?.length || new Set(list).size !== list.length) return { ok: false, error: 'The talk or selection changed. Nothing was inserted.' }
    return withTalk(event, async store => {
      const check = (): void => { if (deps.outlinePathFor(event) !== outline) throw new Error('The talk changed while preparing the selection. Nothing was inserted.') }
      const snapshot = await store.load(); check()
      const items = list.map(id => snapshot.items.find(item => item.id === id))
      if (items.some(item => !item || item.missing || item.status !== 'active')) throw new Error('An item is no longer available. Nothing was inserted.')
      const entries: ScratchPreparedInsert[] = []
      for (const candidate of items) {
        const item = candidate!; check()
        if (item.kind === 'slide' && item.slide) {
          const source = deps.slideSource?.(item.slide, outline)
          if (!source) throw new Error(`The source talk for “${item.title}” is unavailable. Nothing was inserted.`)
          entries.push({ id: item.id, title: item.title, markdown: item.slide.markdown, sourceOutlinePath: source.outlinePath })
        } else {
          if (!deps.importVisual) throw new Error('Inserting is not available.')
          const file = await store.fileFor(item.id); check()
          if (!file) throw new Error(`The file for “${item.title}” is unavailable. Nothing was inserted.`)
          const imported = await deps.importVisual({ kind: file.kind, path: file.path, outlinePath: outline, from: `${store.folder.split(/[\\/]/).slice(-2).join('/')}/${file.name}` }); check()
          const visual = visualReply(imported)
          entries.push({ id: item.id, title: item.title, line: visual.line })
        }
      }
      check(); return { entries }
    })
  })
  deps.ipc.handle('scratchpad:mark-inserted-many', (event, records: unknown, expectedOutline: unknown) => {
    if (expectedOutline !== deps.outlinePathFor(event) || !Array.isArray(records) || !records.length || records.length > MAX_IDS || records.some(r => !r || typeof r.id !== 'string' || typeof r.title !== 'string') || new Set(records.map(r => r.id)).size !== records.length) return { ok: false, error: 'The talk or insertion records changed.' }
    return change(event, store => store.markInsertedMany(records))
  })
  deps.ipc.handle('scratchpad:mark-inserted', (event, id: unknown, slideTitle: unknown) => {
    if (typeof id !== 'string' || typeof slideTitle !== 'string') return { ok: false, error: 'Choose an item.' }
    return change(event, (store) => store.markInserted(id, slideTitle))
  })

  deps.ipc.handle('scratchpad:reveal-folder', (event) => withTalk(event, async (store) => { deps.revealFolder(store.folder); return {} }))

  return { closeAll() { for (const id of [...subscriptions.keys()]) unsubscribe(id) } }
}
