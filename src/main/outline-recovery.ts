// Recovery copies of unsaved outline text (shared-talk ticket 01). When an editor save of a guarded talk
// is refused or fails, the editor's text is not on disk anywhere; a forced quit or a crash before the
// person chooses would lose it. So every such save also writes the text here:
//
//   <dir>/<talk-slug>-<path-hash>-<timestamp>-outline.md   the editor's text (a plain outline)
//   <dir>/<same name>-outline.md.path                      the talk's real outline path (plain text)
//   <dir>/index.json                                       path-hash → { outline path, file, savedAt }
//
// The path hash (sha256 of the talk's full real outline path, 12 hex digits) keeps two talks with one
// slug apart, and it is what a lookup uses, so the files alone identify each talk's copy: a corrupt or
// missing index.json is rebuilt from the files present (never loaded as empty), each copy's outline path
// read back from its `.path` note, so a rebuilt entry still moves with a later rename of its folder. One copy per talk, kept
// up to date (a newer save replaces it) and deleted after the talk's next successful save. The app's own
// rename or move of a talk moves its copy with it (`rekey`), so a copy is always offered on the next
// open of the talk it belongs to. Every operation is best-effort for the caller: it never blocks a save.
import { createHash } from 'crypto'
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'fs/promises'
import { basename, join, sep } from 'path'
import type { OutlineRecoveryCopy } from '../shared/outline-disk-change.ts'

export interface OutlineRecovery {
  /** Keeps `text` as the recovery copy for the talk at `realPath` (replacing an older one). */
  save(realPath: string, text: string): Promise<void>
  /** Deletes the talk's recovery copy, if any (after a successful save, Reload, or Discard). */
  clear(realPath: string): Promise<void>
  /** The talk's recovery copy, or null. */
  read(realPath: string): Promise<OutlineRecoveryCopy | null>
  /** The app moved `from` to `to`: a copy of `from` (or, with `under`, of any talk inside the folder
   *  `from`) now belongs to the talk at its new path. */
  rekey(from: string, to: string, opts?: { under?: boolean }): Promise<void>
}

interface IndexEntry { path: string | null; file: string; savedAt: number }
type Index = Record<string, IndexEntry>

export const recoveryPathHash = (realPath: string): string => createHash('sha256').update(realPath, 'utf8').digest('hex').slice(0, 12)

const slugOf = (realPath: string): string =>
  (basename(realPath).replace(/-outline\.md$/i, '').replace(/\.md$/i, '').replace(/[^A-Za-z0-9._-]+/g, '-') || 'talk').slice(0, 80)
const stamp = (at: number): string => new Date(at).toISOString().replace(/[:.]/g, '-')
// <slug>-<hash>-<YYYY-MM-DDTHH-MM-SS-mmmZ>-outline.md
const FILE = /^(.*)-([0-9a-f]{12})-(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z)-outline\.md$/
const parseStamp = (s: string): number => Date.parse(s.replace(/^(\d{4}-\d\d-\d\dT\d\d)-(\d\d)-(\d\d)-(\d{3})Z$/, '$1:$2:$3.$4Z'))

