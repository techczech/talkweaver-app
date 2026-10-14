// The signing key (going live from several Macs, decision R1), against a real live Worker
// (`wrangler dev`: local, throwaway secrets and state, nothing deployed).
//
// A Worker with the env secret (every service set up by 0.38.2):
//   - a presenter token signed with the env value the way 0.38.2 did is accepted, and is byte for
//     byte what this build hands out; owner tokens signed that way are accepted too;
//   - the registry's `signing_key` table stays empty (read from the Worker's own persisted storage);
//   - the key route is not reachable by any method or spelling of its path, sent raw.
// A Worker with no env secret (the harness's own var overridden with an empty value, which the
// Worker treats as absent):
//   - the first requests after a fresh start, sent at once, all succeed and every token made is
//     accepted on its owner route: there is one key;
//   - the persisted registry holds exactly one key, and no reply from a sample of routes contains it;
//   - a token signed with the value the harness generated, or with an empty or blank key, is refused;
//   - the key route is not reachable, and no public request makes a key on a Worker that has none.
// A restart on the same persisted state is not covered here (the harness removes its state on stop);
// worker/signing-key.test.ts covers it over the real object classes.
//
// No key, token or reply body is ever printed: assertions compare statuses and booleans.
// Usage: node scripts/test-signing-key-worker-integration.mjs
import assert from 'node:assert/strict'
import { createHmac, randomBytes } from 'node:crypto'
import { readdirSync, statSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { startLiveWorker } from './lib/live-worker-harness.mjs'

const results = []
const pass = (name) => { results.push(name); console.log(`PASS  ${name}`) }
const KEY_SHAPE = /^[A-Za-z0-9_-]{43}$/

async function call(baseUrl, method, path, { bearer, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: response.status, text, json }
}

/** One request with the path sent exactly as written (fetch would resolve `..` and `\` first). */
function raw(baseUrl, method, path, bearer) {
  const { hostname, port } = new URL(baseUrl)
  return new Promise((resolveReply, reject) => {
    const request = httpRequest({ hostname, port, method, path, headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), 'content-length': 0 } }, (response) => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { text += chunk })
      response.on('end', () => resolveReply({ status: response.statusCode, text }))
    })
    request.on('error', reject)
    request.end()
  })
}

