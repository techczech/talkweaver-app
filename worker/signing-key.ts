// The signing key: the HMAC key behind presenter tokens and the three kinds of owner token
// (going live from several Macs, decision R1: the app never handles it).
//
// `signingKey(env)` is the one way the rest of the Worker gets it:
//   - `env.SESSION_SIGNING_SECRET`, when it is a string with something in it besides white space.
//     That is every live service set up by 0.38.2 or earlier. The value is used exactly as bound
//     (never trimmed), so tokens made before this build verify as before. The registry is then
//     neither asked nor written: no second key is made beside the env one.
//   - otherwise, the key the singleton `SessionRegistry` object keeps in its `signing_key` table. The
//     object makes it on the first request (32 random bytes, base64url) and it is never replaced.
//
// If someone deletes the env secret by hand, tokens issued under it stop verifying and the registry's
// key takes over; the env value is never copied into storage.
//
// Rules this file holds (each has a test in signing-key.test.ts):
//   - env is looked at on every call; only the registry's value is remembered, per isolate.
//   - the registry's read-then-insert is one synchronous stretch (`SigningKeyTable.fetchOrCreate` has
//     no `await`), so two first requests get the same key.
//   - only an empty table makes a key. A read that fails, or a stored value that is not a key,
//     throws; nothing is generated or written over it.
//   - the key leaves the registry object on one internal route, `POST /internal/signing-key`, that
//     only this file builds a request for. The entry Worker never forwards a public request there:
//     the only public request it passes to the registry is `GET /session/<slug>`, rebuilt as a
//     request of its own (index.ts).
//   - the key is never logged and never put in an error's text.
import { errorResponse, jsonResponse, registryStub, type Env } from './http'

const SIGNING_KEY_PATH = '/internal/signing-key'
const SIGNING_KEY_BYTES = 32
/** 32 bytes as unpadded base64url: exactly what `SigningKeyTable` writes, and all it will read back. */
const STORED_KEY = /^[A-Za-z0-9_-]{43}$/

/** The env signing secret as bound, or null when it is absent, not a string, empty or only white space. */
export function envSigningSecret(env: { SESSION_SIGNING_SECRET?: unknown }): string | null {
  const value = env.SESSION_SIGNING_SECRET
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function generateKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SIGNING_KEY_BYTES))
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/** The `signing_key` table of the `SessionRegistry` object: no row, or the one row that holds the key. */
export class SigningKeyTable {
  private readonly sql: SqlStorage

  constructor(sql: SqlStorage) {
    this.sql = sql
    // No migration tag: the table is made the first time this build's registry object starts.
    // `id = 1` is the only row the table can hold, and a plain INSERT never replaces it.
    sql.exec('CREATE TABLE IF NOT EXISTS signing_key (id INTEGER PRIMARY KEY CHECK (id = 1), key TEXT NOT NULL, created_at INTEGER NOT NULL)')
  }

  /**
   * The stored key, made first when the table is empty. Synchronous on purpose: a Durable Object runs
   * one stretch of synchronous code at a time, so nothing can come between the read and the insert.
   * Throws when the read fails or the stored value is not a key; it never makes a second one.
   */
  fetchOrCreate(): string {
    const rows = [...this.sql.exec<{ key: unknown }>('SELECT key FROM signing_key')]
    if (rows.length > 1) throw new Error('The signing key table holds more than one row.')
    if (rows.length === 1) {
      const stored = rows[0].key
      if (typeof stored !== 'string' || !STORED_KEY.test(stored)) throw new Error('The stored signing key is not readable.')
      return stored
    }
    const made = generateKey()
    this.sql.exec('INSERT INTO signing_key (id, key, created_at) VALUES (1, ?, ?)', made, Date.now())
    return made
  }

  /** The registry object's side of the route. Null when the path is not this table's. Synchronous. */
  route(request: Request, url: URL): Response | null {
    if (url.pathname !== SIGNING_KEY_PATH) return null
    if (request.method !== 'POST') return errorResponse('not_found', 'Registry route not found.', 404)
    try {
      return jsonResponse({ key: this.fetchOrCreate() })
    } catch (error) {
      // The error's name only: storage errors are not trusted to leave bound values out of their text.
      console.error('[signing-key] the registry could not read or keep its key:', error instanceof Error ? error.name : 'error')
      return errorResponse('signing_key_unavailable', 'The live service could not read its signing key.', 500)
    }
  }
}

/** Thrown when there is no env secret and the registry did not hand over its key. Carries no key. */
export class SigningKeyUnavailable extends Error {
  constructor(reason: string) {
    super(`The live service could not read its signing key (${reason}).`)
    this.name = 'SigningKeyUnavailable'
  }
}

// The registry's key, per isolate, by the registry namespace it came from (one per isolate in a real
// Worker; one per service in the unit tests). The key is made once and never replaced, so a
// remembered value cannot go stale. A failed fetch is never remembered.
const registryKeys = new WeakMap<object, string>()

/**
 * The key to sign and verify tokens with. Callable from the entry Worker and from any Durable Object
 * other than the registry itself (they all hold `env`). Throws `SigningKeyUnavailable`, never returns
 * an empty or made-up key.
 */
export async function signingKey(env: Env): Promise<string> {
  // Every call: a remembered registry key never stands in for an env secret that is there.
  const fromEnv = envSigningSecret(env)
  if (fromEnv !== null) return fromEnv

  const namespace = env.SESSION_REGISTRY
  const remembered = registryKeys.get(namespace)
  if (remembered !== undefined) return remembered

  let response: Response
  try {
    response = await registryStub(env).fetch(new Request(`https://internal${SIGNING_KEY_PATH}`, { method: 'POST' }))
  } catch {
    throw new SigningKeyUnavailable('the registry could not be reached')
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new SigningKeyUnavailable(`the registry answered ${response.status}`)
  }
  const body = await response.json().catch(() => null) as { key?: unknown } | null
  const key = body?.key
  if (typeof key !== 'string' || !STORED_KEY.test(key)) throw new SigningKeyUnavailable('the registry answered without a key')
  registryKeys.set(namespace, key)
  return key
}
