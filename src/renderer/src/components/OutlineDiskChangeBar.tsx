// The quiet bar at the top of an open talk when its outline file differs from what the editor holds
// (shared-talk ticket 01): "This talk changed on disk at 09:12 · Reload · Keep mine", and its variants
// for a talk removed on disk, a save that failed halfway, and unsaved text kept from an earlier session.
// No dialog; the talk stays usable in every view, and saves wait (refused by the main process) until a
// choice is made. OutlineDiskChangeSheet is the same choice when the person leaves the talk.
// lib/outlineDiskChange.ts carries out the choice.
import { useEffect } from 'react'
import { describeDiskChange, type OutlineDiskChange, type OutlineDiskChoice } from '../lib/outlineDiskChange'

export default function OutlineDiskChangeBar({ change, busy, onChoose }: {
  change: OutlineDiskChange
  busy: boolean
  onChoose: (choice: Exclude<OutlineDiskChoice, 'stay'>) => void
}) {
  const { text, actions } = describeDiskChange(change)
  return (
    <div className="disk-change-bar" role="status" aria-live="polite" data-testid="outline-disk-change-bar" data-kind={change.kind}>
      <span className="disk-change-bar__text">{text}</span>
      {actions.map((action) => (
        <span key={action.choice} className="disk-change-bar__item">
          <span className="disk-change-bar__sep" aria-hidden="true">·</span>
          <button type="button" className="disk-change-bar__action" disabled={busy} title={action.title}
            onClick={() => onChoose(action.choice)}>{action.label}</button>
        </span>
      ))}
    </div>
  )
}

/** The sheet that holds a talk switch or a window close until the person has chosen. */
export function OutlineDiskChangeSheet({ change, onAnswer }: {
  change: OutlineDiskChange
  onAnswer: (choice: OutlineDiskChoice) => void
}) {
  const { text, sheetTitle, actions } = describeDiskChange(change)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onAnswer('stay') }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [onAnswer])
  return (
    <>
      <div className="disk-change-sheet__scrim" onClick={() => onAnswer('stay')} />
      <div className="disk-change-sheet" role="dialog" aria-modal="true" aria-label={sheetTitle} data-testid="outline-disk-change-sheet">
        <div className="disk-change-sheet__title">{sheetTitle}</div>
        <div className="disk-change-sheet__detail">{text}. Choose what to keep before you leave the talk.</div>
        <div className="disk-change-sheet__actions">
          <button type="button" className="disk-change-sheet__btn disk-change-sheet__btn--ghost" onClick={() => onAnswer('stay')}>Stay here</button>
          {actions.map((action) => (
            <button key={action.choice} type="button" className="disk-change-sheet__btn" title={action.title}
              onClick={() => onAnswer(action.choice)}>{action.label}</button>
          ))}
        </div>
      </div>
    </>
  )
}
