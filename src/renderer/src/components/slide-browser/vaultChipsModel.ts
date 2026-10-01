// The Slide Browser's vault filter (several-vaults ticket 06; LOCKED-add-slide frames 1–4). Pure:
// which vaults get a chip and in what order, what each chip counts, which results a chip set keeps,
// the current talk's vault ranked first, and what an empty result says about vaults switched off.
// Every open vault is on each time the Browser opens (the off set lives only for one opening).

/** `unavailable`: the vault's folder is not there; its chip is greyed and cannot be switched on (ticket 07). */
export type ChipVault = { id: string; name: string; initial: string; color: string; unavailable?: boolean }
type VaultLike = Omit<ChipVault, "unavailable"> & { open: boolean; order: number; root?: string; unavailable?: unknown }
type RowLike = { vaultId?: string }

/** Open vaults, the current talk's vault first, the rest in the sidebar's order. */
export function chipVaults(vaults: readonly VaultLike[], currentVaultId: string | null): ChipVault[] {
  return vaults
    .filter((v) => v.open)
    .slice()
    .sort((a, b) => (a.id === currentVaultId ? -1 : b.id === currentVaultId ? 1 : a.order - b.order))
    .map(({ id, name, initial, color, unavailable }) => (unavailable ? { id, name, initial, color, unavailable: true } : { id, name, initial, color }))
}

/** The vault the open talk lives in: its stamped vaultId, else the open vault whose root holds it. */
export function currentVaultIdFor(vaults: readonly VaultLike[], outlinePath: string | null | undefined, talkVaultId?: string): string | null {
  if (talkVaultId && vaults.some((v) => v.id === talkVaultId)) return talkVaultId
  if (!outlinePath) return null
  let best: VaultLike | null = null
  for (const v of vaults) {
    if (!v.open || !v.root) continue
    const root = v.root.replace(/[\\/]+$/, '')
    if (outlinePath.startsWith(root + '/') || outlinePath.startsWith(root + '\\')) {
      if (!best || (best.root ?? '').length < root.length) best = v
    }
  }
  return best?.id ?? null
}

/** Matches per vault (rows without a vaultId are not counted). */
export function countByVault(rows: readonly RowLike[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const r of rows) if (r.vaultId) counts.set(r.vaultId, (counts.get(r.vaultId) ?? 0) + 1)
  return counts
}

/** The rows of the vaults switched on. A row with no vaultId (a single-vault search) always stays. */
export function rowsInVaults<T extends RowLike>(rows: readonly T[], off: ReadonlySet<string>): T[] {
  if (off.size === 0) return rows as T[]
  return rows.filter((r) => !r.vaultId || !off.has(r.vaultId))
}

/** The current vault's rows first, each group in its existing order (a stable partition). */
export function currentVaultFirst<T extends RowLike>(rows: readonly T[], currentVaultId: string | null): T[] {
  if (!currentVaultId) return rows as T[]
  const mine: T[] = []
  const rest: T[] = []
  for (const r of rows) (r.vaultId && r.vaultId !== currentVaultId ? rest : mine).push(r)
  return rest.length === 0 || mine.length === 0 ? (rows as T[]) : [...mine, ...rest]
}

/** Switched-off vaults that do have matches, in chip order — for "N matches in X, which is off". */
export function offVaultMatches(chips: readonly ChipVault[], counts: ReadonlyMap<string, number>, off: ReadonlySet<string>): Array<{ vault: ChipVault; count: number }> {
  return chips.filter((c) => off.has(c.id) && (counts.get(c.id) ?? 0) > 0).map((vault) => ({ vault, count: counts.get(vault.id) ?? 0 }))
}

/** "A or B", "A, B or C". */
export function orList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`
}

/** Flip one vault in the off set (a new set). */
export function toggleVault(off: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(off)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}
