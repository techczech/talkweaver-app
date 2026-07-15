import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { TalkInfo, TalkMeta } from '../../../../preload/index'
import { formatShortDate, type PubState } from './model'
import { Cover } from './ShelfRow'

// Preview flyout (Ledger mode only): follows the KEYBOARD focus, not the mouse — the
// working view stays dense and the detail glides alongside as ↑↓ walk the list. Rendered
// through a portal with fixed positioning so it overlays the editor area beside the panel.
export default function Flyout({
  talk,
  meta,
  deliveredMs,
  pub,
  anchorEl,
  panelEl
}: {
  talk: TalkInfo
  meta: TalkMeta[string] | undefined
  deliveredMs: number | undefined
  pub: PubState
  anchorEl: HTMLElement | null
  panelEl: HTMLElement | null
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    if (!anchorEl || !panelEl) { setPos(null); return }
    const place = (): void => {
      if (!anchorEl.isConnected) { setPos(null); return }
      const panelBox = panelEl.getBoundingClientRect()
      const rowBox = anchorEl.getBoundingClientRect()
      const height = boxRef.current?.offsetHeight ?? 260
      let top = rowBox.top - 12
      top = Math.max(8, Math.min(top, window.innerHeight - height - 8))
      setPos({ left: panelBox.right + 8, top })
    }
    place()
    // Capture-phase scroll catches the tree scroller (and any ancestor) without wiring a prop.
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [anchorEl, panelEl, talk.outlinePath])

  if (!pos) return null

  const warningCount = meta?.warningCount ?? 0
  return createPortal(
    <aside ref={boxRef} className="tl-flyout" style={{ left: pos.left, top: pos.top }} aria-label="Talk preview" data-talklist-flyout>
      <div className="tl-flyout-cover">
        <Cover slug={talk.slug} coverKey={meta?.coverKey ?? null} title={talk.title} />
      </div>
      <dl className="tl-flyout-meta">
        {meta?.event && (
          <>
            <dt>Event</dt>
            <dd className="tl-flyout-clip" title={meta.event}>{meta.event}</dd>
          </>
        )}
        <dt>Slides</dt>
        <dd className="tl-mono">{meta?.slideCount != null ? `${meta.slideCount} slide${meta.slideCount === 1 ? '' : 's'}` : '—'}</dd>
        <dt>Created</dt>
        <dd className="tl-mono">{formatShortDate(meta?.createdMs)}</dd>
        <dt>Edited</dt>
        <dd className="tl-mono">{formatShortDate(meta?.editedMs)}</dd>
        <dt>Delivered</dt>
        <dd className="tl-mono">{deliveredMs ? formatShortDate(deliveredMs) : 'Never'}</dd>
        <dt>Handout</dt>
        {pub === 'live' && <dd className="tl-flyout-live"><span className="tl-flyout-dot" />Published · live</dd>}
        {pub === 'dead' && <dd className="tl-flyout-dead"><span className="tl-flyout-dot" />Published · link dead</dd>}
        {pub === 'none' && <dd className="tl-flyout-quiet">Not published</dd>}
        <dt>Warnings</dt>
        {warningCount > 0
          ? <dd className="tl-flyout-warn">⚠ {warningCount} slide{warningCount > 1 ? 's' : ''}</dd>
          : <dd className="tl-flyout-quiet">None</dd>}
        {/* The filename stays one glance away even in title naming mode. */}
        <dt>File</dt>
        <dd className="tl-mono tl-flyout-clip" title={talk.slug}>{talk.slug}</dd>
      </dl>
      <div className="tl-flyout-foot">
        <span>Preview</span>
        <span><b>↵</b> open</span>
      </div>
    </aside>,
    document.body
  )
}
