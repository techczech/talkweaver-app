// The image drawer's one import (ticket 11, and the pictures of an editable old slide, ticket 12): copy a
// search hit's file into the `_assets` pool of the vault that holds the TARGET TALK, and answer its
// `img-<hash>` id. The id is a name in that vault's pool only, so the vault is worked out here, in main, from
// the talk path the renderer names, never taken from the renderer and never "the current vault".
//
// The rule is deliberately plain:
//   - the vault is found from the path text through the registry, exactly as the compiler finds the pool it
//     reads a talk's ids from (registry.resolve, asset-roots.ts), so the two always agree;
//   - the talk must be a plain file reached through plain folders below that vault's root, and `_assets` a
//     plain folder: no link anywhere below the root, so the text names the real place;
//   - the vault is asked again after the awaited file lookup and before each write;
//   - files are created exclusively and never through a link (O_CREAT | O_EXCL | O_NOFOLLOW).
// Anything else imports nothing.

import { createHash } from 'crypto'
import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeSync } from 'fs'
import { basename, dirname, isAbsolute, join } from 'path'
import type { ImportedImage } from '../../shared/image-search.ts'
import type { ImageFile } from './provider.ts'

type VaultEntry = { id: string; root: string; open: boolean }

/** The part of the vault registry this needs: the vault holding a path, by its text (registry.resolve). */
export interface TalkVaultLookup {
  resolve(absPath: string): { vault: VaultEntry; rel: string } | null
}

function lstatOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try { return lstatSync(path) } catch { return null }
}

/**
 * The root to write the talk's pooled pictures into: the OPEN vault the registry finds for the path text,
 * when the talk is a plain file below its root reached through plain folders only (no link), and `writable`
 * says the folder is there now. Undefined for anything else: not text, not absolute, the vault root itself,
 * a closed vault, no vault, a link on the way, a talk that is not a plain file. No fallback to another vault.
 */
export function talkVaultWriteRoot(
  vaults: TalkVaultLookup,
  talkPath: unknown,
  writable: (vault: VaultEntry) => string | undefined
): string | undefined {
  if (typeof talkPath !== 'string' || !talkPath || talkPath.includes('\0') || !isAbsolute(talkPath)) return undefined
  let hit: ReturnType<TalkVaultLookup['resolve']>
  try { hit = vaults.resolve(talkPath) } catch { hit = null }
  if (!hit || !hit.vault.open || !hit.rel) return undefined
  const parts = hit.rel.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return undefined
  let at = hit.vault.root
  for (let i = 0; i < parts.length; i++) {
    at = join(at, parts[i])
    const st = lstatOrNull(at)
    if (!st || (i < parts.length - 1 ? !st.isDirectory() : !st.isFile())) return undefined
  }
  return writable(hit.vault) ?? undefined
}

export type ImageImportDeps = {
  /** The image search seam's own rule for which files may be imported (imageSearch.fileFor). */
  fileFor(thumbUrlOrPath: string): Promise<ImageFile | null>
  /** talkVaultWriteRoot bound to the live registry: asked again after the lookup and before each write. */
  vaultRootForTalk(talkPath: unknown): string | undefined
  today?: () => string
  warn?: (message: string) => void
  /** Test hook: runs just before each check-then-write step (where a vault could close or a link appear). */
  beforeWrite?: (step: 'pool' | 'image' | 'sidecar') => void
}

class Refused extends Error {}

/** `<vault>/_assets` while the talk's vault is still the one we started with and `_assets` is a plain folder
 *  (with `create`, made when it is not there yet). Throws Refused otherwise. */
function poolDir(deps: ImageImportDeps, talkPath: unknown, vaultRoot: string, create = false): string {
  if (deps.vaultRootForTalk(talkPath) !== vaultRoot) throw new Refused('the talk’s vault closed or changed')
  const assetsDir = join(vaultRoot, '_assets')
  let st = lstatOrNull(assetsDir)
  if (!st && create) {
    try { mkdirSync(assetsDir) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e }
    st = lstatOrNull(assetsDir)
  }
  if (st ? !st.isDirectory() : create) throw new Refused('_assets is not a plain folder of this vault')
  return assetsDir
}

/** Create path exclusively, never through a link; false when a plain file is already there. */
function createExclusive(path: string, data: Buffer | string): boolean {
  let fd: number
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o644)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST' && lstatOrNull(path)?.isFile()) return false
    throw new Refused('cannot create ' + basename(path))
  }
  try {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
    let off = 0
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off)
  } finally {
    closeSync(fd)
  }
  return true
}

function sameFolder(a: string, b: string): boolean {
  try { return realpathSync(a) === realpathSync(b) } catch { return false }
}

/** `images:import` (thumbUrl, talkPath): the hit copied into the talk's vault pool (or found already there). */
export async function importImageForTalk(deps: ImageImportDeps, thumbUrlOrPath: unknown, talkPath: unknown): Promise<ImportedImage | null> {
  if (typeof thumbUrlOrPath !== 'string' || !thumbUrlOrPath) return null
  const vaultRoot = deps.vaultRootForTalk(talkPath)
  if (!vaultRoot) {
    deps.warn?.('[image-search:import] the talk is in no open vault: ' + String(talkPath).slice(0, 300))
    return null
  }
  try {
    // The seam decides which files may be imported, at request time (same rule as twarchive://).
    const file = await deps.fileFor(thumbUrlOrPath)
    if (!file) {
      deps.warn?.('[image-search:import] refused path: ' + thumbUrlOrPath.slice(0, 300))
      return null
    }
    const absPath = file.absPath

    // After the lookup: the vault is asked again (it may have closed while we waited).
    deps.beforeWrite?.('pool')
    const pool = poolDir(deps, talkPath, vaultRoot)

    // A talk image already in this vault's pool: insert it as it is, copy nothing.
    const pooled = /^(img-[0-9a-f]{7,})\.([a-z0-9]+)$/i.exec(basename(absPath))
    const inPool = join(pool, basename(absPath))
    if (pooled && lstatOrNull(pool) && sameFolder(dirname(absPath), pool) && lstatOrNull(inPool)?.isFile()) {
      return { id: pooled[1], ext: pooled[2].toLowerCase(), path: inPool }
    }

    const origBuf = readFileSync(absPath)
    const ext = (absPath.split('.').pop() || 'png').toLowerCase()

    // Content-address the bytes exactly like asset:paste-image (img-{7hex sha256}.{ext}).
    const hash = createHash('sha256').update(origBuf).digest('hex').slice(0, 7)
    const id = 'img-' + hash

    deps.beforeWrite?.('image')
    const assetPath = join(poolDir(deps, talkPath, vaultRoot, true), id + '.' + ext)
    if (createExclusive(assetPath, origBuf)) {
      deps.beforeWrite?.('sidecar')
      // Provenance: where the image came from, with the originating path noted (one already there is kept).
      createExclusive(
        join(poolDir(deps, talkPath, vaultRoot), id + '.yml'),
        [
          'id: ' + id,
          'created: ' + (deps.today ? deps.today() : new Date().toISOString().slice(0, 10)),
          'original_format: ' + ext,
          'note: ' + JSON.stringify(file.provenance.note),
          'alt: ""',
          'caption: ""',
          'source: ' + JSON.stringify(file.provenance.source),
          'tags: []'
        ].join('\n') + '\n'
      )
    }
    return { id, ext, path: assetPath }
  } catch (e) {
    deps.warn?.('[image-search:import] ' + (e instanceof Error ? e.message : String(e)))
    return null
  }
}
