import { useLayoutEffect, useRef } from 'react'
import type { OutlineMergeReview } from '../lib/outlineReconcile'
import ReviewChangedLines from './ReviewChangedLines'
import './OutlineMergeSheet.css'

/** Read-only disk review for a clean editor. Dirty editors use the slide merge cards. */
export default function OutlineMergeSheet({ review, busy, onApply, onDismiss }: {
  review: OutlineMergeReview; busy: boolean
  onApply(): void; onDismiss(): void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => { element?.close() }
  }, [])
  return <dialog ref={dialog} className="outline-merge-sheet" aria-labelledby="outline-merge-title" data-testid="outline-merge-sheet"
    onCancel={event => { event.preventDefault(); if (!busy) onDismiss() }}>
    <h2 id="outline-merge-title">This talk was changed outside TalkWeaver</h2>
    <p>Review the text before bringing the disk version into this window.</p>
    <div className="outline-merge-conflicts">
      <ReviewChangedLines before={review.base} after={review.disk} />
      <div className="outline-merge-versions">
        <label>In this window<textarea readOnly value={review.mine} /></label>
        <label>On disk<textarea readOnly value={review.disk} /></label>
      </div>
    </div>
    <div className="outline-merge-actions">
      <button type="button" disabled={busy} onClick={onDismiss}>Stay here</button>
      <button type="button" disabled={busy} onClick={onApply}>{busy ? 'Loading…' : 'Keep the changes'}</button>
    </div>
  </dialog>
}
