// Is a vault's folder there? (several-vaults ticket 07; LOCKED-sidebar frame 2C.) A vault whose root
// is missing, unreadable or not responding is "unavailable": its section stays, greyed, with the
// reason and one action; it lists no talks and is not scanned, watched, indexed or searched
// (architecture.md invariant 5), and nothing is written into it.
//
// The check never blocks the main process: each folder is asked asynchronously (one access and one
// opendir, no entry read, so a cloud File Provider is not asked for a listing), with a per-vault
// timeout; a folder that does not answer in time is unavailable ("not responding"). Checks are
// throttled (a window focus asks at most every 10 s; "Check again" forces one). The service label
// of a vault is worked out once per vault id and folder and kept; the last name and service seen
// while a vault was reachable are kept (and persisted by the caller) so an unavailable vault keeps
// its name, even at launch.
import { constants as fsConstants, promises as fsp } from 'node:fs'
import { isAbsolute, dirname, relative, resolve, sep } from 'node:path'
import type { VaultService } from './vault-view.ts'

export type UnavailableReason = 'not-signed-in' | 'folder-moved' | 'no-permission' | 'folder-not-found' | 'not-responding'
export type UnavailableAction = 'open-service' | 'retry'

export type VaultUnavailable = {
  reason: UnavailableReason
  /** Why, and what to do, for the note under the header (no folder path, no vault name: the panel
   *  adds "X is unavailable on this Mac." before it and the provenance sentence after it). */
  message: string
  action: UnavailableAction
  /** The button's label. */
  actionLabel: string
}

/** What a look at the folder found. */
export type RootState = 'dir' | 'missing' | 'denied' | 'not-dir'

export type AvailabilityProbe = {
  home: string
  /** Look at the folder: a directory that can be opened, missing, refused by the system, or
   *  something that is not a folder. */
  state: (path: string) => Promise<RootState>
  exists: (path: string) => Promise<boolean>
}

const CLOUD: ReadonlySet<VaultService> = new Set(['OneDrive', 'Dropbox', 'Google Drive'])

/** The app the unavailable section's "Open <service> settings" opens (a fixed list, never a
 *  renderer-supplied path). */
export const SERVICE_APPS: Partial<Record<VaultService, string>> = {
  OneDrive: '/Applications/OneDrive.app',
  Dropbox: '/Applications/Dropbox.app',
  'Google Drive': '/Applications/Google Drive.app'
}

/** The folder a cloud service mounts under the home folder (~/Library/CloudStorage/<Service-…> or
 *  ~/Dropbox), when the vault sits inside one. */
function cloudMount(root: string, home: string): string | null {
  if (!isAbsolute(root)) return null
  const parts = relative(home, root).split(sep)
  if (parts[0] === '..' || parts[0] === '') return null
  if (parts[0] === 'Library' && parts[1] === 'CloudStorage' && parts[2]) return [home, 'Library', 'CloudStorage', parts[2]].join(sep)
  return [home, parts[0]].join(sep)
}

export async function vaultUnavailability(root: string, service: VaultService, probe: AvailabilityProbe): Promise<VaultUnavailable | null> {
  const state = await probe.state(root)
  if (state === 'dir') return null
  if (state === 'denied') return denied()
  // missing, or not a folder any more
  if (CLOUD.has(service)) {
    const mount = cloudMount(root, probe.home)
    if (mount && !(await probe.exists(mount))) {
      return {
        reason: 'not-signed-in',
        message: `${service} is not signed in. Sign in and it comes back on its own.`,
        action: 'open-service',
        actionLabel: `Open ${service} settings`
      }
    }
  }
  if (state === 'missing' && (await probe.exists(dirname(root)))) {
    return {
      reason: 'folder-moved',
      message: 'The folder was moved, renamed or deleted. Put it back and it comes back on its own.',
      action: 'retry',
      actionLabel: 'Check again'
    }
  }
  return {
    reason: 'folder-not-found',
    message: 'The folder was not found. Reconnect the drive or put the folder back and it comes back on its own.',
    action: 'retry',
    actionLabel: 'Check again'
  }
}

function denied(): VaultUnavailable {
  return {
    reason: 'no-permission',
    message: 'TalkWeaver has no permission to read this folder. Allow access in System Settings, then check again.',
    action: 'retry',
    actionLabel: 'Check again'
  }
}

