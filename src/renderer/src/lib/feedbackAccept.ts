// Accept and Undo for the Feedback rail (shared-talk ticket 06). Accept (and Compare's Use hers) puts
// her proposal into the open talk's editor buffer through the one-writer seam (lib/outlineMutation
// apply, WorkspaceLayout applyOutlineMutation): one minimal change, one undo step in the editor, saved
// from the buffer through the file's save queue. The file is never written here, and never wholesale.
//
// Order, so the item's status never claims what the file does not hold:
//   1. refuse while the external-change guard has the talk held (its file differs from the editor);
//   2. work the change out against the buffer as it stands (feedback-accept applyProposal) and apply;
//   3. only once the save reached the disk: mark the item accepted in main, with the splice the save
//      wrote (ids it stamped included), which Undo reverses.
// A save that failed (the guard refusing a file changed on disk, or a write error) leaves the change in
// the editor, where ⌘Z takes it out; the item stays new. If he keeps it (the guard's Keep mine), the
// next Accept of that item finds her proposal already in the outline (applyProposal's `already`, read
// from the text itself, so it holds across a restart) and marks the item accepted with the splice that
// is there, instead of applying it a second time.
//
// Undo reverses that splice in the buffer the same way, then sets the item back to new.

import { ALREADY, applyProposal, isEmptyEdit, spliceEdit, undoEdit, type AcceptedEdit, type ProposalBase, type ProposalItem } from '../../../shared/feedback-accept.ts'
import type { FeedbackStatus } from '../../../shared/feedback.ts'
import type { OutlineMutate, OutlineMutationResult } from './outlineMutation.ts'

export interface FeedbackAcceptDeps<R> {
  /** The open talk's outline path (null with none open). */
  targetPath(): string | null
  /** The external-change guard holds the talk (its bar is up): nothing may be saved over the file. */
  diskChanged(): boolean
  /** The one-writer seam. */
  apply(outlinePath: string, mutate: OutlineMutate): Promise<OutlineMutationResult<R>>
  /** main's shared-talk:feedback-set-status. `ALREADY`: accepted with nothing changed (no Undo). */
  setStatus(itemId: string, status: FeedbackStatus, edit?: AcceptedEdit | typeof ALREADY | null): Promise<{ success: boolean; error?: string }>
}

export type FeedbackAcceptOutcome =
  | { ok: true; line: number }
  /** `applied`: the change is in the editor although it is not saved (⌘Z takes it out). */
  | { ok: false; error: string; applied: boolean }

export const DISK_CHANGED = 'This talk’s file changed on disk. Choose in the bar at the top of the talk first; nothing was changed.'
const NOT_OPEN = 'The talk is not open in the editor. Nothing was changed.'
const DISK_CHANGED_APPLIED = 'This talk’s file changed on disk, so the talk was not saved and the item stays new. Her text is in the editor (⌘Z takes it out); choose in the bar at the top of the talk.'
const NOT_SAVED = 'Her text is in the editor, but the talk could not be saved to disk, so the item stays new. Undo it in the editor (⌘Z) if you do not want it.'
const UNDO_NOT_SAVED = 'Undo is in the editor, but the talk could not be saved to disk, so the item stays accepted. ⌘Z in the editor puts her text back.'

/** Accepts applied to the editor whose save did not land, by talk and item: the splice they made, so a
 *  later Accept that finds the proposal already there records a real Undo (a replace cannot be undone
 *  from the text alone: his old lines are gone from it). */
const pendingEdits = new Map<string, AcceptedEdit>()
const pendingKey = (outlinePath: string, itemId: string): string => `${outlinePath}\0${itemId}`

/** What the save wrote: the stamped text when it stamped ids, else the text applied. */
function savedText<R>(result: Extract<OutlineMutationResult<R>, { ok: true; changed: true }>): string {
  const content = (result.saved as { content?: unknown } | null | undefined)?.content
  return typeof content === 'string' ? content : result.text
}

export async function acceptProposal<R>(itemId: string, item: ProposalItem, base: ProposalBase, deps: FeedbackAcceptDeps<R>): Promise<FeedbackAcceptOutcome> {
  const target = deps.targetPath()
  if (!target) return { ok: false, error: NOT_OPEN, applied: false }
  if (deps.diskChanged()) return { ok: false, error: DISK_CHANGED, applied: false }
  let line = 0
  const found: { already: AcceptedEdit | null; applied: string; base: string } = { already: null, applied: '', base: '' }
  // The only link from a block already in the outline to this item: the splice its earlier Accept made.
  const remembered = pendingEdits.get(pendingKey(target, itemId)) ?? base.remembered ?? null
  const result = await deps.apply(target, (current) => {
    const r = applyProposal(current, item, { ...base, remembered })
    if (!r.ok) throw new Error(r.error)
    line = r.line
    found.already = r.already ? r.edit : null
    found.applied = r.text
    found.base = current
    return r.text
  })
  if (!result.ok) {
    if (result.reason === 'not-open') return { ok: false, error: NOT_OPEN, applied: false }
    if (result.reason === 'save-failed') {
      pendingEdits.set(pendingKey(target, itemId), spliceEdit(found.base, found.applied, line))
      return { ok: false, error: deps.diskChanged() ? DISK_CHANGED_APPLIED : NOT_SAVED, applied: true }
    }
    return { ok: false, error: result.error, applied: false }
  }
  if (!result.changed) {
    // Already in the outline: nothing to write. Marked accepted with the splice an earlier Accept of
    // this item made (Undo takes it out), or, when the slide simply says what she wrote, with no
    // Undo at all ("Already what the slide says").
    const already = found.already
    if (!already) return { ok: false, error: 'Her proposal is already what the slide says. Nothing was changed.', applied: false }
    const marked = await deps.setStatus(itemId, 'accepted', isEmptyEdit(already) ? ALREADY : already)
    if (!marked.success) return { ok: false, error: `Her text is already in the talk, but the item could not be marked accepted (${marked.error || 'unknown error'}).`, applied: false }
    pendingEdits.delete(pendingKey(target, itemId))
    return { ok: true, line }
  }
  pendingEdits.delete(pendingKey(target, itemId))
  const edit = spliceEdit(result.base, savedText(result), line)
  const marked = await deps.setStatus(itemId, 'accepted', edit)
  if (!marked.success) return { ok: false, error: `Her text is in the talk, but the item could not be marked accepted (${marked.error || 'unknown error'}).`, applied: true }
  return { ok: true, line }
}

export async function undoAccepted<R>(itemId: string, edit: AcceptedEdit, deps: FeedbackAcceptDeps<R>): Promise<FeedbackAcceptOutcome> {
  const target = deps.targetPath()
  if (!target) return { ok: false, error: NOT_OPEN, applied: false }
  if (deps.diskChanged()) return { ok: false, error: DISK_CHANGED, applied: false }
  const result = await deps.apply(target, (current) => {
    const r = undoEdit(current, edit)
    if (!r.ok) throw new Error(r.error)
    return r.text
  })
  if (!result.ok) {
    if (result.reason === 'not-open') return { ok: false, error: NOT_OPEN, applied: false }
    if (result.reason === 'save-failed') return { ok: false, error: UNDO_NOT_SAVED, applied: true }
    return { ok: false, error: result.error, applied: false }
  }
  const marked = await deps.setStatus(itemId, 'new')
  if (!marked.success) return { ok: false, error: `The outline is back as it was, but the item could not be set back to new (${marked.error || 'unknown error'}).`, applied: true }
  return { ok: true, line: edit.line }
}
