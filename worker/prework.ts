// Pre-work and post-work for a planned Run (ADR-0032 amendment point 2; feedback-boards ticket 09; ADR-0040,
// work files ticket 12): the Durable Object that holds one phase of one Run's work (its form and its
// anonymous answers), and the entry Worker's routes into it. The app makes one object per Run and phase.
// Modelled on the shared talk and the Run's share link (run-share.ts): an admin-created id, an owner
// token of its own role, the owner check and each route's body cap in the entry Worker before any
// body is read, and the public routes refusing any credential.
//
//   POST /prework                      admin → 201 {preworkId, ownerToken}
//   GET  /prework/<id>                 public: {state, phase, opensAt, closesAt, people?} (404 until pushed)
//   POST /prework/<id>/submit          public: one read, answer, done mark or question
//   POST /prework/<id>/mine            public: {participantId} → that device's own entries
//   PUT  /prework/<id>/form            owner: {phase, opensAt, closesAt, form?}; a later close reopens;
//                                      no form: only the window changes
//   GET  /prework/<id>/results?after=  owner: entries after a sequence number, a page at a time, with
//                                      {state, phase} named as the status names them
//   GET  /prework/<id>/waiting?after=  owner: {seq, waiting}: how many answers and questions changed
//                                      after the sequence number; no entry is read out
//   POST /prework/<id>/close           owner (or admin): close now; a later closing time pushed by the
//                                      owner reopens the owner's close, never the admin's
//   POST /prework/<id>/withdraw        owner: {withdrawn?} — public routes answer 404 not_available;
//                                      {withdrawn: false} serves it again; answers stay for the owner
//
// With no push and no submission for 60 days the object deletes everything and keeps a tombstone.
import { createPreworkOwnerToken, verifyPreworkOwnerToken } from './auth'
import { adminAuthorised, bearerToken, errorResponse, jsonResponse, readBoundedBytes, readJsonBody, type Env } from './http'
import { signingKey } from './signing-key'
import {
  PREWORK_IDLE_PURGE_MS, PREWORK_LIMITS, parsePreworkFormPush, parsePreworkWithdraw, preworkSourceKey, parsePreworkRoute, parsePreworkSubmission, preworkBodyLimit,
  preworkRouteIsPublic, preworkRouteMethod, validParticipantId, type PreworkEntry, type PreworkRoute,
} from './prework-protocol'
import {
  PreworkError, closePrework, createPrework, isWithdrawn, notAvailable, ownEntry, parseAfter, participantState, preworkStatus, purgeDueAt, pushForm, resultsPage,
  shouldPurge, submitPrework, waitingCount, withdrawPrework, type ParticipantRow, type PreworkStore, type SourceRow, type StoredPrework,
} from './prework-state'
import { isShareId, SHARE_ID_LENGTH } from './share-id'
import { generateShortId } from './short-id'

export { parsePreworkRoute }

const INTERNAL_HOST = 'internal'

function preworkStub(env: Env, preworkId: string): DurableObjectStub {
  return env.RUN_PREWORK.get(env.RUN_PREWORK.idFromName(preworkId))
}

/** The idle purge window: 60 days, or a shorter one a local test Worker is started with. */
function idleMs(env: Env): number {
  const override = Number(env.PREWORK_IDLE_PURGE_MS)
  return Number.isSafeInteger(override) && override > 0 ? override : PREWORK_IDLE_PURGE_MS
}

/** `POST /prework` (admin bearer) → `201 {preworkId, ownerToken}`. Nothing is served until the first push. */
export async function createRunPrework(request: Request, env: Env): Promise<Response> {
  if (!await adminAuthorised(request, env)) return errorResponse('admin_auth_required', 'Admin authentication is required.', 401)
  // Before anything is made: pre-work whose token could not be signed is never left behind.
  const key = await signingKey(env)
  let preworkId = ''
  for (let attempt = 0; attempt < 5 && !preworkId; attempt += 1) {
    const candidate = generateShortId(undefined, SHARE_ID_LENGTH)
    if (!isShareId(candidate)) continue
    const init = await preworkStub(env, candidate).fetch(new Request(`https://${INTERNAL_HOST}/internal/init`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ preworkId: candidate, createdAt: Date.now() }),
    }))
    if (init.ok) preworkId = candidate
    else if (init.status !== 409) return init
  }
  if (!preworkId) return errorResponse('id_exhausted', 'Could not allocate pre-work. Try again.', 503)
  const ownerToken = await createPreworkOwnerToken({ role: 'prework-owner', preworkId, iat: Date.now() }, key)
  return jsonResponse({ preworkId, ownerToken }, 201)
}

