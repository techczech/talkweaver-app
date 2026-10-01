// A Run's read-only share link, main-process side (feedback-boards ticket 06, R6 and R7).
//
// One link per Run. The app keeps it in a registry file in app data (mode 0600) with its owner token,
// which never reaches a window. Share creates the link on the live Worker (admin secret, once) and
// pushes what the link shows; every later change on the Run that the link carries (a refresh that
// pulled late cards, a card put back) pushes again. Stop sharing revokes it on the Worker with the
// link's own owner token; the registry row goes either way, so a stopped link is never shown again.
//
// Invariants: the push is built by runSharePayload (no hidden card, no name); a push only ever goes
// to the Worker origin the link was created on; a link past its expiry is treated as gone.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { isShareId } from '../shared/share-id.ts'
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
  return Boolean(row) && typeof row.key === 'string' && isShareId(row.shareId) && typeof row.ownerToken === 'string'
    && row.ownerToken.length >= 16 && row.ownerToken.length <= 4096 && validOrigin(row.workerBaseUrl)
    && (row.expiresAt === null || Number.isFinite(row.expiresAt)) && (row.lifetime === '7' || row.lifetime === '30' || row.lifetime === 'forever')
    && Boolean(row.include) && typeof row.include.board === 'boolean' && typeof row.include.polls === 'boolean'
}

async function errorText(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { error?: { message?: string } }
    return body?.error?.message || fallback
  } catch { return fallback }
}

export function createRunResultsShares(deps: RunResultsShareDeps) {
  const now = deps.now ?? Date.now

  function read(): RegistryFile {
    const registry: RegistryFile = { version: 1, shares: {} }
    try {
      const parsed = JSON.parse(readFileSync(deps.registryPath, 'utf8')) as { shares?: Record<string, unknown> }
      for (const [key, row] of Object.entries(parsed?.shares ?? {})) if (validRow(row) && row.key === key) registry.shares[key] = row
    } catch { /* no registry yet */ }
    return registry
  }

  function write(registry: RegistryFile): void {
    mkdirSync(dirname(deps.registryPath), { recursive: true })
    const temp = `${deps.registryPath}.${process.pid}.${now().toString(36)}.tmp`
    writeFileSync(temp, `${JSON.stringify(registry, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, deps.registryPath)
    try { chmodSync(deps.registryPath, 0o600) } catch { /* best effort */ }
  }

  function live(row: RunResultsShareRow | undefined): row is RunResultsShareRow {
    return Boolean(row) && (row!.expiresAt === null || row!.expiresAt > now())
  }

  function state(row: RunResultsShareRow): RunResultsShareState {
    return { url: runResultsLink(row.workerBaseUrl, row.shareId, deps.linkBase()), include: { ...row.include }, lifetime: row.lifetime,
      expiresAt: row.expiresAt, pushedAt: row.pushedAt }
  }

  async function push(row: RunResultsShareRow, run: RunLike): Promise<RunResultsShareRow> {
    const at = now()
    const expiresAt = row.expiresAt === null ? null : row.expiresAt
    const body = runSharePayload(row.title ? { ...run, talkTitle: row.title } : run, row.include, expiresAt, at)
    const response = await deps.fetch(`${row.workerBaseUrl}/results/${row.shareId}/content`, {
      method: 'PUT', headers: { authorization: `Bearer ${row.ownerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    })
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
    async share(talkSlug: string, runId: string, run: RunLike, options: { include?: Partial<RunShareInclude>; lifetime: RunShareLifetime; title?: string }): Promise<RunResultsShareState> {
      const title = typeof options.title === 'string' && options.title.trim() ? options.title.trim().slice(0, 300) : undefined
      const registry = read()
      const key = runShareKey(talkSlug, runId)
      const include: RunShareInclude = { ...DEFAULT_RUN_SHARE_INCLUDE, ...options.include, prework: false }
      if (!include.board && !include.polls) throw new Error('Choose the board or the poll results to share.')
      let row = registry.shares[key]
      if (!live(row)) {
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
        row = candidate
      } else {
        const lifetimeChanged = row.lifetime !== options.lifetime
        row = { ...row, include, lifetime: options.lifetime, expiresAt: lifetimeChanged ? runShareExpiresAt(options.lifetime, now()) : row.expiresAt,
          ...(title ? { title } : {}) }
      }
      row = await push(row, run)
      const next = read()
      next.shares[key] = row
      write(next)
      return state(row)
    },

    /**
     * Push again after the Run changed (late cards pulled, a card put back). Never throws: a Run with
     * no live link is `{ok: true, share: null}`; a push that failed is `{ok: false, error}` (the link
     * still shows what it showed before), so the caller can say so.
     */
    async refresh(talkSlug: string, runId: string, run: RunLike): Promise<{ ok: true; share: RunResultsShareState | null } | { ok: false; error: string }> {
      const key = runShareKey(talkSlug, runId)
      const row = read().shares[key]
      if (!live(row)) return { ok: true, share: null }
      try {
        const pushed = await push(row, run)
        const next = read()
        next.shares[key] = pushed
        write(next)
        return { ok: true, share: state(pushed) }
      } catch (cause) {
        return { ok: false, error: cause instanceof Error ? cause.message : 'The link could not be updated.' }
      }
    },

    /**
     * Stop sharing: revoked on the Worker with the link's own token. The row is removed only once the
     * Worker confirms (or the link is already gone), so a link that could not be reached stays listed
     * and can be stopped again, never forgotten while it still works.
     */
    async stop(talkSlug: string, runId: string): Promise<{ ok: true } | { ok: false; error: string }> {
      const key = runShareKey(talkSlug, runId)
      const row = read().shares[key]
      if (row && live(row)) {
        let response: Response
        try {
          response = await deps.fetch(`${row.workerBaseUrl}/results/${row.shareId}/close`, {
            method: 'POST', headers: { authorization: `Bearer ${row.ownerToken}` }, signal: AbortSignal.timeout(10_000),
          })
        } catch {
          return { ok: false, error: 'The sharing service could not be reached, so the link still works. Try again.' }
        }
        if (!response.ok && response.status !== 410 && response.status !== 404) {
          return { ok: false, error: await errorText(response, 'The sharing service did not stop the link. Try again.') }
        }
      }
      const registry = read()
      delete registry.shares[key]
      write(registry)
      return { ok: true }
    },
  }
}

export type RunResultsShares = ReturnType<typeof createRunResultsShares>
