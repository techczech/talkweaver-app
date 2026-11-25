import type { Dialog, IpcMain } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BackupSettings, SettingsChangeEntry, TimerSettings, TranscriptionSettings } from '../preload/index'
import { EDITOR_VIEW_MODE_KEY, editorViewModeFrom, type EditorViewMode } from '../shared/editor-view-mode'
import { normaliseMetadataDefaults, type MetadataDefaults } from '../shared/metadata-surfaces'
import { METADATA_REGISTRY } from '../shared/metadata-registry'
import { PLAIN_FONT_KEY, PLAIN_TEXT_SIZE_KEY, plainFontFrom, plainTextSizeFrom, type PlainLook } from '../shared/plain-view-look'
import type { SlideTabView, SlidesPanelView, WorkspaceView } from '../shared/workspace-view'
import type { Config } from './index'
import type { TalkWeaverSettings } from './settings-host'

type PreferencesConfig = Pick<Config,
  'archiveRoot' | 'actionBarVisible' | 'slidesPanelView' |
  'editorViewMode' | 'plainViewFont' | 'plainViewTextSize' | 'placeChipVisible' |
  'backupEnabled' | 'backupFolder' | 'backupIntervalMin' | 'timerWarnAtMinutes' | 'timerUrgentAtMinutes' |
  'metadataDefaults' | 'transcriptionPython' | 'transcriptionScript' | 'transcriptionFfmpeg'>

type PreferencesIpcHost = {
  ipcMain: Pick<IpcMain, 'handle'>
  handleFromSettingsWindow(channel: string, refused: () => unknown, handler: Parameters<IpcMain['handle']>[1]): void
  dialog: Pick<Dialog, 'showOpenDialog'>
  readonly settingsStore: Pick<TalkWeaverSettings['store'], 'set'> | undefined
  readConfig(): PreferencesConfig
  writeConfig(patch: Partial<PreferencesConfig>): void
  getConfig<K extends keyof PreferencesConfig>(key: K, fallback: PreferencesConfig[K]): PreferencesConfig[K]
  broadcastToWindows(channel: string, state: unknown): void
  userDataPath(): string
  currentVaultRoot(): string | undefined
  detectArchiveRoot(): string | null
  invalidateArchiveCaches(): void
  transcriptionSettings(): TranscriptionSettings
  backupSettings(): BackupSettings
  runLaunchBackup(): Promise<unknown>
  timerSettings(): TimerSettings
  metadataDefaults(): MetadataDefaults
  actionBarState(): { visible: boolean; items: unknown }
  broadcastActionBar(): void
  workspaceViewPreferences(): { openIn: WorkspaceView; slidesPanel: SlidesPanelView; slideTab: SlideTabView }
  plainLook(): PlainLook
  placeChipVisible(): boolean
  guideButtonVisible(): boolean
  setGuideButtonVisible(visible: boolean): boolean
}

