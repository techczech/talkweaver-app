// Opening the settings store main reads its preferences from: the migration first, then the store,
// then the overlay readConfig / writeConfig go through (settings-overlay.ts). One function for every
// process that reads or writes a preference (Sol review 1, #6): the app (settings-host.ts) and the
// `setup` command (index.ts runSetupCommand), so `setup` never reads or writes config.json's old
// copies of the preferences.
//
// No Electron import: scripts/test-shared-settings.mjs opens it in a temporary folder.
import { commandsAdapter, type SettingsState } from '@app-patterns/settings'
import { SettingsStore, type LockOptions } from '@app-patterns/settings/node'
import { APP_ID, registry } from '../shared/bridle-commands.ts'
import { migrateLegacy, schema } from '../shared/settings-schema.ts'
import { runMigration, type MigrationOutcome } from './settings-migration.ts'
import { createConfigOverlay, type ConfigOverlay, type OverlayFile } from './settings-overlay.ts'

export interface OpenSettingsOptions {
  dir: string
  appVersion: string
  /** config.json as main reads and writes it (atomic, config-file.ts). */
  file: OverlayFile
  /** Follow changes other processes make to the file (the app: yes; a one-off command: no). */
  watch?: boolean
  lock?: LockOptions
  /** The store changed: the schema keys whose value changed (the overlay's view), and the state. */
  onChange?(keys: string[], state: SettingsState): void
  log?(line: string): void
}

export interface OpenedSettings {
  migration: MigrationOutcome
  store: SettingsStore
  overlay: ConfigOverlay
  /**
   * Why the store may not be used although it opened (Sol review 2): another app's file, a newer
   * version's, a link or a damaged file that could not be set aside. Null when it may be used. The
   * app still opens such a store (Settings shows why); `setup` refuses it (runWithSettings).
   */
  problem: { code: string; error: string } | null
  /** Waits for every queued preference write, then closes the store. Answers with the preferences that were not saved. */
  close(): Promise<{ unsaved: string[] }>
}

export async function openSettings(opts: OpenSettingsOptions): Promise<OpenedSettings> {
  const log = opts.log ?? ((line: string) => console.warn(line))
  const base = {
    dir: opts.dir, app: APP_ID, schema, registry: commandsAdapter(registry), appVersion: opts.appVersion, migrate: migrateLegacy, log,
    ...(opts.lock ? { lock: opts.lock } : {})
  }
  const migration = await runMigration(opts.dir, () => new SettingsStore({ ...base, watch: false, who: { kind: 'app-update', version: opts.appVersion } as never }))
  if (migration.kind === 'unreadable') log('[settings] config.json could not be read; its preferences are moved in once it can be')
  else if (migration.kind === 'not-saved' || ((migration.kind === 'again' || migration.kind === 'first') && migration.notSaved?.length)) {
    log('[settings] some preferences could not be moved into the settings file yet; they are tried again at the next launch')
  }

  let overlay: ConfigOverlay | undefined
  const store = new SettingsStore({
    ...base,
    watch: opts.watch ?? true,
    onChange: (state) => {
      const keys = overlay ? overlay.storeChanged(state.settings) : []
      try { opts.onChange?.(keys, state) } catch (error) { log(`[settings] a change was not passed on: ${String(error)}`) }
    }
  })
  await store.ready
  overlay = createConfigOverlay({ file: opts.file, store, log })
  const opened = overlay
  return {
    migration,
    store,
    overlay: opened,
    problem: store.problem() ?? null,
    async close() {
      await opened.settled()
      await store.close()
      return { unsaved: opened.unsaved() }
    }
  }
}

export const SETUP_NOTHING_DONE = 'The settings file could not be opened. Nothing was done.'
export const SETUP_WENT_WRONG = 'Something went wrong. Nothing more was done.'
export const SETUP_NOT_SAVED = 'A setting was not saved:'
export const SETUP_MAY_NOT_BE_SAVED = 'A setting may not have been saved.'

/**
 * A one-off command (`setup`) run against the settings store (Sol review 2): it runs only when the
 * store opened and may be used, and it fails when any preference it wrote was not saved. Answers
 * with the exit code. `open` is openSettings with the command's options; `run` the command, given
 * the opened store (its overlay is what readConfig / writeConfig go through while it runs).
 */
export async function runWithSettings(
  open: () => Promise<OpenedSettings>,
  run: (opened: OpenedSettings) => Promise<number>,
  err: (line: string) => void
): Promise<number> {
  let opened: OpenedSettings | null = null
  try { opened = await open() } catch { opened = null }
  if (!opened || opened.problem) {
    if (opened) { try { await opened.close() } catch { /* nothing was written */ } }
    if (opened?.problem?.error) err(opened.problem.error)
    err(SETUP_NOTHING_DONE)
    return 1
  }
  let code = 1
  try {
    code = await run(opened)
  } catch {
    err(SETUP_WENT_WRONG)
    code = 1
  }
  // Every preference write is answered before the store closes; one that was not saved fails the command.
  try {
    const { unsaved } = await opened.close()
    if (unsaved.length) {
      err(`${SETUP_NOT_SAVED} ${unsaved.join(', ')}.`)
      if (code === 0) code = 1
    }
  } catch {
    err(SETUP_MAY_NOT_BE_SAVED)
    if (code === 0) code = 1
  }
  return code
}
