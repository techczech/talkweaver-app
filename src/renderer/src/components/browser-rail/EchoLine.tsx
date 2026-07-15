// The echo line above the grid — restates the active FILTER query in words (ADR-0009 §4:
// "the echo line above the grid restates the query"). Pills reuse the rail's chip grammar
// (tags filled, sections hollow, layouts pill-round, content tinted) with AND joins; each
// pill removes itself. Scope is NOT echoed — it is furniture, visible in the rail and the
// grid's own headers.
import { X } from 'lucide-react'
import { CONTENT_LABELS } from './railModel'
import type { ContentKey, RailFacets, ToggleFacetFn } from './railTypes'

export default function EchoLine({ facets, onToggle, onClearFacets }: {
  facets: RailFacets
  onToggle: ToggleFacetFn
  onClearFacets: () => void
}) {
  const kinds: React.ReactNode[][] = []
  const pill = (cls: string, kind: Parameters<ToggleFacetFn>[0], value: string, label: string): React.ReactNode => (
    <span key={`${kind}:${value}`} className={`lt-epill ${cls}`}>
      {label}
      <button type="button" title="Remove" aria-label={`Remove ${label}`} onClick={() => onToggle(kind, value)}>
        <X className="lt-icon" />
      </button>
    </span>
  )
  if (facets.tagSet.size > 0) kinds.push([...facets.tagSet].map((t) => pill('tag', 'tag', t, t)))
  if (facets.sectionSet.size > 0) kinds.push([...facets.sectionSet].map((s) => pill('sec', 'sec', s, s)))
  if (facets.layoutSet.size > 0) kinds.push([...facets.layoutSet].map((l) => pill('lay', 'lay', l, l)))
  if (facets.contentSet.size > 0) {
    kinds.push([...facets.contentSet].map((k) => pill('ct', 'content', k, CONTENT_LABELS[k as ContentKey] ?? k)))
  }
  if (kinds.length === 0) return null
  return (
    <div className="lt-echo">
      <span className="lt-echo-label">Filtered to</span>
      {kinds.map((k, i) => (
        <span key={i} className="lt-echo-kind">
          {i > 0 && <span className="lt-echo-join">AND</span>}
          {k}
        </span>
      ))}
      <button type="button" className="lt-echo-clear" onClick={onClearFacets}>Clear all</button>
    </div>
  )
}
