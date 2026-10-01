// The Inspector's "Where it came from" card for a slide inserted from another vault (ticket 06;
// LOCKED-add-slide frames 5 and 6). Read-only; nothing is written. Shows nothing for a slide made here.
import { useEffect, useState, type CSSProperties } from 'react'
import { Clock } from 'lucide-react'
import type { SlideOriginInfo } from '../../../preload/index'
import { slideProvenanceView } from './slideProvenanceModel'

export default function SlideProvenance({ outlinePath, slideId }: { outlinePath: string; slideId: string | null }) {
  const [info, setInfo] = useState<SlideOriginInfo>(null)
  useEffect(() => {
    setInfo(null)
    if (!slideId) return
    let live = true
    void window.tw.ledger.origin(outlinePath, slideId).then((r) => { if (live) setInfo(r ?? null) }).catch(() => {})
    return () => { live = false }
  }, [outlinePath, slideId])
  if (!info) return null
  const view = slideProvenanceView(info)
  const initial = [...(info.vaultName || '?').trim()][0]?.toUpperCase() ?? '?'
  const color = info.badge?.color ?? null
  return (
    <section
      className={`tw-slide-prov${view.mine ? ' mine' : ' theirs'}`}
      style={color ? ({ '--c': color } as CSSProperties) : undefined}
      aria-label={view.summary}
      data-slide-provenance={view.mine ? 'owner' : 'colleague'}
      data-summary={view.summary}
    >
      <h3>Where it came from</h3>
      <div className="tw-slide-prov-card">
        <div className="tw-slide-prov-head">
          {view.mine && info.badge
            ? <span className="vs-vb lg" style={{ '--c': info.badge.color } as CSSProperties}>{info.badge.initial}</span>
            : <span className="vs-vb lg ghost">{info.badge?.initial ?? initial}</span>}
          <div>
            <div className="tw-slide-prov-from">{view.fromLine}</div>
            <div className="tw-slide-prov-vault">{view.vaultLine}</div>
          </div>
        </div>
        {view.rows.length > 0 && (
          <div className="tw-slide-prov-rows">
            {view.rows.map((r) => (
              <div className="tw-slide-prov-row" key={r.label}><span>{r.label}</span><span>{r.value}</span></div>
            ))}
          </div>
        )}
        {view.historyNote && <div className="tw-slide-prov-history"><Clock size={13} aria-hidden="true" />{view.historyNote}</div>}
        <p>{view.help}</p>
      </div>
    </section>
  )
}
