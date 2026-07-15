import type { TalkInfo } from '../../../../preload/index'
import type { PubState } from './model'
import { IcFile } from './icons'
import PathwayBadge from './PathwayBadge'

export interface TalkRowShared {
  talk: TalkInfo
  depth: number
  selected: boolean
  focused: boolean
  menuAnchor: boolean
  warningCount: number
  pathwayCount: number
  pathwayNames: string[]
  pub: PubState
  /** Row label under the current naming mode (real title, or the slug as a filename). */
  label: string
  /** True in filename naming mode — the label renders in the mono font so it reads as a file. */
  fileMode: boolean
  rowRef: (el: HTMLDivElement | null) => void
  onOpen: () => void
  onContextMenu: (e: React.MouseEvent) => void
  onDragStart: () => void
  onDragEnd: () => void
}

// Ledger row (26px dense): file icon · title · ⚠count · handout dot · mono slide count.
// The working view — density first; detail lives in the flyout that follows keyboard focus.
export default function LedgerRow({
  talk, depth, selected, focused, menuAnchor, warningCount, pathwayCount, pathwayNames, pub, label, fileMode, slideCount,
  rowRef, onOpen, onContextMenu, onDragStart, onDragEnd
}: TalkRowShared & { slideCount: number | null }) {
  const cls = ['tl-row']
  if (selected) cls.push('tl-row--selected')
  if (focused) cls.push('tl-row--kfocus')
  if (menuAnchor) cls.push('tl-row--menu')
  return (
    <div
      ref={rowRef}
      className={cls.join(' ')}
      role="treeitem"
      aria-selected={selected}
      // The keyboard ring adds 3px side margins (mockup geometry) — compensate so rows never jump.
      style={{ paddingLeft: (focused ? 3 : 6) + depth * 14 }}
      title={talk.slug}
      data-talk-slug={talk.slug}
      data-talk-title={talk.title}
      onClick={onOpen}
      onContextMenu={onContextMenu}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <span className="tl-row-twist" />
      <span className="tl-row-ficon"><IcFile size={11.5} /></span>
      <span className={`tl-row-name ${fileMode ? 'tl-row-name--file' : ''}`}>{label}</span>
      {warningCount > 0 && <span className="tl-row-warn">⚠{warningCount}</span>}
      <PathwayBadge talk={talk} pathwayCount={pathwayCount} pathwayNames={pathwayNames} variant="ledger" />
      <span
        className={`tl-row-pub tl-row-pub--${pub}`}
        title={pub === 'live' ? 'Handout published · live' : pub === 'dead' ? 'Handout published · link dead' : undefined}
      />
      <span className="tl-row-count">{slideCount ?? '—'}</span>
    </div>
  )
}
