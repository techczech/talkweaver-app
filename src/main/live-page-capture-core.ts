// A saved view of a live web page (the capture gallery): the write itself, run in the capture's own
// process (live-page-capture-worker.ts) whose WORKING DIRECTORY IS THE TALK FOLDER. The same write
// authority as Insert › HTML page (html-page-import-core.ts says why a path cannot be one), with the
// folder HELD rather than named (independent review 2026-10-27, P1):
//   - the place is proved first: `realpath.native('.')` is the talk's real path inside the vault and
//     `.` holds the talk's outline with the device and inode main saw;
//   - the process then ENTERS `assets`, then `assets/live-page-captures`, one component at a time:
//     mkdir (never recursive), lstat (a real folder, not a link), chdir, and the folder now held is
//     proved to be that folder (same device and inode as the lstat) at that real path. From then on
//     the working directory IS the folder; renaming or replacing `assets` afterwards cannot redirect
//     anything, because every later operation names ONE component in the held folder;
//   - every file is created exclusively with no link allowed in its path (O_NOFOLLOW_ANY); nothing is
//     renamed, replaced, rewritten or deleted. A half-written record is emptied through its own
//     descriptor and left for readers to skip; its pathname may belong to another writer.
// What is written (compiler/scripts/lib/live-page-captures.mjs):
//   - the picture, `<sha256:16>.jpg`, named by its own bytes: created exclusively, never replacing a
//     file (the same bytes already there are reused; anything else there refuses);
//   - after the picture is durable, the saved view's own record, `<time>-<capture id>.json`, created
//     exclusively. No shared list exists, so two writers at once each add their own view and nothing
//     is lost (review P2: no check-then-replace); the record is never bigger than readers accept
//     (review P2 size: encodeCaptureEntry checks the stored bytes against the readers' limit).
// Nothing here comes from the web page: the page's bytes are the picture main encoded, every name is
// made here, and addresses are checked as addresses, never used as paths.
// macOS only, failing closed elsewhere (as the HTML import): O_NOFOLLOW_ANY is what makes one open
// refuse a link anywhere in its path.
//
// No Electron import and erasable TypeScript only: the plain-Node tests run it in a child process too.
import * as nodeFs from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute, join, relative, sep } from 'node:path'
import {
  captureEntryName, captureImageName, earlierCapturesFor, encodeCaptureEntry, galleryFromEntries, isCaptureEntryName, isCaptureImagePath, LIVE_PAGE_CAPTURES_DIR,
  MAX_CAPTURE_ENTRY_BYTES, MAX_CAPTURE_IMAGE_BYTES, MAX_CAPTURES_PER_PAGE, MAX_CAPTURES_TOTAL, normaliseCaptureUrl,
  parseCaptureEntry, type LivePageCapture, type LivePageCaptureEntry
} from '../../compiler/scripts/lib/live-page-captures.mjs'
import { htmlPageImportSupportedOn, type FileId } from './html-page-import-core.ts'

export const CAPTURE_ASSETS_DIR = 'assets'
const CAPTURES_SUBDIR = LIVE_PAGE_CAPTURES_DIR.slice(CAPTURE_ASSETS_DIR.length + 1)

export type CaptureRefusalReason = 'unsupported' | 'moved' | 'outside-vault' | 'not-a-picture' | 'too-large' | 'record-invalid' | 'full' | 'taken' | 'write-failed'
export type CaptureRefusal = { ok: false; reason: CaptureRefusalReason; message: string }
/** `earlier`: the page's views saved before {capture} lines (records without `slideMarkup`, oldest
 *  first). Main writes their lines with this view's, under the marker, only if the slide's embed is
 *  not in the markup yet; whether it is, the outline says (live-page-capture-markup.mjs). */
export type CaptureWritten = { ok: true; image: string; how: 'written' | 'reused'; capture: LivePageCapture; count: number; earlier: Array<{ image: string; capturedAt: string; mode?: 'page' }> }
export type CaptureAnswer = CaptureWritten | CaptureRefusal

