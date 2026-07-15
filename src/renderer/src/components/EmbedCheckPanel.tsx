import { useCallback, useEffect, useState } from 'react'

interface EmbedStatus {
  slideId: string
  title: string
  url: string
  kind: 'youtube' | 'vimeo' | 'site'
  status: 'ok' | 'embedding-disabled' | 'not-found' | 'refuses-framing' | 'unreachable' | 'unknown'
  detail: string
}

interface Props {
  isOpen: boolean
  onClose: () => void
  outlinePath: string
  content: string
}

// "Check embeds" preflight. For each embed in the deck, says whether it will actually DISPLAY when
// presenting — catching embedding-disabled YouTube videos ("Video unavailable"), private/deleted
// videos, and sites that refuse framing — so the failure is found at the desk, not on stage.
const STATUS_META: Record<EmbedStatus['status'], { icon: string; label: string; color: string }> = {
  ok: { icon: '✓', label: 'Will embed', color: '#1a7f37' },
  'embedding-disabled': { icon: '⚠', label: 'Embedding disabled', color: '#9a6700' },
  'refuses-framing': { icon: '↪', label: 'Refuses framing', color: '#9a6700' },
  'not-found': { icon: '✗', label: 'Not found', color: '#b3261e' },
  unreachable: { icon: '✗', label: 'Unreachable', color: '#883' },
  unknown: { icon: '?', label: 'Unknown', color: '#666' }
}

export default function EmbedCheckPanel({ isOpen, onClose, outlinePath, content }: Props) {
  const [results, setResults] = useState<EmbedStatus[] | null>(null)
  const [loading, setLoading] = useState(false)

  const run = useCallback(() => {
    setLoading(true)
    setResults(null)
    window.tw.talk
      .checkEmbeds(outlinePath, content)
      .then((r) => setResults(r))
      .catch(() => setResults([]))
      .finally(() => setLoading(false))
  }, [outlinePath, content])

  useEffect(() => {
    if (isOpen) run()
  }, [isOpen, run])

  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [isOpen, onClose])

  if (!isOpen) return null

  const problems = results?.filter((r) => r.status !== 'ok') ?? []
  const summary = results == null
    ? ''
    : results.length === 0
      ? 'No network embeds in this talk.'
      : `${results.length} embed${results.length === 1 ? '' : 's'} — ${results.length - problems.length} OK${problems.length ? `, ${problems.length} need attention` : ''}.`

  return (
    <>
      <div style={backdrop} onClick={onClose} />
      <div style={modal} role="dialog" aria-modal="true" aria-label="Check embeds">
        <div style={titleBar}>
          <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--ink)' }}>Will these embeds load when presenting?</span>
          <button onClick={onClose} aria-label="Close" style={closeBtn}>×</button>
        </div>

        <div style={body}>
          {loading && <div style={{ color: 'var(--muted)', fontSize: 13 }}>Checking each embed against its source…</div>}
          {!loading && results && (
            <>
              <div style={summaryLine}>{summary}</div>
              {results.map((r, i) => {
                const meta = STATUS_META[r.status]
                return (
                  <div key={`${r.slideId}-${i}`} style={row}>
                    <span style={{ ...badge, color: meta.color, borderColor: meta.color }} title={meta.label}>
                      {meta.icon} {meta.label}
                    </span>
                    <div style={rowMain}>
                      <div style={rowTitle}>{r.title}</div>
                      <div style={rowUrl} title={r.url}>{r.url}</div>
                      <div style={rowDetail}>{r.detail}</div>
                    </div>
                    <button style={openBtn} onClick={() => window.tw.shell.openExternal(r.url)} title="Open the source in your browser">
                      Open ↗
                    </button>
                  </div>
                )
              })}
            </>
          )}
        </div>

        <div style={footer}>
          <button style={recheckBtn} onClick={run} disabled={loading}>Re-check</button>
          <span>Embedding-disabled videos can't play in any embed — use a different upload or link out. <kbd style={kbd}>Esc</kbd> to close.</span>
        </div>
      </div>
    </>
  )
}

const backdrop: React.CSSProperties = { position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(23,32,42,0.35)' }
const modal: React.CSSProperties = {
  position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 1001,
  width: 640, maxWidth: '92vw', maxHeight: '86vh', display: 'flex', flexDirection: 'column',
  background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 'var(--radius)',
  boxShadow: '0 12px 40px #17202a2e, 0 2px 10px #17202a18', fontFamily: 'var(--font-ui)', overflow: 'hidden'
}
const titleBar: React.CSSProperties = { padding: '12px 14px', borderBottom: '1px solid var(--line)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexShrink: 0 }
const closeBtn: React.CSSProperties = { background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: 'var(--muted)', lineHeight: 1, padding: '2px 6px', borderRadius: 4, flexShrink: 0 }
const body: React.CSSProperties = { padding: '12px 14px', overflowY: 'auto', flex: 1 }
const summaryLine: React.CSSProperties = { fontSize: 13, fontWeight: 600, color: 'var(--ink)', marginBottom: 10 }
const row: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 12, padding: '9px 0', borderBottom: '1px solid var(--line)', alignItems: 'start' }
const badge: React.CSSProperties = { fontSize: 11, fontWeight: 700, border: '1px solid', borderRadius: 999, padding: '2px 8px', whiteSpace: 'nowrap', height: 'fit-content' }
const rowMain: React.CSSProperties = { minWidth: 0 }
const rowTitle: React.CSSProperties = { fontSize: 13.5, fontWeight: 600, color: 'var(--ink)' }
const rowUrl: React.CSSProperties = { fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'var(--faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const rowDetail: React.CSSProperties = { fontSize: 12, color: 'var(--muted)', marginTop: 2 }
const openBtn: React.CSSProperties = { background: 'var(--hover)', border: '1px solid var(--line)', borderRadius: 6, padding: '4px 9px', fontSize: 12, cursor: 'pointer', color: 'var(--ink)', whiteSpace: 'nowrap', height: 'fit-content' }
const footer: React.CSSProperties = { padding: '8px 14px', borderTop: '1px solid var(--line)', fontSize: 11, color: 'var(--faint)', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }
const recheckBtn: React.CSSProperties = { background: 'var(--hover)', border: '1px solid var(--line)', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer', color: 'var(--ink)', flexShrink: 0 }
const kbd: React.CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 11, background: 'var(--hover)', border: '1px solid var(--line)', borderRadius: 3, padding: '2px 5px', color: 'var(--ink)', display: 'inline-block' }