/** Registers preferences on the guarded IPC object and uses the app's existing settings store. */
export function registerPreferencesIpc(host: PreferencesIpcHost): void {
  const {
    ipcMain, handleFromSettingsWindow, dialog, readConfig, writeConfig, getConfig,
    broadcastToWindows, userDataPath, currentVaultRoot, detectArchiveRoot, invalidateArchiveCaches,
    transcriptionSettings, backupSettings, runLaunchBackup, timerSettings, metadataDefaults,
    actionBarState, broadcastActionBar, workspaceViewPreferences, plainLook, placeChipVisible,
    guideButtonVisible, setGuideButtonVisible
  } = host

  ipcMain.handle('preferences:get-transcription', () => transcriptionSettings())

  // These paths name programs main runs (Python, the script, ffmpeg): only the Settings window may
  // change them; any other sender gets the paths as they are, unchanged.
  handleFromSettingsWindow('preferences:set-transcription', () => transcriptionSettings(), async (_event, cfg: { python?: string; script?: string; ffmpeg?: string }) => {
    // Settings sends all three; an empty field clears its setting. Stored as typed (`~` kept).
    writeConfig({
      transcriptionPython: (cfg.python || '').trim() || undefined,
      transcriptionScript: (cfg.script || '').trim() || undefined,
      transcriptionFfmpeg: (cfg.ffmpeg || '').trim() || undefined
    })
    return transcriptionSettings()
  })

  // ── Settings IPC (folders the app reads from) ────────────────────────────────
  // The Settings panel reads these to show the configured folders and let the user change them.
  // archiveDefault is always null — the archive is config-only (no hardcoded fallback).
  ipcMain.handle('preferences:get-paths', () => {
    const c = readConfig()
    return {
      vaultRoot: currentVaultRoot() ?? null,
      archiveRoot: c.archiveRoot ?? null,
      archiveDefault: null,
      archiveAvailable: detectArchiveRoot() != null
    }
  })

  handleFromSettingsWindow('preferences:choose-archive', () => null, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose Image Archive Root',
      message: 'Select the folder containing the old-PowerPoint image archive (registry/media.db)',
      properties: ['openDirectory']
    })
    if (result.canceled || !result.filePaths.length) return null
    const chosen = result.filePaths[0]
    writeConfig({ archiveRoot: chosen })
    invalidateArchiveCaches()
    return chosen
  })

  handleFromSettingsWindow('preferences:clear-archive', () => detectArchiveRoot(), () => {
    writeConfig({ archiveRoot: undefined }) // a preference: back to its default through the store
    invalidateArchiveCaches()
    return null
  })

  ipcMain.handle('preferences:get-action-bar', () => actionBarState())
  ipcMain.handle('preferences:set-action-bar-visible', (_event, visible: boolean) => {
    writeConfig({ actionBarVisible: visible === true })
    broadcastActionBar()
    return actionBarState().visible
  })

  ipcMain.handle('preferences:get-workspace-views', workspaceViewPreferences)
  ipcMain.handle('preferences:set-slide-tab', async (_event, view: unknown) => {
    if (view === 'pages' || view === 'list') await host.settingsStore?.set('writing.slideTabView', view)
  })
  ipcMain.handle('preferences:set-slides-panel', (_event, view: unknown) => {
    if (view !== 'previews' && view !== 'outline') return
    writeConfig({ slidesPanelView: view })
    broadcastToWindows('workspace-views:changed', workspaceViewPreferences())
  })

  function editorViewMode(): EditorViewMode {
    return editorViewModeFrom(readConfig()[EDITOR_VIEW_MODE_KEY])
  }
  ipcMain.handle('preferences:get-editor-view-mode', () => editorViewMode())
  ipcMain.handle('preferences:set-editor-view-mode', (_event, mode: unknown) => {
    writeConfig({ [EDITOR_VIEW_MODE_KEY]: editorViewModeFrom(mode) })
    const next = editorViewMode()
    broadcastToWindows('editor-view-mode:changed', next)
    return next
  })

  ipcMain.handle('preferences:get-plain-look', () => plainLook())
  ipcMain.handle('preferences:set-plain-look', (_event, change: unknown) => {
    const c = (change && typeof change === 'object' ? change : {}) as { font?: unknown; size?: unknown }
    const current = plainLook()
    writeConfig({
      [PLAIN_FONT_KEY]: c.font === undefined ? current.font : plainFontFrom(c.font),
      [PLAIN_TEXT_SIZE_KEY]: c.size === undefined ? current.size : plainTextSizeFrom(c.size)
    })
    const next = plainLook()
    broadcastToWindows('plain-look:changed', next)
    return next
  })

  ipcMain.handle('preferences:get-place-chip', () => ({ visible: placeChipVisible() }))
  ipcMain.handle('preferences:set-place-chip-visible', (_event, visible: boolean) => {
    writeConfig({ placeChipVisible: visible === true })
    const state = { visible: placeChipVisible() }
    broadcastToWindows('place-chip:changed', state)
    return state.visible
  })

  ipcMain.handle('preferences:get-guide-button', () => ({ visible: guideButtonVisible() }))
  ipcMain.handle('preferences:set-guide-button-visible', (_event, visible: boolean) => setGuideButtonVisible(visible === true))

  ipcMain.handle('preferences:get-backup', () => backupSettings())

  ipcMain.handle('preferences:set-backup', (_event, patch: { enabled?: boolean; intervalMin?: number }) => {
    const next: Partial<PreferencesConfig> = {}
    if (typeof patch.enabled === 'boolean') next.backupEnabled = patch.enabled
    if (Number.isFinite(patch.intervalMin)) next.backupIntervalMin = Math.max(5, Math.round(patch.intervalMin as number))
    writeConfig(next)
    // Turning it on backs up whatever is already enrolled and stale — it never scans the vault.
    if (getConfig('backupEnabled', false) && getConfig('backupFolder', undefined)) {
      setTimeout(() => { runLaunchBackup().catch(() => {}) }, 400)
    }
    return backupSettings()
  })

  handleFromSettingsWindow('preferences:choose-backup-folder', () => backupSettings(), async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose Backup Folder',
      message: 'Pick a folder inside your OneDrive/Dropbox — TalkWeaver saves presentable HTML backups there',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths.length) return backupSettings()
    writeConfig({ backupFolder: result.filePaths[0] })
    if (getConfig('backupEnabled', false)) setTimeout(() => { runLaunchBackup().catch(() => {}) }, 400)
    return backupSettings()
  })

  handleFromSettingsWindow('preferences:clear-backup-folder', () => backupSettings(), () => {
    writeConfig({ backupFolder: undefined }) // a preference: back to its default through the store
    return backupSettings()
  })

  ipcMain.handle('preferences:get-timer', () => timerSettings())

  ipcMain.handle('preferences:set-timer', (_event, patch: { warnAtMinutes?: number; urgentAtMinutes?: number }) => {
    const next: Partial<PreferencesConfig> = {}
    if (Number.isFinite(patch.warnAtMinutes)) next.timerWarnAtMinutes = Math.max(1, Math.round(patch.warnAtMinutes as number))
    if (Number.isFinite(patch.urgentAtMinutes)) next.timerUrgentAtMinutes = Math.max(1, Math.round(patch.urgentAtMinutes as number))
    writeConfig(next)
    return timerSettings()
  })

  ipcMain.handle('preferences:get-metadata-defaults', () => metadataDefaults())

  ipcMain.handle('preferences:set-metadata-defaults', (_event, patch: MetadataDefaults) => {
    writeConfig({ metadataDefaults: normaliseMetadataDefaults(METADATA_REGISTRY, { ...metadataDefaults(), ...(patch ?? {}) }) })
    return metadataDefaults()
  })

  // ── Settings changelog (Gate-5) ──────────────────────────────────────────────
  // Every settings change is recorded (old → new, when) in a per-machine userData JSON log, so
  // a tweak the user forgot making is one click to find — and to undo via the per-entry Reset
  // in Settings → Changes. Values only, never secrets (the renderer logs those as presence).
  function settingsChangelogFile(): string { return join(userDataPath(), 'settings-changelog.json') }
  function readSettingsChangelog(): SettingsChangeEntry[] {
    try {
      const raw = JSON.parse(readFileSync(settingsChangelogFile(), 'utf8'))
      return Array.isArray(raw) ? (raw as SettingsChangeEntry[]) : []
    } catch { return [] }
  }
  ipcMain.handle('preferences:changelog-get', () => readSettingsChangelog())
  ipcMain.handle('preferences:changelog-log', (_event, entry: Omit<SettingsChangeEntry, 'at'>) => {
    if (
      typeof entry?.key !== 'string' || typeof entry?.label !== 'string' ||
      typeof entry?.from !== 'string' || typeof entry?.to !== 'string'
    ) return readSettingsChangelog()
    const list = readSettingsChangelog()
    list.unshift({ at: Date.now(), key: entry.key, label: entry.label, from: entry.from, to: entry.to })
    const trimmed = list.slice(0, 200) // a per-machine audit trail, not an archive
    try { writeFileSync(settingsChangelogFile(), JSON.stringify(trimmed, null, 2), 'utf8') } catch { /* log-only */ }
    return trimmed
  })
}
