// Share for comments (ticket 03): the main-process shared-talk module. It owns the share registry
// (app data, beside handout-registry.json), creates and stops shares on the live Worker, and pushes
// the compiled talk — once on Share, then on every save while "Show my latest saves as I work" is on,
// or on an explicit "Update shared copy" when it is off.
//
// Invariants:
//   - A share belongs to a talk's IDENTITY (the outline writer's outlineIdentity), never its file
//     name: two talks named alike in different folders are two talks with two shares. The Worker's
//     talkSlug carries a hash of the real path for the same reason (the Worker replaces a slug's
//     previous share when a new one is created).
//   - share() runs once per talk at a time: a second call while a create is in flight gets the same
//     share, so no window ever shows a link the Worker has already replaced.
//   - Every id the Worker returns passes the Worker's own id rule (worker/share-id.ts) before it
//     touches a path or a URL; registry rows that fail it are ignored.
//   - A push never blocks or fails a save: noteSaved() returns at once, and every failure lands on
//     the share's lastError instead of a throw. Pushes for one talk run one at a time; saves that
//     arrive while one runs collapse into ONE follow-up push of the newest text.
//   - revision is always the Worker's confirmed revision + 1; a 409 re-pushes from the revision the
//     Worker reports. A 409 reporting the revision of an attempt whose reply was lost confirms that
//     attempt: its slides are kept as that revision.
//   - Each confirmed revision's slide text (and the outline text it was built from) is written
//     atomically to <talk>/feedback/<share-id>-revisions/<n>.json, so Compare (ticket 06) can show
//     a slide at an item's base revision; the Worker keeps only the current one.
//   - Stop sharing cancels queued and running pushes (nothing is pushed after it), and talks only to
//     the origin the share was created on, with the share's own owner token. No admin secret is ever
//     sent on a stop.
//   - The owner token stays in this process and the registry file (mode 0600); it is never in a
//     state object sent to a window.
import { createHash } from 'crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { parseFrontmatterPairs } from '../shared/frontmatter-editor.ts'
import { isShareId } from '../shared/share-id.ts'
import {
  isLocalOrigin, sharedTalkLink, STOPPED_LOCALLY_MESSAGE,
  type SharedTalkEnded, type SharedTalkInspection, type SharedTalkSlide, type SharedTalkState, type SharedTalkStopResult,
} from '../shared/shared-talk.ts'

export interface SharedTalkRecord {
  key: string
  slug: string
  /** The talkSlug the Worker registered this share under. */
  workerSlug: string
  outlinePath: string
  realPath: string
  shareId: string
  ownerToken: string
  workerBaseUrl: string
  revision: number
  liveUpdates: boolean
  proposals: boolean
  createdAt: string
  lastPushedAt: string | null
  lastPushHash: string | null
  /** The share ended on the Worker (stopped elsewhere, retired) or refuses this owner token
   *  (ticket 05's owner socket finds out). Nothing is pushed; Stop sharing clears the row. */
  ended?: SharedTalkEnded | null
}

interface RegistryFile { version: 2; shares: Record<string, SharedTalkRecord> }

export interface OutlineIdentityLike { key: string; realPath: string }

export interface SharedTalkDeps {
  /** {userData}/shared-talk-registry.json */
  registryPath: string
  /** The live Worker and its admin credential (ensureLiveWorker). Used to CREATE shares only. */
  endpoint(): Promise<{ baseUrl: string; adminSecret: string }>
  /** Config `sharedTalkLinkBase` (ticket 07 sets it to the drafts host); empty = Worker origin. */
  linkBase(): string | null | undefined
  /** The outline writer's identity for a path (outline-identity.ts). */
  identityOf(outlinePath: string): OutlineIdentityLike
  slugOf(outlinePath: string): string
  /** The talk's current text: the open editor's buffer flushed to disk, then read. */
  readOutline(outlinePath: string): Promise<string>
  /** The outline file as it is on disk, without flushing anything (the sheet's pre-share check). */
  peekOutline(outlinePath: string): string
  /** Compile what one push sends. Throws when the talk cannot be built (the push is skipped). */
  build(input: { outlinePath: string; content: string; slug: string; proposals: boolean }): Promise<{ title: string; html: string; slides: SharedTalkSlide[] }>
  /** Write (url) or remove (null) `share_url:` in the outline's frontmatter. */
  stampShareUrl(outlinePath: string, url: string | null): Promise<void>
  qrSvg(url: string): Promise<string>
  fetch: typeof fetch
  /** A share changed. `previousKey`: the same share under its old identity key (the outline was
   *  replaced by a new file) — ONE event, so no window sees the share go and come back. */
  onChange?(key: string, state: SharedTalkState | null, previousKey?: string): void
  /** Quiet period after a save before the push starts (collapses bursts of autosaves). */
  saveDebounceMs?: number
  now?(): Date
  log?(message: string): void
}

