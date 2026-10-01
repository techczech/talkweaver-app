// Where a talk's slide thumbnails live inside a thumbnail-cache namespace, per vault
// (several-vaults ticket 02; architecture.md, "Impact surface → Thumbnail cache").
//
// Layout inside one namespace (`<userData>/thumb-cache-v<N>-<tag>/`):
//   @vaults/<vaultId>/<slug>/   a vault's talk (two vaults may share a slug; their pictures never mix)
//   <name>/                     app-level caches (`__layout-preview__-*`, `__ledger__`), talks outside
//                               every vault, and the per-slug folders older builds wrote
//
// URLs: `twthumb://<slug>/<key>?vault=<vaultId>` names one vault's picture and is looked up in that
// vault's folder only. A bare `twthumb://<slug>/<key>` (what the renderer builds today) is looked up
// in each open vault's folder in order, then the namespace-level folder.
//
// The per-slug folders older builds wrote belong to the vault they rendered for, which the registry
// migrated into the first open vault; adoptLegacyThumbDirs moves them there once (a rename, no copy),
// so upgrading re-renders nothing.
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, utimesSync } from 'fs'
import { join } from 'path'

export const VAULTS_DIR = '@vaults'

const safeSegment = (s: string): boolean => /^[A-Za-z0-9_-]+$/.test(s)

/** The folder (and URL) name for a vault: its id when that is a plain token (registry ids are
 *  UUIDs), else a hash of it, so no id can reach outside @vaults. */
export function vaultDirName(vaultId: string): string {
  return safeSegment(vaultId) ? vaultId : 'x-' + createHash('sha256').update(vaultId).digest('hex').slice(0, 32)
}

/** The folder for one talk's thumbnails. vaultId null = a talk in no vault (namespace level). */
export function talkThumbDir(namespaceDir: string, vaultId: string | null, slug: string): string {
  if (vaultId) return join(namespaceDir, VAULTS_DIR, vaultDirName(vaultId), slug)
  return join(namespaceDir, slug)
}

/** The twthumb:// URL for a rendered picture; key is the PNG basename. */
export function thumbUrl(slug: string, key: string, vaultId: string | null): string {
  const base = 'twthumb://' + slug + '/' + key
  return vaultId ? base + '?vault=' + vaultDirName(vaultId) : base
}

export type ThumbRequest = { slug: string; key: string; vaultId: string | null }

/** One path segment that stays where it is joined: no separator, not `.` or `..`. */
export function isPlainSegment(s: string): boolean {
  return Boolean(s) && !/[/\\]/.test(s) && s !== '.' && s !== '..'
}

/** null for a URL that is not a thumbnail request, or whose slug or key (decoded) would leave the
 *  cache folder (`twthumb://alpha/..%2F..%2Fx`). */
export function parseThumbUrl(raw: string): ThumbRequest | null {
  try {
    const url = new URL(raw)
    const slug = decodeURIComponent(url.hostname)
    const key = decodeURIComponent(url.pathname.replace(/^\//, ''))
    if (!isPlainSegment(slug) || !isPlainSegment(key)) return null
    const vault = url.searchParams.get('vault')
    return { slug, key, vaultId: vault && safeSegment(vault) ? vault : null }
  } catch {
    return null
  }
}

/** Folders to look in, in order, for a request. A vault-qualified request never reads another
 *  vault's folder; a bare one tries the open vaults in order, then the namespace level. */
export function thumbLookupDirs(namespaceDir: string, req: ThumbRequest, openVaultIds: string[]): string[] {
  if (req.vaultId) return [talkThumbDir(namespaceDir, req.vaultId, req.slug)]
  return [
    ...openVaultIds.map((id) => talkThumbDir(namespaceDir, id, req.slug)),
    talkThumbDir(namespaceDir, null, req.slug)
  ]
}

/** Bump the namespace folder's mtime (creating it if needed). Older builds' cache sweeps judge a
 *  namespace by the mtime of its folder and its immediate children only, so renders deep under
 *  @vaults/ must also show here, or such a build deletes the live namespace after its grace period.
 *  Never throws. */
export function touchNamespace(namespaceDir: string, now: Date = new Date()): void {
  try {
    mkdirSync(namespaceDir, { recursive: true })
    utimesSync(namespaceDir, now, now)
  } catch { /* cache bookkeeping only */ }
}

/** Move the per-slug folders an older build left at the namespace level into vaultId's folder.
 *  App-level caches (`__…`) and folders the vault already has stay put. Returns how many moved.
 *  Never throws; a folder that cannot be moved stays where it is and is still read by bare URLs. */
export function adoptLegacyThumbDirs(namespaceDir: string, vaultId: string): number {
  if (!existsSync(namespaceDir)) return 0
  let names: string[]
  try { names = readdirSync(namespaceDir) } catch { return 0 }
  const target = join(namespaceDir, VAULTS_DIR, vaultDirName(vaultId))
  let moved = 0
  for (const name of names) {
    if (name === VAULTS_DIR || name.startsWith('__') || name.startsWith('.')) continue
    const from = join(namespaceDir, name)
    const to = join(target, name)
    try {
      if (!statSync(from).isDirectory() || existsSync(to)) continue
      mkdirSync(target, { recursive: true })
      renameSync(from, to)
      moved += 1
    } catch { /* leave it; bare lookups still find it */ }
  }
  return moved
}
