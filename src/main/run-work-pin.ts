// The pin writer and reader (ADR-0040 decision 5; work-files-and-sessions ticket 14).
//
// On a Run's first publish of a phase the work file's bytes are copied into the Run's own folder,
// `<vault>/_PRESENTATIONS/<talk>/<run id>/work-<phase>.md`, and the Run records the pinned revision:
// file id, title, `revision`, the sha256 of the copy's bytes and the copy's vault-relative path. Every
// later push and page build of that phase reads the copy (`readPinnedWork`), so an edit to the work
// file reaches only Runs not yet sent. Publishing again (after an unpublish) reuses the pin.
//
// Write path rules:
//   - the copy is written only inside the Run's folder. The Run folder must be a real folder (a link
//     is refused); the talk folder may be a link to another folder INSIDE the vault (it is accepted, and
//     the Run folder is checked against its real path), but a talk folder that resolves outside the
//     vault is refused;
//   - an existing copy at the copy's name with no pin on the Run record (left by an earlier attempt, or
//     put there by hand) is replaced only when its bytes are the work file's: otherwise the pin is
//     refused (`work-pin-copy-exists`), never overwritten silently;
//   - the copy is written to a temporary file in that folder, then renamed; the Run record is written
//     after it, through the atomic Run writer, so a failed copy leaves the Run record unchanged;
//   - the copy path on a Run record is JSON anyone can edit: it is used only when it names exactly
//     the file this module writes for that Run and phase, it is a plain file (not a link), and its
//     bytes still hash to the recorded sha256.
//
// Work files are read from `<vault>/Work files/<file id>.md` (ticket 07's location), contained in the
// vault: the file's real path (links resolved) must be a plain file inside the vault's real path before
// a byte is read, so a link to a FIFO or a device (`/dev/zero`) never blocks the main process. The bytes must be UTF-8: the hash is `workFileHash` of the decoded text, which equals the
// sha256 of the bytes exactly when they are valid UTF-8 (a BOM is kept).

import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { dirname, join, relative, resolve, sep } from 'path'
import { readWorkFile, type WorkFileReading } from '../shared/work-file.ts'
import { workFileHash } from '../shared/work-file-hash.ts'
import { LEGACY_SECTION_FILE_ID, normaliseRunWork, safeCopyPath, WORK_FILE_ID, type Phase, type PinnedRevision } from '../shared/run-work.ts'
import { pathStaysInside } from './path-containment.ts'
import { isSafeRunId, isSafeTalkSlug, persistRunForTalk, readRunForTalk, talkRunFolderForTalk, type RunRecord } from './runs.ts'

export const WORK_FILES_FOLDER = 'Work files'

export type PinError =
  | 'run-not-found' | 'run-path-unsafe' | 'run-folder-unsafe'
  | 'work-not-attached' | 'work-file-id-reserved' | 'work-not-pinned'
  | 'work-file-path-unsafe' | 'work-file-missing' | 'work-file-not-utf8' | 'work-file-not-ready'
  | 'work-file-id-mismatch' | 'work-file-revision-missing' | 'work-pin-file-mismatch' | 'work-pin-invalid'
  | 'work-pin-copy-unsafe' | 'work-pin-copy-missing' | 'work-pin-copy-changed' | 'work-pin-copy-failed' | 'work-pin-copy-exists'

export interface PinnedWork {
  pinned: PinnedRevision
  /** The copy's text, exactly as stored (what every push and page build of the phase uses). */
  text: string
  reading: WorkFileReading
}

export interface PinResult extends PinnedWork {
  run: RunRecord
  /** False when the phase was already pinned and the existing pin was reused. */
  created: boolean
}

function fail(code: PinError): never {
  throw new Error(code)
}

function lexists(path: string): boolean {
  try { lstatSync(path); return true } catch { return false }
}

function realOrNull(path: string): string | null {
  try { return realpathSync(path) } catch { return null }
}

function strictlyInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep) && resolve(parent, rel) === child
}

/** The copy's file name in the Run folder. One per phase: a phase is pinned once. */
export function pinnedCopyName(phase: Phase): string {
  return `work-${phase}.md`
}

/** The vault-relative copy path the pin records, POSIX separators. */
export function pinnedCopyPath(talkSlug: string, runId: string, phase: Phase): string {
  return `_PRESENTATIONS/${talkSlug}/${runId}/${pinnedCopyName(phase)}`
}

/**
 * The Run's own folder, `<vault>/_PRESENTATIONS/<talk>/<run id>`, checked: both names safe, the talk
 * folder inside the vault once links are resolved, and the Run folder — when it exists — a real
 * folder (not a link) whose real path is the talk folder's real path plus the run id. With `create`
 * the talk and Run folders are made first (the Run folder without `recursive`, so nothing above it is
 * created through a link). Null when any check fails.
 */