export interface SharedTalks {
  /** The sheet's first look: this Mac's share, or another Mac's share_url in the outline. */
  inspect(outlinePath: string): Promise<SharedTalkInspection>
  share(outlinePath: string, title?: string): Promise<SharedTalkState>
  status(outlinePath: string): Promise<SharedTalkState | null>
  list(): SharedTalkState[]
  setOptions(outlinePath: string, options: { liveUpdates?: boolean; proposals?: boolean }): Promise<SharedTalkState>
  /** Explicit "Update shared copy": push the current text whatever switch 1 says. */
  update(outlinePath: string): Promise<SharedTalkState>
  /** The save hook: called after every successful editor save. Never throws, never waits. */
  noteSaved(outlinePath: string, content: string): void
  stop(outlinePath: string): Promise<SharedTalkStopResult>
  /** Settles once no push is queued or running (tests, app quit). */
  idle(): Promise<void>
  /** MAIN-ONLY (the feedback service's owner sockets): every share with its owner token. Never
   *  sent to a window. */
  owners(): SharedTalkOwner[]
  /** The owner socket found the share ended: record it (no more pushes) and tell windows. */
  markEnded(shareId: string, reason: SharedTalkEnded): void
}

export interface SharedTalkOwner {
  key: string
  outlinePath: string
  shareId: string
  ownerToken: string
  workerBaseUrl: string
  url: string
  ended: SharedTalkEnded | null
}

export interface RevisionSnapshot {
  shareId: string
  revision: number
  pushedAt: string
  slides: SharedTalkSlide[]
  /** The outline text this revision was built from (a proposals change with switch 1 off rebuilds
   *  their page from it, so they keep the talk as they have it). */
  source: string
}

export function feedbackDirFor(outlinePath: string): string {
  return join(dirname(outlinePath), 'feedback')
}

/** Where a confirmed revision's slide text is kept (ticket 06 reads it for Compare). */
export function revisionSnapshotPath(outlinePath: string, shareId: string, revision: number): string {
  if (!isShareId(shareId)) throw new Error(`Not a share id: ${JSON.stringify(shareId)}`)
  if (!Number.isInteger(revision) || revision < 1) throw new Error(`Not a revision: ${revision}`)
  return join(feedbackDirFor(outlinePath), `${shareId}-revisions`, `${revision}.json`)
}

