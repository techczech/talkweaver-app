// Buffer-first mutations of a talk outline (one-writer spec D1). For the talk open in this window the
// editor's CodeMirror buffer is the only source of the outline text, and disk is written only from
// that buffer, through the file's save queue. Every programmatic change of the open talk — a slide
// reorder, grid undo, and every main-process write that T1's writer routes here (tags, frontmatter,
// ledger detach, image optimisation, the handout stamp, "Add to talk") — therefore runs one way:
//
//   1. wait for any save in flight (and the stamped-id adoption it brings back), so the base is the
//      buffer as it will stand;
//   2. read the buffer (the editor's own doc, never the React mirror of it);
//   3. work out the new text from it (`mutate`, which may be a round trip to the main process);
//   4. if the person typed while `mutate` ran, work it out again against the buffer as it now stands
//      (a result computed from an older buffer is never applied);
//   5. put the new text into the buffer as ONE minimal change — caret, scroll and undo history kept,
//      the editor never remounted — superseding the pending debounced autosave;
//   6. save that buffer through the file's queue, then adopt any ids the save stamped.
//
// Steps 4 and 5 run with no await between them, so nothing can edit the buffer in between. A talk
// that is not open in this window is not this module's business: its callers use the main-process
// handler, which writes it through writeTalkOutline (src/main/talk-writer.ts).
//
// Inserts at the caret (a searched slide, an archive image) are the one change whose place is not in
// the text: `insertAtCaret` puts the block in through the editor's own insert channel — one change at
// the live caret, exactly like typing it — and then saves the buffer as it stands through the same
// path (steps 1, 2, 5 and 6 with the identity change), superseding the debounced autosave.

import { changeNoun, INSTANT_SLIDE_ORIGIN } from '../../../shared/editor-document.ts'

/** The open editor's buffer (WorkspaceLayout wires it to the Editor's registered read / replace). */
export interface OutlineEditorBuffer {
  /** The editor's live text for `outlinePath`, or null when the editor does not hold that talk's loaded text. */
  read(outlinePath: string): string | null
  /** Puts `next` into the buffer as one minimal change, supersedes the pending debounced autosave (the
   *  caller saves the whole buffer at once) and returns the buffer text to save, or null when the
   *  editor is not ready. */
  apply(outlinePath: string, next: string): string | null
  /** After a save: adopts `saved` (the text with stamped ids) only while the buffer is still `sent`. */
  adopt(outlinePath: string, sent: string, saved: string): void
  /** Inserts `block` at the live caret as one change (the editor's insert channel, Editor.tsx
   *  registerInsert). False when the editor does not hold that talk's loaded text. */
  insertAtCaret?(outlinePath: string, block: string): boolean
}

/** What a queued outline save answers (window.tw.talk.writeOutline): `content` is the stamped text. */
export type OutlineSaveReply = { ok: boolean; content?: string } | false | null | undefined

export interface OutlineMutatorDeps<R extends OutlineSaveReply> {
  /** The open editor's buffer when this window has `outlinePath` open, else null. */
  bufferFor(outlinePath: string): OutlineEditorBuffer | null
  /** Resolves once every save queued so far for this file has finished (lib/saveQueue outlineWritesSettled). */
  settled(outlinePath: string): Promise<void>
  /** Saves `text` through the file's save queue (WorkspaceLayout.writeOutline). */
  write(outlinePath: string, text: string): Promise<R>
  /** Called after every save this module made that reached the disk (save indicator, collisions). */
  onSaved?(outlinePath: string, reply: R): void
  /** Called when a save this module made did not reach the disk (the change stays in the buffer). */
  onSaveFailed?(outlinePath: string, reply: R): void
}

/** Works out the new outline from the buffer's current text. A thrown error refuses the change. */
export type OutlineMutate = (current: string) => string | Promise<string>

export interface OutlineMutationOptions {
  /** Save even when `mutate` returns its input (a forced save of the buffer as it stands). */
  force?: boolean
  /** Apply only while the buffer is exactly this text; otherwise refuse ('moved') without retrying. */
  base?: string
  /** How many times to work the change out again when the buffer moves while `mutate` runs (default 3). */
  attempts?: number
}

