// The one containment check for paths that come from outside main (renderer, URL, file contents):
// does a candidate path stay inside a root, lexically and once symlinks are resolved? No imports
// from the rest of the app, so any module (and a multi-vault "inside some registered vault" check)
// can reuse it as-is.

import { lstatSync, realpathSync } from 'fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path'

function lexists(path: string): boolean {
  try { lstatSync(path); return true } catch { return false }
}

function within(parent: string, child: string, allowSame: boolean): boolean {
  if (parent === child) return allowSame
  const rel = relative(parent, child)
  return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
}

/**
 * The containment check every handler here goes through (and the one to reuse for "inside some
 * registered vault"): `candidate` (may not exist yet) stays inside `root` — lexically (no `..` or
 * absolute escape) and once symlinks are resolved: the nearest part of the path that exists (the
 * candidate itself when it exists, a link included) must resolve inside the root's real path.
 * Returns the candidate's resolved real path (for a path that does not exist yet: its nearest
 * existing ancestor's real path plus the rest), or null when it would leave the root.
 * `allowRoot` accepts the root itself; by default the root is refused.
 */
export function pathStaysInside(root: string, candidate: string, allowRoot = false): string | null {
  if (typeof root !== 'string' || typeof candidate !== 'string' || !root || !candidate) return null
  if (root.includes('\0') || candidate.includes('\0')) return null
  const r = resolve(root)
  const t = resolve(r, candidate)
  if (!within(r, t, allowRoot)) return null
  // The root may not exist yet (a fresh thumbnail cache): judge it by its nearest existing ancestor.
  let base = r
  while (!lexists(base)) {
    const parent = dirname(base)
    if (parent === base) return null
    base = parent
  }
  let realRoot: string
  try { realRoot = join(realpathSync(base), relative(base, r)) } catch { return null }
  let probe = t
  while (!lexists(probe)) {
    const parent = dirname(probe)
    if (parent === probe) return null
    probe = parent
  }
  // Nothing exists below the root yet (the root itself may be missing): nothing can redirect it.
  if (probe !== t && within(probe, r, true)) return join(realRoot, relative(r, t))
  let real: string
  try { real = realpathSync(probe) } catch { return null } // a dangling link
  if (!within(realRoot, real, allowRoot || probe !== t)) return null
  return probe === t ? real : join(real, relative(probe, t))
}
