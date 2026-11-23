import { EventEmitter } from 'node:events'
import { watch as nativeWatch } from 'node:fs'

type Change = 'change' | 'rename'
type ChangeListener = (event: Change, name: string | null) => void
type Options = { recursive?: boolean; persistent?: boolean }

export interface DirectoryWatch {
  close(): void
  on(event: 'error', listener: (error: Error) => void): unknown
}

type WatchDirectory = (path: string, options: Options, changed: ChangeListener) => DirectoryWatch

export type DirectoryWatchCommand =
  | { type: 'watch'; id: number; path: string; recursive: boolean }
  | { type: 'unwatch'; id: number }
export type DirectoryWatchReply =
  | { type: 'ready'; id: number }
  | { type: 'change'; id: number; event: Change; name: string | null }
  | { type: 'error'; id: number; message: string }

export interface DirectoryWatcherChild {
  postMessage(command: DirectoryWatchCommand): void
  on(event: 'message', listener: (message: DirectoryWatchReply) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  kill(): unknown
}

// Standalone callers use Node directly. Electron installs the process-backed factory before opening settings.
let openWatch: WatchDirectory = (path, options, changed) => nativeWatch(path, options, changed)
export function configureDirectoryWatch(factory: WatchDirectory): void { openWatch = factory }
export const watchDirectory: WatchDirectory = (path, options, changed) => openWatch(path, options, changed)

export function createDirectoryWatchService(spawn: () => DirectoryWatcherChild) {
  type Subscription = { changed: ChangeListener; errors: EventEmitter }
  type Session = { child: DirectoryWatcherChild; watches: Map<number, Subscription> }
  let current: Session | null = null
  let nextId = 0
  let stopped = false

  function start(): Session {
    const child = spawn()
    const session: Session = { child, watches: new Map() }
    child.on('message', message => {
      const watch = session.watches.get(message.id)
      if (session !== current || !watch) return
      // Reconcile once on attachment so a write during process startup cannot go unnoticed.
      if (message.type === 'ready') watch.changed('rename', null)
      else if (message.type === 'change') watch.changed(message.event, message.name)
      else {
        session.watches.delete(message.id)
        if (watch.errors.listenerCount('error')) watch.errors.emit('error', new Error(message.message))
      }
    })
    child.on('exit', code => {
      if (current !== session) return
      current = null
      for (const watch of session.watches.values()) {
        if (watch.errors.listenerCount('error')) watch.errors.emit('error', new Error(`Directory watcher exited (${code})`))
      }
      session.watches.clear()
    })
    return session
  }

  const watch: WatchDirectory = (path, options, changed) => {
    if (stopped) throw new Error('Directory watching has stopped')
    const session = current ??= start()
    const id = ++nextId
    const errors = new EventEmitter()
    session.watches.set(id, { changed, errors })
    try {
      session.child.postMessage({ type: 'watch', id, path, recursive: options.recursive === true })
    } catch (error) {
      session.watches.delete(id)
      throw error
    }
    return {
      on: (event, listener) => errors.on(event, listener),
      close() {
        if (!session.watches.delete(id)) return
        // The callback loses its subscription immediately. Only the child closes the native handle.
        try { session.child.postMessage({ type: 'unwatch', id }) } catch { /* the child already exited */ }
      },
    }
  }

  return {
    watch,
    stop(): void {
      stopped = true
      const session = current
      current = null
      if (!session) return
      session.watches.clear()
      session.child.kill()
    },
  }
}
