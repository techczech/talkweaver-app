import { useEffect, useRef, useState } from 'react'
import type { PublishNotReady } from '../../../preload/index'
import { SAVE_AS_FILE } from '../../../shared/publish-status'
import { notify } from '../lib/notify'

// The sheet a publish shows when it cannot start (spec docs/plans/cloudflare-setup-in-app, the table
// "What each user action does when its feature is not ready"). Not connected: "Publishing needs a
// Cloudflare account", Open Settings, or "Save as a file instead". Connected with one thing missing:
// that thing named, and the one button that fixes it. Every word comes from the main process
// (src/shared/publish-status.ts); this file lays it out in the share sheet's look. It is used for
// Publish handout (the editor). A Run publishes from its checklist in Sessions (work-files ticket 29).

interface Props {
  /** "Publish handout" or "Publish Run handout": the action that was asked for. */
  what: string
  notReady: PublishNotReady
  onClose: () => void
  /** Save the handout as a file on this computer instead (offered when not connected). */
  onSaveAsFile: () => void
  /** Publish again, after "Create <site>" has made the site. */
  onRetry: () => void
}

export default function PublishNotReadySheet({ what, notReady, onClose, onSaveAsFile, onRetry }: Props) {
  const [busy, setBusy] = useState(false)
  const fixRef = useRef<HTMLButtonElement>(null)

  // Escape closes this sheet, as it closes the share sheet; it is not a registered shortcut (listed in the shortcut scan's ignore list).
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  useEffect(() => { fixRef.current?.focus() }, [])

  const fix = async (): Promise<void> => {
    if (notReady.fix.action === 'open-settings') {
      onClose()
      const shown = await window.tw.cloudflare.openSettings().catch(() => false)
      if (!shown) notify('Open the editor window, then Settings → Cloudflare.', 'info')
      return
    }
    // "Create <site>": the site is made (its name is on the button), then the publish is tried again.
    setBusy(true)
    const reply = await window.tw.cloudflare.createSite().catch(() => null)
    setBusy(false)
    if (reply?.ok && reply.status.publishing.state === 'ready') { onClose(); onRetry(); return }
    onClose()
    notify(reply && !reply.ok ? reply.error : 'The site could not be created. See Settings → Cloudflare.', 'error', 'publish-create-site')
  }

  return (
    <div className="share-sheet-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="share-sheet" role="dialog" aria-modal="true" aria-labelledby="publish-not-ready-title" data-testid="publish-not-ready" data-kind={notReady.kind}>
        <div className="sh-head">
          <div className="sh-eyebrow">{what}</div>
          <h2 id="publish-not-ready-title">{notReady.title}</h2>
          <p data-testid="publish-not-ready-detail">
            {notReady.kind === 'not-connected'
              ? `${notReady.detail ? `${notReady.detail} ` : ''}Connect your Cloudflare account in Settings to publish to your own site, or save the handout as a file to send yourself.`
              : notReady.detail}
          </p>
        </div>
        <div className="sh-foot">
          {notReady.kind === 'not-connected' && (
            <button className="sh-btn sh-btn--plain" data-testid="publish-save-as-file" onClick={() => { onClose(); onSaveAsFile() }}>{SAVE_AS_FILE}</button>
          )}
          <div className="sh-foot-right">
            <button className="sh-btn sh-btn--plain" onClick={onClose}>Cancel</button>
            <button ref={fixRef} className="sh-btn" data-testid="publish-fix" disabled={busy} onClick={() => void fix()}>{busy ? 'Creating…' : notReady.fix.label}</button>
          </div>
        </div>
      </div>
    </div>
  )
}
