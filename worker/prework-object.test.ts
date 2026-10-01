// The RunPrework object over a real SQLite (bun:sqlite) standing in for Durable Object storage, with a
// switch that makes a write throw: a submission whose third write fails is rolled back as a whole,
// answered 503 (never 500), and memory is reloaded so it never runs ahead of storage.
import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { createPreworkOwnerToken } from './auth'
import { RunPrework, forwardToPrework, parsePreworkRoute } from './prework'

const SECRET = 'test-signing-secret-prework'

function fakeState(options: { transactions: boolean }) {
  const db = new Database(':memory:')
  const control = { failOnWrite: 0, writes: 0 }
  const sql = {
    exec(query: string, ...bindings: unknown[]) {
      if (/^\s*(INSERT|UPDATE|DELETE)/i.test(query)) {
        control.writes += 1
        if (control.failOnWrite && control.writes === control.failOnWrite) throw new Error('storage write failed')
      }
      const statement = db.prepare(query)
      return /^\s*SELECT/i.test(query) ? statement.all(...(bindings as never[])) : (statement.run(...(bindings as never[])), [])
    },
  }
  const storage: Record<string, unknown> = {
    sql,
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  }
  if (options.transactions) storage.transactionSync = <T>(fn: () => T): T => db.transaction(fn)()
  const state = {
    storage,
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => { void fn() },
    acceptWebSocket: () => {},
    getWebSockets: () => [],
  }
  return { state, control, db }
}

const form = {
  title: 'Before the session', intro: '',
  steps: [{ id: 'pwwelcome', n: 1, title: 'Welcome', kind: 'slide', questions: true }],
}

async function setUp(transactions: boolean) {
  const { state, control, db } = fakeState({ transactions })
  const object = new RunPrework(state as never, { SESSION_SIGNING_SECRET: SECRET, ADMIN_SECRET: 'admin' } as never)
  await new Promise((resolve) => setTimeout(resolve, 0))
  const init = await object.fetch(new Request('https://internal/internal/init', { method: 'POST', body: JSON.stringify({ preworkId: 'ab12cd34', createdAt: Date.now() }) }))
  expect(init.status).toBe(201)
  const token = await createPreworkOwnerToken({ role: 'prework-owner', preworkId: 'ab12cd34', iat: Date.now() }, SECRET)
  const pushed = await object.fetch(new Request('https://w.test/prework/ab12cd34/form', {
    method: 'PUT', headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ opensAt: Date.now() - 1_000, closesAt: Date.now() + 3_600_000, form }),
  }))
  expect(pushed.status).toBe(200)
  const submit = (participantId: string, submissionId: string) => object.fetch(new Request('https://w.test/prework/ab12cd34/submit', {
    method: 'POST', headers: { 'x-tw-prework-source': '203.0.113.7' },
    body: JSON.stringify({ participantId, submissionId, stepId: 'pwwelcome', kind: 'read' }),
  }))
  const results = async () => (await object.fetch(new Request('https://w.test/prework/ab12cd34/results?after=0', { headers: { authorization: `Bearer ${token}` } }))).json() as
    Promise<{ seq: number; people: number; entries: unknown[] }>
  const stored = () => JSON.parse((db.prepare('SELECT value FROM kv WHERE key = ?').get('prework') as { value: string }).value) as { seq: number; participants: number }
  const close = () => object.fetch(new Request('https://w.test/prework/ab12cd34/close', { method: 'POST', headers: { authorization: `Bearer ${token}` } }))
  return { control, submit, results, stored, db, close }
}

