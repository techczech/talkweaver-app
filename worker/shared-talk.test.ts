import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { SharedTalk, forwardToShare, parseShareRoute, stoppedResponse } from './shared-talk'

describe('stopped, retired or purged share', () => {
  test('the page route serves the "Sharing has stopped" page; API routes answer JSON', async () => {
    const page = stoppedResponse(parseShareRoute('/shares/k7m2ab9x')!)
    expect(page.status).toBe(410)
    expect(page.headers.get('content-type')).toMatch(/text\/html/)
    expect(await page.text()).toContain('Sharing has stopped for this talk.')

    for (const path of ['/shares/k7m2ab9x/talk.json', '/shares/k7m2ab9x/items', '/shares/k7m2ab9x/talk']) {
      const api = stoppedResponse(parseShareRoute(path)!)
      expect(api.status).toBe(410)
      expect(await api.json()).toEqual({ error: { code: 'share_closed', message: 'Sharing has stopped for this talk.' } })
    }
  })
})

// A minimal DurableObjectState stand-in: real SQLite (bun:sqlite, in-memory) behind the same
// `storage.sql.exec(query, ...bindings)` shape the object uses, so its own CREATE TABLE / INSERT /
// SELECT statements run unchanged. `blockConcurrencyWhile`'s callback here has no `await` inside,
// so calling it synchronously (not awaiting the returned promise) already applies its assignments
// before the constructor returns — matching what the constructor needs before the first `fetch`.
function fakeState() {
  const db = new Database(':memory:')
  const sql = { exec: (query: string, ...bindings: unknown[]) => db.query(query).all(...(bindings as [])) }
  return {
    storage: { sql, setAlarm: async () => {}, deleteAlarm: async () => {} },
    blockConcurrencyWhile: (fn: () => Promise<void>) => { fn(); return Promise.resolve() },
    acceptWebSocket: () => {},
    getWebSockets: () => [],
  }
}

describe('SharedTalk init', () => {
  test('refuses a share id once its id is tombstoned, same as an id still in use', async () => {
    // Seed the tombstone row the constructor reads on startup — the state a DO reaches once a
    // closed share's id has been fully purged (worker/shared-talk.ts `deleteEverything`).
    const state = fakeState()
    state.storage.sql.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    state.storage.sql.exec('INSERT INTO kv (key, value) VALUES (?, ?)', 'tombstone', 'k7m2ab9x')

    const object = new SharedTalk(state as never, {} as never)
    const response = await object.fetch(new Request('https://internal/internal/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shareId: 'k7m2ab9x', talkSlug: 'ai-assessment', title: 'T', createdAt: Date.now(), status: 'open' }),
    }))
    expect(response.status).toBe(409)
    expect((await response.json()).error.code).toBe('already_exists')
  })

  test('refuses a reserved share id even from a genuine internal call', async () => {
    const state = fakeState()
    const object = new SharedTalk(state as never, {} as never)
    const response = await object.fetch(new Request('https://internal/internal/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shareId: 'internal', talkSlug: 'ai-assessment', title: 'T', createdAt: Date.now(), status: 'open' }),
    }))
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('invalid_share')
  })
})

// Security review, ticket 07: a bare `/internal/close` used to reach the object's raw, credential-
// free internal Stop handler once the route grammar accepted paths without a `/shares/` prefix
// (`internal` fits the 8-letter share-id shape, and `close` is a real action word). Two independent
// layers now close this: the object only honours `/internal/*` from its own internal-only host
// (shared-talk.ts `internalPost`), and the entry Worker's forwarder never sends anything else.
describe('the object\'s /internal/* routes are internal-host only', () => {
  function seedOpenShare(state: ReturnType<typeof fakeState>, shareId: string): void {
    state.storage.sql.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    const share = {
      shareId, talkSlug: 'ai-assessment', title: 'T', createdAt: 1_000, lastActivityAt: 1_000,
      status: 'open', unregistered: false, purged: false, revision: 0, updatedAt: null,
      talkSeq: 0, seq: 0, itemCount: 0, itemBytes: 0, bucket: { tokens: 5, at: 1_000 },
    }
    state.storage.sql.exec('INSERT INTO kv (key, value) VALUES (?, ?)', 'share', JSON.stringify(share))
  }

  test('a forged /internal/close from a public host never closes the share; the genuine internal call does', async () => {
    const state = fakeState()
    // Seeded directly (bypassing `init`'s own reserved-id refusal above) so this test proves the
    // host guard holds on its own, independent of the reserved-id layer.
    seedOpenShare(state, 'internal')
    const object = new SharedTalk(state as never, {} as never)

    const forged = await object.fetch(new Request('https://drafts.handouts.fyi/internal/close', { method: 'POST' }))
    expect(forged.status).toBe(404) // falls through to ordinary routing — parseShareRoute refuses 'internal' too

    const genuine = await object.fetch(new Request('https://internal/internal/close', { method: 'POST' }))
    expect(genuine.status).toBe(200)
    expect(await genuine.json()).toEqual({ ok: true })
  })
})

describe('forwardToShare always canonicalises the forwarded path', () => {
  test('rewrites every accepted request to /shares/<id>/<action>, never trusting the incoming pathname', async () => {
    const seenPaths: string[] = []
    const fakeStub = { fetch: async (request: Request) => { seenPaths.push(new URL(request.url).pathname); return new Response('{}', { status: 200 }) } }
    const env = { SHARED_TALKS: { idFromName: (name: string) => name, get: () => fakeStub }, SESSION_SIGNING_SECRET: 'test-signing-secret' }

    await forwardToShare(new Request('https://drafts.handouts.fyi/k7m2ab9x'), env as never, { shareId: 'k7m2ab9x', action: 'page' })
    // A route whose action is a sensitive word — forwardToShare never trusts the request's own
    // pathname, only the canonical form it builds from the already-parsed `route`.
    await forwardToShare(
      new Request('https://drafts.handouts.fyi/internal/close', { method: 'POST' }),
      env as never,
      { shareId: 'k7m2ab9x', action: 'close' },
    )

    expect(seenPaths).toEqual(['/shares/k7m2ab9x', '/shares/k7m2ab9x/close'])
  })
})
