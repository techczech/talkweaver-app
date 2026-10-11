import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

function refuseSymlink(filePath: string): void {
  if (existsSync(filePath) && lstatSync(filePath).isSymbolicLink()) {
    throw new Error(`importer-file-symlink-refused:${filePath}`)
  }
}

export interface AtomicWriteOptions {
  /** Permission bits for the file (and its temporary file, from the moment it is created). */
  mode?: number
  /** Flush the temporary file to the disk before the rename (a registry that must survive a power cut). */
  sync?: boolean
}

export function writeTextAtomic(filePath: string, contents: string | Uint8Array, options: AtomicWriteOptions = {}): void {
  mkdirSync(dirname(filePath), { recursive: true })
  refuseSymlink(filePath)
  const tempPath = join(dirname(filePath), `.${basename(filePath)}.${randomUUID()}.tmp`)
  try {
    writeFileSync(tempPath, contents, options.mode === undefined ? { flag: 'wx' } : { flag: 'wx', mode: options.mode })
    if (options.sync) {
      const handle = openSync(tempPath, 'r+')
      try { fsyncSync(handle) } finally { closeSync(handle) }
    }
    refuseSymlink(filePath)
    renameSync(tempPath, filePath)
  } catch (error) {
    try { unlinkSync(tempPath) } catch { /* absent or already renamed */ }
    throw error
  }
}

export function writeJsonAtomic(filePath: string, value: unknown): void {
  writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`)
}
