// Going live from several Macs, ticket 01, against a real live Worker (`wrangler dev`: local, throwaway
// secrets and state, nothing deployed): the live service accepts a key from each computer.
//   - a 0.38.2 computer's key (`ADMIN_SECRET`) still passes every admin route;
//   - a second computer's key under `ADMIN_SECRET_<id>` passes the same routes, and each computer can
//     stop what the other made;
//   - near-miss names (`ADMIN_SECRETS`, `XADMIN_SECRET_a`, an upper-case id, a reserved id), the signing
//     secret, a wrong value and a missing or malformed header are refused on every admin route, with
//     the same reply;
//   - the computers list: empty, then the legacy computer as `legacy` and the second under its own id,
//     renamed, removed (the line only: the removed computer's key still passes); no reply carries a key;
//   - a Worker without the second computer's secret refuses that same bearer and still takes the legacy key;
//   - `GET /capabilities` keeps its shape.
// No key, token or reply body is ever printed: assertions compare statuses, ids and booleans.
// Usage: node scripts/test-computer-keys-worker-integration.mjs
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { startLiveWorker } from './lib/live-worker-harness.mjs'

const BUILD = /export const LIVE_WORKER_BUILD\s*=\s*'([^']+)'/.exec(readFileSync(join(resolve(import.meta.dirname, '..'), 'worker', 'recovery-protocol.ts'), 'utf8'))[1]
const key = () => randomBytes(24).toString('hex')
const second = key()
// Set on the Worker under names that are not admin keys: none of these values may ever pass.
const notKeys = { ADMIN_SECRETS: key(), XADMIN_SECRET_a: key(), ADMIN_SECRET_Mac: key(), ADMIN_SECRET_a_b: key(), ADMIN_SECRET_legacy: key(), ADMIN_SECRET_self: key() }
const results = []
const pass = (name) => { results.push(name); console.log(`PASS  ${name}`) }
const json = { 'content-type': 'application/json' }
const REFUSAL = { error: { code: 'admin_auth_required', message: 'Admin authentication is required.' } }

/** One request; the body is returned for comparing, never printed. */
async function call(baseUrl, method, path, { bearer, authorization, body } = {}) {
  const headers = { ...(body === undefined ? {} : json) }
  if (authorization !== undefined) headers.authorization = authorization
  else if (bearer) headers.authorization = `Bearer ${bearer}`
  const response = await fetch(`${baseUrl}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const text = await response.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch {}
  return { status: response.status, text, json: parsed }
}

/** Every admin route once with `bearer`, on things made for the purpose. Returns the statuses by route. */
async function adminRoutes(baseUrl, bearer, makerBearer, tag) {
  const statuses = {}
  const as = (who) => ({ bearer: who })
  // Things to stop, made by `makerBearer` (a key known to pass), so that a refusal changes nothing.
  const session = (await call(baseUrl, 'POST', '/sessions', { ...as(makerBearer), body: { talkSlug: `stop-session-${tag}` } })).json
  const share = (await call(baseUrl, 'POST', '/shares', { ...as(makerBearer), body: { talkSlug: `stop-share-${tag}`, title: 'T' } })).json
  const link = (await call(baseUrl, 'POST', '/results', { ...as(makerBearer), body: {} })).json
  const prework = (await call(baseUrl, 'POST', '/prework', { ...as(makerBearer), body: {} })).json
  assert.ok(session?.sessionId && share?.shareId && link?.shareId && prework?.preworkId, 'the maker\'s key made the four things to stop')

  statuses['POST /sessions'] = (await call(baseUrl, 'POST', '/sessions', { ...as(bearer), body: { talkSlug: `made-${tag}` } })).status
  statuses['POST /shares'] = (await call(baseUrl, 'POST', '/shares', { ...as(bearer), body: { talkSlug: `made-share-${tag}`, title: 'T' } })).status
  statuses['POST /results'] = (await call(baseUrl, 'POST', '/results', { ...as(bearer), body: {} })).status
  statuses['POST /prework'] = (await call(baseUrl, 'POST', '/prework', { ...as(bearer), body: {} })).status
  statuses['GET /shares/by-talk'] = (await call(baseUrl, 'GET', `/shares/by-talk/stop-share-${tag}`, as(bearer))).status
  statuses['POST /sessions/<id>/close'] = (await call(baseUrl, 'POST', `/sessions/${session.sessionId}/close`, { ...as(bearer), body: {} })).status
  statuses['POST /shares/<id>/close'] = (await call(baseUrl, 'POST', `/shares/${share.shareId}/close`, as(bearer))).status
  statuses['POST /results/<id>/close'] = (await call(baseUrl, 'POST', `/results/${link.shareId}/close`, as(bearer))).status
  statuses['POST /prework/<id>/close'] = (await call(baseUrl, 'POST', `/prework/${prework.preworkId}/close`, as(bearer))).status
  statuses['GET /computers'] = (await call(baseUrl, 'GET', '/computers', as(bearer))).status
  statuses['POST /computers/self'] = (await call(baseUrl, 'POST', '/computers/self', { ...as(bearer), body: { name: `Computer ${tag}` } })).status
  statuses['DELETE /computers/<id>'] = (await call(baseUrl, 'DELETE', '/computers/zz99', as(bearer))).status
  return statuses
}
const ACCEPTED = {
  'POST /sessions': 201, 'POST /shares': 201, 'POST /results': 201, 'POST /prework': 201, 'GET /shares/by-talk': 200,
  'POST /sessions/<id>/close': 200, 'POST /shares/<id>/close': 200, 'POST /results/<id>/close': 200, 'POST /prework/<id>/close': 200,
  'GET /computers': 200, 'POST /computers/self': 200, 'DELETE /computers/<id>': 200,
}
const REFUSED = Object.fromEntries(Object.keys(ACCEPTED).map((route) => [route, 401]))

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
function assertNoKeyIn(text, keys, what) {
  for (const value of keys) {
    assert.equal(text.includes(value), false, `${what}: a key appears in a reply`)
    assert.equal(text.includes(sha256(value)), false, `${what}: a key's digest appears in a reply`)
  }
  assert.equal(/ADMIN_SECRET|SESSION_SIGNING_SECRET/.test(text), false, `${what}: a secret's name appears in a reply`)
}

