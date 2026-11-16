// When the set-up folder engine (setup-folder.ts) runs in the app: at start, when the folder chosen
// changes, when something in the folder changes (watched, and looked at every few minutes because a
// sync service's writes are not always seen by a watch), when a setting changes on this Mac (after a
// short pause, so a burst of changes is one cycle), and on demand. One cycle at a time; a request
// during a cycle runs one more cycle after it. Every new status goes to `changed`. A folder that cannot be
// used (not there at start, a drive asleep, a read out of time) is tried again every RETRY_MS until it can.
// A new folder chosen, or none, tells the engine at once (`folderChanged`): a cycle still running stops
// before its next change; `stop` resolves once it has.
//
// No Electron import; the engine it drives is tested on its own (scripts/test-setup-folder.mjs).
import { watch as fsWatch, type FSWatcher } from 'node:fs'
import type { SetupFolderEngine, SyncReason } from './setup-folder.ts'
import type { SetupFolderStatus } from '../shared/setup-folder.ts'

export const LOCAL_PAUSE_MS = 3000
export const FOLDER_PAUSE_MS = 1500
export const LOOK_EVERY_MS = 5 * 60_000
export const RETRY_MS = 30_000

export interface SetupFolderHost {
  /** The folder setting changed (or the app started). */
  folderChosen(): void
  /** A setting or a vault's personal setting changed on this Mac. */
  localChanged(): void
  readNow(): Promise<SetupFolderStatus>
  /** The folder was cleared or changed by Stop: waits for a cycle still running to stop, then reads the new state. */
  stop(): Promise<SetupFolderStatus>
  dispose(): void
}

export function startSetupFolderHost(opts: {
  engine: SetupFolderEngine
  changed(status: SetupFolderStatus): void
  watch?: (folder: string, listener: () => void) => { close(): void } | null
  log?(line: string): void
  retryMs?: number
}): SetupFolderHost {
  const retryMs = opts.retryMs ?? RETRY_MS
  const log = opts.log ?? (() => {})
  const watchFolder = opts.watch ?? ((folder: string, listener: () => void): FSWatcher | null => {
    try { return fsWatch(folder, { persistent: false }, () => listener()) } catch { return null }
  })
  let watcher: { close(): void } | null = null
  let watched = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  // A cycle's own import changes settings too, which asks for one more cycle; that one finds nothing
  // new and writes nothing (the engine writes only what changed), so there is no loop.

  async function run(reason: SyncReason): Promise<SetupFolderStatus> {
    try {
      const status = await opts.engine.sync(reason)
      rewatch(status.state === 'joined' || status.state === 'joining' ? status.folder : '')
      if (!disposed) opts.changed(status)
      // Not usable now (missing at start, unavailable, out of time): tried again until it is.
      if (status.state === 'unavailable' && !timer) later('folder', retryMs)
      return status
    } catch (error) {
      log(`[setup-folder] a cycle failed: ${String(error)}`)
      return opts.engine.status()
    }
  }
  function rewatch(folder: string): void {
    if (folder === watched) return
    watcher?.close()
    watcher = null
    watched = folder
    if (folder) watcher = watchFolder(folder, () => later('folder', FOLDER_PAUSE_MS))
  }
  function later(reason: SyncReason, ms: number): void {
    if (disposed) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = null; void run(reason) }, ms)
  }
  const every = setInterval(() => { if (watched) void run('folder') }, LOOK_EVERY_MS)
  ;(every as { unref?: () => void }).unref?.()

  void run('start')
  return {
    folderChosen: () => { void opts.engine.folderChanged(); later('chosen', 50) },
    localChanged: () => later('local', LOCAL_PAUSE_MS),
    readNow: () => run('demand'),
    stop: async () => { await opts.engine.folderChanged(); return run('chosen') },
    dispose() {
      disposed = true
      if (timer) clearTimeout(timer)
      clearInterval(every)
      watcher?.close()
    }
  }
}
