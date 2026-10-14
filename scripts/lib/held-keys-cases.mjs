// The requests that carry this computer's key (a share, a Run's results link, pre-work) try each
// key held for the live service, as Go live does (src/main/live-admin-request.ts). One stand-in and
// one list of cases for the three suites that own those requests:
//   test-shared-talk-service.mjs   POST /shares
//   test-runs.mjs                  POST /results
//   test-run-prework-results.mjs   POST /prework
// The stand-in answers the ONE keyed route by which key the request carries; every other request
// goes to the suite's own fake.
import { strict as assert } from 'node:assert'
import { LIVE_ACCESS_REMOVED } from '../../src/main/live-admin-request.ts'

const WORKER = 'talkweaver-live-sessions'
const ACCOUNT = 'a'.repeat(32)

/**
 * `route`: the keyed route's path. `inner`: the suite's fake, which answers a request this lets
 * through. `legacyKey`: the 0.38.2 key (give the one `inner` accepts, when it checks).
 * `set({ own, legacy })`: what each key meets: `refuse` (the live service's own 401, the default),
 * `accept` (handed to `inner`), `down` (no answer) or `broken` (a 502).
 */
export function heldKeysDouble({ baseUrl, route, inner, legacyKey = `legacy-key-${'l'.repeat(32)}` }) {
  const ownKey = `own-key-${'o'.repeat(35)}`
  const at = { accountId: ACCOUNT, workerName: WORKER, baseUrl: baseUrl.replace(/\/+$/, '') }
  const keys = [
    { accountId: ACCOUNT, workerName: WORKER, computerId: 'c0ffee00c0ffee00', key: ownKey, kind: 'own' },
    { accountId: ACCOUNT, workerName: WORKER, computerId: 'legacy', key: legacyKey, kind: 'legacy' },
  ]
  const state = { meets: {}, sent: [] }
  const fetch = async (url, init = {}) => {
    if (init.method !== 'POST' || new URL(String(url)).pathname !== route) return inner(url, init)
    const bearer = new Headers(init.headers).get('authorization')
    const who = bearer === `Bearer ${ownKey}` ? 'own' : bearer === `Bearer ${legacyKey}` ? 'legacy' : 'other'
    state.sent.push(who)
    const meets = state.meets[who] ?? 'refuse'
    if (meets === 'down') throw new TypeError('fetch failed')
    if (meets === 'accept') return inner(url, init)
    if (meets === 'broken') return new Response('upstream error', { status: 502 })
    return new Response(JSON.stringify({ error: { code: 'admin_auth_required', message: 'Admin authorisation is required.' } }), { status: 401, headers: { 'content-type': 'application/json' } })
  }
  return {
    fetch, ownKey, legacyKey,
    /** What the main process hands a module: its own key chosen (no probe was answered), both keys held. */
    endpoint: async () => ({ baseUrl, adminSecret: ownKey, held: { at, keys } }),
    set(meets) { state.meets = meets; state.sent = [] },
    sent: () => [...state.sent],
  }
}

/**
 * The cases. `attempt(n)`: make the thing once more (a new talk or Run each time: a failure must
 * not be a second look at the first), resolving with whatever the module returns.
 */
export async function heldKeysCases(double, attempt, what) {
  const message = async (n) => { try { await attempt(n); return null } catch (error) { return error instanceof Error ? error.message : String(error) } }
  // Every key held is refused by the live service's own 401: "access was removed", each key sent once.
  double.set({})
  assert.deepEqual([await message(1), double.sent()], [LIVE_ACCESS_REMOVED, ['own', 'legacy']], `${what}: both keys refused`)
  // No answer is never "access was removed": about the first key (nothing is re-sent) …
  double.set({ own: 'down' })
  const down = await message(2)
  assert.ok(typeof down === 'string' && down !== LIVE_ACCESS_REMOVED && !/access/i.test(down), `${what}: no answer: ${down}`)
  assert.deepEqual(double.sent(), ['own'], `${what}: a request that met no answer is not sent again`)
  // … or about the second, after the first was refused.
  double.set({ legacy: 'down' })
  const second = await message(3)
  assert.ok(typeof second === 'string' && second !== LIVE_ACCESS_REMOVED && !/access/i.test(second), `${what}: no answer for the second key: ${second}`)
  assert.deepEqual(double.sent(), ['own', 'legacy'])
  // Another status is not a refusal of a key: nothing is re-sent, and nothing is said about access.
  double.set({ own: 'broken' })
  const broken = await message(4)
  assert.ok(typeof broken === 'string' && broken !== LIVE_ACCESS_REMOVED && !/access/i.test(broken), `${what}: a 502: ${broken}`)
  assert.deepEqual(double.sent(), ['own'])
  // Its own key refused and the 0.38.2 key accepted: it works, and the request was sent once per key.
  double.set({ legacy: 'accept' })
  const made = await attempt(5)
  assert.deepEqual(double.sent(), ['own', 'legacy'], `${what}: own key refused, the 0.38.2 key accepted`)
  // The other way round: the first key accepted, one request.
  double.set({ own: 'accept', legacy: 'accept' })
  return made
}
