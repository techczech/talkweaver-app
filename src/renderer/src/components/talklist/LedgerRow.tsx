import type { TalkInfo } from '../../../../preload/index'
import type { PubState } from './model'
import { IcFile } from './icons'
import PathwayBadge from './PathwayBadge'
import type { TalkSearchHit } from '../../../../shared/talk-search'
import { Marked, SearchLine } from './SearchLine'

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
  /** Share for comments: the talk has an active share (the "Shared" badge). */
  shared?: boolean
  /** Feedback rail: unread feedback items (the count pill after the name). */
  feedbackCount?: number
  /** Row label under the current naming mode (real title, or the slug as a filename). */
  label: string
  /** True in filename naming mode — the label renders in the mono font so it reads as a file. */
  fileMode: boolean
  /** The keyboard/card row key, exposed as data-row-key (the hover-card click dismissal reads it). */
  rowKey: string
  rowRef: (el: HTMLDivElement | null) => void
  onOpen: () => void
  onContextMenu: (e: React.MouseEvent) => void
  onDragStart: () => void
  onDragEnd: () => void
  /** Hover intent for the preview card (T29): enter arms the pause, leave disarms/hides. */
  onHoverEnter: () => void
  onHoverLeave: () => void
  /** Set on talk-search result rows: the row grows a second line saying what matched. */
  hit?: TalkSearchHit
  /** The drilled-in folder, so a result's folder reads relative to it. */
  focusPath?: string
}

// Ledger row (36px, two lines: title, then line two — what matched in a search result, or at rest
// the folder or event and the last delivery, ADR-0029 §3): file icon · title · ⚠count ·
// handout dot · mono slide count. Without either line it is the 26px dense row.
// The working view — density first; detail lives in the flyout that follows keyboard focus.
export default function LedgerRow({
  talk, depth, selected, focused, menuAnchor, warningCount, pathwayCount, pathwayNames, pub, shared = false, feedbackCount = 0, label, fileMode, slideCount, rowKey,
  rowRef, onOpen, onContextMenu, onDragStart, onDragEnd, onHoverEnter, onHoverLeave, hit, focusPath = '', line
}: TalkRowShared & { slideCount: number | null; line?: string }) {
  const cls = ['tl-row']
  if (hit || line != null) cls.push('tl-row--two')
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
      data-row-key={rowKey}
      onMouseEnter={onHoverEnter}
      onMouseLeave={onHoverLeave}
      onClick={onOpen}
      onContextMenu={onContextMenu}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <span className="tl-row-twist" />
      <span className="tl-row-ficon"><IcFile size={11.5} /></span>
      {hit ? (
        <span className="tl-row-text">
          <span className={`tl-row-name ${fileMode ? 'tl-row-name--file' : ''}`}>
            {fileMode ? label : <Marked text={label} ranges={hit.titleHighlights} />}
          </span>
          <SearchLine hit={hit} focusPath={focusPath} />
        </span>
      ) : line != null ? (
        <span className="tl-row-text">
          <span className={`tl-row-name ${fileMode ? 'tl-row-name--file' : ''}`}>{label}</span>
          <span className="tl-row-sub tl-row-rest" title={line}>{line}</span>
        </span>
      ) : (
        <span className={`tl-row-name ${fileMode ? 'tl-row-name--file' : ''}`}>{label}</span>
      )}
      {warningCount > 0 && <span className="tl-row-warn">⚠{warningCount}</span>}
      {feedbackCount > 0 && <span className="tl-row-fb-count" title={`${feedbackCount} new feedback`} data-testid="talk-row-feedback-count">{feedbackCount}</span>}
      {shared && <span className="tl-row-shared" title="Shared for comments" data-testid="talk-row-shared">Shared</span>}
      <PathwayBadge talk={talk} pathwayCount={pathwayCount} pathwayNames={pathwayNames} variant="ledger" />
      <span
        className={`tl-row-pub tl-row-pub--${pub}`}
        title={pub === 'live' ? 'Handout published · live' : pub === 'dead' ? 'Handout published · link dead' : undefined}
      />
      <span className="tl-row-count">{slideCount ?? '—'}</span>
    </div>
  )
}
