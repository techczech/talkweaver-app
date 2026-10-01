import type { CSSProperties } from 'react'
import type { VaultView } from '../../../../preload/index'
import { IcChevronRight, IcEllipsis, IcLock, IcPeople, IcPlus, IcWarn } from './icons'
import { hiddenNote, unavailableNote, unavailableSubline } from './vaultFilter'

// The vault parts of the Talks panel (LOCKED sidebar, section 4): a coloured badge with the vault's
// initial, and the section header with name, a lock and the service on the second line, and a ⋯
// button. No folder path is drawn anywhere here.

export function VaultBadge({ vault, size = 18 }: { vault: Pick<VaultView, 'color' | 'initial' | 'name' | 'open'>; size?: number }) {
  return (
    <span
      className={`tl-vb${vault.open ? '' : ' is-closed'}`}
      style={{ '--vc': vault.color, width: size, height: size, fontSize: Math.round(size * 0.55) } as CSSProperties}
      aria-hidden
      title={vault.name}
    >
      {vault.initial}
    </span>
  )
}

/** While another vault is shown (frame 2B): badge, name and how many talks are hidden, on one line. */
export function VaultCompact({ vault, hidden, focused, rowRef, onShow }: {
  vault: VaultView
  hidden: number
  focused: boolean
  rowRef: (el: HTMLDivElement | null) => void
  onShow: () => void
}) {
  return (
    <div
      ref={rowRef}
      className={`tl-vcompact${vault.open && !vault.unavailable ? '' : ' is-closed'}${focused ? ' tl-vhead--kfocus' : ''}`}
      style={{ '--vc': vault.color } as CSSProperties}
      role="treeitem"
      data-vault-header={vault.id}
      data-vault-name={vault.name}
      data-vault-compact="true"
      title={`Show ${vault.name}`}
      onClick={onShow}
    >
      <VaultBadge vault={{ ...vault, open: vault.open && !vault.unavailable }} size={14} />
      <span className="tl-vcname">{vault.name}</span>
      <span className="tl-vchidden">{hiddenNote(vault, hidden)}</span>
    </div>
  )
}

export function VaultHeader({
  vault, expanded, focused, rowRef, onToggle, onMenu
}: {
  vault: VaultView
  expanded: boolean
  focused: boolean
  rowRef: (el: HTMLDivElement | null) => void
  onToggle: () => void
  onMenu: (e: React.MouseEvent) => void
}) {
  const cls = ['tl-vhead']
  if (!vault.open) cls.push('is-closed')
  if (vault.open && vault.unavailable) cls.push('is-unavailable')
  if (focused) cls.push('tl-vhead--kfocus')
  return (
    <div
      ref={rowRef}
      className={cls.join(' ')}
      style={{ '--vc': vault.color } as CSSProperties}
      role="treeitem"
      aria-expanded={vault.open ? expanded : false}
      data-vault-header={vault.id}
      data-vault-name={vault.name}
      data-vault-open={vault.open ? 'true' : 'false'}
      data-vault-unavailable={vault.open && vault.unavailable ? vault.unavailable.reason : undefined}
      onClick={onToggle}
      onContextMenu={onMenu}
    >
      <span className="tl-vchev" style={{ transform: vault.open && expanded ? 'rotate(90deg)' : undefined }}><IcChevronRight size={10} /></span>
      <VaultBadge vault={vault.unavailable ? { ...vault, open: false } : vault} />
      <span className="tl-vtext">
        <span className="tl-vname">{vault.name}{vault.open && vault.unavailable ? ' · unavailable' : ''}</span>
        <span className="tl-vsub">
          {vault.open && vault.unavailable
            ? <><span className="tl-vlock tl-vwarn"><IcWarn size={10} /></span><span className="tl-vsvc" data-vault-reason>{unavailableSubline(vault)}</span></>
            : vault.open
            ? vault.shared
              ? <><span className="tl-vlock tl-vshared" title="Shared: others can open this vault" data-vault-shared><IcPeople size={10} /></span><span className="tl-vsvc">{vault.service} · shared</span></>
              : <><span className="tl-vlock" title="Only you: not shared"><IcLock size={10} /></span><span className="tl-vsvc">{vault.service} · private</span></>
            : vault.duplicateOf
              ? <span className="tl-vsvc" data-vault-duplicate>Copy of {vault.duplicateOf.name} · not opened</span>
              : <span className="tl-vsvc">Closed · not open on this Mac</span>}
        </span>
      </span>
      <button type="button" className="tl-vmore" aria-label={`Actions for ${vault.name}`} title="Vault actions" onClick={onMenu}><IcEllipsis size={14} /></button>
    </div>
  )
}

export function VaultEmpty({ vault, focused, rowRef, onNewTalk, onUnavailableAction }: {
  vault: VaultView
  focused: boolean
  rowRef: (el: HTMLDivElement | null) => void
  onNewTalk: () => void
  onUnavailableAction?: (vaultId: string) => void
}) {
  // LOCKED-sidebar frame 2C: the reason, what still works, one action, and "Talks not listed."
  if (vault.unavailable) {
    const note = unavailableNote(vault)
    return (
      <div ref={rowRef} className={`tl-vunavail${focused ? ' tl-vempty--kfocus' : ''}`} style={{ '--vc': vault.color } as CSSProperties} data-vault-unavailable-note={vault.id}>
        <div className="tl-vunote">
          <b>{note.headline}</b>
          <p>{note.body}</p>
          <button type="button" className="tl-vuact" data-vault-unavailable-action={vault.unavailable.action} onClick={() => onUnavailableAction?.(vault.id)}>{vault.unavailable.actionLabel}</button>
        </div>
        <span className="tl-vunlisted">Talks not listed.</span>
      </div>
    )
  }
  return (
    <div ref={rowRef} className={`tl-vempty${focused ? ' tl-vempty--kfocus' : ''}`} style={{ '--vc': vault.color } as CSSProperties} data-vault-empty={vault.id}>
      <p>No talks yet. New talks made here belong to {vault.name}.</p>
      <button type="button" className="tl-vnew" onClick={onNewTalk}><IcPlus size={11} />New talk in {vault.name}</button>
    </div>
  )
}
