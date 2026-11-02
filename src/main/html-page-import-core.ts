// Insert › HTML page…: the copy itself, run in the import's own process (html-page-import-worker.ts)
// whose WORKING DIRECTORY IS THE TALK FOLDER. Main checks and names everything first
// (html-page-import.ts); this module is where the vault is written.
//
// Why a working directory: Node has no directory handle (no openat/mkdirat), and a path is resolved
// again on every call, so any check-then-write by path races another program renaming a folder or
// swapping one for a link (review 2026-10-27, F1). A process's working directory IS a handle: the
// kernel holds the folder itself, and a relative path resolves from it, never through the folder's
// ancestors. So:
//   - the place is proved first: `realpath.native('.')` is inside the vault's real root and `.` holds
//     the talk's outline with the device and inode main saw;
//   - every mutation is ONE relative component from there: mkdir('assets') (never recursive), then
//     open('assets/<name>') exclusively, with no link allowed in the path (O_NOFOLLOW_ANY on macOS);
//   - before and after the write the file is proved again: the held folder is still the talk's real
//     path and holds the outline, and, in ONE open by the absolute real path with no link anywhere in
//     it, the file there is the file being written. A failed proof after bytes were written empties
//     the file through its own descriptor; nothing is ever unlinked by path.
// What no design prevents (a directory handle included): another program moving the very folder
// being written into out of the vault during the write. That is caught by the proof after the write:
// the file is emptied and the import refused, so success always names a file inside the vault.
// Design and evidence: research/insert-html-page-2026-10-26/2026-10-27-html-import-write-authority-design.md
//
// No Electron import and erasable TypeScript only: the plain-Node tests run it in a child process too.
import * as nodeFs from 'node:fs'
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path'
import type { HtmlPageImport, HtmlPageRefusal, HtmlPageRefusalReason } from '../shared/html-page-import.ts'

/** The talk-folder subfolder a chosen page is copied into (the folder the Embed examples name). */
export const HTML_PAGE_ASSETS_DIR = 'assets'
/** A page larger than this is refused: it is inlined into every compiled slide that shows it. */
export const HTML_PAGE_MAX_BYTES = 20 * 1024 * 1024
const MAX_NAME_TRIES = 999

export const HTML_PAGE_TEXT = {
  notHtml: 'Choose an HTML page (.html or .htm).',
  missing: 'That file is no longer there. Choose it again.',
  tooLarge: `That page is larger than ${HTML_PAGE_MAX_BYTES / 1024 / 1024} MB, so it was not added.`,
  noTalk: 'Open a talk first, then insert the HTML page.',
  talkChanged: 'The open talk changed while the file picker was open, so nothing was added. Choose the page again.',
  vaultUnavailable: 'The talk’s vault folder is not available on this Mac, so nothing was written.',
  outsideVault: 'The talk’s assets folder leads outside its vault, so nothing was written.',
  moved: 'The talk’s folder was moved or changed while the page was being copied, so nothing was added. Choose the page again.',
  expired: 'That choice has expired. Choose the page again.',
  writeFailed: 'The page could not be copied into the talk’s assets folder.',
  unsupported: 'Inserting an HTML page from a file is available on macOS only for now, so nothing was added. You can type an [Embed: …] line instead.'
} as const

export const refusal = (reason: HtmlPageRefusalReason, message: string): HtmlPageRefusal => ({ ok: false, reason, message })

export type FileId = { dev: number; ino: number }

/** What main hands the import's own process. Every path in it was resolved by main just now. */
export type HtmlPageImportJob = {
  /** The vault's real root (realpath.native). */
  realRoot: string
  /** The talk folder's real path (realpath.native, below realRoot): the process starts there. */
  realTalkPath: string
  outlineName: string
  outline: FileId
  /** The chosen page's real path, and the file it was when chosen. */
  source: string
  sourceId: FileId
  /** Slide Scratchpad (ticket 2) uses this copy for an SVG picture too: the file keeps its `.svg` name. */
  kind?: CopiedFileKind
  /** Copy into `assets/` even when the file already sits in the talk folder (an agent's file in `scratchpad/`
   *  is copied, never named where it is: the agent may write it again). */
  alwaysCopy?: boolean
}

/** What the copy takes: an HTML page (Insert › HTML page…) or, for the Slide Scratchpad, an SVG picture. */
export type CopiedFileKind = 'html' | 'svg'

