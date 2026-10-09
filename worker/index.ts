import { createSignedToken, verifySignedToken } from './auth'
import {
  adminAuthorised,
  bearerToken,
  cors,
  errorResponse,
  jsonResponse,
  registryShareUrl,
  registryStub,
  validTalkSlug,
  type Env,
  type SocketAttachment,
} from './http'
import { INK_LIMITS, POINTER_LIMITS, parseAudienceMessage, parsePresenterMessage, type InkMessage } from './protocol'
import {
  LIVE_PROTOCOL_VERSION, LIVE_WORKER_BUILD, parseRecoveryClientMessage, validRecoveryId,
  type RecoveryClientMessage, type SessionSnapshot, type SessionPresence,
} from './recovery-protocol'
import { acceptSubmission, applyPollOperation, recoveryState } from './recovery-state'
import { acceptCard, emptyBoard, ensureBoard, normaliseBoard, ownBoardAllowances, ownBoardCards, type CardSubmission } from './board-state'
import { BOARD_LIMITS, isPresenterBoardMessage } from './board-protocol'
import { closeLateBoards, dueLateBoards, type LateCloseReason, isOpenLateBoard, keepBoardsOpen, lateBoardsOpen, lateBoardsUntil, nextLateAlarm, openLateBoards } from './late-boards'
import {
  acceptQuestion, acceptReaction, audienceSwitches, catchUpOnResume, normaliseAudienceFeedback, questionList,
  reactionCountsBySlide, reactionCountsFor, reactionRecordsAfter, utf8Length,
} from './audience-feedback'
import {
  lookupSession,
  lookupShare,
  registerSession,
  registerShare,
  removeSession,
  removeShare,
  type RegistryEntry,
  type ShareRegistryEntry,
} from './registry-state'
import {
  closePoll,
  closeSession,
  createSession,
  currentPollStateMessages,
  currentStateMessage,
  hidePollResponse,
  normaliseStoredSession,
  openPoll,
  pollStateFor,
  publishSlideState,
  revealPoll,
  setInstantSlide,
  socketRoleReceivesSlideState,
  voteInPoll,
  type StoredLiveSession,
  type StoredPoll,
} from './session-state'
import { createShare, forwardToShare, parseShareRoute } from './shared-talk'
import { createRunShare, forwardToRunShare, parseRunShareRoute } from './run-share'
import { createRunPrework, forwardToPrework, parsePreworkRoute } from './prework'
import { generateShortId } from './short-id'

export { SharedTalk } from './shared-talk'
export { RunShare } from './run-share'
export { RunPrework } from './prework'

/** The reducer's view of a card message: the same fields, typed by kind. */
function cardSubmission(message: Extract<RecoveryClientMessage, { type: 'card.add' | 'card.edit' | 'card.withdraw' }>): CardSubmission {
  const { submissionId, pollId } = message
  switch (message.type) {
    case 'card.add':
      return { kind: 'card.add', submissionId, input: { pollId, column: message.column, text: message.text, ...(message.name ? { name: message.name } : {}) } }
    case 'card.edit':
      return { kind: 'card.edit', submissionId, input: { pollId, cardId: message.cardId, text: message.text } }
    case 'card.withdraw':
      return { kind: 'card.withdraw', submissionId, input: { pollId, cardId: message.cardId } }
  }
}

