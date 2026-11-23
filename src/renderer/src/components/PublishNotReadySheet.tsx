import { useEffect, useRef } from 'react'
import type { PublishNotReady } from '../../../preload/index'
import { SAVE_AS_FILE } from '../../../shared/publish-status'
import { dismissToast, notify } from '../lib/notify'

// The sheet a publish shows when it cannot start (spec docs/plans/cloudflare-setup-in-app, the table
// "What each user action does when its feature is not ready"). Not connected: "Publishing needs a
// Cloudflare account", Open Settings, or "Save as a file instead". Connected with one thing missing:
// that thing named, and Open Settings (Settings → Cloudflare, where each is fixed, the site made too). Every word comes from the main process
// (src/shared/publish-status.ts); this file lays it out in the share sheet's look. It is used for
// Publish handout (the editor). A Run publishes from its checklist in Sessions (work-files ticket 29).

interface Props {
  /** "Publish handout" or "Publish Run handout": the action that was asked for. */
  what: string
  notReady: PublishNotReady
  onClose: () => void
  onRetry?: () => void
  onRecheck?: () => void
  onPublishAnyway?: () => void
  outlinePath?: string
  /** Save the handout as a file on this computer instead (offered when not connected). */
  onSaveAsFile?: () => void
}

export default function PublishNotReadySheet({ what, notReady, onClose, onSaveAsFile, onRetry, onRecheck, onPublishAnyway, outlinePath }: Props) {
  const mediaReady = notReady.kind === 'media-ready'
  const canPublish = (notReady.kind === 'media-warning' || mediaReady) && !!onPublishAnyway
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

  // Every fix is in Settings → Cloudflare. Making the site is there too: it saves the account and
  // site publishing goes to, which only the Settings window changes (Sol review 4).
  const fix = async (): Promise<void> => {
    onClose()
    if (notReady.fix.action === 'import-site-recovery') {
      const result = await window.tw.publish.importSiteRecovery().catch(() => ({ ok: false, error: 'The recovery record could not be checked.' }))
      if (result.ok) onRetry?.()
      else if (result.error) notify(result.error, 'warning')
      return
    }
    if (notReady.fix.action === 'show-source' && outlinePath) { window.tw.shell.showInFolder(outlinePath); return }
    if (notReady.fix.action === 'get-library-files' && outlinePath) {
      notify('Getting library files…', 'info', 'publish-library-files')
      const result = await window.tw.publish.getLibraryFiles(outlinePath).catch(() => ({ ok: false, error: 'The library could not be checked.' }))
      if (result.ok && notReady.kind === 'media-warning' && onRecheck) {
        dismissToast('publish-library-files')
        onRecheck()
        return
      }
      notify(result.ok ? 'Library files fetched. Check the talk, then press Publish again.' : result.error ?? 'Get the files in Finder using Download Now, then publish again.', result.ok ? 'info' : 'warning', 'publish-library-files', { label: 'Reveal source', onAction: () => window.tw.shell.showInFolder(outlinePath) })
      return
    }
    const shown = await window.tw.cloudflare.openSettings().catch(() => false)
    if (!shown) notify('Open the editor window, then Settings → Cloudflare.', 'info')
  }

  return (
    <div className="share-sheet-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="share-sheet" role="dialog" aria-modal="true" aria-labelledby="publish-not-ready-title" data-testid="publish-not-ready" data-kind={notReady.kind}>
        <div className="sh-head">
          <div className="sh-eyebrow">{what}</div>
          <h2 id="publish-not-ready-title">{notReady.title}</h2>
          <p data-testid="publish-not-ready-detail" style={canPublish ? { whiteSpace: 'pre-line' } : undefined}>
            {notReady.kind === 'not-connected'
              ? `${notReady.detail ? `${notReady.detail} ` : ''}Connect your Cloudflare account in Settings to publish to your own site, or save the handout as a file to send yourself.`
              : notReady.detail}
          </p>
        </div>
        <div className="sh-foot">
          {notReady.kind === 'not-connected' && onSaveAsFile && (
            <button className="sh-btn sh-btn--plain" data-testid="publish-save-as-file" onClick={() => { onClose(); onSaveAsFile() }}>{SAVE_AS_FILE}</button>
          )}
          <div className="sh-foot-right">
            <button className="sh-btn sh-btn--plain" onClick={onClose}>Cancel</button>
            {!mediaReady && <button ref={canPublish ? undefined : fixRef} className={canPublish ? 'sh-btn sh-btn--plain' : 'sh-btn'} data-testid="publish-fix" onClick={() => void fix()}>{notReady.fix.label}</button>}
            {canPublish && <button ref={fixRef} className="sh-btn" data-testid="publish-anyway" onClick={() => { onClose(); onPublishAnyway?.() }}>
              {mediaReady ? 'Publish' : 'Publish anyway (missing files show as placeholders)'}
            </button>}
          </div>
        </div>
      </div>
    </div>
  )
}