describe('a storage write that fails mid-submission', () => {
  test('with transactions: nothing of it is stored, it answers 503, memory matches storage, a retry succeeds', async () => {
    const { control, submit, results, stored, db } = await setUp(true)
    control.writes = 0
    control.failOnWrite = 3
    const failed = await submit('device-0123456789abcdef', 'sub-1')
    expect(failed.status).toBe(503)
    expect(((await failed.json()) as { error: { code: string } }).error.code).toBe('prework_unavailable')
    control.failOnWrite = 0
    expect(db.prepare('SELECT COUNT(*) AS n FROM entries').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM sources').get()).toEqual({ n: 0 })
    expect(await results()).toMatchObject({ seq: 0, people: 0, entries: [] })
    expect(stored()).toMatchObject({ seq: 0, participants: 0 })
    const retried = await submit('device-0123456789abcdef', 'sub-1')
    expect(retried.status).toBe(201)
    expect(await results()).toMatchObject({ seq: 1, people: 1 })
    expect(stored()).toMatchObject({ seq: 1, participants: 1 })
  })

  test('without transactions: memory is reloaded from storage, so it never runs ahead of it', async () => {
    const { control, submit, results, stored } = await setUp(false)
    control.writes = 0
    control.failOnWrite = 3
    expect((await submit('device-0123456789abcdef', 'sub-1')).status).toBe(503)
    control.failOnWrite = 0
    expect(stored()).toMatchObject({ seq: 0, participants: 0 })
    expect(await results()).toMatchObject({ seq: 0, people: 0 })
  })
})

describe('a close whose owner check is awaited while another request reloads memory', () => {
  test('the early close is still saved', async () => {
    const { control, submit, stored, close } = await setUp(true)
    // Hold the close in its owner-token check (HMAC sign) until the failing submit has reloaded memory.
    const subtle = crypto.subtle as unknown as { sign: (...args: unknown[]) => Promise<ArrayBuffer> }
    const realSign = subtle.sign.bind(crypto.subtle)
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    subtle.sign = async (...args: unknown[]) => { await held; return realSign(...args) }
    try {
      const closing = close()
      control.writes = 0
      control.failOnWrite = 3
      expect((await submit('device-0123456789abcdef', 'sub-9')).status).toBe(503)
      control.failOnWrite = 0
      release()
      const closed = await closing
      expect(closed.status).toBe(200)
      const { closedAt } = await closed.json() as { closedAt: number }
      expect((stored() as { closedAt?: number }).closedAt).toBe(closedAt)
    } finally {
      subtle.sign = realSign
    }
  })
})

describe('the network source the entry Worker passes on', () => {
  const env = (extra: Record<string, string> = {}) => ({
    SESSION_SIGNING_SECRET: SECRET, ADMIN_SECRET: 'admin', ...extra,
    RUN_PREWORK: { idFromName: (name: string) => name, get: () => ({ fetch: async (request: Request) => new Response(request.headers.get('x-tw-prework-source'), { status: 201 }) }) },
  }) as never
  const submit = (headers: Record<string, string> = {}) => new Request('https://w.test/prework/ab12cd34/submit', { method: 'POST', headers, body: '{}' })
  const route = parsePreworkRoute('/prework/ab12cd34/submit')!

  test('in a deployment a submission with no cf-connecting-ip is refused 503, never put in one shared bucket', async () => {
    const refused = await forwardToPrework(submit(), env(), route)
    expect(refused.status).toBe(503)
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('source_unknown')
    const taken = await forwardToPrework(submit({ 'cf-connecting-ip': '203.0.113.7' }), env(), route)
    expect([taken.status, await taken.text()]).toEqual([201, '203.0.113.7'])
  })

  test('a local Worker (PREWORK_LOCAL_SOURCE=1) treats a request with no address as one local source', async () => {
    const local = await forwardToPrework(submit(), env({ PREWORK_LOCAL_SOURCE: '1' }), route)
    expect([local.status, await local.text()]).toEqual([201, 'local'])
  })

  test('the client can never set the source itself', async () => {
    const spoofed = await forwardToPrework(submit({ 'cf-connecting-ip': '203.0.113.7', 'x-tw-prework-source': '192.0.2.1' }), env(), route)
    expect(await spoofed.text()).toBe('203.0.113.7')
    const statusRoute = parsePreworkRoute('/prework/ab12cd34')!
    const status = await forwardToPrework(new Request('https://w.test/prework/ab12cd34'), env(), statusRoute)
    expect(status.status).toBe(201)
  })
})
