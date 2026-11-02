// One candidate in the Slide Scratchpad list (and the picture in the big preview): its thumbnail, badges,
// highlighted title, group tag, and the buttons that belong to its list.
import { useEffect, useState } from 'react'
import { highlightSegments, TYPE_BADGE, type ScratchGroup, type ScratchItem } from '../../../../shared/scratchpad'
import { thumbUrl } from '../../lib/thumbUrl'
import { noteSourceThumbUnavailable, onThumbRegen, slidePictureFor, thumbRegenNonce } from '../../lib/scratchpadSourceThumbs'

export function Highlight({ text, terms }: { text: string; terms: readonly string[] }): JSX.Element {
  return <>{highlightSegments(text, terms).map((part, i) => (part.hit ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>))}</>
}

export function ItemBadges({ item, inTalk = false }: { item: ScratchItem; inTalk?: boolean }): JSX.Element {
  if (item.kind === 'slide') return <><span className="sp-badge sp-badge--from">From: {item.slide?.talkTitle}</span>{inTalk && <span className="sp-badge sp-badge--from">In talk</span>}</>
  return (
    <>
      <span className="sp-badge sp-badge--agent">Made by agent</span>
      <span className="sp-badge sp-badge--type">{TYPE_BADGE[item.fileKind ?? 'pic']}</span>
      {item.missing && <span className="sp-badge sp-badge--missing">File missing</span>}
    </>
  )
}

/** The picture for an item: a slide's rendered thumbnail, an agent picture or SVG as an image, and a tile
 *  for an HTML page (which only runs in the big preview, on request) or a file that is gone. */
export function ItemThumb({ item, big = false }: { item: ScratchItem; big?: boolean }): JSX.Element {
  const [failed, setFailed] = useState(false)
  const [nonce, setNonce] = useState(() => (item.slide ? thumbRegenNonce(item.slide.talkPath) : 0))
  // The source talk was rendered in the background: its pictures exist now, so try this one again.
  useEffect(() => onThumbRegen(() => {
    if (!item.slide) return
    const next = thumbRegenNonce(item.slide.talkPath)
    if (next !== nonce) { setNonce(next); setFailed(false) }
  }), [item.slide, nonce])
  const cls = `sp-thumb${big ? ' sp-thumb--big' : ''}`
  if (item.kind === 'slide') {
    const slide = item.slide
    const pic = slide ? slidePictureFor(slide) : null
    if (slide && pic && !failed) {
      return <div className={cls}><img loading="lazy" decoding="async" key={nonce} src={thumbUrl(pic.talkSlug, pic.thumbKey, pic.vaultId)} alt="" draggable={false} onError={() => { setFailed(true); noteSourceThumbUnavailable(slide) }} /></div>
    }
    return <div className={`${cls} sp-thumb--text`}><span>{item.title}</span></div>
  }
  if (item.missing) return <div className={`${cls} sp-thumb--tile`}><span>File missing</span></div>
  if (item.fileKind === 'html') return <HtmlThumb item={item} cls={cls} />
  if (item.fileUrl && !failed) return <div className={cls}><img loading="lazy" decoding="async" src={item.fileUrl} alt="" draggable={false} onError={() => setFailed(true)} /></div>
  return <div className={`${cls} sp-thumb--tile`}><span>{failed ? 'Could not load' : 'Picture'}</span></div>
}

/** An HTML page's picture, captured once by the main process; the tile stands in until it exists. */
function HtmlThumb({ item, cls }: { item: ScratchItem; cls: string }): JSX.Element {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    setUrl(null)
    void window.tw.scratchpad.htmlThumb?.(item.id).then((reply) => { if (live && reply.ok) setUrl(reply.url) }, () => undefined)
    return () => { live = false }
  }, [item.id, item.file])
  if (url) return <div className={cls}><img loading="lazy" decoding="async" src={url} alt="" draggable={false} onError={() => setUrl(null)} /></div>
  return <div className={`${cls} sp-thumb--tile`}><span>HTML page</span></div>
}

export function ScratchpadCard({ item, terms, ticked, selected, groupTag, onSelect, onTick, onOpen, onMoveBack, onRemoveMissing, insertedNote = null, inTalk = false }: {
  item: ScratchItem
  terms: readonly string[]
  ticked: boolean
  selected: boolean
  /** The group's name, shown under the title while the group filter is All items. */
  groupTag: ScratchGroup | null
  inTalk?: boolean
  onSelect: (event?: React.MouseEvent) => void
  onTick: () => void
  onOpen: () => void
  onMoveBack: () => void
  onRemoveMissing: () => void
  /** "Inserted · slide 8" once the item went into the talk (it stays here; inserting again is allowed). */
  insertedNote?: string | null
}): JSX.Element {
  const active = item.status === 'active'
  return (
    <div
      className={`sp-card${ticked ? ' is-checked' : ''}${selected ? ' is-selected' : ''}`}
      data-item-id={item.id}
      draggable={active && !item.missing}
      onDragStart={(event) => { event.dataTransfer.setData('application/x-tw-scratch-item', item.id); event.dataTransfer.effectAllowed = 'copy' }}
      role="button"
      tabIndex={0}
      aria-label={item.title}
      aria-pressed={selected || ticked}
      onClick={(event) => onSelect(event)}
      onDoubleClick={onOpen}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter') { e.preventDefault(); onOpen() }
        else if (e.key === ' ') { e.preventDefault(); onSelect() }
      }}
    >
      <div className="sp-thumbwrap">
        <ItemThumb item={item} />
        {active && (
          <input
            type="checkbox"
            className="sp-tick"
            aria-label={`Select ${item.title}`}
            checked={ticked}
            onClick={(e) => e.stopPropagation()}
            onChange={onTick}
          />
        )}
      </div>
      <div className="sp-card-body">
        <div className="sp-badges"><ItemBadges item={item} inTalk={inTalk} /></div>
        <div className="sp-card-title"><Highlight text={item.title} terms={terms} /></div>
        {item.kind === 'file' && item.file && <div className="sp-card-file"><Highlight text={item.file} terms={terms} /></div>}
        {groupTag && active && <div className="sp-grouptag">{groupTag.name}</div>}
        {insertedNote && <div className="sp-inserted">{insertedNote}</div>}
        {!active && (
          <div className="sp-card-actions">
            <button type="button" className="sp-btn sp-btn--sm" onClick={(e) => { e.stopPropagation(); onMoveBack() }}>Move back</button>
          </div>
        )}
        {item.missing && (
          <div className="sp-card-actions">
            <button type="button" className="sp-btn sp-btn--sm" onClick={(e) => { e.stopPropagation(); onRemoveMissing() }}>Remove from Slide Scratchpad</button>
          </div>
        )}
      </div>
    </div>
  )
}
