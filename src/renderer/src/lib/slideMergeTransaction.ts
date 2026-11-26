import { invertedEffects, isolateHistory } from '@codemirror/commands'
import { StateEffect, type EditorState, type Transaction } from '@codemirror/state'
import { normalizeOutlineMergeText } from '../../../shared/outline-merge.ts'
import { replaceDocTransaction } from './replaceDocTransaction.ts'

export function isSlideMergeReviewOpen(): boolean {
  return typeof document !== 'undefined' && document.querySelector('dialog.merge-cards:modal') !== null
}

const unchangedMerge = StateEffect.define<null>()
export const slideMergeHistory = invertedEffects.of(transaction =>
  transaction.effects.some(effect => effect.is(unchangedMerge)) ? [unchangedMerge.of(null)] : [])

/** Even when the choices keep the exact window text, Undo stops at the merge. */
export function slideMergeTransaction(state: EditorState, text: string): Transaction {
  const spec = replaceDocTransaction(state.doc.toString(), normalizeOutlineMergeText(text), { ownUndoStep: true })
  return state.update(spec ?? { effects: unchangedMerge.of(null), annotations: isolateHistory.of('full') })
}