export const CAPTURE_TEXT: Record<CaptureRefusalReason, string> = {
  unsupported: 'Saving views of a web page is available on macOS only for now.',
  moved: 'The talk’s folder was moved or changed while the view was being saved, so nothing was saved.',
  'outside-vault': 'The talk’s assets folder leads outside its vault, so nothing was saved.',
  'not-a-picture': 'The view could not be saved as a picture.',
  'too-large': 'The view is too large to save.',
  'record-invalid': 'This view’s details could not be recorded, so nothing was saved.',
  full: 'This page already has the most saved views a slide keeps.',
  taken: 'A different file already has this saved view’s name, so it was left as it is and nothing was saved.',
  'write-failed': 'The view could not be saved in the talk’s assets folder.'
}

const refuse = (reason: CaptureRefusalReason): CaptureRefusal => ({ ok: false, reason, message: CAPTURE_TEXT[reason] })

/** What main hands the capture's own process. Every path in it was resolved by main just now. */
export type CaptureJob = {
  realRoot: string
  realTalkPath: string
  outlineName: string
  outline: FileId
  /** The slide's own address (normalised): the gallery's key. */
  pageUrl: string
  /** Everything but the picture's path and size, which are made here. */
  capture: Omit<LivePageCapture, 'image' | 'bytes'>
  /** The JPEG main encoded from the page's own view. */
  jpeg: Uint8Array
}

export type CaptureFs = Pick<typeof nodeFs,
  'lstatSync' | 'statSync' | 'openSync' | 'fstatSync' | 'readSync' | 'writeSync' | 'ftruncateSync' | 'closeSync' | 'mkdirSync' | 'readdirSync' | 'unlinkSync' | 'fsyncSync'> & {
  realpathNative?: (path: string) => string
  /** The process's working directory (tests and probes may wrap these). */
  chdir?: (path: string) => void
  cwd?: () => string
}

/** macOS open(2): fail with ELOOP when any component of the path is a symbolic link (sys/fcntl.h, macOS 11+). */
export const O_NOFOLLOW_ANY = 0x20000000
const SUPPORTED = htmlPageImportSupportedOn(process.platform)
const NO_LINKS = SUPPORTED ? O_NOFOLLOW_ANY : (nodeFs.constants.O_NOFOLLOW ?? 0)
const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL } = nodeFs.constants

const sameFile = (a: FileId, b: FileId): boolean => a.dev === b.dev && a.ino === b.ino
const below = (root: string, real: string): boolean => {
  const rel = relative(root, real)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}
const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException)?.code

/** A JPEG's first bytes, and its size within the limit. */
export function isCaptureJpeg(bytes: unknown): bytes is Uint8Array {
  return bytes instanceof Uint8Array && bytes.length > 3 && bytes.length <= MAX_CAPTURE_IMAGE_BYTES && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
}

function readAll(fd: number, size: number, fs: CaptureFs): Buffer | null {
  const out = Buffer.alloc(size)
  let at = 0
  while (at < size) {
    const n = fs.readSync(fd, out, at, size - at, at)
    if (n === 0) return null
    at += n
  }
  return fs.readSync(fd, Buffer.alloc(1), 0, 1, at) === 0 ? out : null
}

function writeAll(fd: number, bytes: Uint8Array, fs: CaptureFs): void {
  for (let at = 0; at < bytes.length;) at += fs.writeSync(fd, bytes, at, bytes.length - at, at)
}

