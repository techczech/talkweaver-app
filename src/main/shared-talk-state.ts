// Part of Share for comments (ticket 12 design: the header of src/main/shared-talk.ts). The share
// registry (rows, their tokens, the file) and the in-memory push state every other part reads:
// one ShareCore per createSharedTalks call.
import { openOwnerTokenRegistry } from './owner-tokens.ts'
import { isLocalOrigin, sharedTalkLink, type SharedTalkState } from '../shared/shared-talk.ts'
import {
  validRecord,
  type Attempt, type OutlineIdentityLike, type RegistryFile, type SharedTalkDeps, type SharedTalkRecord,
} from './shared-talk-model.ts'

export interface ShareCore {
  deps: SharedTalkDeps
  now(): Date
  log(message: string): void
  debounceMs: number
  registryFile: ReturnType<typeof openOwnerTokenRegistry>
  /** The rows this module holds, by identity key. */
  registry: RegistryFile
  // ── in-memory push state (all keyed by identity key) ──
  lastError: Map<string, string | null>
  chains: Map<string, Promise<void>>
  queued: Set<string>
  running: Set<string>
  pendingSave: Map<string, string>
  timers: Map<string, ReturnType<typeof setTimeout>>
  /** Shares (by share id) whose Stop's close step is pressed or running: nothing is pushed to them. */
  stopping: Set<string>
  /** The running push's abort, by share id (a re-keyed talk is still reached by Stop). */
  inFlight: Map<string, AbortController>
  /** The last push attempted per talk whose reply never confirmed it (lost-reply recovery). */
  attempts: Map<string, Attempt>
  qrCache: Map<string, string>
  /** Create steps under way (app quit waits for them, bounded). */
  creating: Set<Promise<unknown>>
  /** share_url tidy-ups started outside a request (idle() waits for them). */
  background: Set<Promise<unknown>>
  track(work: Promise<unknown>): void
  fileKeysOf(shareId: string): string[]
  persist(remove?: string[]): void
  recover(): void
  unusableRowsFor(identity: OutlineIdentityLike, outlinePath: string): string[]
  recordFor(outlinePath: string): SharedTalkRecord | null
  linkOf(record: SharedTalkRecord): string
  stateOf(record: SharedTalkRecord): SharedTalkState
  remoteStatus(share: { shareId: string; workerBaseUrl: string }): Promise<'open' | 'closed' | 'unknown'>
  withQr(record: SharedTalkRecord): Promise<SharedTalkState>
  emit(key: string, previousKey?: string): void
  live(key: string, record: SharedTalkRecord): boolean
  /** The talk under this key has a row whose Stop is pressed or running. */
  stoppingKey(key: string): boolean
  cancelPending(key: string): void
}