export type HtmlPageFs = Pick<typeof nodeFs,
  'lstatSync' | 'statSync' | 'openSync' | 'fstatSync' | 'readSync' | 'writeSync' | 'ftruncateSync' | 'closeSync' | 'mkdirSync'> & {
  /** realpath(3) of a path now (the kernel's answer, not a cached working directory). */
  realpathNative?: (path: string) => string
}

/** macOS open(2): fail with ELOOP when any component of the path is a symbolic link (sys/fcntl.h, macOS 11+). */
const O_NOFOLLOW_ANY = 0x20000000
/**
 * Where the import runs at all: only where one open refuses a link at ANY level of its path. Elsewhere
 * (O_NOFOLLOW guards the last part only, and Windows has nothing) the exclusive create of
 * `assets/<name>` would follow a link swapped in for `assets` and make an empty file outside the vault
 * before any proof could refuse it (review 2026-10-27, second correction). So there the import refuses
 * before it touches the file system, and the picker never opens (html-page-import.ts). Native Windows
 * and Linux are not tested; they are simply refused.
 */
export const htmlPageImportSupportedOn = (platform: string): boolean => platform === 'darwin'
const SUPPORTED = htmlPageImportSupportedOn(process.platform)
const NO_LINKS = SUPPORTED ? O_NOFOLLOW_ANY : (nodeFs.constants.O_NOFOLLOW ?? 0)

const sameFile = (a: FileId, b: FileId): boolean => a.dev === b.dev && a.ino === b.ino
const below = (realRoot: string, real: string): boolean => {
  const rel = relative(realRoot, real)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** A file name safe to write into an `[Embed: …]` line and on every file system: letters, digits, `.`, `_`, `-`. */
export function safePageFileName(original: string, kind: CopiedFileKind = 'html'): string {
  const ext = kind === 'svg' ? '.svg' : extname(original).toLowerCase() === '.htm' ? '.htm' : '.html'
  const stem = basename(original, extname(original))
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80)
  return `${stem || 'page'}${ext}`
}

/** A path inside the talk folder may be written as it is when the Embed line reads it back exactly,
 *  as a local file: no `:` (a part like `https:page.html` reads as an address, `C:` as a drive) and no
 *  `%` (an escape the compiler may decode), besides the characters the Embed line itself uses. */
