// A Run's read-only share link (feedback-boards ticket 06): the Durable Object that holds one link's
// content, and the entry Worker's two routes into it. Modelled on the shared talk (shared-talk.ts):
// an admin-created id, an owner token of its own role, owner checks and body caps in the entry
// Worker before any body is read, a closed share that leaves a tombstone. Different from it: the
// page is read-only (no items, no sockets, no script), it expires by itself, and nothing registers
// it by talk — the app keeps one link per Run.
import { createResultsOwnerToken, verifyResultsOwnerToken } from './auth'
import { adminAuthorised, bearerToken, errorResponse, jsonResponse, readBoundedBytes, readJsonBody, type Env } from './http'
import {
  RUN_SHARE_LIMITS, parseRunSharePush, parseRunShareRoute, renderRunSharePage, runShareAlarmAt, runShareExpired,
  runShareRouteMethod, runShareUnavailablePage, type RunSharePush, type RunShareRoute, type StoredRunShare,
} from './run-share-state'
import { isShareId, SHARE_ID_LENGTH } from './share-id'
import { generateShortId } from './short-id'

export { parseRunShareRoute }

const INTERNAL_HOST = 'internal'

function runShareStub(env: Env, shareId: string): DurableObjectStub {
  return env.RUN_SHARES.get(env.RUN_SHARES.idFromName(shareId))
}

/** `POST /results` (admin bearer) → `201 {shareId, ownerToken}`. The link shows nothing until the first push. */
export async function createRunShare(request: Request, env: Env): Promise<Response> {
  if (!await adminAuthorised(request, env)) return errorResponse('admin_auth_required', 'Admin authentication is required.', 401)
  let shareId = ''
  for (let attempt = 0; attempt < 5 && !shareId; attempt += 1) {
    const candidate = generateShortId(undefined, SHARE_ID_LENGTH)
    if (!isShareId(candidate)) continue
    const init = await runShareStub(env, candidate).fetch(new Request(`https://${INTERNAL_HOST}/internal/init`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shareId: candidate, createdAt: Date.now() }),
    }))
    if (init.ok) shareId = candidate
    else if (init.status !== 409) return init
  }
  if (!shareId) return errorResponse('share_id_exhausted', 'Could not allocate a link. Try again.', 503)
  const ownerToken = await createResultsOwnerToken({ role: 'results-owner', shareId, iat: Date.now() }, env.SESSION_SIGNING_SECRET)
  return jsonResponse({ shareId, ownerToken }, 201)
}

/**
 * Route a parsed results request to its object. Each route takes one method; the push is owner-only
 * and checked here before its body is read, then cut off at its cap. The public routes refuse any
 * credential, so no token ever works on, or travels through, the read-only page.
 */
export async function forwardToRunShare(request: Request, env: Env, route: RunShareRoute): Promise<Response> {
  if (request.method !== runShareRouteMethod(route)) {
    return errorResponse('method_not_allowed', 'This link is read-only.', 405)
  }
  const url = new URL(request.url)
  const publicRoute = route.action === 'page'
  if (publicRoute && (request.headers.has('authorization') || url.searchParams.has('token'))) {
    return errorResponse('credentials_not_allowed', 'This route is public and takes no credentials.', 400)
  }
  if (route.action === 'content' && !await verifyResultsOwnerToken(bearerToken(request), env.SESSION_SIGNING_SECRET, route.shareId)) {
    return errorResponse('owner_auth_required', 'Owner authentication is required.', 401)
  }
  const target = new URL(request.url)
  target.pathname = route.action === 'page' ? `/results/${route.shareId}` : `/results/${route.shareId}/${route.action}`
  target.search = ''
  const headers = new Headers(request.headers)
  if (route.action !== 'content' && route.action !== 'close') {
    headers.delete('content-length')
    headers.delete('transfer-encoding')
    return runShareStub(env, route.shareId).fetch(new Request(target.toString(), { method: request.method, headers }))
  }
  const limit = route.action === 'content' ? RUN_SHARE_LIMITS.pushBytes : RUN_SHARE_LIMITS.closeBytes
  const bytes = request.body ? await readBoundedBytes(request, limit) : new Uint8Array(0)
  if (!bytes) return errorResponse('body_too_large', 'The request body is too large.', 413)
  headers.set('content-length', String(bytes.byteLength))
  return runShareStub(env, route.shareId).fetch(new Request(target.toString(), { method: request.method, headers, body: bytes as Uint8Array<ArrayBuffer> }))
}

function htmlResponse(html: string, status: number): Response {
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-robots-tag': 'noindex',
      // No script, no form, no frame, nothing fetched: the page is text and inline style only.
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
  })
}

export class RunShare {
  private readonly ctx: DurableObjectState
  private readonly env: Env
  private share: StoredRunShare | null = null
  /** A stopped or expired link whose content is gone: it still answers 410 with its reason. */
  private tombstone: { shareId: string; reason: 'stopped' | 'expired' } | null = null

