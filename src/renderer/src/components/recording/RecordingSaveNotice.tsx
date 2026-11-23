import { useEffect } from 'react'
import { AlertTriangle } from 'lucide-react'

const unsavedChecks = new Set<() => boolean>()

/** The Tools shell can change views inside the window without a beforeunload event. */
export function hasUnsavedRecordingEdits(): boolean {
  for (const check of unsavedChecks) if (check()) return true
  return false
}

export function useKeepUnsavedRecordingOpen(hasUnsaved: () => boolean): void {
  useEffect(() => {
    unsavedChecks.add(hasUnsaved)
    const onClose = (event: BeforeUnloadEvent): void => {
      if (hasUnsaved()) {
        event.preventDefault()
        event.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', onClose)
    return () => {
      unsavedChecks.delete(hasUnsaved)
      window.removeEventListener('beforeunload', onClose)
    }
  }, [hasUnsaved])
}

export function RecordingSaveNotice({ className, error, count, saving, retry, discard }: {
  className: string; error: string; count?: number; saving: boolean; retry: () => void; discard: () => void
}): React.JSX.Element {
  return (
    <div className={className} data-recording-save-error role="alert">
      <AlertTriangle className="lt-icon" />
      <span><b>{count === undefined ? 'Unsaved recording edits.' : `${count} unsaved recording ${count === 1 ? 'edit' : 'edits'}.`}</b> {error}</span>
      <button className="tw-btn tw-btn--sm" disabled={saving} onClick={retry}>{saving ? 'Saving…' : 'Retry'}</button>
      <button className="tw-btn tw-btn--sm" disabled={saving} onClick={discard}>Discard unsaved edits</button>
    </div>
  )
}