// ── A Worker with two computers' keys ─────────────────────────────────────────────────────────
const first = await startLiveWorker({ vars: { ADMIN_SECRET_macb: second, ...notKeys } })
let legacy
try {
  const { baseUrl, adminSecret, signingSecret } = first
  legacy = adminSecret
  const everyKey = [legacy, second, signingSecret, ...Object.values(notKeys)]

  assert.deepEqual((await call(baseUrl, 'GET', '/capabilities')).json, { protocol: 2, build: BUILD })
  pass('GET /capabilities keeps its shape and names this build')

  assert.deepEqual((await call(baseUrl, 'GET', '/computers', { bearer: legacy })).json, { computers: [], self: 'legacy' })
  assert.deepEqual((await call(baseUrl, 'GET', '/computers', { bearer: second })).json, { computers: [], self: 'macb' })
  pass('each key is known as its own computer: ADMIN_SECRET as "legacy", ADMIN_SECRET_macb as "macb"')

  assert.deepEqual(await adminRoutes(baseUrl, legacy, legacy, 'legacy'), ACCEPTED)
  pass('a 0.38.2 computer\'s key passes every admin route')
  assert.deepEqual(await adminRoutes(baseUrl, second, second, 'macb'), ACCEPTED)
  pass('a second computer\'s key under ADMIN_SECRET_<id> passes every admin route')
  assert.deepEqual(await adminRoutes(baseUrl, second, legacy, 'cross-a'), ACCEPTED)
  assert.deepEqual(await adminRoutes(baseUrl, legacy, second, 'cross-b'), ACCEPTED)
  pass('each computer can stop what the other made')

  let tag = 0
  for (const [name, value] of [...Object.entries(notKeys), ['SESSION_SIGNING_SECRET', signingSecret], ['a wrong value', key()],
    ['the legacy key with one character more', `${legacy}0`], ['the second key cut short', second.slice(0, -1)]]) {
    assert.deepEqual(await adminRoutes(baseUrl, value, legacy, `refused-${tag += 1}`), REFUSED, `${name} must not pass any admin route`)
  }
  pass('near-miss names, reserved ids, the signing secret and wrong values are refused on every admin route')

  const refusals = []
  for (const authorization of [undefined, '', 'Bearer', 'Bearer ', legacy, second, `Basic ${legacy}`, `Token ${second}`, `Bearer${legacy}`, 'Bearer undefined', 'Bearer null']) {
    for (const [method, path, body] of [['GET', '/computers'], ['POST', '/computers/self', { name: 'x' }], ['DELETE', '/computers/macb'],
      ['POST', '/sessions', { talkSlug: 'no-header' }], ['GET', '/shares/by-talk/no-header']]) {
      const refused = await call(baseUrl, method, path, { authorization, body })
      assert.equal(refused.status, 401, `${method} ${path} with a missing or malformed header`)
      assert.deepEqual(refused.json, REFUSAL)
      refusals.push(refused.text)
    }
  }
  assert.equal(new Set(refusals).size, 1, 'every refusal is the same reply')
  assertNoKeyIn(refusals[0], everyKey, 'a refusal')
  pass('a missing header, an empty bearer, another scheme and the bare value are refused, all with one reply')

  // ── The list of computers ──────────────────────────────────────────────────────────────────
  // adminRoutes recorded both computers already (POST /computers/self); refused callers recorded nothing.
  const before = Date.now()
  const listedReply = await call(baseUrl, 'GET', '/computers', { bearer: legacy })
  const listed = listedReply.json
  assert.deepEqual(listed.computers.map((line) => line.id).sort(), ['legacy', 'macb'], 'only the two computers whose keys passed are listed')
  for (const line of listed.computers) {
    assert.deepEqual(Object.keys(line).sort(), ['id', 'joinedAt', 'joinedWithCode', 'name'])
    assert.equal(line.joinedWithCode, false)
    assert.ok(Number.isSafeInteger(line.joinedAt) && line.joinedAt <= before && line.joinedAt > before - 10 * 60_000)
  }
  pass('computers are listed with id, name, joined date and how they joined; the legacy computer as "legacy"')

  const joinedAt = listed.computers.find((line) => line.id === 'macb').joinedAt
  const renamed = await call(baseUrl, 'POST', '/computers/self', { bearer: second, body: { name: '  Dominik’s MacBook Pro (2) ', id: 'legacy' } })
  assert.deepEqual(renamed.json, { computer: { id: 'macb', name: 'Dominik’s MacBook Pro (2)', joinedAt, joinedWithCode: false } })
  for (const body of [{}, { name: '' }, { name: 'x'.repeat(65) }, { name: 'two\nlines' }, { name: 7 }]) {
    const refused = await call(baseUrl, 'POST', '/computers/self', { bearer: second, body })
    assert.deepEqual([refused.status, refused.json?.error?.code], [400, 'invalid_computer_name'])
  }
  assert.equal((await call(baseUrl, 'POST', '/computers/self', { bearer: second, body: { name: 'x'.repeat(5000) } })).status, 413)
  pass('recording again renames, keeps the joined date and records the caller\'s own id; a bad name is refused')

  for (const id of ['self', 'join', 'Mac', 'a_b', 'LEGACY']) {
    const refused = await call(baseUrl, 'DELETE', `/computers/${id}`, { bearer: legacy })
    assert.deepEqual([refused.status, refused.json?.error?.code], [400, 'invalid_computer_id'])
  }
  assert.deepEqual((await call(baseUrl, 'DELETE', '/computers/macb', { bearer: legacy })).json, { ok: true })
  const after = await call(baseUrl, 'GET', '/computers', { bearer: second })
  assert.deepEqual([after.status, after.json.self, after.json.computers.map((line) => line.id)], [200, 'macb', ['legacy']])
  pass('DELETE removes the line only: the removed computer\'s key still passes until its secret is gone')

  for (const [method, path] of [['GET', '/internal/computers'], ['DELETE', '/internal/computers/legacy'], ['PUT', '/internal/computers/legacy'],
    ['GET', '/computers/legacy'], ['POST', '/computers'], ['DELETE', '/computers/macb/x']]) {
    assert.equal((await call(baseUrl, method, path, { bearer: legacy })).status, 404, `${method} ${path} is not a route`)
  }
  assert.deepEqual((await call(baseUrl, 'GET', '/computers', { bearer: legacy })).json.computers.map((line) => line.id), ['legacy'])
  pass('the registry\'s internal path is not reachable from outside')

  for (const reply of [listedReply, renamed, after, await call(baseUrl, 'GET', '/computers', { bearer: legacy })]) assertNoKeyIn(reply.text, everyKey, 'the computers list')
  pass('no reply from the computers routes carries a key, a digest of one or a secret\'s name')
} finally {
  await first.stop()
}

// ── The same bearer once its secret is absent ─────────────────────────────────────────────────
const without = await startLiveWorker()
try {
  const { baseUrl, adminSecret } = without
  assert.deepEqual(await adminRoutes(baseUrl, second, adminSecret, 'absent'), REFUSED)
  assert.deepEqual(await adminRoutes(baseUrl, legacy, adminSecret, 'other-worker'), REFUSED)
  assert.deepEqual(await adminRoutes(baseUrl, adminSecret, adminSecret, 'still'), ACCEPTED)
  assert.deepEqual((await call(baseUrl, 'GET', '/computers', { bearer: adminSecret })).json.computers.map((line) => line.id), ['legacy'])
  pass('a Worker without a computer\'s secret refuses that bearer on every admin route; its own legacy key still passes')
} finally {
  await without.stop()
}

console.log(`\n${results.length} checks passed`)
