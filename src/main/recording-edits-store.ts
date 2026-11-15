// The only writer of a layered Run's edit sidecar `<runId>.edits.json` (ADR-0043). It never writes the
// Run, its transcript or any media.
//
// A missing sidecar is a fresh, empty edit list. PR 316's versions 1 and 2 are migrated when their
// source binding matches this recording. A newer, unreadable or other-recording sidecar is refused with
// a stated reason and kept unchanged; nothing is written until the owner chooses "Start new edits",
// which moves it aside to a kept copy first. A sidecar holding Git conflict markers is a `git-conflict`
// problem (0.45), named as such, and treated the same way.
//
// Two Macs, one file (0.45, second Mac; wording and file names in src/shared/recording-edits-kept.ts).
// The lock (edits-lock.ts) binds every TalkWeaver process on this Mac, never a sync tool or another Mac,
// so nothing below relies on it for safety. The rules, each simple enough to check by reading:
//
//   R1  Nothing here deletes or writes over an edits file, a kept copy, a captured version or a temporary
//       file that holds bytes, with the one exception R1a. The other removal in the vault is this store's
//       own temporary file once its bytes are held elsewhere (`removeOwnTemp`, two call sites: the install,
//       after the record has settled on those bytes; keepCopy, after the copy is linked). On a failure
//       nothing is removed. Every other change in the vault is a rename to a fresh UUID name or an exclusive
//       create. Tidying copies is a later, owner-driven feature. (writeTextAtomic replaces app-data records
//       and pathway files, never anything in the vault's edits files.)
//   R1a An ordinary save leaves no copy. When an install's capture (what step 3 moved aside, under its private
//       UUID name) is byte-identical to this Mac's `settled` record as it was before the install began (what
//       this Mac itself last saved or saw there) and to the bytes the save was made from (the edits the editor
//       read), it is this Mac's own superseded save. (The second equality keeps a save made from other edits,
//       in another window or a restore, from removing what it did not grow from.) Its bytes go into the
//       record's `previous` slot (replacing the one before) in the same durable write that settles the install,
//       and only after that is the capture removed from the vault (`removeSuperseded`, one call site, which
//       reads the capture again and removes it only when it still holds those bytes). Any other capture
//       (another Mac's version, a sync arrival, an older release's save) stays a listed copy. `previous` is
//       listed in Kept edits as "Previous save on this Mac" and opens and restores like a copy.
//   R2  Kept edits lists every file whose name has any copy-name form, whether or not it parses, however
//       large. Details come from a bounded read; a copy whose details cannot be read there is listed as
//       such, with its file date. Copies holding identical bytes are shown as one row (display only).
//   R3  This Mac's own record comes first. The record (app data) holds `settled`, the bytes this Mac last
//       saw or saved at the edits file, `pending`, the bytes an install is putting there, and `previous`,
//       this Mac's own save before the current one (R1a). Before an install touches the vault, the exact new
//       bytes are written to it durably as pending, beside the bytes the final check found as settled. After
//       the link the new bytes become settled; only then is the temporary file removed. Bytes leave
//       `settled` and `pending` only once a listed copy or `previous` holds them; `previous` is carried over
//       on every write and leaves only when R1a puts a newer own save there (moveRecord, the one writer of
//       the record, keeps a copy first when nothing holds them). On every locked step (open, save,
//       restore, Start new edits), when the record differs from what is at the edits file, the record's
//       bytes are kept as a listed copy in the vault and the owner is told.
//   R4  No ancestry reasoning. "Unchanged" means byte-identical to this Mac's record. Anything else at the
//       edits file is "changed elsewhere": this Mac's recorded version is kept as a copy (no new file when
//       a listed copy already holds those bytes) and the owner is told.
//   R5  Recovery never guesses and never installs an unfinished save. With no edits file and an
//       interrupted install beside it (its temporary file and the version it moved aside), the most
//       recently captured version (capture time in its name, then round, then name) goes back through the
//       same install. Every leftover temporary file then becomes a listed `unfinished-` copy (a rename),
//       and the owner is told when it holds something other than the edits now in place. A plain read
//       (export, checks) that finds no edits file beside a leftover temporary file refuses with a clear
//       message rather than report "no edits".
//
// THE INSTALL (install()). Copies are named `<runId>.edits.<kind>-<time>-<uuid>[-<round>].json`.
//   0. Final check: the edits file is still what the caller read (else MOVED: nothing written; read again).
//   1. Record: the new bytes pending, the checked bytes settled, in this Mac's record (app data; flushed, renamed into place).
//   2. Temporary file `.<runId>.edits.<id>.tmp` (exclusive create, flushed).
//   3. Move whatever is at the edits file now to `<runId>.edits.<kind>-<time>-<id>.json` (a rename: it takes
//      the file as it is at that instant, whoever wrote it).
//   4. Link the temporary file at the edits file exclusively (fails when the name is taken; on a volume
//      without hard links an exclusive create, then the bytes). Taken: back to 3 (`-2`, `-3`, … at most 8).
//   5. Settle the record on the new bytes (the checked bytes are among what step 3 moved aside; if a sync
//      replaced them first, moveRecord keeps them from the record). R1a: a capture identical to this Mac's
//      settled bytes from before step 1 and to the save's base becomes `previous` in this same write.  6. Remove the temporary file.
//   7. R1a: remove that capture (re-read first: only while it still holds those bytes).
// A kill at each point leaves, and the next open does:
//   before 1      the edits file untouched                     → nothing to do
//   after 1       record pending ≠ edits file                  → the new bytes kept as a copy; owner told
//   after 2       as after 1, plus the temporary file          → it becomes the copy (renamed); owner told
//   after 3       no edits file; captured version; temp file   → the captured version back (install); the
//                                                                temp file a listed copy; owner told
//   during 4      (no hard links) a prefix at the edits file   → the prefix stays (a stated problem); the
//                                                                temp file a listed copy; owner told
//   after 4       new bytes in place; record pending           → record settled; temp file a listed copy,
//                                                                silently (it holds what is in place)
//   after 5       new bytes in place; temp file left; an own   → temp file a listed copy; the capture stays
//                 capture both in the vault and in `previous`     listed (bytes in both places, nothing lost)
//   after 7       new bytes in place; the own capture only in  → nothing to do
//                 `previous`
// And whatever a sync puts at the edits file at any instant: on the next open the edits file holds the saved
// bytes, or the record differs and its bytes are kept as a copy (R3). What a sync does to a version no
// TalkWeaver has opened or saved (replaces it before any Mac reads it) is the sync's, outside this guarantee.
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { conflictServiceOf, hasGitConflictMarkers } from './conflict-copies.mjs'
import { withEditsLock, type LockIo } from './edits-lock.ts'
import { EARLIER_LIMIT, earlierOf, editedOn, editsSummary, gitConflictSides, keptStateWords, savedByOf, whenWords, type EditsNotice, type KeptEdits, type KeptReason, type SavedBy } from '../shared/recording-edits-kept.ts'
import { editsGitConflict } from '../shared/git-conflict.ts'
import { applyEditOp, EDITS_MAX_BYTES, emptyEdits, RECORDING_EDITS_VERSION, fitEditsBudget, parseEditsText, type EditOp, type EditsContext, type EditsProblem, type RecordingEdits } from '../shared/recording-edits.ts'

