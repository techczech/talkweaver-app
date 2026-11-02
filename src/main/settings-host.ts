// The app's side of the shared settings (0.42): the store (userData/settings.json), the overlay main
// reads its preferences through, the Settings window, the menu bar generated from the command
// registry, export and import, and Accounts and keys. Everything with behaviour lives in the
// @app-patterns packages and in settings-migration.ts / settings-overlay.ts / settings-secret-slots.ts;
// this file wires them to TalkWeaver's schema, registry and windows.
//
// Order at launch (startSettingsHost, awaited before anything reads a preference):
//   1-3. openSettings (settings-open.ts, shared with the `setup` command): runMigration (config.json's
//      preferences moved into settings.json, or again after a downgrade, by a store logging as "app
//      update", closed again); the store the app reads from, logging as "you", whose onChange tells the
//      overlay, the window and the app (the broadcasts in index.ts) about every change; the overlay
//      behind readConfig / writeConfig (index.ts).
//   4. installSettings: shared Settings IPC, the window, the menu bar.
import { Menu } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SettingsState } from '@app-patterns/settings'
import type { SettingsStore } from '@app-patterns/settings/node'
import { installSettings, type SettingsHost } from '@app-patterns/settings-electron/main'
import type { SecretSlots } from '@app-patterns/settings-electron'
import { APP_ID, MENUS, appCommandIdOf, registry } from '../shared/bridle-commands'
import { updateCheckMenuTemplate } from './settings-update-menu'
import { schema } from '../shared/settings-schema'
import type { MigrationOutcome } from './settings-migration'
import type { ConfigOverlay, OverlayFile } from './settings-overlay'
import { openSettings } from './settings-open'

/** Pages of the Settings window that are the app's own (settings-main.tsx draws them). */
export const CUSTOM_PAGES = ['get-started', 'backups', 'cloudflare'] as const

/** Path settings that name a file (the rest are folders). */
const FILE_PATHS = new Set(['recording.transcriptionPython', 'recording.transcriptionScript', 'recording.ffmpeg'])

export interface SettingsHostDeps {
  dir: string
  appVersion: string
  /** config.json as main reads and writes it (atomic, config-file.ts). */
  file: OverlayFile
  /** The Settings window's preload and page. */
  window: { preload: string; url: string }
  slots?: SecretSlots
  /** Show an editor window (make one when none is open). */
  openMain(): void
  /** Run an app command (its app id) in the editor window, as its palette row does. */
  runInEditor(appCommandId: string): void
  /** Commands main runs itself (New window). True when it ran one. */
  runInMain(appCommandId: string): boolean
  /** The store changed: the schema keys whose value changed (the overlay's view), and the state. */
  changed(keys: string[], state: SettingsState): void
  log?(line: string): void
}

export interface TalkWeaverSettings {
  overlay: ConfigOverlay
  host: SettingsHost
  store: SettingsStore
  migration: MigrationOutcome
  dispose(): Promise<void>
}

/** The Settings page's URL: the dev server in development, else the bundled file. */
export function settingsPageUrl(rendererDevUrl: string | undefined, mainDir: string): string {
  if (rendererDevUrl) return `${rendererDevUrl}/settings.html`
  return pathToFileURL(join(mainDir, '../renderer/settings.html')).href
}

export async function startSettingsHost(deps: SettingsHostDeps): Promise<TalkWeaverSettings> {
  const log = deps.log ?? ((line: string) => console.warn(line))
  let host: SettingsHost | undefined
  const opened = await openSettings({
    dir: deps.dir,
    appVersion: deps.appVersion,
    file: deps.file,
    log,
    onChange: (keys, state) => {
      host?.storeChanged(state)
      if (host) placeUpdateCheckInAppMenu(store, deps, host)
      deps.changed(keys, state)
    }
  })
  const { store, overlay, migration } = opened

  host = installSettings({
    store,
    schema,
    registry,
    menus: MENUS,
    openMain: () => undefined, // each command below decides whether it needs the editor window
    sendCommand: (id) => {
      const appId = appCommandIdOf(id)
      if (deps.runInMain(appId)) return
      deps.openMain()
      deps.runInEditor(appId)
    },
    window: deps.window,
    ...(deps.slots ? { slots: deps.slots } : {}),
    extraSections: [...CUSTOM_PAGES],
    pathKind: (key) => (FILE_PATHS.has(key) ? 'file' : 'folder'),
    appInfo: { icon: 'presentation', cli: APP_ID }
  })

  placeUpdateCheckInAppMenu(store, deps, host)
  return {
    overlay,
    host,
    store,
    migration,
    async dispose() {
      host?.dispose()
      await opened.close()
    }
  }
}

/** Build from the shared template and relocate only the identified update item, without cloning menus. */
function placeUpdateCheckInAppMenu(store: SettingsStore, deps: SettingsHostDeps, host: SettingsHost | undefined): void {
  const run = (commandId: string): void => {
    if (commandId === 'settings') { host?.openSettingsWindow(); return }
    if (commandId === 'export-settings') { void host?.exportSettings(); return }
    if (commandId === 'import-settings') { host?.startImport(); return }
    const appId = appCommandIdOf(commandId)
    if (!deps.runInMain(appId)) { deps.openMain(); deps.runInEditor(appId) }
  }
  const template = updateCheckMenuTemplate({
    platform: process.platform, keys: store.view().keys, run, log: deps.log ?? ((line: string) => console.warn(line))
  })
  if (template) Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