export function notResponding(): VaultUnavailable {
  return {
    reason: 'not-responding',
    message: 'The folder is not responding. When its drive or service answers again it comes back on its own.',
    action: 'retry',
    actionLabel: 'Check again'
  }
}

/** The real probe: `access(R_OK)` then `opendir` + `close` (no entry is read). */
export function nodeAvailabilityProbe(home: string, fs: Pick<typeof fsp, 'access' | 'opendir'> = fsp): AvailabilityProbe {
  const code = (e: unknown): string => String((e as NodeJS.ErrnoException)?.code ?? '')
  return {
    home,
    async state(path) {
      try { await fs.access(path, fsConstants.R_OK) } catch (e) {
        const c = code(e)
        if (c === 'EACCES' || c === 'EPERM') return 'denied'
        if (c === 'ENOTDIR') return 'missing'
        return 'missing'
      }
      try {
        const dir = await fs.opendir(path)
        await dir.close().catch(() => {})
        return 'dir'
      } catch (e) {
        const c = code(e)
        if (c === 'ENOTDIR') return 'not-dir'
        if (c === 'EACCES' || c === 'EPERM') return 'denied'
        return 'missing'
      }
    },
    async exists(path) {
      try { await fs.access(path); return true } catch { return false }
    }
  }
}

/** p, or onTimeout() after ms. */
export function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => resolvePromise(onTimeout()), ms)
    p.then((v) => { clearTimeout(timer); resolvePromise(v) }, (e) => { clearTimeout(timer); reject(e) })
  })
}

/** The name and service a vault had when it was last reachable. */
export type LastGood = { name: string | null; service: VaultService }

export type AvailabilityVault = { id: string; root: string; open: boolean }

export interface VaultAvailability {
  /** The last check's answer for this vault: null = available (or never checked), else why not. */
  status(id: string): VaultUnavailable | null
  isUnavailable(id: string): boolean
  /** Check every open vault (closed ones are not touched) unless the last check was under the
   *  throttle ago; `force` checks now. Concurrent calls share one check. True when an answer changed. */
  check(vaults: AvailabilityVault[], opts?: { force?: boolean }): Promise<boolean>
  /** The vault's service label: worked out once per id and folder while the folder answers, else
   *  the last one seen (else from the path alone). */
  service(vault: { id: string; root: string }): VaultService
  lastGood(id: string): LastGood | null
  /** Keep this vault's name and service (called while it is reachable); persisted when it changes. */
  remember(id: string, good: LastGood): void
  /** Drop what is known about a vault (removed from the list). */
  forget(id: string): void
}

export type AvailabilityDeps = {
  probe: AvailabilityProbe
  /** The full service label (may look at the disk: realpath, .git); called only for a folder that
   *  just answered, once per id and folder. */
  serviceOf: (root: string) => VaultService
  /** The service label from the path alone (no disk). */
  serviceFromPath: (root: string) => VaultService
  timeoutMs?: number
  throttleMs?: number
  now?: () => number
  readLastGood?: () => Record<string, LastGood> | undefined
  writeLastGood?: (all: Record<string, LastGood>) => void
}