// A token as worker/auth.ts makes one, and as 0.38.2 made it: base64url(JSON) + '.' + base64url(HMAC-SHA256).
function sign(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`
}

async function makeFour(baseUrl, admin, tag) {
  const [session, share, link, prework] = await Promise.all([
    call(baseUrl, 'POST', '/sessions', { bearer: admin, body: { talkSlug: `talk-${tag}` } }),
    call(baseUrl, 'POST', '/shares', { bearer: admin, body: { talkSlug: `share-${tag}`, title: 'T' } }),
    call(baseUrl, 'POST', '/results', { bearer: admin, body: {} }),
    call(baseUrl, 'POST', '/prework', { bearer: admin, body: {} }),
  ])
  assert.deepEqual([session.status, share.status, link.status, prework.status], [201, 201, 201, 201], `the four things were made (${tag})`)
  return {
    replies: [session, share, link, prework],
    sessionId: session.json.sessionId, expiresAt: session.json.expiresAt, presenter: session.json.presenterToken,
    shareId: share.json.shareId, share: share.json.ownerToken,
    linkId: link.json.shareId, link: link.json.ownerToken,
    preworkId: prework.json.preworkId, prework: prework.json.ownerToken,
  }
}

/** One owner-only request per kind of token. 401: the token was refused. An empty body is not a push: 400. */
async function ownerStatuses(baseUrl, four, tokens = four) {
  return {
    status: (await call(baseUrl, 'GET', `/sessions/${four.sessionId}/status`, { bearer: tokens.presenter })).status,
    recovery: (await call(baseUrl, 'GET', `/sessions/${four.sessionId}/recovery`, { bearer: tokens.presenter })).status,
    talk: (await call(baseUrl, 'PUT', `/shares/${four.shareId}/talk`, { bearer: tokens.share, body: {} })).status,
    content: (await call(baseUrl, 'PUT', `/results/${four.linkId}/content`, { bearer: tokens.link, body: {} })).status,
    results: (await call(baseUrl, 'GET', `/prework/${four.preworkId}/results`, { bearer: tokens.prework })).status,
  }
}
const ACCEPTED = { status: 200, recovery: 200, talk: 400, content: 400, results: 200 }
const REFUSED = { status: 401, recovery: 401, talk: 401, content: 401, results: 401 }
const forged = (four, secret) => ({
  presenter: sign({ role: 'presenter', sessionId: four.sessionId, exp: four.expiresAt }, secret),
  share: sign({ role: 'owner', shareId: four.shareId, iat: Date.now() }, secret),
  link: sign({ role: 'results-owner', shareId: four.linkId, iat: Date.now() }, secret),
  prework: sign({ role: 'prework-owner', preworkId: four.preworkId, iat: Date.now() }, secret),
})

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']
const KEY_PATHS = [
  '/internal/signing-key', '/internal/signing-key/', '/internal/signing-key?x=1', '//internal/signing-key', '///internal/signing-key',
  '/session/../internal/signing-key', '/session/x/../../internal/signing-key', '/session/./../internal/signing-key',
  '/session/%2e%2e/internal/signing-key', '/session/%2E%2E/internal/signing-key', '/session/.%2e/internal/signing-key',
  '/session/..%2Finternal%2Fsigning-key', '/session/..%2finternal%2fsigning-key', '/session/%2e%2e%2finternal%2fsigning-key',
  '/session/..%252Finternal%252Fsigning-key', '/session/internal%2Fsigning-key', '/session/%2Finternal%2Fsigning-key',
  '/session//internal/signing-key', '/session/internal/signing-key', '/session/signing-key', '/session/..\\internal\\signing-key',
  '/session/..%5Cinternal%5Csigning-key', '/internal%2Fsigning-key', '/%2Finternal%2Fsigning-key', '/internal/./signing-key',
  '/internal/x/../signing-key', '/INTERNAL/SIGNING-KEY', '/session/x?next=/internal/signing-key', '/session/x%3F/internal/signing-key',
  '/session/x;/internal/signing-key', '/computers/../internal/signing-key', '/shares/by-talk/..%2F..%2Finternal%2Fsigning-key',
  '/sessions/../internal/signing-key', '/results/../internal/signing-key', '/prework/../internal/signing-key', '/signing-key',
]

/** Every method on every spelling, sent raw, with and without a credential. Returns how many were asked. */
async function keyRouteIsUnreachable(baseUrl, bearers, keys) {
  let asked = 0
  for (const method of METHODS) {
    for (const path of KEY_PATHS) {
      for (const bearer of bearers) {
        const reply = await raw(baseUrl, method, path, bearer)
        asked += 1
        // Not a route, an admin route refusing, or a lookup (public: a talk slug; admin: a talk's share) of a name nobody uses.
        const harmless = [400, 401, 404].includes(reply.status) || (reply.status === 200 && ['{"live":false}', '{"active":false}'].includes(reply.text))
        assert.equal(harmless, true, `${method} ${path} answered ${reply.status}`)
        assert.equal(/"key"/.test(reply.text), false, `${method} ${path}: a reply with a key field`)
        for (const key of keys) assert.equal(reply.text.includes(key), false, `${method} ${path}: the key is in a reply`)
      }
    }
  }
  return asked
}

/**
 * The registry object's own SQLite file, in the state this Worker persists to. The harness does not
 * say where that is, so the file is found by a name only this Worker's computers table can hold.
 * Opened read-only; the caller closes it.
 */
async function registryDatabase(baseUrl, admin) {
  const marker = `probe ${randomBytes(12).toString('hex')}`
  assert.equal((await call(baseUrl, 'POST', '/computers/self', { bearer: admin, body: { name: marker } })).status, 200)
  const files = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (name.endsWith('.sqlite')) files.push(path)
    }
  }
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith('talkweaver-live-worker-')) continue
    try { walk(join(tmpdir(), name, 'state')) } catch { /* another run's folder, gone or not there yet */ }
  }
  for (const file of files) {
    let db
    try {
      db = new DatabaseSync(file, { readOnly: true })
      if (db.prepare('SELECT count(*) AS n FROM computers WHERE name = ?').get(marker).n === 1) return db
    } catch { /* another object's file: it has no computers table */ }
    db?.close()
  }
  throw new Error('the registry object\'s storage was not found under the harness\'s state folder')
}
const storedKeys = (db) => db.prepare('SELECT key FROM signing_key').all().map((row) => row.key)

// ── A Worker with the env secret ──────────────────────────────────────────────────────────────
const legacy = await startLiveWorker()
try {
  const { baseUrl, adminSecret, signingSecret } = legacy
  const four = await makeFour(baseUrl, adminSecret, 'env')
  const old = forged(four, signingSecret)
  assert.deepEqual(await ownerStatuses(baseUrl, four, old), ACCEPTED)
  assert.deepEqual(await ownerStatuses(baseUrl, four), ACCEPTED)
  assert.equal(four.presenter === old.presenter, true, 'the presenter token is what 0.38.2 would have made')
  pass('env secret: tokens signed with it the way 0.38.2 did are accepted, and the presenter token is byte for byte the same')

  assert.deepEqual(await ownerStatuses(baseUrl, four, forged(four, randomBytes(24).toString('hex'))), REFUSED)
  pass('env secret: tokens signed with another key are refused')

  const asked = await keyRouteIsUnreachable(baseUrl, [undefined, adminSecret], [signingSecret])
  assert.equal(asked, METHODS.length * KEY_PATHS.length * 2)
  pass(`env secret: the key route is unreachable (${asked} raw requests), and no reply carries the secret`)

  const db = await registryDatabase(baseUrl, adminSecret)
  try {
    assert.equal(storedKeys(db).length, 0)
  } finally {
    db.close()
  }
  pass('env secret: the registry\'s signing_key table exists and stays empty')
} finally {
  await legacy.stop()
}

// ── A Worker with no env secret ───────────────────────────────────────────────────────────────
// The harness always passes SESSION_SIGNING_SECRET; a later `--var` of the same name with an empty
// value replaces it, and the Worker treats an empty secret as absent.
const fresh = await startLiveWorker({ vars: { SESSION_SIGNING_SECRET: '' } })
try {
  const { baseUrl, adminSecret, signingSecret } = fresh

  // Before any key exists: public requests make none (seen below as the first makeFour working).
  await keyRouteIsUnreachable(baseUrl, [undefined], [])

  // The first requests that need the key, all at once.
  const batches = await Promise.all(Array.from({ length: 6 }, (_, index) => makeFour(baseUrl, adminSecret, `first-${index}`)))
  for (const four of batches) assert.deepEqual(await ownerStatuses(baseUrl, four), ACCEPTED)
  // Each kind of token only on its own thing: one batch's tokens never pass for another's.
  assert.deepEqual(await ownerStatuses(baseUrl, batches[0], batches[1]), REFUSED)
  pass('no env secret: 24 first requests at once all succeed and every token is accepted (one key)')

  const db = await registryDatabase(baseUrl, adminSecret)
  let key
  try {
    const keys = storedKeys(db)
    assert.equal(keys.length, 1, 'exactly one key is kept')
    key = keys[0]
    assert.equal(KEY_SHAPE.test(key), true, 'the key is 32 bytes as base64url')
    assert.equal(key === signingSecret, false)
  } finally {
    db.close()
  }
  assert.equal(batches.every((four) => four.presenter === sign({ role: 'presenter', sessionId: four.sessionId, exp: four.expiresAt }, key)), true)
  pass('no env secret: the registry keeps exactly one key, and every presenter token was signed with it')

  for (const wrong of [signingSecret, '', ' ', 'undefined', randomBytes(32).toString('base64url')]) {
    assert.deepEqual(await ownerStatuses(baseUrl, batches[0], forged(batches[0], wrong)), REFUSED)
  }
  pass('no env secret: a token signed with the harness\'s unused secret, an empty or blank key, or another key is refused')

  const asked = await keyRouteIsUnreachable(baseUrl, [undefined, adminSecret, batches[0].presenter], [key])
  pass(`no env secret: the key route is unreachable (${asked} raw requests), and no reply carries the key`)

  const four = batches[2]
  const sample = [
    ...batches.flatMap((batch) => batch.replies),
    await call(baseUrl, 'GET', '/capabilities'), await call(baseUrl, 'GET', '/'), await call(baseUrl, 'GET', '/nope'),
    await call(baseUrl, 'GET', '/session/talk-first-2'), await call(baseUrl, 'GET', '/session/never'),
    await call(baseUrl, 'GET', `/sessions/${four.sessionId}/status`), await call(baseUrl, 'GET', `/sessions/${four.sessionId}/status`, { bearer: four.presenter }),
    await call(baseUrl, 'GET', `/sessions/${four.sessionId}/status`, { bearer: 'bad.token' }), await call(baseUrl, 'GET', `/sessions/${four.sessionId}/recovery`, { bearer: four.presenter }),
    await call(baseUrl, 'GET', `/sessions/${four.sessionId}/recovery`), await call(baseUrl, 'POST', '/sessions', { body: { talkSlug: 'x' } }),
    await call(baseUrl, 'POST', '/sessions', { bearer: adminSecret, body: { talkSlug: 'Bad Slug' } }),
    await call(baseUrl, 'GET', '/shares/by-talk/share-first-2', { bearer: adminSecret }), await call(baseUrl, 'GET', '/shares/by-talk/share-first-2'),
    await call(baseUrl, 'GET', `/shares/${four.shareId}`), await call(baseUrl, 'GET', `/shares/${four.shareId}/items`),
    await call(baseUrl, 'PUT', `/shares/${four.shareId}/talk`, { bearer: four.share, body: {} }), await call(baseUrl, 'PUT', `/shares/${four.shareId}/talk`, { bearer: 'bad.token', body: {} }),
    await call(baseUrl, 'GET', `/results/${four.linkId}`), await call(baseUrl, 'PUT', `/results/${four.linkId}/content`, { bearer: four.link, body: {} }),
    await call(baseUrl, 'PUT', `/results/${four.linkId}/content`, { body: {} }),
    await call(baseUrl, 'GET', `/prework/${four.preworkId}`), await call(baseUrl, 'GET', `/prework/${four.preworkId}/results`, { bearer: four.prework }),
    await call(baseUrl, 'GET', `/prework/${four.preworkId}/results`),
    await call(baseUrl, 'GET', '/computers', { bearer: adminSecret }), await call(baseUrl, 'GET', '/computers'),
    await call(baseUrl, 'POST', `/prework/${four.preworkId}/close`, { bearer: four.prework }), await call(baseUrl, 'POST', `/results/${four.linkId}/close`, { bearer: four.link }),
    await call(baseUrl, 'POST', `/shares/${four.shareId}/close`, { bearer: adminSecret }), await call(baseUrl, 'POST', `/sessions/${four.sessionId}/close`, { bearer: adminSecret, body: {} }),
  ]
  const carrying = sample.filter((reply) => reply.text.includes(key)).length
  console.log(`      replies searched: ${sample.length}; carrying the key: ${carrying > 0}`)
  assert.equal(carrying, 0)
  assert.equal(sample.length > 50, true)
  pass('no env secret: no reply from a sample of every kind of route contains the key')

  // The key did not change under any of that.
  const again = await registryDatabase(baseUrl, adminSecret)
  try {
    assert.deepEqual(storedKeys(again).map((stored) => stored === key), [true])
  } finally {
    again.close()
  }
  assert.deepEqual(await ownerStatuses(baseUrl, batches[5]), ACCEPTED)
  pass('no env secret: the same one key is kept afterwards, and earlier tokens are still accepted')
} finally {
  await fresh.stop()
}

console.log(`\n${results.length} checks passed`)
