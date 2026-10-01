import { useEffect, useRef, useState } from 'react'
import type { VaultView } from '../../../../preload/index'
import { IcChevronDown, IcClear } from './icons'
import { VaultBadge } from './VaultRows'
import { showOptions } from './vaultFilter'

// "Show: All vaults ▾" under the Talks search (LOCKED-sidebar frames 2A and 2B). Set to one vault it
// takes that vault's badge and name and shows ×; × or "All vaults" brings every vault back. The
// caller hides it with fewer than two open vaults.
export default function ShowFilter({ vaults, showId, onChange }: {
  vaults: VaultView[]
  showId: string | null
  onChange: (vaultId: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent): void => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }
    window.addEventListener('mousedown', away)
    window.addEventListener('keydown', esc, { capture: true })
    return () => { window.removeEventListener('mousedown', away); window.removeEventListener('keydown', esc, { capture: true }) }
  }, [open])
  const shown = showId ? vaults.find((v) => v.id === showId) ?? null : null
  const pick = (id: string | null): void => { setOpen(false); onChange(id) }
  return (
    <div className="tl-showrow" ref={rootRef} data-show-filter>
      <button
        type="button"
        className={`tl-show${shown ? ' tl-show--set' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-show-value={shown?.id ?? 'all'}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="tl-show-k">Show</span>
        {shown && <VaultBadge vault={shown} size={14} />}
        <span className="tl-show-v">{shown ? shown.name : 'All vaults'}</span>
        {shown
          ? <span className="tl-show-x" role="button" aria-label="Show all vaults" data-show-clear onClick={(e) => { e.stopPropagation(); pick(null) }}><IcClear size={11} /></span>
          : <IcChevronDown size={11} />}
      </button>
      {open && (
        <div className="tl-menu tl-show-menu" role="menu" aria-label="Show">
          {showOptions(vaults).map((o) => {
            const v = o.id ? vaults.find((x) => x.id === o.id) : null
            const checked = (o.id ?? null) === (shown?.id ?? null)
            return (
              <button
                type="button"
                key={o.id ?? 'all'}
                role="menuitemradio"
                aria-checked={checked}
                disabled={!!o.disabled}
                className={`tl-mi tl-show-item${checked ? ' tl-mi--current' : ''}${o.disabled ? ' is-disabled' : ''}`}
                data-show-option={o.id ?? 'all'}
                onClick={() => pick(o.id)}
              >
                <span className="tl-show-tick">{checked ? '✓' : ''}</span>
                {v && <VaultBadge vault={{ ...v, open: v.open && !v.unavailable }} size={14} />}
                <span className="tl-show-name">{o.label}</span>
                <span className="tl-show-hint">{o.hint}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
