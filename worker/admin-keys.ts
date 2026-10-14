// Admin keys: one per computer (going live from several Macs, ticket 01, decision T1).
//
// The live service accepts an admin bearer that equals the value of
//   - the secret `ADMIN_SECRET` (the first computer, set up by 0.38.2 or earlier): computer id `legacy`;
//   - a secret `ADMIN_SECRET_<computer id>`: that computer.
//
// Computer id alphabet: lower-case ASCII letters and digits, 1 to 64 characters (`[a-z0-9]{1,64}`).
// One case only, so an id has exactly one spelling as a secret name, as a path segment
// (`DELETE /computers/<id>`) and as a table key. Three words are never a computer's id: `legacy`
// (the id of `ADMIN_SECRET` itself), and `self` and `join` (route words under `/computers/`). A
// secret named `ADMIN_SECRET_legacy`, `ADMIN_SECRET_self` or `ADMIN_SECRET_join` is therefore never
// accepted, like any other name outside the pattern (`ADMIN_SECRETS`, `XADMIN_SECRET_a`,
// `ADMIN_SECRET_`, `ADMIN_SECRET_Mac`, `ADMIN_SECRET_a_b`).
//
// Only a binding whose value is a string with something in it besides white space counts. Durable
// Object namespaces and any other non-string binding never count, and neither does
// `SESSION_SIGNING_SECRET` (its name does not fit).
//
// Whose word this is: a Worker cannot tell a secret from a plain-text var, both are strings in `env`.
// So ANY string bound under one of these names is trusted as an admin key, however it was bound.
// That is sound because only the holder of the account's Cloudflare token can bind anything to this
// Worker, and that holder can already replace the Worker's code and secrets. What TalkWeaver ships
// never binds plain text under these names: `wrangler.jsonc` and the built `upload-config.json`
// declare no `vars`, the upload sends Durable Object namespaces only, and keys are sent as
// `secret_text` (checked by scripts/test-live-service-upload.mjs).
//
// Comparison: the SHA-256 digest of the bearer against the digest of EVERY candidate, each with a
// constant-time equality, with no exit that depends on which candidate matched or whether one did.
// What is returned is the computer id, never a value; callers must not put the id, or which names
// exist, in a refusal.
import { constantTimeEqual, hashSecret } from './auth.ts'

/** The id of the computer that holds `ADMIN_SECRET` (set up by 0.38.2 or earlier). */
export const LEGACY_COMPUTER_ID = 'legacy'
export const LEGACY_ADMIN_SECRET_NAME = 'ADMIN_SECRET'
export const ADMIN_SECRET_PREFIX = 'ADMIN_SECRET_'

const COMPUTER_ID = /^[a-z0-9]{1,64}$/
const RESERVED_COMPUTER_IDS = new Set([LEGACY_COMPUTER_ID, 'self', 'join'])

/** An id a computer can have under `ADMIN_SECRET_<id>` (so: never `legacy`). */
export function validComputerId(value: unknown): value is string {
  return typeof value === 'string' && COMPUTER_ID.test(value) && !RESERVED_COMPUTER_IDS.has(value)
}

/** An id a line in the list of computers can have: `legacy` or a computer's own id. */
export function validListedComputerId(value: unknown): value is string {
  return value === LEGACY_COMPUTER_ID || validComputerId(value)
}

/** The name of the secret that holds a computer's admin key. */
export function adminSecretName(computerId: string): string {
  return computerId === LEGACY_COMPUTER_ID ? LEGACY_ADMIN_SECRET_NAME : ADMIN_SECRET_PREFIX + computerId
}

/** The computer a binding name belongs to, or null when the name is not an admin key's. */
export function computerIdForSecretName(name: string): string | null {
  if (name === LEGACY_ADMIN_SECRET_NAME) return LEGACY_COMPUTER_ID
  if (!name.startsWith(ADMIN_SECRET_PREFIX)) return null
  const id = name.slice(ADMIN_SECRET_PREFIX.length)
  return validComputerId(id) ? id : null
}

interface AdminKey {
  computerId: string
  value: string
}

/** Every admin key in `env`, `legacy` first, then by computer id: the same order for the same bindings. */
function adminKeys(env: object): AdminKey[] {
  const keys: AdminKey[] = []
  for (const name of Object.keys(env).sort()) {
    const computerId = computerIdForSecretName(name)
    if (computerId === null) continue
    const value = (env as Record<string, unknown>)[name]
    // A secret that is unset, empty or only white space is no key (digests compare trimmed values).
    if (typeof value !== 'string' || value.trim().length === 0) continue
    keys.push({ computerId, value })
  }
  // 'ADMIN_SECRET' sorts before every 'ADMIN_SECRET_…' name, so legacy is first when present.
  return keys
}

/**
 * The bearer of an `Authorization: Bearer <value>` header, trimmed; null when the header is
 * missing, is not the Bearer scheme, or carries nothing.
 */
export function adminBearer(request: Request): string | null {
  const header = request.headers.get('authorization')
  if (header === null) return null
  const match = /^Bearer\s+(.*)$/is.exec(header)
  const bearer = match ? match[1].trim() : ''
  return bearer.length > 0 ? bearer : null
}

/**
 * The computer whose admin key the bearer is, or null. Every candidate is hashed and compared
 * whether or not an earlier one matched. Should two computers ever hold the same value, the first
 * in order (legacy, then by id) is the one named.
 */
export async function matchAdminKey(bearer: string | null, env: object): Promise<string | null> {
  if (typeof bearer !== 'string' || bearer.trim().length === 0) return null
  const presented = await hashSecret(bearer)
  let matched: string | null = null
  for (const key of adminKeys(env)) {
    const equal = constantTimeEqual(presented, await hashSecret(key.value))
    if (equal && matched === null) matched = key.computerId
  }
  return matched
}
