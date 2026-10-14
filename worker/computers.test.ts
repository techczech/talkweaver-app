// The list of computers that can go live (going live from several Macs, ticket 01), through the entry
// Worker's own fetch and the real SessionRegistry object over a real SQLite (bun:sqlite) standing in
// for Durable Object storage. Key values are made per run and never printed.
import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import worker, { SessionRegistry } from './index'
import { COMPUTER_NAME_MAX, ComputersTable, parseComputerName } from './computers'
import { LIVE_PROTOCOL_VERSION, LIVE_WORKER_BUILD } from './recovery-protocol'
import type { Env } from './http'

const random = () => [...crypto.getRandomValues(new Uint8Array(24))].map((byte) => byte.toString(16).padStart(2, '0')).join('')
const LEGACY = random()
const MACB = random()
const SIGNING = random()

function sqlStorage() {
  const db = new Database(':memory:')
  return { exec: (query: string, ...bindings: unknown[]) => db.query(query).all(...(bindings as [])) } as unknown as SqlStorage
}

/** The entry Worker over one registry object; `registryCalls` records what reached the object. */
function service(extra: Record<string, unknown> = {}) {
  const sql = sqlStorage()
  const state = { storage: { sql, setAlarm: async () => {}, deleteAlarm: async () => {} } }
  const registry = new SessionRegistry(state as never)
  const registryCalls: string[] = []
  const env = {
    SESSION_REGISTRY: { idFromName: () => 'registry', get: () => ({ fetch: (request: Request) => {
      registryCalls.push(`${request.method} ${new URL(request.url).pathname}`)
      return registry.fetch(request)
    } }) },
    ADMIN_SECRET: LEGACY, ADMIN_SECRET_macb: MACB, SESSION_SIGNING_SECRET: SIGNING, ...extra,
  } as unknown as Env
  async function call(method: string, path: string, key?: string | null, body?: unknown, bindings: Env = env) {
    const response = await worker.fetch(new Request(`https://live.test${path}`, {
      method,
      headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    }), bindings)
    const text = await response.text()
    return { status: response.status, text, json: text ? JSON.parse(text) : null }
  }
  return { env, call, registryCalls, sql, restart: () => new SessionRegistry(state as never) }
}

describe('a computer\'s name', () => {
  test('is trimmed and kept as typed: any script, punctuation and spaces', () => {
    for (const name of ['Studio Mac', 'Dominik’s MacBook Pro (2)', 'Kancelář – iMac', '書斎のMac', 'a', 'x'.repeat(COMPUTER_NAME_MAX), '😀'.repeat(COMPUTER_NAME_MAX)]) {
      expect(parseComputerName(name)).toBe(name)
    }
    expect(parseComputerName('  Studio Mac \n')).toBe('Studio Mac')
  })

  test('is refused when empty, too long, on more than one line, or carrying hidden characters', () => {
    for (const name of [
      '', '   ', 'x'.repeat(COMPUTER_NAME_MAX + 1), '😀'.repeat(COMPUTER_NAME_MAX + 1), 'x'.repeat(100_000),
      'two\nlines', 'tab\tname', 'nul\u0000name', 'bell\u0007', 'esc\u001b[31m', 'del\u007f', 'c1\u0085',
      'rtl\u202eoverride', 'zero\u200bwidth', 'b\ufeffom', 'line\u2028sep', 'para\u2029sep', 'lone\ud800surrogate', 'private\ue000use',
      null, undefined, 7, true, ['Studio Mac'], { name: 'Studio Mac' },
    ]) {
      expect(parseComputerName(name)).toBeNull()
    }
  })
})

describe('the computers table', () => {
  test('is made once, and making it again loses nothing', () => {
    const sql = sqlStorage()
    const first = new ComputersTable(sql)
    expect(first.list()).toEqual([])
    first.record('legacy', 'Studio Mac', 1_000)
    expect(new ComputersTable(sql).list()).toEqual([{ id: 'legacy', name: 'Studio Mac', joinedAt: 1_000, joinedWithCode: false }])
  })

  test('a rename keeps when and how the computer joined; a line joined with a code reads as such', () => {
    const sql = sqlStorage()
    const table = new ComputersTable(sql)
    table.record('macb', 'Laptop', 2_000)
    sql.exec('INSERT INTO computers (id, name, joined_at, joined_with_code) VALUES (?, ?, ?, 1)', 'macc', 'Travel Mac', 3_000)
    expect(table.record('macb', 'Laptop (old)', 9_000)).toEqual({ id: 'macb', name: 'Laptop (old)', joinedAt: 2_000, joinedWithCode: false })
    expect(table.record('macc', 'Travel', 9_000)).toEqual({ id: 'macc', name: 'Travel', joinedAt: 3_000, joinedWithCode: true })
    table.remove('macb')
    table.remove('never-there')
    expect(table.list().map((line) => line.id)).toEqual(['macc'])
  })

  test('the table has exactly the four columns of the spec: nothing a key could be kept in', () => {
    const sql = sqlStorage()
    new ComputersTable(sql)
    const columns = [...sql.exec<{ name: string }>('SELECT name FROM pragma_table_info(\'computers\')')].map((row) => row.name)
    expect(columns).toEqual(['id', 'name', 'joined_at', 'joined_with_code'])
  })
})

