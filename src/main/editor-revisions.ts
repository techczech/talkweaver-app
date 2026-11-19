// Closing an editor window (ADR-0044 §6, rules B and D): what main knows of each editor's saves, by revision.
//
// The editor numbers every change the person makes to its text (its revision; the renderer's lib/editorRevision.ts,
// one counter per window that only goes up). Every save it sends carries the revision of the text it sent; loading a
// talk carries the revision the text was loaded at. Main records here, from the write itself, the last revision known
// to be on disk (`saved`: a successful write, or the load) and the last one it was asked to write (`attempted`,
// successful or not), and how many writes are still running.
//
// At a close the frozen editor (no typing, paste, drag, undo, menu or command edits) confirms with its current
// revision. Before this, main accepted "the last save did not fail" as the confirmation, which carried no revision:
// typing during the close's save scheduled a write the close did not wait for, and was lost (review round two,
// finding 1). Now:
//   - an update's restart closes the window only when the save of exactly this revision succeeded and nothing is
//     still being written (`restart`);
//   - every other close (the window's own, a quit) needs this revision to have been written or tried, with nothing
//     still being written (`close`): a save that failed keeps its old handling (the recovery copy and the sheets).
// Otherwise the answer is `resave`: the editor writes its current text once more and confirms again. No Electron
// here: scripts/test-editor-revisions.mjs drives it.

export type CloseMode = 'restart' | 'close'
export type RevisionVerdict = 'saved' | 'resave'

interface Record_ { saved: number | null; attempted: number | null; running: number; discarded: boolean }

export function createEditorRevisions() {
  const windows = new Map<number, Record_>()
  const of = (id: number): Record_ => {
    let r = windows.get(id)
    if (!r) { r = { saved: null, attempted: null, running: 0, discarded: false }; windows.set(id, r) }
    return r
  }
  const valid = (revision: unknown): revision is number => typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0

  return {
    /** The editor loaded a talk at `revision`: that text is the file's. */
    loaded(id: number, revision: unknown): void {
      const r = of(id)
      r.discarded = false
      if (valid(revision)) { r.saved = revision; r.attempted = revision } else { r.saved = null; r.attempted = null }
    },
    /** A save started; `finished` reports whether it wrote. A save without a revision (a workspace write of the
     *  editor's text) leaves the record unknown until a save with one: the close then asks for one more save. */
    writeStarted(id: number, revision: unknown): (ok: boolean) => void {
      const r = of(id)
      r.running += 1
      const rev = valid(revision) ? revision : null
      let done = false
      return (ok: boolean) => {
        if (done) return
        done = true
        r.running -= 1
        r.attempted = rev
        if (ok) r.saved = rev
      }
    },
    /** The person discarded the talk (removed on disk): it is never saved again from this editor. */
    discarded(id: number): void { of(id).discarded = true },
    /** The editor confirms its close at `revision` (its current one, frozen). */
    verdict(id: number, revision: unknown, mode: CloseMode): RevisionVerdict {
      const r = windows.get(id)
      if (!valid(revision)) return 'resave'
      if (r && r.running > 0) return 'resave'
      if (mode === 'restart') return r && !r.discarded && r.saved === revision ? 'saved' : 'resave'
      if (!r || r.discarded) return 'saved'
      return r.attempted === revision || r.saved === revision ? 'saved' : 'resave'
    },
    forget(id: number): void { windows.delete(id) },
  }
}
export type EditorRevisions = ReturnType<typeof createEditorRevisions>