export function createShareCore(deps: SharedTalkDeps): ShareCore {
  const now = deps.now ?? (() => new Date())
  const log = deps.log ?? (() => {})

  // The registry file holds no owner token: each row gets its token from the secrets store here.
  const registryFile = openOwnerTokenRegistry('shared-talk', deps.registryPath, deps.ownerTokens)
  /** Rows in the file this module could not use when it last read them (no token, most often). */
  let heldBack = 0
  function readRegistry(): RegistryFile {
    const registry: RegistryFile = { version: 2, shares: {} }
    heldBack = 0
    for (const value of Object.values(registryFile.read())) {
      const row = value as Partial<SharedTalkRecord>
      // A pre-identity row (keyed by file name) is re-keyed by the identity of its outline path.
      if (row && typeof row.outlinePath === 'string' && (!row.key || !row.realPath)) {
        try {
          const identity = deps.identityOf(row.outlinePath)
          row.key = identity.key
          row.realPath = identity.realPath
          row.workerSlug = row.workerSlug || row.slug
        } catch { /* outline gone: dropped below */ }
      }
      if (validRecord(row)) registry.shares[row.key] = row
      else {
        heldBack += 1
        log('[shared-talk] ignoring an invalid share registry row')
      }
    }
    return registry
  }
  const registry = readRegistry()
  /** The file's keys for the rows of one share (a row from an earlier version is keyed by file name). */
  function fileKeysOf(shareId: string): string[] {
    return Object.entries(registryFile.read()).flatMap(([fileKey, raw]) => ((raw as { shareId?: unknown } | null)?.shareId === shareId ? [fileKey] : []))
  }
  /**
   * Write the rows held here. Rows in the file that are not held here stay exactly as they are;
   * `remove` names the file's rows to take out (a stopped share, a re-keyed one).
   */
  function persist(remove: string[] = []): void {
    // A share closed on the service whose row could not be removed (finding 7) is never written
    // back (its token would be stored again): its row is removed by name on every write, and once
    // a write works it leaves memory too.
    const closed = Object.values(registry.shares).filter((record) => record.closedRemotely)
    const rows = closed.length ? Object.fromEntries(Object.entries(registry.shares).filter(([, record]) => !record.closedRemotely)) : registry.shares
    registryFile.write(rows, { remove: [...remove, ...closed.flatMap((record) => fileKeysOf(record.shareId))] })
    for (const record of closed) {
      delete registry.shares[record.key]
      emit(record.key)
    }
  }
  /**
   * Rows held back at start because secure storage could not be read are shares that still work.
   * Once it can be read they are taken up again, here, before anything looks a share up.
   */
  function recover(): void {
    if (heldBack === 0 || !deps.ownerTokens.readable()) return
    const held = new Set(Object.values(registry.shares).map((record) => record.shareId))
    const back = Object.values(readRegistry().shares).filter((record) => !held.has(record.shareId) && !registry.shares[record.key])
    heldBack = 0 // the store was readable: whatever is still unusable will not become usable by asking again
    for (const record of back) {
      registry.shares[record.key] = record
      emit(record.key)
    }
  }
  /** The file's rows for this talk that are not held here: unusable now, and never written over unasked. */
  function unusableRowsFor(identity: OutlineIdentityLike, outlinePath: string): string[] {
    const held = new Set(Object.values(registry.shares).map((record) => record.shareId))
    return Object.entries(registryFile.read()).flatMap(([fileKey, raw]) => {
      const row = (raw ?? {}) as Partial<SharedTalkRecord>
      if (typeof row.shareId === 'string' && held.has(row.shareId)) return []
      const sameTalk = fileKey === identity.key || row.key === identity.key || row.realPath === identity.realPath || row.outlinePath === outlinePath
      return sameTalk ? [fileKey] : []
    })
  }

  const lastError = new Map<string, string | null>()
  const chains = new Map<string, Promise<void>>()
  const queued = new Set<string>()
  const running = new Set<string>()
  const pendingSave = new Map<string, string>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const stopping = new Set<string>()
  const inFlight = new Map<string, AbortController>()
  const attempts = new Map<string, Attempt>()
  const qrCache = new Map<string, string>()
  const creating = new Set<Promise<unknown>>()
  const background = new Set<Promise<unknown>>()
  function track(work: Promise<unknown>): void {
    const settled = work.catch(() => {})
    background.add(settled)
    void settled.finally(() => background.delete(settled))
  }

  function recordFor(outlinePath: string): SharedTalkRecord | null {
    recover()
    const identity = deps.identityOf(outlinePath)
    const direct = registry.shares[identity.key]
    if (direct) return refreshPath(direct, outlinePath, identity)
    // Same file, new identity key (the file was replaced, not written in place): re-key it.
    const moved = Object.values(registry.shares).find((record) => record.realPath === identity.realPath)
    if (!moved) return null
    const oldKey = moved.key
    delete registry.shares[oldKey]
    moved.key = identity.key
    registry.shares[identity.key] = moved
    refreshPath(moved, outlinePath, identity, false)
    persist([oldKey])
    // Windows hold shares by key: one re-key event (never "gone" then "back", which would close the
    // rail and the sheet).
    emit(identity.key, oldKey)
    return moved
  }
  /** A share found by identity follows its talk: a moved or renamed talk folder keeps pushing (and
   *  mirroring feedback) at the path it is opened from now, never the old one. A stored path that
   *  is only another spelling of the same file (/var vs /private/var) is kept: windows match their
   *  talk rows on it. */
  function refreshPath(record: SharedTalkRecord, outlinePath: string, identity: OutlineIdentityLike, announce = true): SharedTalkRecord {
    if (record.outlinePath === outlinePath && record.realPath === identity.realPath) return record
    let stale = true
    try { stale = deps.identityOf(record.outlinePath).realPath !== identity.realPath } catch { /* gone: stale */ }
    if (!stale && record.realPath === identity.realPath) return record
    if (stale) record.outlinePath = outlinePath
    record.realPath = identity.realPath
    if (announce) {
      persist()
      emit(record.key)
    }
    return record
  }
  function linkOf(record: SharedTalkRecord): string {
    return sharedTalkLink(record.workerBaseUrl, record.shareId, deps.linkBase())
  }
  function stateOf(record: SharedTalkRecord): SharedTalkState {
    const url = linkOf(record)
    const key = record.key
    return {
      key,
      slug: record.slug,
      outlinePath: record.outlinePath,
      realPath: record.realPath,
      shareId: record.shareId,
      url,
      localOnly: isLocalOrigin(record.workerBaseUrl),
      revision: record.revision,
      liveUpdates: record.liveUpdates,
      proposals: record.proposals,
      createdAt: record.createdAt,
      lastPushedAt: record.lastPushedAt,
      pushing: queued.has(key) || running.has(key) || timers.has(key),
      lastError: lastError.get(key) ?? null,
      qrSvg: qrCache.get(url) ?? '',
      ended: record.ended ?? null,
    }
  }
  /**
   * Whether a share is open on the service (round 2, findings 5 and 6), asked on its public
   * `talk.json` route, which carries no credential: 200 open, 410/404 closed, anything else unknown.
   */
  async function remoteStatus(share: { shareId: string; workerBaseUrl: string }): Promise<'open' | 'closed' | 'unknown'> {
    try {
      const response = await deps.fetch(`${share.workerBaseUrl}/shares/${share.shareId}/talk.json`, { method: 'GET', signal: AbortSignal.timeout(15_000) })
      if (response.ok) return 'open'
      return response.status === 410 || response.status === 404 ? 'closed' : 'unknown'
    } catch { return 'unknown' }
  }
  async function withQr(record: SharedTalkRecord): Promise<SharedTalkState> {
    const url = linkOf(record)
    if (!qrCache.has(url)) {
      try { qrCache.set(url, await deps.qrSvg(url)) } catch { qrCache.set(url, '') }
    }
    return stateOf(record)
  }
  function emit(key: string, previousKey?: string): void {
    const record = registry.shares[key]
    try {
      if (previousKey) deps.onChange?.(key, record ? stateOf(record) : null, previousKey)
      else deps.onChange?.(key, record ? stateOf(record) : null)
    } catch { /* a closing window */ }
  }
  const live = (key: string, record: SharedTalkRecord): boolean => registry.shares[key] === record && !stopping.has(record.shareId) && !record.ended
  const stoppingKey = (key: string): boolean => { const record = registry.shares[key]; return !!record && stopping.has(record.shareId) }
  function cancelPending(key: string): void {
    const timer = timers.get(key)
    if (timer) { clearTimeout(timer); timers.delete(key) }
    pendingSave.delete(key)
  }

  return {
    deps, now, log, debounceMs: deps.saveDebounceMs ?? 1500,
    registryFile, registry,
    lastError, chains, queued, running, pendingSave, timers, stopping, inFlight, attempts, qrCache, creating, background,
    track, fileKeysOf, persist, recover, unusableRowsFor, recordFor, linkOf, stateOf, remoteStatus, withQr, emit, live, stoppingKey, cancelPending,
  }
}
