// userData/config.json read and write. The write is atomic and durable: the whole new file goes to a
// temporary file beside it, which is flushed to disk (fsync), then renamed over config.json, and the
// folder is flushed so the rename itself survives a power loss. A crash (or a failed write) at any
// point leaves either the old file or the new one, never a truncated file — a truncated config.json
// read back as {} and the next merge-write dropped the vault list (several-vaults ticket 01 review).
//
// Merge semantics are unchanged: a write stores { ...current file, ...patch } (a shallow merge; a
// key in the patch replaces the stored value, keys not in the patch are kept).
import * as nodeFs from 'fs'
import { basename, dirname, join } from 'path'

export type ConfigFs = Pick<
  typeof nodeFs,
  | 'readFileSync' | 'renameSync' | 'mkdirSync' | 'existsSync' | 'unlinkSync'
  | 'openSync' | 'writeSync' | 'fsyncSync' | 'closeSync' | 'readdirSync' | 'statSync'
>

export interface ConfigFile<C extends object> {
  read(): C
  /** Shallow-merge patch into the stored config and write it atomically. Throws when it fails; the
   *  stored file is then unchanged. */
  write(patch: Partial<C>): void
  /** Replace the whole stored config atomically (for removing keys). */
  replace(value: C): void
  /** Remove temp files an interrupted write left beside the config (`<name>.<pid>.tmp`, older than
   *  minAgeMs so a write in flight is never touched). Returns how many went. Never throws. */
  sweepStaleTemps(minAgeMs?: number, now?: number): number
}

/** Flush a folder's entries (the rename) where the platform allows it; some refuse to open or
 *  fsync a directory (EISDIR, EINVAL, EPERM…), which is not an error for us. */
function fsyncDir(fs: ConfigFs, dir: string): void {
  let fd: number | null = null
  try {
    fd = fs.openSync(dir, 'r')
    fs.fsyncSync(fd)
  } catch { /* not supported here */ } finally {
    if (fd !== null) try { fs.closeSync(fd) } catch { /* ignore */ }
  }
}

export function createConfigFile<C extends object>(path: string, fs: ConfigFs = nodeFs): ConfigFile<C> {
  const dir = dirname(path)
  const tempPattern = new RegExp(`^${basename(path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.\\d+\\.tmp$`)
  const read = (): C => {
    try { return JSON.parse(fs.readFileSync(path, 'utf8') as string) as C } catch { return {} as C }
  }
  const replace = (value: C): void => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    // Exclusive create ('wx', O_EXCL): the temp file is never one that already exists (a link planted
    // there, or a stale temp). A stale temp of this pid is removed and the create retried once.
    const openTemp = (): number => {
      try {
        return fs.openSync(tmp, 'wx')
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error
        fs.unlinkSync(tmp)
        return fs.openSync(tmp, 'wx')
      }
    }
    try {
      const fd = openTemp()
      try {
        const data = Buffer.from(JSON.stringify(value, null, 2), 'utf8')
        let off = 0
        while (off < data.length) off += fs.writeSync(fd, data, off, data.length - off)
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      fs.renameSync(tmp, path)
    } catch (error) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) } catch { /* best-effort cleanup */ }
      throw error
    }
    fsyncDir(fs, dir)
  }
  const sweepStaleTemps = (minAgeMs = 60_000, now = Date.now()): number => {
    let removed = 0
    let names: string[]
    try { names = fs.readdirSync(dir) as string[] } catch { return 0 }
    for (const name of names) {
      if (!tempPattern.test(name)) continue
      const p = join(dir, name)
      try {
        const st = fs.statSync(p)
        if (!st.isFile() || now - st.mtimeMs < minAgeMs) continue
        fs.unlinkSync(p)
        removed += 1
      } catch { /* vanished or unremovable */ }
    }
    return removed
  }
  return {
    read,
    write: (patch) => replace({ ...read(), ...patch }),
    replace,
    sweepStaleTemps
  }
}