/** Save one view in the talk folder that is this process's working directory. */
export function writeCaptureInWorkingFolder(job: CaptureJob, fs: CaptureFs = nodeFs, platformSupported = SUPPORTED): CaptureAnswer {
  if (!platformSupported) return refuse('unsupported')
  const realNow = fs.realpathNative ?? ((path: string) => nodeFs.realpathSync.native(path))
  const chdir = fs.chdir ?? ((path: string) => process.chdir(path))
  const cwd = fs.cwd ?? (() => process.cwd())

  const given: unknown = job.jpeg
  if (!isCaptureJpeg(given)) return refuse(given instanceof Uint8Array && given.length > MAX_CAPTURE_IMAGE_BYTES ? 'too-large' : 'not-a-picture')
  const jpeg = Buffer.from(given.buffer, given.byteOffset, given.byteLength)
  const pageUrl = normaliseCaptureUrl(job.pageUrl)
  if (!pageUrl) return refuse('record-invalid')

  try {
    if (realNow('.') !== job.realTalkPath || (job.realRoot !== job.realTalkPath && !below(job.realRoot, job.realTalkPath))) return refuse('moved')
    const outline = fs.lstatSync(job.outlineName)
    if (!outline.isFile() || !sameFile(outline, job.outline)) return refuse('moved')
  } catch { return refuse('moved') }

  const started = cwd()
  try {
    // 1. Hold the saved-view folder: enter it one proved component at a time.
    const assetsReal = join(job.realTalkPath, CAPTURE_ASSETS_DIR)
    const capturesReal = join(assetsReal, CAPTURES_SUBDIR)
    const entered = enter(CAPTURE_ASSETS_DIR, assetsReal, fs, realNow, chdir)
    if (entered !== true) return refuse(entered)
    const inside = enter(CAPTURES_SUBDIR, capturesReal, fs, realNow, chdir)
    if (inside !== true) return refuse(inside)
    // The held folder is still where it was proved (a check after a write, never a reason to write).
    const held = (): boolean => { try { return realNow('.') === capturesReal } catch { return false } }
    const fileHolds = (fd: number, name: string): boolean => {
      try {
        const info = fs.fstatSync(fd)
        if (!info.isFile() || !held()) return false
        const again = fs.openSync(name, O_RDONLY | NO_LINKS)
        try { return sameFile(fs.fstatSync(again), info) } finally { fs.closeSync(again) }
      } catch { return false }
    }

    // 2. The gallery as it is now: every saved view's own record, within the readers' limits.
    let names: string[]
    try { names = (fs.readdirSync('.') as string[]).filter((n) => isCaptureEntryName(n)) } catch { return refuse('write-failed') }
    if (names.length >= MAX_CAPTURES_TOTAL * 2) return refuse('full')
    const entries: Array<LivePageCaptureEntry & { name: string }> = []
    for (const name of names) {
      const entry = readEntry(name, fs)
      if (entry) entries.push({ ...entry, name })
    }
    const gallery = galleryFromEntries(entries)
    const onPage = gallery.pages[pageUrl]?.length ?? 0
    const earlier = earlierCapturesFor(gallery, pageUrl)
    if (gallery.total >= MAX_CAPTURES_TOTAL || onPage >= MAX_CAPTURES_PER_PAGE) return refuse('full')

    // 3. The record, made and checked whole before anything is written: exactly what readers accept.
    //    The address the page had reached is dropped when the record would be too large with it.
    const imageName = captureImageName(createHash('sha256').update(jpeg).digest('hex'))
    const image = `${LIVE_PAGE_CAPTURES_DIR}/${imageName}`
    const full = { ...job.capture, image, bytes: jpeg.length } as LivePageCapture
    let text: string
    let capture: LivePageCapture
    try {
      try { text = encodeCaptureEntry(pageUrl, full); capture = full } catch (error) {
        if (String((error as Error)?.message) !== 'capture-too-large' || !full.currentUrl) throw error
        const { currentUrl: _dropped, ...rest } = full
        capture = rest as LivePageCapture
        text = encodeCaptureEntry(pageUrl, capture)
      }
    } catch { return refuse('record-invalid') }
    const entryName = captureEntryName(capture)
    const parsed = parseCaptureEntry(text, entryName)
    if (!parsed) return refuse('record-invalid')
    capture = parsed.capture

    // 4. The picture: created exclusively in the held folder, or the same bytes already there reused.
    let how: CaptureWritten['how'] = 'written'
    {
      let fd: number | null = null
      try { fd = fs.openSync(imageName, O_WRONLY | O_CREAT | O_EXCL | NO_LINKS, 0o644) } catch (error) {
        const code = codeOf(error)
        if (code === 'ELOOP' || code === 'ENOTDIR') return refuse('outside-vault')
        if (code !== 'EEXIST') return refuse('write-failed')
      }
      if (fd === null) {
        let rfd: number
        try { rfd = fs.openSync(imageName, O_RDONLY | NO_LINKS) } catch { return refuse('taken') }
        try {
          const info = fs.fstatSync(rfd)
          const bytes = info.isFile() && info.size === jpeg.length ? readAll(rfd, info.size, fs) : null
          if (!bytes || !bytes.equals(jpeg)) return refuse('taken')
          if (!fileHolds(rfd, imageName)) return refuse('moved')
          how = 'reused'
        } catch { return refuse('taken') } finally { try { fs.closeSync(rfd) } catch { /* closed */ } }
      } else {
        try {
          try { writeAll(fd, jpeg, fs); fs.fsyncSync(fd) } catch { emptied(fd, fs); return refuse('write-failed') }
          if (!fileHolds(fd, imageName)) return refuse('moved')
        } finally { try { fs.closeSync(fd) } catch { /* closed */ } }
      }
    }

    // 5. The saved view's own record, created exclusively once the picture is durable. Never replaces.
    let efd: number
    try { efd = fs.openSync(entryName, O_WRONLY | O_CREAT | O_EXCL | NO_LINKS, 0o644) } catch (error) {
      const code = codeOf(error)
      return refuse(code === 'EEXIST' ? 'taken' : code === 'ELOOP' || code === 'ENOTDIR' ? 'outside-vault' : 'write-failed')
    }
    let done = false
    try {
      try { writeAll(efd, Buffer.from(text, 'utf8'), fs); fs.fsyncSync(efd) } catch { return refuse('write-failed') }
      if (!fileHolds(efd, entryName)) return refuse('moved')
      done = true
      return { ok: true, image, how, capture, count: onPage + 1, earlier }
    } finally {
      // Empty only our descriptor. Deleting by name could remove a concurrent replacement.
      if (!done) emptied(efd, fs)
      try { fs.closeSync(efd) } catch { /* closed */ }
    }
  } finally {
    try { chdir(started) } catch { /* the process ends after one job */ }
  }
}

