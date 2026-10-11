// A Run's read-only share link, main-process side (feedback-boards ticket 06, R6 and R7).
//
// One link per Run. The app keeps it in a registry file in app data; its owner token is kept in the
// secrets store (owner-tokens.ts), joined to the row when the registry is read, and never reaches a
// window. Share creates the link on the live Worker (admin secret, once) and
// pushes what the link shows; every later change on the Run that the link carries (a refresh that
// pulled late cards, a card put back) pushes again. Stop sharing revokes it on the Worker with the
// link's own owner token; the registry row goes either way, so a stopped link is never shown again.
//
// Invariants: the push is built by runSharePayload (no hidden card, no name); a push only ever goes
// to the Worker origin the link was created on; a link past its expiry is treated as gone. A new
// link's owner token is stored and read back before anything is pushed to it; when it cannot be
// stored the link is closed again with the token still in hand. Every request that carries an owner
// token goes through ownerFetch: a failure to send is a fixed sentence, never the transport's error.
// A row this module cannot use just now (secure storage locked) is left in the registry untouched.
// Share, refresh and stop for one Run run one at a time (a per-Run queue): a second share waits and
// gets the first one's link, and a stop waits for a publish under way. Apart from the queue, a new
// link replaces only the exact row this saw, a write after a publish goes ahead only while the
// link's own row is still there, and a link made here whose row is not registered is closed again.
import { isShareId } from '../shared/share-id.ts'
import { createKeyedQueue, openOwnerTokenRegistry, ownerFetch, validOwnerToken, type OwnerTokens } from './owner-tokens.ts'
import {
  DEFAULT_RUN_SHARE_INCLUDE, runResultsLink, runShareExpiresAt, runSharePayload,
  type RunLike, type RunShareInclude, type RunShareLifetime,
} from '../shared/run-results-share.ts'

export interface RunResultsShareRow {
  key: string
  shareId: string
  ownerToken: string
  workerBaseUrl: string
  include: RunShareInclude
  lifetime: RunShareLifetime
  expiresAt: number | null
  createdAt: number
  pushedAt: number
  /** The talk's title as History shows it (a Run file may carry only its slug). */
  title?: string
}

/** What a window may see of a link: never the owner token. */
export interface RunResultsShareState {
  url: string
  include: RunShareInclude
  lifetime: RunShareLifetime
  expiresAt: number | null
  pushedAt: number
}

export interface RunResultsShareDeps {
  /** {userData}/run-results-share-registry.json */
  registryPath: string
  /** Where the links' owner tokens are kept (the secrets store). */
  ownerTokens: OwnerTokens
  /** The live Worker and its admin credential. Used to CREATE links only. */
  endpoint(): Promise<{ baseUrl: string; adminSecret: string }>
  /** The share-link domain (Settings), or empty for the Worker's own address. */
  linkBase(): string | null | undefined
  fetch: typeof fetch
  now?(): number
}

interface RegistryFile { version: 1; shares: Record<string, RunResultsShareRow> }

export function runShareKey(talkSlug: string, runId: string): string {
  return `${talkSlug}/${runId}`
}

function validOrigin(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value
  } catch { return false }
}

function validRow(value: unknown): value is RunResultsShareRow {
  const row = value as RunResultsShareRow
  return Boolean(row) && typeof row.key === 'string' && isShareId(row.shareId) && validOwnerToken(row.ownerToken) && validOrigin(row.workerBaseUrl)
    && (row.expiresAt === null || Number.isFinite(row.expiresAt)) && (row.lifetime === '7' || row.lifetime === '30' || row.lifetime === 'forever')
    && Boolean(row.include) && typeof row.include.board === 'boolean' && typeof row.include.polls === 'boolean'
}

export const RESULTS_LINK_NOT_REACHED = 'The sharing service could not be reached, so the link was not updated. Try again.'
export const RESULTS_LINK_LOCKED = 'This Run already has a link, but its key cannot be read from this computer\'s secure storage just now. Nothing was changed. Try again.'
export const RESULTS_LINK_STOPPED = 'The link was stopped while it was being updated.'
export const RESULTS_LINK_NOT_KEPT = 'The link could not be saved on this computer, so it was closed again and nothing was shared.'
export const RESULTS_LINK_NOT_KEPT_OPEN = 'The link could not be saved on this computer and could not be closed again. It shows nothing and cannot be reached from this app.'

async function errorText(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { error?: { message?: string } }
    return body?.error?.message || fallback
  } catch { return fallback }
}