export type EditsLocation = { path: string; runId: string; durationMs: number; fingerprint: string; context?: Omit<EditsContext, 'fingerprint'> }
export type EditsSnapshot = {
  edits: RecordingEdits
  problem: (EditsProblem & { file: string }) | null
  keptAs?: string
  /** The content hash of the bytes these edits were read from or written as; null when there is no file. The editor sends it back with each change. */
  digest?: string | null
  /** Who saved the file (0.45), when it says. */
  savedBy?: SavedBy | null
  /** A version kept instead of lost, or a restore, to tell the owner about. */
  notice?: EditsNotice
  /** A second one. */
  also?: EditsNotice
  /** Any more (rare: several things found at once). */
  more?: EditsNotice[]
  /** How many kept copies are beside the file (on open, Start new edits and restore). */
  keptCount?: number
}
/** The points of an install a test can act at (kill, or put something at the edits file). */
export type InstallStep = 'recorded' | 'temp' | 'moved' | 'linked' | 'settled' | 'released' | 'done'
/** File operations a test can make fail, and the moments a test can act in. */
export type EditsIo = {
  write?: (fd: number, bytes: Uint8Array, offset: number) => number
  flushFolder?: (folder: string) => void
  link?: (from: string, to: string) => void
  /** Before an exclusive create on a volume without hard links. */
  beforeCreate?: () => void
  /** Between moving the edits file aside (step 3) and installing the new one (step 4), every round. */
  beforeLink?: () => void
  /** After each step of an install (the table at the top). */
  at?: (step: InstallStep) => void
  /** Each read of a kept copy while listing, with its size in bytes (a test counts them). */
  onListRead?: (bytes: number) => void
}

type Read = { bytes: Buffer } | { missing: true } | { unreadable: true }
function readSidecar(path: string): Read {
  let fd: number
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW) } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { missing: true }
    return { unreadable: true }
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.size > EDITS_MAX_BYTES) return { unreadable: true }
    try { return { bytes: readFileSync(fd) } } catch { return { unreadable: true } }
  } finally { closeSync(fd) }
}
/** At most `n` bytes from the start of a plain file; null when it cannot be read. */
function readHead(path: string, n: number): Buffer | null {
  let fd: number
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW) } catch { return null }
  try {
    if (!fstatSync(fd).isFile()) return null
    const buf = Buffer.alloc(n)
    const got = readSync(fd, buf, 0, n, 0)
    return buf.subarray(0, got)
  } catch { return null } finally { closeSync(fd) }
}

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
/** The text of exact bytes, for parsing and showing only; null when they are not valid UTF-8. */
function decode(bytes: Uint8Array | null): string | null {
  if (!bytes) return null
  try { return UTF8.decode(bytes) } catch { return null }
}
const sameBytes = (a: Buffer | null | undefined, b: Buffer | null | undefined): boolean => !!a && !!b && a.equals(b)

/** Flush a folder's entry list. Best effort: some platforms cannot open a folder at all. */
export function flushFolder(folder: string): void {
  let fd: number | null = null
  try { fd = openSync(folder, constants.O_RDONLY); fsyncSync(fd) } catch { /* the rename itself is atomic */ } finally { if (fd !== null) try { closeSync(fd) } catch { /* closed */ } }
}

/**
 * Write text atomically as `target` (app data and pathway files; never an edits file or a kept copy, which
 * install() and keepCopy() place without replacing anything). The temporary file is created exclusively,
 * so it is ours from the moment it exists; it is removed on every failure before the rename, and an
 * existing file of the same name (not ours) is never touched. After the rename nothing can turn the write
 * into a failure.
 */
