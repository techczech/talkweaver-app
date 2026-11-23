// FSEvents can block when it closes a directory handle. Keep those handles off Electron's main thread.
import { watch, type FSWatcher } from 'node:fs'
import type { DirectoryWatchCommand, DirectoryWatchReply } from './directory-watch.ts'

const port = process.parentPort
const watches = new Map<number, FSWatcher>()
const send = (message: DirectoryWatchReply): void => port.postMessage(message)

function unwatch(id: number): void {
  const watcher = watches.get(id)
  watches.delete(id)
  watcher?.close()
}

port.on('message', ({ data }: { data: DirectoryWatchCommand }) => {
  if (data.type === 'unwatch') {
    unwatch(data.id)
    return
  }
  const { id, path, recursive } = data
  try {
    const watcher = watch(path, { recursive, persistent: false }, (event, name) => {
      if (watches.get(id) === watcher) send({ type: 'change', id, event, name })
    })
    watches.set(id, watcher)
    send({ type: 'ready', id })
    watcher.on('error', error => {
      if (watches.get(id) !== watcher) return
      send({ type: 'error', id, message: error.message })
      unwatch(id)
    })
  } catch (error) {
    send({ type: 'error', id, message: error instanceof Error ? error.message : String(error) })
  }
})
