import { createSignedToken, hashSecret, verifySignedToken } from './auth'
import { parseAudienceMessage, parsePresenterMessage } from './protocol'
import {
  LIVE_PROTOCOL_VERSION, LIVE_WORKER_BUILD, parseRecoveryClientMessage, validRecoveryId,
  type RecoveryClientMessage, type SessionSnapshot,
} from './recovery-protocol'
import { acceptSubmission, applyPollOperation, recoveryState } from './recovery-state'
import { lookupSession, registerSession, removeSession, type RegistryEntry } from './registry-state'
import {
  closePoll,
  closeSession,
  createSession,
  currentPollStateMessages,
  currentStateMessage,
  hidePollResponse,
  normaliseStoredSession,
  openPoll,
  pollStateMessage,
  publishSlideState,
  revealPoll,
  socketRoleReceivesSlideState,
  voteInPoll,
  type StoredLiveSession,
  type StoredPoll,
} from './session-state'
import { generateShortId } from './short-id'

const SESSION_TTL_MS = 12 * 60 * 60 * 1_000
const REGISTRY_NAME = 'talkweaver-session-registry'

interface Env {
  LIVE_SESSIONS: DurableObjectNamespace
  SESSION_REGISTRY: DurableObjectNamespace
  ADMIN_SECRET: string
  SESSION_SIGNING_SECRET: string
}

interface CreateSessionBody {
  talkSlug?: string
}

