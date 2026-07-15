import { useState } from 'react'
import { relDays, type PubState } from './model'
import type { TalkRowShared } from './LedgerRow'
import { IcCheck, IcWarn } from './icons'
import PathwayBadge from './PathwayBadge'

// Real 16:9 cover from the thumb cache, with the schematic serif fallback while the
// thumbnail is missing (cold cache) or the coverKey hasn't been indexed yet.
export function Cover({ slug, coverKey, title }: { slug: string; coverKey: string | null; title: string }): JSX.Element {
  const [failed, setFailed] = useState(false)
  const showImg = coverKey && !failed
  return (
    <div className="tl-cover" aria-hidden>
      {showImg ? (
        <img src={`twthumb://${slug}/${coverKey}`} alt="" onError={() => setFailed(true)} />
      ) : (
        <div className="tl-cover-schematic">
          <div className="tl-cover-rule" />
          <div className="tl-cover-title">{title}</div>
        </div>
      )}
    </div>
  )
}

function Badges({ talk, deliveredMs, pub, warningCount, pathwayCount, pathwayNames }: {
  talk: TalkRowShared['talk']
  deliveredMs: number | undefined
  pub: PubState
  warningCount: number
  pathwayCount: number
  pathwayNames: string[]
}): JSX.Element {
  const rel = relDays(deliveredMs)
  return (
    <>
      {rel && (
        <span className="tl-badge tl-badge--del" title="Delivered (rehearsals excluded)">
          <IcCheck size={8.5} />{rel}
        </span>
      )}
      {pub === 'live' && (
        <span className="tl-badge tl-badge--pub" title="Handout published — link live">Published ↗</span>
      )}
      {pub === 'dead' && (
        <span className="tl-badge tl-badge--pub" title="Handout published — link is dead">
          <span className="tl-badge-dot" />Published ↗
        </span>
      )}
      {warningCount > 0 && (
        <span className="tl-badge tl-badge--warn" title={`${warningCount} outline warning${warningCount > 1 ? 's' : ''}`}>
          <IcWarn size={8.5} />{warningCount}
        </span>
      )}
      <PathwayBadge talk={talk} pathwayCount={pathwayCount} pathwayNames={pathwayNames} variant="shelf" />
    </>
  )
}

// Shelf row (cover-led, two-line): the recognising view — cover thumbnail leads, status
// becomes badges (green Delivered ✓+recency · oxford Published ↗ · amber ⚠), quiet edited date.
export default function ShelfRow({
  talk, depth, selected, focused, menuAnchor, warningCount, pathwayCount, pathwayNames, pub, label, fileMode,
  slideCount, coverKey, deliveredMs, editedMs, event,
  rowRef, onOpen, onContextMenu, onDragStart, onDragEnd
}: TalkRowShared & {
  slideCount: number | null
  coverKey: string | null
  deliveredMs: number | undefined
  editedMs: number | undefined
  /** Frontmatter event, shown as quiet context in title mode (null hides it). */
  event: string | null
}) {
  const cls = ['tl-shrow']
  if (selected) cls.push('tl-shrow--selected')
  if (focused) cls.push('tl-shrow--kfocus')
  if (menuAnchor) cls.push('tl-shrow--menu')
  const edited = relDays(editedMs)
  return (
    <div
      ref={rowRef}
      className={cls.join(' ')}
      role="treeitem"
      aria-selected={selected}
      // The keyboard ring adds 3px side margins (mockup geometry) — compensate so rows never jump.
      style={{ paddingLeft: (focused ? 5 : 8) + depth * 14 }}
      title={talk.slug}
      data-talk-slug={talk.slug}
      data-talk-title={talk.title}
      onClick={onOpen}
      onContextMenu={onContextMenu}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <Cover slug={talk.slug} coverKey={coverKey} title={talk.title} />
      <div className="tl-shrow-main">
        <div className={`tl-shrow-title ${fileMode ? 'tl-shrow-title--file' : ''}`}>{label}</div>
        <div className="tl-shrow-meta">
          <span className="tl-shrow-slides">{slideCount != null ? `${slideCount}sl` : '—'}</span>
          <Badges talk={talk} deliveredMs={deliveredMs} pub={pub} warningCount={warningCount} pathwayCount={pathwayCount} pathwayNames={pathwayNames} />
          {event && <span className="tl-shrow-event" title={event}>{event}</span>}
          {edited && <span className="tl-shrow-quiet">ed. {edited}</span>}
        </div>
      </div>
    </div>
  )
}
