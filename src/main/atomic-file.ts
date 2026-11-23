// Which writer: small data files (JSON records, registries, pack files, published pages) → this module;
// generated output written without holding the main process → generated-file-write.ts; the talk outline →
// talk-writer.ts; a Run file → the Run writer in runs.ts (exclusive reservation).
//
// A small file written here is, on disk, always either the old complete version or the new complete one.
// The bytes go to a temporary file in the same folder (short unpredictable name, created exclusively, so a stray
// file or a link already under that name is never written through), are flushed to the disk, and only then
// renamed onto the real name; a rename within one folder replaces the old file in one step. Every failure
// removes the temporary file and leaves the destination as it was. A link at the destination is refused,
// before writing and again just before the rename: the write never goes through a link to somewhere else.
//
// No Electron import: plain-Node tests load this file.
import { randomBytes } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** The file-system calls a write makes (tests replace one to fail it on purpose). */
export type AtomicFileOps = {
  /** Create `path` exclusively (never an existing entry) and write `data` to it. */
  writeFile: (path: string, data: string | Uint8Array, mode?: number) => void
  /** Flush `path` to the disk. */
  fsync: (path: string) => void
  rename: (from: string, to: string) => void
  unlink: (path: string) => void
  /** The unique part of a temporary file's name (tests choose it to force a collision). */
  tempSuffix?: () => string
}

export interface AtomicWriteOptions {
  /** Permission bits for the file (and its temporary file, from the moment it is created). */
  mode?: number
  /** Flush the temporary file to the disk before the rename. Default true: these are small files. */
  sync?: boolean
  /** Make the destination's folder when it is missing. Default true. Pass false where the folder must
   *  already be there (anything inside a vault), so a folder that has gone is never made again. */
  createParent?: boolean
  /** Runs after the bytes are written and flushed, just before the rename; throwing cancels the write. */
  beforeCommit?: () => void
  /** Replaces some of the file-system calls (tests). */
  ops?: Partial<AtomicFileOps>
}

const fsOps: AtomicFileOps = {
  writeFile: (path, data, mode) => writeFileSync(path, data, mode === undefined ? { flag: 'wx' } : { flag: 'wx', mode }),
  fsync: (path) => {
    const handle = openSync(path, 'r+')
    try { fsyncSync(handle) } finally { closeSync(handle) }
  },
  rename: renameSync,
  unlink: unlinkSync,
}

function refuseSymlink(filePath: string): void {
  let isLink: boolean
  try {
    isLink = lstatSync(filePath).isSymbolicLink()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (isLink) throw new Error(`atomic-write-symlink-refused:${filePath}`)
}

/** A replacement written and flushed beside its destination but not yet in place: `commit` renames it
 *  onto the destination, `discard` removes it. A change to several files stages every file first, so a
 *  flush that fails does so before anything is replaced. */
export interface StagedWrite {
  commit: () => void
  discard: () => void
}

export function stageTextAtomic(filePath: string, contents: string | Uint8Array, options: AtomicWriteOptions = {}): StagedWrite {
  const ops: AtomicFileOps = { ...fsOps, ...options.ops }
  const folder = dirname(filePath)
  if (options.createParent ?? true) mkdirSync(folder, { recursive: true })
  refuseSymlink(filePath)
  // Short whatever the destination's name: a name near the file system's limit still has a temporary file.
  const suffix = ops.tempSuffix ? ops.tempSuffix() : randomBytes(8).toString('hex')
  const tempPath = join(folder, `.tw-${suffix}.tmp`)
  const removeTemp = (): void => {
    try { ops.unlink(tempPath) } catch { /* never made, or already gone */ }
  }
  try {
    ops.writeFile(tempPath, contents, options.mode)
  } catch (error) {
    // A partly written temporary file goes; an entry that was already under that name (the exclusive
    // create refused it) is not ours and stays.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') removeTemp()
    throw error
  }
  try {
    if (options.sync ?? true) ops.fsync(tempPath)
  } catch (error) {
    removeTemp()
    throw error
  }
  let settled = false
  return {
    commit: () => {
      if (settled) throw new Error('atomic-write-already-settled')
      settled = true
      try {
        options.beforeCommit?.()
        refuseSymlink(filePath)
        ops.rename(tempPath, filePath)
      } catch (error) {
        removeTemp()
        throw error
      }
    },
    discard: () => {
      if (settled) return
      settled = true
      removeTemp()
    },
  }
}

export function writeTextAtomic(filePath: string, contents: string | Uint8Array, options: AtomicWriteOptions = {}): void {
  stageTextAtomic(filePath, contents, options).commit()
}

export function writeJsonAtomic(filePath: string, value: unknown, options: AtomicWriteOptions = {}): void {
  writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, options)
}
