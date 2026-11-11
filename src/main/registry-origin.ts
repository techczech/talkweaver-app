// This computer's short-link registry (`handout-registry.json`) and the record of where its trust comes from
// (`handout-registry.origin.json`), for per-talk publishing (spec docs/plans/2026-11-05-per-talk-publishing/spec.md).
//
// Every publish makes the local registry a copy of the site's record. That copy is downloaded data: it must never become the
// evidence that binds a Run published before its folder was recorded to a folder a publish replaces or removes
// (run-unpublish.ts `legacyRunUnproven`). So before the FIRST time this computer follows a site record, the registry it had
// of its own is recorded once, durably, and never changed: either that registry, or an explicit "none" when it had none (or
// none that could be read). Later calls only read that record. Two failures, told apart (`RegistryOriginUnavailable.kind`):
//   unreadable: a record is there but cannot be read (damaged, cut short, an earlier format). Nothing is trusted, and it is
//               never replaced, so no record is ever made later from a registry that has followed a site record since.
//   unwritable: there is no record and none can be made. The caller must not follow the site's record now, or a later
//               successful write would record the downloaded copy as this computer's own.
// A failure while THIS call makes the record (writing, flushing the file, or a real failure flushing its folder) is `unwritable`:
// the publish stops before following the site's record. Only a record that was already there and reads as damaged is
// `unreadable`. Once created, the file is never removed (emptied where it can be): it keeps any later call from making a new
// record, and a later read finds it damaged, which then refuses only what needs it.
//
// No Electron import: the tests drive these functions on files of their own.
import { closeSync, fsyncSync, ftruncateSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'

export class RegistryOriginUnavailable extends Error {
  readonly kind: 'unreadable' | 'unwritable'
  constructor(kind: 'unreadable' | 'unwritable', message: string) { super(message); this.kind = kind }
}

export type RegistryOrigin = { state: 'registry'; registry: Record<string, string> } | { state: 'none' }

const isRegistry = (value: unknown): value is Record<string, string> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every((id) => typeof id === 'string')

/** The registry on disk; null when the file is missing or does not read as a registry (never an empty one in its place). */
export function readRegistryStrict(path: string): Record<string, string> | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return isRegistry(value) ? value : null
  } catch {
    return null
  }
}

