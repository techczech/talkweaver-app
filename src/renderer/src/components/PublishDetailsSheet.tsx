import { useEffect, useId, useRef, useState } from 'react'
import { publishDiagnosticMessage, publishDiagnosticText, publishDiagnosticTitle, type PublishDiagnostic } from '../../../shared/publish-diagnostic'
import './rightPanel.css'

export default function PublishDetailsSheet({ diagnostic, close, retry, progress }: {
  diagnostic: PublishDiagnostic
  close: () => void
  retry?: () => void
  progress?: { text: string; cancel?: () => void; cancelling: boolean }
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const heading = useId()
  const [copyStatus, setCopyStatus] = useState('')
  const details = publishDiagnosticText(diagnostic)
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => { element?.close() }
  }, [])
  const copy = async (): Promise<void> => {
    try { await navigator.clipboard.writeText(details); setCopyStatus('Details copied.') }
    catch { setCopyStatus('Could not copy. Select and copy the diagnostics below.') }
  }
  return <dialog ref={dialog} className="tw-agent-dialog" aria-labelledby={heading}
    onCancel={event => { event.preventDefault(); if (!progress) close() }}>
    <h2 id={heading}>{publishDiagnosticTitle(diagnostic)}</h2>
    <p>{publishDiagnosticMessage(diagnostic)}</p>
    <details open={copyStatus.startsWith('Could not') || undefined}>
      <summary>Technical details</summary>
      <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{details}</pre>
    </details>
    <footer className="tw-agent-actions">
      <span role="status">{progress?.text ?? copyStatus}</span>
      <button type="button" className="toolbar-btn" onClick={() => void copy()}>Copy details</button>
      <button type="button" className="toolbar-btn" disabled={Boolean(progress)} onClick={close}>Close</button>
      {progress?.cancel && <button type="button" className="toolbar-btn" disabled={progress.cancelling} onClick={progress.cancel}>Cancel publish</button>}
      {retry && <button type="button" className="toolbar-btn tw-agent-primary" disabled={Boolean(progress)} onClick={retry}>Try again</button>}
    </footer>
  </dialog>
}
