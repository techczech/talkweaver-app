// The signing key (going live from several Macs, decision R1), through the entry Worker's own fetch
// and the real Durable Object classes, each over a real SQLite (bun:sqlite) standing in for its
// storage. Key values are made per run and never printed: assertions compare booleans, counts and
// statuses.
import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import worker, { LiveSession, SessionRegistry } from './index'
import { createOwnerToken, createPreworkOwnerToken, createResultsOwnerToken, createSignedToken, verifySignedToken } from './auth'
import { RunPrework } from './prework'
import { RunShare } from './run-share'
import { SharedTalk } from './shared-talk'
import { SigningKeyTable, SigningKeyUnavailable, envSigningSecret, signingKey } from './signing-key'
import { LIVE_WORKER_BUILD } from './recovery-protocol'
import type { Env } from './http'

const random = () => [...crypto.getRandomValues(new Uint8Array(24))].map((byte) => byte.toString(16).padStart(2, '0')).join('')
const ADMIN = random()
const KEY_SHAPE = /^[A-Za-z0-9_-]{43}$/
const KEY_ROUTE = 'POST /internal/signing-key'

type Sql = SqlStorage & { failReads: boolean; statements: string[] }

/** Durable Object SQL over one database. `failReads` makes every SELECT throw, as a storage error would. */
function sqlOver(db: Database): Sql {
  const sql = {
    failReads: false,
    statements: [] as string[],
    exec(query: string, ...bindings: unknown[]) {
      sql.statements.push(query.trim().split(/\s+/)[0].toUpperCase())
      if (sql.failReads && /^\s*SELECT/i.test(query)) throw new Error('storage read failed')
      return db.query(query).all(...(bindings as []))
    },
  }
  return sql as unknown as Sql
}
const freshSql = () => sqlOver(new Database(':memory:'))
const storedKeys = (sql: SqlStorage) => [...sql.exec<{ key: string }>('SELECT key FROM signing_key')].map((row) => row.key)

function objectState(sql: SqlStorage) {
  return {
    storage: { sql, setAlarm: async () => {}, deleteAlarm: async () => {}, getAlarm: async () => null },
    blockConcurrencyWhile: (fn: () => unknown) => { void fn() },
    getWebSockets: () => [], acceptWebSocket: () => {},
  }
}

/**
 * A whole live service: the entry Worker over the five real object classes, one database per object.
 * `start()` is an isolate starting on that same storage: new objects and new bindings (so nothing is
 * remembered from before). `registryCalls` records every request that reached the registry object.
 */
