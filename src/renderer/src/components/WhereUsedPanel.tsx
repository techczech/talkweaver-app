import { useEffect, useState } from 'react'

// Read-only ledger MVP (ADR-0032): where a slide's {id=…} lives and which versions exist.
// The designed surface for this is the Slide Browser (design-first-dev cycle); this panel
// deliberately stays a list — no actions, no diffing. Visually matches ExplainPanel.

interface Hit {
  talk: string
  outline: string
}

interface Version {
  file: string
  talk: string
  savedAt: number
  sealed: boolean
  sealedBy: string | null
  lineage: string | null
  markdown: string
}

interface Props {
  slideId: string
  onClose: () => void
}

export default function WhereUsedPanel({ slideId, onClose }: Props) {
  const [hits, setHits] = useState<Hit[] | null>(null)
  const [versions, setVersions] = useState<Version[] | null>(null)

  useEffect(() => {
    let cancelled = false
    window.tw.ledger
      .whereUsed(slideId)
      .then((h) => { if (!cancelled) setHits(h) })
      .catch(() => { if (!cancelled) setHits([]) })
    window.tw.ledger
      .versions(slideId)
      .then((v) => { if (!cancelled) setVersions(v as Version[]) })
      .catch(() => { if (!cancelled) setVersions([]) })
    return () => {
      cancelled = true
    }
  }, [slideId])

  // Escape closes — capture phase so the editor's keymap never sees it (same as ExplainPanel).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [onClose])

  return (
    <>
      <div style={backdrop} onClick={onClose} />
      <div style={modal} role="dialog" aria-modal="true" aria-label="Where used and versions">
        <div style={titleBar}>
          <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--ink)' }}>
            Slide <code style={code}>{`{id=${slideId}}`}</code> — where used &amp; versions
          </span>
          <button onClick={onClose} aria-label="Close" style={closeBtn}>×</button>
        </div>

        <div style={body}>
          <div style={sectionHead}>
            Used in {hits ? hits.length : '…'} presentation{hits?.length === 1 ? '' : 's'}
          </div>
          {hits && hits.length === 0 && (
            <div style={emptyNote}>No outline currently contains this slide id.</div>
          )}
          <ul style={hitList}>
            {(hits ?? []).map((h) => (
              <li key={h.outline} style={hitRow}>
                <code style={code}>{h.talk}</code>
                <span style={pathText}> — {h.outline}</span>
              </li>
            ))}
          </ul>

          <div style={{ ...sectionHead, marginTop: 14 }}>
            {versions ? versions.length : '…'} version{versions?.length === 1 ? '' : 's'}
          </div>
          {versions && versions.length === 0 && (
            <div style={emptyNote}>No versions recorded yet — save the outline to stamp one.</div>
          )}
          <ol style={versionList}>
            {(versions ?? []).map((v) => (
              <li key={v.file} style={versionRow}>
                <div style={versionMeta}>
                  {new Date(v.savedAt).toLocaleString()} · <code style={code}>{v.talk}</code>
                  {v.sealed ? ` · sealed (${v.sealedBy})` : ''}
                  {v.lineage ? ` · from {id=${v.lineage}}` : ''}
                </div>
                <pre style={versionMd}>{v.markdown}</pre>
              </li>
            ))}
          </ol>
        </div>

        <div style={footer}>
          Read-only — the full slide history surface arrives with the Slide Browser.{' '}
          <kbd style={kbd}>Esc</kbd> to close.
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
const sectionHead: React.CSSProperties = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--faint)', marginBottom: 6 }
const emptyNote: React.CSSProperties = { fontSize: 12.5, color: 'var(--muted)', padding: '2px 0 6px' }
const hitList: React.CSSProperties = { margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }
const hitRow: React.CSSProperties = { fontSize: 13, color: 'var(--ink)', lineHeight: 1.45 }
const pathText: React.CSSProperties = { color: 'var(--muted)', fontSize: 12 }
const versionList: React.CSSProperties = { margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 10 }
const versionRow: React.CSSProperties = { fontSize: 13, color: 'var(--ink)', lineHeight: 1.45 }
const versionMeta: React.CSSProperties = { fontSize: 12.5 }
const versionMd: React.CSSProperties = {
  whiteSpace: 'pre-wrap', fontSize: 11, opacity: 0.8, margin: '4px 0 0',
  fontFamily: 'var(--font-mono)', background: 'var(--hover)', border: '1px solid var(--line)',
  borderRadius: 4, padding: '6px 8px', maxHeight: 160, overflowY: 'auto'
}
const code: React.CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 11.5, background: 'var(--hover)', padding: '1px 4px', borderRadius: 3 }
const footer: React.CSSProperties = { padding: '6px 14px', borderTop: '1px solid var(--line)', fontSize: 11, color: 'var(--faint)', textAlign: 'center', flexShrink: 0 }
const kbd: React.CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 11, background: 'var(--hover)', border: '1px solid var(--line)', borderRadius: 3, padding: '2px 5px', color: 'var(--ink)', display: 'inline-block' }
