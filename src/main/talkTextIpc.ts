import { ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { existsSync, mkdirSync, readFileSync, watch } from 'fs'
import { join } from 'path'
import {
  buildTalkTextModel,
  exportText,
  renderNotesMarkdown,
  renderScriptMarkdown,
  type TalkTextModel,
  type TalkTextSegment
} from './talkText'
import { slideImageRefs, toTalkTextRows, type AdapterRow } from './talkTextAdapter'
import {
  approveCleaned,
  approvePart,
  approvedCleanedInOrder,
  approvedPartsInOrder,
  createCleanedMoveUndoStore,
  discardCleanedDraft,
  discardPartDraft,
  listCleanedDrafts,
  listParts,
  moveCleanedDrafts,
  readCleanedStore,
  readNotesStore,
  resolveCleanTemplate,
  resolveInstructionsDir,
  unapproveCleaned,
  unapprovePart,
  writeCleanedDraft,
  writeCleanedStore,
  writeCleanPack,
  writeNotesStore,
  writeRewritePack,
  type CleanedSlide,
  type CleanedStore,
  type NotesPart,
  type NotesStore
} from './rewritePack'
import { readRun } from './runs'
import { assertPathInsideVault, resolveTalkTextPaths, type TalkTextPaths } from './talkTextPathSafety'
import { isToolsWindowSender } from './talkTextSender'
import { createDirectoryWatcherRegistry } from './talkTextWatchers'

type TalkInfo = { slug: string; title: string; outlinePath: string }
export type TalkTextExportOptions = {
  mode: 'notes' | 'script'
  treatment: 'raw' | 'cleaned'
  format: 'markdown' | 'plain' | 'rich'
  timecodes?: boolean
  references?: boolean
}
export type CleanMode = 'section' | 'onepass' | 'perslide'
export type CleanPrepareOptions = { mode: CleanMode; slides?: number[] }

const CLEAN_MODE_INSTRUCTIONS: Record<Exclude<CleanMode, 'perslide'>, string> = {
  section: 'Work **section by section**. Clean only the slides of the FIRST section that still has no file in `cleaned/`, write those `cleaned/slide-N.md` files, then STOP and wait for approval before continuing. On the next run, do the next unfinished section.',
  onepass: 'Work in **one pass**. Clean EVERY slide in order, write all `cleaned/slide-N.md` files, then stop.'
}

const BAD_SENDER = { ok: false as const, error: 'bad-sender' as const }

export interface TalkTextIpcDeps {
  vaultRoot: () => string | null
  listTalks: (root: string) => Promise<TalkInfo[]>
  compile: (outlinePath: string, content: string) => Promise<Array<Record<string, unknown>> | null>
  readSidecar: (id: string) => { alt?: string; caption?: string } | null
  resources: () => { resourcesPath?: string; devRoot?: string }
  toolsWindow: () => BrowserWindow | null
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export interface TalkTextIpcController {
  releaseAllWatchers: () => void
}

export function registerTalkTextIpc(deps: TalkTextIpcDeps): TalkTextIpcController {
  const watchers = createDirectoryWatcherRegistry((directory, onChange) => watch(directory, onChange))
  const moveUndo = createCleanedMoveUndoStore()
  const watcherOwner = (talkSlug: string, sessionId: string): string => `${talkSlug}\u0000${sessionId}`
  const isToolsSender = (event: IpcMainInvokeEvent): boolean => {
    return isToolsWindowSender(event.sender, deps.toolsWindow())
  }

  const talkAndPaths = async (vault: string, talkSlug: unknown, sessionId: unknown): Promise<{
    talk: TalkInfo
    paths: TalkTextPaths
  }> => {
    const paths = resolveTalkTextPaths(vault, talkSlug, sessionId)
    const talk = (await deps.listTalks(vault)).find((candidate) => candidate.slug === talkSlug)
    if (!talk) throw new Error('talk-not-found')
    return { talk, paths }
  }

  const pathsFor = async (vault: string, talkSlug: unknown, sessionId: unknown): Promise<TalkTextPaths> => (
    (await talkAndPaths(vault, talkSlug, sessionId)).paths
  )

  const notesStore = (path: string): NotesStore => readNotesStore(path)
  const cleanedStore = (path: string): CleanedStore => readCleanedStore(path)

  const assembleModel = async (talkSlug: string, sessionId: string): Promise<TalkTextModel | null> => {
    const vault = deps.vaultRoot()
    if (!vault) return null

    const { talk, paths } = await talkAndPaths(vault, talkSlug, sessionId)
    const content = readFileSync(talk.outlinePath, 'utf8')
    const projectionRows = await deps.compile(talk.outlinePath, content)
    if (!projectionRows) return null

    const run = readRun(vault, talkSlug, sessionId)
    if (!run) return null

    let segments: TalkTextSegment[] = []
    try {
      const transcriptPath = assertPathInsideVault(vault, join(paths.presentationDir, `${sessionId}.transcript.json`))
      const transcript = JSON.parse(readFileSync(transcriptPath, 'utf8')) as { segments?: unknown }
      if (Array.isArray(transcript.segments)) segments = transcript.segments as TalkTextSegment[]
    } catch {
      segments = []
    }

    const adapterRows = projectionRows as AdapterRow[]
    const imageIds = new Set<string>()
    for (const row of adapterRows) {
      for (const image of slideImageRefs(row.source_markdown ?? '')) imageIds.add(image.id)
    }
    const sidecars = new Map([...imageIds].map((id) => [id, deps.readSidecar(id) ?? {}]))
    const rows = toTalkTextRows(content, adapterRows, sidecars)

    return buildTalkTextModel({
      rows,
      slideTimeIndex: run.slideTimeIndex,
      segments,
      trims: run.trims,
      meta: {
        talkSlug,
        talkTitle: run.talkTitle,
        event: run.context ?? undefined,
        date: run.startedAt ? run.startedAt.slice(0, 10) : undefined,
        recordedMs: run.recordingMs
      }
    })
  }

  const startPartsWatcher = (talkSlug: string, sessionId: string, partsDir: string): void => {
    try {
      mkdirSync(partsDir, { recursive: true })
      watchers.acquire(partsDir, watcherOwner(talkSlug, sessionId), () => {
        const win = deps.toolsWindow()
        if (win && !win.isDestroyed()) {
          win.webContents.send('talktext:parts-changed', { talkSlug, sessionId })
        }
      })
    } catch {
      /* parts watching is best-effort */
    }
  }

  const startCleanedWatcher = (talkSlug: string, sessionId: string, cleanedDir: string): void => {
    try {
      mkdirSync(cleanedDir, { recursive: true })
      watchers.acquire(cleanedDir, watcherOwner(talkSlug, sessionId), () => {
        const win = deps.toolsWindow()
        if (win && !win.isDestroyed()) {
          win.webContents.send('talktext:cleaned-changed', { talkSlug, sessionId })
        }
      })
    } catch {
      /* cleaned-slide watching is best-effort */
    }
  }

  const preparePack = async (talkSlug: string, sessionId: string): Promise<string | null> => {
    const vault = deps.vaultRoot()
    if (!vault) return null
    const model = await assembleModel(talkSlug, sessionId)
    if (!model) return null

    const resources = deps.resources()
    const promptTemplatePath = resources.resourcesPath
      ? join(resources.resourcesPath, 'agent-rewrite', 'PROMPT.template.md')
      : join(resources.devRoot ?? process.cwd(), 'resources', 'agent-rewrite', 'PROMPT.template.md')
    const promptTemplate = readFileSync(promptTemplatePath, 'utf8')
    const { packDir, partsDir } = await pathsFor(vault, talkSlug, sessionId)
    writeRewritePack({
      packDir,
      model,
      promptTemplate,
      instructionsDir: resolveInstructionsDir(resources)
    })
    startPartsWatcher(talkSlug, sessionId, partsDir)
    return packDir
  }

  const ensurePack = async (talkSlug: string, sessionId: string): Promise<string | null> => {
    const vault = deps.vaultRoot()
    if (!vault) return null
    const { packDir, partsDir } = await pathsFor(vault, talkSlug, sessionId)
    if (!existsSync(join(packDir, 'PROMPT.md'))) return preparePack(talkSlug, sessionId)
    startPartsWatcher(talkSlug, sessionId, partsDir)
    return packDir
  }

  const prepareCleanPack = async (
    talkSlug: string,
    sessionId: string,
    options: CleanPrepareOptions
  ): Promise<string | null> => {
    const vault = deps.vaultRoot()
    if (!vault) return null
    const model = await assembleModel(talkSlug, sessionId)
    if (!model) return null

    let modeInstructions: string
    if (options.mode === 'perslide') {
      const slides = [...new Set(options.slides ?? [])]
        .filter((slide) => Number.isInteger(slide) && slide > 0 && model.slides.some((item) => item.slideNumber === slide))
        .sort((a, b) => a - b)
      if (slides.length === 0) throw new Error('clean-slides-required')
      modeInstructions = `Clean ONLY these slides: ${slides.join(', ')}. Write their \`cleaned/slide-N.md\` files and stop.`
    } else if (options.mode === 'section' || options.mode === 'onepass') {
      modeInstructions = CLEAN_MODE_INSTRUCTIONS[options.mode]
    } else {
      throw new Error('clean-mode-invalid')
    }

    const resources = deps.resources()
    const cleanTemplate = readFileSync(resolveCleanTemplate(resources), 'utf8')
    const { packDir, cleanedDir } = await pathsFor(vault, talkSlug, sessionId)
    writeCleanPack({
      packDir,
      model,
      cleanTemplate,
      instructionsDir: resolveInstructionsDir(resources),
      modeInstructions
    })
    startCleanedWatcher(talkSlug, sessionId, cleanedDir)
    return cleanedDir
  }

  ipcMain.handle('talktext:model', async (event, talkSlug: string, sessionId: string) => {
    if (!isToolsSender(event)) return BAD_SENDER
    try {
      const vault = deps.vaultRoot()
      if (!vault) return null
      resolveTalkTextPaths(vault, talkSlug, sessionId)
      watchers.releaseAllExcept(watcherOwner(talkSlug, sessionId))
      moveUndo.releaseAllExcept(watcherOwner(talkSlug, sessionId))
      return await assembleModel(talkSlug, sessionId)
    } catch {
      return null
    }
  })

  ipcMain.handle('talktext:export', async (
    event,
    talkSlug: string,
    sessionId: string,
    options: TalkTextExportOptions
  ) => {
    if (!isToolsSender(event)) return BAD_SENDER
    try {
      const model = await assembleModel(talkSlug, sessionId)
      if (!model) return null
      const vault = deps.vaultRoot()
      if (!vault) return null
      const markdown = options.mode === 'script'
        ? renderScriptMarkdown(model, {
            cleanedBySlide: options.treatment === 'cleaned'
              ? new Map(approvedCleanedInOrder(cleanedStore((await pathsFor(vault, talkSlug, sessionId)).cleanStorePath))
                .map((slide) => [slide.slideNumber, slide.markdown]))
              : undefined,
            timecodes: options.timecodes
          })
        : renderNotesMarkdown(
            model,
            approvedPartsInOrder(notesStore((await pathsFor(vault, talkSlug, sessionId)).notesStorePath)),
            { references: options.references }
          )
      return exportText(markdown, options.format)
    } catch {
      return null
    }
  })

  ipcMain.handle('rewrite:prepare-pack', async (event, talkSlug: string, sessionId: string) => {
    if (!isToolsSender(event)) return BAD_SENDER
    try {
      const packDir = await preparePack(talkSlug, sessionId)
      return packDir ? { ok: true, packDir } : { ok: false, error: 'talk-text-model-unavailable' }
    } catch (cause) {
      return { ok: false, error: errorMessage(cause) }
    }
  })

  ipcMain.handle('rewrite:list-parts', async (event, talkSlug: string, sessionId: string) => {
    if (!isToolsSender(event)) return BAD_SENDER
    try {
      const vault = deps.vaultRoot()
      return vault ? listParts((await pathsFor(vault, talkSlug, sessionId)).partsDir) : []
    } catch {
      return []
    }
  })

  ipcMain.handle('rewrite:notes', async (event, talkSlug: string, sessionId: string) => {
    if (!isToolsSender(event)) return BAD_SENDER
    try {
      const vault = deps.vaultRoot()
      if (!vault) return null
      const model = await assembleModel(talkSlug, sessionId)
      if (!model) return null
      const parts = approvedPartsInOrder(notesStore((await pathsFor(vault, talkSlug, sessionId)).notesStorePath))
      return { parts, markdown: renderNotesMarkdown(model, parts) }
    } catch {
      return null
    }
  })

  ipcMain.handle('rewrite:approve-part', async (event, talkSlug: string, sessionId: string, slug: string) => {
    if (!isToolsSender(event)) return BAD_SENDER
    try {
      const vault = deps.vaultRoot()
      if (!vault) return { ok: false, error: 'no-vault' }
      const { partsDir, notesStorePath } = await pathsFor(vault, talkSlug, sessionId)
      const draft = listParts(partsDir).find((candidate) => candidate.slug === slug)
      if (!draft) return { ok: false, error: 'part-not-found' }
      const part: NotesPart = {
        slug: draft.slug,
        order: draft.order,
        markdown: draft.markdown,
        approvedAt: new Date().toISOString()
      }
      writeNotesStore(notesStorePath, approvePart(notesStore(notesStorePath), part))
      return { ok: true }
    } catch (cause) {
      return { ok: false, error: errorMessage(cause) }
    }
  })

  ipcMain.handle('rewrite:unapprove-part', async (event, talkSlug: string, sessionId: string, slug: string) => {
    if (!isToolsSender(event)) return BAD_SENDER
    try {
      const vault = deps.vaultRoot()
      if (!vault) return { ok: false }
      const { notesStorePath } = await pathsFor(vault, talkSlug, sessionId)
      writeNotesStore(notesStorePath, unapprovePart(notesStore(notesStorePath), slug))
      return { ok: true }
    } catch {
      return { ok: false }
    }
  })

  ipcMain.handle('rewrite:open-part', async (event, talkSlug: string, sessionId: string, slug: string) => {
    if (!isToolsSender(event)) return BAD_SENDER
    try {
      const vault = deps.vaultRoot()
      if (!vault) return false
      const { partsDir } = await pathsFor(vault, talkSlug, sessionId)
      const part = listParts(partsDir).find((candidate) => candidate.slug === slug)
      if (!part) return false
      return (await shell.openPath(assertPathInsideVault(vault, join(partsDir, part.fileName)))) === ''
    } catch {
      return false
    }
  })

  ipcMain.handle('rewrite:discard-part', async (event, talkSlug: string, sessionId: string, slug: string) => {
    if (!isToolsSender(event)) return BAD_SENDER
    try {
      const vault = deps.vaultRoot()
      if (!vault) return { ok: false }
      const { partsDir, notesStorePath } = await pathsFor(vault, talkSlug, sessionId)
      const part = listParts(partsDir).find((candidate) => candidate.slug === slug)
      if (!part) return { ok: false }
      discardPartDraft(assertPathInsideVault(vault, join(partsDir, part.fileName)), notesStorePath, slug)
      return { ok: true }
    } catch {
      return { ok: false }
    }
  })

  ipcMain.handle('rewrite:reveal-folder', async (event, talkSlug: string, sessionId: string) => {
    if (!isToolsSender(event)) return BAD_SENDER
    try {
      const packDir = await ensurePack(talkSlug, sessionId)
      if (!packDir) return false
      shell.showItemInFolder(packDir)
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('rewrite:copy-prompt', async (event, talkSlug: string, sessionId: string) => {
    if (!isToolsSender(event)) return BAD_SENDER
    try {
      const packDir = await ensurePack(talkSlug, sessionId)
      return packDir ? readFileSync(join(packDir, 'PROMPT.md'), 'utf8') : null
    } catch {
      return null
    }
  })

  ipcMain.handle('clean:prepare', async (
    event,
    talkSlug: string,
    sessionId: string,
    options: CleanPrepareOptions
  ) => {
    if (!isToolsSender(event)) return BAD_SENDER
    try {
      const cleanedDir = await prepareCleanPack(talkSlug, sessionId, options)
      return cleanedDir ? { ok: true, cleanedDir } : { ok: false, error: 'talk-text-model-unavailable' }
    } catch (cause) {
      return { ok: false, error: errorMessage(cause) }
    }
  })

  ipcMain.handle('clean:list', async (event, talkSlug: string, sessionId: string) => {
    if (!isToolsSender(event)) return BAD_SENDER
    try {
      const vault = deps.vaultRoot()
      if (!vault) return []
      const { cleanedDir, cleanStorePath } = await pathsFor(vault, talkSlug, sessionId)
      const merged = new Map<number, { slideNumber: number; markdown: string; approved: boolean }>()
      for (const draft of listCleanedDrafts(cleanedDir)) {
        merged.set(draft.slideNumber, { slideNumber: draft.slideNumber, markdown: draft.markdown, approved: false })
      }
      for (const approved of approvedCleanedInOrder(cleanedStore(cleanStorePath))) {
        merged.set(approved.slideNumber, { slideNumber: approved.slideNumber, markdown: approved.markdown, approved: true })
      }
      startCleanedWatcher(talkSlug, sessionId, cleanedDir)
      return [...merged.values()].sort((a, b) => a.slideNumber - b.slideNumber)
    } catch {
      return []
    }
  })

  ipcMain.handle('clean:approve', async (event, talkSlug: string, sessionId: string, slideNumber: number) => {
    if (!isToolsSender(event)) return BAD_SENDER
    try {
      const vault = deps.vaultRoot()
      if (!vault) return { ok: false, error: 'no-vault' }
      const { cleanedDir, cleanStorePath } = await pathsFor(vault, talkSlug, sessionId)
      const draft = listCleanedDrafts(cleanedDir).find((candidate) => candidate.slideNumber === slideNumber)
      if (!draft) return { ok: false, error: 'cleaned-slide-not-found' }
      const slide: CleanedSlide = {
        slideNumber,
        markdown: draft.markdown,
        approvedAt: new Date().toISOString()
      }
      writeCleanedStore(cleanStorePath, approveCleaned(cleanedStore(cleanStorePath), slide))
      moveUndo.invalidate(watcherOwner(talkSlug, sessionId), slideNumber)
      return { ok: true }
    } catch (cause) {
      return { ok: false, error: errorMessage(cause) }
    }
  })

  ipcMain.handle('clean:unapprove', async (event, talkSlug: string, sessionId: string, slideNumber: number) => {
    if (!isToolsSender(event)) return BAD_SENDER
    try {
      const vault = deps.vaultRoot()
      if (!vault) return { ok: false }
      const { cleanStorePath } = await pathsFor(vault, talkSlug, sessionId)
      writeCleanedStore(cleanStorePath, unapproveCleaned(cleanedStore(cleanStorePath), slideNumber))
      moveUndo.invalidate(watcherOwner(talkSlug, sessionId), slideNumber)
      return { ok: true }
    } catch {
      return { ok: false }
    }
  })

  ipcMain.handle('clean:open', async (event, talkSlug: string, sessionId: string, slideNumber: number) => {
    if (!isToolsSender(event)) return BAD_SENDER
    try {
      const vault = deps.vaultRoot()
      if (!vault) return false
      const { cleanedDir } = await pathsFor(vault, talkSlug, sessionId)
      const draft = listCleanedDrafts(cleanedDir).find((candidate) => candidate.slideNumber === slideNumber)
      return draft ? (await shell.openPath(assertPathInsideVault(vault, join(cleanedDir, draft.fileName)))) === '' : false
    } catch {
      return false
    }
  })

  ipcMain.handle('clean:reveal-folder', async (event, talkSlug: string, sessionId: string) => {
    if (!isToolsSender(event)) return BAD_SENDER
    try {
      const vault = deps.vaultRoot()
      if (!vault) return false
      const { packDir, cleanedDir } = await pathsFor(vault, talkSlug, sessionId)
      mkdirSync(cleanedDir, { recursive: true })
      startCleanedWatcher(talkSlug, sessionId, cleanedDir)
      shell.showItemInFolder(packDir)
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('clean:copy-prompt', async (event, talkSlug: string, sessionId: string) => {
    if (!isToolsSender(event)) return BAD_SENDER
    try {
      const vault = deps.vaultRoot()
      if (!vault) return null
      const { packDir } = await pathsFor(vault, talkSlug, sessionId)
      if (!existsSync(join(packDir, 'CLEAN.md'))) {
        const cleanedDir = await prepareCleanPack(talkSlug, sessionId, { mode: 'onepass' })
        if (!cleanedDir) return null
      }
      return readFileSync(join(packDir, 'CLEAN.md'), 'utf8')
    } catch {
      return null
    }
  })

  ipcMain.handle('clean:discard', async (event, talkSlug: string, sessionId: string, slideNumber: number) => {
    if (!isToolsSender(event)) return BAD_SENDER
    try {
      const vault = deps.vaultRoot()
      if (!vault) return { ok: false }
      const { cleanedDir, cleanStorePath } = await pathsFor(vault, talkSlug, sessionId)
      const draft = listCleanedDrafts(cleanedDir).find((candidate) => candidate.slideNumber === slideNumber)
      const discarded = discardCleanedDraft(
        draft ? assertPathInsideVault(vault, join(cleanedDir, draft.fileName)) : null,
        cleanStorePath,
        slideNumber
      )
      moveUndo.invalidate(watcherOwner(talkSlug, sessionId), slideNumber)
      return discarded ? { ok: true } : { ok: false }
    } catch {
      return { ok: false }
    }
  })

  // In-app editing: write the cleaned draft for a slide directly (no external editor). `keepApproval`
  // is true for a plain edit of an approved slide (re-snapshot, stays approved); false for a move,
  // which changes the content across a boundary and must return the slide to review.
  ipcMain.handle('clean:save', async (
    event,
    talkSlug: string,
    sessionId: string,
    slideNumber: number,
    markdown: string,
    keepApproval: boolean,
    allowEmpty = false
  ) => {
    if (!isToolsSender(event)) return BAD_SENDER
    try {
      const vault = deps.vaultRoot()
      if (!vault) return { ok: false, error: 'no-vault' }
      if (!Number.isInteger(slideNumber) || slideNumber <= 0) return { ok: false, error: 'bad-slide' }
      const { cleanedDir, cleanStorePath } = await pathsFor(vault, talkSlug, sessionId)
      const store = cleanedStore(cleanStorePath)
      const draftMarkdown = listCleanedDrafts(cleanedDir)
        .find((candidate) => candidate.slideNumber === slideNumber)?.markdown
      const approvedMarkdown = store.approved[String(slideNumber)]?.markdown
      const existingMarkdown = draftMarkdown?.trim() ? draftMarkdown : approvedMarkdown
      if (!markdown.trim() && existingMarkdown?.trim() && allowEmpty !== true) {
        return { ok: false, error: 'empty-cleaned-slide-requires-confirmation' }
      }
      writeCleanedDraft(cleanedDir, slideNumber, markdown, { allowEmpty: allowEmpty === true })
      const wasApproved = Boolean(store.approved[String(slideNumber)])
      if (wasApproved && keepApproval) {
        writeCleanedStore(cleanStorePath, approveCleaned(store, {
          slideNumber,
          markdown: markdown.trim(),
          approvedAt: new Date().toISOString()
        }))
      } else if (wasApproved) {
        writeCleanedStore(cleanStorePath, unapproveCleaned(store, slideNumber))
      }
      moveUndo.invalidate(watcherOwner(talkSlug, sessionId), slideNumber)
      return { ok: true }
    } catch (cause) {
      return { ok: false, error: errorMessage(cause) }
    }
  })

  ipcMain.handle('clean:move', async (
    event,
    talkSlug: string,
    sessionId: string,
    source: { slideNumber: number; markdown: string },
    destination: { slideNumber: number; markdown: string }
  ) => {
    if (!isToolsSender(event)) return BAD_SENDER
    try {
      const vault = deps.vaultRoot()
      if (!vault) return { ok: false, error: 'no-vault' }
      const model = await assembleModel(talkSlug, sessionId)
      if (!model) return { ok: false, error: 'talk-text-model-unavailable' }
      const validSlides = new Set(model.slides.map((slide) => slide.slideNumber))
      if (!source || !destination ||
          !validSlides.has(source.slideNumber) || !validSlides.has(destination.slideNumber) ||
          source.slideNumber === destination.slideNumber ||
          typeof source.markdown !== 'string' || typeof destination.markdown !== 'string') {
        return { ok: false, error: 'bad-slide-move' }
      }
      const { cleanedDir, cleanStorePath } = await pathsFor(vault, talkSlug, sessionId)
      const snapshot = moveCleanedDrafts({ cleanedDir, cleanStorePath, source, destination })
      moveUndo.remember(watcherOwner(talkSlug, sessionId), snapshot)
      return { ok: true }
    } catch (cause) {
      return { ok: false, error: errorMessage(cause) }
    }
  })

  ipcMain.handle('clean:undoMove', async (event, talkSlug: string, sessionId: string) => {
    if (!isToolsSender(event)) return BAD_SENDER
    try {
      const vault = deps.vaultRoot()
      if (!vault) return { ok: false, error: 'no-vault' }
      const { cleanedDir, cleanStorePath } = await pathsFor(vault, talkSlug, sessionId)
      moveUndo.undo(watcherOwner(talkSlug, sessionId), cleanedDir, cleanStorePath)
      return { ok: true }
    } catch (cause) {
      return { ok: false, error: errorMessage(cause) }
    }
  })

  return {
    releaseAllWatchers: () => {
      watchers.releaseAll()
      moveUndo.releaseAll()
    }
  }
}