function service(bindings: Record<string, unknown> = {}) {
  const databases = new Map<string, Database>()
  const registryCalls: string[] = []
  const registrySql = sqlOver(new Database(':memory:'))
  function start() {
    const objects = new Map<string, { fetch(request: Request): Promise<Response> }>()
    const namespace = (kind: string, make: (state: never, env: Env) => { fetch(request: Request): Promise<Response> }) => ({
      idFromName: (name: string) => name,
      get: (name: string) => ({
        fetch: async (request: Request) => {
          const id = `${kind}:${name}`
          if (kind === 'registry') registryCalls.push(`${request.method} ${new URL(request.url).pathname}`)
          if (!objects.has(id)) {
            if (!databases.has(id)) databases.set(id, new Database(':memory:'))
            objects.set(id, make(objectState(kind === 'registry' ? registrySql : sqlOver(databases.get(id)!)) as never, env))
            await Promise.resolve()
          }
          return objects.get(id)!.fetch(request)
        },
      }),
    })
    const env = {
      LIVE_SESSIONS: namespace('session', (state, e) => new LiveSession(state, e)),
      SESSION_REGISTRY: namespace('registry', (state) => new SessionRegistry(state)),
      SHARED_TALKS: namespace('share', (state, e) => new SharedTalk(state, e)),
      RUN_SHARES: namespace('results', (state, e) => new RunShare(state, e)),
      RUN_PREWORK: namespace('prework', (state, e) => new RunPrework(state, e)),
      ADMIN_SECRET: ADMIN, PREWORK_LOCAL_SOURCE: '1', ...bindings,
    } as unknown as Env
    return env
  }
  let env = start()
  async function call(method: string, path: string, bearer?: string | null, body?: unknown) {
    const response = await worker.fetch(new Request(`https://live.test${path}`, {
      method,
      headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env)
    const text = await response.text()
    let json: any = null
    try { json = JSON.parse(text) } catch { /* a page */ }
    return { status: response.status, text, json }
  }
  return {
    call, registryCalls, registrySql,
    get env() { return env },
    restart(next: Record<string, unknown> = bindings) { bindings = next; env = start() },
  }
}
type Service = ReturnType<typeof service>

/** A session, a shared talk, a Run link and pre-work, made with the admin key; each reply carries its token. */
async function makeFour(s: Service, tag: string) {
  const session = await s.call('POST', '/sessions', ADMIN, { talkSlug: `talk-${tag}` })
  const share = await s.call('POST', '/shares', ADMIN, { talkSlug: `share-${tag}`, title: 'T' })
  const link = await s.call('POST', '/results', ADMIN, {})
  const prework = await s.call('POST', '/prework', ADMIN, {})
  expect([session.status, share.status, link.status, prework.status]).toEqual([201, 201, 201, 201])
  return {
    replies: [session, share, link, prework],
    sessionId: session.json.sessionId as string, presenterToken: session.json.presenterToken as string, expiresAt: session.json.expiresAt as number,
    shareId: share.json.shareId as string, shareToken: share.json.ownerToken as string,
    linkId: link.json.shareId as string, linkToken: link.json.ownerToken as string,
    preworkId: prework.json.preworkId as string, preworkToken: prework.json.ownerToken as string,
  }
}
type Four = Awaited<ReturnType<typeof makeFour>>

/**
 * One owner-only request per kind of token, each checked by the entry Worker and again inside the
 * object (the session's by its object only). 401 means the token was refused; anything else, accepted.
 */
async function ownerStatuses(s: Service, four: Four, tokens: Partial<Record<'presenter' | 'share' | 'link' | 'prework', string>> = {}) {
  return {
    'GET /sessions/<id>/status': (await s.call('GET', `/sessions/${four.sessionId}/status`, tokens.presenter ?? four.presenterToken)).status,
    'GET /sessions/<id>/recovery': (await s.call('GET', `/sessions/${four.sessionId}/recovery`, tokens.presenter ?? four.presenterToken)).status,
    'PUT /shares/<id>/talk': (await s.call('PUT', `/shares/${four.shareId}/talk`, tokens.share ?? four.shareToken, {})).status,
    'PUT /results/<id>/content': (await s.call('PUT', `/results/${four.linkId}/content`, tokens.link ?? four.linkToken, {})).status,
    'GET /prework/<id>/results': (await s.call('GET', `/prework/${four.preworkId}/results`, tokens.prework ?? four.preworkToken)).status,
  }
}
// An empty body is not a push: accepted tokens get the route's own 400, never 401.
const ACCEPTED = { 'GET /sessions/<id>/status': 200, 'GET /sessions/<id>/recovery': 200, 'PUT /shares/<id>/talk': 400, 'PUT /results/<id>/content': 400, 'GET /prework/<id>/results': 200 }
const REFUSED = Object.fromEntries(Object.keys(ACCEPTED).map((route) => [route, 401]))

describe('the env signing secret', () => {
  test('counts when it is a string with something in it, and is used exactly as bound', () => {
    for (const value of ['k', 'test-secret', '  padded  ', 'tab\tinside', random()]) expect(envSigningSecret({ SESSION_SIGNING_SECRET: value }) === value).toBe(true)
  })

  test('does not count when absent, empty, only white space or not a string', () => {
    for (const value of [undefined, null, '', ' ', '   ', '\t', '\n', ' \r\n\t ', ' ', ' ', 0, 1, true, {}, [], ['k'], { toString: () => 'k' }]) {
      expect(envSigningSecret({ SESSION_SIGNING_SECRET: value })).toBeNull()
    }
    expect(envSigningSecret({})).toBeNull()
  })
})

describe('the registry\'s signing key table', () => {
  test('an empty table makes one key of 32 random bytes; asking again, or starting again, gives the same one', () => {
    const sql = freshSql()
    const table = new SigningKeyTable(sql)
    expect(storedKeys(sql)).toHaveLength(0)
    const key = table.fetchOrCreate()
    expect(KEY_SHAPE.test(key)).toBe(true)
    expect(atob(key.replaceAll('-', '+').replaceAll('_', '/')).length).toBe(32)
    expect(table.fetchOrCreate() === key).toBe(true)
    expect(new SigningKeyTable(sql).fetchOrCreate() === key).toBe(true)
    expect(storedKeys(sql)).toHaveLength(1)
    // Two services never share a key.
    expect(new SigningKeyTable(freshSql()).fetchOrCreate() === key).toBe(false)
  })

  test('the table cannot hold a second key, and nothing replaces the first', () => {
    const sql = freshSql()
    const key = new SigningKeyTable(sql).fetchOrCreate()
    expect(() => sql.exec('INSERT INTO signing_key (id, key, created_at) VALUES (2, ?, 0)', 'x'.repeat(43))).toThrow()
    expect(() => sql.exec('INSERT INTO signing_key (id, key, created_at) VALUES (1, ?, 0)', 'x'.repeat(43))).toThrow()
    expect(storedKeys(sql).map((stored) => stored === key)).toEqual([true])
  })

  test('a read that fails throws: no key is made, on a table with a key or without one', () => {
    for (const seeded of [true, false]) {
      const sql = freshSql()
      const table = new SigningKeyTable(sql)
      const key = seeded ? table.fetchOrCreate() : null
      sql.statements.length = 0
      sql.failReads = true
      expect(() => table.fetchOrCreate()).toThrow('storage read failed')
      expect(() => table.fetchOrCreate()).toThrow('storage read failed')
      expect(sql.statements.includes('INSERT')).toBe(false)
      sql.failReads = false
      expect(storedKeys(sql)).toHaveLength(seeded ? 1 : 0)
      // Once storage reads again: the key that was there, or (never having had one) a first key.
      const after = table.fetchOrCreate()
      expect(seeded ? after === key : KEY_SHAPE.test(after)).toBe(true)
      expect(storedKeys(sql)).toHaveLength(1)
    }
  })

  test('a stored value that is not a key throws and is left as it is', () => {
    for (const stored of ['', ' ', 'short', 'x'.repeat(42), 'x'.repeat(44), `${'x'.repeat(42)}=`, `${'x'.repeat(42)}/`]) {
      const sql = freshSql()
      const table = new SigningKeyTable(sql)
      sql.exec('INSERT INTO signing_key (id, key, created_at) VALUES (1, ?, 0)', stored)
      sql.statements.length = 0
      expect(() => table.fetchOrCreate()).toThrow('The stored signing key is not readable.')
      expect(sql.statements).toEqual(['SELECT'])
      expect([...sql.exec<{ key: unknown }>('SELECT key FROM signing_key')].map((row) => row.key)).toEqual([stored])
    }
  })

  test('a write that fails throws, and the next request makes the first key', () => {
    const db = new Database(':memory:')
    const sql = sqlOver(db)
    const table = new SigningKeyTable(sql)
    const real = sql.exec.bind(sql)
    let failing = true
    sql.exec = ((query: string, ...bindings: unknown[]) => {
      if (failing && query.startsWith('INSERT')) throw new Error('storage write failed')
      return real(query, ...bindings)
    }) as never
    expect(() => table.fetchOrCreate()).toThrow('storage write failed')
    expect(storedKeys(sql)).toHaveLength(0)
    failing = false
    expect(table.fetchOrCreate() === storedKeys(sql)[0]).toBe(true)
  })
})

describe('the registry object\'s key route', () => {
  const state = (sql: SqlStorage) => objectState(sql) as never
  const ask = (registry: SessionRegistry, method = 'POST', path = '/internal/signing-key') => registry.fetch(new Request(`https://internal${path}`, { method }))

  test('fetchOrCreate and the route have no await in them: read and insert are one synchronous stretch', async () => {
    const table = new SigningKeyTable(freshSql())
    expect(typeof table.fetchOrCreate()).toBe('string')
    expect(table.route(new Request('https://internal/internal/signing-key', { method: 'POST' }), new URL('https://internal/internal/signing-key'))).toBeInstanceOf(Response)
  })

  test('two first requests at once get the same key, and so do fifty', async () => {
    for (const count of [2, 50]) {
      const sql = freshSql()
      const registry = new SessionRegistry(state(sql))
      const replies = await Promise.all(Array.from({ length: count }, () => ask(registry).then((response) => response.json() as Promise<{ key: string }>)))
      expect(new Set(replies.map((reply) => reply.key)).size).toBe(1)
      expect(KEY_SHAPE.test(replies[0].key)).toBe(true)
      expect(storedKeys(sql)).toHaveLength(1)
      expect(sql.statements.filter((statement) => statement === 'INSERT')).toHaveLength(1)
    }
  })

  test('two first requests at once through two objects started on the same storage get the same key', async () => {
    const sql = freshSql()
    const replies = await Promise.all([new SessionRegistry(state(sql)), new SessionRegistry(state(sql))]
      .map((registry) => ask(registry).then((response) => response.json() as Promise<{ key: string }>)))
    expect(replies[0].key === replies[1].key).toBe(true)
    expect(storedKeys(sql)).toHaveLength(1)
  })

  test('only POST on the exact path answers with the key; anything else makes none', async () => {
    const sql = freshSql()
    const registry = new SessionRegistry(state(sql))
    for (const [method, path] of [
      ['GET', '/internal/signing-key'], ['PUT', '/internal/signing-key'], ['DELETE', '/internal/signing-key'], ['PATCH', '/internal/signing-key'],
      ['HEAD', '/internal/signing-key'], ['POST', '/internal/signing-key/'], ['POST', '/internal/signing-key/x'], ['POST', '/internal/Signing-Key'],
      ['POST', '/signing-key'], ['POST', '/internal/signing-keys'], ['POST', '//internal/signing-key'], ['POST', '/internal//signing-key'],
      ['GET', '/session/internal%2Fsigning-key'], ['GET', '/session/..%2Finternal%2Fsigning-key'], ['GET', '/session/signing-key'],
      ['POST', '/session/..%2Finternal%2Fsigning-key'], ['GET', '/internal/computers'],
    ]) {
      const reply = await ask(registry, method, path)
      const text = await reply.text()
      expect([method, path, text.includes('"key"')]).toEqual([method, path, false])
    }
    expect(storedKeys(sql)).toHaveLength(0)
    const made = await (await ask(registry)).json() as { key: string }
    expect(storedKeys(sql).map((stored) => stored === made.key)).toEqual([true])
  })

  test('a storage error is a 500 that names no key, never a new key', async () => {
    const sql = freshSql()
    const registry = new SessionRegistry(state(sql))
    const { key } = await (await ask(registry)).json() as { key: string }
    const logged: string[] = []
    const realError = console.error
    console.error = (...parts: unknown[]) => { logged.push(parts.map(String).join(' ')) }
    try {
      sql.failReads = true
      const failed = await ask(registry)
      const text = await failed.text()
      expect([failed.status, JSON.parse(text).error.code, text.includes(key)]).toEqual([500, 'signing_key_unavailable', false])
      sql.failReads = false
      // A stored value that is not a key: the same answer, and the value is not echoed.
      sql.exec('UPDATE signing_key SET key = ?', 'not-a-key-but-secret-looking')
      const unreadable = await ask(registry)
      const unreadableText = await unreadable.text()
      expect([unreadable.status, unreadableText.includes('not-a-key-but-secret-looking')]).toEqual([500, false])
      sql.exec('UPDATE signing_key SET key = ?', key)
    } finally {
      console.error = realError
    }
    expect(logged).toHaveLength(2)
    expect(logged.some((line) => line.includes(key) || line.includes('not-a-key-but-secret-looking'))).toBe(false)
    expect((await (await ask(registry)).json() as { key: string }).key === key).toBe(true)
    expect(storedKeys(sql)).toHaveLength(1)
  })
})

describe('signingKey(env)', () => {
  test('with the env secret: its exact value, and the registry is neither asked nor written', async () => {
    for (const secret of [random(), '  padded  ', 'k']) {
      const s = service({ SESSION_SIGNING_SECRET: secret })
      expect(await signingKey(s.env) === secret).toBe(true)
      expect(await signingKey(s.env) === secret).toBe(true)
      expect(s.registryCalls).toEqual([])
    }
  })

  test('with no env secret, or one that is empty, white space or not a string: the registry\'s key, asked for once per isolate', async () => {
    for (const absent of [undefined, null, '', ' ', ' \n\t', 7, {}]) {
      const s = service({ SESSION_SIGNING_SECRET: absent })
      const key = await signingKey(s.env)
      expect(KEY_SHAPE.test(key)).toBe(true)
      expect(key === String(absent)).toBe(false)
      expect(await signingKey(s.env) === key).toBe(true)
      expect(await signingKey(s.env) === key).toBe(true)
      expect(s.registryCalls).toEqual([KEY_ROUTE])
      expect(storedKeys(s.registrySql).map((stored) => stored === key)).toEqual([true])
    }
  })

  test('env is looked at on every call: an env secret that appears wins over a remembered registry key, and nothing is copied', async () => {
    const s = service()
    const bindings = s.env as { SESSION_SIGNING_SECRET?: string }
    const kept = await signingKey(s.env)
    const secret = random()
    bindings.SESSION_SIGNING_SECRET = secret
    expect(await signingKey(s.env) === secret).toBe(true)
    bindings.SESSION_SIGNING_SECRET = '   '
    expect(await signingKey(s.env) === kept).toBe(true)
    bindings.SESSION_SIGNING_SECRET = secret
    expect(await signingKey(s.env) === secret).toBe(true)
    delete bindings.SESSION_SIGNING_SECRET
    expect(await signingKey(s.env) === kept).toBe(true)
    // The registry's own key is the one it made: the env value was never written to storage.
    expect(storedKeys(s.registrySql).map((stored) => [stored === kept, stored === secret])).toEqual([[true, false]])
  })

  test('an env secret that goes away after tokens were made: the registry key takes over and the old tokens stop', async () => {
    const secret = random()
    const s = service({ SESSION_SIGNING_SECRET: secret })
    const four = await makeFour(s, 'env')
    expect(await ownerStatuses(s, four)).toEqual(ACCEPTED)
    expect(storedKeys(s.registrySql)).toHaveLength(0)
    s.restart({})
    expect(await ownerStatuses(s, four)).toEqual(REFUSED)
    const key = storedKeys(s.registrySql)
    expect([key.length, key[0] === secret]).toEqual([1, false])
    expect(await ownerStatuses(s, await makeFour(s, 'after'))).toEqual(ACCEPTED)
    // And back: the env secret's tokens work again, the registry key stays in its table unused.
    s.restart({ SESSION_SIGNING_SECRET: secret })
    expect(await ownerStatuses(s, four)).toEqual(ACCEPTED)
    expect(storedKeys(s.registrySql).map((stored) => stored === key[0])).toEqual([true])
  })

  test('first calls at once, from the entry Worker and from objects that remember nothing of each other, all get one key', async () => {
    const s = service()
    // Each stand-in env has its own registry binding (so its own memory) over the same registry object.
    const stub = (s.env.SESSION_REGISTRY as unknown as { get(name: string): { fetch(request: Request): Promise<Response> } }).get('x')
    const envs = Array.from({ length: 12 }, () => ({ SESSION_REGISTRY: { idFromName: () => 'x', get: () => stub } }) as unknown as Env)
    const keys = await Promise.all([...envs.map((env) => signingKey(env)), signingKey(s.env), signingKey(s.env)])
    expect(new Set(keys).size).toBe(1)
    expect(s.registryCalls.every((call) => call === KEY_ROUTE)).toBe(true)
    expect(storedKeys(s.registrySql)).toHaveLength(1)
  })

  test('a registry that fails, answers 500, answers {} or answers something that is not a key throws; nothing is remembered or made up', async () => {
    const good = `${'a'.repeat(42)}Q`
    const answers: Array<() => Promise<Response>> = [
      async () => { throw new Error(`boom ${good}`) },
      async () => new Response(JSON.stringify({ key: good }), { status: 500 }),
      async () => new Response(JSON.stringify({ key: good }), { status: 404 }),
      async () => new Response('{}'),
      async () => new Response('not json'),
      async () => new Response('null'),
      async () => new Response(JSON.stringify({ key: '' })),
      async () => new Response(JSON.stringify({ key: 'short' })),
      async () => new Response(JSON.stringify({ key: 7 })),
      async () => new Response(JSON.stringify({ key: [good] })),
      async () => new Response(JSON.stringify({ Key: good })),
    ]
    let next = 0
    let asked = 0
    const env = { SESSION_REGISTRY: { idFromName: () => 'x', get: () => ({ fetch: async () => { asked += 1; return next < answers.length ? answers[next]() : new Response(JSON.stringify({ key: good })) } }) } } as unknown as Env
    for (; next < answers.length; next += 1) {
      const error = await signingKey(env).then(() => null, (thrown: unknown) => thrown)
      expect(error).toBeInstanceOf(SigningKeyUnavailable)
      expect(String((error as Error).message).includes(good)).toBe(false)
      expect(String((error as Error).stack).includes(good)).toBe(false)
    }
    expect(asked).toBe(answers.length)
    expect(await signingKey(env) === good).toBe(true)
    expect(await signingKey(env) === good).toBe(true)
    expect(asked).toBe(answers.length + 1)
  })

  test('a registry storage error reaches the caller as an error, and the same key is back once storage reads again', async () => {
    const s = service()
    const four = await makeFour(s, 'storage')
    const key = storedKeys(s.registrySql)[0]
    const realError = console.error
    console.error = () => {}
    try {
      s.restart()
      s.registrySql.failReads = true
      expect(await signingKey(s.env).then(() => null, (thrown: unknown) => thrown)).toBeInstanceOf(SigningKeyUnavailable)
      // Nothing can be made while the key cannot be read: no session, share, link or pre-work is left behind.
      for (const [path, body] of [['/sessions', { talkSlug: 'talk-down' }], ['/shares', { talkSlug: 'share-down', title: 'T' }], ['/results', {}], ['/prework', {}]] as const) {
        expect(await s.call('POST', path, ADMIN, body).then(() => 'answered', (thrown: unknown) => thrown instanceof SigningKeyUnavailable)).toBe(true)
      }
      expect(s.registryCalls.filter((call) => call !== KEY_ROUTE && !/^(GET|POST|PUT) \/(internal\/)?(session|share|computers)/.test(call))).toEqual([])
    } finally {
      console.error = realError
      s.registrySql.failReads = false
    }
    expect(storedKeys(s.registrySql).map((stored) => stored === key)).toEqual([true])
    expect(await ownerStatuses(s, four)).toEqual(ACCEPTED)
  })
})

describe('a live service set up by 0.38.2 (env secret present)', () => {
  test('tokens signed with the env value by the old code path verify on every route, and the registry table stays empty', async () => {
    const secret = random()
    const s = service({ SESSION_SIGNING_SECRET: secret })
    const four = await makeFour(s, 'legacy')
    // What 0.38.2 did: `createXToken(payload, env.SESSION_SIGNING_SECRET)`.
    const old = {
      presenter: await createSignedToken({ role: 'presenter', sessionId: four.sessionId, exp: four.expiresAt }, secret),
      share: await createOwnerToken({ role: 'owner', shareId: four.shareId, iat: Date.now() - 86_400_000 }, secret),
      link: await createResultsOwnerToken({ role: 'results-owner', shareId: four.linkId, iat: Date.now() - 86_400_000 }, secret),
      prework: await createPreworkOwnerToken({ role: 'prework-owner', preworkId: four.preworkId, iat: Date.now() - 86_400_000 }, secret),
    }
    expect(await ownerStatuses(s, four, old)).toEqual(ACCEPTED)
    expect(await ownerStatuses(s, four)).toEqual(ACCEPTED)
    // And what this build hands out is what the old code would have: the presenter token is byte for byte the same.
    expect(four.presenterToken === old.presenter).toBe(true)
    expect(Boolean(await verifySignedToken(four.presenterToken, secret))).toBe(true)

    const other = random()
    const forged = {
      presenter: await createSignedToken({ role: 'presenter', sessionId: four.sessionId, exp: four.expiresAt }, other),
      share: await createOwnerToken({ role: 'owner', shareId: four.shareId, iat: Date.now() }, other),
      link: await createResultsOwnerToken({ role: 'results-owner', shareId: four.linkId, iat: Date.now() }, other),
      prework: await createPreworkOwnerToken({ role: 'prework-owner', preworkId: four.preworkId, iat: Date.now() }, other),
    }
    expect(await ownerStatuses(s, four, forged)).toEqual(REFUSED)

    s.restart()
    expect(await ownerStatuses(s, four, old)).toEqual(ACCEPTED)
    expect(s.registryCalls.includes(KEY_ROUTE)).toBe(false)
    expect(storedKeys(s.registrySql)).toHaveLength(0)
  })
})

describe('a live service with no env secret', () => {
  test('a session, a share, a Run link and pre-work are made and their tokens verify, in the entry Worker and in each object', async () => {
    const s = service()
    const four = await makeFour(s, 'fresh')
    expect(await ownerStatuses(s, four)).toEqual(ACCEPTED)
    const key = storedKeys(s.registrySql)
    expect(key).toHaveLength(1)
    // The tokens are signed with the registry's key, and with nothing else.
    expect(Boolean(await verifySignedToken(four.presenterToken, key[0]))).toBe(true)
    expect(four.presenterToken === await createSignedToken({ role: 'presenter', sessionId: four.sessionId, exp: four.expiresAt }, key[0])).toBe(true)
    for (const wrong of ['', ' ', 'undefined', 'null', random()]) {
      const forged = {
        presenter: await createSignedToken({ role: 'presenter', sessionId: four.sessionId, exp: four.expiresAt }, wrong || 'x'),
        share: await createOwnerToken({ role: 'owner', shareId: four.shareId, iat: Date.now() }, wrong || 'x'),
        link: await createResultsOwnerToken({ role: 'results-owner', shareId: four.linkId, iat: Date.now() }, wrong || 'x'),
        prework: await createPreworkOwnerToken({ role: 'prework-owner', preworkId: four.preworkId, iat: Date.now() }, wrong || 'x'),
      }
      expect(await ownerStatuses(s, four, forged)).toEqual(REFUSED)
    }
    // One kind of token never stands in for another.
    expect(await ownerStatuses(s, four, { presenter: four.shareToken, share: four.linkToken, link: four.preworkToken, prework: four.presenterToken })).toEqual(REFUSED)
    // Asked for once by this isolate, whatever number of tokens were made and checked.
    expect(s.registryCalls.filter((call) => call === KEY_ROUTE)).toHaveLength(1)
  })

  test('after the service starts again on the same storage the same tokens still verify, and no second key is made', async () => {
    const s = service()
    const four = await makeFour(s, 'restart')
    const key = storedKeys(s.registrySql)[0]
    for (let round = 0; round < 3; round += 1) {
      s.restart()
      expect(await ownerStatuses(s, four)).toEqual(ACCEPTED)
      expect(storedKeys(s.registrySql).map((stored) => stored === key)).toEqual([true])
    }
    const later = await makeFour(s, 'later')
    expect(await ownerStatuses(s, later)).toEqual(ACCEPTED)
    expect(Boolean(await verifySignedToken(later.presenterToken, key))).toBe(true)
  })

  test('two services never accept each other\'s tokens', async () => {
    const a = service()
    const b = service()
    const fromA = await makeFour(a, 'a')
    const fromB = await makeFour(b, 'b')
    expect(await ownerStatuses(a, fromA, { presenter: fromB.presenterToken, share: fromB.shareToken, link: fromB.linkToken, prework: fromB.preworkToken })).toEqual(REFUSED)
    expect(storedKeys(a.registrySql)[0] === storedKeys(b.registrySql)[0]).toBe(false)
  })
})

describe('the key never leaves the live service', () => {
  const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']
  // `new Request` resolves dot segments and backslashes as a browser would, so several of these reach
  // the Worker as `/internal/signing-key`; the harness test sends the same paths raw.
  const PATHS = [
    '/internal/signing-key', '/internal/signing-key/', '/internal/signing-key?x=1', '//internal/signing-key', '///internal/signing-key',
    '/session/../internal/signing-key', '/session/x/../../internal/signing-key', '/session/./../internal/signing-key',
    '/session/%2e%2e/internal/signing-key', '/session/%2E%2E/internal/signing-key', '/session/.%2e/internal/signing-key',
    '/session/..%2Finternal%2Fsigning-key', '/session/..%2finternal%2fsigning-key', '/session/%2e%2e%2finternal%2fsigning-key',
    '/session/..%252Finternal%252Fsigning-key', '/session/internal%2Fsigning-key', '/session/%2Finternal%2Fsigning-key',
    '/session//internal/signing-key', '/session/internal/signing-key', '/session/signing-key', '/session/..\\internal\\signing-key',
    '/session/..%5Cinternal%5Csigning-key', '/internal%2Fsigning-key', '/%2Finternal%2Fsigning-key', '/internal/./signing-key',
    '/internal/x/../signing-key', '/INTERNAL/SIGNING-KEY', '/session/x?next=/internal/signing-key', '/session/x%3F/internal/signing-key',
    '/session/x%23/../internal/signing-key', '/session/x;/internal/signing-key', '/session/%00/internal/signing-key',
    '/computers/../internal/signing-key', '/shares/by-talk/..%2F..%2Finternal%2Fsigning-key', '/sessions/../internal/signing-key',
    '/results/../internal/signing-key', '/prework/../internal/signing-key', '/shares/../internal/signing-key', '/signing-key',
  ]

  test('no public request, by any method or spelling of the path, with or without an admin key, reaches the key route or gets the key', async () => {
    const s = service()
    const four = await makeFour(s, 'reach')
    const key = storedKeys(s.registrySql)[0]
    s.registryCalls.length = 0
    let asked = 0
    for (const method of METHODS) {
      for (const path of PATHS) {
        for (const bearer of [null, ADMIN, four.presenterToken]) {
          const reply = await s.call(method, path, bearer, method === 'GET' || method === 'HEAD' ? undefined : {})
          asked += 1
          expect([method, path, reply.text.includes(key), reply.text.includes('"key"')]).toEqual([method, path, false, false])
        }
      }
    }
    expect(asked).toBe(METHODS.length * PATHS.length * 3)
    expect(s.registryCalls.includes(KEY_ROUTE)).toBe(false)
    expect(s.registryCalls.some((call) => call.includes('/internal/signing'))).toBe(false)
    // All that reached the registry: the public lookup of one talk slug, and an admin's share lookup.
    expect(s.registryCalls.filter((call) => !/^GET \/session\/[^/]+$/.test(call) && !/^GET \/internal\/share\/[^/]+$/.test(call))).toEqual([])
    expect(s.registryCalls.length).toBeGreaterThan(0)
    expect(storedKeys(s.registrySql).map((stored) => stored === key)).toEqual([true])
  })

  test('on a service that has made no key yet, those requests make none', async () => {
    const s = service()
    for (const method of METHODS) for (const path of PATHS) await s.call(method, path, null, method === 'GET' || method === 'HEAD' ? undefined : {})
    expect(storedKeys(s.registrySql)).toHaveLength(0)
    expect(s.registryCalls.includes(KEY_ROUTE)).toBe(false)
  })

  test('the public session lookup goes to the registry as a request the Worker built: GET, no headers, no body, one path segment', async () => {
    const seen: Array<{ method: string; url: string; headers: string[]; body: string }> = []
    const env = {
      SESSION_REGISTRY: { idFromName: () => 'x', get: () => ({ fetch: async (request: Request) => {
        seen.push({ method: request.method, url: request.url, headers: [...request.headers.keys()], body: await request.text() })
        return new Response('{"live":false}')
      } }) },
      ADMIN_SECRET: ADMIN,
    } as unknown as Env
    for (const path of ['/session/my-talk', '/session/..%2Finternal%2Fsigning-key', '/session/my-talk?x=/internal/signing-key']) {
      const reply = await worker.fetch(new Request(`https://evil.example${path}`, { headers: { authorization: `Bearer ${ADMIN}`, 'x-forwarded-host': 'internal', cookie: 'a=b' } }), env)
      expect(reply.status).toBe(200)
    }
    expect(seen).toEqual([
      { method: 'GET', url: 'https://internal/session/my-talk', headers: [], body: '' },
      { method: 'GET', url: 'https://internal/session/..%2Finternal%2Fsigning-key', headers: [], body: '' },
      { method: 'GET', url: 'https://internal/session/my-talk', headers: [], body: '' },
    ])
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
      expect((await worker.fetch(new Request('https://live.test/session/my-talk', { method }), env)).status).toBe(404)
    }
    expect(seen).toHaveLength(3)
  })

  test('no reply from a sample of every kind of route carries the key, and neither does anything logged', async () => {
    const logged: string[] = []
    const real = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug }
    for (const level of Object.keys(real) as Array<keyof typeof real>) console[level] = (...parts: unknown[]) => { logged.push(parts.map(String).join(' ')) }
    try {
      const s = service()
      const four = await makeFour(s, 'bodies')
      const key = storedKeys(s.registrySql)[0]
      const replies = [
        ...four.replies,
        await s.call('GET', '/capabilities'), await s.call('GET', '/'), await s.call('GET', '/nope'),
        await s.call('GET', '/session/talk-bodies'), await s.call('GET', '/session/never'),
        await s.call('GET', `/sessions/${four.sessionId}/status`), await s.call('GET', `/sessions/${four.sessionId}/status`, four.presenterToken),
        await s.call('GET', `/sessions/${four.sessionId}/status`, 'bad.token'), await s.call('GET', `/sessions/${four.sessionId}/recovery`, four.presenterToken),
        await s.call('GET', `/sessions/${four.sessionId}/recovery`), await s.call('POST', '/sessions', null, { talkSlug: 'x' }), await s.call('POST', '/sessions', ADMIN, { talkSlug: 'Bad Slug' }),
        await s.call('GET', '/shares/by-talk/share-bodies', ADMIN), await s.call('GET', '/shares/by-talk/share-bodies'),
        await s.call('GET', `/shares/${four.shareId}`), await s.call('GET', `/shares/${four.shareId}/items`), await s.call('PUT', `/shares/${four.shareId}/talk`, four.shareToken, {}),
        await s.call('PUT', `/shares/${four.shareId}/talk`, 'bad.token', {}),
        await s.call('GET', `/results/${four.linkId}`), await s.call('PUT', `/results/${four.linkId}/content`, four.linkToken, {}), await s.call('PUT', `/results/${four.linkId}/content`, null, {}),
        await s.call('GET', `/prework/${four.preworkId}`), await s.call('GET', `/prework/${four.preworkId}/results`, four.preworkToken), await s.call('GET', `/prework/${four.preworkId}/results`),
        await s.call('GET', '/computers', ADMIN), await s.call('POST', '/computers/self', ADMIN, { name: 'Studio Mac' }), await s.call('GET', '/computers'),
        await s.call('POST', `/prework/${four.preworkId}/close`, four.preworkToken), await s.call('POST', `/results/${four.linkId}/close`, four.linkToken),
        await s.call('POST', `/shares/${four.shareId}/close`, ADMIN), await s.call('POST', `/sessions/${four.sessionId}/close`, ADMIN, {}),
      ]
      expect(replies.length).toBeGreaterThan(30)
      expect(replies.filter((reply) => reply.text.includes(key))).toHaveLength(0)
      // Nor the route's or the secret's name (the build's own name aside).
      expect(replies.filter((reply) => /signing[-_ ]?key|SESSION_SIGNING_SECRET/i.test(reply.text.replaceAll(LIVE_WORKER_BUILD, '')))).toHaveLength(0)
      expect(logged.filter((line) => line.includes(key))).toHaveLength(0)
      // Nor is it kept anywhere but the registry's one row.
      expect(storedKeys(s.registrySql).map((stored) => stored === key)).toEqual([true])
    } finally {
      Object.assign(console, real)
    }
  })

  test('this build is named 22-signing-key', () => {
    expect(LIVE_WORKER_BUILD).toBe('26-online-content-guidelines')
  })
})