function writeFileAtomic(path: string, text: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`
  writeFileSync(temp, text, mode === undefined ? 'utf8' : { encoding: 'utf8', mode })
  renameSync(temp, path)
}

/** A confirmed revision as kept on disk: null when it was never kept; THROWS when the file is there
 *  but unreadable or not a revision file (a corrupt file is an error, never "missing"). */
export function readRevisionSnapshot(outlinePath: string, shareId: string, revision: number): RevisionSnapshot | null {
  const path = revisionSnapshotPath(outlinePath, shareId, revision)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error(`Revision ${revision} of this share could not be read: ${(error as Error).message}`)
  }
  let parsed: Partial<RevisionSnapshot>
  try { parsed = JSON.parse(raw) } catch { throw new Error(`Revision ${revision} of this share is corrupt (${path}).`) }
  const slidesOk = Array.isArray(parsed.slides) && parsed.slides.every((slide) =>
    slide && typeof slide.slideId === 'string' && typeof slide.title === 'string' && typeof slide.text === 'string')
  if (!parsed || parsed.shareId !== shareId || parsed.revision !== revision || !slidesOk) {
    throw new Error(`Revision ${revision} of this share is corrupt (${path}).`)
  }
  return {
    shareId, revision, pushedAt: String(parsed.pushedAt ?? ''), slides: parsed.slides as SharedTalkSlide[],
    source: typeof parsed.source === 'string' ? parsed.source : '',
  }
}

/** The slide text at a revision (Compare's base): null when never kept; throws when corrupt. */
export function readRevisionSlides(outlinePath: string, shareId: string, revision: number): SharedTalkSlide[] | null {
  return readRevisionSnapshot(outlinePath, shareId, revision)?.slides ?? null
}

/** The talkSlug the Worker registers a share under: the file-name slug made Worker-safe, plus a
 *  hash of the outline's real path, so same-named talks never replace each other's share. */
export function workerTalkSlug(slug: string, realPath: string): string {
  const base = String(slug).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'talk'
  return `${base}-${createHash('sha256').update(realPath).digest('hex').slice(0, 10)}`
}

class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

class Cancelled extends Error {
  constructor() { super('cancelled: sharing stopped') }
}

async function readJson(response: Response): Promise<unknown> {
  try { return await response.json() } catch { return null }
}

function errorMessage(body: unknown, fallback: string): string {
  const error = (body as { error?: { message?: string; code?: string } } | null)?.error
  return error?.message || error?.code || fallback
}

function describe(error: unknown): string {
  if (error instanceof HttpError) return error.message
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return 'the sharing service did not answer in time.'
    return error.message
  }
  return String(error)
}

function validOwnerToken(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 16 && value.length <= 4096 && /^[\x21-\x7e]+$/.test(value)
}

function validOrigin(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value
  } catch { return false }
}

function validRecord(value: unknown): value is SharedTalkRecord {
  const r = value as SharedTalkRecord
  return Boolean(r) && typeof r.key === 'string' && !!r.key && typeof r.outlinePath === 'string' && typeof r.realPath === 'string'
    && isShareId(r.shareId) && validOwnerToken(r.ownerToken) && validOrigin(r.workerBaseUrl)
    && Number.isInteger(r.revision) && r.revision >= 0 && typeof r.liveUpdates === 'boolean' && typeof r.proposals === 'boolean'
}

interface Attempt { revision: number; slides: SharedTalkSlide[]; source: string; hash: string }

type PushMode = { kind: 'save' } | { kind: 'current' } | { kind: 'confirmed' }

export function createSharedTalks(deps: SharedTalkDeps): SharedTalks {
  const now = deps.now ?? (() => new Date())
  const log = deps.log ?? (() => {})
  const debounceMs = deps.saveDebounceMs ?? 1500

  // ── registry ──────────────────────────────────────────────────────────────────────────────────
  function readRegistry(): RegistryFile {
    const registry: RegistryFile = { version: 2, shares: {} }
    let parsed: { shares?: Record<string, unknown> } | null = null
    try { parsed = JSON.parse(readFileSync(deps.registryPath, 'utf8')) } catch { return registry }
    for (const value of Object.values(parsed?.shares ?? {})) {
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
      else log('[shared-talk] ignoring an invalid share registry row')
    }
    return registry
  }
  let registry = readRegistry()
  function persist(): void {
    writeFileAtomic(deps.registryPath, JSON.stringify(registry, null, 2), 0o600)
    try { chmodSync(deps.registryPath, 0o600) } catch { /* best effort */ }
  }

  // ── in-memory push state (all keyed by identity key) ──────────────────────────────────────────
  const lastError = new Map<string, string | null>()
  const chains = new Map<string, Promise<void>>()
  const queued = new Set<string>()
  const running = new Set<string>()
  const pendingSave = new Map<string, string>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const creating = new Map<string, Promise<SharedTalkState>>()
  const stopping = new Set<string>()
  const inFlight = new Map<string, AbortController>()
  /** The last push attempted per talk whose reply never confirmed it (lost-reply recovery). */
  const attempts = new Map<string, Attempt>()
  const qrCache = new Map<string, string>()

  function recordFor(outlinePath: string): SharedTalkRecord | null {
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
    persist()
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
  const live = (key: string, record: SharedTalkRecord): boolean => registry.shares[key] === record && !stopping.has(key) && !record.ended

  // ── the push ──────────────────────────────────────────────────────────────────────────────────
  async function putTalk(record: SharedTalkRecord, revision: number, html: string, slides: SharedTalkSlide[], signal: AbortSignal): Promise<{ ok: true; revision: number } | { ok: false; conflictAt: number }> {
    const response = await deps.fetch(`${record.workerBaseUrl}/shares/${record.shareId}/talk`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${record.ownerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ revision, html, slides }),
      signal: AbortSignal.any([AbortSignal.timeout(60_000), signal]),
    })
    const body = await readJson(response)
    if (response.ok) {
      const confirmed = Number((body as { revision?: unknown } | null)?.revision)
      return { ok: true, revision: Number.isInteger(confirmed) && confirmed > 0 ? confirmed : revision }
    }
    const current = Number((body as { revision?: unknown } | null)?.revision)
    if (response.status === 409 && Number.isInteger(current) && current >= 0) return { ok: false, conflictAt: current }
    if (response.status === 410) throw new HttpError(410, 'this share has been stopped or retired. Share again for a new link.')
    if (response.status === 401 || response.status === 403) throw new HttpError(response.status, 'the sharing service no longer accepts this talk’s owner credential.')
    throw new HttpError(response.status, errorMessage(body, `the sharing service answered ${response.status}.`))
  }

  function keepRevision(record: SharedTalkRecord, attempt: Attempt, revision: number, pushedAt: string): void {
    try {
      const snapshot: RevisionSnapshot = { shareId: record.shareId, revision, pushedAt, slides: attempt.slides, source: attempt.source }
      writeFileAtomic(revisionSnapshotPath(record.outlinePath, record.shareId, revision), JSON.stringify(snapshot, null, 2))
    } catch (error) {
      log(`[shared-talk] revision ${revision} slide text not kept: ${describe(error)}`)
    }
  }

  function confirm(record: SharedTalkRecord, attempt: Attempt, revision: number): void {
    const pushedAt = now().toISOString()
    record.revision = revision
    record.lastPushedAt = pushedAt
    record.lastPushHash = attempt.hash
    persist()
    keepRevision(record, attempt, revision, pushedAt)
  }

  async function pushOnce(key: string, mode: PushMode, saved: string | null): Promise<void> {
    const record = registry.shares[key]
    if (!record || !live(key, record)) return
    const controller = new AbortController()
    inFlight.set(key, controller)
    try {
      let source: string
      let payload: { html: string; slides: SharedTalkSlide[] }
      if (mode.kind === 'confirmed') {
        // Switch 1 off and switch 2 changed: their page's permissions change, the talk they see does
        // not — rebuilt from the last CONFIRMED revision as kept on disk, never the outline now.
        const snapshot = record.revision > 0 ? readRevisionSnapshot(record.outlinePath, record.shareId, record.revision) : null
        if (!snapshot || !snapshot.source) throw new Error(`revision ${record.revision} is not kept on this Mac; use Update shared copy.`)
        source = snapshot.source
        const built = await deps.build({ outlinePath: record.outlinePath, content: source, slug: record.slug, proposals: record.proposals })
        payload = { html: built.html, slides: snapshot.slides }
      } else {
        source = saved ?? await deps.readOutline(record.outlinePath)
        if (!live(key, record)) throw new Cancelled()
        payload = await deps.build({ outlinePath: record.outlinePath, content: source, slug: record.slug, proposals: record.proposals })
      }
      if (!live(key, record)) throw new Cancelled()
      const hash = createHash('sha256').update(payload.html).update('\0').update(JSON.stringify(payload.slides)).digest('hex')
      if (mode.kind === 'save' && hash === record.lastPushHash && record.revision > 0) return
      const prior = attempts.get(key)
      let revision = record.revision + 1
      for (let round = 0; round < 3; round += 1) {
        const attempt: Attempt = { revision, slides: payload.slides, source, hash }
        attempts.set(key, attempt)
        const result = await putTalk(record, revision, payload.html, payload.slides, controller.signal)
        if (!live(key, record)) throw new Cancelled()
        if (result.ok) {
          confirm(record, attempt, result.revision)
          attempts.delete(key)
          lastError.set(key, null)
          return
        }
        log(`[shared-talk] ${record.slug}: revision ${revision} refused; the Worker is at ${result.conflictAt}`)
        // Lost reply: an earlier attempt landed but its answer never arrived. The Worker's revision
        // IS that attempt, so keep its slides as that revision's file.
        if (prior && prior.revision === result.conflictAt && result.conflictAt > record.revision) {
          confirm(record, prior, prior.revision)
          if (prior.hash === hash) { attempts.delete(key); lastError.set(key, null); return }
        } else {
          record.revision = result.conflictAt
        }
        revision = result.conflictAt + 1
      }
      throw new Error('the shared copy kept moving on the sharing service; try Update shared copy.')
    } finally {
      if (inFlight.get(key) === controller) inFlight.delete(key)
    }
  }

  /** Queue a push behind any running one. While a save push is queued (not started) later saves
   *  ride on it, reading the newest saved text when it starts. */
  function enqueue(key: string, mode: PushMode): Promise<void> {
    if (mode.kind === 'save' && queued.has(key)) return chains.get(key) ?? Promise.resolve()
    queued.add(key)
    emit(key)
    const previous = chains.get(key) ?? Promise.resolve()
    const next = previous.then(async () => {
      queued.delete(key)
      if (stopping.has(key) || !registry.shares[key]) return
      running.add(key)
      const saved = mode.kind === 'save' ? pendingSave.get(key) ?? null : null
      if (mode.kind === 'save') pendingSave.delete(key)
      try {
        await pushOnce(key, mode, saved)
      } catch (error) {
        if (error instanceof Cancelled || stopping.has(key)) return
        lastError.set(key, describe(error))
        log(`[shared-talk] push failed: ${describe(error)}`)
        if (mode.kind !== 'save') throw error
      } finally {
        running.delete(key)
        emit(key)
      }
    })
    const settled = next.catch(() => {})
    chains.set(key, settled)
    void settled.then(() => { if (chains.get(key) === settled && !queued.has(key) && !running.has(key)) chains.delete(key) })
    return next
  }

  async function createRemote(identity: OutlineIdentityLike, slug: string, title: string, outlinePath: string): Promise<SharedTalkRecord> {
    const endpoint = await deps.endpoint()
    let base: string
    try { base = new URL(endpoint.baseUrl).origin } catch { throw new Error('Could not create the share: the sharing service address is not valid.') }
    const workerSlug = workerTalkSlug(slug, identity.realPath)
    const response = await deps.fetch(`${base}/shares`, {
      method: 'POST',
      headers: { authorization: `Bearer ${endpoint.adminSecret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ talkSlug: workerSlug, title }),
      signal: AbortSignal.timeout(15_000),
    })
    const body = await readJson(response) as { shareId?: unknown; ownerToken?: unknown } | null
    if (!response.ok) throw new HttpError(response.status, `Could not create the share: ${errorMessage(body, `the sharing service answered ${response.status}.`)}`)
    if (!isShareId(body?.shareId)) throw new Error('Could not create the share: the sharing service returned an id this app does not accept.')
    if (!validOwnerToken(body?.ownerToken)) throw new Error('Could not create the share: the sharing service returned an unusable owner credential.')
    return {
      key: identity.key, slug, workerSlug, outlinePath, realPath: identity.realPath,
      shareId: body.shareId, ownerToken: body.ownerToken, workerBaseUrl: base,
      revision: 0, liveUpdates: true, proposals: true,
      createdAt: now().toISOString(), lastPushedAt: null, lastPushHash: null,
    }
  }

  function cancelPending(key: string): void {
    const timer = timers.get(key)
    if (timer) { clearTimeout(timer); timers.delete(key) }
    pendingSave.delete(key)
  }

  async function doShare(outlinePath: string, title?: string): Promise<SharedTalkState> {
    const identity = deps.identityOf(outlinePath)
    const slug = deps.slugOf(outlinePath)
    let record = recordFor(outlinePath)
    if (record) {
      if (record.revision === 0) await enqueue(record.key, { kind: 'current' }).catch(() => {})
      return withQr(record)
    }
    record = await createRemote(identity, slug, title || slug, outlinePath)
    registry.shares[record.key] = record
    persist()
    const state = await withQr(record)
    emit(record.key)
    try {
      await deps.stampShareUrl(outlinePath, state.url)
    } catch (error) {
      log(`[shared-talk] share_url not written: ${describe(error)}`)
    }
    // The first push: a failure is shown on the sheet (lastError), the share itself stands.
    await enqueue(record.key, { kind: 'current' }).catch(() => {})
    return withQr(record)
  }

  return {
    async inspect(outlinePath) {
      const record = recordFor(outlinePath)
      if (record) return { share: await withQr(record), foreignShareUrl: null }
      let foreign: string | null = null
      try {
        foreign = parseFrontmatterPairs(deps.peekOutline(outlinePath)).find((pair) => pair.key === 'share_url')?.value || null
      } catch { /* unreadable: nothing to warn about */ }
      return { share: null, foreignShareUrl: foreign }
    },

    share(outlinePath, title) {
      const key = deps.identityOf(outlinePath).key
      const inflight = creating.get(key)
      if (inflight) return inflight
      const started = doShare(outlinePath, title).finally(() => { if (creating.get(key) === started) creating.delete(key) })
      creating.set(key, started)
      return started
    },

    async status(outlinePath) {
      const record = recordFor(outlinePath)
      return record ? withQr(record) : null
    },

    list() {
      return Object.values(registry.shares).map(stateOf)
    },

    async setOptions(outlinePath, options) {
      const record = recordFor(outlinePath)
      if (!record) throw new Error('This talk is not shared.')
      const proposalsChanged = typeof options.proposals === 'boolean' && options.proposals !== record.proposals
      if (typeof options.liveUpdates === 'boolean') record.liveUpdates = options.liveUpdates
      if (typeof options.proposals === 'boolean') record.proposals = options.proposals
      if (!record.liveUpdates) cancelPending(record.key)
      persist()
      emit(record.key)
      // Their page's permissions are baked into the pushed page, so a proposals change is pushed at
      // once — from the text they already have when switch 1 is off.
      if (proposalsChanged && record.revision > 0) {
        await enqueue(record.key, record.liveUpdates ? { kind: 'current' } : { kind: 'confirmed' }).catch(() => {})
      }
      return withQr(record)
    },

    async update(outlinePath) {
      const record = recordFor(outlinePath)
      if (!record) throw new Error('This talk is not shared.')
      cancelPending(record.key)
      await enqueue(record.key, { kind: 'current' }).catch(() => {})
      return withQr(record)
    },

    noteSaved(outlinePath, content) {
      try {
        const record = recordFor(outlinePath)
        if (!record || !record.liveUpdates || record.ended || stopping.has(record.key)) return
        const key = record.key
        pendingSave.set(key, content)
        const existing = timers.get(key)
        if (existing) clearTimeout(existing)
        const timer = setTimeout(() => {
          timers.delete(key)
          if (!registry.shares[key] || stopping.has(key)) return
          void enqueue(key, { kind: 'save' })
        }, debounceMs)
        timers.set(key, timer)
        if (!existing) emit(key)
      } catch (error) {
        log(`[shared-talk] save hook failed: ${describe(error)}`)
      }
    },

    async stop(outlinePath) {
      const record = recordFor(outlinePath)
      if (!record) return { serverClosed: true, message: null }
      const key = record.key
      // Nothing is pushed from here on: pending saves dropped, queued pushes skip, the running
      // one is aborted.
      stopping.add(key)
      cancelPending(key)
      inFlight.get(key)?.abort()
      try {
        await (chains.get(key) ?? Promise.resolve())
        let response: Response
        try {
          // The share's own origin and owner token only — never an admin secret, never elsewhere.
          response = await deps.fetch(`${record.workerBaseUrl}/shares/${record.shareId}/close`, {
            method: 'POST', headers: { authorization: `Bearer ${record.ownerToken}` }, signal: AbortSignal.timeout(15_000),
          })
        } catch (error) {
          lastError.set(key, describe(error))
          throw new Error(`Could not stop sharing: ${describe(error)}`)
        }
        let result: SharedTalkStopResult = { serverClosed: true, message: null }
        if (response.status === 401 || response.status === 403) {
          result = { serverClosed: false, message: STOPPED_LOCALLY_MESSAGE }
          log(`[shared-talk] owner token refused on close (${response.status}); stopped locally`)
        } else if (!response.ok && response.status !== 410 && response.status !== 404) {
          // 410/404: already closed or retired on the Worker — stopping here is the right outcome.
          const message = errorMessage(await readJson(response), `the sharing service answered ${response.status}.`)
          lastError.set(key, message)
          throw new Error(`Could not stop sharing: ${message}`)
        }
        delete registry.shares[key]
        persist()
        lastError.delete(key)
        attempts.delete(key)
        try {
          await deps.stampShareUrl(record.outlinePath, null)
        } catch (error) {
          log(`[shared-talk] share_url not removed: ${describe(error)}`)
        }
        // The feedback folder (items, revision slide text) is his record and stays.
        return result
      } finally {
        stopping.delete(key)
        emit(key)
      }
    },

    owners() {
      return Object.values(registry.shares).map((record) => ({
        key: record.key, outlinePath: record.outlinePath, shareId: record.shareId,
        ownerToken: record.ownerToken, workerBaseUrl: record.workerBaseUrl, url: linkOf(record),
        ended: record.ended ?? null,
      }))
    },

    markEnded(shareId, reason) {
      const record = Object.values(registry.shares).find((row) => row.shareId === shareId)
      if (!record || record.ended) return
      record.ended = reason
      cancelPending(record.key)
      inFlight.get(record.key)?.abort()
      persist()
      emit(record.key)
    },

    async idle() {
      for (;;) {
        const pending = [...chains.values(), ...creating.values()]
        if (!pending.length && !timers.size) return
        if (!pending.length) { await new Promise((resolve) => setTimeout(resolve, Math.min(debounceMs, 50))); continue }
        await Promise.all(pending.map((p) => Promise.resolve(p).catch(() => {})))
      }
    },
  }
}