describe('GET /computers, POST /computers/self, DELETE /computers/<id>', () => {
  const REFUSAL = { error: { code: 'admin_auth_required', message: 'Admin authentication is required.' } }

  test('all three are admin only, and a refusal reads no body, reaches no object and says nothing about keys', async () => {
    const s = service()
    const routes: Array<[string, string, unknown?]> = [
      ['GET', '/computers'], ['POST', '/computers/self', { name: 'Studio Mac' }], ['DELETE', '/computers/legacy'], ['DELETE', '/computers/macb'],
      // Refused before the id or the body is looked at: no different answer for a bad one.
      ['DELETE', '/computers/NOT-AN-ID'], ['POST', '/computers/self', 'not json'], ['POST', '/computers/self', { name: '' }],
    ]
    for (const [method, path, body] of routes) {
      for (const key of [null, random(), SIGNING, 'legacy', 'macb', 'ADMIN_SECRET', 'ADMIN_SECRET_macb']) {
        const refused = await s.call(method, path, key, body)
        expect(refused.status).toBe(401)
        expect(refused.json).toEqual(REFUSAL)
      }
    }
    expect(s.registryCalls).toEqual([])
    // The same refusal whichever keys exist: one computer, two, or none.
    const none = service({ ADMIN_SECRET: undefined, ADMIN_SECRET_macb: undefined })
    const one = service({ ADMIN_SECRET_macb: undefined })
    for (const other of [none, one]) expect((await other.call('GET', '/computers', random())).text).toBe((await s.call('GET', '/computers', random())).text)
  })

  test('the legacy computer appears as "legacy" once it has recorded itself; a second computer under its own id', async () => {
    const s = service()
    expect((await s.call('GET', '/computers', LEGACY)).json).toEqual({ computers: [], self: 'legacy' })

    const before = Date.now()
    const recorded = await s.call('POST', '/computers/self', LEGACY, { name: '  Studio Mac ' })
    expect(recorded.status).toBe(200)
    expect(recorded.json.computer).toMatchObject({ id: 'legacy', name: 'Studio Mac', joinedWithCode: false })
    expect(recorded.json.computer.joinedAt).toBeGreaterThanOrEqual(before)
    expect(recorded.json.computer.joinedAt).toBeLessThanOrEqual(Date.now())

    expect((await s.call('POST', '/computers/self', MACB, { name: 'Laptop' })).json.computer).toMatchObject({ id: 'macb', name: 'Laptop', joinedWithCode: false })
    const fromSecond = await s.call('GET', '/computers', MACB)
    expect(fromSecond.json.self).toBe('macb')
    expect(fromSecond.json.computers.map((line: { id: string; name: string }) => [line.id, line.name]).sort()).toEqual([['legacy', 'Studio Mac'], ['macb', 'Laptop']])
    for (const line of fromSecond.json.computers) expect(Object.keys(line).sort()).toEqual(['id', 'joinedAt', 'joinedWithCode', 'name'])
  })

  test('the id recorded is the one the key belongs to, never one the request names', async () => {
    const s = service()
    await s.call('POST', '/computers/self', MACB, { name: 'Laptop', id: 'legacy', computerId: 'legacy', joinedAt: 1, joinedWithCode: true })
    expect((await s.call('GET', '/computers', MACB)).json.computers).toMatchObject([{ id: 'macb', name: 'Laptop', joinedWithCode: false }])
    expect((await s.call('GET', '/computers', MACB)).json.computers[0].joinedAt).toBeGreaterThan(1)
  })

  test('recording again renames and keeps the joined date', async () => {
    const s = service()
    const first = (await s.call('POST', '/computers/self', LEGACY, { name: 'Studio Mac' })).json.computer
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = (await s.call('POST', '/computers/self', LEGACY, { name: 'Office Mac' })).json.computer
    expect(second).toEqual({ ...first, name: 'Office Mac' })
    expect((await s.call('GET', '/computers', LEGACY)).json.computers).toEqual([second])
  })

  test('the list survives the registry object starting again', async () => {
    const s = service()
    await s.call('POST', '/computers/self', LEGACY, { name: 'Studio Mac' })
    const again = s.restart()
    const listed = await (await again.fetch(new Request('https://internal/internal/computers'))).json() as { computers: unknown[] }
    expect(listed.computers).toHaveLength(1)
  })

  test('a name that is not one is refused and nothing is recorded', async () => {
    const s = service()
    for (const body of [{}, { name: '' }, { name: '   ' }, { name: 7 }, { name: null }, { name: ['x'] }, { name: 'x'.repeat(COMPUTER_NAME_MAX + 1) },
      { name: 'two\nlines' }, { name: 'rtl\u202eoverride' }, [], 'null', '"Studio Mac"', 'not json', '']) {
      const refused = await s.call('POST', '/computers/self', LEGACY, body)
      expect(refused.status).toBe(400)
      expect(refused.json.error.code).toBe('invalid_computer_name')
    }
    const tooLarge = await s.call('POST', '/computers/self', LEGACY, { name: 'x'.repeat(5_000) })
    expect(tooLarge.status).toBe(413)
    expect((await s.call('GET', '/computers', LEGACY)).json.computers).toEqual([])
  })

  test('DELETE removes the line only: the removed computer\'s key is still its key', async () => {
    const s = service()
    await s.call('POST', '/computers/self', LEGACY, { name: 'Studio Mac' })
    await s.call('POST', '/computers/self', MACB, { name: 'Laptop' })

    expect((await s.call('DELETE', '/computers/macb', LEGACY)).json).toEqual({ ok: true })
    expect((await s.call('GET', '/computers', LEGACY)).json.computers.map((line: { id: string }) => line.id)).toEqual(['legacy'])
    // Removing the secret is the app's job, through Cloudflare: until then the key still passes.
    expect((await s.call('GET', '/computers', MACB)).json.self).toBe('macb')
    // Removing again, or a computer never listed, is the same answer.
    expect((await s.call('DELETE', '/computers/macb', LEGACY)).json).toEqual({ ok: true })
    expect((await s.call('DELETE', '/computers/zz99', LEGACY)).status).toBe(200)
    // Any computer can remove any line, its own and the legacy one included.
    expect((await s.call('DELETE', '/computers/legacy', MACB)).status).toBe(200)
    expect((await s.call('GET', '/computers', LEGACY)).json).toEqual({ computers: [], self: 'legacy' })
  })

  test('DELETE refuses what cannot be a computer id, and touches nothing', async () => {
    const s = service()
    await s.call('POST', '/computers/self', LEGACY, { name: 'Studio Mac' })
    for (const id of ['self', 'join', 'LEGACY', 'Mac', 'a_b', 'a-b', '%6cegacy', 'a%20b', 'a'.repeat(65), '*', "x';DROP TABLE computers;--"]) {
      const refused = await s.call('DELETE', `/computers/${id}`, LEGACY)
      expect([refused.status, refused.json?.error?.code]).toEqual([400, 'invalid_computer_id'])
    }
    expect((await s.call('GET', '/computers', LEGACY)).json.computers).toHaveLength(1)
  })

  test('no reply ever carries a key, a digest of one, or a secret\'s name', async () => {
    const s = service()
    const replies = [
      await s.call('POST', '/computers/self', LEGACY, { name: 'Studio Mac' }),
      await s.call('POST', '/computers/self', MACB, { name: 'Laptop' }),
      await s.call('GET', '/computers', LEGACY), await s.call('GET', '/computers', MACB),
      await s.call('GET', '/computers'), await s.call('GET', '/computers', random()),
      await s.call('DELETE', '/computers/macb', LEGACY), await s.call('DELETE', '/computers/Bad', LEGACY),
      await s.call('POST', '/computers/self', MACB, { name: '' }),
    ]
    const digest = async (value: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
      .map((byte) => byte.toString(16).padStart(2, '0')).join('')
    const never = [LEGACY, MACB, SIGNING, await digest(LEGACY), await digest(MACB), 'ADMIN_SECRET', 'SESSION_SIGNING_SECRET']
    for (const reply of replies) for (const text of never) expect(reply.text.includes(text)).toBe(false)
    // Nor does the table: every stored cell is an id, a name, a date or a flag.
    const cells = [...s.sql.exec<Record<string, unknown>>('SELECT * FROM computers')].flatMap((row) => Object.values(row).map(String))
    for (const cell of cells) for (const text of never) expect(cell.includes(text)).toBe(false)
  })

  test('nothing else under /computers is a route, and the object\'s internal path is not reachable from outside', async () => {
    const s = service()
    for (const [method, path] of [
      ['POST', '/computers'], ['PUT', '/computers'], ['DELETE', '/computers'], ['GET', '/computers/self'], ['PUT', '/computers/self'],
      ['GET', '/computers/legacy'], ['GET', '/computers/'], ['POST', '/computers/self/x'], ['DELETE', '/computers/macb/x'], ['DELETE', '/computers/'],
      ['GET', '/internal/computers'], ['PUT', '/internal/computers/legacy'], ['DELETE', '/internal/computers/legacy'],
    ]) {
      const reply = await s.call(method, path, LEGACY, method === 'GET' || method === 'DELETE' ? undefined : { name: 'x' })
      expect([method, path, reply.status, reply.json?.error?.code]).toEqual([method, path, 404, 'not_found'])
    }
    expect(s.registryCalls).toEqual([])
  })

  test('GET /capabilities keeps its shape and names this build', async () => {
    const s = service()
    expect((await s.call('GET', '/capabilities')).json).toEqual({ protocol: LIVE_PROTOCOL_VERSION, build: LIVE_WORKER_BUILD })
    expect(LIVE_WORKER_BUILD).toBe('22-signing-key')
  })
})
