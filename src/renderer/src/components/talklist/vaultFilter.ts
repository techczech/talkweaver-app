import type { TalkInfo, VaultView } from '../../../../preload/index'

// The Talks panel's "Show: All vaults ▾" filter (several-vaults ticket 07; LOCKED-sidebar frames 2A,
// 2B and 3F). Pure: whether the control appears, which vault it is set to, what its menu lists, and
// what each other vault says on its one line. React and storage stay in the panel.

export const SHOW_STORE_KEY = 'tw-talks-show-vault'

/** The control appears once two vaults are open on this Mac (frame 3F hides it for one). */
export function showFilterVisible(vaults: readonly Pick<VaultView, 'open'>[]): boolean {
  return vaults.filter((v) => v.open).length > 1
}

/** The vault the panel is scoped to, or null for every vault. A remembered vault that has since been
 *  closed, removed or become unavailable, or a filter with fewer than two open vaults, scopes nothing
 *  (the choice stays remembered, so the vault is shown alone again once it is back). */
export function effectiveShow(showId: string | null | undefined, vaults: readonly (Pick<VaultView, 'id' | 'open'> & { unavailable?: VaultView['unavailable'] })[]): string | null {
  if (!showId || !showFilterVisible(vaults)) return null
  return vaults.some((v) => v.id === showId && v.open && !v.unavailable) ? showId : null
}

export type ShowOption = {
  /** null = All vaults. */
  id: string | null
  label: string
  /** Right-hand text: the service, or why the option cannot be chosen. */
  hint: string
  disabled: 'closed' | 'unavailable' | null
}

/** "All vaults", then every vault in sidebar order; a closed or unavailable vault is listed but greyed. */
export function showOptions(vaults: readonly VaultView[]): ShowOption[] {
  return [
    { id: null, label: 'All vaults', hint: '', disabled: null },
    ...vaults.map((v): ShowOption => ({
      id: v.id,
      label: v.name,
      hint: !v.open ? 'closed' : v.unavailable ? 'unavailable' : v.service,
      disabled: !v.open ? 'closed' : v.unavailable ? 'unavailable' : null
    }))
  ]
}

/** What a vault's one-line row says while another vault is shown. */
export function hiddenNote(vault: Pick<VaultView, 'open' | 'unavailable'>, talkCount: number): string {
  if (!vault.open) return 'closed'
  if (vault.unavailable) return 'unavailable'
  return `${talkCount} hidden`
}

/** Recent, narrowed to the shown vault. */
export function talksInShow<T extends Pick<TalkInfo, 'vaultId'>>(talks: readonly T[], showId: string | null, firstOpenId: string | null): T[] {
  if (!showId) return talks as T[]
  return talks.filter((t) => (t.vaultId ?? firstOpenId) === showId)
}

/** The sentence under "Oxford AICC is unavailable on this Mac." on the header's second line. */
export function unavailableSubline(vault: Pick<VaultView, 'service' | 'unavailable'>): string {
  switch (vault.unavailable?.reason) {
    case 'not-signed-in': return `${vault.service} · not signed in`
    case 'folder-moved': return `${vault.service} · folder moved`
    case 'no-permission': return `${vault.service} · no permission`
    case 'not-responding': return `${vault.service} · not responding`
    default: return `${vault.service} · folder not found`
  }
}

/** The note inside an unavailable section (LOCKED-sidebar frame 2C): the headline, why and what to do
 *  (from main, no folder path), and that slides already copied from it still work and still say where
 *  they came from. */
export function unavailableNote(vault: Pick<VaultView, 'name' | 'unavailable'>): { headline: string; body: string } {
  const why = vault.unavailable?.message ?? ''
  const provenance = `Slides already copied from ${vault.name} still work, and still say \u201cFrom: ${vault.name} vault\u201d.`
  return { headline: `${vault.name} is unavailable on this Mac.`, body: why ? `${why} ${provenance}` : provenance }
}
