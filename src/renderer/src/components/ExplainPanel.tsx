import { useEffect, useState } from 'react'

interface Trace {
  navTitle: string
  layout: string
  titleLayout: string
  role: string
  mode: string
  split: string
  triggers: string[]
  wordCount: number
  bulletCount: number
  imageCount: number
  warnings: string[]
}

interface Props {
  isOpen: boolean
  onClose: () => void
  outlinePath: string
  content: string
  index: number | null
}

// "Explain rendering" (ADR-0024). Right-click a slide → see WHY it rendered the way it did, read
// from the ACTUAL compiled decisions (data-* on the slide's <section>), not a guess. Turns the
// opaque, content-adaptive layout into something inspectable so "inconsistent" becomes explainable.
export default function ExplainPanel({ isOpen, onClose, outlinePath, content, index }: Props) {
  const [trace, setTrace] = useState<Trace | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!isOpen || index == null) return
    setLoading(true)
    setTrace(null)
    window.tw.talk
      .explainSlide(outlinePath, content, index)
      .then((t) => setTrace(t))
      .catch(() => setTrace(null))
      .finally(() => setLoading(false))
  }, [isOpen, index, outlinePath, content])

  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [isOpen, onClose])

  if (!isOpen || index == null) return null

  // ── Plain-English mapping of the compiled decisions ──
  const layoutTrigger = trace?.triggers.find((t) => /^\{[a-z][a-z0-9-]*\}$/.test(t)) // a bare {word} sets layout
  const placement = (() => {
    if (!trace) return ''
    if (trace.titleLayout === 'left') return 'Side-by-side — title in a left rail, content on the right.'
    if (trace.titleLayout === 'top') return 'Stacked — title on top, content below.'
    if (trace.role === 'section-title' || trace.role === 'opening' || trace.role === 'ending' || trace.layout === 'statement-bigtitle')
      return 'Centred — a full-bleed divider/title treatment.'
    if (trace.layout === 'quote' || trace.layout === 'image-quote') return 'Title hidden (kept for navigation only) — quote layouts default to no on-slide title.'
    return 'Default — no left rail; title sits above the content.'
  })()
  const rows: Array<[string, string]> = trace
    ? [
        ['Layout', `${trace.layout || '(none)'}${layoutTrigger ? ` — set by your ${layoutTrigger} trigger` : ' — inferred from the slide content (no layout trigger written)'}`],
        ['Title placement', placement],
        ['Triggers you wrote', trace.triggers.length ? trace.triggers.join(' ') : '(none)'],
        ['Content', `${trace.wordCount} words · ${trace.bulletCount} bullets · ${trace.imageCount} images`],
        ['Role', trace.role || '(content)']
      ]
    : []

  return (
    <>
      <div style={backdrop} onClick={onClose} />
      <div style={modal} role="dialog" aria-modal="true" aria-label="Explain rendering">
        <div style={titleBar}>
          <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--ink)' }}>
            Why this slide rendered this way{trace?.navTitle ? ` — ${trace.navTitle}` : ''}
          </span>
          <button onClick={onClose} aria-label="Close" style={closeBtn}>×</button>
        </div>

        <div style={body}>
          {loading && <div style={{ color: 'var(--muted)', fontSize: 13 }}>Reading the compiled decisions…</div>}
          {!loading && !trace && <div style={{ color: 'var(--muted)', fontSize: 13 }}>Couldn't read the rendering (compiler unavailable?).</div>}
          {trace && (
            <>
              <div style={grid}>
                {rows.map(([k, v]) => (
                  <div key={k} style={rowWrap}>
                    <div style={keyCell}>{k}</div>
                    <div style={valCell}>{v}</div>
                  </div>
                ))}
              </div>

              {trace.warnings.length > 0 && (
                <div style={warnBox}>
                  ⚠ {trace.warnings.length} compiler warning{trace.warnings.length === 1 ? '' : 's'}: {trace.warnings.join(', ')}
                </div>
              )}

              <div style={rulesHead}>How a slide's layout is decided</div>
              <ol style={rules}>
                <li><b>Layout:</b> if you wrote a bare <code style={code}>{'{word}'}</code> trigger (e.g. <code style={code}>{'{statement}'}</code>) that wins; otherwise it&apos;s <b>inferred</b> from content (text → statement, a list → list, an image → media, image + text → copy-visual…).</li>
                <li><b>Title placement</b> follows the layout: <code style={code}>list / statement / contrast / quote / timeline</code> use a <b>left rail (side-by-side)</b>; others sit on top or centre. Placement and size are fixed per placement — the title does not scale with content length.</li>
                <li><b>Quote / section / title</b> layouts have their own centred treatment and hide or restyle the heading by default ({'{title=show}'} forces it back).</li>
              </ol>
            </>
          )}
        </div>
        <div style={footer}>Read live from the compiled output — not a guess. <kbd style={kbd}>Esc</kbd> to close.</div>
      </div>
    </>
  )
}

const backdrop: React.CSSProperties = { position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(23,32,42,0.35)' }
const modal: React.CSSProperties = {
  position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 1001,
  width: 600, maxWidth: '92vw', maxHeight: '86vh', display: 'flex', flexDirection: 'column',
  background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 'var(--radius)',
  boxShadow: '0 12px 40px #17202a2e, 0 2px 10px #17202a18', fontFamily: 'var(--font-ui)', overflow: 'hidden'
}
const titleBar: React.CSSProperties = { padding: '12px 14px', borderBottom: '1px solid var(--line)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexShrink: 0 }
const closeBtn: React.CSSProperties = { background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: 'var(--muted)', lineHeight: 1, padding: '2px 6px', borderRadius: 4, flexShrink: 0 }
const body: React.CSSProperties = { padding: '12px 14px', overflowY: 'auto', flex: 1 }
const grid: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 0 }
const rowWrap: React.CSSProperties = { display: 'grid', gridTemplateColumns: '130px 1fr', gap: 10, padding: '7px 0', borderBottom: '1px solid var(--line)', alignItems: 'baseline' }
const keyCell: React.CSSProperties = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--faint)' }
const valCell: React.CSSProperties = { fontSize: 13, color: 'var(--ink)', lineHeight: 1.45 }
const warnBox: React.CSSProperties = { marginTop: 10, padding: '8px 10px', borderRadius: 6, background: '#b8860b18', border: '1px solid #b8860b55', color: '#7a5c08', fontSize: 12.5, lineHeight: 1.4 }
const rulesHead: React.CSSProperties = { marginTop: 16, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--faint)' }
const rules: React.CSSProperties = { margin: '8px 0 0', paddingLeft: 18, fontSize: 12.5, color: 'var(--ink)', lineHeight: 1.55, display: 'flex', flexDirection: 'column', gap: 6 }
const code: React.CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 11.5, background: 'var(--hover)', padding: '1px 4px', borderRadius: 3 }
const footer: React.CSSProperties = { padding: '6px 14px', borderTop: '1px solid var(--line)', fontSize: 11, color: 'var(--faint)', textAlign: 'center', flexShrink: 0 }
const kbd: React.CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 11, background: 'var(--hover)', border: '1px solid var(--line)', borderRadius: 3, padding: '2px 5px', color: 'var(--ink)', display: 'inline-block' }
