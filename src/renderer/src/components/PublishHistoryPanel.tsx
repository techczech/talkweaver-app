import { useEffect, useState } from 'react'
import { publishStageLabel, type PublishHistoryAttempt, type PublishSiteCheck } from '../../../shared/publish-history'

export default function PublishHistoryPanel() {
  const [rows, setRows] = useState<PublishHistoryAttempt[]>([])
  const [error, setError] = useState<string | null>(null)
  const [check, setCheck] = useState<PublishSiteCheck | null>(null)
  const [busy, setBusy] = useState(false)
  const refresh = async (): Promise<void> => {
    try {
      const result = await window.tw.publish.history()
      if (result.ok) { setRows(result.attempts); setError(null) }
      else setError(result.error)
    } catch { setError('Publishing history could not be read.') }
  }
  useEffect(() => { void refresh() }, [])
  const checkSite = async (): Promise<void> => {
    setBusy(true)
    try { setCheck(await window.tw.publish.checkSite()); await refresh() }
    catch { setCheck({ state: 'unknown', checkedAt: new Date().toISOString() }) }
    finally { setBusy(false) }
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
    {!rows.length && !error && <p style={{ marginTop: 12 }}>No publishing attempts have been recorded on this Mac yet.</p>}
    <div style={{ maxHeight: 430, overflowY: 'auto', marginTop: 12 }}>
      {rows.map(row => <details key={row.id} style={{ borderTop: '1px solid var(--line)', padding: '12px 0' }}>
        <summary>{new Date(row.startedAt).toLocaleString()} — {row.computer} — {row.entry} — {row.outcome ?? 'not confirmed; check the site'}</summary>
        <p style={{ marginTop: 8 }}>{row.site ?? 'No destination was authorised'} · TalkWeaver {row.appVersion}</p>
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
      </details>)}
    </div>
    <p style={{ color: 'var(--muted)', fontSize: '.85rem', marginTop: 12 }}>Times use this Mac’s clock. Confirmation uses Cloudflare’s deployment identity. The last 50 attempts are kept.</p>
  </section>
}
