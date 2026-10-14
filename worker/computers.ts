// The list of computers that can go live (going live from several Macs, ticket 01).
//
// One line per computer: its id, the name its owner sees, when it was first recorded and whether it
// joined with a joining code. The list holds no key and nothing made from one: a computer's admin
// key is a Worker secret (`admin-keys.ts`), and the only thing taken from it here is the id of the
// computer it belongs to.
//
// Public routes, all admin only (`computersRoute`, called by the entry Worker):
//   GET    /computers        the list, and which line is the caller's (`self`)
//   POST   /computers/self   {"name": "..."}: record the calling computer, or rename it
//   DELETE /computers/<id>   remove a line. The line only: the computer's key is a Cloudflare
//                            secret, and removing that is the app's job, through Cloudflare.
//
// The lines live in the `SessionRegistry` object's `computers` table (`ComputersTable`), reached
// over `/internal/computers…`, which only this file builds requests for.
import { validListedComputerId } from './admin-keys'
import { adminAuthorised, errorResponse, jsonResponse, readJsonBody, registryStub, type Env } from './http'

export interface ComputerLine {
  id: string
  name: string
  /** When the line was first recorded (ms since 1970). A rename keeps it. */
  joinedAt: number
  /** True when the computer joined with a joining code; false for first set-up and for joining without one. */
  joinedWithCode: boolean
}

export const COMPUTER_NAME_MAX = 64
/** A `{"name": …}` body: 64 characters are at most 256 bytes of UTF-8, plus JSON escaping. */
const NAME_BODY_MAX_BYTES = 1024
// Not in a name: control, format (bidirectional overrides, zero-width), lone surrogate, private-use
// and unassigned characters, and line and paragraph separators. Letters, digits, punctuation, symbols
// and spaces of any script are allowed; whoever renders a name escapes it.
const NAME_FORBIDDEN = /[\p{C}\p{Zl}\p{Zp}]/u

/** A computer's name as it is stored: trimmed, 1 to 64 characters, one line. Null when it is not one. */
export function parseComputerName(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > COMPUTER_NAME_MAX * 8) return null
  const name = value.trim()
  if (NAME_FORBIDDEN.test(name)) return null
  const length = [...name].length
  return length >= 1 && length <= COMPUTER_NAME_MAX ? name : null
}

interface ComputerRow {
  id: string
  name: string
  joined_at: number
  joined_with_code: number
}

/** The `computers` table of the `SessionRegistry` object. */
export class ComputersTable {
  private readonly sql: SqlStorage

  constructor(sql: SqlStorage) {
    this.sql = sql
    // No migration tag: the table is made the first time this build's registry object starts.
    sql.exec('CREATE TABLE IF NOT EXISTS computers (id TEXT PRIMARY KEY, name TEXT NOT NULL, joined_at INTEGER NOT NULL, joined_with_code INTEGER NOT NULL)')
  }

  list(): ComputerLine[] {
    const rows = this.sql.exec<ComputerRow>('SELECT id, name, joined_at, joined_with_code FROM computers ORDER BY joined_at, id')
    return [...rows].map((row) => ({ id: row.id, name: row.name, joinedAt: Number(row.joined_at), joinedWithCode: Number(row.joined_with_code) === 1 }))
  }

  get(id: string): ComputerLine | null {
    return this.list().find((line) => line.id === id) ?? null
  }

  /** Record a computer, or rename it: an existing line keeps when and how it joined. */
  record(id: string, name: string, now: number): ComputerLine {
    this.sql.exec(
      'INSERT INTO computers (id, name, joined_at, joined_with_code) VALUES (?, ?, ?, 0) ON CONFLICT(id) DO UPDATE SET name = excluded.name',
      id, name, now,
    )
    return this.get(id)!
  }

  remove(id: string): void {
    this.sql.exec('DELETE FROM computers WHERE id = ?', id)
  }

  /** The registry object's side of the routes. Null when the path is not this table's. */
  async route(request: Request, url: URL): Promise<Response | null> {
    if (url.pathname === '/internal/computers') {
      return request.method === 'GET' ? jsonResponse({ computers: this.list() }) : errorResponse('not_found', 'Registry route not found.', 404)
    }
    const match = url.pathname.match(/^\/internal\/computers\/([^/]+)$/)
    if (!match) return null
    const id = match[1]
    if (!validListedComputerId(id)) return errorResponse('invalid_computer_id', 'That is not a computer on this list.', 400)
    if (request.method === 'PUT') {
      const body = await request.json().catch(() => null) as { name?: unknown } | null
      const name = parseComputerName(body?.name)
      if (name === null) return invalidName()
      return jsonResponse({ computer: this.record(id, name, Date.now()) })
    }
    if (request.method === 'DELETE') {
      this.remove(id)
      return jsonResponse({ ok: true })
    }
    return errorResponse('not_found', 'Registry route not found.', 404)
  }
}

function invalidName(): Response {
  return errorResponse('invalid_computer_name', `Give the computer a name of 1 to ${COMPUTER_NAME_MAX} characters on one line.`, 400)
}

function internalUrl(id?: string): string {
  return `https://internal/internal/computers${id === undefined ? '' : `/${id}`}`
}

/**
 * The entry Worker's side: the three public routes, or null when the request is not one of them.
 * The admin check comes before anything is read from the request or said about it.
 */
export async function computersRoute(request: Request, env: Env, url: URL): Promise<Response | null> {
  const list = url.pathname === '/computers' && request.method === 'GET'
  const self = url.pathname === '/computers/self' && request.method === 'POST'
  const remove = request.method === 'DELETE' ? url.pathname.match(/^\/computers\/([^/]+)$/) : null
  if (!list && !self && !remove) return null

  const caller = await adminAuthorised(request, env)
  if (!caller) return errorResponse('admin_auth_required', 'Admin authentication is required.', 401)

  if (list) {
    const response = await registryStub(env).fetch(new Request(internalUrl()))
    if (!response.ok) return response
    const { computers } = await response.json() as { computers: ComputerLine[] }
    return jsonResponse({ computers, self: caller })
  }
  if (self) {
    const body = await readJsonBody(request, NAME_BODY_MAX_BYTES)
    if ('tooLarge' in body) return errorResponse('body_too_large', 'That is too much for a computer name.', 413)
    const name = 'value' in body && body.value && typeof body.value === 'object' ? parseComputerName((body.value as { name?: unknown }).name) : null
    if (name === null) return invalidName()
    // The id is the one the caller's key belongs to, never one the request names.
    return registryStub(env).fetch(new Request(internalUrl(caller), {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
    }))
  }
  const id = remove![1]
  if (!validListedComputerId(id)) return errorResponse('invalid_computer_id', 'That is not a computer on this list.', 400)
  return registryStub(env).fetch(new Request(internalUrl(id), { method: 'DELETE' }))
}