/** The registry written whole (to a temporary file, then renamed over the old one). */
export function writeRegistry(path: string, registry: Record<string, string>): void {
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, JSON.stringify(registry, null, 2), 'utf8')
    renameSync(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

/** How the record is flushed: the file system's own fsync unless a test stands in for it. */
export interface OriginIo { fsync(fd: number, what: 'file' | 'folder'): void }
const FS_IO: OriginIo = { fsync: (fd) => fsyncSync(fd) }
/** What a platform answers when a folder cannot be flushed at all (not a failure of the disk). */
const FOLDER_SYNC_UNSUPPORTED = new Set(['EISDIR', 'EPERM', 'EINVAL', 'ENOTSUP', 'EOPNOTSUPP'])
const codeOf = (error: unknown): string => String((error as NodeJS.ErrnoException)?.code ?? '')

/**
 * The folder's own entry for a file just made, flushed. A platform that cannot flush a folder (Windows, or one that answers
 * FOLDER_SYNC_UNSUPPORTED) is not a failure; any other error is, and is thrown.
 */
function syncFolder(folder: string, io: OriginIo): void {
  if (process.platform === 'win32') return // a folder cannot be opened this way; its file system keeps the entry with the file
  let fd: number
  try { fd = openSync(folder, 'r') } catch (error) {
    if (FOLDER_SYNC_UNSUPPORTED.has(codeOf(error))) return
    throw error
  }
  try {
    io.fsync(fd, 'folder')
  } catch (error) {
    if (!FOLDER_SYNC_UNSUPPORTED.has(codeOf(error))) throw error
  } finally {
    try { closeSync(fd) } catch { /* flushed or not, nothing more to do */ }
  }
}

/** An existing record and its folder entry, flushed; an unsupported flush is fine, a real failure is `unwritable`. */
function flushExisting(path: string, io: OriginIo): void {
  const unwritable = (): RegistryOriginUnavailable => new RegistryOriginUnavailable('unwritable', 'the record of this computer\'s own short links cannot be flushed to disk')
  let fd: number
  try { fd = openSync(path, 'r') } catch (error) {
    if (FOLDER_SYNC_UNSUPPORTED.has(codeOf(error))) return syncFolderOrThrow()
    throw unwritable()
  }
  try { io.fsync(fd, 'file') } catch (error) {
    if (!FOLDER_SYNC_UNSUPPORTED.has(codeOf(error))) { try { closeSync(fd) } catch { /* below */ } throw unwritable() }
  }
  try { closeSync(fd) } catch { /* flushed: nothing more to do */ }
  syncFolderOrThrow()
  function syncFolderOrThrow(): void { try { syncFolder(dirname(path), io) } catch { throw unwritable() } }
}

function readOrigin(originPath: string): RegistryOrigin | 'missing' {
  let text: string
  try { text = readFileSync(originPath, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return 'missing'
    throw new RegistryOriginUnavailable('unreadable', 'the record of this computer\'s own short links cannot be read')
  }
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new RegistryOriginUnavailable('unreadable', 'the record of this computer\'s own short links does not read') }
  const record = value as { version?: unknown; state?: unknown; registry?: unknown }
  if (record?.version === 1 && record.state === 'none') return { state: 'none' }
  if (record?.version === 1 && record.state === 'registry' && isRegistry(record.registry)) return { state: 'registry', registry: record.registry }
  throw new RegistryOriginUnavailable('unreadable', 'the record of this computer\'s own short links does not read')
}

/**
 * The short links this computer itself gave. The first call records them durably (written, flushed to disk, created only if
 * absent) from the registry on disk at that moment: a registry, or `none` when there is none or it cannot be read. Every later
 * call reads that record and nothing else, whatever the registry holds by then. Throws RegistryOriginUnavailable when the record
 * cannot be written or read: then no trust may be conferred, and the site's record must not be followed either.
 */
export function registryOrigin(paths: { registry: string; origin: string }, io: OriginIo = FS_IO): RegistryOrigin {
  // A record already there (whole or damaged) is flushed again, file and folder, before anything follows a site's record: a
  // retry after a failed flush must not sync on a record that may not survive a crash.
  let kept: RegistryOrigin | 'missing'
  try { kept = readOrigin(paths.origin) } catch (error) {
    if (error instanceof RegistryOriginUnavailable) flushExisting(paths.origin, io)
    throw error
  }
  if (kept !== 'missing') { flushExisting(paths.origin, io); return kept }
  const own = readRegistryStrict(paths.registry)
  const origin: RegistryOrigin = own === null ? { state: 'none' } : { state: 'registry', registry: own }
  const unwritable = (): RegistryOriginUnavailable => new RegistryOriginUnavailable('unwritable', 'the record of this computer\'s own short links cannot be written')
  let fd: number
  try { fd = openSync(paths.origin, 'wx', 0o600) } catch (error) {
    // Another call recorded it first: that record stands.
    if (codeOf(error) === 'EEXIST') {
      const raced = readOrigin(paths.origin)
      if (raced !== 'missing') { flushExisting(paths.origin, io); return raced }
    }
    throw unwritable()
  }
  try {
    // Every byte written (a short write is written on from where it stopped), then flushed.
    const bytes = Buffer.from(JSON.stringify({ version: 1, ...origin }), 'utf8')
    for (let at = 0; at < bytes.length;) {
      const wrote = writeSync(fd, bytes, at, bytes.length - at)
      if (!(wrote > 0)) throw new Error('nothing written')
      at += wrote
    }
    io.fsync(fd, 'file')
  } catch {
    // This attempt could not make it: the file stays (so no later call makes a record from a synced registry), emptied where
    // possible so a later read finds it damaged, and this publish stops before following the site's record.
    try { ftruncateSync(fd, 0) } catch { /* what was written stays: it is this computer's own registry, read before any sync */ }
    try { closeSync(fd) } catch { /* nothing more to do */ }
    try { syncFolder(dirname(paths.origin), io) } catch { /* already failing */ }
    throw unwritable()
  }
  closeSync(fd)
  // The folder's entry for it, flushed: a real failure here stops this publish too (the record may not survive a crash).
  try { syncFolder(dirname(paths.origin), io) } catch { throw unwritable() }
  return origin
}
