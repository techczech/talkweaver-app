import { createOwnerToken, verifyOwnerToken } from './auth'
import {
  adminAuthorised,
  bearerToken,
  errorResponse,
  jsonResponse,
  readBoundedBytes,
  readJsonBody,
  registryShareUrl,
  registryStub,
  validTalkSlug,
  type Env,
  type SocketAttachment,
} from './http'
import {
  SHARED_TALK_LIMITS,
  parseItemStatusPatch,
  parseSharedItemPost,
  parseSharedTalkPush,
  type SharedItem,
  type SharedSlide,
  type SharedTalkAudienceMessage,
  type SharedTalkOwnerMessage,
} from './protocol'
import { injectSharedTalkRuntime, sharedTalkPageConfig, sharedTalkUnavailablePage, splitOnCodePoints } from './shared-talk-page'
import {
  SharedTalkError,
  closeSharedTalk,
  createSharedTalk,
  nextAlarmAt,
  parseSince,
  postItem,
  purgeDueAt,
  pushTalk,
  replayMessages,
  setItemStatus,
  shouldRetire,
  socketRoleReceives,
  talkJson,
  type SharedItemStore,
  type SharedTalkSocketRole,
  type StoredSharedTalk,
} from './shared-talk-state'
import {
  MAX_ITEM_BODY_BYTES,
  MAX_PATCH_BODY_BYTES,
  MAX_PUSH_BODY_BYTES,
  SHARE_ID_LENGTH,
  canonicalShareRoutePath,
  isShareId,
  parseShareRoute,
  shareBodyLimit,
  shareRouteNeedsOwner,
  type ShareRoute,
} from './shared-talk-route'
import { generateShortId } from './short-id'

export { isShareId, parseShareRoute } from './shared-talk-route'

const HTML_CHUNK_UNITS = 512 * 1024

type ShareMessage = SharedTalkAudienceMessage | SharedTalkOwnerMessage
type ShareSocketAttachment = SocketAttachment<SharedTalkSocketRole>

function shareStub(env: Env, shareId: string): DurableObjectStub {
  return env.SHARED_TALKS.get(env.SHARED_TALKS.idFromName(shareId))
}

// The hostname that marks a request as a genuine internal bootstrap call (init/close/discard) made
// by this Worker itself via `internalPost`, never by anything forwarded from the public entry point
// (`forwardToShare` below always rewrites to the real, public origin plus a canonical `/shares/…`
// path — see SharedTalk.fetch's own guard on the three `/internal/*` branches).
const INTERNAL_HOST = 'internal'

