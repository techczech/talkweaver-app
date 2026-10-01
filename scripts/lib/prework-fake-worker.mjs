// A small stand-in for the live Worker's pre-work routes, played through Playwright's request routing,
// for the pre-work form's page tests. It keeps what the real Worker keeps for the form (one entry per
// person and step for a read, an answer and a done mark; one per question; idempotent by submission id)
// and answers the way it does (status, mine, submit; 410 once closed). The real Worker is the live test.
export const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS' }

/**
 * @param {import('playwright').BrowserContext} context
 * @param {{ baseUrl: string, preworkId: string, state?: 'not_yet'|'open'|'closed', people?: number, closesAt?: number }} options
 */
export async function fakePreworkWorker(context, { baseUrl, preworkId, state = 'open', people, closesAt = Date.now() + 3 * 86_400_000 }) {
  const world = {
    state, closesAt, people,
    /** participant → Map(ref → entry) */
    entries: new Map(),
    /** every accepted or refused submit body, in order */
    submits: [],
    /** the next submits answer with these instead of being taken: { status, code?, retryAfterMs? } | 'abort' */
    failNext: [],
    seenIds: new Map(),
    seq: 0,
    /** Seed a device's earlier entries, as `mine` returns them. */
    seed(participantId, list) {
      const map = world.entries.get(participantId) ?? new Map()
      for (const entry of list) map.set(entry.ref, { at: Date.now() - 86_400_000, ...entry })
      world.entries.set(participantId, map)
    },
    all() { return [...world.entries.values()].flatMap((map) => [...map.values()]) },
  }
  const json = (route, status, body) => route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  await context.route(`${baseUrl}/prework/${preworkId}**`, async (route) => {
    const request = route.request()
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    const path = new URL(request.url()).pathname.slice(`/prework/${preworkId}`.length)
    if (request.method() === 'GET' && path === '') {
      return json(route, 200, { state: world.state, opensAt: Date.now() - 86_400_000, closesAt: world.closesAt, ...(world.state === 'closed' && world.people !== undefined ? { people: world.people } : {}) })
    }
    const body = JSON.parse(request.postData() || '{}')
    if (path === '/mine') {
      const map = world.entries.get(body.participantId) ?? new Map()
      return json(route, 200, { entries: [...map.values()] })
    }
    if (path === '/submit') {
      world.submits.push(body)
      const failure = world.failNext.shift()
      if (failure === 'abort') return route.abort('failed')
      if (failure) return json(route, failure.status, { error: { code: failure.code ?? 'unavailable', message: 'no' }, ...(failure.retryAfterMs ? { retryAfterMs: failure.retryAfterMs } : {}) })
      if (world.state === 'closed') return json(route, 410, { error: { code: 'prework_closed', message: 'Pre-work has closed.' } })
      const known = world.seenIds.get(body.submissionId)
      if (known) return json(route, 200, { entry: known, changed: false })
      const map = world.entries.get(body.participantId) ?? new Map()
      const ref = body.kind === 'question' ? `q:${body.submissionId}` : `${body.kind}:${body.stepId}`
      const entry = { ref, stepId: body.stepId, kind: body.kind, at: Date.now() }
      for (const key of ['choice', 'text', 'name', 'done']) if (body[key] !== undefined) entry[key] = body[key]
      map.set(ref, entry)
      world.entries.set(body.participantId, map)
      world.seenIds.set(body.submissionId, entry)
      return json(route, 201, { entry, changed: true })
    }
    return json(route, 404, { error: { code: 'not_found' } })
  })
  return world
}