export function writeTextAtomic(target: string, text: string, beforeRename?: () => void, io: EditsIo = {}): void {
  const folder = dirname(target)
  try { if (lstatSync(target).isSymbolicLink() || !lstatSync(target).isFile()) throw Error(`${basename(target)} is not a plain file, so it was not replaced.`) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const temp = join(folder, `.${basename(target)}.${randomUUID()}.tmp`)
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  let owned = true, open = true
  try {
    writeWhole(fd, new TextEncoder().encode(text), io.write)
    closeSync(fd); open = false
    beforeRename?.()
    renameSync(temp, target)
    owned = false
  } finally {
    if (open) try { closeSync(fd) } catch { /* already closed */ }
    if (owned) try { unlinkSync(temp) } catch { /* already gone */ }
  }
  ;(io.flushFolder ?? flushFolder)(folder)
}

function writeWhole(fd: number, bytes: Uint8Array, write: NonNullable<EditsIo['write']> = (f, b, offset) => writeSync(f, b, offset, b.length - offset)): void {
  for (let offset = 0; offset < bytes.length;) { const wrote = write(fd, bytes, offset); if (!(wrote > 0)) throw Error('The disk stopped accepting data'); offset += wrote }
  fsyncSync(fd)
}
const errCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code
/** R1: the one removal in the vault. Only this store's own temporary file, once its bytes are held elsewhere. */
const removeOwnTemp = (path: string): void => { try { unlinkSync(path) } catch { /* already gone */ } }
/**
 * R1a: the one removal of a capture. `path` is a capture this install made under its private UUID name; it is
 * removed only when it still holds exactly `own` (this Mac's superseded save, already durable in `previous`).
 * Anything else, or any failure, leaves it a listed copy.
 */
const removeSuperseded = (path: string, own: Buffer): boolean => {
  const r = readSidecar(path)
  if (!('bytes' in r) || !r.bytes.equals(own)) return false
  try { unlinkSync(path); return true } catch { return false }
}

/**
 * Put `bytes` (already flushed in `from`) at `target` only when nothing is there: a hard link (whole or
 * not at all), or on a volume without hard links an exclusive create and write. 'taken' when something is
 * there. A failure after the exclusive create throws with `created` set: the file cut short is ours, under
 * `target`, for the caller to move aside.
 */
function placeExclusive(from: string, target: string, bytes: Uint8Array, io: EditsIo): 'placed' | 'taken' {
  try { (io.link ?? linkSync)(from, target); return 'placed' } catch (error) {
    if (errCode(error) === 'EEXIST') return 'taken'
  }
  // No hard links on this volume (some network and removable disks).
  io.beforeCreate?.()
  let fd: number
  try { fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) } catch (error) {
    if (errCode(error) === 'EEXIST') return 'taken'
    throw error
  }
  try { writeWhole(fd, bytes, io.write) } catch (error) { throw Object.assign(error instanceof Error ? error : Error(String(error)), { created: true }) } finally { closeSync(fd) }
  return 'placed'
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const stampOf = (d: Date): string => d.toISOString().replace(/[:.]/g, '-')
/** kept: Start new edits and a restore · changed: this Mac's recorded version, found replaced · before: what an install moved aside · unfinished: a save that did not finish. */
type CopyKind = 'kept' | 'changed' | 'before' | 'unfinished'
const KINDS = 'kept|changed|before|unfinished'
/** A new kept copy's name: never taken by anything else, on this Mac or any other (the UUID). */
const copyName = (runId: string, kind: CopyKind, now: Date, id: string = randomUUID(), n = 1): string => `${runId}.edits.${kind}-${stampOf(now)}-${id}${n > 1 ? `-${n}` : ''}.json`
/** Every temporary file this store makes beside the edits file: an install's (`.<runId>.edits.<id>.tmp`) and keepCopy's (`.<runId>.edits.<kind>.<id>.tmp`). */
const tempRe = (runId: string): RegExp => new RegExp(`^\\.${escapeRe(runId)}\\.edits\\.(?:(?:${KINDS})\\.)?(${UUID})\\.tmp$`)
const installTempRe = (runId: string): RegExp => new RegExp(`^\\.${escapeRe(runId)}\\.edits\\.(${UUID})\\.tmp$`)
/** What an install moved aside: its time, its install id, its round. */
const capturedRe = (runId: string): RegExp => new RegExp(`^${escapeRe(runId)}\\.edits\\.(?:kept|changed|before)-([0-9TZ-]+)-(${UUID})(?:-(\\d+))?\\.json$`)

/**
 * The name the first copy of an edits file written by an older release got in earlier 0.45 builds,
 * `<runId>.edits.version-<n>-<uuid>.json` (earlier still `version-<n>.json`); both are listed.
 */
export function olderVersionPath(path: string, runId: string, version: number): string {
  return join(dirname(path), `${runId}.edits.version-${version}-${randomUUID()}.json`)
}

/** The short content hash an edits file is known by (the editor's `digest`, the `earlier` list): of its exact bytes. */
export function editsDigest(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex').slice(0, 16)
}

const parseJson = (text: string | null): unknown => { if (text === null) return null; try { return JSON.parse(text) } catch { return null } }
const versionOf = (raw: unknown): number | null => { const v = raw && typeof raw === 'object' ? (raw as { version?: unknown }).version : undefined; return typeof v === 'number' && Number.isInteger(v) ? v : null }
const revisionOf = (raw: unknown): number => { const v = raw && typeof raw === 'object' ? (raw as { revision?: unknown }).revision : undefined; return Number.isSafeInteger(v) && (v as number) >= 0 ? v as number : 0 }
/** Saved by a TalkWeaver before 0.45 (an edits file this release reads, with no `savedBy`): for the words only. */
const olderSave = (raw: unknown): boolean => { const v = versionOf(raw); return v !== null && v >= 1 && v <= RECORDING_EDITS_VERSION && !savedByOf(raw) }

/**
 * Keep `bytes` as a new copy beside the edits file, `<runId>.edits.<kind>-<time>-<uuid>.json`. Nothing is
 * ever replaced: the copy appears by a hard link from a flushed temporary file (whole or not at all), or, on a
 * volume without hard links, by an exclusive create. Returns the copy's file name. Throws when it cannot be
 * kept (the caller still holds the bytes and changes nothing).
 */
function keepCopy(loc: EditsLocation, kind: CopyKind, bytes: Uint8Array, now: Date, io: EditsIo = {}): string {
  const folder = dirname(loc.path)
  const temp = join(folder, `.${loc.runId}.edits.${kind}.${randomUUID()}.tmp`)
  let fd: number
  try { fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) } catch (error) {
    throw Error(`The other version of these edits could not be kept, so nothing was changed. ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    try { writeWhole(fd, bytes, io.write) } finally { closeSync(fd) }
    for (let n = 0; n < 5; n++) {
      const name = copyName(loc.runId, kind, now)
      if (placeExclusive(temp, join(folder, name), bytes, io) === 'taken') continue
      ;(io.flushFolder ?? flushFolder)(folder)
      // The bytes are at the copy (or still with the caller): the temporary file is only ours.
      removeOwnTemp(temp)
      return name
    }
    throw Error('There is no free name for the copy.')
  } catch (error) {
    // Left in place (a listed `unfinished` copy on the next open); the caller still holds the bytes.
    throw Error(`The other version of these edits could not be kept, so nothing was changed. ${error instanceof Error ? error.message : String(error)}`)
  }
}

type KeptFile = { file: string; reason: KeptReason; version?: number; service?: string }
/** R2: every file beside the edits file with a copy-name form, whatever it holds. */
function keptFiles(loc: EditsLocation): KeptFile[] {
  let names: string[]
  try { names = readdirSync(dirname(loc.path)) } catch { return [] }
  const own = new RegExp(`^${escapeRe(loc.runId)}\\.edits\\.(${KINDS})-[0-9A-Za-z-]+\\.json$`)
  const older = new RegExp(`^${escapeRe(loc.runId)}\\.edits\\.version-(\\d+)(?:-${UUID})?\\.json$`)
  const temp = tempRe(loc.runId)
  const canonical = basename(loc.path)
  const out: KeptFile[] = []
  for (const file of names) {
    if (file === canonical) continue
    if (temp.test(file)) { out.push({ file, reason: 'unfinished' }); continue }
    if (file.startsWith('.')) continue
    const m = own.exec(file)
    if (m) { out.push({ file, reason: REASON_OF[m[1] as CopyKind] }); continue }
    const v = older.exec(file)
    if (v) { out.push({ file, reason: 'older-format', version: Number(v[1]) }); continue }
    // A sync service's copy of the edits file (the outline rules, applied to the .json name).
    if (!file.endsWith('.json')) continue
    const sync = conflictServiceOf(file.slice(0, -5) + '.md', canonical.slice(0, -5) + '.md')
    if (sync) out.push({ file, reason: 'sync-copy', service: SERVICE_NAMES[sync.service] ?? sync.service })
  }
  return out
}
const REASON_OF: Record<CopyKind, KeptReason> = { kept: 'set-aside', changed: 'changed', before: 'before-save', unfinished: 'unfinished' }
const SERVICE_NAMES: Record<string, string> = { onedrive: 'OneDrive', dropbox: 'Dropbox', gdrive: 'Google Drive', icloud: 'iCloud Drive', syncthing: 'Syncthing' }

/** One kept copy read: its exact bytes (a Git side's own), what the editor lists for it, and its edits when it opens. */
type KeptRead = { info: KeptEdits; bytes: Buffer; edits: RecordingEdits | null }

function describeKept(loc: EditsLocation, base: KeptFile, bytes: Buffer, mtime: string | null, side?: 1 | 2): KeptRead {
  const text = decode(bytes)
  const raw = parseJson(text)
  const by = savedByOf(raw)
  const ctx = { ...loc.context, fingerprint: loc.fingerprint }
  const parsed = text === null ? null : parseEditsText(text, loc.durationMs, ctx)
  // A copy made for another recording opens (read only), but is not restored here.
  const other = parsed && !parsed.ok && parsed.problem.kind === 'stale' ? parseEditsText(text as string, loc.durationMs, { ...loc.context, fingerprint: undefined }) : null
  const edits = parsed?.ok ? parsed.edits : other?.ok ? other.edits : null
  const state: KeptEdits['state'] = parsed?.ok ? 'ok' : parsed && !parsed.ok && parsed.problem.kind === 'newer' ? 'newer' : other?.ok ? 'other-recording' : 'unreadable'
  return {
    bytes, edits,
    info: {
      id: side ? `${base.file}#${side}` : base.file, file: base.file, reason: side ? 'git-side' : base.reason,
      at: by?.at ?? mtime, by, version: versionOf(raw) ?? base.version ?? null, state, summary: edits ? editsSummary(edits) : null,
      ...(base.service ? { service: base.service } : {}), ...(side ? { side } : {})
    }
  }
}

/** One kept copy read whole: a copy with Git conflict markers as its two versions; anything else as one, readable or not. */
function readKeptFile(loc: EditsLocation, k: KeptFile, io: EditsIo = {}): KeptRead[] {
  const path = join(dirname(loc.path), k.file)
  const read = readSidecar(path)
  let mtime: string | null = null
  try { mtime = lstatSync(path).mtime.toISOString() } catch { /* gone */ }
  if (!('bytes' in read)) return [{ bytes: Buffer.alloc(0), edits: null, info: { id: k.file, file: k.file, reason: k.reason, at: mtime, by: null, version: k.version ?? null, state: 'unreadable', summary: null, ...(k.service ? { service: k.service } : {}) } }]
  io.onListRead?.(read.bytes.length)
  const text = decode(read.bytes)
  const sides = text !== null && hasGitConflictMarkers(text) ? gitConflictSides(text) : null
  if (sides) return [describeKept(loc, k, Buffer.from(sides[0]), mtime, 1), describeKept(loc, k, Buffer.from(sides[1]), mtime, 2)]
  return [describeKept(loc, k, read.bytes, mtime)]
}

