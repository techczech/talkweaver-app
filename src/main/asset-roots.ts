// The folders a talk's media may be read from when it is compiled (ADR-0036: media references stay
// inside the talk's vault). The compiler checks every file a talk names against these roots, by
// real path; this module only decides WHICH roots a talk gets. No imports from the rest of main.

import { dirname, isAbsolute, resolve } from 'path'

/** The part of the vault registry this needs: the vault (open or closed) whose root holds a path. */
export interface VaultLookup {
  resolve(absPath: string): { vault: { root: string } } | null
}

/**
 * The root of the registered vault (open or closed, current or not) that holds the talk, or
 * undefined for a talk in no vault. This is the vault a talk's pooled ids (`img-…`) are names in:
 * never "the current vault", which for a talk in a closed vault is a different one.
 */
export function talkVaultRoot(vaults: VaultLookup, outlinePath: string): string | undefined {
  let root: string | undefined
  try { root = typeof outlinePath === 'string' && outlinePath ? vaults.resolve(outlinePath)?.vault.root : undefined } catch { root = undefined }
  return typeof root === 'string' && isAbsolute(root) ? root : undefined
}

/**
 * What every main-process compile passes to the compiler as `allowedAssetRoots`:
 *   - a talk in a registered vault: that vault's root. The talk's own folder, other talks' folders
 *     and the pooled `_assets` folder are all inside it;
 *   - a talk in no vault (a loose file, a temp copy): its own folder, nothing else. There is no
 *     fallback to "the current vault": a talk outside every vault is never given one to read from.
 * `extra` adds roots for a compile staged somewhere else on purpose (a temp folder holding slides
 * that belong to a vault).
 */
export function assetRootsForTalk(vaults: VaultLookup, outlinePath: string, extra: string[] = []): string[] {
  const own = talkVaultRoot(vaults, outlinePath) ?? dirname(resolve(String(outlinePath)))
  return [own, ...extra.filter((root) => typeof root === 'string' && isAbsolute(root) && root !== own)]
}
