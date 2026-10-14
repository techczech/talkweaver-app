// Admin keys, one per computer (going live from several Macs, ticket 01): which bindings count, which
// headers count, that every candidate is compared, and that a 0.38.2 computer's key behaves as before.
// Values here are made per run and never printed: assertions compare ids and booleans only.
import { describe, expect, spyOn, test } from 'bun:test'
import {
  adminBearer, adminSecretName, computerIdForSecretName, matchAdminKey, validComputerId, validListedComputerId,
} from './admin-keys'
import * as auth from './auth.ts'
import { constantTimeEqual, hashSecret } from './auth.ts'
import { adminAuthorised, bearerToken, type Env } from './http'

const random = () => [...crypto.getRandomValues(new Uint8Array(24))].map((byte) => byte.toString(16).padStart(2, '0')).join('')
const LEGACY = random()
const SECOND = random()
const THIRD = random()
const SIGNING = random()

/** Stand-ins for the non-string bindings a deployed Worker has. */
const namespace = () => ({ idFromName: () => 'id', get: () => ({ fetch: async () => new Response('{}') }) })

function env(extra: Record<string, unknown> = {}): Env {
  return {
    LIVE_SESSIONS: namespace(), SESSION_REGISTRY: namespace(), SHARED_TALKS: namespace(), RUN_SHARES: namespace(), RUN_PREWORK: namespace(),
    ADMIN_SECRET: LEGACY, SESSION_SIGNING_SECRET: SIGNING, ...extra,
  } as unknown as Env
}

const request = (authorization?: string) => new Request('https://worker.test/sessions', {
  method: 'POST', headers: authorization === undefined ? {} : { authorization },
})
const check = (bearer: string, bindings: Env) => adminAuthorised(request(`Bearer ${bearer}`), bindings)

/** `adminAuthorised` exactly as 0.38.2 shipped it (worker/http.ts at build 20-pointer-live). */
async function adminAuthorised0382(req: Request, bindings: { ADMIN_SECRET: string }): Promise<boolean> {
  const bearer = bearerToken(req)
  return Boolean(bearer) && constantTimeEqual(await hashSecret(bearer!), await hashSecret(bindings.ADMIN_SECRET))
}

describe('which computer an admin bearer belongs to', () => {
  test('the first computer\'s ADMIN_SECRET is computer "legacy"', async () => {
    expect(await check(LEGACY, env())).toBe('legacy')
  })

  test('a key under ADMIN_SECRET_<id> is that computer, beside the legacy one', async () => {
    const bindings = env({ ADMIN_SECRET_macb: SECOND, ADMIN_SECRET_9f3c2a7b1d4e5f60: THIRD })
    expect(await check(SECOND, bindings)).toBe('macb')
    expect(await check(THIRD, bindings)).toBe('9f3c2a7b1d4e5f60')
    expect(await check(LEGACY, bindings)).toBe('legacy')
  })

  test('once a computer\'s secret is absent its bearer is refused and the others still pass', async () => {
    const before = env({ ADMIN_SECRET_macb: SECOND })
    expect(await check(SECOND, before)).toBe('macb')
    const after = env()
    expect(await check(SECOND, after)).toBeNull()
    expect(await check(LEGACY, after)).toBe('legacy')
  })

  test('the legacy computer can be the one removed', async () => {
    const bindings = env({ ADMIN_SECRET: undefined, ADMIN_SECRET_macb: SECOND })
    delete (bindings as { ADMIN_SECRET?: string }).ADMIN_SECRET
    expect(await check(LEGACY, bindings)).toBeNull()
    expect(await check(SECOND, bindings)).toBe('macb')
  })

  test('what is returned is the id, never the value', async () => {
    const matched = await check(SECOND, env({ ADMIN_SECRET_macb: SECOND }))
    expect(matched).toBe('macb')
    expect(matched!.includes(SECOND)).toBe(false)
  })

  test('should two names hold one value, the first in order is named: legacy, then by id', async () => {
    expect(await check(LEGACY, env({ ADMIN_SECRET_aaaa: LEGACY }))).toBe('legacy')
    expect(await check(SECOND, env({ ADMIN_SECRET_zz: SECOND, ADMIN_SECRET_bb: SECOND }))).toBe('bb')
  })
})

