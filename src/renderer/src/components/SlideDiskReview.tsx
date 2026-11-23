import { useEffect, useRef } from 'react'
import { Check, Undo2 } from 'lucide-react'
import { useLiveSlidePreview } from './useLiveSlidePreview'
import FixedDeckPreview from './FixedDeckPreview'
import ReviewChangedLines from './ReviewChangedLines'
import type { SlideDiskReview as SlideChange } from '../lib/slideDiskReview'
import type { OutlineMergeReview } from '../lib/outlineReconcile'

function SlidePicture({ path, outline, id, label }: { path: string; outline: string; id: string; label: string }) {
  const { previewUrl, previewErr } = useLiveSlidePreview(path, outline, id, label === 'Before' ? 'review-before' : 'review-after')
  return <div><h3>{label}</h3><div className="tw-review-picture">
    {previewErr && !previewUrl ? <p>Preview unavailable</p> : <FixedDeckPreview title={`${label} slide`} src={previewUrl ?? undefined} />}
  </div></div>
}

export default function SlideDiskReview({ path, review, change, busy, keep, putBack, close }: {
  path: string
  review: OutlineMergeReview
  change: SlideChange
  busy: boolean
  keep: () => void
  putBack: () => void
  close: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => { element?.close() }
  }, [])
  return <dialog ref={dialog} className="tw-agent-dialog tw-slide-review" aria-labelledby="tw-slide-review-heading"
    onCancel={event => { event.preventDefault(); if (!busy) close() }}>
    <h2 id="tw-slide-review-heading">“{change.title}” was changed outside TalkWeaver</h2>
    <p>The talk’s file was edited while it was open here. Only this slide changed on disk. Your typing is kept.</p>
    <div className="tw-review-columns">
      <SlidePicture path={path} outline={review.mine} id={change.id} label="Before" />
      <SlidePicture path={path} outline={change.proposedOutline} id={change.id} label="After" />
    </div>
    <ReviewChangedLines before={change.before} after={change.after} />
    <footer className="tw-agent-actions">
      <span>The slide keeps its id.</span>
      <button className="toolbar-btn" type="button" disabled={busy} onClick={putBack}><Undo2 size={15} />Put it back</button>
      <button className="toolbar-btn tw-agent-primary" type="button" disabled={busy} onClick={keep}><Check size={15} />Keep the change</button>
    </footer>
  </dialog>
}