/** How many of the newest copies a listing reads whole, and how many bytes at most; the rest are listed from a small read. */
const LIST_WHOLE = 40
const LIST_WHOLE_BYTES = 8 * 1024 * 1024
const HEAD_BYTES = 4096
/** At most this many bytes read to tell which copies are identical (display grouping only). */
const GROUP_BYTES = 8 * 1024 * 1024

/** Best effort details from the first bytes of a copy: its format version and who saved it, wherever they sit in those bytes. */
function headDetails(text: string): { version: number | null; by: SavedBy | null } {
  const v = /"version"\s*:\s*(\d+)/.exec(text)
  const sb = /"savedBy"\s*:\s*(\{[^{}]*\})/.exec(text)
  return { version: v ? Number(v[1]) : null, by: sb ? savedByOf({ savedBy: parseJson(sb[1]) }) : null }
}

/**
 * Every kept copy, newest first, as the editor lists it (R2: nothing omitted). The newest copies are read
 * whole (their summary and whether they open); beyond LIST_WHOLE of them, or LIST_WHOLE_BYTES, each is listed
 * from its first HEAD_BYTES (format version and who saved it, best effort) and read whole only when opened or
 * restored. Copies holding identical bytes are shown as one row, the newest, naming the others (`same`).
 */
function listKeptInfo(loc: EditsLocation, dir: string, io: EditsIo = {}): KeptEdits[] {
  const folder = dirname(loc.path)
  const files = keptFiles(loc).map((k) => {
    let mtime: Date | null = null, size = 0
    try { const st = lstatSync(join(folder, k.file)); mtime = st.mtime; size = st.size } catch { /* gone */ }
    return { k, mtime, size }
  }).sort((a, b) => (b.mtime?.getTime() ?? 0) - (a.mtime?.getTime() ?? 0) || a.k.file.localeCompare(b.k.file))
  type Row = { info: KeptEdits; size: number; full?: string; head?: string }
  const rows: Row[] = []
  let whole = 0, budget = LIST_WHOLE_BYTES
  for (const { k, mtime, size } of files) {
    if (whole < LIST_WHOLE && size <= budget) {
      whole++; budget -= size
      for (const r of readKeptFile(loc, k, io)) rows.push({ info: r.info, size, ...(r.info.side || r.info.state === 'unreadable' && !r.bytes.length ? {} : { full: editsDigest(r.bytes), head: editsDigest(r.bytes.subarray(0, HEAD_BYTES)) }) })
      continue
    }
    const head = readHead(join(folder, k.file), HEAD_BYTES)
    io.onListRead?.(head?.length ?? 0)
    const text = head ? head.toString('utf8') : ''
    // A Git conflict copy is listed as its two versions, which needs the whole file (rare).
    if (text.includes('<<<<<<< ')) { for (const r of readKeptFile(loc, k, io)) rows.push({ info: r.info, size }); continue }
    const { version: v, by } = headDetails(text)
    const version = v ?? k.version ?? null
    const state: KeptEdits['state'] = head === null ? 'unreadable' : version !== null && version > RECORDING_EDITS_VERSION ? 'newer' : version !== null ? 'ok' : 'unknown'
    rows.push({
      info: { id: k.file, file: k.file, reason: k.reason, at: by?.at ?? mtime?.toISOString() ?? null, by, version, state, summary: null, ...(k.service ? { service: k.service } : {}) },
      size, ...(head ? { head: editsDigest(head), ...(size <= HEAD_BYTES ? { full: editsDigest(head) } : {}) } : {})
    })
  }
  // R1a: this Mac's previous save, from its record (one row, never grouped: it is not a file in the vault).
  const prev = previousRead(loc, dir)
  if (prev) rows.push({ info: prev.info, size: prev.bytes.length })
  // Identical bytes (display only; no file is touched): candidates share size and first bytes, confirmed by a whole read.
  const bySizeHead = new Map<string, Row[]>()
  for (const r of rows) if (r.head) bySizeHead.set(`${r.size}:${r.head}`, [...(bySizeHead.get(`${r.size}:${r.head}`) ?? []), r])
  let groupBudget = GROUP_BYTES
  for (const same of bySizeHead.values()) {
    if (same.length < 2) continue
    for (const r of same) {
      if (r.full) continue
      if (r.size > groupBudget) continue
      const read = readSidecar(join(folder, r.info.file))
      if ('bytes' in read) { groupBudget -= read.bytes.length; io.onListRead?.(read.bytes.length); r.full = editsDigest(read.bytes) }
    }
  }
  const sorted = rows.sort((a, b) => String(b.info.at ?? '').localeCompare(String(a.info.at ?? '')) || a.info.id.localeCompare(b.info.id))
  const first = new Map<string, KeptEdits>()
  const out: KeptEdits[] = []
  for (const r of sorted) {
    const key = r.full ? `${r.size}:${r.full}` : null
    const rep = key ? first.get(key) : undefined
    if (rep) { rep.same = [...(rep.same ?? []), r.info.id]; continue }
    if (key) first.set(key, r.info)
    out.push(r.info)
  }
  return out
}

/** The id Kept edits knows this Mac's previous save by (R1a); never a file name. */
export const PREVIOUS_ID = 'this-mac:previous-save'
/** This Mac's previous save (R1a), read from its record, as Kept edits lists it; null when there is none. */
function previousRead(loc: EditsLocation, dir: string): KeptRead | null {
  const p = readRecord(dir, loc.path)?.previous
  if (!p) return null
  const r = describeKept(loc, { file: '', reason: 'previous-save' }, p, null)
  return { ...r, info: { ...r.info, id: PREVIOUS_ID, local: true } }
}

/**
 * The listed copy (or one side of a Git conflict copy) holding exactly `bytes`, if any: bytes already kept are
 * not kept twice (R4; nothing is deleted either way). Only files of that size are read (and Git conflict copies).
 * A temporary file never counts: one that came from another Mac by sync can be removed there.
 */
function findSameBytes(loc: EditsLocation, bytes: Uint8Array): string | null {
  const folder = dirname(loc.path)
  const want = Buffer.from(bytes)
  for (const k of keptFiles(loc)) {
    if (k.file.startsWith('.')) continue
    let size: number
    try { size = lstatSync(join(folder, k.file)).size } catch { continue }
    if (size === want.length) {
      const r = readSidecar(join(folder, k.file))
      if ('bytes' in r && r.bytes.equals(want)) return k.file
    } else if (size > want.length && (readHead(join(folder, k.file), HEAD_BYTES)?.toString('utf8').includes('<<<<<<< ') ?? false)) {
      if (readKeptFile(loc, k).some((s) => s.bytes.equals(want))) return k.file
    }
  }
  return null
}

/**
 * R3: this Mac's record of the edits file (app data, never the vault). `settled`: the bytes this Mac last saw or
 * saved there. `pending`: the bytes an install is putting there. The settled bytes leave the record only when the
 * edits file or a listed copy holds them.
 */
