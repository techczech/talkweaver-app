// Filters group — Layout → Content → Tags → Sections (ADR-0009 §4, ADR-0037 grammar).
// Layout + Content are compact pills; Layout/Tags/Sections carry an inline search and a
// capped list with Show-all. Every sub-group collapses individually, and an active-count
// badge stays visible when collapsed (taste rule: collapsed is never invisible). Tags are
// FILLED chips (curated vocabulary), Sections HOLLOW (observed history) — never blended.
// Counts arrive CONDITIONED by the other active kinds (v0.15.2, leave-one-out law): a chip
// whose conditioned count is 0 renders dimmed with "0" but stays clickable — clicking it
// shows the empty grid honestly instead of promising slides the combination doesn't have.
import { useState } from 'react'
import { ChevronDown, Code2, Image as ImageIcon, MonitorPlay, Search, Sparkles, X } from 'lucide-react'
import { capItems } from './railModel'
import type { ContentItem, FacetItem, RailFacets, ToggleFacetFn } from './railTypes'

const CHIP_CAP = 6 // tag/section rows before "Show all"
const LAY_CAP = 8 // ~2 pill rows before "+N more"

export type FsubKey = 'lay' | 'ct' | 'tags' | 'secs'

const CONTENT_ICONS: Record<string, React.ReactElement> = {
  image: <ImageIcon className="lt-icon lt-ci" />,
  icon: <Sparkles className="lt-icon lt-ci" />,
  video: <MonitorPlay className="lt-icon lt-ci" />,
  code: <Code2 className="lt-icon lt-ci" />
}

// One collapsible filter sub-group: uppercase head, active-count badge, chevron.
function Fsub({ id, title, badge, open, onToggle, children }: {
  id: FsubKey
  title: string
  badge: number
  open: boolean
  onToggle: (id: FsubKey) => void
  children: React.ReactNode
}) {
  return (
    <div className={`lt-fsub${open ? '' : ' closed'}`}>
      <button type="button" className="lt-fsub-head" aria-expanded={open} onClick={() => onToggle(id)}>
        {title}
        {badge > 0 && <span className="lt-fbadge">{badge}</span>}
        <ChevronDown className="lt-icon lt-chev" />
      </button>
      {open && <div className="lt-fsub-body">{children}</div>}
    </div>
  )
}

// Inline vocabulary search. Esc clears the query FIRST, then blurs (taste rule) — the
// Browser's global key handler skips inputs carrying data-rail-esc so this runs unshadowed.
function Finput({ value, placeholder, onChange }: {
  value: string
  placeholder: string
  onChange: (v: string) => void
}) {
  return (
    <div className="lt-finput">
      <Search className="lt-icon" />
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        aria-label={placeholder}
        data-rail-esc="1"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return
          e.preventDefault()
          e.stopPropagation()
          if (value !== '') onChange('')
          else (e.target as HTMLInputElement).blur()
        }}
      />
    </div>
  )
}