export type OutlineMutationFailure = 'not-open' | 'refused' | 'moved' | 'save-failed'

export type OutlineMutationResult<R> =
  | { ok: true; changed: false; base: string; text: string }
  | { ok: true; changed: true; base: string; text: string; saved: R }
  /** `applied`: the change is in the buffer (undoable) although its save failed. */
  | { ok: false; reason: OutlineMutationFailure; error: string; applied: boolean; base?: string; saved?: R }

export interface OutlineMutator<R extends OutlineSaveReply> {
  /** Applies `mutate` to the open talk's buffer, then saves it (the D1 seam). */
  apply(outlinePath: string, mutate: OutlineMutate, opts?: OutlineMutationOptions): Promise<OutlineMutationResult<R>>
  /** Inserts `block` at the open talk's live caret (one change, undoable), then saves the buffer as it
   *  stands through the file's queue. `not-open` (nothing inserted) when the editor does not hold it. */
  insertAtCaret(outlinePath: string, block: string): Promise<OutlineMutationResult<R>>
  /** The main process's `read` request (outline:editor-request): the buffer once saves in flight settle. */
  readForMain(outlinePath: string): Promise<{ ok: true; text: string } | { ok: false; error: string }>
  /** The main process's `apply` request: `next` goes in only while the buffer is still `base`; ok once
   *  saved, with `text`: exactly what that save wrote (`next` with any ids it stamped). `origin` (the
   *  main writer) words the refusal; `moved`: refused only because the buffer was no longer `base`. */
  applyFromMain(outlinePath: string, base: string, next: string, origin?: string): Promise<{ ok: true; text: string } | { ok: false; error: string; moved?: boolean }>
}

// The main-route replies. "Add to talk" (the first routed writer, origin instant-slide) keeps the words
// it has always shown; every other writer is named by its noun (shared/editor-document changeNoun).
export const NOT_READY_FOR_MAIN = 'The talk is not ready in its editor window. Nothing was added; try again.'
export const MOVED_FOR_MAIN = 'The talk was edited while the slide was being added. Nothing was changed; try again.'
export const SAVE_FAILED_FOR_MAIN = 'The slide is in the open editor, but the talk could not be saved to disk, so it is not marked as added. Undo it in the editor (⌘Z) if you do not want it, and check the talk before adding it again.'
// Publish's flush (talk-writer.ts flushTalkForPublish) saves the buffer as it stands: it changes
// nothing in the editor, so its refusals say nothing was published and never suggest ⌘Z (that would
// undo the person's own edit).
export const PUBLISH_FLUSH_ORIGIN = 'publish-flush'
export const PUBLISH_FLUSH_REPLIES = {
  notReady: 'The talk is not ready in its editor window, so nothing was published. Try again.',
  moved: 'The talk was edited while it was being saved for publishing. Nothing was published; try again.',
  saveFailed: 'The talk could not be saved to disk, so nothing was published. Your edits are still in the editor.',
}
export function mainRouteReplies(origin: string | undefined): { notReady: string; moved: string; saveFailed: string } {
  if (origin === undefined || origin === INSTANT_SLIDE_ORIGIN) return { notReady: NOT_READY_FOR_MAIN, moved: MOVED_FOR_MAIN, saveFailed: SAVE_FAILED_FOR_MAIN }
  if (origin === PUBLISH_FLUSH_ORIGIN) return PUBLISH_FLUSH_REPLIES
  const noun = changeNoun(origin)
  return {
    notReady: `The talk is not ready in its editor window, so applying ${noun} changed nothing. Try again.`,
    moved: `The talk was edited while applying ${noun}. Nothing was changed; try again.`,
    saveFailed: `Applying ${noun} changed the open editor, but the talk could not be saved to disk. Undo it in the editor (⌘Z) if you do not want it, and check the talk before trying again.`,
  }
}
const NOT_OPEN = 'The talk is not ready in its editor. Nothing was changed; try again.'
const KEPT_MOVING = 'The talk kept changing while this change was being worked out. Nothing was changed; try again.'
const SAVE_FAILED = 'The change is in the open editor, but the talk could not be saved to disk.'