function internalPost(env: Env, shareId: string, path: string, body?: unknown): Promise<Response> {
  return shareStub(env, shareId).fetch(new Request(`https://${INTERNAL_HOST}/internal/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }))
}

function sharedTalkErrorResponse(error: unknown): Response {
  if (!(error instanceof SharedTalkError)) throw error
  const response = errorResponse(error.code, error.message, error.status, error.details)
  if (typeof error.details.retryAfterMs === 'number') response.headers.set('retry-after', String(Math.ceil(error.details.retryAfterMs / 1_000)))
  return response
}

/**
 * `POST /shares` (admin bearer) `{talkSlug, title}` → `201 {shareId, ownerToken}`.
 * A slug's active share is stopped first, so one slug never has two live shares. The new share
 * is discarded again if it cannot be registered, so no share exists whose owner token was never
 * handed out.
 */
export async function createShare(request: Request, env: Env): Promise<Response> {
  if (!await adminAuthorised(request, env)) return errorResponse('admin_auth_required', 'Admin authentication is required.', 401)
  const body = await request.json().catch(() => ({})) as { talkSlug?: unknown; title?: unknown }
  if (!validTalkSlug(body.talkSlug)) return errorResponse('invalid_talk_slug', 'Use a lower-case talk slug containing letters, numbers, or hyphens.', 400)
  if (typeof body.title !== 'string' || body.title.length > SHARED_TALK_LIMITS.titleChars) {
    return errorResponse('invalid_title', 'Title must be a string of at most 300 characters.', 400)
  }
  const talkSlug = body.talkSlug
  const title = body.title.trim() || talkSlug

  const lookup = await registryStub(env).fetch(new Request(registryShareUrl(talkSlug)))
  if (!lookup.ok) return lookup
  const previous = await lookup.json() as { active: boolean; shareId?: string }
  if (previous.active && previous.shareId) {
    const stopped = await internalPost(env, previous.shareId, 'close')
    if (!stopped.ok && stopped.status !== 404) return errorResponse('previous_share_open', 'The talk\'s current share could not be stopped. Try again.', 503)
  }

  let shareId = ''
  for (let attempt = 0; attempt < 5 && !shareId; attempt += 1) {
    const candidate = generateShortId(undefined, SHARE_ID_LENGTH)
    if (!isShareId(candidate)) continue // a reserved word (worker/share-id.ts) — try another
    const init = await internalPost(env, candidate, 'init', createSharedTalk({ shareId: candidate, talkSlug, title, createdAt: Date.now() }))
    if (init.ok) shareId = candidate
    else if (init.status !== 409) return init
  }
  if (!shareId) return errorResponse('share_id_exhausted', 'Could not allocate a share id. Try again.', 503)

  const registration = await registryStub(env).fetch(new Request(registryShareUrl(talkSlug, shareId), { method: 'POST' }))
    .catch(() => null)
  if (!registration?.ok) {
    await internalPost(env, shareId, 'discard').catch(() => null)
    return errorResponse('registration_failed', 'The share could not be registered. Try again.', 503)
  }

  const ownerToken = await createOwnerToken({ role: 'owner', shareId, iat: Date.now() }, env.SESSION_SIGNING_SECRET)
  return jsonResponse({ shareId, ownerToken }, 201)
}

/**
 * Route a parsed shared-talk request to its object. Two guards run here, in the stateless entry
 * Worker, before any body is read: the owner token on push and patch (401 unread), and the
 * route's byte cap (413 as soon as it is passed, whether or not Content-Length is sent). Routes
 * that take no body are forwarded without one. Cancelling a body inside the object would reset it
 * and drop its sockets, so an oversize or unauthenticated upload never reaches the object.
 */
export async function forwardToShare(request: Request, env: Env, route: ShareRoute): Promise<Response> {
  const stub = shareStub(env, route.shareId)
  // Always the canonical `/shares/<id>/…` path, whichever of the two accepted forms the request
  // actually arrived on (see canonicalShareRoutePath) — this is what keeps a forwarded request's
  // pathname from ever being able to read as one of the object's own `/internal/*` bootstrap
  // routes, whatever the entry Worker's own route grammar accepts (security review, ticket 07).
  const canonicalUrl = new URL(request.url)
  canonicalUrl.pathname = canonicalShareRoutePath(route)
  const canonicalHref = canonicalUrl.toString()
  if (request.headers.get('upgrade') === 'websocket') return stub.fetch(new Request(canonicalHref, request))
  if (shareRouteNeedsOwner(route, request.method)
    && !await verifyOwnerToken(bearerToken(request), env.SESSION_SIGNING_SECRET, route.shareId)) {
    return errorResponse('owner_auth_required', 'Owner authentication is required.', 401)
  }
  const headers = new Headers(request.headers)
  const limit = shareBodyLimit(route, request.method)
  if (limit === null || !request.body) {
    headers.delete('content-length')
    headers.delete('transfer-encoding')
    return stub.fetch(new Request(canonicalHref, { method: request.method, headers }))
  }
  const bytes = await readBoundedBytes(request, limit)
  if (!bytes) return errorResponse('body_too_large', 'The request body is too large.', 413)
  headers.set('content-length', String(bytes.byteLength))
  return stub.fetch(new Request(canonicalHref, { method: request.method, headers, body: bytes as Uint8Array<ArrayBuffer> }))
}

function carriesCredentials(request: Request, url: URL): boolean {
  return request.headers.has('authorization') || url.searchParams.has('token')
}

/** The object's items table, read on demand; nothing but the metadata is held in memory. */
class SqlItemStore implements SharedItemStore {
  constructor(private readonly sql: SqlStorage) {}

  get(itemId: string): SharedItem | null {
    const row = [...this.sql.exec<{ value: string }>('SELECT value FROM items WHERE item_id = ?', itemId)][0]
    return row ? JSON.parse(row.value) as SharedItem : null
  }

  put(item: SharedItem): void {
    this.sql.exec(
      'INSERT INTO items (item_id, seq, status_seq, value) VALUES (?, ?, ?, ?) ON CONFLICT(item_id) DO UPDATE SET status_seq = excluded.status_seq, value = excluded.value',
      item.itemId, item.seq, item.statusSeq, JSON.stringify(item),
    )
  }

  createdAfter(since: number, limit: number): SharedItem[] {
    return this.rows('SELECT value FROM items WHERE seq > ? ORDER BY seq LIMIT ?', since, limit)
  }

  statusChangedAfter(since: number, limit: number): SharedItem[] {
    return this.rows('SELECT value FROM items WHERE status_seq > seq AND status_seq > ? ORDER BY status_seq LIMIT ?', since, limit)
  }

  private rows(query: string, ...bindings: unknown[]): SharedItem[] {
    return [...this.sql.exec<{ value: string }>(query, ...bindings)].map((row) => JSON.parse(row.value) as SharedItem)
  }
}

export class SharedTalk {
  private readonly ctx: DurableObjectState
  private readonly env: Env
  private readonly items: SqlItemStore
  private share: StoredSharedTalk | null = null
  /** Id of a share that was stopped or retired and then purged: it still answers "stopped". */
  private tombstoneShareId: string | null = null

  constructor(state: DurableObjectState, env: Env) {
    this.ctx = state
    this.env = env
    const sql = state.storage.sql
    sql.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    sql.exec('CREATE TABLE IF NOT EXISTS slides (position INTEGER PRIMARY KEY, value TEXT NOT NULL)')
    sql.exec('CREATE TABLE IF NOT EXISTS html_chunks (position INTEGER PRIMARY KEY, chunk TEXT NOT NULL)')
    sql.exec('CREATE TABLE IF NOT EXISTS items (item_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, status_seq INTEGER NOT NULL, value TEXT NOT NULL)')
    sql.exec('CREATE INDEX IF NOT EXISTS items_seq ON items (seq)')
    sql.exec('CREATE INDEX IF NOT EXISTS items_status_seq ON items (status_seq)')
    this.items = new SqlItemStore(sql)
    state.blockConcurrencyWhile(async () => {
      const row = [...sql.exec<{ value: string }>('SELECT value FROM kv WHERE key = ?', 'share')][0]
      this.share = row ? JSON.parse(row.value) as StoredSharedTalk : null
      const tombstone = [...sql.exec<{ value: string }>('SELECT value FROM kv WHERE key = ?', 'tombstone')][0]
      this.tombstoneShareId = tombstone?.value ?? null
    })
  }

  // ── storage ───────────────────────────────────────────────────────────────────────────────

  private saveMeta(): void {
    if (!this.share) return
    this.ctx.storage.sql.exec(
      'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      'share',
      JSON.stringify(this.share),
    )
  }

  private saveTalk(slides: SharedSlide[], html: string): void {
    const sql = this.ctx.storage.sql
    sql.exec('DELETE FROM slides')
    slides.forEach((slide, position) => sql.exec('INSERT INTO slides (position, value) VALUES (?, ?)', position, JSON.stringify(slide)))
    sql.exec('DELETE FROM html_chunks')
    splitOnCodePoints(html, HTML_CHUNK_UNITS).forEach((chunk, position) => sql.exec('INSERT INTO html_chunks (position, chunk) VALUES (?, ?)', position, chunk))
  }

  private readSlides(): SharedSlide[] {
    return [...this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM slides ORDER BY position')].map((row) => JSON.parse(row.value) as SharedSlide)
  }

  private readHtml(): string {
    return [...this.ctx.storage.sql.exec<{ chunk: string }>('SELECT chunk FROM html_chunks ORDER BY position')].map((row) => row.chunk).join('')
  }

  /** Delete the shared content: HTML, slides and items. The metadata stays until the registry is clean. */
  private purgeContent(): void {
    const sql = this.ctx.storage.sql
    sql.exec('DELETE FROM html_chunks')
    sql.exec('DELETE FROM slides')
    sql.exec('DELETE FROM items')
    if (this.share) this.share.purged = true
  }

  /** Delete everything. A closed share leaves a tombstone (its id only) so its link keeps saying "stopped". */
  private deleteEverything(): void {
    const closedShareId = this.share?.status === 'closed' ? this.share.shareId : null
    this.purgeContent()
    const sql = this.ctx.storage.sql
    sql.exec('DELETE FROM kv')
    if (closedShareId) sql.exec('INSERT INTO kv (key, value) VALUES (?, ?)', 'tombstone', closedShareId)
    this.tombstoneShareId = closedShareId
    this.share = null
  }

  /** After any lifecycle step: delete the share once nothing is left to do, else arm the alarm. */
  private async settle(now: number): Promise<void> {
    if (!this.share) return
    const next = nextAlarmAt(this.share, now)
    if (next === null) {
      this.deleteEverything()
      await this.ctx.storage.deleteAlarm()
    } else {
      await this.ctx.storage.setAlarm(next)
    }
  }

  // ── sockets ───────────────────────────────────────────────────────────────────────────────

  private acceptSocket(role: SharedTalkSocketRole, since: number, closeAfterReplay = false): Response {
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    server.serializeAttachment({ role, connectionId: crypto.randomUUID() } satisfies ShareSocketAttachment)
    this.ctx.acceptWebSocket(server)
    if (this.share) {
      for (const message of replayMessages(this.share, this.items, role, since)) this.send(server, message)
      if (closeAfterReplay && this.share.closedReason) {
        this.send(server, { type: 'share.closed', reason: this.share.closedReason })
        try { server.close(1000, 'Sharing stopped') } catch { /* already disconnected */ }
      }
    }
    return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: WebSocket })
  }

  private send(socket: HibernatingWebSocket, message: ShareMessage): void {
    try { socket.send(JSON.stringify(message)) } catch { /* the runtime removes disconnected sockets */ }
  }

  private broadcast(message: ShareMessage): void {
    for (const socket of this.ctx.getWebSockets()) {
      const role = socket.deserializeAttachment<ShareSocketAttachment>()?.role
      if (role && socketRoleReceives(role, message)) this.send(socket, message)
    }
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────────────────────

  /** Remove the registry entry. Never throws: a failure is retried from the alarm. */
  private async unregister(): Promise<boolean> {
    if (!this.share) return true
    try {
      const response = await registryStub(this.env).fetch(new Request(registryShareUrl(this.share.talkSlug, this.share.shareId), { method: 'DELETE' }))
      return response.ok
    } catch {
      return false
    }
  }

  /**
   * Stop sharing or retire. The closed state (registry entry still to remove) is saved and the
   * retry alarm armed BEFORE the registry call, so an eviction mid-await leaves a closed share the
   * alarm finishes, never an open share with its registry entry gone. Stop sharing drops the HTML
   * at once and keeps slides and items for the retention window, so the owner can still mirror
   * them; retirement wipes everything.
   */
  private async close(reason: 'stopped' | 'retired'): Promise<void> {
    const share = this.share
    if (!share || share.status !== 'open') return
    const now = Date.now()
    const message = closeSharedTalk(share, reason, now)
    share.unregistered = false
    this.ctx.storage.sql.exec('DELETE FROM html_chunks')
    if (reason === 'retired') this.purgeContent()
    this.saveMeta()
    await this.settle(now)
    share.unregistered = await this.unregister()
    this.saveMeta()
    for (const socket of this.ctx.getWebSockets()) {
      this.send(socket, message)
      try { socket.close(1000, 'Sharing stopped') } catch { /* already disconnected */ }
    }
    await this.settle(now)
  }

  private ownerToken(request: Request, allowQueryToken: boolean): string | null {
    return bearerToken(request) ?? (allowQueryToken ? new URL(request.url).searchParams.get('token') : null)
  }

  private async ownerAuthorised(request: Request, allowQueryToken: boolean): Promise<boolean> {
    if (!this.share) return false
    return Boolean(await verifyOwnerToken(this.ownerToken(request, allowQueryToken), this.env.SESSION_SIGNING_SECRET, this.share.shareId))
  }

  // ── routes ────────────────────────────────────────────────────────────────────────────────

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    // The three bootstrap routes below take no credential of their own — they are safe only
    // because nothing but this Worker's own `internalPost` (shared-talk.ts) can ever reach them,
    // over its dedicated internal-only host. A request forwarded from the public entry Worker
    // (forwardToShare) always carries the real public origin and a canonical `/shares/…` path, so
    // it can never match here even if its original pathname or a share id happened to spell one of
    // these words (security review, ticket 07 — a bare `/internal/close` used to reach this).
    const isInternalCall = url.hostname === INTERNAL_HOST
    if (isInternalCall && url.pathname === '/internal/init' && request.method === 'POST') return this.init(request)
    if (isInternalCall && url.pathname === '/internal/close' && request.method === 'POST') {
      if (!this.share) return errorResponse('not_found', 'Shared talk not found.', 404)
      await this.close('stopped')
      return jsonResponse({ ok: true })
    }
    if (isInternalCall && url.pathname === '/internal/discard' && request.method === 'POST') {
      this.deleteEverything()
      await this.ctx.storage.deleteAlarm()
      return jsonResponse({ ok: true })
    }

    const route = parseShareRoute(url.pathname)
    if (route && !this.share && route.shareId === this.tombstoneShareId) return stoppedResponse(route)
    if (!this.share || !route || route.shareId !== this.share.shareId) return errorResponse('not_found', 'Shared talk not found.', 404)
    const { action, itemId } = route
    const isSocket = request.headers.get('upgrade') === 'websocket'

    if (shouldRetire(this.share, Date.now())) await this.close('retired')
    const share = this.share
    if (!share || share.status !== 'open') {
      // In the retention window after Stop sharing the owner can still reconnect to collect items.
      if (share && !share.purged && action === 'owner' && isSocket && await this.ownerAuthorised(request, true)) {
        return this.acceptSocket('owner', parseSince(url.searchParams.get('since')), true)
      }
      return stoppedResponse(route)
    }

    // Audience routes: public. They never accept a credential, so an owner token or the admin
    // secret can never be put to work by (or leak through) the colleague's page.
    const audienceRoute = (action === 'page' && request.method === 'GET')
      || (action === 'talk.json' && request.method === 'GET')
      || (action === 'items' && request.method === 'POST')
      || (action === 'audience' && isSocket)
    if (audienceRoute && carriesCredentials(request, url)) {
      return errorResponse('credentials_not_allowed', 'This route is public and takes no credentials.', 400)
    }

    try {
      if (action === 'page' && request.method === 'GET') return this.page(share)
      if (action === 'talk.json' && request.method === 'GET') return noStore(jsonResponse(talkJson(share, this.readSlides())))
      if (action === 'items' && request.method === 'POST') return await this.postItem(request, share)
      if (action === 'audience' && isSocket) return this.acceptSocket('audience', parseSince(url.searchParams.get('since')))

      // Owner routes: the owner token only. The admin bearer is not an owner credential.
      if (action === 'owner' && isSocket) {
        return await this.ownerAuthorised(request, true)
          ? this.acceptSocket('owner', parseSince(url.searchParams.get('since')))
          : errorResponse('owner_auth_required', 'Owner authentication is required.', 401)
      }
      if (action === 'talk' && request.method === 'PUT') {
        if (!await this.ownerAuthorised(request, false)) return errorResponse('owner_auth_required', 'Owner authentication is required.', 401)
        return await this.pushTalk(request, share)
      }
      if (action === 'item' && itemId && request.method === 'PATCH') {
        if (!await this.ownerAuthorised(request, false)) return errorResponse('owner_auth_required', 'Owner authentication is required.', 401)
        return await this.patchItem(request, share, itemId)
      }
      if (action === 'close' && request.method === 'POST') {
        // Addition to the spec: the admin bearer may also stop a share (the app lost its token).
        if (!await this.ownerAuthorised(request, false) && !await adminAuthorised(request, this.env)) {
          return errorResponse('owner_auth_required', 'Owner authentication is required.', 401)
        }
        await this.close('stopped')
        return jsonResponse({ ok: true })
      }
    } catch (error) {
      return sharedTalkErrorResponse(error)
    }
    return errorResponse('not_found', 'Shared talk route not found.', 404)
  }

  private async init(request: Request): Promise<Response> {
    if (this.share || this.tombstoneShareId) return errorResponse('already_exists', 'Shared talk already exists.', 409)
    const share = await request.json().catch(() => null) as StoredSharedTalk | null
    if (!share?.shareId || !isShareId(share.shareId) || !share.talkSlug || typeof share.title !== 'string' || share.status !== 'open') {
      return errorResponse('invalid_share', 'Shared talk details are invalid.', 400)
    }
    this.share = share
    this.saveMeta()
    await this.settle(Date.now())
    return jsonResponse({ ok: true })
  }

  private page(share: StoredSharedTalk): Response {
    if (share.revision < 1) return htmlResponse(sharedTalkUnavailablePage('not_pushed'), 404)
    return htmlResponse(injectSharedTalkRuntime(this.readHtml(), sharedTalkPageConfig(share.shareId, share.revision, share.seq)), 200)
  }

  private async pushTalk(request: Request, share: StoredSharedTalk): Promise<Response> {
    const body = await readJsonBody(request, MAX_PUSH_BODY_BYTES)
    if ('tooLarge' in body) return errorResponse('push_too_large', 'The push is too large.', 413)
    if ('invalid' in body) return errorResponse('invalid_push', 'Push body must be JSON.', 400)
    const parsed = parseSharedTalkPush(body.value)
    if ('error' in parsed) return errorResponse(parsed.error.code, parsed.error.message, 400)
    const message = pushTalk(share, parsed.value.revision, Date.now())
    this.saveTalk(parsed.value.slides, parsed.value.html)
    this.saveMeta()
    await this.settle(Date.now())
    this.broadcast(message)
    return jsonResponse({ revision: message.revision, seq: message.seq })
  }

  private async postItem(request: Request, share: StoredSharedTalk): Promise<Response> {
    const body = await readJsonBody(request, MAX_ITEM_BODY_BYTES)
    if ('tooLarge' in body) return errorResponse('item_too_large', 'The item is too large.', 413)
    if ('invalid' in body) return errorResponse('invalid_item', 'Item body must be JSON.', 400)
    const parsed = parseSharedItemPost(body.value)
    if ('error' in parsed) return errorResponse(parsed.error.code, parsed.error.message, 400)
    const result = postItem(share, this.items, parsed.value, Date.now())
    if (result.created) {
      this.saveMeta()
      await this.settle(Date.now())
    }
    if (result.message) this.broadcast(result.message)
    return jsonResponse({ item: result.item }, result.created ? 201 : 200)
  }

  private async patchItem(request: Request, share: StoredSharedTalk, itemId: string): Promise<Response> {
    const body = await readJsonBody(request, MAX_PATCH_BODY_BYTES)
    if ('tooLarge' in body || 'invalid' in body) return errorResponse('invalid_status', 'Status must be new, accepted, dismissed or done.', 400)
    const parsed = parseItemStatusPatch(body.value)
    if ('error' in parsed) return errorResponse(parsed.error.code, parsed.error.message, 400)
    const result = setItemStatus(share, this.items, itemId, parsed.value, Date.now())
    if (result.message) {
      this.saveMeta()
      await this.settle(Date.now())
      this.broadcast(result.message)
    }
    return jsonResponse({ item: result.item })
  }

  // ── hibernation handlers ──────────────────────────────────────────────────────────────────

  async webSocketMessage(): Promise<void> {
    // Both sockets are receive-only; items and status changes travel over HTTP.
  }

  async webSocketClose(socket: HibernatingWebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    try { socket.close(code, reason || (wasClean ? 'Closed' : 'Connection lost')) } catch { /* already closed */ }
  }

  async webSocketError(socket: HibernatingWebSocket): Promise<void> {
    try { socket.close(1011, 'WebSocket error') } catch { /* already disconnected */ }
  }

  async alarm(): Promise<void> {
    const share = this.share
    if (!share) return
    const now = Date.now()
    if (share.status === 'open') {
      if (shouldRetire(share, now)) await this.close('retired')
      else await this.settle(now)
      return
    }
    if (!share.unregistered) share.unregistered = await this.unregister()
    if (!share.purged && now >= purgeDueAt(share)) this.purgeContent()
    this.saveMeta()
    await this.settle(now)
  }
}

/** A stopped, retired or purged share: the page route gets the notice page, API routes JSON. */
export function stoppedResponse(route: ShareRoute): Response {
  return route.action === 'page'
    ? htmlResponse(sharedTalkUnavailablePage('closed'), 410)
    : errorResponse('share_closed', 'Sharing has stopped for this talk.', 410)
}

function htmlResponse(html: string, status: number): Response {
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    },
  })
}

function noStore(response: Response): Response {
  response.headers.set('cache-control', 'no-store')
  return response
}