describe('names that are not admin keys', () => {
  const nearMisses = [
    'ADMIN_SECRETS', 'XADMIN_SECRET_a', 'XADMIN_SECRET', 'ADMIN_SECRET_', 'ADMIN_SECRET__a', 'ADMIN_SECRET_a_b', 'ADMIN_SECRET_a-b',
    'ADMIN_SECRET_a.b', 'ADMIN_SECRET_Mac', 'ADMIN_SECRET_MACB', 'ADMIN_SECRET_a b', 'ADMIN_SECRET_a\n', ' ADMIN_SECRET_a', 'ADMIN_SECRET ',
    'admin_secret', 'admin_secret_a', 'Admin_Secret_a', 'ADMIN_SECRET_é', `ADMIN_SECRET_${'a'.repeat(65)}`,
    // The three words that are never a computer's id.
    'ADMIN_SECRET_legacy', 'ADMIN_SECRET_self', 'ADMIN_SECRET_join',
    'SESSION_SIGNING_SECRET', 'ADMIN', 'SECRET', 'ADMIN_SECRET_SIGNING_SECRET',
  ]

  test.each(nearMisses)('%p never matches', async (name) => {
    expect(computerIdForSecretName(name)).toBeNull()
    const value = random()
    const bindings = env({ [name]: value })
    // SESSION_SIGNING_SECRET is set by env() itself: its own value is the one to try.
    expect(await check(name === 'SESSION_SIGNING_SECRET' ? SIGNING : value, bindings)).toBeNull()
    expect(await check(LEGACY, bindings)).toBe('legacy')
  })

  test('the signing secret is never an admin key', async () => {
    expect(await check(SIGNING, env())).toBeNull()
    expect(await check(SIGNING, env({ ADMIN_SECRET_macb: SECOND }))).toBeNull()
  })

  test('the id alphabet: lower-case letters and digits, 1 to 64, and three reserved words', () => {
    for (const id of ['a', '0', 'macb', '9f3c2a7b1d4e5f60', 'a'.repeat(64)]) {
      expect(validComputerId(id)).toBe(true)
      expect(computerIdForSecretName(adminSecretName(id))).toBe(id)
    }
    for (const id of ['', 'A', 'Mac', 'a_b', 'a-b', 'a b', 'a/b', 'é', 'a'.repeat(65), 'legacy', 'self', 'join', null, undefined, 7, {}]) {
      expect(validComputerId(id)).toBe(false)
    }
    expect(validListedComputerId('legacy')).toBe(true)
    expect(validListedComputerId('self')).toBe(false)
    expect(adminSecretName('legacy')).toBe('ADMIN_SECRET')
    expect(computerIdForSecretName('ADMIN_SECRET')).toBe('legacy')
  })
})

describe('values that are not admin keys', () => {
  test.each(['', ' ', '\t', '\n', ' \r\n '])('an empty or white-space secret %p never matches, whatever is sent', async (value) => {
    for (const bindings of [env({ ADMIN_SECRET: value }), env({ ADMIN_SECRET_macb: value })]) {
      for (const authorization of ['Bearer ', `Bearer ${value}`, 'Bearer', '', 'Bearer undefined', 'Bearer null', 'Bearer  ']) {
        const matched = await adminAuthorised(request(authorization), bindings)
        // Only the untouched legacy key of the second env could match, and nothing here sends it.
        expect(matched).toBeNull()
      }
    }
  })

  test('an unset secret never matches a bearer spelling "undefined", "null" or nothing', async () => {
    const bindings = { SESSION_SIGNING_SECRET: SIGNING, ADMIN_SECRET: undefined, ADMIN_SECRET_macb: undefined, ADMIN_SECRET_macc: null } as unknown as Env
    for (const authorization of [undefined, '', 'Bearer', 'Bearer ', 'Bearer undefined', 'Bearer null', 'undefined', 'null']) {
      expect(await adminAuthorised(request(authorization), bindings)).toBeNull()
    }
  })

  test('a binding that is not a string never counts, even one that turns into the bearer as text', async () => {
    const sneaky = { toString: () => SECOND, valueOf: () => SECOND, trim: () => SECOND, length: SECOND.length }
    const bindings = env({
      ADMIN_SECRET: sneaky, ADMIN_SECRET_macb: sneaky, ADMIN_SECRET_ns: namespace(), ADMIN_SECRET_num: 12345,
      ADMIN_SECRET_list: [SECOND], ADMIN_SECRET_bool: true, ADMIN_SECRET_wrapped: new String(SECOND),
    })
    for (const bearer of [SECOND, '12345', 'true', '[object Object]', LEGACY]) expect(await check(bearer, bindings)).toBeNull()
  })

  test('inherited properties of env never count', async () => {
    const bindings = Object.create({ ADMIN_SECRET: LEGACY, ADMIN_SECRET_macb: SECOND }) as Env
    expect(await check(LEGACY, bindings)).toBeNull()
    expect(await check(SECOND, bindings)).toBeNull()
  })
})