type MacRecord = { settled: Buffer | null; pending: Buffer | null; previous: Buffer | null }
function recordFile(dir: string, path: string): string {
  return join(dir, `${createHash('sha256').update(path).digest('hex').slice(0, 32)}.json`)
}
function readRecord(dir: string, path: string): MacRecord | null {
  try {
    const v = JSON.parse(readFileSync(recordFile(dir, path), 'utf8')) as { path?: unknown; settled?: unknown; pending?: unknown; previous?: unknown; bytes?: unknown; text?: unknown }
    if (v.path !== path) return null
    const b64 = (x: unknown): Buffer | null => typeof x === 'string' ? Buffer.from(x, 'base64') : null
    // Base64, exact. Records written earlier in 0.45 development hold `bytes`, or `text`.
    const settled = b64(v.settled) ?? b64(v.bytes) ?? (typeof v.text === 'string' ? Buffer.from(v.text, 'utf8') : null)
    return { settled, pending: b64(v.pending), previous: b64(v.previous) }
  } catch { return null }
}
/**
 * Replace this Mac's record, durably (flushed, renamed into place, folder flushed); throws when it cannot. R3: bytes
 * leave `settled` and `pending` only once a listed copy holds them (or `previous`, or one of `held`, copies already
 * made): any that nothing holds are kept as a copy first. `previous` is carried over unless `next.previous` is given:
 * only the install gives it (R1a), with this Mac's own superseded save, which then replaces the earlier one. Returns
 * the copies it made.
 */
