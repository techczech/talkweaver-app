// A stand-in for the deployed live service, as the app meets it at its workers.dev address: the
// routes the set-up sequence and Go live use, answered from the fake Cloudflare API's model
// (cloudflare-api-stub.mjs), so a secret set or removed through the fake API is accepted or refused
// here as the real Worker would (worker/admin-keys.ts: `ADMIN_SECRET` is the computer `legacy`,
// `ADMIN_SECRET_<id>` the computer <id>). No network.
//
//   GET  /capabilities      { protocol, build }
//   GET  /computers         admin: { computers, self }
//   POST /computers/self    admin: records or renames the caller
//   POST /sessions          admin: 201 { sessionId, presenterToken, … }
//   POST /shares            admin: 201 { shareId, ownerToken }       (a talk shared for comments)
//   POST /results           admin: 201 { shareId, ownerToken }       (a Run link)
//   POST /tokens/check      { token } → 200 { role, id }, or 401 when it was not signed with the
//                           signing key the live service has NOW
// A refused admin key is 401 `admin_auth_required`. An OLDER build (state.build) has no /computers
// routes (404) and takes only `ADMIN_SECRET`, like 0.38.2's.
//
// Tokens are real (decision R8): each is `<role>.<id>.<HMAC-SHA256 of "<role>.<id>" under the signing
// key>`, and /tokens/check verifies it. The signing key is the Worker's own, as worker/signing-key.ts
// has it: the secret `SESSION_SIGNING_SECRET` when Cloudflare holds a non-empty one for the Worker
// (a service 0.38.2 set up), otherwise a key the live service made for itself once and keeps
// (`worker.registryKey` in the fake's model; it goes when the Worker does). So anything that sets,
// replaces or removes the signing secret, or makes the Worker again, makes every earlier token fail
// its check: a test that keeps a token from before can SEE the damage.
//
// `state` is the test's to change: `build(worker)`, `unreachable`, `lag` (how many admin requests
// still see the secrets as they were before the last change: propagation), `computers`.
// `requests` records method, route and whether a bearer came, never the bearer.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { computerIdForSecretName } from '../../worker/admin-keys.ts'
import { createComputerKeyStore } from '../../src/main/live-service-key.ts'

/** The signing key the live service has now: the env secret when one is set, else its own. */
function signingKeyOf(worker) {
  const secret = worker.values?.get('SESSION_SIGNING_SECRET')
  if (typeof secret === 'string' && secret.length > 0) return secret
  worker.registryKey ??= randomBytes(32).toString('base64url')
  return worker.registryKey
}
const mac = (key, text) => createHmac('sha256', key).update(text).digest('base64url')
const signed = (worker, role, id) => `${role}.${id}.${mac(signingKeyOf(worker), `${role}.${id}`)}`
function checked(worker, token) {
  const [role, id, tag, ...rest] = String(token ?? '').split('.')
  if (!role || !id || !tag || rest.length) return null
  const expected = Buffer.from(mac(signingKeyOf(worker), `${role}.${id}`))
  const given = Buffer.from(tag)
  return given.length === expected.length && timingSafeEqual(given, expected) ? { role, id } : null
}

export function liveWorkerDouble(fake, { account, name, address, build }) {
  const state = { build: () => build, unreachable: false, lag: 0, computers: [], clock: 1 }
  const requests = []
  let settled = new Map()
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    const method = init.method ?? 'GET'
    const bearer = /^Bearer (.+)$/.exec(new Headers(init.headers).get('authorization') ?? '')?.[1] ?? null
    requests.push({ method, route: url.pathname, search: url.search, bearer: bearer !== null })
    // `address: null`: whatever workers.dev subdomain the account has.
    const ours = address === null ? url.protocol === 'https:' && url.hostname.startsWith(`${name}.`) && url.hostname.endsWith('.workers.dev') : url.origin === address
    if (state.unreachable || !ours) throw new TypeError('fetch failed')
    const worker = fake.model.workers.get(account)?.get(name)
    if (!worker) return new Response('no such Worker', { status: 404 })
    const answersAs = state.build(worker)
    if (url.pathname === '/capabilities' && method === 'GET') return Response.json({ protocol: 2, build: answersAs })
    const current = answersAs === build
    // The secrets this isolate sees: as they were while a change is still on its way.
    if (state.lag > 0) state.lag -= 1
    else settled = new Map(worker.values ?? [])
    let caller = null
    for (const [secret, value] of [...settled].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const id = computerIdForSecretName(secret)
      if (id === null || (!current && id !== 'legacy')) continue
      if (typeof value === 'string' && value.trim() && value === bearer && caller === null) caller = id
    }
    const admin = () => (caller ? null : Response.json({ error: { code: 'admin_auth_required', message: 'Admin authentication is required.' } }, { status: 401 }))
    if (current && url.pathname === '/computers' && method === 'GET') return admin() ?? Response.json({ computers: state.computers, self: caller })
    if (current && url.pathname === '/computers/self' && method === 'POST') {
      const refusal = admin()
      if (refusal) return refusal
      const named = JSON.parse(String(init.body ?? '{}')).name
      const line = state.computers.find((entry) => entry.id === caller)
      if (line) line.name = named
      else state.computers.push({ id: caller, name: named, joinedAt: state.clock++, joinedWithCode: false })
      return Response.json({ computer: state.computers.find((entry) => entry.id === caller) })
    }
    if (url.pathname === '/tokens/check' && method === 'POST') {
      const found = checked(worker, JSON.parse(String(init.body ?? '{}')).token)
      return found ? Response.json(found) : Response.json({ error: { code: 'token_invalid', message: 'The token is not valid.' } }, { status: 401 })
    }
    const made = (prefix) => `${prefix}${state.clock++}`
    if (url.pathname === '/sessions' && method === 'POST') {
      const refusal = admin()
      if (refusal) return refusal
      const sessionId = made('s')
      return Response.json({ sessionId, presenterToken: signed(worker, 'presenter', sessionId), shortId: `k${sessionId}`, expiresAt: 60_000 }, { status: 201 })
    }
    if ((url.pathname === '/shares' || url.pathname === '/results') && method === 'POST') {
      const refusal = admin()
      if (refusal) return refusal
      const role = url.pathname === '/shares' ? 'share-owner' : 'results-owner'
      const shareId = made(url.pathname === '/shares' ? 'h' : 'r')
      return Response.json({ shareId, ownerToken: signed(worker, role, shareId) }, { status: 201 })
    }
    return new Response('not found', { status: 404 })
  }
  return { fetch, state, requests }
}

