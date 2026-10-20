// How a talk's `prework:` / `postwork:` value names a work file: the one reading, used by the editor's
// strips and Pre-work / Post-work picker (work-strips.ts, workStrips.ts) and by the Work files view's
// Used by (work-files-view.ts), so the three never disagree (ticket 08 review S6). Pure; no fs.
//
//   - The value is read as written or as the front-matter reader returns it: white space, a trailing
//     ` # comment`, surrounding quotes and a trailing `.md` are dropped.
//   - It names the file whose id it is, when exactly one file has that id. An id two files share names
//     no file (the Work files view flags both).
//   - Otherwise it names a file with no id by its file name, when no file has that name as its id.
//   - `true` / `false` are the 0.39 switch (`prework: true`) and name no file, unless a file has that
//     id: a work-file id may be `true` (WORK_FILE_ID_RE), and the picker writes ids unquoted.

/** What naming needs of a work file. */
export interface NameableWorkFile { id: string; fileName: string }

/** A front-matter value read as a work-file name; '' when it is empty. */
export function namedWorkFile(value: string | undefined | null): string {
  if (typeof value !== 'string') return ''
  return value.trim()
    .replace(/[ \t]+#.*$/, '').trim()
    .replace(/^["']/, '').replace(/["']$/, '').trim()
    .replace(/\.md$/i, '')
}

const stemOf = (fileName: string): string => fileName.replace(/\.md$/i, '')

export interface TalkWorkFile<F> {
  /** The name as read; '' when the talk names nothing (no value, or the 0.39 `true` / `false`). */
  name: string
  /** The file it names; null when no file answers to it. */
  file: F | null
  /** True when two or more files have the id the talk names. */
  sharedId: boolean
}

/** The work file a talk's value names, among the vault's files. */
export function talkWorkFile<F extends NameableWorkFile>(value: string | undefined | null, files: readonly F[]): TalkWorkFile<F> {
  const name = namedWorkFile(value)
  if (!name) return { name: '', file: null, sharedId: false }
  const byId = files.filter((file) => file.id === name)
  if (byId.length === 1) return { name, file: byId[0], sharedId: false }
  if (byId.length > 1) return { name, file: null, sharedId: true }
  if (name === 'true' || name === 'false') return { name: '', file: null, sharedId: false }
  const byStem = files.find((file) => !file.id && stemOf(file.fileName) === name) ?? null
  return { name, file: byStem, sharedId: false }
}

/** The value the picker writes for a file: its id. A file with no id cannot be named for a Run ('' ). */
export function workFileValue(file: Pick<NameableWorkFile, 'id'>): string {
  return file.id
}
