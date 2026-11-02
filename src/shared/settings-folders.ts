// Two orchestrator rules for settings that name something outside the app (2026-10-20, from a
// security review of another app), kept in one place so the schema and main read the same words:
//
//   - A setting that names something to run (an interpreter, a binary, a script), somewhere to
//     send data (an endpoint, a URL, an upload destination) or a folder the app reads or writes
//     (the image archive, the backup and site folders) is never applied by Import settings…:
//     its `canApply` always answers LOCAL_ONLY, so the import preview lists it as skipped.
//   - Folder settings that must not overlap one another get a `validate` (an absolute path, or ~)
//     and are checked again where they are used (foldersOverlap): the backup folder holds every talk
//     with its speaker notes, and the site folder is uploaded to the web as it is, so neither may
//     be inside the other, and the site folder may not hold a vault.
//
// Pure; erasable TypeScript only (node tests import it as it is).

/** The import preview's reason for a setting that is set on each Mac by hand. */
export const LOCAL_ONLY = 'Set on this Mac only'

/**
 * Settings that name something to run, somewhere to send data, or a folder the app's code reads or
 * writes: never applied by import. Every `path` setting of the schema is here (Sol review 1, #3: the
 * image archive folder locates the archive database the app reads), and scripts/test-shared-settings.mjs
 * checks that no path setting is left out.
 */
export const LOCAL_ONLY_KEYS: readonly string[] = [
  // a folder the app reads its data from
  'general.imageArchive',
  // something to run
  'recording.transcriptionPython',
  'recording.transcriptionScript',
  'recording.ffmpeg',
  // somewhere to send data
  'recording.endpoint',
  'recording.bucket',
  'publishing.customDomain',
  'publishing.branch',
  'publishing.siteFolder',
  'presenting.backupFolder'
]

/** Folder settings that must not overlap each other or a vault; checked again on use. */
export const SEPARATE_FOLDER_KEYS: readonly string[] = ['presenting.backupFolder', 'publishing.siteFolder']

/** The `validate` of a separate folder: empty, or an absolute path (or one starting at ~). */
export function folderShapeError(value: unknown): string | null {
  if (typeof value !== 'string') return 'Must be a folder'
  const v = value.trim()
  if (v === '') return null
  if (v === '~' || v.startsWith('~/') || v.startsWith('/') || /^[A-Za-z]:[\\/]/.test(v)) return null
  return 'Choose a whole folder path, starting with / or ~'
}

const norm = (p: string): string => {
  const parts: string[] = []
  for (const part of p.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return '/' + parts.join('/').toLowerCase()
}

/** The `validate` of the site folder: as above, or a path inside the app's own folder (the old relative override), never climbing out with `..`. */
export function siteFolderShapeError(value: unknown): string | null {
  if (typeof value !== 'string') return 'Must be a folder'
  const v = value.trim()
  if (v === '' || folderShapeError(v) === null) return null
  return v.split(/[\\/]/).includes('..') ? 'A folder inside the app’s own folder cannot use ..' : null
}

/** True when one folder is the other or inside it (case-insensitive, as macOS volumes usually are). Absolute paths only. */
export function foldersOverlap(a: string, b: string): boolean {
  if (!a.trim() || !b.trim()) return false
  const x = norm(a)
  const y = norm(b)
  return x === y || x.startsWith(y === '/' ? '/' : `${y}/`) || y.startsWith(x === '/' ? '/' : `${x}/`)
}

/** True when `inner` is `outer` or inside it. */
export function folderInside(inner: string, outer: string): boolean {
  if (!inner.trim() || !outer.trim()) return false
  const x = norm(inner)
  const y = norm(outer)
  return x === y || x.startsWith(y === '/' ? '/' : `${y}/`)
}

/**
 * Why a folder may not be used for `use`, or null. `others` are the folders it must stay apart from,
 * each with its name in the person's words ("the backup folder", "the vault Talks").
 */
export function separateFolderProblem(folder: string, use: string, others: ReadonlyArray<{ path: string; name: string }>): string | null {
  for (const other of others) {
    if (foldersOverlap(folder, other.path)) return `${use} stopped: its folder overlaps ${other.name}. Choose a folder of its own in Settings.`
  }
  return null
}