/**
 * Enter `name` below the working directory: made if absent (one component), a real folder (not a
 * link), and once entered, the SAME folder (device and inode) at the real path expected.
 */
function enter(name: string, expectedReal: string, fs: CaptureFs, realNow: (p: string) => string, chdir: (p: string) => void): true | CaptureRefusalReason {
  try { fs.mkdirSync(name) } catch (error) { if (codeOf(error) !== 'EEXIST') return 'write-failed' }
  let seen: nodeFs.Stats
  try { seen = fs.lstatSync(name) } catch { return 'moved' }
  if (seen.isSymbolicLink() || !seen.isDirectory()) return 'outside-vault'
  try { chdir(name) } catch { return 'moved' }
  try {
    const now = fs.statSync('.')
    if (!now.isDirectory() || !sameFile(now, seen) || realNow('.') !== expectedReal) return 'outside-vault'
  } catch { return 'moved' }
  return true
}

/** One saved view's record in the held folder, within the readers' limits; null when it is not one. */
function readEntry(name: string, fs: CaptureFs): LivePageCaptureEntry | null {
  let fd: number
  try { fd = fs.openSync(name, O_RDONLY | NO_LINKS) } catch { return null }
  try {
    const info = fs.fstatSync(fd)
    if (!info.isFile() || info.size > MAX_CAPTURE_ENTRY_BYTES) return null
    const bytes = readAll(fd, info.size, fs)
    return bytes ? parseCaptureEntry(bytes.toString('utf8'), name) : null
  } catch { return null } finally { try { fs.closeSync(fd) } catch { /* closed */ } }
}

/** Our own file, through our own descriptor: emptied. */
function emptied(fd: number, fs: CaptureFs): void {
  try { fs.ftruncateSync(fd, 0) } catch { /* left as written */ }
}

/** The answer's shape, checked by main: the child is ours, but a broken answer must not reach the deck. */
export function isCaptureAnswer(value: unknown): value is CaptureAnswer {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (v.ok === false) return typeof v.reason === 'string' && Object.prototype.hasOwnProperty.call(CAPTURE_TEXT, v.reason) && typeof v.message === 'string'
  return v.ok === true && typeof v.image === 'string' && (v.how === 'written' || v.how === 'reused') && typeof v.count === 'number' && !!v.capture && typeof v.capture === 'object'
    && Array.isArray(v.earlier) && v.earlier.every((e) => !!e && typeof e === 'object' && isCaptureImagePath((e as { image?: unknown }).image) && typeof (e as { capturedAt?: unknown }).capturedAt === 'string')
}

export { refuse as captureRefusal }
