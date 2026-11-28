import { invertedEffects, isolateHistory } from '@codemirror/commands'
import { StateEffect, type EditorState, type Transaction } from '@codemirror/state'
import { normalizeOutlineMergeText } from '../../../shared/outline-merge.ts'
import type { SlideMergeApplyReply } from '../../../shared/outline-slide-merge.ts'
import { replaceDocTransaction } from './replaceDocTransaction.ts'

let openReviews = 0
export function openSlideMergeReview(): () => void {
  openReviews++
  return () => { openReviews-- }
}

export function isSlideMergeReviewOpen(): boolean {
  return openReviews > 0
}

// The main-process apply reply can settle the editor's queue even if its individual write
// reply never arrives. Main only reports a timeout if the writer can still be stopped.
const saves = new Map<string, Promise<SlideMergeApplyReply>>()
export function trackSlideMergeSave(generation: string, reply: Promise<SlideMergeApplyReply>): Promise<SlideMergeApplyReply> {
  saves.set(generation, reply)
  return reply.finally(() => { if (saves.get(generation) === reply) saves.delete(generation) })
}

export function slideMergeSaveReply(generation: string): Promise<SlideMergeApplyReply> | undefined {
  return saves.get(generation)
}

const unchangedMerge = StateEffect.define<null>()
export const slideMergeHistory = invertedEffects.of(transaction =>
  transaction.effects.some(effect => effect.is(unchangedMerge)) ? [unchangedMerge.of(null)] : [])

/** Even when the choices keep the exact window text, Undo stops at the merge. */
export function slideMergeTransaction(state: EditorState, text: string): Transaction {
  const spec = replaceDocTransaction(state.doc.toString(), normalizeOutlineMergeText(text), { ownUndoStep: true })
  return state.update(spec ?? { effects: unchangedMerge.of(null), annotations: isolateHistory.of('full') })
}
