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

const RESTART_DELAYS_MS = [250, 1000, 4000]
const STABLE_UPTIME_MS = 30_000

export function createDirectoryWatchService(
  spawn: () => DirectoryWatcherChild,
  logFailure: (error: Error) => void = () => {},
) {
  type Subscription = {
    command: Extract<DirectoryWatchCommand, { type: 'watch' }>
    changed: ChangeListener
    errors: EventEmitter
  }
  type Session = { child: DirectoryWatcherChild; startedAt: number }
  const watches = new Map<number, Subscription>()
  let current: Session | null = null
  let restartTimer: ReturnType<typeof setTimeout> | undefined
  let failures = 0
  let exhausted = false
  let nextId = 0
  let stopped = false

  function reportError(watch: Subscription, error: Error): void {
    if (watch.errors.listenerCount('error')) watch.errors.emit('error', error)
  }

  function retry(error: Error, session: Session | null): void {
    current = null
    logFailure(error)
    if (session && Date.now() - session.startedAt >= STABLE_UPTIME_MS) failures = 0
    const delay = RESTART_DELAYS_MS[failures++]
    if (delay === undefined) {
      exhausted = true
      const ended = [...watches.values()]
      watches.clear()
      const failure = new Error('Directory watcher restart limit reached', { cause: error })
      for (const watch of ended) reportError(watch, failure)
      return
    }
    restartTimer = setTimeout(() => {
      restartTimer = undefined
      if (!stopped && watches.size > 0) start()
    }, delay)
  }

  function start(): void {
    try {
      const child = spawn()
      const session = current = { child, startedAt: Date.now() }
      child.on('message', message => {
        const watch = watches.get(message.id)
        if (session !== current || !watch) return
        // Reconcile on every attachment, including writes while the worker was absent.
        if (message.type === 'ready') watch.changed('rename', null)
        else if (message.type === 'change') watch.changed(message.event, message.name)
        else {
          watches.delete(message.id)
          reportError(watch, new Error(message.message))
        }
      })
      child.on('exit', code => {
        if (current === session) retry(new Error(`Directory watcher exited (${code})`), session)
      })
      for (const watch of watches.values()) child.postMessage(watch.command)
    } catch (error) {
      restartAfterSendFailure(error)
    }
  }

  function restartAfterSendFailure(error: unknown): void {
    const session = current
    retry(error instanceof Error ? error : new Error(String(error)), session)
    // The session has lost its identity, so even its exit message is stale.
    session?.child.kill()
  }

  const watch: WatchDirectory = (path, options, changed) => {
    if (stopped) throw new Error('Directory watching has stopped')
    if (exhausted) throw new Error('Directory watcher restart limit reached')
    const id = ++nextId
    const errors = new EventEmitter()
    const command = { type: 'watch', id, path, recursive: options.recursive === true } as const
    watches.set(id, { command, changed, errors })
    if (current) {
      try { current.child.postMessage(command) } catch (error) { restartAfterSendFailure(error) }
    } else if (!restartTimer) start()
    return {
      on: (event, listener) => errors.on(event, listener),
      close() {
        if (!watches.delete(id)) return
        // Remove the callback immediately. Only the child closes the native handle.
        try { current?.child.postMessage({ type: 'unwatch', id }) } catch { /* the child already exited */ }
      },
    }
  }

  return {
    watch,
    stop(): void {
      stopped = true
      clearTimeout(restartTimer)
      restartTimer = undefined
      watches.clear()
      const session = current
      current = null
      session?.child.kill()
    },
  }
}