export function createVaultAvailability(deps: AvailabilityDeps): VaultAvailability {
  const timeoutMs = deps.timeoutMs ?? 1500
  const throttleMs = deps.throttleMs ?? 10_000
  const now = deps.now ?? (() => Date.now())
  const statuses = new Map<string, VaultUnavailable | null>()
  const services = new Map<string, { root: string; service: VaultService }>()
  let lastGoodAll: Record<string, LastGood> = { ...(safe(() => deps.readLastGood?.()) ?? {}) }
  let lastCheckAt = -Infinity
  let inFlight: Promise<boolean> | null = null
  let checkedKey = ''

  const keyOf = (vaults: AvailabilityVault[]): string => vaults.filter((v) => v.open).map((v) => `${v.id}\u0000${resolve(v.root)}`).join('\u0001')

  async function checkOne(v: AvailabilityVault): Promise<VaultUnavailable | null> {
    const kept = lastGoodAll[v.id]?.service ?? services.get(v.id)?.service ?? deps.serviceFromPath(v.root)
    try {
      return await withTimeout(vaultUnavailability(v.root, kept, deps.probe), timeoutMs, notResponding)
    } catch {
      return {
        reason: 'folder-not-found',
        message: 'The folder was not found. Reconnect the drive or put the folder back and it comes back on its own.',
        action: 'retry',
        actionLabel: 'Check again'
      }
    }
  }

  async function run(vaults: AvailabilityVault[]): Promise<boolean> {
    const open = vaults.filter((v) => v.open)
    const answers = await Promise.all(open.map(async (v) => [v.id, await checkOne(v)] as const))
    let changed = false
    for (const [id, answer] of answers) {
      const before = statuses.get(id)
      if (before === undefined ? answer !== null : JSON.stringify(before) !== JSON.stringify(answer)) changed = true
      statuses.set(id, answer)
    }
    for (const id of [...statuses.keys()]) if (!open.some((v) => v.id === id)) statuses.delete(id)
    lastCheckAt = now()
    checkedKey = keyOf(vaults)
    return changed
  }

  const api: VaultAvailability = {
    status(id) { return statuses.get(id) ?? null },
    isUnavailable(id) { return !!statuses.get(id) },
    check(vaults, opts) {
      if (inFlight) return inFlight
      const fresh = now() - lastCheckAt < throttleMs && checkedKey === keyOf(vaults)
      if (fresh && !opts?.force) return Promise.resolve(false)
      inFlight = run(vaults).finally(() => { inFlight = null })
      return inFlight
    },
    service(vault) {
      const cached = services.get(vault.id)
      if (cached && cached.root === vault.root) return cached.service
      if (statuses.get(vault.id) || !statuses.has(vault.id)) {
        // Unavailable, or not checked yet: never touch the disk for the label.
        return lastGoodAll[vault.id]?.service ?? deps.serviceFromPath(vault.root)
      }
      const service = safe(() => deps.serviceOf(vault.root)) ?? deps.serviceFromPath(vault.root)
      services.set(vault.id, { root: vault.root, service })
      return service
    },
    lastGood(id) { return lastGoodAll[id] ?? null },
    remember(id, good) {
      const before = lastGoodAll[id]
      if (before && before.name === good.name && before.service === good.service) return
      lastGoodAll = { ...lastGoodAll, [id]: { name: good.name, service: good.service } }
      safe(() => deps.writeLastGood?.(lastGoodAll))
    },
    forget(id) {
      statuses.delete(id)
      services.delete(id)
      if (lastGoodAll[id]) {
        const next = { ...lastGoodAll }
        delete next[id]
        lastGoodAll = next
        safe(() => deps.writeLastGood?.(lastGoodAll))
      }
    }
  }
  return api
}

function safe<T>(fn: () => T): T | undefined {
  try { return fn() } catch { return undefined }
}

// ── Writes ────────────────────────────────────────────────────────────────────────────────────

export type RootFs = { isDirectory: (path: string) => boolean; mkdir: (path: string) => void }

/** Is `dir` strictly below `root`? */
export function isBelow(root: string, dir: string): boolean {
  const rel = relative(resolve(root), resolve(dir))
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel)
}

/** The folder a write may create into: root when it is an existing folder right now, else null
 *  (a moved folder is never re-created, a signed-out cloud folder never gets a local tree). */
export function writableRoot(root: string | null | undefined, fs: Pick<RootFs, 'isDirectory'>): string | null {
  if (!root) return null
  return fs.isDirectory(root) ? root : null
}

/** Create dir (and any missing folders between it and root), only below an existing vault root.
 *  Never creates the root itself or anything above it: throws VaultUnavailableError instead. */
export function mkdirBelowRoot(root: string, dir: string, fs: RootFs): void {
  if (!isBelow(root, dir)) throw new VaultUnavailableError('outside-vault')
  if (!fs.isDirectory(root)) throw new VaultUnavailableError('vault-unavailable')
  fs.mkdir(dir)
}

export class VaultUnavailableError extends Error {
  readonly reason: 'vault-unavailable' | 'outside-vault'
  constructor(reason: 'vault-unavailable' | 'outside-vault') {
    super(reason === 'vault-unavailable' ? 'The vault folder is not available on this Mac, so nothing was written.' : 'That folder is outside the vault.')
    this.reason = reason
  }
}