/**
 * One computer's profile for a test: the REAL key store (live-service-key.ts) over a plain slot, and
 * the `config.json` it reads the recorded live service from. `slot.text` is the slot's text (null:
 * nothing stored); `slot.failRead` makes every read throw (a slot that is there and cannot be
 * decrypted), `slot.failWrite` every write (nothing is then kept); `slot.writes` are the texts written.
 */
export function keyProfile({ text = null, config = {}, workerName = 'talkweaver-live-sessions' } = {}) {
  const slot = { text, writes: [], reads: 0, failRead: false, failWrite: false }
  const store = createComputerKeyStore({
    read: () => { slot.reads += 1; if (slot.failRead) throw new Error('the slot could not be decrypted'); return slot.text },
    write: (next) => { if (slot.failWrite) throw new Error('secure storage unavailable'); slot.writes.push(next); slot.text = next },
    recorded: () => ({ accountId: config.liveWorkerAccountId ?? null, baseUrl: config.liveWorkerBaseUrl ?? null, workerName }),
    // As the main process: config.json's field names, and the removal of one (writeConfig with it undefined).
    settings: { fields: () => Object.keys(config), remove: (field) => { delete config[field] } },
  })
  /** The entries in the slot now, as written (throws when it is not this build's form). */
  const entries = () => (slot.text === null ? [] : JSON.parse(slot.text).entries)
  return { slot, store, config, entries }
}

/**
 * The `keys` port of a set-up for tests of something else: one key at most, held in `holder.stored`
 * as `{ computerId, adminSecret }` and taken to be for whichever live service is asked about (these
 * tests have one). `make()` gives the key a first `ownKeyFor` stores. `onRead`: called on every read.
 */
export function singleKeyPort(holder, make, onRead = () => {}) {
  const entry = (at) => ({ accountId: at.accountId, workerName: at.workerName, computerId: holder.stored.computerId, key: holder.stored.adminSecret, kind: holder.stored.computerId === 'legacy' ? 'legacy' : 'own' })
  return {
    check() {},
    keysFor: (at) => { onRead(); return holder.stored ? [entry(at)] : [] },
    ownKeyFor(at) {
      if (!holder.stored || holder.stored.computerId === 'legacy') holder.stored = make()
      return entry(at)
    },
  }
}

/** A clock and a pause that do not really wait: each pause moves the clock on. */
export function instantClock() {
  const clock = { at: 0, pauses: [] }
  return { clock, live: { now: () => clock.at, wait: async (ms) => { clock.pauses.push(ms); clock.at += ms }, requestMs: 2000 } }
}

/**
 * A live service that answers as `build` (then as `updatedTo`) and accepts whatever key it is shown as the computer
 * `self()`: for tests of something else (the upload, the connection) that only need set-up to finish.
 */
export function acceptingLive({ build, updatedTo = build, self }) {
  // `updatedTo`: the build it answers as after its first answer (the one a set-up decides on): what
  // an update uploaded. A set-up reads the build back after its upload (decision R10), and a stand-in
  // that went on answering as the earlier build would be "another computer's older TalkWeaver".
  let asked = 0
  return async (input, init = {}) => {
    const url = new URL(String(input))
    if (url.pathname === '/capabilities') return Response.json({ protocol: 2, build: (asked += 1) === 1 ? build : updatedTo })
    if (url.pathname === '/computers') return Response.json({ computers: [], self: self(init) })
    if (url.pathname === '/computers/self' && init.method === 'POST') return Response.json({ computer: { id: self(), name: 'Test computer', joinedAt: 1, joinedWithCode: false } })
    return new Response('not found', { status: 404 })
  }
}