export function runFolder(vaultRoot: string, talkSlug: string, runId: string, create: boolean): string | null {
  if (!isSafeTalkSlug(talkSlug) || !isSafeRunId(runId)) return null
  const talkFolder = talkRunFolderForTalk(vaultRoot, talkSlug)
  if (!talkFolder) return null
  const folder = join(talkFolder, runId)
  if (create) {
    try { mkdirSync(talkFolder, { recursive: true }) } catch { return null }
  }
  const realVault = realOrNull(resolve(vaultRoot))
  const realTalk = realOrNull(talkFolder)
  if (!realVault || !realTalk || !strictlyInside(realVault, realTalk)) return null
  if (!lexists(folder)) {
    if (!create) return null
    try { mkdirSync(folder) } catch { return null }
  }
  let stat
  try { stat = lstatSync(folder) } catch { return null }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return null
  return realOrNull(folder) === join(realTalk, runId) ? folder : null
}

/** `<vault>/Work files/<id>.md`, contained in the vault (a link out of it is refused). */
export function workFilePath(vaultRoot: string, fileId: string): string | null {
  if (!WORK_FILE_ID.test(fileId) || fileId === LEGACY_SECTION_FILE_ID) return null
  const path = join(resolve(vaultRoot), WORK_FILES_FOLDER, `${fileId}.md`)
  return pathStaysInside(vaultRoot, path) ? path : null
}

/**
 * A work file's bytes, read only once its real path (links resolved) is known to be a plain file inside
 * the vault's real path: a link to a FIFO, a device or anything outside the vault is never opened.
 * Throws `work-file-path-unsafe` or `work-file-missing`.
 */
export function readWorkFileBytes(vaultRoot: string, fileId: string): Buffer {
  const source = workFilePath(vaultRoot, fileId)
  if (!source) fail('work-file-path-unsafe')
  const realVault = realOrNull(resolve(vaultRoot))
  const real = realOrNull(source)
  if (!real) fail('work-file-missing')
  if (!realVault || !strictlyInside(realVault, real) || !pathStaysInside(vaultRoot, source)) fail('work-file-path-unsafe')
  let realStat
  try { realStat = statSync(real) } catch { fail('work-file-missing') }
  if (!realStat.isFile()) fail('work-file-path-unsafe')
  try { return readFileSync(real) } catch { fail('work-file-missing') }
}

export function decodeUtf8(bytes: Buffer): string | null {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch { return null }
}

/**
 * The copy a pin names, validated on read: the recorded path must be exactly the one this module
 * writes for the Run and phase, the Run folder must pass `runFolder`, the copy must be a plain file
 * (not a link) inside it, and its bytes must hash to the recorded sha256 and decode as UTF-8.
 */
function readCopy(vaultRoot: string, talkSlug: string, runId: string, phase: Phase, pinned: PinnedRevision): PinnedWork {
  if (!safeCopyPath(pinned.copy) || pinned.copy !== pinnedCopyPath(talkSlug, runId, phase)) fail('work-pin-copy-unsafe')
  const folder = runFolder(vaultRoot, talkSlug, runId, false)
  if (!folder) fail(lexists(join(resolve(vaultRoot), '_PRESENTATIONS', talkSlug, runId)) ? 'work-pin-copy-unsafe' : 'work-pin-copy-missing')
  const path = join(folder, pinnedCopyName(phase))
  let stat
  try { stat = lstatSync(path) } catch { fail('work-pin-copy-missing') }
  if (stat.isSymbolicLink() || !stat.isFile()) fail('work-pin-copy-unsafe')
  let bytes: Buffer
  try { bytes = readFileSync(path) } catch { fail('work-pin-copy-missing') }
  const text = decodeUtf8(bytes)
  if (text === null || workFileHash(text) !== pinned.sha256.toLowerCase()) fail('work-pin-copy-changed')
  return { pinned, text, reading: readWorkFile(text) }
}

/**
 * The pinned copy of a Run's phase, for every push and page build after the first publish. Throws
 * `work-not-pinned` when the phase has no pin, and a `work-pin-copy-*` code when the recorded copy is
 * unsafe, missing or no longer the pinned bytes.
 */
export function readPinnedWork(vaultRoot: string, talkSlug: string, runId: string, phase: Phase): PinnedWork {
  if (!isSafeTalkSlug(talkSlug) || !isSafeRunId(runId)) fail('run-path-unsafe')
  const run = readRunForTalk(vaultRoot, talkSlug, runId)
  if (!run) fail('run-not-found')
  const pinned = run.work?.[phase]?.pinned
  if (!pinned) fail('work-not-pinned')
  return readCopy(vaultRoot, talkSlug, runId, phase, pinned)
}

