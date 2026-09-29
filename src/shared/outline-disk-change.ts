// Outline external-change guard (shared-talk ticket 01). What the main process reports when a talk's
// outline file changed on disk behind the open editor (another TalkWeaver on a shared cloud-synced
// folder, a sync client, a text editor). Shared by main (src/main/outline-disk-guard.ts), the preload
// bridge and the renderer's bar (src/renderer/src/lib/outlineDiskChange.ts).

/**
 * - `changed`: the file holds other text than the editor was given (hash = that text's version).
 * - `removed`: the file is gone (deleted, or moved away by the other side).
 * - `partial`: an app save failed halfway; the file may be incomplete (tempPath holds the full text).
 * - `recovery`: text a refused save kept in the recovery copy (an earlier session ended before the
 *   person chose) differs from the file. Renderer-only: main never reports it as a disk change.
 */
export type OutlineDiskChangeKind = 'changed' | 'removed' | 'partial' | 'recovery'

export interface OutlineDiskChange {
  /** The outline path as the window that has the talk open knows it. */
  outlinePath: string
  kind: OutlineDiskChangeKind
  /** The version the person is shown: sha256 of the disk text (changed), `removed`, `partial:<temp>`,
   *  or `recovery`. Keep mine / Reload / Save again name it, so a newer change is never accepted unseen. */
  hash: string
  /** When it happened (ms since the epoch): the file's modification time, or the time of the event. */
  changedAt: number
  /** partial: the temp file that holds the save's full text. */
  tempPath?: string
  /** The person chose (Keep mine, Save it again, Save again) but the save then failed: why. The
   *  difference stays until a save lands; the editor's text is in the recovery copy meanwhile. */
  saveError?: string
}

/** A save refused because the file changed on disk since the app last read or wrote it. */
export interface OutlineChangedOnDiskRefusal {
  ok: false
  refused: 'changed-on-disk'
  change: OutlineDiskChange
}

/** Accepting a disk version (Keep mine / Reload / Save again): ok, or the file changed again (the newer
 *  change), or the request was refused (error). */
export type OutlineDiskAccept = { ok: true } | { ok: false; change: OutlineDiskChange | null; error?: string }

/** A recovery copy of an unsaved editor text (userData/recovery). */
export interface OutlineRecoveryCopy {
  text: string
  savedAt: number
}

export const CHANGED_ON_DISK_MESSAGE =
  'This talk changed on disk since TalkWeaver read it. Nothing was saved: choose Reload or Keep mine.'
export const REMOVED_ON_DISK_MESSAGE =
  'This talk was removed on disk. Nothing was saved: choose Save it again or Discard.'
export const PARTIAL_WRITE_MESSAGE =
  'A save failed halfway; the file on disk may be incomplete. Nothing more was saved: choose Save again.'
