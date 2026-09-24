import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import type { Dialog, IpcMain, IpcMainInvokeEvent, Shell } from 'electron'
import {
  DEFAULT_IMPORTER_SETTINGS,
  type ImportCleanupPass,
  type ImportPackRequest,
  type ImportProgress,
  type ImportSlidePatch,
  type ImportSourceInfo,
  type ImportSourceSelection,
  type ImportStartRequest,
  type ImporterSettings
} from '../../shared/importer.ts'
import { discoverRenderer, inspectPptx } from './pptx.ts'
import { applySlidePatch, resetSlideDecision } from './storage.ts'
import { applyImportSuggestion, readImportSuggestions, writeImportCleanupPack } from './pack.ts'
import { getImportRun, importRunDir, listImportRuns, originalSlideDataUrl, resumeImport, startImport } from './service.ts'

export interface RegisterImporterIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  dialog: Pick<Dialog, 'showOpenDialog'>
  shell: Pick<Shell, 'showItemInFolder'>
  platform: NodeJS.Platform
  getVaultRoot: () => string | null
  getSettings: () => ImporterSettings
  setSettings: (settings: ImporterSettings) => void
  resourcesDir: string
  onVaultChanged?: () => void
}

export function insideVault(vaultRoot: string, target: string): boolean {
  const rel = relative(resolve(vaultRoot), resolve(target))
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep))
}

