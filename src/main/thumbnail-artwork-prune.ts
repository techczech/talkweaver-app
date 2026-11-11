// Generated thumbnail artwork only; the caller supplies the app-owned namespace boundary.
import { lstat, readdir, realpath, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path)
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
}

/** Preflight only: same-user replacement between checks and operations is an accepted race. */
async function safeDirectory(cacheDir: string, namespaceRoot: string): Promise<boolean> {
  const root = resolve(namespaceRoot), dir = resolve(cacheDir)
  if (!inside(root, dir)) return false
  const ancestors: string[] = []
  for (let path = dir;; path = dirname(path)) {
    ancestors.push(path)
    if (path === root) break
    if (dirname(path) === path) return false
  }
  try {
    // Root first: refuse an ancestor link before even inspecting its descendants.
    for (const path of ancestors.reverse()) {
      const entry = await lstat(path)
      if (entry.isSymbolicLink() || !entry.isDirectory()) return false
    }
    return inside(await realpath(root), await realpath(dir))
  } catch { return false }
}

/** Only standard namespaces immediately under the configured userData root can be pruned. */
export function thumbnailArtworkNamespace(cacheDir: string, userData: string): string | null {
  const rel = relative(resolve(userData), resolve(cacheDir))
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return null
  const name = rel.split(sep)[0]
  return /^thumb-cache-v\d+-[0-9a-z]+$/.test(name) ? join(resolve(userData), name) : null
}

export async function pruneThumbnailArtwork(cacheDir: string, namespaceRoot: string | null, currentPrefix: string,
  verified: ReadonlySet<string>, log: (message: string) => void = () => {}): Promise<void> {
  const refused = (): void => log('[thumbnails] skipped artwork pruning: unsafe or unknown cache directory')
  if (!namespaceRoot || !await safeDirectory(cacheDir, namespaceRoot)) { refused(); return }
  const names = await readdir(cacheDir).catch(() => [])
  const candidates = names.filter(name => {
    const match = /^[0-9a-f]{16}-(.+?)(?:__\d+)?\.png$/.exec(name)
    return match && !name.startsWith(currentPrefix) && verified.has(match[1])
  })
  for (const name of candidates) {
    if (!await safeDirectory(cacheDir, namespaceRoot)) { refused(); return }
    const path = join(cacheDir, name)
    try {
      const entry = await lstat(path)
      if (entry.isSymbolicLink() || !entry.isFile()) continue
      await unlink(path)
    } catch { /* vanished or unreadable: generated cache cleanup is best effort */ }
  }
}
