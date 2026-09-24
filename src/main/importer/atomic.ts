import { existsSync, lstatSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

function refuseSymlink(filePath: string): void {
  if (existsSync(filePath) && lstatSync(filePath).isSymbolicLink()) {
    throw new Error(`importer-file-symlink-refused:${filePath}`)
  }
}

export function writeTextAtomic(filePath: string, contents: string | Uint8Array): void {
  mkdirSync(dirname(filePath), { recursive: true })
  refuseSymlink(filePath)
  const tempPath = join(dirname(filePath), `.${basename(filePath)}.${randomUUID()}.tmp`)
  try {
    writeFileSync(tempPath, contents, { flag: 'wx' })
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