const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

export function createOutlineMutator<R extends OutlineSaveReply>(deps: OutlineMutatorDeps<R>): OutlineMutator<R> {
  async function apply(outlinePath: string, mutate: OutlineMutate, opts: OutlineMutationOptions = {}): Promise<OutlineMutationResult<R>> {
    const notOpen: OutlineMutationResult<R> = { ok: false, reason: 'not-open', error: NOT_OPEN, applied: false }
    const buffer = deps.bufferFor(outlinePath)
    if (!buffer) return notOpen
    const attempts = opts.base !== undefined ? 1 : Math.max(1, opts.attempts ?? 3)
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await deps.settled(outlinePath)
      const base = buffer.read(outlinePath)
      if (base == null) return notOpen
      if (opts.base !== undefined && base !== opts.base) return { ok: false, reason: 'moved', error: KEPT_MOVING, applied: false, base }
      let next: string
      try { next = await mutate(base) } catch (error) { return { ok: false, reason: 'refused', error: message(error), applied: false, base } }
      if (typeof next !== 'string') return { ok: false, reason: 'refused', error: 'The change could not be worked out. Nothing was changed.', applied: false, base }
      // Typed while the change was being worked out: never apply a result computed from an older buffer.
      if (buffer.read(outlinePath) !== base) continue
      if (next === base && !opts.force) return { ok: true, changed: false, base, text: base }
      const text = buffer.apply(outlinePath, next)
      if (text == null) return notOpen
      const saved = await deps.write(outlinePath, text)
      if (!saved || saved.ok !== true) {
        deps.onSaveFailed?.(outlinePath, saved)
        return { ok: false, reason: 'save-failed', error: SAVE_FAILED, applied: true, base, saved }
      }
      if (typeof saved.content === 'string' && saved.content !== text) buffer.adopt(outlinePath, text, saved.content)
      deps.onSaved?.(outlinePath, saved)
      return { ok: true, changed: true, base, text, saved }
    }
    return { ok: false, reason: 'moved', error: KEPT_MOVING, applied: false }
  }

  async function insertAtCaret(outlinePath: string, block: string): Promise<OutlineMutationResult<R>> {
    const notOpen: OutlineMutationResult<R> = { ok: false, reason: 'not-open', error: NOT_OPEN, applied: false }
    const buffer = deps.bufferFor(outlinePath)
    if (!buffer?.insertAtCaret || buffer.read(outlinePath) == null) return notOpen
    if (!buffer.insertAtCaret(outlinePath, block)) return notOpen
    // The block is in the buffer like typed text; save the buffer as it stands (forced: the identity
    // change still supersedes the autosave and goes through the queue after any save in flight).
    const saved = await apply(outlinePath, (current) => current, { force: true })
    return saved.ok ? saved : { ...saved, applied: true }
  }

  return {
    apply,
    insertAtCaret,
    async readForMain(outlinePath) {
      const buffer = deps.bufferFor(outlinePath)
      if (!buffer) return { ok: false, error: NOT_READY_FOR_MAIN }
      await deps.settled(outlinePath)
      const text = buffer.read(outlinePath)
      return text == null ? { ok: false, error: NOT_READY_FOR_MAIN } : { ok: true, text }
    },
    async applyFromMain(outlinePath, base, next, origin) {
      // Forced: main decided this write (a flush for publish commits the buffer to itself).
      const result = await apply(outlinePath, () => next, { base, force: true })
      // What the save wrote: the stamped text when the save stamped ids, else the text applied.
      if (result.ok) {
        const stamped = result.changed ? (result.saved as { content?: unknown } | null | undefined)?.content : undefined
        return { ok: true, text: typeof stamped === 'string' ? stamped : result.text }
      }
      const replies = mainRouteReplies(origin)
      if (result.reason === 'not-open') return { ok: false, error: replies.notReady }
      if (result.reason === 'save-failed') return { ok: false, error: replies.saveFailed }
      return { ok: false, error: replies.moved, moved: true }
    },
  }
}