export function createRunResultsShares(deps: RunResultsShareDeps) {
  const now = deps.now ?? Date.now
  // The registry file holds no owner token: each row gets its token from the secrets store here.
  const registryFile = openOwnerTokenRegistry('run-results', deps.registryPath, deps.ownerTokens)

  function read(): RegistryFile {
    const registry: RegistryFile = { version: 1, shares: {} }
    for (const [key, row] of Object.entries(registryFile.read())) if (validRow(row) && row.key === key) registry.shares[key] = row
    return registry
  }

  /** One operation at a time per Run: share, refresh and stop never interleave. */
  const queue = createKeyedQueue()

  /**
   * Add or change this one row; every other row in the file stays as it is. `seen` is the id of the
   * row this operation saw under the key (null: none): the write happens only if that is still what
   * the file holds. A new link names the row it replaces; a write after a publish names its own.
   */
  function save(row: RunResultsShareRow, seen: string | null): void {
    registryFile.write({ [row.key]: row }, { expect: { [row.key]: seen }, ...(seen !== null && seen !== row.shareId ? { remove: [row.key] } : {}) })
  }

  function live(row: RunResultsShareRow | undefined): row is RunResultsShareRow {
    return Boolean(row) && (row!.expiresAt === null || row!.expiresAt > now())
  }

  function state(row: RunResultsShareRow): RunResultsShareState {
    return { url: runResultsLink(row.workerBaseUrl, row.shareId, deps.linkBase()), include: { ...row.include }, lifetime: row.lifetime,
      expiresAt: row.expiresAt, pushedAt: row.pushedAt }
  }

  /** Close a link on the service with its own token. True when the service confirms it is closed or gone. */
  async function closeRemote(row: RunResultsShareRow): Promise<boolean> {
    try {
      const response = await ownerFetch(deps.fetch, `${row.workerBaseUrl}/results/${row.shareId}/close`, row.ownerToken, {
        method: 'POST', signal: AbortSignal.timeout(10_000),
      })
      return response.ok || response.status === 410 || response.status === 404
    } catch { return false }
  }

  async function push(row: RunResultsShareRow, run: RunLike): Promise<RunResultsShareRow> {
    const at = now()
    const expiresAt = row.expiresAt === null ? null : row.expiresAt
    const body = runSharePayload(row.title ? { ...run, talkTitle: row.title } : run, row.include, expiresAt, at)
    let response: Response
    try {
      response = await ownerFetch(deps.fetch, `${row.workerBaseUrl}/results/${row.shareId}/content`, row.ownerToken, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
      })
    } catch {
      throw new Error(RESULTS_LINK_NOT_REACHED)
    }
    if (!response.ok) throw new Error(await errorText(response, `The link could not be updated (HTTP ${response.status}).`))
    return { ...row, pushedAt: at }
  }

  return {
    /** The Run's link, or null when it has none (or it has expired). */
    status(talkSlug: string, runId: string): RunResultsShareState | null {
      const row = read().shares[runShareKey(talkSlug, runId)]
      return live(row) ? state(row) : null
    },

    /**
     * Share (or re-share with new choices): creates the Run's link on first use, then pushes what it
     * shows for the chosen lifetime. The same link is kept while it lives.
     */
    share(talkSlug: string, runId: string, run: RunLike, options: { include?: Partial<RunShareInclude>; lifetime: RunShareLifetime; title?: string }): Promise<RunResultsShareState> {
      return queue.run(runShareKey(talkSlug, runId), async () => {
      const title = typeof options.title === 'string' && options.title.trim() ? options.title.trim().slice(0, 300) : undefined
      // Asked before the rows are read, so a row read without its token is known to be for good.
      const storeReadable = deps.ownerTokens.readable()
      const registry = read()
      const key = runShareKey(talkSlug, runId)
      const include: RunShareInclude = { ...DEFAULT_RUN_SHARE_INCLUDE, ...options.include, prework: false }
      if (!include.board && !include.polls) throw new Error('Choose the board or the poll results to share.')
      let row = registry.shares[key]
      let made: RunResultsShareRow | null = null
      if (!live(row)) {
        // The Run has a row this cannot use. While secure storage cannot be read that row is a
        // working link whose token is out of reach: it is left alone and no second link is made.
        const seen = registryFile.idAt(key)
        if (seen !== null && !row && !storeReadable) throw new Error(RESULTS_LINK_LOCKED)
        // A link whose owner token could not be kept is never made: it could not be stopped afterwards.
        registryFile.assertCanStore()
        const endpoint = await deps.endpoint()
        const response = await deps.fetch(`${endpoint.baseUrl}/results`, {
          method: 'POST', headers: { authorization: `Bearer ${endpoint.adminSecret}`, 'content-type': 'application/json' },
          body: '{}', signal: AbortSignal.timeout(15_000),
        })
        if (!response.ok) throw new Error(await errorText(response, `The link could not be created (HTTP ${response.status}).`))
        const created = await response.json() as { shareId?: unknown; ownerToken?: unknown }
        const origin = new URL(endpoint.baseUrl).origin
        const candidate = { key, shareId: created.shareId, ownerToken: created.ownerToken, workerBaseUrl: origin, include, lifetime: options.lifetime,
          expiresAt: runShareExpiresAt(options.lifetime, now()), createdAt: now(), pushedAt: 0, ...(title ? { title } : {}) }
        if (!validRow(candidate)) throw new Error('The sharing service returned an incomplete link.')
        // Stored (and read back) before anything is published. If that fails the link is closed
        // while its token is still here: nothing is left on the service that cannot be stopped.
        try {
          save(candidate, seen) // the expired or dead row this saw is replaced; any other row is not
        } catch {
          throw new Error(await closeRemote(candidate) ? RESULTS_LINK_NOT_KEPT : RESULTS_LINK_NOT_KEPT_OPEN)
        }
        row = made = candidate
      } else {
        const lifetimeChanged = row.lifetime !== options.lifetime
        row = { ...row, include, lifetime: options.lifetime, expiresAt: lifetimeChanged ? runShareExpiresAt(options.lifetime, now()) : row.expiresAt,
          ...(title ? { title } : {}) }
      }
      const shareId = row.shareId
      try {
        row = await push(row, run)
        save(row, shareId) // only while this link's own row is still there
      } catch (cause) {
        // A link made here whose row is no longer registered could never be stopped: close it now.
        if (made && registryFile.idAt(key) !== made.shareId) throw new Error(await closeRemote(made) ? RESULTS_LINK_NOT_KEPT : RESULTS_LINK_NOT_KEPT_OPEN)
        if (registryFile.idAt(key) !== shareId) throw new Error(RESULTS_LINK_STOPPED)
        throw cause
      }
      return state(row)
      })
    },

    /**
     * Push again after the Run changed (late cards pulled, a card put back). Never throws: a Run with
     * no live link is `{ok: true, share: null}`; a push that failed is `{ok: false, error}` (the link
     * still shows what it showed before), so the caller can say so.
     */
    refresh(talkSlug: string, runId: string, run: RunLike): Promise<{ ok: true; share: RunResultsShareState | null } | { ok: false; error: string }> {
      const key = runShareKey(talkSlug, runId)
      return queue.run(key, async () => {
        const row = read().shares[key]
        if (!live(row)) return { ok: true as const, share: null }
        try {
          const pushed = await push(row, run)
          // Stopped meanwhile (outside the queue): the row is not written back.
          if (registryFile.idAt(key) !== row.shareId) return { ok: true as const, share: null }
          save(pushed, row.shareId)
          return { ok: true as const, share: state(pushed) }
        } catch (cause) {
          return { ok: false as const, error: cause instanceof Error ? cause.message : 'The link could not be updated.' }
        }
      })
    },

    /**
     * Stop sharing: revoked on the Worker with the link's own token. The row is removed only once the
     * Worker confirms (or the link is already gone), so a link that could not be reached stays listed
     * and can be stopped again, never forgotten while it still works.
     */
    stop(talkSlug: string, runId: string): Promise<{ ok: true } | { ok: false; error: string }> {
      const key = runShareKey(talkSlug, runId)
      return queue.run(key, async () => {
      const storeReadable = deps.ownerTokens.readable()
      const row = read().shares[key]
      // A row whose token is out of reach just now is a link that still works: it is not dropped.
      if (!row && !storeReadable && registryFile.has(key)) return { ok: false, error: RESULTS_LINK_LOCKED }
      if (row && live(row)) {
        let response: Response
        try {
          response = await ownerFetch(deps.fetch, `${row.workerBaseUrl}/results/${row.shareId}/close`, row.ownerToken, {
            method: 'POST', signal: AbortSignal.timeout(10_000),
          })
        } catch {
          return { ok: false, error: 'The sharing service could not be reached, so the link still works. Try again.' }
        }
        if (!response.ok && response.status !== 410 && response.status !== 404) {
          return { ok: false, error: await errorText(response, 'The sharing service did not stop the link. Try again.') }
        }
      }
      // The one place a row is removed (and its token forgotten): this Run's row, by name, and only
      // the row this stop saw (a link made meanwhile outside the queue is not dropped unclosed).
      const seen = registryFile.idAt(key)
      if (row && seen !== row.shareId) return { ok: true as const }
      registryFile.write({}, { remove: [key], expect: { [key]: seen } })
      return { ok: true as const }
      })
    },
  }
}

export type RunResultsShares = ReturnType<typeof createRunResultsShares>
