// Which real file an outline path names (live-presenting ticket 07, third review; one writer for talk
// files, D3). Discovery accepts outline symlinks and a talk can be hard-linked, so one outline can be
// reached by several path strings (its link, its real path, a linked folder, a second hard link).
// Everything that must treat "the same file" as one thing — the renderer's save queue, the editor
// window an "Add to talk" or a main-process write goes through, the one-window-per-talk guard, the
// main writer's per-file lock — compares `outlineIdentity(path).key`, never the raw strings, and
// resolves it again at every comparison and every write (a symlink can be retargeted while a talk is
// open, or an outside tool can replace the file).
import { realpathSync, statSync, type Stats } from 'fs'
import { basename, dirname, join, resolve } from 'path'

/** The outline's real path: every symlink (the file's own or a folder's) resolved. A file that does
 *  not exist (yet, or any more) resolves through its nearest folder that does — so a talk whose folder
 *  was deleted keeps the key it had while open (shared-talk ticket 08); a path nothing on disk backs is
 *  returned absolute. */
export function canonicalOutlinePath(outlinePath: string): string {
  const abs = resolve(outlinePath)
  try { return realpathSync.native(abs) } catch { /* not on disk (yet) */ }
  const missing: string[] = [basename(abs)]
  for (let dir = dirname(abs); ; dir = dirname(dir)) {
    try { return join(realpathSync.native(dir), ...missing) } catch { /* keep walking up */ }
    if (dirname(dir) === dir) return abs
    missing.unshift(basename(dir))
  }
}

export interface OutlineIdentity {
  /** `${dev}:${ino}` of the real file, or the real path itself when no file exists there yet. Two
   *  paths with one key are one talk. Stable across writes: talk-writer.ts writes in place, so the
   *  inode never changes (it does change once, when a missing file is first created). */
  key: string
  /** The real path (canonicalOutlinePath): where a write lands. */
  realPath: string
}

function rawKey(st: Pick<Stats, 'dev' | 'ino'>): string {
  return `${st.dev}:${st.ino}`
}

/** The identity of the file `outlinePath` names now (one stat; never throws). */
export function outlineIdentity(outlinePath: string): OutlineIdentity {
  const realPath = canonicalOutlinePath(outlinePath)
  try {
    return { key: rawKey(statSync(realPath)), realPath }
  } catch {
    return { key: realPath, realPath }
  }
}

/** An editor window and the talk it has open, as the window itself names it. Identity is resolved
 *  from `outlinePath` at every comparison, never cached on the entry. */
export interface EditorWindowEntry<W> {
  win: W
  outlinePath: string | null
}

/** The editor window whose open talk is the same file as `outlinePath` (whichever alias either side
 *  uses), or null. `exceptWin` skips one window (the one asking). The caller talks to that window in
 *  the window's own `outlinePath`. */
export function editorEntryForOutline<W>(
  entries: Iterable<EditorWindowEntry<W>>,
  outlinePath: string,
  isLive: (win: W) => boolean,
  exceptWin?: W,
): EditorWindowEntry<W> & { outlinePath: string } | null {
  const wanted = outlineIdentity(outlinePath).key
  for (const entry of entries) {
    if (entry.outlinePath === null || entry.win === exceptWin || !isLive(entry.win)) continue
    if (outlineIdentity(entry.outlinePath).key === wanted) return entry as EditorWindowEntry<W> & { outlinePath: string }
  }
  return null
}