describe('the Authorization header', () => {
  const bindings = env({ ADMIN_SECRET_macb: SECOND })

  test('missing, empty, scheme only, another scheme, or the bare value all fail', async () => {
    for (const authorization of [
      undefined, '', ' ', 'Bearer', 'Bearer ', 'Bearer    ', 'bearer', LEGACY, SECOND, `Basic ${LEGACY}`, `Token ${SECOND}`,
      `Bearer${LEGACY}`, `Bearer:${LEGACY}`, `X Bearer ${LEGACY}`, `Bearer ${LEGACY} extra`, `Bearer ${LEGACY},${SECOND}`,
      `Bearer ${LEGACY.slice(0, -1)}`, `Bearer ${LEGACY}0`, `Bearer ${LEGACY.toUpperCase()}x`,
    ]) {
      expect(await adminAuthorised(request(authorization), bindings)).toBeNull()
    }
    expect(adminBearer(request())).toBeNull()
    expect(adminBearer(request('Bearer '))).toBeNull()
    expect(adminBearer(request(LEGACY))).toBeNull()
  })

  test('the scheme is case-insensitive and white space round the value is ignored, as before', async () => {
    for (const authorization of [`Bearer ${SECOND}`, `bearer ${SECOND}`, `BEARER ${SECOND}`, `Bearer   ${SECOND}`, `Bearer\t${SECOND}  `]) {
      expect(await adminAuthorised(request(authorization), bindings)).toBe('macb')
    }
  })

  test('matchAdminKey refuses an empty or missing bearer directly', async () => {
    for (const bearer of [null, '', '   ', undefined as unknown as null]) expect(await matchAdminKey(bearer, bindings)).toBeNull()
    expect(await matchAdminKey(LEGACY, {})).toBeNull()
  })
})

