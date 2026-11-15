// One writer at a time for a vault data file on this Mac (0.45, second Mac): a lock file that every
// TalkWeaver process on this Mac sees (in the system temp folder, keyed by the file's path; never in the
// vault, so a sync tool never carries it to another Mac). Taking it is an exclusive create; the holder
// writes its pid and its process start time (as `ps -o lstart=` gives it, the identity reap.mjs uses for
// processes). A lock whose holder is gone (no such pid, or a pid now running another process) is stale:
// it is taken over, so a crash never blocks editing. Taking over goes through a second exclusive file, so
// two processes that both find the same stale lock cannot both win. Synchronous: the store's writes are
// synchronous, and the time under the lock is a read and an atomic write.
import { createHash } from 'node:crypto'
import { closeSync, constants, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export type LockHolder = { pid: number; started: string }
export type LockIo = {
  /** The start time of a running process as `ps` gives it, or null when there is no such process. */
  startedOf?: (pid: number) => string | null
  /** Sleep without giving up the thread (the store is synchronous). */
  sleep?: (ms: number) => void
  now?: () => number
}

const sleepSync = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

/** The real machine: `ps` for a process's start time; Windows has none, so there the pid alone identifies. */
export function processStarted(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null
  if (process.platform === 'win32') {
    try { process.kill(pid, 0); return 'running' } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' ? 'running' : null }
  }
  const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' })
  const started = r.status === 0 ? r.stdout.trim() : ''
  return started || null
}

let ownStarted: string | null = null
function me(io: LockIo): LockHolder {
  ownStarted ??= (io.startedOf ?? processStarted)(process.pid) ?? `pid-${process.pid}`
  return { pid: process.pid, started: ownStarted }
}

/** Where the lock for `path` lives: one folder for the whole Mac, a name made from the path. */
export function lockPathFor(path: string, folder = join(tmpdir(), 'talkweaver-locks')): string {
  return join(folder, `${createHash('sha256').update(path).digest('hex').slice(0, 40)}.lock`)
}

function readHolder(file: string): LockHolder | null | 'unreadable' {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as Partial<LockHolder>
    return Number.isInteger(v.pid) && typeof v.started === 'string' ? { pid: v.pid as number, started: v.started } : 'unreadable'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'unreadable'
  }
}

function createExclusive(file: string, holder: LockHolder): boolean {
  let fd: number
  try { fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
  try { writeSync(fd, JSON.stringify(holder)) } finally { closeSync(fd) }
  return true
}

const ageMs = (file: string, now: number): number => { try { return now - statSync(file).mtimeMs } catch { return 0 } }

/**
 * Run `work` while holding the lock for `path`. Waits up to `waitMs` for another live holder, then throws a
 * plain refusal (nothing was done). A holder that is gone is taken over at once.
 */
const heldHere = new Set<string>()
export function withEditsLock<T>(path: string, work: () => T, options: { folder?: string; waitMs?: number; io?: LockIo } = {}): T {
  // Already held by this process (a step inside another): the work is part of that one.
  if (heldHere.has(path)) return work()
  heldHere.add(path)
  try { return lockAndRun(path, work, options) } finally { heldHere.delete(path) }
}

function lockAndRun<T>(path: string, work: () => T, options: { folder?: string; waitMs?: number; io?: LockIo }): T {
  const io = options.io ?? {}
  const startedOf = io.startedOf ?? processStarted
  const sleep = io.sleep ?? sleepSync
  const now = io.now ?? Date.now
  const folder = options.folder ?? join(tmpdir(), 'talkweaver-locks')
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  const file = lockPathFor(path, folder)
  const steal = `${file}.steal`
  const self = me(io)
  const until = now() + (options.waitMs ?? 3000)
  for (;;) {
    if (createExclusive(file, self)) break
    const holder = readHolder(file)
    // Being written this instant (created, not yet filled): wait a moment, unless it stays so (a crash in between).
    const halfWritten = holder === 'unreadable' && ageMs(file, now()) > 2000
    const gone = halfWritten || (holder !== null && holder !== 'unreadable' && startedOf(holder.pid) !== holder.started)
    if (holder !== null && gone) {
      // Take over: only the process that creates the steal file may remove the stale lock, and only while it is
      // still the same stale lock. A steal file left by a crash is cleared after a few seconds.
      if (ageMs(steal, now()) > 5000) try { unlinkSync(steal) } catch { /* gone */ }
      if (createExclusive(steal, self)) {
        try {
          const again = readHolder(file)
          const same = again === 'unreadable' ? halfWritten : again !== null && holder !== 'unreadable' && again.pid === holder.pid && again.started === holder.started
          if (same) try { unlinkSync(file) } catch { /* already gone */ }
        } finally { try { unlinkSync(steal) } catch { /* gone */ } }
        continue
      }
    }
    if (now() > until) throw Error('Another TalkWeaver window is saving these edits. Try again in a moment.')
    sleep(15)
  }
  try { return work() } finally {
    // Only our own lock is removed (a holder that took over a lock it judged stale has its own name in it).
    const held = readHolder(file)
    if (held && held !== 'unreadable' && held.pid === self.pid && held.started === self.started) try { unlinkSync(file) } catch { /* gone */ }
  }
}
