import type { OpenInNewWindowTarget } from '../shared/open-in-new-window'

// Main-process bookkeeping for "Open in new window". A window started for a talk is "starting" from
// its creation until it claims the talk (window:claim-talk) or closes, so a second request for the
// same talk in that gap focuses the starting window instead of opening an empty second one. Pure: no
// Electron, window ids are numbers, identity comparison and vault checks are injected.

interface Pending { target: OpenInNewWindowTarget; taken: boolean }

export interface OpenRequests {
  /** A window was created for `target`. */
  start(wcId: number, target: OpenInNewWindowTarget): void
  /** The new window asks what it was opened for: once. A talk stays "starting" until claimed. */
  take(wcId: number): OpenInNewWindowTarget | null
  /** The window that is starting for this talk, if any. */
  startingFor(outlinePath: string): number | null
  /** The window now holds its talk (or released it): it is no longer starting. */
  claimed(wcId: number): void
  /** The window closed. */
  closed(wcId: number): void
  size(): number
}

export function createOpenRequests(identityKey: (outlinePath: string) => string, isLive: (wcId: number) => boolean = () => true): OpenRequests {
  const pending = new Map<number, Pending>()
  return {
    start: (wcId, target) => { pending.set(wcId, { target, taken: false }) },
    take(wcId) {
      const p = pending.get(wcId)
      if (!p || p.taken) return null
      if (p.target.kind === 'talk') p.taken = true
      else pending.delete(wcId) // a folder claims nothing: nothing to keep
      return p.target
    },
    startingFor(outlinePath) {
      const wanted = identityKey(outlinePath)
      for (const [wcId, p] of pending) {
        if (p.target.kind === 'talk' && isLive(wcId) && identityKey(p.target.outlinePath) === wanted) return wcId
      }
      return null
    },
    claimed: (wcId) => { pending.delete(wcId) },
    closed: (wcId) => { pending.delete(wcId) },
    size: () => pending.size
  }
}

/** Why a request is refused, or null when it may proceed. `outlineRefused` is the vault-containment
 *  check for a talk path; a folder must be a plain relative path inside a known vault. */
export function refuseOpenTarget(
  target: OpenInNewWindowTarget,
  deps: { outlineRefused: (outlinePath: string) => string | null; hasVault: (vaultId: string) => boolean }
): string | null {
  if (target.kind === 'talk') return deps.outlineRefused(target.outlinePath)
  const topic = target.topic
  if (topic.startsWith('/') || topic.startsWith('\\') || /^[a-zA-Z]:/.test(topic) || topic.includes('\0')) return 'folder must be relative'
  if (topic.split(/[\\/]/).some((part) => part === '..' || part === '.' || part === '')) return 'folder must be a plain path inside the vault'
  if (target.vaultId !== undefined && !deps.hasVault(target.vaultId)) return 'unknown vault'
  return null
}
