// Compare side by side (locked mockup state 6): 2 to 4 ticked items, large, in columns, each with its own
// actions, so they can be decided one by one; one placement note for all of them at the bottom.
import type { ScratchGroup, ScratchItem } from '../../../../shared/scratchpad'
import { ItemBadges, ItemThumb } from './ScratchpadCard'

/** The slide's text, shortened, without its heading and markup tokens: what the column shows under the title. */
function slideText(markdown: string): string {
  const lines = markdown.split('\n').slice(1).map((l) => l.replace(/\{[^}]*\}/g, '').replace(/^\s*[-*+]\s+/, '').trim()).filter(Boolean)
  const text = lines.join(' · ')
  return text.length > 220 ? `${text.slice(0, 219)}…` : text
}

export function ScratchpadCompare({ items, groupOf, onBack, onTakeOut, onOpen, actions, note, inTalk = () => false }: {
  inTalk?: (item: ScratchItem) => boolean
  items: ScratchItem[]
  groupOf: (id: string | null) => ScratchGroup | null
  onBack: () => void
  onTakeOut: (id: string) => void
  onOpen: (id: string) => void
  /** The column's buttons for one item (Insert…, Keep for library, Reject; Move back once decided). */
  actions: (item: ScratchItem) => JSX.Element
  note: JSX.Element | null
}): JSX.Element {
  return (
    <div className="sp-compare">
      <div className="sp-compare-top">
        <button type="button" className="sp-btn sp-btn--sm" onClick={onBack}>← Back to the list</button>
        <b>Side by side · {items.length} {items.length === 1 ? 'item' : 'items'}</b>
        <span className="sp-compare-hint">Each column has its own actions, so you can decide one by one.</span>
      </div>
      <div className="sp-compare-cols" style={{ gridTemplateColumns: `repeat(${Math.max(1, items.length)}, minmax(0, 1fr))` }}>
        {items.map((item) => {
          const group = groupOf(item.group)
          return (
            <div className="sp-compare-col" key={item.id} data-item-id={item.id}>
              <ItemThumb item={item} big />
              <div className="sp-badges"><ItemBadges item={item} inTalk={inTalk(item)} />{group && <span className="sp-badge">{group.name}</span>}</div>
              <div className="sp-compare-title">{item.title}</div>
              {item.description && <div className="sp-compare-desc">{item.description}</div>}
              {item.kind === 'slide' && item.slide && <div className="sp-compare-text">Slide text: {slideText(item.slide.markdown)}</div>}
              <div className="sp-compare-when">{item.kind === 'slide' ? <>Picked from {item.slide?.talkTitle}</> : <>File <code>{item.file}</code></>}</div>
              {item.status !== 'active' && <div className="sp-compare-done">{item.status === 'kept' ? 'Kept for library' : 'Rejected'}</div>}
              <div className="sp-actions">{actions(item)}</div>
              <div className="sp-compare-foot">
                {item.kind === 'file' && item.fileKind === 'html' && !item.missing && <><button type="button" className="sp-link" onClick={() => onOpen(item.id)}>Open big preview</button> · </>}
                <button type="button" className="sp-link" onClick={() => onTakeOut(item.id)}>Take out of comparison</button>
              </div>
            </div>
          )
        })}
      </div>
      {note}
    </div>
  )
}