describe('comparison does not stop at a match', () => {
  const names = ['ADMIN_SECRET_aa', 'ADMIN_SECRET_bb', 'ADMIN_SECRET_cc', 'ADMIN_SECRET_dd']
  const values = names.map(random)
  const bindings = env(Object.fromEntries(names.map((name, index) => [name, values[index]])))

  /** `check`, counting the digests made and recording every call of the equality (`auth.constantTimeEqual`, the one admin-keys.ts uses). */
  async function observe(bearer: string, withBindings: Env = bindings): Promise<{ matched: string | null; digests: number; comparisons: Array<[string, string]>; results: boolean[] }> {
    const digest = spyOn(crypto.subtle, 'digest')
    const equality = spyOn(auth, 'constantTimeEqual')
    try {
      const matched = await check(bearer, withBindings)
      return {
        matched, digests: digest.mock.calls.length,
        comparisons: equality.mock.calls.map((call) => [call[0], call[1]] as [string, string]),
        results: equality.mock.results.map((result) => result.value as boolean),
      }
    } finally {
      equality.mockRestore()
      digest.mockRestore()
    }
  }
  const digestsFor = observe

  test('every candidate is hashed and compared whichever one matches, and when none does', async () => {
    // One digest for the bearer and one for each of the five candidates (legacy and four computers).
    const first = await digestsFor(LEGACY)
    const middle = await digestsFor(values[1])
    const last = await digestsFor(values[3])
    const none = await digestsFor(random())
    expect([first.matched, middle.matched, last.matched, none.matched]).toEqual(['legacy', 'bb', 'dd', null])
    expect([first.digests, middle.digests, last.digests, none.digests]).toEqual([6, 6, 6, 6])
  })

  test('the equality runs once for every candidate, also after a match: a match first, in the middle, last, or none', async () => {
    // Hashing every candidate is not enough: an implementation that hashes all five and stops
    // COMPARING once one has matched makes six digests too. So the equality's own calls are counted,
    // and what each was given: the bearer's digest against each candidate's digest, in order.
    const candidates = [LEGACY, ...values]
    const expected = await Promise.all(candidates.map((value) => hashSecret(value)))
    for (const [bearer, id, at] of [[LEGACY, 'legacy', 0], [values[1], 'bb', 2], [values[3], 'dd', 4], [random(), null, -1]] as Array<[string, string | null, number]>) {
      const seen = await observe(bearer)
      const presented = await hashSecret(bearer)
      expect(seen.matched).toBe(id)
      expect(seen.comparisons.length).toBe(5)
      expect(seen.comparisons.every(([a]) => a === presented)).toBe(true)
      expect(seen.comparisons.map(([, b]) => expected.indexOf(b))).toEqual([0, 1, 2, 3, 4])
      // Exactly the matching candidate's comparison is true, wherever it stands; the ones after it still ran.
      expect(seen.results).toEqual([0, 1, 2, 3, 4].map((index) => index === at))
    }
  })

  test('should every candidate hold the bearer\'s value, all are still compared', async () => {
    const same = env({ ADMIN_SECRET_aa: LEGACY, ADMIN_SECRET_bb: LEGACY, ADMIN_SECRET_cc: LEGACY })
    const seen = await observe(LEGACY, same)
    expect(seen.matched).toBe('legacy')
    expect(seen.results).toEqual([true, true, true, true])
  })

  test('the signing secret and non-key bindings are never hashed', async () => {
    const seen = await observe(random(), env({ ADMIN_SECRETS: random(), ADMIN_SECRET_ns: namespace(), ADMIN_SECRET_empty: '' }))
    expect(seen.digests).toBe(2)
    expect(seen.comparisons.length).toBe(1)
  })

  /**
   * A digest as text that counts how many of its characters are read. Stands in for a string so that
   * an equality which stops at the first differing character (or never reads characters at all, like
   * `===`) is told apart from one that reads them all, without measuring time.
   */
  function counted(text: string): { value: string; reads: () => number } {
    let reads = 0
    const value = Object.create(String.prototype, {
      length: { value: text.length },
      charCodeAt: { value: (index: number) => { reads += 1; return text.charCodeAt(index) } },
      codePointAt: { value: (index: number) => { reads += 1; return text.codePointAt(index) } },
      charAt: { value: (index: number) => { reads += 1; return text.charAt(index) } },
      at: { value: (index: number) => { reads += 1; return text.at(index) } },
      toString: { value: () => { throw new Error('the equality must read characters, not the whole text') } },
      valueOf: { value: () => { throw new Error('the equality must read characters, not the whole text') } },
      [Symbol.toPrimitive]: { value: () => { throw new Error('the equality must read characters, not the whole text') } },
    }) as unknown as string
    return { value, reads: () => reads }
  }

  test('the equality itself reads every character, wherever the first difference is', () => {
    const digest = 'a'.repeat(64)
    const others: Array<[string, boolean]> = [
      [`b${digest.slice(1)}`, false], // differs at the first character
      [`${digest.slice(0, 31)}b${digest.slice(32)}`, false], // in the middle
      [`${digest.slice(1)}b`, false], // at the last
      ['b'.repeat(64), false], // everywhere
      [digest, true],
    ]
    for (const [other, equal] of others) {
      const a = counted(digest)
      const b = counted(other)
      expect(constantTimeEqual(a.value, b.value)).toBe(equal)
      // All 64 characters of both sides: an early return at a difference would read fewer.
      expect([a.reads(), b.reads()]).toEqual([64, 64])
      expect(constantTimeEqual(digest, other)).toBe(equal)
    }
  })

  test('the equality the admin check uses is that one', async () => {
    // Not a stand-in: with nothing replaced, the calls recorded above reach the real function.
    const seen = await observe(values[2])
    expect(seen.matched).toBe('cc')
    for (const [a, b] of seen.comparisons) expect([a.length, b.length]).toEqual([64, 64])
  })
})

describe('a 0.38.2 computer: the legacy key behaves as it did', () => {
  // Stored values as they can be: plain, or saved with a trailing newline (digests compare trimmed text).
  const stored = [LEGACY, `${LEGACY}\n`, `  ${LEGACY}  `]
  const sent = [
    `Bearer ${LEGACY}`, `bearer ${LEGACY}`, `Bearer   ${LEGACY}`, `Bearer ${LEGACY} `, `Bearer ${SECOND}`, `Bearer ${LEGACY}x`,
    `Bearer ${LEGACY.slice(1)}`, `Bearer ${SIGNING}`, 'Bearer ', 'Bearer wrong', `Basic ${LEGACY}`, undefined,
  ]

  test('for every Bearer header, the answer equals 0.38.2\'s, with and without other computers\' keys', async () => {
    for (const value of stored) {
      for (const authorization of sent) {
        const before = await adminAuthorised0382(request(authorization), { ADMIN_SECRET: value })
        for (const bindings of [env({ ADMIN_SECRET: value }), env({ ADMIN_SECRET: value, ADMIN_SECRET_macb: THIRD })]) {
          const now = await adminAuthorised(request(authorization), bindings)
          expect(now === 'legacy').toBe(before)
          expect(now).toBe(before ? 'legacy' : null)
        }
      }
    }
  })

  test('the one tightening: a value sent without the Bearer scheme no longer passes', async () => {
    expect(await adminAuthorised0382(request(LEGACY), { ADMIN_SECRET: LEGACY })).toBe(true)
    expect(await adminAuthorised(request(LEGACY), env())).toBeNull()
  })
})