/**
 * Pin the work file attached to a Run's phase, on the first publish of that phase. A phase already
 * pinned keeps its pin (the copy is checked, nothing is written). Otherwise the work file is read,
 * must read with no blocking finding and carry its own id and a revision, is copied into the Run's
 * folder, and the pin is recorded on the Run. A failure before the record is written leaves the Run
 * record as it was. Throws with a `PinError` code.
 */
export function pinRunWork(vaultRoot: string, talkSlug: string, runId: string, phase: Phase, now: () => Date = () => new Date()): PinResult {
  if (!isSafeTalkSlug(talkSlug) || !isSafeRunId(runId)) fail('run-path-unsafe')
  const run = readRunForTalk(vaultRoot, talkSlug, runId)
  if (!run) fail('run-not-found')
  const work = run.work?.[phase]
  if (!work) fail('work-not-attached')
  if (work.fileId === LEGACY_SECTION_FILE_ID) fail('work-file-id-reserved')
  if (work.pinned) {
    if (work.pinned.fileId !== work.fileId) fail('work-pin-file-mismatch')
    return { run, created: false, ...readCopy(vaultRoot, talkSlug, runId, phase, work.pinned) }
  }

  // The source: the work file's bytes, read once; the hash, the reading and the copy all come from them.
  const bytes = readWorkFileBytes(vaultRoot, work.fileId)
  const text = decodeUtf8(bytes)
  if (text === null) fail('work-file-not-utf8')
  const reading = readWorkFile(text)
  if (!reading.ok) fail('work-file-not-ready')
  if (reading.definition.id !== work.fileId) fail('work-file-id-mismatch')
  if (reading.revision === null) fail('work-file-revision-missing')
  const pinned: PinnedRevision = {
    fileId: work.fileId,
    title: reading.definition.title,
    revision: reading.revision,
    sha256: reading.hash,
    copy: pinnedCopyPath(talkSlug, runId, phase),
    pinnedAt: now().toISOString()
  }
  // The record must survive its own reader (title length, copy path syntax) before anything is written.
  if (!normaliseRunWork({ ...work, pinned }, phase)?.pinned) fail('work-pin-invalid')

  const folder = runFolder(vaultRoot, talkSlug, runId, true)
  if (!folder) fail('run-folder-unsafe')
  const target = join(folder, pinnedCopyName(phase))
  if (dirname(target) !== folder) fail('run-folder-unsafe')
  // A link or folder at the copy's name is never written through; the rename replaces a plain file, and
  // only one that already holds exactly these bytes (a copy with no pin is never overwritten silently).
  if (lexists(target)) {
    const stat = lstatSync(target)
    if (stat.isSymbolicLink() || !stat.isFile()) fail('run-folder-unsafe')
    let existing: Buffer
    try { existing = readFileSync(target) } catch { fail('work-pin-copy-failed') }
    if (!existing.equals(bytes)) fail('work-pin-copy-exists')
  }
  const temp = join(folder, `.${pinnedCopyName(phase)}.${process.pid}.${Date.now()}.tmp`)
  try {
    writeFileSync(temp, bytes, { flag: 'wx' })
    renameSync(temp, target)
  } catch {
    try { rmSync(temp, { force: true }) } catch { /* nothing to clean */ }
    fail('work-pin-copy-failed')
  }

  // The copy must read back as the pinned bytes before the Run records it.
  let written: PinnedWork
  try {
    written = readCopy(vaultRoot, talkSlug, runId, phase, pinned)
  } catch (error) {
    try { rmSync(target, { force: true }) } catch { /* left for the next attempt to replace */ }
    throw error
  }

  // Re-read the Run just before writing it, so a write made meanwhile (another process, a synced
  // vault) is not lost. The copy is left in place here: a pin recorded meanwhile may name it.
  const latest = readRunForTalk(vaultRoot, talkSlug, runId)
  const current = latest?.work?.[phase]
  if (!latest || !current || current.fileId !== work.fileId || current.pinned) {
    if (latest && current?.pinned && current.pinned.fileId === current.fileId) return { run: latest, created: false, ...readCopy(vaultRoot, talkSlug, runId, phase, current.pinned) }
    fail(!latest ? 'run-not-found' : !current ? 'work-not-attached' : 'work-pin-file-mismatch')
  }
  const next: RunRecord = { ...latest, work: { ...latest.work, [phase]: { ...current, pinned } } }
  let saved: RunRecord
  try {
    saved = persistRunForTalk(vaultRoot, talkSlug, runId, next)
  } catch (error) {
    try { rmSync(target, { force: true }) } catch { /* harmless orphan */ }
    throw error
  }
  if (!saved.work?.[phase]?.pinned) fail('work-pin-invalid')
  return { run: saved, created: true, ...written }
}
