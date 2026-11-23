import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { OutlineMergeReview } from '../lib/outlineReconcile'
import './OutlineMergeSheet.css'

export default function OutlineMergeSheet({ review, busy, onApply, onDismiss, onDraft, initialChoices = {} }: {
  review: OutlineMergeReview; busy: boolean; initialChoices?: Record<string, string>
  onApply(generation: number, choices: Record<string, string>): void
  onDismiss(): void
  onDraft(generation: number, choices: Record<string, string>): void
}) {
  const [choices, setChoices] = useState<Record<string, string>>(initialChoices)
  const surface = useRef<HTMLDivElement>(null)
  const dismissRef = useRef(onDismiss)
  dismissRef.current = onDismiss
  const busyRef = useRef(busy)
  busyRef.current = busy
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const siblings = Array.from(document.body.children).filter(el => el !== surface.current && !el.hasAttribute('inert'))
    siblings.forEach(el => el.setAttribute('inert', ''))
    surface.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); if (!busyRef.current) dismissRef.current(); return }
      if (event.key !== 'Tab') return
      const items = Array.from(surface.current?.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled)') ?? [])
      const first = items[0], last = items.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    window.addEventListener('keydown', key, { capture: true })
    return () => {
      window.removeEventListener('keydown', key, { capture: true })
      siblings.forEach(el => el.removeAttribute('inert'))
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])
  const choose = (id: string, text: string): void => {
    const next = { ...choices, [id]: text }
    setChoices(next); onDraft(review.generation, next)
  }
  const remaining = review.merge.conflicts.filter(item => !Object.hasOwn(choices, item.id)).length
  return createPortal(<div ref={surface} className="outline-merge-root">
    <div className="disk-change-sheet__scrim" />
    <div className="outline-merge-sheet" role="dialog" aria-modal="true" aria-labelledby="outline-merge-title" data-testid="outline-merge-sheet">
      <h2 id="outline-merge-title">Choose the changes to keep</h2>
      <p>These slides changed in both places. Independent edits are already included. Both versions are kept in recovery. Nothing is written until you apply the merge.</p>
      <button type="button" disabled={busy} onClick={onDismiss}>Stay here</button>
      {review.recoveryPath && <button type="button" disabled={busy} onClick={() => { void window.tw.shell.showInFolder(review.recoveryPath!) }}>Show recovery copy</button>}
      <div className="outline-merge-conflicts">
        {review.merge.conflicts.map((item, index) => <section key={item.id} aria-label={`Conflict ${index + 1}: ${item.label}`}>
          <h3>{item.label}</h3>
          <div className="outline-merge-versions">
            <label>Mine{item.mineDeleted && <span> — Deleted on this side</span>}
              <textarea aria-label={`Mine ${index + 1}`} readOnly value={item.mine} />
              <button type="button" disabled={busy} onClick={() => choose(item.id, item.mine)}>Use mine</button>
            </label>
            <label>On disk{item.diskDeleted && <span> — Deleted on this side</span>}
              <textarea aria-label={`On disk ${index + 1}`} readOnly value={item.disk} />
              <button type="button" disabled={busy} onClick={() => choose(item.id, item.disk)}>Use on disk</button>
            </label>
          </div>
          <label>Result{!Object.hasOwn(choices, item.id) && <span> — Choose a version or edit below</span>}
            <textarea aria-label={`Result ${index + 1}`} disabled={busy} value={choices[item.id] ?? item.mine} onChange={event => choose(item.id, event.target.value)} />
          </label>
        </section>)}
      </div>
      <div className="outline-merge-actions">
        <span role="status">{remaining} {remaining === 1 ? 'slide still needs' : 'slides still need'} a choice</span>
        <button type="button" disabled={busy || review.merge.conflicts.some(item => !Object.hasOwn(choices, item.id))} onClick={() => onApply(review.generation, choices)}>{busy ? 'Saving…' : 'Apply merge'}</button>
      </div>
    </div>
  </div>, document.body)
}
