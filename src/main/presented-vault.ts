// The vault a presenter window's writes go to (issue 256): its recording, its saved Run and the
// stream marker's vault are the vault of the talk being presented, never the first vault because it
// is first. Pure: index.ts passes the registry; the tests pass two temp vaults.

/** Where a write goes: a vault root, `null` for no vault at all (the Run is kept beside the audio), or why no vault can be named
 *  (recording.ts then keeps the Run beside its audio in TalkWeaver's own folder: a recording is never refused or put in another vault). */
export type WriteVault = { root: string | null } | { error: string }

/** The talk's own vault is closed, or its folder is not there right now. */
export const TALK_VAULT_NOT_OPEN = 'The vault this talk is in is not open, or its folder is missing.'
/** The talk is in no vault and more than one vault is open: no vault can be named. */
export const VAULT_NOT_NAMED = 'This talk is not in any open vault and more than one vault is open, so no vault can be named.'

interface VaultLike { id: string; root: string; open: boolean }

export interface PresentedVaultDeps {
  /** The registered vault (open or closed) whose root holds a path. */
  resolve(absPath: string): { vault: VaultLike } | null
  /** Open and its folder answers (index.ts vaultAvailable). */
  available(vault: VaultLike): boolean
  /** The root, only while its folder is there right now (vault-availability.ts writableRoot). */
  writable(root: string): string | undefined
  /** How many vaults are open (available or not). */
  openVaults(): number
  /** The single-vault write root as before (index.ts writableVaultRoot), or null. */
  current(): string | null
}

/**
 * The vault a write for the talk at `outlinePath` goes to:
 *   - a talk in an open vault whose folder is there: that vault;
 *   - a talk in a closed vault: refused (never another vault in its place);
 *   - a talk in an open vault that is unavailable, or a talk in no vault: with one vault open (or none),
 *     the current vault as before (null when it is not there: the Run is kept beside the audio); with
 *     more than one open, refused.
 */
export function presentedTalkVault(deps: PresentedVaultDeps, outlinePath: string): WriteVault {
  let hit: { vault: VaultLike } | null = null
  try { hit = typeof outlinePath === 'string' && outlinePath ? deps.resolve(outlinePath) : null } catch { hit = null }
  if (hit && !hit.vault.open) return { error: TALK_VAULT_NOT_OPEN }
  if (hit && deps.available(hit.vault)) {
    const root = deps.writable(hit.vault.root)
    if (root) return { root }
  }
  if (deps.openVaults() > 1) return { error: hit ? TALK_VAULT_NOT_OPEN : VAULT_NOT_NAMED }
  return { root: deps.current() }
}