/**
 * Route a parsed pre-work request to its object. The method, the credential rule (public routes take
 * none; owner routes need the pre-work owner token, close also the admin secret) and the body cap are
 * all enforced here before the object is reached or any body read.
 */
export async function forwardToPrework(request: Request, env: Env, route: PreworkRoute): Promise<Response> {
  if (request.method !== preworkRouteMethod(route)) return errorResponse('method_not_allowed', 'Method not allowed.', 405)
  const url = new URL(request.url)
  if (preworkRouteIsPublic(route)) {
    if (request.headers.has('authorization') || url.searchParams.has('token')) {
      return errorResponse('credentials_not_allowed', 'This route is public and takes no credentials.', 400)
    }
  } else {
    const owner = await verifyPreworkOwnerToken(bearerToken(request), await signingKey(env), route.preworkId)
    if (!owner && !(route.action === 'close' && await adminAuthorised(request, env))) {
      return errorResponse('owner_auth_required', 'Owner authentication is required.', 401)
    }
  }
  // The network source for the object's per-source limits: the connecting IP (Cloudflare sets it;
  // a local test Worker has none, so every request there is one source). Set here, never taken from
  // the client: any header of this name the client sent is replaced.
  // An IPv6 address counts by its /64 (one host holds a whole /64). The header is set only on the
  // request forwarded below, whose body is the bounded bytes already read: the incoming request is
  // never rewrapped, so an oversized body is refused (413) unread, as on every other route.
  const connecting = request.headers.get('cf-connecting-ip')
  if (!connecting && route.action === 'submit' && env.PREWORK_LOCAL_SOURCE !== '1') {
    return errorResponse('source_unknown', 'Pre-work cannot tell where this came from. Try again in a moment.', 503)
  }
  const target = new URL(request.url)
  target.pathname = route.action === 'status' ? `/prework/${route.preworkId}` : `/prework/${route.preworkId}/${route.action}`
  target.search = route.action === 'results' || route.action === 'waiting' ? `?after=${parseAfter(url.searchParams.get('after'))}` : ''
  const headers = new Headers(request.headers)
  headers.set('x-tw-prework-source', connecting ? preworkSourceKey(connecting) : 'local')
  const limit = preworkBodyLimit(route)
  if (limit === null || !request.body) {
    headers.delete('content-length')
    headers.delete('transfer-encoding')
    return preworkStub(env, route.preworkId).fetch(new Request(target.toString(), { method: request.method, headers }))
  }
  const bytes = await readBoundedBytes(request, limit)
  if (!bytes) return errorResponse('body_too_large', 'The request body is too large.', 413)
  headers.set('content-length', String(bytes.byteLength))
  return preworkStub(env, route.preworkId).fetch(new Request(target.toString(), { method: request.method, headers, body: bytes as Uint8Array<ArrayBuffer> }))
}