/** Each board poll's cards and groups live in their own row, so no board can outgrow the session row. */
function boardRowKey(pollId: string): string {
  return 'board:' + pollId
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1_000
/** Reaction records per snapshot or recovery page; the cursor fetches the rest. */
const REACTION_RECORD_PAGE = 500

interface CreateSessionBody {
  talkSlug?: string
}

/** LiveSession's socket attachment: the shared shape plus the recovery protocol's fields. */
type LiveSocketAttachment = SocketAttachment<'presenter' | 'audience'> & {
  protocol?: number
  participantId?: string
  kind?: 'screen'
}

function liveSessionStub(env: Env, sessionId: string): DurableObjectStub {
  return env.LIVE_SESSIONS.get(env.LIVE_SESSIONS.idFromName(sessionId))
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

  // The talk's current session, if any, is about to lose the join link: its boards left open close first.
  const current = await registryStub(env).fetch(new Request(`https://internal/session/${encodeURIComponent(body.talkSlug)}`))
    .then((response) => response.ok ? response.json() as Promise<{ live?: boolean; sessionId?: string }> : null).catch(() => null)
  if (current?.live && current.sessionId && current.sessionId !== sessionId) {
    await liveSessionStub(env, current.sessionId).fetch(new Request('https://internal/internal/supersede', { method: 'POST' })).catch(() => null)
  }

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
    } else if (url.pathname === '/shares' && request.method === 'POST') {
      response = await createShare(request, env)
    } else if (url.pathname === '/results' && request.method === 'POST') {
      response = await createRunShare(request, env)
    } else if (parseRunShareRoute(url.pathname)) {
      // A Run's read-only share link (ticket 06): parsed here and again in the object.
      response = await forwardToRunShare(request, env, parseRunShareRoute(url.pathname)!)
    } else if (url.pathname === '/prework' && request.method === 'POST') {
      response = await createRunPrework(request, env)
    } else if (parsePreworkRoute(url.pathname)) {
      // A planned Run's pre-work (ticket 09): parsed here and again in the object.
      // A failure reaching or inside the object is a plain, retryable 503 (never an uncaught 500).
      response = await forwardToPrework(request, env, parsePreworkRoute(url.pathname)!).catch((error) => {
        console.error('[prework] forward failed', error)
        const busy = errorResponse('prework_unavailable', 'Pre-work is busy. Try again in a moment.', 503)
        busy.headers.set('retry-after', '2')
        return busy
      })
    } else {
      const discovery = url.pathname.match(/^\/session\/([^/]+)$/)
      const sessionRoute = url.pathname.match(/^\/sessions\/([^/]+)\/(presenter|audience|close|status|recovery)$/)
      const shareLookup = url.pathname.match(/^\/shares\/by-talk\/([^/]+)$/)
      const shareRoute = parseShareRoute(url.pathname)
      if (discovery && request.method === 'GET') {
        response = await registryStub(env).fetch(request)
      } else if (sessionRoute && (request.method === 'GET' || request.method === 'POST' || request.headers.get('upgrade') === 'websocket')) {
        response = await liveSessionStub(env, sessionRoute[1]).fetch(request)
      } else if (shareLookup && request.method === 'GET') {
        // Admin only: a public slug lookup would hand out share links to anyone guessing slugs.
        response = await adminAuthorised(request, env)
          ? await registryStub(env).fetch(new Request(registryShareUrl(shareLookup[1])))
          : errorResponse('admin_auth_required', 'Admin authentication is required.', 401)
      } else if (shareRoute) {
        // Parsed once: the same route decides the body cap, the early owner check and the object.
        response = await forwardToShare(request, env, shareRoute)
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
    state.storage.sql.exec('CREATE TABLE IF NOT EXISTS active_shares (talk_slug TEXT PRIMARY KEY, share_id TEXT NOT NULL)')
  }

  private shareEntries(): Map<string, ShareRegistryEntry> {
    const rows = this.ctx.storage.sql.exec<{ talk_slug: string; share_id: string }>('SELECT talk_slug, share_id FROM active_shares')
    return new Map([...rows].map((row) => [row.talk_slug, { talkSlug: row.talk_slug, shareId: row.share_id }]))
  }

  private saveShareEntries(entries: Map<string, ShareRegistryEntry>): void {
    this.ctx.storage.sql.exec('DELETE FROM active_shares')
    for (const entry of entries.values()) {
      this.ctx.storage.sql.exec('INSERT INTO active_shares (talk_slug, share_id) VALUES (?, ?)', entry.talkSlug, entry.shareId)
    }
  }

  private shareRoute(request: Request, url: URL, talkSlug: string): Response {
    const entries = this.shareEntries()
    if (request.method === 'POST') {
      const shareId = url.searchParams.get('shareId')
      if (!shareId) return errorResponse('invalid_registration', 'Share registration is invalid.', 400)
      registerShare(entries, { talkSlug, shareId })
      this.saveShareEntries(entries)
      return jsonResponse({ ok: true })
    }
    if (request.method === 'DELETE') {
      removeShare(entries, talkSlug, url.searchParams.get('shareId') ?? '')
      this.saveShareEntries(entries)
      return jsonResponse({ ok: true })
    }
    if (request.method === 'GET') return jsonResponse(lookupShare(entries, talkSlug))
    return errorResponse('not_found', 'Registry route not found.', 404)
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
    const internalShare = url.pathname.match(/^\/internal\/share\/([^/]+)$/)
    if (internalShare) return this.shareRoute(request, url, decodeURIComponent(internalShare[1]))
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
    if (!row) return null
    const session = normaliseStoredSession(JSON.parse(row.value) as StoredLiveSession)
    const feedback = [...this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM kv WHERE key = ?', 'feedback')][0]
    if (feedback) session.feedback = normaliseAudienceFeedback(JSON.parse(feedback.value))
    for (const poll of Object.values(session.polls)) {
      if (poll.type !== 'board') continue
      const board = this.readRow(boardRowKey(poll.pollId))
      // A board opened but never written takes the definition's own settings (its limit may be 12 or All).
      ;(session.boards ??= {})[poll.pollId] = board === null ? emptyBoard(poll.board) : normaliseBoard(JSON.parse(board), poll.board)
    }
    return session
  }

  private readRow(key: string): string | null {
    const row = [...this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM kv WHERE key = ?', key)][0]
    return row ? row.value : null
  }

  private writeRow(key: string, value: string): void {
    this.ctx.storage.sql.exec(
      'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value)
  }

  /** The session row. Reactions and questions live in their own row (saveFeedback) so neither outgrows a row. */
  private save(): void {
    if (!this.session) return
    const { feedback: _feedback, boards: _boards, ...session } = this.session
    this.writeRow('session', JSON.stringify(session))
  }

  /**
   * Writes one board's row. The reducer keeps audience submissions inside the row's byte cap with room
   * for the presenter's operations; this refuses anything that still outgrew it. On a refusal or a
   * storage failure memory goes back to what storage holds and the caller refuses the message.
   */
  private saveBoard(pollId: string): boolean {
    const board = this.session?.boards?.[pollId]
    if (!board) return true
    try {
      const value = JSON.stringify(board)
      if (utf8Length(value) > BOARD_LIMITS.boardRowBytes) throw new Error('board_row_too_large')
      this.writeRow(boardRowKey(pollId), value)
      return true
    } catch {
      const stored = this.readRow(boardRowKey(pollId))
      const settings = this.session!.polls[pollId]?.board
      this.session!.boards![pollId] = stored === null ? emptyBoard(settings) : normaliseBoard(JSON.parse(stored), settings)
      return false
    }
  }

  /**
   * Writes the feedback row. The reducer refuses anything that would outgrow it, so a failure here is
   * unexpected; if it happens, memory goes back to what storage holds and the caller refuses the message.
   */
  private saveFeedback(): boolean {
    if (!this.session?.feedback) return true
    try {
      this.writeRow('feedback', JSON.stringify(this.session.feedback))
      return true
    } catch {
      const row = [...this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM kv WHERE key = ?', 'feedback')][0]
      this.session.feedback = row ? normaliseAudienceFeedback(JSON.parse(row.value)) : undefined
      return false
    }
  }

  /** Presenter-only relay. Protocol-1 presenters predate reactions and questions. */
  private sendToPresenters(message: unknown): void {
    for (const socket of this.sockets('presenter')) {
      if (socket.deserializeAttachment<LiveSocketAttachment>()?.protocol === 2) this.send(socket, message)
    }
  }

  private broadcastSwitches(): void {
    if (!this.session) return
    const message = { type: 'switches.state', ...audienceSwitches(this.session) }
    for (const socket of this.sockets()) {
      if (socket.deserializeAttachment<LiveSocketAttachment>()?.protocol === 2) this.send(socket, message)
    }
  }

  private presenterToken(request: Request): string | null {
    return bearerToken(request) ?? new URL(request.url).searchParams.get('token')
  }

  /**
   * The presenter's token checked at the moment it was issued, with its exact session and expiry: the
   * capability to read the session's history and to close boards left open, which outlive the token's
   * 12-hour live window.
   */
  private async presenterCapability(request: Request): Promise<boolean> {
    if (!this.session) return false
    const token = await verifySignedToken(this.presenterToken(request), this.env.SESSION_SIGNING_SECRET, this.session.createdAt)
    return token?.sessionId === this.session.sessionId && token.exp === this.session.expiresAt
  }

  private async presenterAuthorised(request: Request): Promise<boolean> {
    if (!this.session) return false
    const payload = await verifySignedToken(this.presenterToken(request), this.env.SESSION_SIGNING_SECRET)
    return payload?.sessionId === this.session.sessionId
  }

  private acceptSocket(role: LiveSocketAttachment['role'], request: Request): Response {
    const url = new URL(request.url)
    const protocol = url.searchParams.get('protocol') === '2' ? 2 : 1
    const participantId = url.searchParams.get('participantId')
    const kind = role === 'audience' && url.searchParams.get('kind') === 'screen' ? 'screen' : undefined
    if (role === 'audience' && protocol === 2 && !validRecoveryId(participantId)) {
      return errorResponse('participant_required', 'A participant identity is required.', 400)
    }
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    const connectionId = crypto.randomUUID()
    server.serializeAttachment({ role, connectionId, protocol,
      ...(role === 'audience' && participantId ? { participantId } : {}),
      ...(kind ? { kind } : {}),
    } satisfies LiveSocketAttachment)
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
    this.broadcastPresence()
    if (protocol === 2) {
      this.send(server, { type: 'session.hello', protocol: 2, expiresAt: this.audienceExpiresAt() })
      return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: WebSocket })
    }
    const current = this.session && currentStateMessage(this.session)
    if (current && socketRoleReceivesSlideState(role)) server.send(JSON.stringify(current))
    if (kind === 'screen') this.inkForScreen(server)
    if (this.session) {
      // Old handouts have no closed-state display contract; retain their original initial snapshot.
      for (const message of currentPollStateMessages(this.session, role).filter((p) => p.open)) server.send(JSON.stringify(message))
    }
    return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: WebSocket })
  }

  private sockets(role?: LiveSocketAttachment['role']): HibernatingWebSocket[] {
    return this.ctx.getWebSockets().filter((socket) => !role || socket.deserializeAttachment<LiveSocketAttachment>()?.role === role)
  }

  private send(socket: HibernatingWebSocket, message: unknown): void {
    try { socket.send(JSON.stringify(message)) } catch { /* the runtime removes disconnected sockets */ }
  }

  private presence(): SessionPresence {
    const sockets = this.sockets()
    return { type: 'session.presence',
      presenterConnected: sockets.some((socket) => socket.deserializeAttachment<LiveSocketAttachment>()?.role === 'presenter'),
      venueScreens: sockets.filter((socket) => socket.deserializeAttachment<LiveSocketAttachment>()?.kind === 'screen').length }
  }

  private broadcastPresence(): void {
    const message = this.presence()
    for (const socket of this.sockets()) this.send(socket, message)
  }

  private broadcastSlideState(message: unknown): void {
    for (const socket of this.sockets()) {
      const role = socket.deserializeAttachment<LiveSocketAttachment>()?.role
      if (role && socketRoleReceivesSlideState(role)) this.send(socket, message)
    }
  }

  private broadcastPollState(poll: StoredPoll, role: LiveSocketAttachment['role']): void {
    const message = pollStateFor(this.session!, poll, role)
    for (const socket of this.sockets(role)) this.send(socket, message)
  }

  private async unregister(): Promise<void> {
    if (!this.session) return
    await registryStub(this.env).fetch(new Request(
      `https://internal/internal/session/${encodeURIComponent(this.session.talkSlug)}?sessionId=${encodeURIComponent(this.session.sessionId)}`,
      { method: 'DELETE' },
    ))
  }

  /** Until when an audience socket may use this session: its live expiry, or the last late board's close. */
  private audienceExpiresAt(): number {
    if (!this.session) return 0
    return this.session.status === 'closed' ? lateBoardsUntil(this.session) ?? this.session.expiresAt : this.session.expiresAt
  }

  private async register(expiresAt: number): Promise<void> {
    if (!this.session) return
    await registryStub(this.env).fetch(new Request(`https://internal/internal/session/${encodeURIComponent(this.session.talkSlug)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ talkSlug: this.session.talkSlug, sessionId: this.session.sessionId, expiresAt }),
    }))
  }

  /**
   * End live. With `keepBoards` every board still open keeps taking cards after the session ends
   * (late-boards.ts): the presenter and the phones following the talk are told the session closed,
   * the join link keeps resolving to this session until the last kept board closes, and the alarm
   * closes each board when its time is up. Without an open board it is a plain end.
   */
  private async endSession(reason: 'ended' | 'expired' = 'ended', keepBoards = false): Promise<Response> {
    if (!this.session) return errorResponse('not_found', 'Session not found.', 404)
    if (this.session.status === 'closed') return jsonResponse({ ok: true, lateBoards: openLateBoards(this.session, Date.now()) })
    const now = Date.now()
    const kept = keepBoards && reason === 'ended' ? keepBoardsOpen(this.session, now) : {}
    const message = closeSession(this.session)
    this.liveInk = null
    this.save()
    for (const socket of this.sockets()) {
      this.send(socket, socket.deserializeAttachment<LiveSocketAttachment>()?.protocol === 2 ? { ...message, reason } : message)
      try { socket.close(1000, 'Session closed') } catch { /* already disconnected */ }
    }
    const next = nextLateAlarm(this.session)
    if (next === null) {
      await this.ctx.storage.deleteAlarm()
      await this.unregister()
    } else {
      await this.ctx.storage.setAlarm(next)
      await this.register(lateBoardsUntil(this.session)!)
    }
    return jsonResponse({ ok: true, lateBoards: kept })
  }

  /**
   * Close boards left open: the ones whose time has come (the alarm), or all of them ("Close it
   * now" from History). Their sockets hear the board closed; once none is left the session's
   * remaining sockets are closed and the join link stops resolving to it.
   */
  private async closeBoardsLeftOpen(pollIds: string[] | undefined, reason: LateCloseReason): Promise<void> {
    const session = this.session
    if (!session?.lateBoards) return
    const changed = closeLateBoards(session, pollIds, reason, Date.now())
    this.save()
    for (const poll of changed) {
      this.broadcastPollState(poll, 'presenter')
      this.broadcastPollState(poll, 'audience')
    }
    const next = nextLateAlarm(session)
    if (next !== null) {
      await this.ctx.storage.setAlarm(next)
      return
    }
    for (const socket of this.sockets()) {
      this.send(socket, { type: 'session.closed', reason: 'ended' })
      try { socket.close(1000, 'Session closed') } catch { /* already disconnected */ }
    }
    await this.ctx.storage.deleteAlarm()
    await this.unregister()
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    // A new live session for the same talk is taking the join link (entry Worker only: the public
    // routes never forward a path outside /sessions/<id>/…). Boards this session left open close, so
    // no board claims to be open where no phone can reach it.
    if (url.hostname === 'internal' && url.pathname === '/internal/supersede' && request.method === 'POST') {
      if (this.session?.status === 'closed' && this.session.lateBoards) await this.closeBoardsLeftOpen(undefined, 'superseded')
      return jsonResponse({ ok: true })
    }
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
      const afterReaction = Number(url.searchParams.get('afterReactionSequence') || 0)
      if (!Number.isSafeInteger(afterReaction) || afterReaction < 0) return errorResponse('invalid_cursor', 'Invalid recovery cursor.', 400)
      const records = recoveryState(this.session).voteRecords.filter((record) => record.sequence > after)
      const reactionRecords = reactionRecordsAfter(this.session, afterReaction)
      return jsonResponse({ polls: currentPollStateMessages(this.session, 'presenter'),
        voteRecords: records.slice(0, 200), moreRecords: records.length > 200,
        questions: questionList(this.session), reactionCounts: reactionCountsBySlide(this.session),
        reactionRecords: reactionRecords.slice(0, REACTION_RECORD_PAGE), moreReactionRecords: reactionRecords.length > REACTION_RECORD_PAGE,
        // Boards left open after End live, with when each closes; absent once none is.
        ...(this.session.status === 'closed' && this.session.lateBoards ? { lateBoards: openLateBoards(this.session, Date.now()) } : {}),
        ...(this.session.endedAt ? { endedAt: this.session.endedAt } : {}),
        // Boards left open that have closed since: when and why (expired, closed, superseded).
        ...(this.session.lateClosed ? { closedBoards: this.session.lateClosed } : {}) })
    }
    if (route[2] === 'status' && request.method === 'GET') {
      if (this.presenterToken(request) && !await this.presenterAuthorised(request)) {
        return errorResponse('presenter_auth_required', 'Presenter authentication is required.', 401)
      }
      return jsonResponse({ protocol: 2, build: LIVE_WORKER_BUILD, sessionId: this.session.sessionId,
        status: this.session.expiresAt <= Date.now() ? 'expired' : this.session.status === 'closed' ? 'ended' : 'open',
        expiresAt: this.session.expiresAt,
        ...(this.session.status === 'closed' && lateBoardsOpen(this.session, Date.now()) ? { lateBoards: openLateBoards(this.session, Date.now()) } : {}),
      })
    }
    if (this.session.status === 'closed' && this.session.lateBoards) {
      const now = Date.now()
      // The alarm may run late: a board whose time has come is closed before anything else is served.
      const due = dueLateBoards(this.session, now)
      if (due.length) await this.closeBoardsLeftOpen(due, 'expired')
      // "Close it now" from History: the presenter's capability (checked as issued) or the admin secret.
      if (route[2] === 'close' && request.method === 'POST' && this.session.lateBoards) {
        if (!await adminAuthorised(request, this.env) && !await this.presenterCapability(request)) {
          return errorResponse('presenter_auth_required', 'Presenter authentication is required.', 401)
        }
        await this.closeBoardsLeftOpen(undefined, 'closed')
        return jsonResponse({ ok: true, lateBoards: {} })
      }
      // Late cards: only the acknowledged audience protocol, and only while a board is still open.
      if (route[2] === 'audience' && request.headers.get('upgrade') === 'websocket' && lateBoardsOpen(this.session, now)
        && url.searchParams.get('protocol') === '2') return this.acceptSocket('audience', request)
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
      // `{"keepBoardsOpen": true}`: boards still open keep taking cards after the end (ticket 06).
      const body = await request.json().catch(() => null) as { keepBoardsOpen?: unknown } | null
      return this.endSession('ended', body?.keepBoardsOpen === true)
    }
    return errorResponse('not_found', 'Session action not found.', 404)
  }

  private pointerRates = new WeakMap<HibernatingWebSocket, { at: number; count: number }>()
  private inkRates = new WeakMap<HibernatingWebSocket, { at: number; count: number }>()
  /**
   * The Pen's latest ink (ticket 08): the presenter's current layer, held in this object's memory
   * only (never this.save(), never storage) so a venue screen that joins or reconnects is sent it.
   * Gone when the session ends or the object is evicted; the presenter resends it on reconnect.
   */
  private liveInk: InkMessage | null = null
  private liveInkVersion = 0
  private inkRequestedAt = 0
  /** The cached layer last sent to a screen on join or sync: which version, and when. */
  private inkRepliedTo = new WeakMap<HibernatingWebSocket, { version: number; at: number }>()

  /**
   * A venue screen joined or reconnected: send it the current layer. When this object holds none
   * (evicted: ink lives in memory only), ask the presenter to send it again (at most once a second);
   * the answer reaches every venue screen through the ordinary ink relay. Ink is never stored.
   */
  private inkForScreen(screen: HibernatingWebSocket): void {
    if (this.liveInk) {
      // A screen that syncs again and again gets the same layer at most once a second (a new
      // drawing reaches it through the relay anyway).
      const now = Date.now(), previous = this.inkRepliedTo.get(screen)
      if (previous && previous.version === this.liveInkVersion && now - previous.at < 1000) return
      this.inkRepliedTo.set(screen, { version: this.liveInkVersion, at: now })
      this.send(screen, this.liveInk)
      return
    }
    if (this.session?.status !== 'open') return
    const now = Date.now()
    if (now - this.inkRequestedAt < 1000) return
    const owner = this.session.recovery?.presenterConnectionId
    const presenters = this.sockets('presenter').filter((socket) => {
      const a = socket.deserializeAttachment<LiveSocketAttachment>()
      return a?.protocol === 2 && (!owner || a.connectionId === owner)
    })
    if (!presenters.length) return
    this.inkRequestedAt = now
    for (const presenter of presenters) this.send(presenter, { type: 'ink.request' })
  }

  /** Venue screens only: phones never receive the pointer or ink. */
  private sendToScreens(message: unknown): void {
    for (const follower of this.sockets('audience')) {
      if (follower.deserializeAttachment<LiveSocketAttachment>()?.kind === 'screen') this.send(follower, message)
    }
  }

  async webSocketMessage(socket: HibernatingWebSocket, value: string | ArrayBuffer): Promise<void> {
    const attachment = socket.deserializeAttachment<LiveSocketAttachment>()
    if (!attachment || !this.session || typeof value !== 'string') return
    if (this.session.status !== 'open') {
      if (attachment.role === 'audience' && attachment.protocol === 2 && attachment.participantId && this.session.lateBoards) {
        await this.handleLateMessage(socket, attachment.participantId, value)
      }
      return
    }
    if (this.session.expiresAt <= Date.now()) { await this.endSession('expired'); return }
    const owner = this.session.recovery?.presenterConnectionId
    if (attachment.role === 'presenter' && owner && owner !== attachment.connectionId) {
      this.send(socket, { type: 'session.superseded' })
      try { socket.close(4001, 'Presenter connection replaced') } catch {}
      return
    }
    if (value.length > 128_000) { this.send(socket, { type: 'protocol.error', code: 'message_too_large' }); return }
    // A transient message bypasses the durable operation queue. Authority is the authenticated
    // socket attachment, including the supersession check above, never a payload claim.
    // Ink frames are larger than a pointer's; only a frame naming ink.live pays for this extra parse
    // (the name is no authority: parsePresenterMessage checks the frame in full).
    const transient = attachment.role === 'presenter'
      && (value.length <= POINTER_LIMITS.bytes || (value.length <= INK_LIMITS.bytes && value.includes('"ink.live"')))
      ? parsePresenterMessage(value) : null
    if (transient?.type === 'pointer.live') {
      if (attachment.role !== 'presenter') return
      const now = Date.now(), previous = this.pointerRates.get(socket)
      const rate = previous && now - previous.at < 1000 ? previous : { at: now, count: 0 }
      this.pointerRates.set(socket, rate)
      if (++rate.count > POINTER_LIMITS.perSecond) return
      this.sendToScreens(transient)
      return
    }
    if (transient?.type === 'ink.live') {
      // Checked by parsePresenterMessage: bytes, strokes per layer, points per stroke and per layer.
      if (attachment.role !== 'presenter') return
      const now = Date.now(), previous = this.inkRates.get(socket)
      const rate = previous && now - previous.at < 1000 ? previous : { at: now, count: 0 }
      this.inkRates.set(socket, rate)
      if (++rate.count > INK_LIMITS.perSecond) return
      this.liveInk = transient
      this.liveInkVersion++
      this.sendToScreens(transient)
      return
    }
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
      // Reactions and questions need the acknowledged (protocol 2) path; on protocol 1 they stay inert.
      if (!message || message.type !== 'poll.vote') {
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
          this.send(presenter, presenter.deserializeAttachment<LiveSocketAttachment>()?.protocol === 2 ? record
            : { type: 'poll.vote-record', pollId: message.pollId, choice: ack.choice })
        }
        this.broadcastPollState(poll, 'presenter')
        if (poll.visibility === 'live' || poll.revealed) this.broadcastPollState(poll, 'audience')
        else this.send(socket, pollStateFor(this.session, poll, 'audience', true))
      } catch {
        this.send(socket, { type: 'protocol.error', code: 'invalid_poll_vote' })
      }
      return
    }

    const message = parsePresenterMessage(value)
    if (!message || message.type === 'pointer.live' || message.type === 'ink.live' || message.type === 'question.answer' || message.type === 'switches.set'
      || isPresenterBoardMessage(message)) {
      this.send(socket, { type: 'protocol.error', code: 'invalid_or_inert_message' })
      return
    }
    try {
      if (message.type === 'slide.publish') {
        const state = publishSlideState(this.session, {
          slideId: message.slideId, reveal: message.reveal, focus: message.focus,
          ...(message.lightbox ? { lightbox: message.lightbox } : {}),
          ...(message.talkQr ? { talkQr: true } : {}),
        })
        this.save()
        this.broadcastSlideState(state)
        return
      }
      if (message.type === 'instant.show' || message.type === 'instant.clear') {
        const state = setInstantSlide(this.session, message.type === 'instant.show' ? message.slide : null)
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
      else if (message.type === 'poll.hide') hidePollResponse(this.session, message.pollId, message.responseId, message.hidden ?? true)
      else return
      const pollId = message.type === 'poll.open' ? message.poll.pollId : message.pollId
      const poll = this.session.polls[pollId]
      this.save()
      // An empty board that could not be written is rebuilt from its definition on the next load, but
      // the presenter is told and the room is not sent a board storage does not hold.
      if (poll.type === 'board' && !this.saveBoard(pollId)) {
        this.send(socket, { type: 'protocol.error', code: 'storage_failed' })
        return
      }
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
    this.broadcastPresence()
  }

  async webSocketError(socket: HibernatingWebSocket): Promise<void> {
    try { socket.close(1011, 'WebSocket error') } catch { /* already disconnected */ }
    this.broadcastPresence()
  }

  async alarm(): Promise<void> {
    const now = Date.now()
    if (this.session?.status === 'open' && this.session.expiresAt <= now) await this.endSession('expired')
    else if (this.session?.status === 'closed' && this.session.lateBoards) {
      const due = dueLateBoards(this.session, now)
      if (due.length) await this.closeBoardsLeftOpen(due, 'expired')
      else {
        const next = nextLateAlarm(this.session)
        if (next !== null) await this.ctx.storage.setAlarm(next)
      }
    }
  }

  /**
   * A phone's message after End live while boards are left open: ping, sync (a snapshot of the late
   * boards only; no slide to follow) and cards for a board still open. Everything else is refused.
   */
  private async handleLateMessage(socket: HibernatingWebSocket, participantId: string, value: string): Promise<void> {
    const session = this.session!
    const now = Date.now()
    const due = dueLateBoards(session, now)
    if (due.length) await this.closeBoardsLeftOpen(due, 'expired')
    if (value.length > 128_000) { this.send(socket, { type: 'protocol.error', code: 'message_too_large' }); return }
    const message = parseRecoveryClientMessage(value)
    if (!message) { this.send(socket, { type: 'protocol.error', code: 'session_not_live' }); return }
    if (message.type === 'session.ping') { this.send(socket, { type: 'session.pong', nonce: message.nonce }); return }
    const late = openLateBoards(session, now)
    if (message.type === 'session.sync') {
      const { presenterConnected, venueScreens } = this.presence()
      const recovery = recoveryState(session)
      const snapshot: SessionSnapshot = {
        type: 'session.snapshot', protocol: 2, syncId: message.syncId, sessionId: session.sessionId,
        expiresAt: this.audienceExpiresAt(), slideState: null, presence: { presenterConnected, venueScreens },
        instantSlide: null,
        polls: Object.keys(late).map((pollId) => pollStateFor(session, session.polls[pollId], 'audience')),
        switches: audienceSwitches(session),
        receipts: Object.values(recovery.submissions).filter((s) => s.participantId === participantId).map((s) => s.ack),
        myCards: ownBoardCards(session, participantId).filter((card) => card.pollId in late),
        myBoards: ownBoardAllowances(session, participantId).filter((board) => board.pollId in late),
      }
      this.send(socket, snapshot)
      return
    }
    if (message.type === 'card.add' || message.type === 'card.edit' || message.type === 'card.withdraw') {
      if (!isOpenLateBoard(session, message.pollId, now)) {
        this.send(socket, { type: 'card.ack', submissionId: message.submissionId, pollId: message.pollId, status: 'rejected', error: 'board_closed' })
        return
      }
      this.handleCard(socket, participantId, message)
      return
    }
    if (message.type === 'submission.invalid' && 'pollId' in message) {
      this.send(socket, { type: 'card.ack', submissionId: message.submissionId, pollId: message.pollId, status: 'rejected', error: message.error })
      return
    }
    this.send(socket, { type: 'protocol.error', code: 'session_not_live' })
  }

  /** A card add, edit or withdrawal from one participant: stored, acknowledged, and the board sent out. */
  private handleCard(socket: HibernatingWebSocket, participantId: string,
    message: Extract<RecoveryClientMessage, { type: 'card.add' | 'card.edit' | 'card.withdraw' }>): void {
    const session = this.session!
    const { submissionId, pollId } = message
    const poll = session.polls[pollId]
    if (!poll || poll.type !== 'board') {
      this.send(socket, { type: 'card.ack', submissionId, pollId, status: 'rejected', error: 'board_not_found' })
      return
    }
    const outcome = acceptCard(ensureBoard(session, poll), poll, participantId, cardSubmission(message), Date.now())
    if (outcome.stored && !this.saveBoard(poll.pollId)) {
      this.send(socket, { type: 'card.ack', submissionId, pollId: poll.pollId, status: 'rejected', error: 'storage_failed' })
      return
    }
    if (outcome.stored) {
      this.broadcastPollState(poll, 'presenter')
      this.broadcastPollState(poll, 'audience')
    }
    this.send(socket, outcome.ack)
    // The participant's other tabs learn the card is theirs.
    if (outcome.stored) for (const peer of this.sockets('audience')) {
      const peerAttachment = peer.deserializeAttachment<LiveSocketAttachment>()
      if (peer !== socket && peerAttachment?.protocol === 2 && peerAttachment.participantId === participantId) this.send(peer, outcome.ack)
    }
  }

  private handleRecoveryMessage(socket: HibernatingWebSocket, attachment: LiveSocketAttachment, message: RecoveryClientMessage): void {
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
      if (attachment.role === 'presenter') this.broadcastPresence()
      const recovery = recoveryState(session)
      const records = recovery.voteRecords.filter((r) => r.sequence > (message.afterSequence ?? 0))
      const { presenterConnected, venueScreens } = this.presence()
      const snapshot: SessionSnapshot = {
        type: 'session.snapshot', protocol: 2, syncId: message.syncId, sessionId: session.sessionId,
        expiresAt: session.expiresAt, slideState: currentStateMessage(session),
        presence: { presenterConnected, venueScreens },
        instantSlide: session.instantSlide ?? null,
        polls: currentPollStateMessages(session, attachment.role),
        switches: audienceSwitches(session),
        ...(attachment.role === 'presenter'
          ? { voteRecords: records.slice(0, 200), moreRecords: records.length > 200 }
          : { receipts: Object.values(recovery.submissions)
            .filter((s) => s.participantId === attachment.participantId).map((s) => s.ack) }),
        ...(attachment.role === 'audience' && attachment.participantId && Object.keys(session.boards ?? {}).length
          ? { myCards: ownBoardCards(session, attachment.participantId), myBoards: ownBoardAllowances(session, attachment.participantId) } : {}),
      }
      if (attachment.role === 'presenter') {
        const reactionRecords = reactionRecordsAfter(session, message.afterReactionSequence ?? 0)
        Object.assign(snapshot, {
          reactionCounts: reactionCountsBySlide(session), questions: questionList(session),
          reactionRecords: reactionRecords.slice(0, REACTION_RECORD_PAGE),
          moreReactionRecords: reactionRecords.length > REACTION_RECORD_PAGE,
        })
      }
      this.send(socket, snapshot)
      // A venue screen that joins or reconnects is sent the drawing on the presenter's current layer.
      if (attachment.role === 'audience' && attachment.kind === 'screen') this.inkForScreen(socket)
      return
    }
    if (message.type === 'operation' && attachment.role === 'presenter') {
      const key = 'op:' + message.operationId
      const prior = recoveryState(session).operations[key]
      const action = message.action
      // Read before the switch changes: what the presenter missed while reactions were paused.
      const catchUp = !prior && action.type === 'switches.set' && action.reactionsAllowed === true ? catchUpOnResume(session) : []
      let ack = applyPollOperation(session, message)
      // The board poll this operation may have changed: a board operation's, or a board being opened.
      const boardPollId = isPresenterBoardMessage(action) ? action.pollId : action.type === 'poll.open' ? action.poll.pollId : null
      const boardPoll = boardPollId === null ? undefined : session.polls[boardPollId]
      const changedBoard = boardPoll?.type === 'board' ? boardPoll : null
      if ((action.type === 'question.answer' || action.type === 'switches.set') && !prior && !this.saveFeedback()) {
        // Storage refused the feedback row: memory is back to storage, so the operation did not happen.
        ack = { type: 'operation.ack', operationId: message.operationId, status: 'rejected', error: 'storage_failed' }
        delete recoveryState(session).operations[key]
      } else if (changedBoard && !prior && ack.status === 'confirmed' && !this.saveBoard(changedBoard.pollId)) {
        ack = { type: 'operation.ack', operationId: message.operationId, status: 'rejected', error: 'storage_failed' }
        delete recoveryState(session).operations[key]
      }
      this.save()
      if (!prior && ack.status === 'confirmed') {
        if (isPresenterBoardMessage(action)) {
          // A board operation changes one board: send that board, full to the presenter, public to the room.
          // A confirmed board operation always names a board poll.
          if (changedBoard) {
            this.broadcastPollState(changedBoard, 'presenter')
            this.broadcastPollState(changedBoard, 'audience')
          }
        } else if (action.type === 'question.answer') {
          this.sendToPresenters({ type: 'questions.state', questions: questionList(session) })
        } else if (action.type === 'switches.set') {
          this.broadcastSwitches()
          for (const slide of catchUp) this.sendToPresenters({ type: 'reaction.counts', ...slide })
        } else if (action.type === 'instant.show' || action.type === 'instant.clear') {
          this.broadcastSlideState({ type: 'instant.state', slide: session.instantSlide ?? null })
        } else for (const poll of Object.values(session.polls)) {
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
          presenter.deserializeAttachment<LiveSocketAttachment>()?.protocol === 2 ? record
            : { type: record.type, pollId: record.pollId, choice: record.choice })
        const poll = session.polls[message.pollId]
        this.broadcastPollState(poll, 'presenter')
        if (poll.visibility === 'live' || poll.revealed) this.broadcastPollState(poll, 'audience')
      }
      this.send(socket, ack)
      // Other tabs belonging to this anonymous participant share the same allowance.
      if (record) for (const peer of this.sockets('audience')) {
        const peerAttachment = peer.deserializeAttachment<LiveSocketAttachment>()
        if (peer !== socket && peerAttachment?.protocol === 2
          && peerAttachment.participantId === attachment.participantId) this.send(peer, ack)
      }
      return
    }
    if (attachment.role === 'audience' && attachment.participantId) {
      if (message.type === 'submission.invalid') {
        if ('pollId' in message) this.send(socket, { type: 'card.ack', submissionId: message.submissionId, pollId: message.pollId,
          status: 'rejected', error: message.error })
        else this.send(socket, { type: message.kind === 'reaction.send' ? 'reaction.ack' : 'question.ack',
          submissionId: message.submissionId, status: 'rejected', error: message.error })
        return
      }
      if (message.type === 'card.add' || message.type === 'card.edit' || message.type === 'card.withdraw') {
        this.handleCard(socket, attachment.participantId, message)
        return
      }
      if (message.type === 'reaction.send') {
        const { submissionId, type: _type, ...input } = message
        const outcome = acceptReaction(session, attachment.participantId, submissionId, input, Date.now())
        if (outcome.stored && !this.saveFeedback()) {
          this.send(socket, { type: 'reaction.ack', submissionId, status: 'rejected', error: 'storage_failed' })
          return
        }
        // Counts go out only when they changed. While reactions are paused, bookmarks are stored but
        // their counts wait for the resume.
        if (outcome.stored && audienceSwitches(session).reactionsAllowed) {
          this.sendToPresenters({ type: 'reaction.counts', slideId: input.slideId,
            counts: reactionCountsFor(session, input.slideId), records: outcome.records })
        }
        // The sender's receipt is the only thing an audience socket hears about a reaction.
        this.send(socket, outcome.ack)
        return
      }
      if (message.type === 'question.submit') {
        const { submissionId, type: _type, ...input } = message
        const outcome = acceptQuestion(session, attachment.participantId, submissionId, input, Date.now())
        if (outcome.stored && !this.saveFeedback()) {
          this.send(socket, { type: 'question.ack', submissionId, status: 'rejected', error: 'storage_failed' })
          return
        }
        if (outcome.question) this.sendToPresenters({ type: 'questions.state', questions: questionList(session) })
        this.send(socket, outcome.ack)
        return
      }
    }
    this.send(socket, { type: 'protocol.error', code: 'wrong_role' })
  }
}