  constructor(state: DurableObjectState, env: Env) {
    this.ctx = state
    this.env = env
    const sql = state.storage.sql
    sql.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    state.blockConcurrencyWhile(async () => {
      this.share = this.readJson<StoredRunShare>('share')
      this.tombstone = this.readJson<{ shareId: string; reason: 'stopped' | 'expired' }>('tombstone')
    })
  }

  private readJson<T>(key: string): T | null {
    const row = [...this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM kv WHERE key = ?', key)][0]
    return row ? JSON.parse(row.value) as T : null
  }

  private write(key: string, value: unknown): void {
    this.ctx.storage.sql.exec('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value))
  }

  /** Stop sharing or expiry: the content is deleted at once and only a tombstone is kept. */
  private async end(reason: 'stopped' | 'expired'): Promise<void> {
    if (!this.share) return
    const shareId = this.share.shareId
    this.ctx.storage.sql.exec('DELETE FROM kv')
    this.tombstone = { shareId, reason }
    this.write('tombstone', this.tombstone)
    this.share = null
    await this.ctx.storage.deleteAlarm()
  }

  /** Unknown id and not pushed yet: one answer for both, so a guessed id learns nothing. */
  private notFound(route: RunShareRoute): Response {
    return route.action === 'page' ? htmlResponse(runShareUnavailablePage('not_found'), 404) : errorResponse('not_found', 'Link not found.', 404)
  }

  private gone(route: RunShareRoute, reason: 'stopped' | 'expired'): Response {
    return route.action === 'page'
      ? htmlResponse(runShareUnavailablePage(reason), 410)
      : errorResponse(reason === 'expired' ? 'link_expired' : 'share_closed',
        reason === 'expired' ? 'This link has expired.' : 'Sharing has stopped for these results.', 410)
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.hostname === INTERNAL_HOST && url.pathname === '/internal/init' && request.method === 'POST') {
      if (this.share || this.tombstone) return errorResponse('already_exists', 'Link already exists.', 409)
      const body = await request.json().catch(() => null) as { shareId?: unknown; createdAt?: unknown } | null
      if (!isShareId(body?.shareId) || !Number.isFinite(body?.createdAt)) return errorResponse('invalid_share', 'Link details are invalid.', 400)
      this.share = { shareId: body!.shareId as string, createdAt: Number(body!.createdAt), status: 'open', expiresAt: null, pushedAt: null }
      this.write('share', this.share)
      return jsonResponse({ ok: true }, 201)
    }
    const route = parseRunShareRoute(url.pathname)
    if (!route) return errorResponse('not_found', 'Route not found.', 404)
    if (!this.share && this.tombstone?.shareId === route.shareId) return this.gone(route, this.tombstone.reason)
    if (!this.share || this.share.shareId !== route.shareId) return this.notFound(route)
    const now = Date.now()
    if (runShareExpired(this.share, now)) {
      await this.end('expired')
      return this.gone(route, 'expired')
    }
    const share = this.share

    if (route.action === 'page') {
      const content = this.readJson<RunSharePush>('content')
      if (!content) return this.notFound(route)
      return htmlResponse(renderRunSharePage(content), 200)
    }
    if (route.action === 'content') {
      // The entry Worker checked the owner token already; the object checks it again.
      if (!await verifyResultsOwnerToken(bearerToken(request), this.env.SESSION_SIGNING_SECRET, share.shareId)) {
        return errorResponse('owner_auth_required', 'Owner authentication is required.', 401)
      }
      const body = await readJsonBody(request, RUN_SHARE_LIMITS.pushBytes)
      if ('tooLarge' in body) return errorResponse('push_too_large', 'The push is too large.', 413)
      if ('invalid' in body) return errorResponse('invalid_push', 'The push must be JSON.', 400)
      const parsed = parseRunSharePush(body.value, now)
      if ('error' in parsed) return errorResponse(parsed.error.code, parsed.error.message, 400)
      this.write('content', parsed.value)
      share.expiresAt = parsed.value.expiresAt
      share.pushedAt = now
      this.write('share', share)
      const alarm = runShareAlarmAt(share)
      if (alarm === null) await this.ctx.storage.deleteAlarm()
      else await this.ctx.storage.setAlarm(alarm)
      return jsonResponse({ shareId: share.shareId, expiresAt: share.expiresAt, pushedAt: now })
    }
    // close: the owner token, or the admin secret (the app lost its token).
    if (!await verifyResultsOwnerToken(bearerToken(request), this.env.SESSION_SIGNING_SECRET, share.shareId)
      && !await adminAuthorised(request, this.env)) {
      return errorResponse('owner_auth_required', 'Owner authentication is required.', 401)
    }
    await this.end('stopped')
    return jsonResponse({ ok: true })
  }

  async alarm(): Promise<void> {
    if (this.share && runShareExpired(this.share, Date.now())) await this.end('expired')
    else if (this.share) {
      const alarm = runShareAlarmAt(this.share)
      if (alarm !== null) await this.ctx.storage.setAlarm(alarm)
    }
  }
}