export function writableAsReference(rel: string): boolean {
  return rel !== '' && !/[[\]\r\n\0?#\\:%]/.test(rel) && !rel.startsWith('~') && rel === rel.trim() && !rel.split('/').some((part) => part === '..' || part === '' || part === '.')
}

const REFERENCE_TAGS = new Set(['script', 'link', 'img', 'iframe', 'source', 'audio', 'video', 'embed', 'object', 'track', 'input'])
const REFERENCE_ATTR = /\s(?:src|href|data|srcset|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi
const MAX_REFERENCES = 5

/** A relative local address, without query or fragment; null for an address, a scheme, `//host`, `#id` or nothing. */
function localAddress(raw: string): string | null {
  const value = raw.trim()
  if (!value || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(value)) return null
  return value.split(/[?#]/)[0] || null
}

/**
 * Some relative local files the page loads, named in its script, stylesheet and media tags: at most
 * five, to name in the notice. NOT a list of everything the page needs (CSS `url()`/`@import`, script
 * fetches and the like are not read), so the notice after an insert always says that files beside
 * the page are not copied, whether or not any are named here (review 2026-10-27, F3).
 * One pass: each `<` starts at most one tag, which ends at the next `>`, and the scan resumes after
 * it; a `<` with no `>` after it ends the scan. Time is proportional to the page's size.
 */
export function localReferencesOf(html: string): string[] {
  const found = new Set<string>()
  for (let at = html.indexOf('<'); at !== -1;) {
    const close = html.indexOf('>', at + 1)
    if (close === -1) break
    const name = /^<([A-Za-z][A-Za-z0-9]*)/.exec(html.slice(at, Math.min(close, at + 16)))?.[1]?.toLowerCase()
    if (name && REFERENCE_TAGS.has(name)) {
      for (const a of html.slice(at, close + 1).matchAll(REFERENCE_ATTR)) {
        const value = localAddress((a[1] ?? a[2] ?? a[3] ?? '').trim().split(/[\s,]/)[0])
        if (value) found.add(value)
        if (found.size >= MAX_REFERENCES) return [...found]
      }
    }
    at = html.indexOf('<', close + 1)
  }
  return [...found]
}

/** The chosen page's bytes, through one descriptor that is the file chosen in the picker. */
function readChosenPage(job: HtmlPageImportJob, fs: HtmlPageFs): Buffer | HtmlPageRefusal {
  let fd: number
  try { fd = fs.openSync(job.source, nodeFs.constants.O_RDONLY | NO_LINKS) } catch { return refusal('missing', HTML_PAGE_TEXT.missing) }
  try {
    const info = fs.fstatSync(fd)
    if (!info.isFile() || !sameFile(info, job.sourceId)) return refusal('missing', HTML_PAGE_TEXT.missing)
    if (info.size > HTML_PAGE_MAX_BYTES) return refusal('too-large', HTML_PAGE_TEXT.tooLarge)
    const out = Buffer.alloc(info.size)
    let at = 0
    while (at < out.length) {
      const n = fs.readSync(fd, out, at, out.length - at, at)
      if (n === 0) break
      at += n
    }
    // A file that grew past the limit while being read is refused rather than cut short.
    const probe = Buffer.alloc(1)
    if (fs.readSync(fd, probe, 0, 1, at) !== 0 || at !== out.length) return refusal('too-large', HTML_PAGE_TEXT.tooLarge)
    return out
  } catch {
    return refusal('missing', HTML_PAGE_TEXT.missing)
  } finally {
    try { fs.closeSync(fd) } catch { /* already closed */ }
  }
}

/**
 * Copy (or name in place) the chosen page into the talk folder that is this process's working
 * directory. Never overwrites a file; the new copy is created exclusively. A refusal before the copy
 * writes nothing; a refusal after it leaves the new file empty.
 */
export function importInWorkingFolder(job: HtmlPageImportJob, fs: HtmlPageFs = nodeFs): HtmlPageImport {
  // First, before any file-system call: everything below relies on O_NOFOLLOW_ANY.
  if (!SUPPORTED) return refusal('unsupported', HTML_PAGE_TEXT.unsupported)
  const realNow = fs.realpathNative ?? ((path: string) => nodeFs.realpathSync.native(path))
  /** The held folder is still the talk's, at its real path inside the vault. */
  const placeHolds = (): boolean => {
    try {
      if (realNow('.') !== job.realTalkPath) return false
      const outline = fs.lstatSync(job.outlineName)
      return outline.isFile() && sameFile(outline, job.outline)
    } catch { return false }
  }
  /**
   * The open file `fd` is the file at `rel` below the talk's real path inside the vault. The LAST step
   * decides, in one open: by the absolute real path with no link allowed anywhere in it (macOS), the
   * same file. A link swapped in at any level, a folder moved out, or another file there all fail in
   * that one call, so no swap before it escapes it (a swap after it is after the import answered).
   */
  const fileHolds = (fd: number, rel: string): boolean => {
    try {
      const held = fs.fstatSync(fd)
      if (!held.isFile() || !placeHolds()) return false
      const again = fs.openSync(join(job.realTalkPath, ...rel.split('/')), nodeFs.constants.O_RDONLY | NO_LINKS)
      try { return sameFile(fs.fstatSync(again), held) } finally { fs.closeSync(again) }
    } catch { return false }
  }

  /**
   * `rel` (below the talk folder) names the chosen file now: the held folder is still the talk's, and
   * ONE open by the absolute real path with no link allowed anywhere in it (macOS) finds the file with
   * the chosen device and inode. A link put in its place, at any level, or another file there fails.
   */
  const namesChosenFile = (rel: string): boolean => {
    try {
      if (!placeHolds()) return false
      const fd = fs.openSync(join(job.realTalkPath, ...rel.split('/')), nodeFs.constants.O_RDONLY | NO_LINKS)
      try {
        const info = fs.fstatSync(fd)
        return info.isFile() && sameFile(info, job.sourceId)
      } finally { fs.closeSync(fd) }
    } catch { return false }
  }

  if (!placeHolds()) return refusal('outside-vault', HTML_PAGE_TEXT.moved)
  const bytes = readChosenPage(job, fs)
  if (!Buffer.isBuffer(bytes)) return bytes
  const localReferences = job.kind === 'svg' ? [] : localReferencesOf(bytes.toString('utf8'))

  // Already in the talk's folder: written as it is, nothing copied, when the path is PROVED, now that
  // the read is done, to still name the file chosen. Otherwise the checked bytes are copied as from
  // anywhere else (review 2026-10-27, second correction: a path is not authority).
  let here: string
  try { here = realNow('.') } catch { return refusal('outside-vault', HTML_PAGE_TEXT.moved) }
  if (!job.alwaysCopy && below(here, job.source)) {
    const rel = relative(here, job.source).split(sep).join('/')
    if (writableAsReference(rel) && namesChosenFile(rel)) return { ok: true, embedPath: rel, how: 'in-talk', localReferences }
  }

  try { fs.mkdirSync(HTML_PAGE_ASSETS_DIR) } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') return refusal('write-failed', HTML_PAGE_TEXT.writeFailed)
  }
  try {
    const assets = fs.lstatSync(HTML_PAGE_ASSETS_DIR)
    if (assets.isSymbolicLink() || !assets.isDirectory()) return refusal('outside-vault', HTML_PAGE_TEXT.outsideVault)
  } catch { return refusal('write-failed', HTML_PAGE_TEXT.writeFailed) }

  const name = safePageFileName(basename(job.source), job.kind === 'svg' ? 'svg' : 'html')
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let n = 1; n <= MAX_NAME_TRIES; n += 1) {
    const candidate = n === 1 ? name : `${stem}-${n}${ext}`
    const rel = `${HTML_PAGE_ASSETS_DIR}/${candidate}`
    let existing: nodeFs.Stats | null = null
    try { existing = fs.lstatSync(rel) } catch { /* free */ }
    if (existing) {
      // Same bytes in a plain file of this folder: the page is already in the talk. A link (followed
      // nowhere) or anything else is a taken name.
      if (existing.isFile() && existing.size === bytes.length) {
        const same = sameBytesAt(rel, bytes, fs, fileHolds)
        if (same === 'moved') return refusal('outside-vault', HTML_PAGE_TEXT.moved)
        if (same === 'same') return { ok: true, embedPath: rel, how: 'reused', localReferences }
      }
      continue
    }
    let fd: number
    try { fd = fs.openSync(rel, nodeFs.constants.O_WRONLY | nodeFs.constants.O_CREAT | nodeFs.constants.O_EXCL | NO_LINKS, 0o644) } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if (code === 'EEXIST') continue // appeared meanwhile: never replaced
      return code === 'ELOOP' || code === 'ENOTDIR' ? refusal('outside-vault', HTML_PAGE_TEXT.outsideVault) : refusal('write-failed', HTML_PAGE_TEXT.writeFailed)
    }
    try {
      if (!fileHolds(fd, rel)) return refusal('outside-vault', HTML_PAGE_TEXT.moved)
      try {
        for (let at = 0; at < bytes.length;) at += fs.writeSync(fd, bytes, at, bytes.length - at, at)
      } catch {
        emptied(fd, fs)
        return refusal('write-failed', HTML_PAGE_TEXT.writeFailed)
      }
      if (!fileHolds(fd, rel)) { emptied(fd, fs); return refusal('outside-vault', HTML_PAGE_TEXT.moved) }
      return { ok: true, embedPath: rel, how: 'copied', localReferences }
    } finally {
      try { fs.closeSync(fd) } catch { /* already closed */ }
    }
  }
  return refusal('write-failed', HTML_PAGE_TEXT.writeFailed)
}

/** Our own file, through our own descriptor: emptied, never unlinked by path. */
function emptied(fd: number, fs: HtmlPageFs): void {
  try { fs.ftruncateSync(fd, 0) } catch { /* left as written; the import is refused either way */ }
}

/** Whether the plain file at `rel` (in the held folder) holds exactly `bytes`, read through a proved descriptor. */
function sameBytesAt(rel: string, bytes: Buffer, fs: HtmlPageFs, fileHolds: (fd: number, rel: string) => boolean): 'same' | 'different' | 'moved' {
  let fd: number
  try { fd = fs.openSync(rel, nodeFs.constants.O_RDONLY | NO_LINKS) } catch { return 'different' }
  try {
    if (fs.fstatSync(fd).size !== bytes.length) return 'different'
    const held = Buffer.alloc(bytes.length)
    for (let at = 0; at < held.length;) {
      const n = fs.readSync(fd, held, at, held.length - at, at)
      if (n === 0) return 'different'
      at += n
    }
    if (!held.equals(bytes)) return 'different'
    return fileHolds(fd, rel) ? 'same' : 'moved'
  } catch {
    return 'different'
  } finally {
    try { fs.closeSync(fd) } catch { /* already closed */ }
  }
}
