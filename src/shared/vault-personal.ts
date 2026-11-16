// A vault's personal settings ("Just for me" in Edit this vault): author, badge colour, badge letter.
// The one cleaner: the vault registry stores only what it returns, and the set-up folder accepts from
// another Mac only a value it leaves unchanged. Pure; erasable TypeScript only.

/** "Just for me" in Edit this vault: stays on this Mac, in app config, by vault id. */
export type VaultPersonal = { author?: string; badgeColour?: string; badgeInitial?: string }

/** Personal settings as stored: author (trimmed, ≤ 120), a #rrggbb colour, one upper-case character. */
export function cleanPersonal(raw: unknown): VaultPersonal {
  const out: VaultPersonal = {}
  if (!raw || typeof raw !== 'object') return out
  const { author, badgeColour, badgeInitial } = raw as Record<string, unknown>
  if (typeof author === 'string' && author.trim()) out.author = author.trim().slice(0, 120)
  if (typeof badgeColour === 'string' && /^#[0-9a-fA-F]{6}$/.test(badgeColour.trim())) out.badgeColour = badgeColour.trim().toLowerCase()
  if (typeof badgeInitial === 'string') {
    const first = [...badgeInitial.trim()][0]
    if (first && /[\p{L}\p{N}]/u.test(first)) out.badgeInitial = first.toUpperCase()
  }
  return out
}
