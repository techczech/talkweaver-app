// A small dropdown of groups: the group filter beside the search box, and Move to group….
// Both end in "New group…", which asks for a name in place.
import { useEffect, useRef, useState } from 'react'

export interface GroupMenuRow { id: string; label: string; count?: number; current?: boolean }

export function ScratchpadGroupMenu({ heading, rows, startNaming = false, onPick, onNewGroup, onClose }: {
  heading?: string
  /** Opens with the name field ready (the New Slide Scratchpad group command). */
  startNaming?: boolean
  rows: GroupMenuRow[]
  onPick: (id: string) => void
  /** Called with the typed name; the menu closes when it answers true. */
  onNewGroup: (name: string) => Promise<boolean> | boolean
  onClose: () => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [naming, setNaming] = useState(startNaming)
  const [name, setName] = useState('')
  useEffect(() => {
    const away = (e: MouseEvent): void => { if (ref.current && !ref.current.contains(e.target as Node)) onClose() }
    const esc = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc, true)
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc, true) }
  }, [onClose])
  const create = async (): Promise<void> => {
    const clean = name.trim()
    if (!clean) return
    if (await onNewGroup(clean)) onClose()
  }
  return (
    <div className="sp-menu" ref={ref} role="menu" aria-label={heading ?? 'Groups'}>
      {heading && <div className="sp-menu-head">{heading}</div>}
      {rows.map((row) => (
        <button key={row.id} type="button" role="menuitem" className={`sp-menu-row${row.current ? ' is-current' : ''}`} onClick={() => { onPick(row.id); onClose() }}>
          <span>{row.label}</span>
          {row.count !== undefined && <em>{row.count}</em>}
        </button>
      ))}
      {naming ? (
        <form className="sp-menu-new" onSubmit={(e) => { e.preventDefault(); void create() }}>
          <input autoFocus value={name} maxLength={80} placeholder="Group name" aria-label="New group name" onChange={(e) => setName(e.target.value)} />
          <button type="submit" className="sp-btn sp-btn--sm" disabled={name.trim() === ''}>Create</button>
        </form>
      ) : (
        <button type="button" role="menuitem" className="sp-menu-row sp-menu-row--new" onClick={() => setNaming(true)}>New group…</button>
      )}
    </div>
  )
}
