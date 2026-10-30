// The one containment check for paths that come from outside main (renderer, URL, file contents):
// does a candidate path stay inside a root, lexically and once symlinks are resolved? No imports
// from the rest of the app, so any module (and a multi-vault "inside some registered vault" check)
// can reuse it as-is.

import { lstatSync, realpathSync } from 'fs'
import { lstat, realpath } from 'fs/promises'
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

/** An answer from the filesystem that is not "there is nothing at this path". */
function isAbsent(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** Thrown when a caller's budget ran out: no further filesystem operation was started. */
export class FsWorkStopped extends Error {
  constructor() { super('stopped'); this.name = 'FsWorkStopped' }
}

/**
 * One filesystem operation under a caller's stop signal (review of 03756f0f): never started once
 * `stop()` is true, and its result not used if `stop()` became true while it ran.
 */
export async function underStop<T>(stop: () => boolean, op: () => Promise<T>): Promise<T> {
  if (stop()) throw new FsWorkStopped()
  const result = await op()
  if (stop()) throw new FsWorkStopped()
  return result
}

const never = (): boolean => false

async function lexistsAsync(path: string, stop: () => boolean): Promise<boolean> {
  try { await underStop(stop, () => lstat(path)); return true } catch (error) { if (isAbsent(error)) return false; throw error }
}

/**
 * pathStaysInside without blocking main (object card status and earlier views, review R4 of a222975a):
 * the same lexical and resolved-path rule, with the filesystem asked asynchronously. Null when the
 * candidate would leave the root, as for pathStaysInside; any answer other than "nothing there" (no
 * permission, an I/O error) is thrown, so a caller can tell "outside" from "could not be checked".
 * With `stop`, no filesystem operation starts once it is true (FsWorkStopped is thrown). The answer is
 * a fact about one moment, never an authority to open the path later: a reader that must not consume
 * bytes from outside opens with a kernel-enforced rule instead (object-status.ts, readRecord).
 */
export async function pathStaysInsideAsync(root: string, candidate: string, allowRoot = false, stop: () => boolean = never): Promise<string | null> {
  if (typeof root !== 'string' || typeof candidate !== 'string' || !root || !candidate) return null
  if (root.includes('\0') || candidate.includes('\0')) return null
  const r = resolve(root)
  const t = resolve(r, candidate)
  if (!within(r, t, allowRoot)) return null
  let base = r
  while (!(await lexistsAsync(base, stop))) {
    const parent = dirname(base)
    if (parent === base) return null
    base = parent
  }
  const realRoot = join(await underStop(stop, () => realpath(base)), relative(base, r))
  let probe = t
  while (!(await lexistsAsync(probe, stop))) {
    const parent = dirname(probe)
    if (parent === probe) return null
    probe = parent
  }
  if (probe !== t && within(probe, r, true)) return join(realRoot, relative(r, t))
  let real: string
  try { real = await underStop(stop, () => realpath(probe)) } catch (error) { if (isAbsent(error)) return null; throw error } // a dangling link
  if (!within(realRoot, real, allowRoot || probe !== t)) return null
  return probe === t ? real : join(real, relative(probe, t))
}
