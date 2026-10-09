// Which renderer-supplied paths shell:open-path and shell:show-item-in-folder act on. Both take a
// path from the renderer; shell.openPath hands it to the OS "open" action, which LAUNCHES an app
// bundle, an installer, a script or an executable as readily as it opens a document. So:
//
//   - both: the path must be absolute and stay inside an open vault's folder, lexically and once
//     symlinks are resolved (pathStaysInside) — every legitimate caller passes a talk's outline, a
//     file the build / handout export wrote to <talk>/dist, or a vault folder. The shell call gets
//     the resolved real path, so a symlink is judged (and opened) as what it points to.
//   - open-path additionally: a folder, or a file whose extension is a document / media type the
//     app produces or shows (OPENABLE_EXTENSIONS) — an allowlist, not a list of dangerous types,
//     because a denylist cannot catch an extensionless Mach-O / ELF binary (macOS opens one in
//     Terminal and runs it), a .webloc / .url / .terminal / .fileloc that opens something else, or
//     Windows Script Host types (.js, .vbs, .wsf) that run on double-click. Nothing inside a bundle
//     (Foo.app/…, an installer .pkg, a .workflow, …) and no bundle folder itself is opened, since the
//     OS launches a bundle folder rather than showing it.
//   - show-item-in-folder only reveals (selects the item in Finder / Explorer) and launches nothing,
//     so any type inside a vault is fine.
import { closeSync, lstatSync, openSync, readSync, statSync } from 'fs'
import { basename, extname, isAbsolute, sep } from 'path'
import { pathStaysInside } from './path-containment.ts'

export type ShellPathAction = 'open' | 'reveal'
export type ShellPathDecision =
  | { ok: true; path: string }
  | { ok: false; reason: 'not-a-path' | 'outside-vaults' | 'not-openable' | 'inside-bundle' | 'finder-alias' }

/** Documents and media the app writes or shows: outlines, builds, handouts, notes, exports, media. */
export const OPENABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.md', '.markdown', '.txt', '.html', '.htm', '.pdf', '.json', '.jsonl', '.csv', '.tsv', '.yaml', '.yml',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.heic', '.tif', '.tiff', '.bmp',
  '.mp3', '.m4a', '.wav', '.aac', '.ogg', '.oga', '.opus', '.flac', '.mp4', '.m4v', '.mov', '.webm',
  '.pptx', '.docx', '.xlsx', '.ppt', '.doc', '.xls', '.key', '.pages', '.numbers', '.odp', '.odt', '.ods', '.rtf', '.vtt', '.srt'
])

/** Folders the OS launches or installs instead of showing (macOS bundles). */
export const BUNDLE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.app', '.pkg', '.mpkg', '.bundle', '.framework', '.plugin', '.appex', '.xpc', '.kext', '.prefpane',
  '.workflow', '.action', '.scptd', '.saver', '.qlgenerator', '.mdimporter', '.wdgt', '.service'
])

export type ShellPathDeps = {
  /** pathStaysInside by default (root, candidate) → real path or null. */
  inside?: (root: string, candidate: string) => string | null
  /** Whether a real path is a folder (false for a file or a missing path). */
  isDirectory?: (path: string) => boolean
  /** Whether a file is a macOS Finder alias (see isFinderAlias). */
  isAlias?: (path: string) => boolean
}

/**
 * A macOS Finder alias is not a symlink: realpath leaves it as the alias file, but Launch Services
 * follows it when the file is opened. An alias renamed to `report.pdf` would pass the extension
 * check and open its target, which can be any application or script outside the vault (Codex
 * review on PR #9). Modern aliases are bookmark data in the data fork ("book" at byte 0, "mark" at
 * byte 8); older ones live in the resource fork, which macOS exposes at `<file>/..namedfork/rsrc`.
 * A file with either is refused: documents the app writes have neither.
 */
export function isFinderAlias(path: string): boolean {
  try {
    const head = Buffer.alloc(12)
    const fd = openSync(path, 'r')
    let n = 0
    try { n = readSync(fd, head, 0, 12, 0) } finally { closeSync(fd) }
    if (n >= 12 && head.toString('latin1', 0, 4) === 'book' && head.toString('latin1', 8, 12) === 'mark') return true
  } catch { /* unreadable: the open below fails on its own */ }
  if (process.platform === 'darwin') {
    try { if (statSync(`${path}/..namedfork/rsrc`).size > 0) return true } catch { /* no resource fork */ }
  }
  return false
}

function defaultIsDirectory(path: string): boolean {
  try { return statSync(path).isDirectory() } catch { try { return lstatSync(path).isDirectory() } catch { return false } }
}

function insideBundle(path: string): boolean {
  return path.split(sep).some((part) => BUNDLE_EXTENSIONS.has(extname(part).toLowerCase()))
}

/** `roots`: the open vaults' folders. */
export function decideShellPath(action: ShellPathAction, candidate: unknown, roots: readonly string[], deps: ShellPathDeps = {}): ShellPathDecision {
  if (typeof candidate !== 'string' || !candidate || candidate.includes('\0') || !isAbsolute(candidate)) return { ok: false, reason: 'not-a-path' }
  const inside = deps.inside ?? ((root: string, p: string) => pathStaysInside(root, p, true))
  let real: string | null = null
  for (const root of roots) {
    if (typeof root !== 'string' || !root) continue
    real = inside(root, candidate)
    if (real) break
  }
  if (!real) return { ok: false, reason: 'outside-vaults' }
  // Revealing launches nothing: show the item the person clicked (a link as the link).
  if (action === 'reveal') return { ok: true, path: candidate }
  if (insideBundle(real) || insideBundle(candidate)) return { ok: false, reason: 'inside-bundle' }
  if ((deps.isDirectory ?? defaultIsDirectory)(real)) return { ok: true, path: real }
  if ((deps.isAlias ?? isFinderAlias)(real)) return { ok: false, reason: 'finder-alias' }
  const exts = [extname(basename(real)).toLowerCase(), extname(basename(candidate)).toLowerCase()]
  return exts.every((e) => OPENABLE_EXTENSIONS.has(e)) ? { ok: true, path: real } : { ok: false, reason: 'not-openable' }
}
