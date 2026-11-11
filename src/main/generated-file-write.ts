// Generated output (the presenter's deck file beside a talk, the preview variants, and other HTML the
// app makes from a compile) is written without holding the main process and without ever being seen
// half-written.
//
// The bytes go to a temporary file in the same folder, asynchronously, and only a finished file is
// renamed onto the real name; a rename within one folder replaces the old file in one step. A failed
// write leaves the previous file as it was and removes its temporary file. Not for the talk outline:
// the author's own file has its own save path, with its own guards.
//
// Writes to the same file run one at a time, in the order asked for, and at most one waits behind the
// running one: a slow older revision can never be renamed over a newer one, and a burst of requests
// keeps at most two payloads alive (the running write's and the newest waiting one).
//
// No Electron import: plain-Node tests load this file.
import { randomBytes } from 'node:crypto'
import { open, rename, unlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export type GeneratedFileOps = {
  writeFile: (path: string, data: string | Uint8Array) => Promise<void>
  rename: (from: string, to: string) => Promise<void>
  unlink: (path: string) => Promise<void>
  /** The 12 hex digits of a temporary file's name (tests choose them to force a collision). */
  tempSuffix?: () => string
}
/** The part of a FileHandle used here (tests pass a fake that writes short). */
export type WritableHandle = {
  write(buffer: Uint8Array, offset: number, length: number): Promise<{ bytesWritten: number }>
  close(): Promise<void>
}
/** Characters encoded per step: about 4 MB, a few milliseconds of UTF-8 encoding. */
const CHUNK_CHARS = 4 * 1024 * 1024

/** Write every byte of `bytes`, however few each call takes; no progress at all is a failure. */
async function writeAll(handle: WritableHandle, bytes: Uint8Array): Promise<void> {
  for (let offset = 0; offset < bytes.byteLength;) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset)
    if (!(bytesWritten > 0)) throw new Error('The file could not be written (no bytes were taken).')
    offset += bytesWritten
  }
}

/** Write a string as UTF-8 a slice at a time. writeFile(path, string) encodes the WHOLE string on the
 *  calling thread before any byte is written (measured: 250 ms on a 138 MB presenter deck); a slice
 *  at a time, each awaited, gives the event loop a turn between slices. A slice never ends between
 *  the two halves of a surrogate pair, so the bytes are exactly Buffer.from(text, 'utf8'). */
export async function writeTextInSlices(
  path: string,
  text: string,
  chunkChars = CHUNK_CHARS,
  // Created exclusively: an entry already under the temporary name (a stray file, a link) is never
  // opened or written through; the write fails with EEXIST and is retried under another name.
  openFile: (path: string) => Promise<WritableHandle> = (p) => open(p, 'wx'),
): Promise<void> {
  const handle = await openFile(path)
  try {
    for (let start = 0; start < text.length;) {
      let end = Math.min(start + chunkChars, text.length)
      const last = text.charCodeAt(end - 1)
      if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1
      if (end <= start) end = Math.min(start + 2, text.length)
      await writeAll(handle, Buffer.from(text.slice(start, end), 'utf8'))
      start = end
    }
  } finally {
    await handle.close()
  }
}

const fsOps: GeneratedFileOps = {
  writeFile: (path, data) => typeof data === 'string' ? writeTextInSlices(path, data) : writeFile(path, data, { flag: 'wx' }),
  rename,
  unlink,
}

// Per file: the write running now, and at most ONE waiting to run after it. A newer request replaces
// the waiting one (only the newest content is worth writing, and a superseded deck-sized payload is
// not kept alive); every caller it displaced is settled with the outcome of the write that replaced
// it, so when it resolves the file holds that newer content.
type Waiter = { resolve: () => void; reject: (error: unknown) => void }
type Pending = { data: string | Uint8Array; ops: GeneratedFileOps; waiters: Waiter[] }
const slots = new Map<string, { pending: Pending | null }>()

/** Write `data` to `path` by temporary file + rename, after the write to the same path already
 *  running (if any). Rejects (and leaves `path` as the previous write left it) on failure. A request
 *  overtaken by a newer one before it started is not written; it settles with the newer write. */
export function writeGeneratedFile(path: string, data: string | Uint8Array, ops: GeneratedFileOps = fsOps): Promise<void> {
  const target = resolve(path)
  return new Promise<void>((resolveCaller, rejectCaller) => {
    const waiter: Waiter = { resolve: resolveCaller, reject: rejectCaller }
    const slot = slots.get(target)
    if (slot) {
      // Something is running: this becomes the one waiting write, taking over any older waiter.
      const waiters = slot.pending ? [...slot.pending.waiters, waiter] : [waiter]
      slot.pending = { data, ops, waiters }
      return
    }
    const fresh = { pending: null as Pending | null }
    slots.set(target, fresh)
    run(target, path, fresh, { data, ops, waiters: [waiter] })
  })
}

function run(target: string, path: string, slot: { pending: Pending | null }, job: Pending): void {
  writeOnce(path, job.data, job.ops).then(
    () => { for (const w of job.waiters) w.resolve() },
    (error: unknown) => { for (const w of job.waiters) w.reject(error) },
  ).finally(() => {
    const next = slot.pending
    slot.pending = null
    if (next) run(target, path, slot, next)
    else if (slots.get(target) === slot) slots.delete(target)
  })
}

const TEMP_ATTEMPTS = 3
const isExists = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'EEXIST'

async function writeOnce(path: string, data: string | Uint8Array, ops: GeneratedFileOps): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const temp = `${path}.${ops.tempSuffix?.() ?? randomBytes(6).toString('hex')}.tmp`
    try {
      await ops.writeFile(temp, data)
    } catch (error) {
      // EEXIST: the name belongs to an entry that is not ours; leave it and take another name.
      if (isExists(error)) { if (attempt < TEMP_ATTEMPTS) continue; throw error }
      await ops.unlink(temp).catch(() => {})
      throw error
    }
    try {
      await ops.rename(temp, path)
    } catch (error) {
      await ops.unlink(temp).catch(() => {})
      throw error
    }
    return
  }
}
