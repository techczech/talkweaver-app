// Watches a talk's scratch folder for agent files (debounced). One watcher on the talk folder notices the
// folder appearing; one on the folder itself notices files. Events for the app's own state file and its temp
// files are ignored, so a state write never wakes the watcher it came from. A metadata-only
// reconciliation also repairs silent native-event loss (observed with macOS directory watches).
import { watch, lstatSync, readdirSync, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { SCRATCH_FOLDER_NAME, STATE_FILE_NAME } from '../shared/scratchpad.ts'

export interface ScratchpadWatch { close(): void }

export function watchScratchFolder(talkDir: string, onChange: () => void, debounceMs = 300): ScratchpadWatch {
  const folder = join(talkDir, SCRATCH_FOLDER_NAME)
  let closed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let talkWatcher: FSWatcher | null = null
  let folderWatcher: FSWatcher | null = null

  const ours = (name: string | Buffer | null): boolean => {
    const text = name === null ? '' : String(name)
    return text === STATE_FILE_NAME || (text.startsWith(`.${STATE_FILE_NAME}.`) && text.endsWith('.tmp'))
  }
  const metadata = (): { identity: string; key: string } | null => {
    try {
      const directory = lstatSync(folder, { bigint: true })
      if (!directory.isDirectory()) return null // Never follow a linked scratch folder.
      const identity = `${directory.dev}:${directory.ino}`
      const entries = readdirSync(folder).filter((name) => !ours(name)).sort().map((name) => {
        try {
          const file = lstatSync(join(folder, name), { bigint: true })
          return [name, `${file.dev}:${file.ino}:${file.size}:${file.mtimeNs}:${file.ctimeNs}`]
        } catch { return [name, 'unreadable'] }
      })
      const after = lstatSync(folder, { bigint: true })
      if (!after.isDirectory() || after.dev !== directory.dev || after.ino !== directory.ino) return null
      // Folder mtime includes our own state writes; only non-state entry metadata matters.
      return { identity, key: JSON.stringify([identity, entries]) }
    } catch { return null }
  }
  let last = metadata()
  let watchedIdentity = last?.identity
  const fire = (): void => {
    if (closed) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = null; if (!closed) reconcile() }, debounceMs)
  }
  const attachFolder = (): void => {
    if (closed || folderWatcher || !watchedIdentity) return
    try {
      folderWatcher = watch(folder, (_event, name) => { if (!ours(name)) fire() })
      folderWatcher.on('error', () => { folderWatcher?.close(); folderWatcher = null })
    } catch { folderWatcher = null }
  }
  const reconcile = (): void => {
    const next = metadata()
    if (next?.identity !== watchedIdentity) {
      folderWatcher?.close(); folderWatcher = null
      watchedIdentity = next?.identity
    }
    attachFolder()
    if (next?.key === last?.key) return
    last = next
    onChange()
  }
  try {
    talkWatcher = watch(talkDir, (_event, name) => {
      if (name !== null && String(name) !== SCRATCH_FOLDER_NAME) return
      fire()
    })
    talkWatcher.on('error', () => { talkWatcher?.close(); talkWatcher = null })
  } catch { talkWatcher = null }
  attachFolder()
  queueMicrotask(fire)
  // A successful fs.watch registration does not prove its stream will deliver events.
  // Native events keep the fast path; this periodic scan reads no file contents and creates
  // no child process. Snapshot comparison also coalesces late native events with a repair.
  const repair = setInterval(fire, 2000)
  repair.unref()

  return {
    close() {
      closed = true
      if (timer) clearTimeout(timer)
      clearInterval(repair)
      talkWatcher?.close(); folderWatcher?.close()
      talkWatcher = null; folderWatcher = null
    }
  }
}