interface SocketAttachment {
  role: 'presenter' | 'audience'
  connectionId: string
  protocol?: number
  participantId?: string
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function errorResponse(code: string, message: string, status: number): Response {
  return jsonResponse({ error: { code, message } }, status)
}

function cors(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set('access-control-allow-origin', '*')
  headers.set('access-control-allow-headers', 'authorization, content-type')
  headers.set('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS')
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

function liveSessionStub(env: Env, sessionId: string): DurableObjectStub {
  return env.LIVE_SESSIONS.get(env.LIVE_SESSIONS.idFromName(sessionId))
}

function registryStub(env: Env): DurableObjectStub {
  return env.SESSION_REGISTRY.get(env.SESSION_REGISTRY.idFromName(REGISTRY_NAME))
}

function bearerToken(request: Request): string | null {
  return request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null
}

async function adminAuthorised(request: Request, env: Env): Promise<boolean> {
  const bearer = bearerToken(request)
  return Boolean(bearer) && await hashSecret(bearer!) === await hashSecret(env.ADMIN_SECRET)
}

function validTalkSlug(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/.test(value)
}

async function createLiveSession(request: Request, env: Env): Promise<Response> {
  if (!await adminAuthorised(request, env)) return errorResponse('admin_auth_required', 'Admin authentication is required.', 401)
  const body = await request.json().catch(() => ({})) as CreateSessionBody
  if (!validTalkSlug(body.talkSlug)) return errorResponse('invalid_talk_slug', 'Use a lower-case talk slug containing letters, numbers, or hyphens.', 400)

  const now = Date.now()
  const sessionId = crypto.randomUUID()
  const shortId = generateShortId()
  const expiresAt = now + SESSION_TTL_MS
  const session = createSession({ sessionId, shortId, talkSlug: body.talkSlug, createdAt: now, expiresAt })
  const initResponse = await liveSessionStub(env, sessionId).fetch(new Request('https://internal/internal/init', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(session),
  }))
  if (!initResponse.ok) return initResponse

  const registration = await registryStub(env).fetch(new Request(`https://internal/internal/session/${encodeURIComponent(body.talkSlug)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ talkSlug: body.talkSlug, sessionId, expiresAt }),
  }))
  if (!registration.ok) return registration

  const presenterToken = await createSignedToken({ role: 'presenter', sessionId, exp: expiresAt }, env.SESSION_SIGNING_SECRET)
  return jsonResponse({ sessionId, presenterToken, shortId, expiresAt }, 201)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }))
    const url = new URL(request.url)
    let response: Response

    if (url.pathname === '/capabilities' && request.method === 'GET') {
      response = jsonResponse({ protocol: LIVE_PROTOCOL_VERSION, build: LIVE_WORKER_BUILD })
    } else if (url.pathname === '/sessions' && request.method === 'POST') {
      response = await createLiveSession(request, env)
    } else {
      const discovery = url.pathname.match(/^\/session\/([^/]+)$/)
      const sessionRoute = url.pathname.match(/^\/sessions\/([^/]+)\/(presenter|audience|close|status|recovery)$/)
      if (discovery && request.method === 'GET') {
        response = await registryStub(env).fetch(request)
      } else if (sessionRoute && (request.method === 'GET' || request.method === 'POST' || request.headers.get('upgrade') === 'websocket')) {
        response = await liveSessionStub(env, sessionRoute[1]).fetch(request)
      } else {
        response = errorResponse('not_found', 'Route not found.', 404)
      }
    }

    return request.headers.get('upgrade') === 'websocket' ? response : cors(response)
  },
}

export class SessionRegistry {
  private readonly ctx: DurableObjectState

  constructor(state: DurableObjectState) {
    this.ctx = state
    state.storage.sql.exec('CREATE TABLE IF NOT EXISTS active_sessions (talk_slug TEXT PRIMARY KEY, session_id TEXT NOT NULL, expires_at INTEGER NOT NULL)')
  }

  private entries(): Map<string, RegistryEntry> {
    const rows = this.ctx.storage.sql.exec<{ talk_slug: string; session_id: string; expires_at: number }>('SELECT talk_slug, session_id, expires_at FROM active_sessions')
    return new Map([...rows].map((row) => [row.talk_slug, { talkSlug: row.talk_slug, sessionId: row.session_id, expiresAt: row.expires_at }]))
  }

  private saveEntries(entries: Map<string, RegistryEntry>): void {
    this.ctx.storage.sql.exec('DELETE FROM active_sessions')
    for (const entry of entries.values()) {
      this.ctx.storage.sql.exec(
        'INSERT INTO active_sessions (talk_slug, session_id, expires_at) VALUES (?, ?, ?)',
        entry.talkSlug,
        entry.sessionId,
        entry.expiresAt,
      )
    }
  }

  private async scheduleNextAlarm(entries: Map<string, RegistryEntry>): Promise<void> {
    const next = Math.min(...[...entries.values()].map((entry) => entry.expiresAt))
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(next)
    else await this.ctx.storage.deleteAlarm()
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const internal = url.pathname.match(/^\/internal\/session\/([^/]+)$/)
    const discovery = url.pathname.match(/^\/session\/([^/]+)$/)
    const entries = this.entries()

    if (internal && request.method === 'POST') {
      const entry = await request.json().catch(() => null) as RegistryEntry | null
      if (!entry || entry.talkSlug !== decodeURIComponent(internal[1]) || !entry.sessionId || !entry.expiresAt) {
        return errorResponse('invalid_registration', 'Session registration is invalid.', 400)
      }
      registerSession(entries, entry)
      this.saveEntries(entries)
      await this.scheduleNextAlarm(entries)
      return jsonResponse({ ok: true })
    }

    if (internal && request.method === 'DELETE') {
      const talkSlug = decodeURIComponent(internal[1])
      removeSession(entries, talkSlug, url.searchParams.get('sessionId') ?? '')
      this.saveEntries(entries)
      await this.scheduleNextAlarm(entries)
      return jsonResponse({ ok: true })
    }

    if (discovery && request.method === 'GET') {
      const result = lookupSession(entries, decodeURIComponent(discovery[1]), Date.now())
      this.saveEntries(entries)
      await this.scheduleNextAlarm(entries)
      return jsonResponse(result)
    }

    return errorResponse('not_found', 'Registry route not found.', 404)
  }

  async alarm(): Promise<void> {
    const entries = this.entries()
    const now = Date.now()
    for (const entry of [...entries.values()]) lookupSession(entries, entry.talkSlug, now)
    this.saveEntries(entries)
    await this.scheduleNextAlarm(entries)
  }
}

export class LiveSession {
  private readonly ctx: DurableObjectState
  private readonly env: Env
  private session: StoredLiveSession | null = null

  constructor(state: DurableObjectState, env: Env) {
    this.ctx = state
    this.env = env
    state.storage.sql.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    state.blockConcurrencyWhile(async () => {
      this.session = this.readSession()
    })
  }

  private readSession(): StoredLiveSession | null {
    const row = [...this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM kv WHERE key = ?', 'session')][0]
    return row ? normaliseStoredSession(JSON.parse(row.value) as StoredLiveSession) : null
  }

  private save(): void {
    if (!this.session) return
    this.ctx.storage.sql.exec(
      'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      'session',
      JSON.stringify(this.session),
    )
  }

  private presenterToken(request: Request): string | null {
    return bearerToken(request) ?? new URL(request.url).searchParams.get('token')
  }

  private async presenterAuthorised(request: Request): Promise<boolean> {
    if (!this.session) return false
    const payload = await verifySignedToken(this.presenterToken(request), this.env.SESSION_SIGNING_SECRET)
    return payload?.sessionId === this.session.sessionId
  }

  private acceptSocket(role: SocketAttachment['role'], request: Request): Response {
    const url = new URL(request.url)
    const protocol = url.searchParams.get('protocol') === '2' ? 2 : 1
    const participantId = url.searchParams.get('participantId')
    if (role === 'audience' && protocol === 2 && !validRecoveryId(participantId)) {
      return errorResponse('participant_required', 'A participant identity is required.', 400)
    }
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    const connectionId = crypto.randomUUID()
    server.serializeAttachment({ role, connectionId, protocol,
      ...(role === 'audience' && participantId ? { participantId } : {}),
    } satisfies SocketAttachment)
    this.ctx.acceptWebSocket(server)
    if (role === 'presenter' && this.session) {
      recoveryState(this.session).presenterConnectionId = connectionId
      this.save()
      // Transfer ownership before closing the old socket: late close/error/message events are inert.
      for (const old of this.sockets('presenter')) {
        if (old === server) continue
        this.send(old, { type: 'session.superseded' })
        try { old.close(4001, 'Presenter connection replaced') } catch {}
      }
    }
    if (protocol === 2) {
      this.send(server, { type: 'session.hello', protocol: 2, expiresAt: this.session!.expiresAt })
      return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: WebSocket })
    }
    const current = this.session && currentStateMessage(this.session)
    if (current && socketRoleReceivesSlideState(role)) server.send(JSON.stringify(current))
    if (this.session) {
      // Old handouts have no closed-state display contract; retain their original initial snapshot.
      for (const message of currentPollStateMessages(this.session, role).filter((p) => p.open)) server.send(JSON.stringify(message))
    }
    return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: WebSocket })
  }

  private sockets(role?: SocketAttachment['role']): HibernatingWebSocket[] {
    return this.ctx.getWebSockets().filter((socket) => !role || socket.deserializeAttachment<SocketAttachment>()?.role === role)
  }

  private send(socket: HibernatingWebSocket, message: unknown): void {
    try { socket.send(JSON.stringify(message)) } catch { /* the runtime removes disconnected sockets */ }
  }

  private broadcastSlideState(message: unknown): void {
    for (const socket of this.sockets()) {
      const role = socket.deserializeAttachment<SocketAttachment>()?.role
      if (role && socketRoleReceivesSlideState(role)) this.send(socket, message)
    }
  }

  private broadcastPollState(poll: StoredPoll, role: SocketAttachment['role']): void {
    const message = pollStateMessage(poll, role)
    for (const socket of this.sockets(role)) this.send(socket, message)
  }

  private async unregister(): Promise<void> {
    if (!this.session) return
    await registryStub(this.env).fetch(new Request(
      `https://internal/internal/session/${encodeURIComponent(this.session.talkSlug)}?sessionId=${encodeURIComponent(this.session.sessionId)}`,
      { method: 'DELETE' },
    ))
  }