export default function FilterGroups({
  facets, layoutItems, contentItems, tagItems, sectionItems,
  onToggle, onClearFacets, anyActive, scopeActive, fsubOpen, onToggleFsub
}: {
  facets: RailFacets
  layoutItems: FacetItem[]
  contentItems: ContentItem[]
  tagItems: FacetItem[]
  sectionItems: FacetItem[]
  onToggle: ToggleFacetFn
  onClearFacets: () => void
  anyActive: boolean
  scopeActive: boolean
  fsubOpen: Record<FsubKey, boolean>
  onToggleFsub: (id: FsubKey) => void
}) {
  const [fq, setFq] = useState<Record<'lay' | 'tags' | 'secs', string>>({ lay: '', tags: '', secs: '' })
  const [showAll, setShowAll] = useState<Record<'lay' | 'tags' | 'secs', boolean>>({ lay: false, tags: false, secs: false })
  const setQ = (k: 'lay' | 'tags' | 'secs', v: string): void => setFq((s) => ({ ...s, [k]: v }))
  const flipAll = (k: 'lay' | 'tags' | 'secs', v: boolean): void => setShowAll((s) => ({ ...s, [k]: v }))

  // Chip list tail: "Show all N…" / "Show fewer" for the capped vocabularies.
  function tail(k: 'lay' | 'tags' | 'secs', hiddenCount: number, total: number): React.ReactNode {
    if (hiddenCount > 0) {
      return <button type="button" className="lt-showall" onClick={() => flipAll(k, true)}>Show all {total}…</button>
    }
    if (showAll[k] && fq[k].trim() === '' && total > (k === 'lay' ? LAY_CAP : CHIP_CAP)) {
      return <button type="button" className="lt-showall" onClick={() => flipAll(k, false)}>Show fewer</button>
    }
    return null
  }

  const layMatches = layoutItems.filter((l) => l.value.includes(fq.lay.trim().toLowerCase()))
  const lay = capItems(layMatches, LAY_CAP, showAll.lay, fq.lay)
  const tagMatches = tagItems.filter((t) => t.value.includes(fq.tags.trim().toLowerCase()))
  const tags = capItems(tagMatches, CHIP_CAP, showAll.tags, fq.tags)
  const secMatches = sectionItems.filter((s) => s.value.toLowerCase().includes(fq.secs.trim().toLowerCase()))
  const secs = capItems(secMatches, CHIP_CAP, showAll.secs, fq.secs)

  return (
    <>
      <div className="lt-rail-sub">
        {scopeActive
          ? 'Narrow within the scope — AND across kinds, OR within one.'
          : 'No scope — filters narrow across the whole vault.'}
      </div>

      <Fsub id="lay" title="Layout" badge={facets.layoutSet.size} open={fsubOpen.lay} onToggle={onToggleFsub}>
        <Finput value={fq.lay} placeholder={`Filter ${layoutItems.length} layouts…`} onChange={(v) => setQ('lay', v)} />
        <div className="lt-chipwrap">
          {lay.shown.map((l) => (
            <button
              key={l.value}
              type="button"
              className={`lt-lchip${facets.layoutSet.has(l.value) ? ' on' : ''}${l.count === 0 ? ' zero' : ''}`}
              title={l.count === 0 ? 'No slides under the other active filters — click to see why the combination is empty' : undefined}
              onClick={() => onToggle('lay', l.value)}
            >
              {l.value}<span className="lt-cc">{l.count}</span>
            </button>
          ))}
          {layMatches.length === 0 && <div className="lt-fzero">No layout matches.</div>}
          {lay.hiddenCount > 0 && (
            <button type="button" className="lt-lchip more" onClick={() => flipAll('lay', true)}>
              +{lay.hiddenCount} more
            </button>
          )}
          {lay.hiddenCount === 0 && showAll.lay && fq.lay.trim() === '' && layoutItems.length > LAY_CAP && (
            <button type="button" className="lt-lchip more" onClick={() => flipAll('lay', false)}>fewer</button>
          )}
        </div>
      </Fsub>

      <Fsub id="ct" title="Content" badge={facets.contentSet.size} open={fsubOpen.ct} onToggle={onToggleFsub}>
        <div className="lt-chipwrap lt-ct-pad">
          {contentItems.map((c) => (
            <button
              key={c.key}
              type="button"
              className={`lt-lchip${facets.contentSet.has(c.key) ? ' on' : ''}${c.count === 0 ? ' zero' : ''}`}
              title={c.count === 0 ? 'No slides under the other active filters — click to see why the combination is empty' : undefined}
              aria-pressed={facets.contentSet.has(c.key)}
              onClick={() => onToggle('content', c.key)}
            >
              {CONTENT_ICONS[c.key]}{c.label}<span className="lt-cc">{c.count}</span>
            </button>
          ))}
        </div>
      </Fsub>

      <Fsub id="tags" title="Tags — curated" badge={facets.tagSet.size} open={fsubOpen.tags} onToggle={onToggleFsub}>
        <Finput value={fq.tags} placeholder="Filter tags…" onChange={(v) => setQ('tags', v)} />
        <div className="lt-rail-list">
          {tags.shown.map((t) => (
            <button
              key={t.value}
              type="button"
              className={`lt-fchip tag${facets.tagSet.has(t.value) ? ' on' : ''}${t.count === 0 ? ' zero' : ''}`}
              title={t.count === 0 ? 'No slides under the other active filters — click to see why the combination is empty' : undefined}
              onClick={() => onToggle('tag', t.value)}
            >
              <span className="lt-fn">{t.value}</span><span className="lt-cc">{t.count}</span>
            </button>
          ))}
          {tagMatches.length === 0 && <div className="lt-fzero">{tagItems.length === 0 ? 'No tags yet — select slides and press T.' : 'Nothing matches.'}</div>}
          {tail('tags', tags.hiddenCount, tagMatches.length)}
        </div>
      </Fsub>

      <Fsub id="secs" title="Sections — observed" badge={facets.sectionSet.size} open={fsubOpen.secs} onToggle={onToggleFsub}>
        <Finput value={fq.secs} placeholder="Filter sections…" onChange={(v) => setQ('secs', v)} />
        <div className="lt-rail-list">
          {secs.shown.map((s) => (
            <button
              key={s.value}
              type="button"
              className={`lt-fchip sec${facets.sectionSet.has(s.value) ? ' on' : ''}${s.count === 0 ? ' zero' : ''}`}
              title={s.count === 0 ? 'No slides under the other active filters — click to see why the combination is empty' : undefined}
              onClick={() => onToggle('sec', s.value)}
            >
              <span className="lt-fn">{s.value}</span><span className="lt-cc">{s.count}</span>
            </button>
          ))}
          {secMatches.length === 0 && <div className="lt-fzero">Nothing matches.</div>}
          {tail('secs', secs.hiddenCount, secMatches.length)}
        </div>
      </Fsub>

      {anyActive && (
        <button type="button" className="lt-rail-clearf" onClick={onClearFacets}>
          <X className="lt-icon" /> Clear filters
        </button>
      )}
    </>
  )
}
