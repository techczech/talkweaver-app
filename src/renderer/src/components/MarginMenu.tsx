// The Plain margin's two menus (spec T8, T9): the level menu opened from the margin word and the
// layout menu opened from the layout name. One component, drawn with the app's menu look (`tl-menu`)
// and the shared primitives in talklist/menus.tsx (↑↓ wrap, ↵ chooses, ⎋ closes, click outside closes).
// It owns no behaviour: WorkspaceLayout supplies the rows and applies the choice.
import { Fragment, useEffect } from 'react'
import { Check } from 'lucide-react'
import { useClamped, useDismiss, useMenuKeyNav } from './talklist/menus'

export interface MarginMenuRow {
  key: string
  label: string
  /** One-line note under the label. */
  note?: string
  current: boolean
}

/** A row that opens the layout picker rather than choosing a layout. */
export const MORE_IN_INSPECTOR_KEY = '__more-in-inspector'

export default function MarginMenu({
  title, ariaLabel, rows, separatorsAfter = [], more, anchor, onChoose, onClose, onEscape
}: {
  title: string
  ariaLabel: string
  rows: readonly MarginMenuRow[]
  /** Rows (by key) with a separator under them. */
  separatorsAfter?: readonly string[]
  /** A last row after a separator, e.g. "More in Inspector…". */
  more?: string
  anchor: { left: number; bottom: number }
  onChoose: (key: string) => void
  onClose: () => void
  /** Escape: the caller returns focus to the editor at the heading. */
  onEscape: () => void
}) {
  useDismiss(onClose)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onEscape() }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [onEscape])
  const { ref, left, top } = useClamped(anchor.left - 14, anchor.bottom + 6)
  const all = more ? [...rows, { key: MORE_IN_INSPECTOR_KEY, label: more, current: false }] : rows
  const [active, setActive] = useMenuKeyNav(all.length, (i) => onChoose(all[i].key), false, Math.max(0, all.findIndex((r) => r.current)))
  return (
    <div ref={ref} className="tl-menu pv-menu" style={{ left, top }} role="menu" aria-label={ariaLabel} data-margin-menu onClick={(e) => e.stopPropagation()}>
      <div className="pv-menu-title">{title}</div>
      {all.map((row, i) => (
        <Fragment key={row.key}>
          {row.key === MORE_IN_INSPECTOR_KEY && <hr />}
          <button
            type="button"
            className={`tl-mi pv-menu-row ${row.current ? 'pv-menu-row--current' : ''} ${row.key === MORE_IN_INSPECTOR_KEY ? 'pv-menu-row--more' : ''} ${i === active ? 'tl-mi--kbd' : ''}`}
            role="menuitemradio"
            aria-checked={row.current}
            data-margin-menu-item={row.key}
            onClick={() => onChoose(row.key)}
            onMouseEnter={() => setActive(i)}
          >
            <span className="pv-menu-tick">{row.current ? <Check size={13} strokeWidth={2.4} /> : null}</span>
            <span className="pv-menu-text">
              <span className="pv-menu-label">{row.label}</span>
              {row.note && <span className="pv-menu-note">{row.note}</span>}
            </span>
          </button>
          {separatorsAfter.includes(row.key) && <hr />}
        </Fragment>
      ))}
    </div>
  )
}