function moveRecord(loc: EditsLocation, dir: string, next: { settled: Buffer | null; pending: Buffer | null; previous?: Buffer }, now: Date, io: EditsIo, held: readonly (Buffer | null)[] = []): string[] {
  const old = readRecord(dir, loc.path)
  const previous = next.previous ?? old?.previous ?? null
  const made: string[] = []
  for (const b of [old?.settled, old?.pending]) {
    if (!b || sameBytes(b, next.settled) || sameBytes(b, next.pending) || sameBytes(b, previous) || held.some((h) => sameBytes(h, b))) continue
    if (!findSameBytes(loc, b)) made.push(keepCopy(loc, 'changed', b, now, io))
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeTextAtomic(recordFile(dir, loc.path), JSON.stringify({ path: loc.path, settled: next.settled?.toString('base64') ?? null, pending: next.pending?.toString('base64') ?? null, previous: previous?.toString('base64') ?? null }))
  return made
}

export type EditsSaver = () => { mac: string; app: string } | null

/** The bytes the store writes: the edit list, who saved it (near the start, so a listing reads it cheaply) and the versions it grew from. */
export function serialiseEditsFile(edits: RecordingEdits, savedBy: SavedBy | null, earlier: readonly string[]): string {
  const { version, ...rest } = edits
  return JSON.stringify({ version, ...(savedBy ? { savedBy } : {}), ...rest, ...(earlier.length ? { earlier: earlier.slice(0, EARLIER_LIMIT) } : {}) }) + '\n'
}

const MOVED = Symbol('moved')
const CHANGED_IN_ANOTHER_WINDOW = 'The edits changed in another window. Reopen the recording to see them.'
export const UNFINISHED_SAVE = 'A save of these edits did not finish. Open Edit video for this recording to recover it, then try again.'
/** A version an install moved aside: its listed name and exact bytes (null: it could not be read). */
type Captured = { file: string; bytes: Buffer | null }
const INSTALL_TRIES = 8

/**
 * Put `bytes` at the edits file without ever writing over anything (the install at the top of this file).
 * MOVED: the file is no longer `expected` at the final check (nothing written); the caller reads again and
 * decides again. Otherwise the versions it moved aside that stay listed copies (`kept`), and those that were this
 * Mac's own superseded save, now `previous` in the record and gone from the vault (`superseded`, R1a).
 */
function install(loc: EditsLocation, bytes: Buffer, o: { expected: Buffer | null; base: Buffer | null; kind: CopyKind; now: Date; io: EditsIo; recordDir: string; beforeCheck?: () => void; beforeInstall?: () => void }): { kept: Captured[]; superseded: Captured[] } | typeof MOVED {
  const folder = dirname(loc.path), io = o.io, flush = (): void => (io.flushFolder ?? flushFolder)(folder)
  try { const st = lstatSync(loc.path); if (st.isSymbolicLink() || !st.isFile()) throw Error(`${basename(loc.path)} is not a plain file, so it was not replaced.`) } catch (error) {
    if (errCode(error) !== 'ENOENT') throw error
  }
  // 0. The final check.
  o.beforeCheck?.()
  const again = readSidecar(loc.path)
  if (!('bytes' in again ? sameBytes(again.bytes, o.expected) : 'missing' in again && o.expected === null)) return MOVED
  o.beforeInstall?.()
  // R1a's reference: what this Mac itself last saved or saw at the edits file, as recorded before this install, when
  // it is also exactly what this save was made from.
  const settledBefore = readRecord(o.recordDir, loc.path)?.settled ?? null
  const mine = sameBytes(settledBefore, o.base) ? settledBefore : null
  // 1. This Mac's record first: the exact bytes, pending, beside the bytes the check found (R3). Those stay in the
  //    record until the edits file or a listed copy holds them: a sync may replace them before step 3 moves them.
  moveRecord(loc, o.recordDir, { settled: o.expected, pending: bytes }, o.now, io)
  io.at?.('recorded')
  // 2. The new bytes, whole and flushed, under a name only this save uses.
  const id = randomUUID()
  const temp = join(folder, `.${loc.runId}.edits.${id}.tmp`)
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { writeWhole(fd, bytes, io.write) } finally { closeSync(fd) }
  io.at?.('temp')
  // From here on a failure leaves everything where it is: the next open lists it (R5).
  const captured: string[] = []
  let installed = false
  for (let n = 1; n <= INSTALL_TRIES && !installed; n++) {
    // 3. Whatever is at the edits file now, as it is at this instant, goes to a name no one else uses.
    const name = copyName(loc.runId, o.kind, o.now, id, n)
    try { lstatSync(join(folder, name)); throw Error(`${name} is already there.`) } catch (error) { if (errCode(error) !== 'ENOENT') throw error }
    try { renameSync(loc.path, join(folder, name)); captured.push(name); flush() } catch (error) { if (errCode(error) !== 'ENOENT') throw error }
    io.beforeLink?.()
    if (n === 1) io.at?.('moved')
    // 4. The new bytes only where nothing is: something that arrived since step 3 is moved aside next round.
    try { installed = placeExclusive(temp, loc.path, bytes, io) === 'placed' } catch (error) {
      // A file cut short that this save created (a disk that failed mid-write): moved aside to a listed copy, so the
      // next open finds no edits file and puts back what this save moved aside (R5). A kill here leaves it in place.
      if ((error as { created?: boolean }).created) try { renameSync(loc.path, join(folder, copyName(loc.runId, 'unfinished', o.now))); flush() } catch { /* the next open lists it */ }
      throw error
    }
  }
  if (!installed) throw Error('The edits file kept being replaced while these edits were being saved, so they were not saved. Try again.')
  flush()
  io.at?.('linked')
  const all: Captured[] = captured.map((file) => { const r = readSidecar(join(folder, file)); return { file, bytes: 'bytes' in r ? r.bytes : null } })
  // R1a: a capture holding exactly what this Mac last saved or saw there, and what this save was made from, is its own
  // superseded save. The comparison
  // is on the capture itself (a private name nothing else writes), so a sync replacing the edits file at any instant
  // only ever puts something that differs into a capture, and that stays listed.
  const own = mine ? all.filter((c) => sameBytes(c.bytes, mine)) : []
  const kept = all.filter((c) => !own.includes(c))
  // 5. Settled (the version the check found is normally among the captures; if a sync replaced it before step 3
  //    moved it, moveRecord keeps it from the record now), with an own superseded save as `previous`, in one
  //    durable write.  6. The temporary file: its bytes are installed and held by the record.
  moveRecord(loc, o.recordDir, { settled: bytes, pending: null, ...(own.length && mine ? { previous: mine } : {}) }, o.now, io, kept.map((c) => c.bytes))
  io.at?.('settled')
  removeOwnTemp(temp)
  // 7. R1a: only now, with the new bytes settled and the superseded bytes durable in `previous`, does the capture
  //    leave the vault. A kill before this leaves it a listed copy as well: in two places, never in none.
  const gone = own.filter((c) => removeSuperseded(join(folder, c.file), mine as Buffer))
  if (gone.length) flush()
  io.at?.('released')
  io.at?.('done')
  return { kept: [...kept, ...own.filter((c) => !gone.includes(c))], superseded: gone }
}

/**
 * The captures of installs that did not finish: a version an install moved aside whose temporary file (same id)
 * is still beside it. Oldest first: capture time in the name, then round, then name.
 */
function interruptedCaptures(loc: EditsLocation): { file: string; temp: string }[] {
  let names: string[]
  try { names = readdirSync(dirname(loc.path)) } catch { return [] }
  const temps = new Map<string, string>()
  const tr = installTempRe(loc.runId), cr = capturedRe(loc.runId)
  for (const f of names) { const m = tr.exec(f); if (m) temps.set(m[1], f) }
  const out: { file: string; temp: string; stamp: string; round: number }[] = []
  for (const f of names) { const m = cr.exec(f); if (m && temps.has(m[2])) out.push({ file: f, temp: temps.get(m[2]) as string, stamp: m[1], round: Number(m[3] ?? 1) }) }
  return out.sort((a, b) => a.stamp.localeCompare(b.stamp) || a.round - b.round || a.file.localeCompare(b.file))
}

export function createRecordingEditsStore(deps: {
  locate: (key: unknown) => EditsLocation
  /** Runs immediately before a save's final check of the file (tests). */
  beforeRename?: () => void
  /** Runs after the final check, immediately before this Mac's record is written and the install starts (tests). */
  beforeInstall?: () => void
  now?: () => Date
  io?: EditsIo
  /** This Mac's name and the app version, written into every save (`savedBy`). */
  saver?: EditsSaver
  /** Where this Mac keeps its record of each edits file (app data). Default: beside the lock folder. */
  seenDir?: () => string | null
  /** The lock folder (default: the system temp folder) and process inspection, for tests. */
  lockFolder?: string
  lockIo?: LockIo
}) {
  const io = deps.io ?? {}
  const now = (): Date => deps.now?.() ?? new Date()
  const ctxOf = (loc: EditsLocation): EditsContext => ({ ...loc.context, fingerprint: loc.fingerprint })
  const recordDir = (): string => deps.seenDir?.() ?? join(deps.lockFolder ?? join(tmpdir(), 'talkweaver-locks'), 'edits-records')
  const locked = <T>(loc: EditsLocation, work: () => T): T => withEditsLock(loc.path, work, { folder: deps.lockFolder, io: deps.lockIo })
  // The bytes each digest the editor may name came from (what this process read or wrote), a few per file.
  const seen = new Map<string, Map<string, Buffer>>()
  const remember = (path: string, bytes: Buffer): void => {
    let m = seen.get(path)
    if (!m) seen.set(path, (m = new Map()))
    const d = editsDigest(bytes)
    m.delete(d); m.set(d, bytes)
    while (m.size > 8) m.delete(m.keys().next().value as string)
  }

  type Loaded = EditsSnapshot & { bytes: Buffer | null; text: string | null; digest: string | null; missing: boolean }
  function load(loc: EditsLocation): Loaded {
    const read = readSidecar(loc.path)
    const unreadable = { kind: 'corrupt' as const, message: 'The saved edits for this recording could not be read.', file: loc.path }
    if ('missing' in read) return { edits: emptyEdits(), problem: null, digest: null, savedBy: null, bytes: null, text: null, missing: true }
    if ('unreadable' in read) return { edits: emptyEdits(), problem: unreadable, digest: null, savedBy: null, bytes: null, text: null, missing: false }
    const bytes = read.bytes, digest = editsDigest(bytes), text = decode(bytes)
    // Not valid UTF-8 (a damaged or half-synced file): a problem, with its exact bytes kept as they are.
    if (text === null) return { edits: emptyEdits(), problem: unreadable, digest, savedBy: null, bytes, text: null, missing: false }
    // Two Macs saved edits and Git left both versions in the file: say so before "could not be read" (0.45).
    if (hasGitConflictMarkers(text)) {
      const sides = gitConflictSides(text)
      const a = sides && savedByOf(parseJson(sides[0])), b = sides && savedByOf(parseJson(sides[1]))
      const who = a && b ? ` One version: ${editedOn(a)}. The other: ${editedOn(b)}.` : ''
      return { edits: emptyEdits(), problem: { kind: 'git-conflict', message: editsGitConflict(basename(loc.path)) + who, file: loc.path }, digest, savedBy: null, bytes, text, missing: false }
    }
    const by = savedByOf(parseJson(text))
    const parsed = parseEditsText(text, loc.durationMs, ctxOf(loc))
    if (parsed.ok) return { edits: parsed.edits, problem: null, digest, savedBy: by, bytes, text, missing: false }
    // Newer, or made for another recording: say who saved it, so the owner knows which Mac to look at.
    const who = by && parsed.problem.kind !== 'corrupt' ? ` ${editedOn(by)}.` : ''
    return { edits: emptyEdits(), problem: { ...parsed.problem, message: parsed.problem.message + who, file: loc.path }, digest, savedBy: by, bytes, text, missing: false }
  }
  const snapshot = (s: EditsSnapshot & { bytes?: Buffer | null; text?: string | null; missing?: boolean; kept?: Captured[]; superseded?: Captured[] }): EditsSnapshot => { const { bytes: _bytes, text: _text, missing: _missing, kept: _kept, superseded: _superseded, ...rest } = s; return rest }
  /** How many rows Kept edits has to show: the copies beside the file, and this Mac's previous save (R1a). */
  const keptCountOf = (loc: EditsLocation): number => keptFiles(loc).length + (readRecord(recordDir(), loc.path)?.previous ? 1 : 0)
  /** The notices in the snapshot's fields, in order. */
  const withNotices = (s: EditsSnapshot, notices: readonly EditsNotice[]): EditsSnapshot => {
    const [notice, also, ...more] = notices
    return { ...s, ...(notice ? { notice } : {}), ...(also ? { also } : {}), ...(more.length ? { more } : {}) }
  }

  /**
   * This Mac's record, settled at what it now sees at the edits file (after a step that wrote nothing). Returns a
   * notice when something replaced the recorded version since reconcile looked (it is kept). Best effort: if the
   * record cannot be written, the next open finds the same copy (it does not make another) and tells again.
   */
  function recordSeen(loc: EditsLocation, current: Loaded): EditsNotice | null {
    const dir = recordDir(), bytes = current.bytes
    const rec = readRecord(dir, loc.path)
    if (rec && !rec.pending && (rec.settled ? sameBytes(rec.settled, bytes) : bytes === null)) return null
    try {
      const made = moveRecord(loc, dir, { settled: bytes, pending: null }, now(), io)
      return made.length ? { kind: 'replaced', copy: made[0], mine: savedByOf(parseJson(decode(rec?.settled ?? null))), by: current.savedBy ?? null, gone: current.missing } : null
    } catch { return null /* app data not writable: saves refuse */ }
  }

  /**
   * Before every locked step: this Mac's record against the edits file (R3, R4), an interrupted install with no
   * edits file (R5), then leftover temporary files listed. Returns what to tell the owner. The record itself is
   * moved on by the step (an install, or recordSeen once the step has succeeded), so a step that is refused
   * leaves it, and the next open tells the owner again (finding the copy kept here, not making another).
   */
  function reconcile(loc: EditsLocation): EditsNotice[] {
    const folder = dirname(loc.path), dir = recordDir()
    const notices: EditsNotice[] = []
    const rec = readRecord(dir, loc.path)
    const cur = load(loc)
    // R3/R4: what this Mac recorded is not what is there: its bytes are kept, and the owner told.
    const hold = (bytes: Buffer, kind: CopyKind): string => findSameBytes(loc, bytes) ?? keepCopy(loc, kind, bytes, now(), io)
    if (rec?.pending && !sameBytes(rec.pending, cur.bytes)) {
      // An install that did not finish (or whose result something replaced): what it was saving is kept.
      notices.push({ kind: 'interrupted', copy: hold(rec.pending, 'unfinished'), restored: false })
      if (rec.settled && !sameBytes(rec.settled, cur.bytes)) hold(rec.settled, 'changed')
    } else if (rec?.pending) {
      // Installed: the version it replaced is held too (normally the install moved it aside: found, not copied).
      if (rec.settled) hold(rec.settled, 'changed')
    } else if (rec?.settled && !sameBytes(rec.settled, cur.bytes)) {
      notices.push({ kind: 'replaced', copy: hold(rec.settled, 'changed'), mine: savedByOf(parseJson(decode(rec.settled))), by: cur.savedBy ?? null, gone: cur.missing, ...(cur.bytes && olderSave(parseJson(cur.text)) ? { older: true } : {}) })
    }
    // R5: no edits file and an install that did not finish: the newest version it moved aside goes back.
    if (cur.missing) {
      const caps = interruptedCaptures(loc)
      for (const cap of [...caps].reverse()) {
        const r = readSidecar(join(folder, cap.file))
        if (!('bytes' in r)) continue
        if (install(loc, r.bytes, { expected: null, base: r.bytes, kind: 'before', now: now(), io, recordDir: dir }) === MOVED) break
        const told = notices.find((n): n is Extract<EditsNotice, { kind: 'interrupted' }> => n.kind === 'interrupted')
        if (told) told.restored = true
        else notices.push({ kind: 'interrupted', copy: cap.temp, restored: true })
        break
      }
    }
    // R5: every leftover temporary file becomes a listed copy (a rename; nothing removed).
    let names: string[] = []
    try { names = readdirSync(folder) } catch { /* no folder */ }
    const tr = tempRe(loc.runId), renamed = new Map<string, string>()
    const atFile = readSidecar(loc.path)
    for (const f of names) {
      if (!tr.test(f)) continue
      const to = copyName(loc.runId, 'unfinished', now())
      try { renameSync(join(folder, f), join(folder, to)) } catch { continue }
      renamed.set(f, to)
      if (notices.some((n) => n.kind === 'interrupted' || ('copy' in n && n.copy === f))) continue
      const r = readSidecar(join(folder, to))
      if ('bytes' in r && !('bytes' in atFile && atFile.bytes.equals(r.bytes))) notices.push({ kind: 'interrupted', copy: to, restored: false })
    }
    if (renamed.size) (io.flushFolder ?? flushFolder)(folder)
    for (const n of notices) if ('copy' in n && n.copy && renamed.has(n.copy)) n.copy = renamed.get(n.copy) as string
    return notices
  }

  /** The editor's notice for versions an install moved aside that are not what the save grew from: the newest (R1a never removes these). */
  const changedNotice = (kept: readonly Captured[], base: Buffer | null): EditsNotice | null => {
    const last = kept.filter((c) => !sameBytes(c.bytes, base)).at(-1)
    if (!last) return null
    const raw = parseJson(decode(last.bytes))
    return { kind: 'changed', copy: last.file, by: savedByOf(raw), ...(olderSave(raw) ? { older: true } : {}) }
  }

  /**
   * Install `next`, grown from `base`, while the file is still `expected` at the final check (MOVED otherwise:
   * the caller reads again and decides again). Whatever is at the file is moved aside and listed (install()).
   */
  function write(loc: EditsLocation, next: RecordingEdits, base: Buffer | null, expected: Buffer | null, kind: CopyKind): (Loaded & { kept: Captured[]; superseded: Captured[] }) | typeof MOVED {
    const fitted = fitEditsBudget({ ...next, recording: loc.fingerprint })
    const who = deps.saver?.() ?? null
    const savedBy: SavedBy | null = who ? { mac: who.mac, app: who.app, at: now().toISOString() } : null
    const earlier = base === null ? [] : [editsDigest(base), ...earlierOf(parseJson(decode(base)))]
    const text = fitted && serialiseEditsFile(fitted, savedBy, earlier)
    // Exactly what the reader would make of these bytes: a change it would refuse is never written.
    if (!fitted || !text || !parseEditsText(text, loc.durationMs, ctxOf(loc)).ok) throw Error('There are too many cuts to save. Use the whole recording, then cut again.')
    const bytes = Buffer.from(text, 'utf8')
    const done = install(loc, bytes, { expected, base, kind, now: now(), io, recordDir: recordDir(), beforeCheck: deps.beforeRename, beforeInstall: deps.beforeInstall })
    if (done === MOVED) return MOVED
    remember(loc.path, bytes)
    return { edits: fitted, problem: null, digest: editsDigest(bytes), savedBy, bytes, text, missing: false, kept: done.kept, superseded: done.superseded }
  }

  function keptEntry(loc: EditsLocation, id: unknown): KeptRead {
    if (typeof id !== 'string') throw Error('Choose a kept copy.')
    if (id === PREVIOUS_ID) {
      const prev = previousRead(loc, recordDir())
      if (!prev) throw Error('There is no previous save of these edits on this Mac.')
      return prev
    }
    const file = id.replace(/#[12]$/, '')
    const k = keptFiles(loc).find((f) => f.file === file)
    const found = k ? readKeptFile(loc, k, io).find((r) => r.info.id === id) : undefined
    if (!found) throw Error('That kept copy is no longer beside the recording.')
    return found
  }

  return {
    /**
     * The edits as they are, for main's own use (export, checks): nothing kept, nothing recorded, no notice.
     * No edits file beside a leftover temporary file (a save that did not finish) is never "no edits": it is
     * looked at again under the lock, and refused with UNFINISHED_SAVE until the editor recovers it (R5).
     */
    read(key: unknown): EditsSnapshot {
      const loc = deps.locate(key)
      const first = load(loc)
      if (!first.missing) return snapshot(first)
      return locked(loc, () => {
        const now_ = load(loc)
        if (!now_.missing) return snapshot(now_)
        let names: string[] = []
        try { names = readdirSync(dirname(loc.path)) } catch { /* no folder: no edits */ }
        const tr = tempRe(loc.runId)
        if (names.some((f) => tr.test(f))) throw Error(UNFINISHED_SAVE)
        return snapshot(now_)
      })
    },
    /** The edits as the editor opens them, after reconcile (this Mac's last edits kept if replaced; an unfinished save recovered). */
    get(key: unknown): EditsSnapshot {
      const loc = deps.locate(key)
      return locked(loc, () => {
        const notices = reconcile(loc)
        const current = load(loc)
        const late = recordSeen(loc, current)
        if (current.bytes !== null) remember(loc.path, current.bytes)
        return withNotices({ ...snapshot(current), keptCount: keptCountOf(loc) }, late ? [...notices, late] : notices)
      })
    },
    /**
     * Apply one operation to the edits the editor shows: those it read as `digest` (null: there was no file),
     * or, without a digest (callers before 0.45), those of `revision`. When the file is still those bytes, the
     * change is written. When it changed since (another Mac's sync, another window), the editor's edits with
     * this change are installed and the version that was there is moved aside as a copy, and the snapshot says
     * so (`notice`). Without a digest a change is refused as before. Throws when the file holds a problem and
     * the editor read it so, or when what is there cannot be read (nothing is written).
     */
    apply(key: unknown, op: EditOp, revision: number, digest?: string | null): EditsSnapshot {
      const loc = deps.locate(key)
      return locked(loc, () => {
        const found = reconcile(loc)
        for (let attempt = 0; attempt < 3; attempt++) {
          const current = load(loc)
          if (current.digest === null && current.problem) throw Error(`${current.problem.message} It was kept unchanged. Choose Start new edits to continue.`)
          const changed = digest !== undefined && current.digest !== digest
          if (!changed) {
            if (current.problem) throw Error(`${current.problem.message} It was kept unchanged. Choose Start new edits to continue.`)
            if (digest === undefined && revision !== current.edits.revision) throw Error(CHANGED_IN_ANOTHER_WINDOW)
            const next = applyEditOp(current.edits, op, loc.durationMs)
            if (next === current.edits) { const late = recordSeen(loc, current); return withNotices(snapshot(current), late ? [...found, late] : found) }
            const done = write(loc, next, current.bytes, current.bytes, 'before')
            if (done === MOVED) continue
            const notice = changedNotice(done.kept, current.bytes)
            return withNotices({ ...snapshot(done), keptCount: keptCountOf(loc) }, notice ? [notice, ...found] : found)
          }
          // Changed under the editor: the editor's own edits are the ones it read as `digest`.
          const baseBytes = digest === null ? null : seen.get(loc.path)?.get(digest as string)
          if (baseBytes === undefined) throw Error(CHANGED_IN_ANOTHER_WINDOW)
          const baseText = decode(baseBytes)
          const base = baseBytes === null ? { ok: true as const, edits: emptyEdits() } : baseText === null ? null : parseEditsText(baseText, loc.durationMs, ctxOf(loc))
          if (!base?.ok) throw Error(CHANGED_IN_ANOTHER_WINDOW)
          const applied = applyEditOp(base.edits, op, loc.durationMs)
          // A revision above both, so neither Mac's guard mistakes the other's file for its own.
          const next = { ...applied, revision: Math.max(base.edits.revision, revisionOf(parseJson(current.text))) + 1 }
          const done = write(loc, next, baseBytes, current.bytes, 'before')
          if (done === MOVED) continue
          const notice = changedNotice(done.kept, baseBytes)
          return withNotices({ ...snapshot(done), keptCount: keptCountOf(loc) }, notice ? [notice, ...found] : found)
        }
        throw Error('These edits kept changing while they were being saved, so nothing was saved. Try again.')
      })
    },
    /** Keep an unreadable, newer or other-recording sidecar beside a fresh one. Only on the owner's explicit choice. */
    startFresh(key: unknown): EditsSnapshot {
      const loc = deps.locate(key)
      return locked(loc, () => {
        const found = reconcile(loc)
        const current = load(loc)
        if (!current.problem) { const late = recordSeen(loc, current); return withNotices({ ...snapshot(current), keptCount: keptCountOf(loc) }, late ? [...found, late] : found) }
        // The file as it is at this instant goes to a name no one else uses (never renamed over anything).
        const kept = join(dirname(loc.path), copyName(loc.runId, 'kept', now()))
        try { lstatSync(kept); throw Error(`${basename(kept)} is already there.`) } catch (error) { if (errCode(error) !== 'ENOENT') throw error }
        let moved = true
        try { renameSync(loc.path, kept) } catch (error) { if (errCode(error) === 'ENOENT') moved = false; else throw error }
        ;(io.flushFolder ?? flushFolder)(dirname(loc.path))
        // What this step read, if a sync replaced it before the move, is kept before the record lets it go.
        if (current.bytes) { const r = readSidecar(kept); if (!('bytes' in r && r.bytes.equals(current.bytes))) findSameBytes(loc, current.bytes) ?? keepCopy(loc, 'changed', current.bytes, now(), io) }
        try { moveRecord(loc, recordDir(), { settled: null, pending: null }, now(), io) } catch { /* the copy is found, not made again, next time */ }
        const set: EditsNotice[] = moved ? [{ kind: 'set-aside', copy: basename(kept) }] : []
        return withNotices({ edits: emptyEdits(), problem: null, ...(moved ? { keptAs: kept } : {}), digest: null, savedBy: null, keptCount: keptCountOf(loc) }, [...set, ...found])
      })
    },
    /** Every kept copy of these edits, newest first, identical ones as one row (the newest read whole; the rest read when opened). */
    listKept(key: unknown): KeptEdits[] {
      return listKeptInfo(deps.locate(key), recordDir(), io)
    },
    /** One kept copy's edits, to show without changing anything. */
    openKept(key: unknown, id: unknown): { kept: KeptEdits; edits: RecordingEdits } {
      const loc = deps.locate(key)
      const k = keptEntry(loc, id)
      if (!k.edits) throw Error(keptStateWords(k.info) ?? 'This copy could not be read.')
      return { kept: k.info, edits: k.edits }
    },
    /** Make a kept copy the edits. The edits it replaces (whatever is there at the instant of the install) are moved aside as a copy; the copy itself stays. */
    restoreKept(key: unknown, id: unknown): EditsSnapshot {
      const loc = deps.locate(key)
      return locked(loc, () => {
        const found = reconcile(loc)
        for (let attempt = 0; attempt < 3; attempt++) {
          const k = keptEntry(loc, id)
          if (k.info.state !== 'ok' || !k.edits) throw Error(keptStateWords(k.info) ?? 'This copy could not be read.')
          const read = readSidecar(loc.path)
          if ('unreadable' in read) throw Error('The edits now beside the recording could not be read, so they could not be kept and nothing was restored.')
          const current = 'bytes' in read ? read.bytes : null
          const next = { ...k.edits, revision: Math.max(k.edits.revision, revisionOf(parseJson(decode(current)))) + 1 }
          const done = write(loc, next, k.bytes, current, 'kept')
          if (done === MOVED) continue
          const restored: EditsNotice = { kind: 'restored', copy: done.kept[0]?.file ?? null, from: whenWords(k.info.at, now()), ...(done.superseded.length && !done.kept.length ? { previous: true } : {}) }
          return withNotices({ ...snapshot(done), keptCount: keptCountOf(loc) }, [restored, ...found])
        }
        throw Error('These edits kept changing while they were being restored, so nothing was restored. Try again.')
      })
    }
  }
}
export type RecordingEditsStore = ReturnType<typeof createRecordingEditsStore>
