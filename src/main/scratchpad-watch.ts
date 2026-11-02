// Watches a talk's scratch folder for agent files (debounced). One watcher on the talk folder notices the
// folder appearing; one on the folder itself notices files. Events for the app's own state file and its temp
// files are ignored, so a state write never wakes the watcher it came from. No polling.
import { watch, existsSync, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { SCRATCH_FOLDER_NAME, STATE_FILE_NAME } from '../shared/scratchpad.ts'

export interface ScratchpadWatch { close(): void }

export function watchScratchFolder(talkDir: string, onChange: () => void, debounceMs = 300): ScratchpadWatch {
  const folder = join(talkDir, SCRATCH_FOLDER_NAME)
  const folderExistedAtStart = existsSync(folder)
  let closed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let talkWatcher: FSWatcher | null = null
  let folderWatcher: FSWatcher | null = null

  const fire = (): void => {
    if (closed) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = null; if (!closed) onChange() }, debounceMs)
  }
  const ours = (name: string | Buffer | null): boolean => {
    const text = name === null ? '' : String(name)
    return text === STATE_FILE_NAME || (text.startsWith(`.${STATE_FILE_NAME}.`) && text.endsWith('.tmp'))
  }
  const attachFolder = (): void => {
    if (closed || folderWatcher || !existsSync(folder)) return
    try {
      folderWatcher = watch(folder, (_event, name) => { if (!ours(name)) fire() })
      folderWatcher.on('error', () => { folderWatcher?.close(); folderWatcher = null })
    } catch { folderWatcher = null }
  }
  try {
    talkWatcher = watch(talkDir, (_event, name) => {
      if (String(name ?? '') !== SCRATCH_FOLDER_NAME) return
      // The folder appeared (or went): reattach, and tell the panel.
      if (!existsSync(folder)) { folderWatcher?.close(); folderWatcher = null } else attachFolder()
      fire()
    })
    talkWatcher.on('error', () => { talkWatcher?.close(); talkWatcher = null })
  } catch { talkWatcher = null }
  attachFolder()
  // A folder can be created while the OS starts delivering the parent watcher's events.
  // Reconcile once after this turn so that first arrival cannot be missed; later changes
  // remain event-driven, and closing the watcher also cancels this reconciliation.
  queueMicrotask(() => {
    if (closed || folderExistedAtStart || !existsSync(folder)) return
    attachFolder()
    fire()
  })

  return {
    close() {
      closed = true
      if (timer) clearTimeout(timer)
      talkWatcher?.close(); folderWatcher?.close()
      talkWatcher = null; folderWatcher = null
    }
  }
}
