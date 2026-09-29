import { useEffect, useReducer, useRef } from 'react'
import type { TalkInfo } from '../../../preload/index'
import { initialShareSheet, shareSheetReducer, shareSheetView } from '../../../shared/shared-talk'
import { notify } from '../lib/notify'

// Share for comments (ticket 03) — the share sheet, built to
// docs/design/2026-09-28-shared-talk/LOCKED-share-sheet.html frame 2: centred over the editor, one
// sheet and no steps. The link is live the moment the sheet opens (opening it shares the talk) —
// unless the outline already carries a share link this Mac did not make: then the sheet first says
// sharing here replaces it, and shares only on "Share here".
// State lives in the pure reducer in src/shared/shared-talk.ts; this component only renders it and
// talks to main through window.tw.sharedTalk.

export default function ShareSheet({ talk, title, onClose }: { talk: TalkInfo; title: string; onClose: () => void }) {
  const [model, dispatch] = useReducer(shareSheetReducer, undefined, initialShareSheet)
  const view = shareSheetView(model)
  const doneRef = useRef<HTMLButtonElement>(null)
  const outlinePath = talk.outlinePath

  const cancelledRef = useRef(false)
  const keyRef = useRef<string | null>(null)

  async function shareNow(): Promise<void> {
    dispatch({ type: 'creating' })
    const res = await window.tw.sharedTalk.share(outlinePath, title)
    if (cancelledRef.current) return
    if (res.success && res.share) { keyRef.current = res.share.key; dispatch({ type: 'created', share: res.share }) }
    else dispatch({ type: 'failed', error: res.error || 'Could not share this talk.' })
  }

  useEffect(() => {
    cancelledRef.current = false
    const off = window.tw.sharedTalk.onChanged(({ key, state, previousKey }) => {
      if (cancelledRef.current) return
      if (previousKey && previousKey === keyRef.current) keyRef.current = key
      const mine = key === keyRef.current || state?.outlinePath === outlinePath || state?.realPath === outlinePath
      if (mine) dispatch({ type: 'changed', share: state })
    })
    void (async () => {
      const seen = await window.tw.sharedTalk.inspect(outlinePath).catch(() => ({ share: null, foreignShareUrl: null }))
      if (cancelledRef.current) return
      if (seen.share) keyRef.current = seen.share.key
      dispatch({ type: 'inspected', share: seen.share, foreignShareUrl: seen.foreignShareUrl })
      if (!seen.share && !seen.foreignShareUrl) await shareNow()
    })()
    return () => { cancelledRef.current = true; off() }
  }, [outlinePath, title])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  useEffect(() => { doneRef.current?.focus() }, [])

  useEffect(() => {
    if (!model.copied) return
    const t = setTimeout(() => dispatch({ type: 'copy-reset' }), 1800)
    return () => clearTimeout(t)
  }, [model.copied])

  async function copyLink(): Promise<void> {
    if (!view.link) return
    try {
      await navigator.clipboard.writeText(view.link)
      dispatch({ type: 'copied' })
    } catch {
      dispatch({ type: 'failed', error: 'Couldn’t copy the link.' })
    }
  }

  async function setOption(option: 'liveUpdates' | 'proposals', value: boolean): Promise<void> {
    const res = await window.tw.sharedTalk.setOptions(outlinePath, { [option]: value })
    if (res.success && res.share) dispatch({ type: 'changed', share: res.share })
    else dispatch({ type: 'failed', error: res.error || 'Could not change the setting.' })
  }

  async function updateCopy(): Promise<void> {
    const res = await window.tw.sharedTalk.update(outlinePath)
    if (res.success && res.share) dispatch({ type: 'changed', share: res.share })
    else dispatch({ type: 'failed', error: res.error || 'Could not update the shared copy.' })
  }

  async function stop(): Promise<void> {
    dispatch({ type: 'stopping' })
    const res = await window.tw.sharedTalk.stop(outlinePath)
    if (res.success) {
      if (res.serverClosed === false && res.message) notify(res.message, 'warning')
      onClose()
    }
    else dispatch({ type: 'failed', error: res.error || 'Could not stop sharing.' })
  }

  const share = model.share
  return (
    <div className="share-sheet-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="share-sheet" role="dialog" aria-modal="true" aria-labelledby="share-sheet-title" data-testid="share-sheet" data-phase={model.phase}>
        <div className="sh-head">
          <div className="sh-eyebrow">Share for comments</div>
          <h2 id="share-sheet-title">{title}</h2>
          <p>Anyone with this link can read the talk and comment. No account needed.</p>
        </div>
        <div className="sh-link">
          <div className="sh-link-main">
            <div className="sh-field" data-testid="share-link">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></svg>
              <span className="sh-field-text">{view.link || (model.phase === 'error' ? 'No link' : model.phase === 'confirm-replace' ? 'Not shared from this Mac yet' : 'Creating the link…')}</span>
            </div>
            {view.replaceWarning ? (
              <div className="sh-replace" role="alert" data-testid="share-replace-warning">
                <div>{view.replaceWarning}</div>
                <div className="sh-btnrow">
                  <button type="button" className="sh-btn" onClick={() => { void shareNow() }} data-testid="share-replace-confirm">Share here</button>
                  <button type="button" className="sh-btn sh-btn--plain" onClick={onClose}>Cancel</button>
                </div>
              </div>
            ) : (
              <div className="sh-btnrow">
                <button type="button" className="sh-btn" disabled={!view.canCopy} onClick={() => { void copyLink() }} data-testid="share-copy">{view.copyLabel}</button>
                {view.showPasteHint && <span className="sh-hint" data-testid="share-paste-hint">Paste it into Teams or an email.</span>}
              </div>
            )}
            {view.localNote && <div className="sh-status sh-local" data-testid="share-local-note">{view.localNote}</div>}
            <div className="sh-hint sh-promise">She sees the slides as they are in your outline now, one slide at a time, with space beside each to reply.</div>
            {view.status && (
              <div className={`sh-status ${view.statusTone === 'error' ? 'is-error' : ''}`} role="status" data-testid="share-status">{view.status}</div>
            )}
          </div>
          <div className="sh-qr-wrap">
            {share?.qrSvg
              ? <img className="sh-qr" data-testid="share-qr" alt="QR code for the link" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(share.qrSvg)}`} />
              : <div className="sh-qr sh-qr--empty" aria-hidden="true" />}
          </div>
        </div>
        <div className="sh-switches">
          <div className="sh-switch">
            <div className="sh-switch-text">
              <b id="sh-live-label">Show my latest saves as I work</b>
              <span>Her page updates a few seconds after you save. Off: she sees the talk as it is now.</span>
            </div>
            <button
              type="button" role="switch" className="sh-toggle" aria-labelledby="sh-live-label" data-testid="share-switch-live"
              aria-checked={share?.liveUpdates ?? true} disabled={!view.switchesEnabled}
              onClick={() => { if (share) void setOption('liveUpdates', !share.liveUpdates) }}
            />
          </div>
          <div className="sh-switch">
            <div className="sh-switch-text">
              <b id="sh-proposals-label">Let them propose slide text, not only notes</b>
              <span>She can reword a slide, propose deleting one, or propose a new slide or section. You get each as a proposal with the changes marked; nothing in the outline changes until you accept it.</span>
            </div>
            <button
              type="button" role="switch" className="sh-toggle" aria-labelledby="sh-proposals-label" data-testid="share-switch-proposals"
              aria-checked={share?.proposals ?? true} disabled={!view.switchesEnabled}
              onClick={() => { if (share) void setOption('proposals', !share.proposals) }}
            />
          </div>
        </div>
        <div className="sh-where">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true"><path d="M3 13l3-8h12l3 8v6H3z" /><path d="M3 13h5l1 3h6l1-3h5" /></svg>
          <div>Comments arrive in this talk&apos;s <b>Feedback tray</b>, beside the outline. The talk row shows how many are new.</div>
        </div>
        <div className="sh-foot">
          <button type="button" className="sh-stop" disabled={!view.canStop} onClick={() => { void stop() }} data-testid="share-stop">Stop sharing</button>
          <div className="sh-foot-right">
            {view.showUpdate && (
              <button type="button" className="sh-btn sh-btn--plain" onClick={() => { void updateCopy() }} data-testid="share-update">Update shared copy</button>
            )}
            <button type="button" ref={doneRef} className="sh-btn sh-btn--plain" onClick={onClose} data-testid="share-done">Done</button>
          </div>
        </div>
      </div>
    </div>
  )
}