async function participantKey(preworkId: string, participantId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${preworkId}:${participantId}`))
  return [...new Uint8Array(digest).slice(0, 8)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

class SqlPreworkStore implements PreworkStore {
  constructor(private readonly sql: SqlStorage) {}

  submission(submissionId: string) {
    const row = [...this.sql.exec<{ fingerprint: string; entry_id: string }>('SELECT fingerprint, entry_id FROM submissions WHERE submission_id = ?', submissionId)][0]
    return row ? { fingerprint: row.fingerprint, entryId: row.entry_id } : null
  }

  putSubmission(submissionId: string, fingerprint: string, entryId: string): void {
    this.sql.exec('INSERT INTO submissions (submission_id, fingerprint, entry_id) VALUES (?, ?, ?) ON CONFLICT(submission_id) DO NOTHING', submissionId, fingerprint, entryId)
  }

  entry(entryId: string): PreworkEntry | null {
    const row = [...this.sql.exec<{ value: string }>('SELECT value FROM entries WHERE entry_id = ?', entryId)][0]
    return row ? JSON.parse(row.value) as PreworkEntry : null
  }

  putEntry(entry: PreworkEntry): void {
    this.sql.exec('INSERT INTO entries (entry_id, seq, participant, value) VALUES (?, ?, ?, ?) ON CONFLICT(entry_id) DO UPDATE SET seq = excluded.seq, value = excluded.value',
      entry.id, entry.seq, entry.participant, JSON.stringify(entry))
  }

  participant(key: string): ParticipantRow | null {
    const row = [...this.sql.exec<{ value: string }>('SELECT value FROM participants WHERE key = ?', key)][0]
    return row ? JSON.parse(row.value) as ParticipantRow : null
  }

  putParticipant(row: ParticipantRow): void {
    this.sql.exec('INSERT INTO participants (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', row.key, JSON.stringify(row))
  }

  entriesAfter(after: number, limit: number): PreworkEntry[] {
    return [...this.sql.exec<{ value: string }>('SELECT value FROM entries WHERE seq > ? ORDER BY seq LIMIT ?', after, limit)].map((row) => JSON.parse(row.value) as PreworkEntry)
  }

  source(key: string): SourceRow | null {
    const row = [...this.sql.exec<{ value: string }>('SELECT value FROM sources WHERE key = ?', key)][0]
    return row ? JSON.parse(row.value) as SourceRow : null
  }

  putSource(row: SourceRow): void {
    this.sql.exec('INSERT INTO sources (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', row.key, JSON.stringify(row))
  }

  participantEntries(key: string): PreworkEntry[] {
    return [...this.sql.exec<{ value: string }>('SELECT value FROM entries WHERE participant = ?', key)].map((row) => JSON.parse(row.value) as PreworkEntry)
  }

  responsesAfter(after: number): number {
    // An entry id is `<16 hex>:<kind>:…`: answers are `…:answer:<step>`, questions `…:q:<submission>`.
    const row = [...this.sql.exec<{ n: number }>(
      "SELECT COUNT(*) AS n FROM entries WHERE seq > ? AND (entry_id LIKE '________________:answer:%' OR entry_id LIKE '________________:q:%')", after)][0]
    return Number(row?.n ?? 0)
  }
}

function noStore(response: Response): Response {
  response.headers.set('cache-control', 'no-store')
  return response
}

export class RunPrework {
  private readonly ctx: DurableObjectState
  private readonly env: Env
  private readonly store: SqlPreworkStore
  private prework: StoredPrework | null = null
  /** A purged object keeps its id only, so its link says "gone" rather than "unknown". */
  private tombstone: string | null = null

  constructor(state: DurableObjectState, env: Env) {
    this.ctx = state
    this.env = env
    const sql = state.storage.sql
    sql.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    sql.exec('CREATE TABLE IF NOT EXISTS submissions (submission_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, entry_id TEXT NOT NULL)')
    sql.exec('CREATE TABLE IF NOT EXISTS entries (entry_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, participant TEXT NOT NULL, value TEXT NOT NULL)')
    sql.exec('CREATE INDEX IF NOT EXISTS entries_seq ON entries (seq)')
    sql.exec('CREATE INDEX IF NOT EXISTS entries_participant ON entries (participant)')
    sql.exec('CREATE TABLE IF NOT EXISTS participants (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    sql.exec('CREATE TABLE IF NOT EXISTS sources (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    this.store = new SqlPreworkStore(sql)
    state.blockConcurrencyWhile(async () => {
      this.prework = this.readJson<StoredPrework>('prework')
      this.tombstone = this.readJson<string>('tombstone')
    })
  }

  private readJson<T>(key: string): T | null {
    const row = [...this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM kv WHERE key = ?', key)][0]
    return row ? JSON.parse(row.value) as T : null
  }

  private save(): void {
    if (!this.prework) return
    this.ctx.storage.sql.exec('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', 'prework', JSON.stringify(this.prework))
  }

  /** Arm the idle purge from the last activity. */
  private async arm(): Promise<void> {
    if (this.prework) await this.ctx.storage.setAlarm(purgeDueAt(this.prework, idleMs(this.env)))
  }

  /** Delete every answer, the form and the metadata; keep the id only. */
  private async purge(): Promise<void> {
    if (!this.prework) return
    const id = this.prework.preworkId
    const sql = this.ctx.storage.sql
    sql.exec('DELETE FROM submissions')
    sql.exec('DELETE FROM entries')
    sql.exec('DELETE FROM participants')
    sql.exec('DELETE FROM sources')
    sql.exec('DELETE FROM kv')
    sql.exec('INSERT INTO kv (key, value) VALUES (?, ?)', 'tombstone', JSON.stringify(id))
    this.tombstone = id
    this.prework = null
    await this.ctx.storage.deleteAlarm()
  }

  /**
   * Run `fn` as one storage transaction where the runtime offers it. If it throws, the metadata in
   * memory is reloaded from storage, so memory never runs ahead of what was stored.
   */
  private atomically<T>(fn: () => T): T {
    try {
      const storage = this.ctx.storage
      return storage.transactionSync ? storage.transactionSync(fn) : fn()
    } catch (error) {
      // A refusal (PreworkError) wrote nothing and changed nothing in memory: keep the object, so
      // requests in flight keep one metadata object between them.
      if (!(error instanceof PreworkError)) this.prework = this.readJson<StoredPrework>('prework')
      throw error
    }
  }

  private preworkError(error: unknown): Response {
    if (!(error instanceof PreworkError)) {
      // Anything unexpected (storage contention, a malformed row) is a plain, retryable 503, never a
      // 500; memory is reloaded from storage first so it never runs ahead of it.
      console.error('[prework] unexpected error', error)
      try { this.prework = this.readJson<StoredPrework>('prework') } catch { /* storage unreadable: the next request reloads */ }
      const response = errorResponse('prework_unavailable', 'Pre-work is busy. Try again in a moment.', 503)
      response.headers.set('retry-after', '2')
      return response
    }
    const response = errorResponse(error.code, error.message, error.status, error.details)
    if (typeof error.details.retryAfterMs === 'number') response.headers.set('retry-after', String(Math.ceil(error.details.retryAfterMs / 1_000)))
    // "Not available" is never cached, like the status it stands in for: published again, the work is
    // seen again at once.
    return error.code === 'not_available' ? noStore(response) : response
  }

  async fetch(request: Request): Promise<Response> {
    try {
      return await this.handle(request)
    } catch (error) {
      return this.preworkError(error)
    }
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.hostname === INTERNAL_HOST && url.pathname === '/internal/init' && request.method === 'POST') {
      if (this.prework || this.tombstone) return errorResponse('already_exists', 'Pre-work already exists.', 409)
      const body = await request.json().catch(() => null) as { preworkId?: unknown; createdAt?: unknown } | null
      if (!isShareId(body?.preworkId) || !Number.isSafeInteger(body?.createdAt)) return errorResponse('invalid_prework', 'Pre-work details are invalid.', 400)
      this.prework = createPrework(body!.preworkId as string, Number(body!.createdAt))
      this.save()
      await this.arm()
      return jsonResponse({ ok: true }, 201)
    }
    const route = parsePreworkRoute(url.pathname)
    if (!route) return errorResponse('not_found', 'Route not found.', 404)
    const now = Date.now()
    if (this.prework && shouldPurge(this.prework, now, idleMs(this.env))) await this.purge()
    if (!this.prework && this.tombstone === route.preworkId) return errorResponse('prework_gone', 'This pre-work has been deleted.', 410)
    if (!this.prework || this.prework.preworkId !== route.preworkId) return errorResponse('not_found', 'Pre-work not found.', 404)
    const prework = this.prework

    // Owner routes: checked again here (the entry Worker checked first). Close also takes the admin
    // secret; who closed is kept, since only the owner's close is lifted by a later closing time.
    let closedBy: 'owner' | 'admin' = 'owner'
    if (!preworkRouteIsPublic(route)) {
      const owner = await verifyPreworkOwnerToken(bearerToken(request), await signingKey(this.env), prework.preworkId)
      if (!owner) {
        if (!(route.action === 'close' && await adminAuthorised(request, this.env))) {
          return errorResponse('owner_auth_required', 'Owner authentication is required.', 401)
        }
        closedBy = 'admin'
      }
    }

    try {
      // Withdrawn: every public route says "not available", before any body is read; the owner's stay.
      if (preworkRouteIsPublic(route) && isWithdrawn(prework)) throw notAvailable()
      switch (route.action) {
        case 'status': {
          const status = preworkStatus(prework, now)
          return noStore(status ? jsonResponse(status) : errorResponse('not_found', 'Pre-work not found.', 404))
        }
        case 'submit': {
          const body = await readJsonBody(request, PREWORK_LIMITS.submitBytes)
          if ('tooLarge' in body) return errorResponse('submission_too_large', 'The submission is too large.', 413)
          if ('invalid' in body) return errorResponse('invalid_submission', 'The submission must be JSON.', 400)
          const parsed = parsePreworkSubmission(body.value)
          if ('error' in parsed) return errorResponse(parsed.error.code, parsed.error.message, 400)
          const key = await participantKey(prework.preworkId, parsed.value.participantId)
          // The source is kept only as a hash, like the participant.
          const source = await participantKey(prework.preworkId, `source:${request.headers.get('x-tw-prework-source') ?? 'local'}`)
          // One transaction: the reducer's writes and the metadata land together or not at all.
          const result = this.atomically(() => {
            // The metadata as it is NOW (after the awaits above), never a copy taken before them.
            const current = this.prework
            if (!current || current.preworkId !== route.preworkId) throw new PreworkError('not_found', 'Pre-work not found.', 404)
            const outcome = submitPrework(current, this.store, key, parsed.value, Date.now(), source)
            this.save()
            return outcome
          })
          if (result.changed) await this.arm()
          return jsonResponse({ entry: ownEntry(result.entry), changed: result.changed }, result.changed ? 201 : 200)
        }
        case 'mine': {
          const body = await readJsonBody(request, PREWORK_LIMITS.mineBytes)
          const participantId = 'value' in body ? (body.value as { participantId?: unknown } | null)?.participantId : undefined
          if (!validParticipantId(participantId)) return errorResponse('invalid_participant', 'participantId is required.', 400)
          if (!preworkStatus(prework, now)) return errorResponse('not_found', 'Pre-work not found.', 404)
          return noStore(jsonResponse({ entries: participantState(this.store, await participantKey(prework.preworkId, participantId)) }))
        }
        case 'form': {
          const body = await readJsonBody(request, PREWORK_LIMITS.formBytes)
          if ('tooLarge' in body) return errorResponse('form_too_large', 'The form is too large.', 413)
          if ('invalid' in body) return errorResponse('invalid_push', 'The form must be JSON.', 400)
          const parsed = parsePreworkFormPush(body.value, now)
          if ('error' in parsed) return errorResponse(parsed.error.code, parsed.error.message, 400)
          // A refused push (another phase, or a window-only push before any form) changes nothing:
          // pushForm checks before it writes.
          pushForm(this.prework ?? prework, parsed.value, now)
          this.save()
          await this.arm()
          return jsonResponse({ ok: true, status: preworkStatus(this.prework ?? prework, now) })
        }
        case 'results':
          return noStore(jsonResponse(resultsPage(prework, this.store, parseAfter(url.searchParams.get('after')), now)))
        case 'waiting':
          return noStore(jsonResponse(waitingCount(prework, this.store, parseAfter(url.searchParams.get('after')))))
        case 'close': {
          // The metadata as it is NOW (after the owner check's await), as the form push does.
          const closedAt = closePrework(this.prework ?? prework, now, closedBy)
          this.save()
          return jsonResponse({ ok: true, closedAt })
        }
        case 'withdraw': {
          const bytes = await readBoundedBytes(request, PREWORK_LIMITS.withdrawBytes)
          if (!bytes) return errorResponse('body_too_large', 'The request body is too large.', 413)
          // An empty body withdraws; JSON that is not {withdrawn: boolean} is refused.
          const raw = new TextDecoder().decode(bytes).trim()
          let withdrawn: boolean | null = null
          try { withdrawn = parsePreworkWithdraw(raw ? JSON.parse(raw) : undefined) } catch { withdrawn = null }
          if (withdrawn === null) return errorResponse('invalid_withdraw', 'The body is empty or {"withdrawn": true|false}.', 400)
          // The metadata as it is NOW (after the awaits above), as the form push does.
          const withdrawnAt = withdrawPrework(this.prework ?? prework, withdrawn, now)
          this.save()
          return jsonResponse({ ok: true, withdrawn, ...(withdrawnAt !== null ? { withdrawnAt } : {}) })
        }
      }
    } catch (error) {
      return this.preworkError(error)
    }
  }

  async alarm(): Promise<void> {
    if (!this.prework) return
    if (shouldPurge(this.prework, Date.now(), idleMs(this.env))) await this.purge()
    else await this.arm()
  }
}