export function pptxFilesInFolder(folder: string): string[] {
  const found: string[] = []
  const visit = (current: string): void => {
    let entries
    try { entries = readdirSync(current, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const path = join(current, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.pptx') && !entry.name.startsWith('~$')) found.push(path)
    }
  }
  visit(folder)
  return found.sort((a, b) => a.localeCompare(b, 'en'))
}

export async function inspectPptxSources(
  paths: string[],
  inspect: (path: string) => Promise<ImportSourceInfo> = inspectPptx
): Promise<ImportSourceSelection> {
  const results = await Promise.all(paths.map(async (path) => {
    try { return { source: await inspect(path), error: null } }
    catch (caught) {
      return { source: null, error: { path, message: caught instanceof Error ? caught.message : String(caught) } }
    }
  }))
  return {
    sources: results.flatMap((result) => result.source ? [result.source] : []),
    errors: results.flatMap((result) => result.error ? [result.error] : [])
  }
}

function vaultOrThrow(options: RegisterImporterIpcOptions): string {
  const vault = options.getVaultRoot()
  if (!vault) throw new Error('importer-vault-not-configured')
  return vault
}

function packDir(vaultRoot: string, runId: string, packId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(packId)) throw new Error('importer-pack-id-invalid')
  const path = join(importRunDir(vaultRoot, runId), 'agent-cleanup', packId)
  if (!insideVault(vaultRoot, path) || !existsSync(path)) throw new Error('importer-pack-not-found')
  return path
}

function normaliseSettings(value: Partial<ImporterSettings>): ImporterSettings {
  const cleanupPasses = Array.isArray(value.cleanupPasses)
    ? value.cleanupPasses.filter((pass): pass is ImportCleanupPass =>
      ['structural-parity', 'layout-repair', 'accessibility', 'editorial'].includes(String(pass)))
    : DEFAULT_IMPORTER_SETTINGS.cleanupPasses
  return {
    includeHidden: typeof value.includeHidden === 'boolean' ? value.includeHidden : DEFAULT_IMPORTER_SETTINGS.includeHidden,
    preserveNotes: typeof value.preserveNotes === 'boolean' ? value.preserveNotes : DEFAULT_IMPORTER_SETTINGS.preserveNotes,
    extractMedia: typeof value.extractMedia === 'boolean' ? value.extractMedia : DEFAULT_IMPORTER_SETTINGS.extractMedia,
    fallbackPolicy: value.fallbackPolicy === 'always' ? 'always' : 'uncertain',
    renderer: value.renderer === 'libreoffice' ? 'libreoffice' : 'automatic',
    cleanupPasses: cleanupPasses.length ? cleanupPasses : DEFAULT_IMPORTER_SETTINGS.cleanupPasses
  }
}

function sendProgress(event: IpcMainInvokeEvent, progress: ImportProgress): void {
  if (!event.sender.isDestroyed()) event.sender.send('importer:progress', progress)
}

export function registerImporterIpc(options: RegisterImporterIpcOptions): void {
  options.ipcMain.handle('importer:capabilities', async () => ({
    available: options.platform === 'darwin',
    platform: options.platform,
    renderer: await discoverRenderer()
  }))

  options.ipcMain.handle('importer:choose-sources', async (_event, mode: 'files' | 'folder') => {
    if (options.platform !== 'darwin') return { sources: [], errors: [] }
    const result = await options.dialog.showOpenDialog({
      title: mode === 'folder' ? 'Choose a folder of PowerPoint presentations' : 'Choose PowerPoint presentations',
      properties: mode === 'folder' ? ['openDirectory'] : ['openFile', 'multiSelections'],
      ...(mode === 'files' ? { filters: [{ name: 'PowerPoint presentations', extensions: ['pptx'] }] } : {})
    })
    if (result.canceled) return { sources: [], errors: [] }
    const sourcePaths = mode === 'folder' ? pptxFilesInFolder(result.filePaths[0]) : result.filePaths
    return inspectPptxSources(sourcePaths)
  })

  options.ipcMain.handle('importer:choose-destination', async () => {
    const vault = vaultOrThrow(options)
    const result = await options.dialog.showOpenDialog({
      title: 'Choose a destination folder in the TalkWeaver Vault',
      defaultPath: vault,
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled) return null
    const destination = resolve(result.filePaths[0])
    if (!insideVault(vault, destination)) throw new Error('Choose a folder inside the configured TalkWeaver Vault.')
    return relative(vault, destination).split(sep).join('/')
  })

  options.ipcMain.handle('importer:start', async (event, request: ImportStartRequest) => {
    if (options.platform !== 'darwin') throw new Error('importer-macos-only')
    const detail = await startImport({
      vaultRoot: vaultOrThrow(options),
      request,
      onProgress: (progress) => sendProgress(event, progress)
    })
    options.onVaultChanged?.()
    return detail
  })

  options.ipcMain.handle('importer:resume', async (event, runId: string) => {
    if (options.platform !== 'darwin') throw new Error('importer-macos-only')
    const detail = await resumeImport({
      vaultRoot: vaultOrThrow(options),
      runId: String(runId),
      onProgress: (progress) => sendProgress(event, progress)
    })
    options.onVaultChanged?.()
    return detail
  })

  options.ipcMain.handle('importer:list-runs', () => listImportRuns(vaultOrThrow(options)))
  options.ipcMain.handle('importer:get-run', (_event, runId: string) => getImportRun(vaultOrThrow(options), String(runId)))
  options.ipcMain.handle('importer:update-slide', (_event, runId: string, slideNumber: number, patch: ImportSlidePatch) => {
    const result = applySlidePatch(importRunDir(vaultOrThrow(options), String(runId)), Number(slideNumber), patch)
    options.onVaultChanged?.()
    return result
  })
  options.ipcMain.handle('importer:reset-slide', (_event, runId: string, slideNumber: number) => {
    const result = resetSlideDecision(importRunDir(vaultOrThrow(options), String(runId)), Number(slideNumber))
    options.onVaultChanged?.()
    return result
  })
  options.ipcMain.handle('importer:prepare-pack', (_event, request: ImportPackRequest) => {
    const vault = vaultOrThrow(options)
    const runDir = importRunDir(vault, String(request.runId))
    const packId = `pack-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
    const created = writeImportCleanupPack({
      runDir,
      packId,
      slideNumbers: request.slideNumbers.map(Number),
      passes: request.passes,
      resourcesDir: options.resourcesDir
    })
    return { packId, packDir: created }
  })
  options.ipcMain.handle('importer:list-suggestions', (_event, runId: string, packId: string) =>
    readImportSuggestions(packDir(vaultOrThrow(options), String(runId), String(packId))))
  options.ipcMain.handle('importer:apply-suggestion', (_event, runId: string, packId: string, slideNumber: number) => {
    const vault = vaultOrThrow(options)
    const runDir = importRunDir(vault, String(runId))
    applyImportSuggestion(runDir, packDir(vault, String(runId), String(packId)), Number(slideNumber))
    options.onVaultChanged?.()
    return getImportRun(vault, String(runId))
  })
  options.ipcMain.handle('importer:get-settings', () => normaliseSettings(options.getSettings()))
  options.ipcMain.handle('importer:set-settings', (_event, patch: Partial<ImporterSettings>) => {
    const settings = normaliseSettings({ ...options.getSettings(), ...patch })
    options.setSettings(settings)
    return settings
  })
  options.ipcMain.handle('importer:reveal-run', (_event, runId: string) => {
    const path = join(importRunDir(vaultOrThrow(options), String(runId)), 'manifest.json')
    options.shell.showItemInFolder(path)
    return true
  })
  options.ipcMain.handle('importer:original-data-url', (_event, runId: string, slideNumber: number) =>
    originalSlideDataUrl(vaultOrThrow(options), String(runId), Number(slideNumber)))
}
