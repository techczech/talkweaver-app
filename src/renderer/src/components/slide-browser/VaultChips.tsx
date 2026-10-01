// The vault chips under "Search slides" (ticket 06; LOCKED-add-slide frames 1–3): one per open vault,
// badge + name + match count, the current talk's vault first and marked "this talk". A click leaves
// that vault out of this search (the chip goes grey, dashed, OFF, its count kept); a second click
// brings it back. Every vault is on again the next time the Browser opens.
import type { CSSProperties } from 'react'
import { Check } from 'lucide-react'
import type { ChipVault } from './vaultChipsModel'

export function VaultChips({ chips, currentVaultId, counts, off, showCounts, onToggle }: {
  chips: ChipVault[]
  currentVaultId: string | null
  counts: ReadonlyMap<string, number>
  off: ReadonlySet<string>
  /** Counts appear once something is typed (frame 1 has none). */
  showCounts: boolean
  onToggle: (vaultId: string) => void
}) {
  return (
    <div className="lt-vchips" role="group" aria-label="Search in" data-vault-chips>
      <span className="lt-vchips-label">Search in</span>
      {chips.map((c) => {
        const gone = !!c.unavailable
        const isOff = !gone && off.has(c.id)
        const n = counts.get(c.id) ?? 0
        return (
          <button
            key={c.id}
            type="button"
            className={`lt-vchip${isOff ? ' off' : ''}${gone ? ' unavailable' : ''}`}
            style={{ '--c': c.color } as CSSProperties}
            aria-pressed={gone ? false : !isOff}
            aria-disabled={gone || undefined}
            data-vault-unavailable={gone ? 'true' : undefined}
            data-vault-chip={c.id}
            data-vault-name={c.name}
            title={gone ? `${c.name} is unavailable on this Mac` : isOff ? `Search ${c.name} again` : `Leave ${c.name} out of this search`}
            onClick={(e) => { e.stopPropagation(); if (!gone) onToggle(c.id) }}
          >
            <span className="vs-vb sm" style={{ '--c': c.color } as CSSProperties}>{c.initial}</span>
            <span className="lt-vchip-name">{c.name}</span>
            {showCounts && !gone && <span className="n">{n}</span>}
            {c.id === currentVaultId && !isOff && !gone && <span className="lt-vchip-this">this talk</span>}
            {gone ? <span className="st">unavailable</span> : isOff ? <span className="st">OFF</span> : <Check className="lt-icon lt-vchip-on" aria-hidden="true" />}
          </button>
        )
      })}
    </div>
  )
}

/** A result's vault: badge and name, never a folder (frame 2). */
export function VaultLabel({ vault }: { vault: ChipVault }) {
  return (
    <span className="lt-vlabel" data-vault-label={vault.id} title={`${vault.name} vault`}>
      <span className="vs-vb sm" style={{ '--c': vault.color } as CSSProperties}>{vault.initial}</span>
      {vault.name}
    </span>
  )
}