  private async endSession(reason: 'ended' | 'expired' = 'ended'): Promise<Response> {
    if (!this.session) return errorResponse('not_found', 'Session not found.', 404)
    if (this.session.status === 'closed') return jsonResponse({ ok: true })
    const message = closeSession(this.session)
    this.save()
    for (const socket of this.sockets()) {
      this.send(socket, socket.deserializeAttachment<SocketAttachment>()?.protocol === 2 ? { ...message, reason } : message)
      try { socket.close(1000, 'Session closed') } catch { /* already disconnected */ }
    }
    await this.ctx.storage.deleteAlarm()
    await this.unregister()
    return jsonResponse({ ok: true })
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/internal/init' && request.method === 'POST') {
      if (this.session) return errorResponse('already_exists', 'Session already exists.', 409)
      const session = await request.json().catch(() => null) as StoredLiveSession | null
      if (!session?.sessionId || !session.talkSlug || !session.shortId || session.status !== 'open') {
        return errorResponse('invalid_session', 'Session details are invalid.', 400)
      }
      this.session = normaliseStoredSession(session)
      this.save()
      await this.ctx.storage.setAlarm(session.expiresAt)
      return jsonResponse({ ok: true })
    }

    const route = url.pathname.match(/^\/sessions\/([^/]+)\/(presenter|audience|close|status|recovery)$/)
    if (!route || route[1] !== this.session?.sessionId) return errorResponse('not_found', 'Session route not found.', 404)
    if (route[2] === 'recovery' && request.method === 'GET') {
      // Read-only history remains recoverable after expiry. Verify the original capability
      // at its issuance time, and require its exact session and expiration claims.
      const token = await verifySignedToken(this.presenterToken(request), this.env.SESSION_SIGNING_SECRET, this.session.createdAt)
      if (token?.sessionId !== this.session.sessionId || token.exp !== this.session.expiresAt) {
        return errorResponse('presenter_auth_required', 'Presenter authentication is required.', 401)
      }
      const after = Number(url.searchParams.get('afterSequence') || 0)
      if (!Number.isSafeInteger(after) || after < 0) return errorResponse('invalid_cursor', 'Invalid recovery cursor.', 400)
      const records = recoveryState(this.session).voteRecords.filter((record) => record.sequence > after)
      return jsonResponse({ polls: currentPollStateMessages(this.session, 'presenter'),
        voteRecords: records.slice(0, 200), moreRecords: records.length > 200 })
    }
    if (route[2] === 'status' && request.method === 'GET') {
      if (this.presenterToken(request) && !await this.presenterAuthorised(request)) {
        return errorResponse('presenter_auth_required', 'Presenter authentication is required.', 401)
      }
      return jsonResponse({ protocol: 2, build: LIVE_WORKER_BUILD, sessionId: this.session.sessionId,
        status: this.session.expiresAt <= Date.now() ? 'expired' : this.session.status === 'closed' ? 'ended' : 'open',
        expiresAt: this.session.expiresAt,
      })
    }
    if (!this.session || this.session.status !== 'open' || this.session.expiresAt <= Date.now()) {
      if (this.session?.status === 'open') await this.endSession('expired')
      return errorResponse('session_not_live', 'This session is not live.', 404)
    }
    if (route[2] === 'audience' && request.headers.get('upgrade') === 'websocket') return this.acceptSocket('audience', request)
    if (route[2] === 'presenter' && request.headers.get('upgrade') === 'websocket') {
      return await this.presenterAuthorised(request)
        ? this.acceptSocket('presenter', request)
        : errorResponse('presenter_auth_required', 'Presenter authentication is required.', 401)
    }
    if (route[2] === 'close' && request.method === 'POST') {
      const isAdmin = await adminAuthorised(request, this.env)
      if (!isAdmin && !await this.presenterAuthorised(request)) return errorResponse('presenter_auth_required', 'Presenter authentication is required.', 401)
      return this.endSession()
    }
    return errorResponse('not_found', 'Session action not found.', 404)
  }

  async webSocketMessage(socket: HibernatingWebSocket, value: string | ArrayBuffer): Promise<void> {
    const attachment = socket.deserializeAttachment<SocketAttachment>()
    if (!attachment || !this.session || this.session.status !== 'open' || typeof value !== 'string') return
    if (this.session.expiresAt <= Date.now()) { await this.endSession('expired'); return }
    const owner = this.session.recovery?.presenterConnectionId
    if (attachment.role === 'presenter' && owner && owner !== attachment.connectionId) {
      this.send(socket, { type: 'session.superseded' })
      try { socket.close(4001, 'Presenter connection replaced') } catch {}
      return
    }
    if (value.length > 128_000) { this.send(socket, { type: 'protocol.error', code: 'message_too_large' }); return }
    const recovery = attachment.protocol === 2 ? parseRecoveryClientMessage(value) : null
    if (recovery) {
      this.handleRecoveryMessage(socket, attachment, recovery)
      return
    }
    if (attachment.protocol === 2 && (attachment.role === 'audience' || parsePresenterMessage(value)?.type !== 'slide.publish')) {
      this.send(socket, { type: 'protocol.error', code: 'acknowledged_message_required' })
      return
    }
    if (attachment.role === 'audience') {
      const message = parseAudienceMessage(value)
      if (!message) {
        this.send(socket, { type: 'protocol.error', code: 'invalid_or_inert_message' })
        return
      }
      try {
        const { ack, record } = acceptSubmission(this.session, 'legacy-' + attachment.connectionId,
          { type: 'vote.submit', submissionId: crypto.randomUUID(), pollId: message.pollId, choice: message.choice }, Date.now())
        if (ack.status !== 'confirmed') throw new Error(ack.error)
        const poll = this.session.polls[message.pollId]
        this.save()
        for (const presenter of this.sockets('presenter')) {
          this.send(presenter, presenter.deserializeAttachment<SocketAttachment>()?.protocol === 2 ? record
            : { type: 'poll.vote-record', pollId: message.pollId, choice: ack.choice })
        }
        this.broadcastPollState(poll, 'presenter')
        if (poll.visibility === 'live' || poll.revealed) this.broadcastPollState(poll, 'audience')
        else this.send(socket, pollStateMessage(poll, 'audience', true))
      } catch {
        this.send(socket, { type: 'protocol.error', code: 'invalid_poll_vote' })
      }
      return
    }

    const message = parsePresenterMessage(value)
    if (!message) {
      this.send(socket, { type: 'protocol.error', code: 'invalid_or_inert_message' })
      return
    }
    try {
      if (message.type === 'slide.publish') {
        const state = publishSlideState(this.session, {
          slideId: message.slideId, reveal: message.reveal, focus: message.focus,
        })
        this.save()
        this.broadcastSlideState(state)
        return
      }
      const previouslyOpenPollIds = message.type === 'poll.open'
        ? Object.values(this.session.polls).filter((poll) => poll.open).map((poll) => poll.pollId)
        : []
      if (message.type === 'poll.open') openPoll(this.session, message.poll)
      else if (message.type === 'poll.close') closePoll(this.session, message.pollId)
      else if (message.type === 'poll.reveal') revealPoll(this.session, message.pollId)
      else hidePollResponse(this.session, message.pollId, message.responseId, message.hidden ?? true)
      const pollId = message.type === 'poll.open' ? message.poll.pollId : message.pollId
      const poll = this.session.polls[pollId]
      this.save()
      for (const previousPollId of previouslyOpenPollIds) {
        const previous = this.session.polls[previousPollId]
        if (!previous || previous.pollId === pollId) continue
        this.broadcastPollState(previous, 'presenter')
        this.broadcastPollState(previous, 'audience')
      }
      this.broadcastPollState(poll, 'presenter')
      this.broadcastPollState(poll, 'audience')
    } catch {
      this.send(socket, { type: 'protocol.error', code: 'invalid_poll_action' })
    }
  }

  async webSocketClose(socket: HibernatingWebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    // A socket is a transport, not the session. Only authenticated End or expiry closes the session.
    try { socket.close(code === 1005 || code === 1006 ? 1000 : code, reason || (wasClean ? 'Closed' : 'Connection lost')) } catch {}
  }

  async webSocketError(socket: HibernatingWebSocket): Promise<void> {
    try { socket.close(1011, 'WebSocket error') } catch { /* already disconnected */ }
  }

  async alarm(): Promise<void> {
    if (this.session?.status === 'open' && this.session.expiresAt <= Date.now()) await this.endSession('expired')
  }

  private handleRecoveryMessage(socket: HibernatingWebSocket, attachment: SocketAttachment, message: RecoveryClientMessage): void {
    const session = this.session!
    if (message.type === 'session.ping') {
      this.send(socket, { type: 'session.pong', nonce: message.nonce })
      return
    }
    if (message.type === 'session.sync') {
      if (attachment.role === 'presenter' && message.slideState) {
        const current = publishSlideState(session, message.slideState)
        this.save()
        this.broadcastSlideState(current)
      }
      const recovery = recoveryState(session)
      const records = recovery.voteRecords.filter((r) => r.sequence > (message.afterSequence ?? 0))
      const snapshot: SessionSnapshot = {
        type: 'session.snapshot', protocol: 2, syncId: message.syncId, sessionId: session.sessionId,
        expiresAt: session.expiresAt, slideState: currentStateMessage(session),
        polls: currentPollStateMessages(session, attachment.role),
        ...(attachment.role === 'presenter'
          ? { voteRecords: records.slice(0, 200), moreRecords: records.length > 200 }
          : { receipts: Object.values(recovery.submissions)
            .filter((s) => s.participantId === attachment.participantId).map((s) => s.ack) }),
      }
      this.send(socket, snapshot)
      return
    }
    if (message.type === 'operation' && attachment.role === 'presenter') {
      const key = 'op:' + message.operationId
      const prior = recoveryState(session).operations[key]
      const ack = applyPollOperation(session, message)
      this.save()
      if (!prior && ack.status === 'confirmed') {
        for (const poll of Object.values(session.polls)) {
          this.broadcastPollState(poll, 'presenter')
          this.broadcastPollState(poll, 'audience')
        }
      }
      this.send(socket, ack)
      return
    }
    if (message.type === 'vote.submit' && attachment.role === 'audience' && attachment.participantId) {
      const { ack, record } = acceptSubmission(session, attachment.participantId, message, Date.now())
      this.save()
      if (record) {
        for (const presenter of this.sockets('presenter')) this.send(presenter,
          presenter.deserializeAttachment<SocketAttachment>()?.protocol === 2 ? record
            : { type: record.type, pollId: record.pollId, choice: record.choice })
        const poll = session.polls[message.pollId]
        this.broadcastPollState(poll, 'presenter')
        if (poll.visibility === 'live' || poll.revealed) this.broadcastPollState(poll, 'audience')
      }
      this.send(socket, ack)
      // Other tabs belonging to this anonymous participant share the same allowance.
      if (record) for (const peer of this.sockets('audience')) {
        const peerAttachment = peer.deserializeAttachment<SocketAttachment>()
        if (peer !== socket && peerAttachment?.protocol === 2
          && peerAttachment.participantId === attachment.participantId) this.send(peer, ack)
      }
      return
    }
    this.send(socket, { type: 'protocol.error', code: 'wrong_role' })
  }
}

interface DurableObjectNamespace {
  idFromName(name: string): unknown
  get(id: unknown): DurableObjectStub
}

interface DurableObjectStub {
  fetch(request: Request): Promise<Response>
}

interface SqlStorage {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): Iterable<T>
}

interface DurableObjectStorage {
  sql: SqlStorage
  setAlarm(scheduledTime: number): Promise<void>
  deleteAlarm(): Promise<void>
}

interface HibernatingWebSocket extends WebSocket {
  serializeAttachment(value: unknown): void
  deserializeAttachment<T>(): T | null
}

interface DurableObjectState {
  storage: DurableObjectStorage
  blockConcurrencyWhile<T>(callback: () => Promise<T>): void
  acceptWebSocket(socket: HibernatingWebSocket): void
  getWebSockets(): HibernatingWebSocket[]
}

declare class WebSocketPair {
  0: WebSocket
  1: HibernatingWebSocket
}