export function createOutlineRecovery(dir: string, now: () => number = Date.now): OutlineRecovery {
  const indexPath = join(dir, 'index.json')
  let index: Index | null = null
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const run = chain.then(work)
    chain = run.catch(() => undefined)
    return run
  }

  const filesFor = async (hash: string): Promise<string[]> => {
    let names: string[] = []
    try { names = await readdir(dir) } catch { return [] }
    return names.filter((name) => FILE.exec(name)?.[2] === hash)
  }

  // From the files alone: the newest copy per path hash (the outline path itself is not in the name).
  const rebuild = async (): Promise<Index> => {
    const rebuilt: Index = {}
    let names: string[] = []
    try { names = await readdir(dir) } catch { return rebuilt }
    for (const name of names) {
      const m = FILE.exec(name)
      if (!m) continue
      const savedAt = parseStamp(m[3])
      if (!rebuilt[m[2]] || rebuilt[m[2]].savedAt < savedAt) rebuilt[m[2]] = { path: null, file: name, savedAt }
    }
    // A copy written before the notes existed keeps path null: found by its own path's hash only.
    for (const [hash, entry] of Object.entries(rebuilt)) entry.path = await readNote(entry.file, hash)
    return rebuilt
  }

  const load = async (): Promise<Index> => {
    if (index) return index
    let raw: string | null = null
    try { raw = await readFile(indexPath, 'utf8') } catch { /* missing: rebuild */ }
    let parsed: unknown = null
    if (raw !== null) { try { parsed = JSON.parse(raw) } catch { parsed = null } }
    const valid = parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
      Object.values(parsed as Record<string, unknown>).every((e) => !!e && typeof (e as IndexEntry).file === 'string')
    index = valid ? parsed as Index : await rebuild()
    if (!valid && raw !== null) {
      console.warn('[outline-recovery] index.json was unreadable; rebuilt it from the copies present')
      await store(index).catch(() => undefined)
    }
    return index
  }
  const store = async (next: Index): Promise<void> => {
    await mkdir(dir, { recursive: true })
    const temp = `${indexPath}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(next, null, 2))
    await rename(temp, indexPath)
  }

  // The `.path` note beside a copy: the talk's real outline path, which the path hash cannot give back.
  const noteOf = (file: string): string => join(dir, `${file}.path`)
  const writeNote = (file: string, realPath: string): Promise<void> => writeFile(noteOf(file), realPath, 'utf8')
  const readNote = async (file: string, hash: string): Promise<string | null> => {
    try {
      const path = (await readFile(noteOf(file), 'utf8')).trim()
      return path && recoveryPathHash(path) === hash ? path : null
    } catch { return null }
  }

  const removeAll = async (hash: string, keep?: string): Promise<void> => {
    for (const name of await filesFor(hash)) {
      if (name === keep) continue
      await unlink(join(dir, name)).catch(() => undefined)
      await unlink(noteOf(name)).catch(() => undefined)
    }
  }

  // Moves the copy of `fromPath` (if any) to `toPath`. Caller holds the chain.
  const move = async (idx: Index, fromPath: string, toPath: string): Promise<void> => {
    const fromHash = recoveryPathHash(fromPath)
    const entry = idx[fromHash]
    const files = await filesFor(fromHash)
    const newest = entry?.file && files.includes(entry.file) ? entry.file : files.sort().at(-1)
    if (!newest) { if (entry) delete idx[fromHash]; return }
    const savedAt = entry?.savedAt ?? (await stat(join(dir, newest)).then((s) => s.mtimeMs, () => now()))
    const toHash = recoveryPathHash(toPath)
    const file = `${slugOf(toPath)}-${toHash}-${stamp(savedAt)}-outline.md`
    await rename(join(dir, newest), join(dir, file))
    await unlink(noteOf(newest)).catch(() => undefined)
    await writeNote(file, toPath).catch((e) => console.error('[outline-recovery] note', e))
    await removeAll(fromHash)
    await removeAll(toHash, file)
    delete idx[fromHash]
    idx[toHash] = { path: toPath, file, savedAt }
  }

  return {
    save: (realPath, text) => serial(async () => {
      const idx = await load()
      const at = now()
      const hash = recoveryPathHash(realPath)
      const file = `${slugOf(realPath)}-${hash}-${stamp(at)}-outline.md`
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, file), text, 'utf8')
      await writeNote(file, realPath).catch((e) => console.error('[outline-recovery] note', e))
      idx[hash] = { path: realPath, file, savedAt: at }
      await store(idx)
      await removeAll(hash, file)
    }),
    clear: (realPath) => serial(async () => {
      const idx = await load()
      const hash = recoveryPathHash(realPath)
      if (!idx[hash]) return
      delete idx[hash]
      await store(idx)
      await removeAll(hash)
    }),
    read: (realPath) => serial(async () => {
      const entry = (await load())[recoveryPathHash(realPath)]
      if (!entry) return null
      try { return { text: await readFile(join(dir, entry.file), 'utf8'), savedAt: entry.savedAt } } catch { return null }
    }),
    rekey: (from, to, opts = {}) => serial(async () => {
      const idx = await load()
      const pairs: Array<[string, string]> = []
      if (opts.under) {
        const root = from.endsWith(sep) ? from : from + sep
        // An entry stored without its path (rebuilt from the files) takes it from the copy's note.
        for (const [hash, entry] of Object.entries(idx)) if (!entry.path) entry.path = await readNote(entry.file, hash)
        for (const entry of Object.values(idx)) {
          if (entry.path && entry.path.startsWith(root)) pairs.push([entry.path, join(to, entry.path.slice(root.length))])
        }
      } else {
        pairs.push([from, to])
      }
      if (pairs.length === 0) return
      for (const [a, b] of pairs) await move(idx, a, b).catch((e) => console.error('[outline-recovery] rekey', e))
      await store(idx)
    }),
  }
}
