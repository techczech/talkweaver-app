import { useEffect, useRef, useState } from 'react'
import { handoutAddressLabel } from '../../../shared/publish-status'
import { publishStageLabel, type PublishHistoryAttempt, type PublishSiteCheck } from '../../../shared/publish-history'
import { interruptedPublishDiagnostic, publishDiagnosticTitle, type PublishDiagnostic } from '../../../shared/publish-diagnostic'
import { useHandoutPublishProgress } from '../lib/useHandoutPublishProgress'
import PublishDetailsSheet from './PublishDetailsSheet'

export default function PublishHistoryPanel() {
  const [rows, setRows] = useState<PublishHistoryAttempt[]>([])
  const [error, setError] = useState<string | null>(null)
  const [check, setCheck] = useState<PublishSiteCheck | null>(null)
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<{ diagnostic: PublishDiagnostic; retryId?: string } | null>(null)
  const [retryNotice, setRetryNotice] = useState('')
  const retrying = useRef(false)
  const progress = useHandoutPublishProgress()
  const refresh = async (): Promise<void> => {
    try {
      const result = await window.tw.publish.history()
      if (result.ok) { setRows(result.attempts); setError(null) }
      else setError(result.error)
    } catch { setError('Publishing history could not be read.') }
  }
  useEffect(() => {
    void refresh()
    return window.tw.publish.onHistoryChanged?.(() => { void refresh() })
  }, [])
  const checkSite = async (): Promise<void> => {
    setBusy(true)
    try { setCheck(await window.tw.publish.checkSite()); await refresh() }
    catch { setCheck({ state: 'unknown', checkedAt: new Date().toISOString() }) }
    finally { setBusy(false) }
  }
  const retry = async (attemptId: string): Promise<void> => {
    if (retrying.current) return
    retrying.current = true
    setRetryNotice('')
    try {
      const result = await progress.run(id => window.tw.talk.retryHandoutPublish(attemptId, id))
      if (result.success) {
        setSelected(null)
        setRetryNotice(result.warning ? `Published with a warning. ${result.warning}` : 'Handout published.')
      } else {
        const diagnostic = result.diagnostic ?? interruptedPublishDiagnostic(result.error)
        if (result.notReady?.kind === 'media-warning' || result.notReady?.kind === 'media-ready') {
          const { title, detail } = result.notReady
          setSelected({ diagnostic: { ...diagnostic, cause: `${title}. ${detail ?? ''} Open the talk to review the media and publish it.` } })
        } else setSelected({ diagnostic, retryId: attemptId })
      }
      await refresh()
    } catch { setSelected({ diagnostic: interruptedPublishDiagnostic(), retryId: attemptId }) }
    finally { retrying.current = false }
  }
  return <section aria-label="Publishing history" style={{ border: '1px solid var(--line)', borderRadius: 6, padding: 16, marginBottom: 16 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'space-between' }}>
      <h3 style={{ fontSize: '1rem' }}>Publishing history on this Mac</h3>
      <button onClick={() => void checkSite()} disabled={busy}>{busy ? 'Checking…' : 'Check this Mac against the site'}</button>
    </div>
    <p role="status" style={{ marginTop: 10, color: 'var(--muted)' }}>{check
      ? `${check.state === 'in-step' ? 'This Mac and the site are in step for the last confirmed publication.' : check.state === 'changed' ? 'The site has changed since this Mac’s last confirmed publication.' : 'The site could not be compared with a confirmed publication on this Mac.'} Checked ${new Date(check.checkedAt).toLocaleString()}.`
      : 'Check the site for a current comparison. History alone does not prove that another Mac has synced.'}</p>
    {check?.publishedBy && <p style={{ marginTop: 8 }}>Last site publisher: {check.publishedBy}{check.publisherVersion ? ` · TalkWeaver ${check.publisherVersion}` : ''}{check.publishedAt ? ` · recorded at ${new Date(check.publishedAt).toLocaleString()} on that Mac’s clock` : ''}.</p>}
    {error && <p role="alert">{error}</p>}
    {retryNotice && <p role="status">{retryNotice}</p>}
    {!rows.length && !error && <p style={{ marginTop: 12 }}>No publishing attempts have been recorded on this Mac yet.</p>}
    <div style={{ maxHeight: 430, overflowY: 'auto', marginTop: 12 }}>
      {rows.map(row => {
        const finished = row.events.at(-1)
        const diagnostic = finished?.diagnostic
        const url = finished?.handoutUrl
        return <details key={row.id} style={{ borderTop: '1px solid var(--line)', padding: '12px 0' }}>
        <summary>{new Date(row.startedAt).toLocaleString()} — {row.computer} — {row.entry} — {diagnostic
          ? publishDiagnosticTitle(diagnostic) : row.outcome ?? 'not confirmed; check the site'}</summary>
        {diagnostic && <button type="button" className="toolbar-btn" aria-haspopup="dialog"
          onClick={() => setSelected({ diagnostic, retryId: row.canRetry ? row.id : undefined })}>Publish details</button>}
        <p style={{ marginTop: 8 }}>{row.site ?? 'No destination was authorised'} · TalkWeaver {row.appVersion}</p>
        {url && <p style={{ marginTop: 8, overflowWrap: 'anywhere' }}>
          <a href={url} onClick={event => { event.preventDefault(); void window.tw.shell.openExternal(url) }}>{handoutAddressLabel(url)}</a>
        </p>}
        <ol style={{ paddingLeft: 24, marginTop: 10 }}>
          {row.events.map((event, index) => <li key={index} style={{ margin: '7px 0', overflowWrap: 'anywhere' }}>
            {publishStageLabel[event.stage]}
            {event.files !== undefined && (event.stage === 'record' ? ` · ${event.files} short-link entries` : ` · ${event.files} file${event.files === 1 ? '' : 's'}`)}
            {event.bytes !== undefined && ` · ${event.bytes.toLocaleString()} bytes`}
            {event.missing !== undefined && ` · ${event.missing} files missing or unreadable`}
            {event.removed !== undefined && ` · ${event.removed} paths withdrawn`}
            {event.folders?.length ? ` · ${event.folders.join(', ')}` : ''}
            {event.revision && ` · deployment ${event.revision}`}
            {event.recordPresent !== undefined && (event.recordPresent ? ' · shared record found' : ' · first shared record needed')}
            {event.linksReconciled !== undefined && ` · ${event.linksReconciled} local short-link differences reconciled using the site’s ids`}
            {event.linkStyleChanged && ' · adopted the site’s short-link setting'}
          </li>)}
        </ol>
      </details>})}
    </div>
    <p style={{ color: 'var(--muted)', fontSize: '.85rem', marginTop: 12 }}>Times use this Mac’s clock. Confirmation uses Cloudflare’s deployment identity. The last 50 attempts are kept.</p>
    {selected && <PublishDetailsSheet key={selected.diagnostic.elapsedMs + selected.diagnostic.kind}
      diagnostic={selected.diagnostic} close={() => setSelected(null)} retry={selected.retryId ? () => void retry(selected.retryId!) : undefined}
      progress={progress.text ? { text: progress.text, cancelling: progress.cancelling,
        cancel: progress.canCancel ? () => void progress.cancel() : undefined } : undefined} />}
  </section>
}
