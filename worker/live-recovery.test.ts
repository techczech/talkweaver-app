import { describe, expect, spyOn, test } from 'bun:test'
import { createSignedToken } from './auth'
import { LiveSession } from './index'
import { createSession } from './session-state'

// Exercise the actual Durable Object handlers. Only the platform storage/socket boundary is fake.
function harness() {
  let saved = JSON.stringify(createSession({
    sessionId: 'session-test', shortId: 'abcd', talkSlug: 'recovery-talk',
    createdAt: Date.now(), expiresAt: Date.now() + 60_000,
  }))
  let unregisters = 0
  const sockets: any[] = []
  const ctx: any = {
    storage: {
      sql: { exec(query: string, ...args: any[]) {
        if (query.startsWith('SELECT')) return [{ value: saved }]
        if (query.startsWith('INSERT')) saved = args[1]
        return []
      } },
      setAlarm: async () => {}, deleteAlarm: async () => {},
    },
    blockConcurrencyWhile: (fn: () => void) => fn(),
    getWebSockets: () => sockets, acceptWebSocket: () => {},
  }
  const registry: any = { idFromName: () => '', get: () => ({ fetch: async () => {
    unregisters++; return new Response('{}')
  } }) }
  const env: any = { SESSION_REGISTRY: registry, SESSION_SIGNING_SECRET: 'test-secret', ADMIN_SECRET: 'test-admin-secret' }
  const worker = new LiveSession(ctx, env)
  function socket(role: 'presenter' | 'audience', connectionId: string, protocol = 2, participantId = 'participant-test') {
    const sent: any[] = []
    const ws: any = {
      sent, closed: false,
      deserializeAttachment: () => ({ role, connectionId, protocol, participantId }),
      send: (message: string) => sent.push(JSON.parse(message)),
      close: () => { ws.closed = true },
    }
    sockets.push(ws)
    return ws
  }
  return {
    worker, ctx, env, socket, state: () => JSON.parse(saved), unregisters: () => unregisters,
    reload: () => new LiveSession(ctx, env),
  }
}
const poll = {
  pollId: 'poll-test', type: 'single', question: 'Choose', visibility: 'held',
  options: [{ optionId: 'a', label: 'A' }, { optionId: 'b', label: 'B' }],
}
const deliver = (worker: LiveSession, socket: any, message: unknown) => worker.webSocketMessage(socket, JSON.stringify(message))

describe('live recovery through actual Worker handlers', () => {
  for (const handler of ['webSocketClose', 'webSocketError'] as const) {
    test(`${handler} preserves the session and its joining registration`, async () => {
      const h = harness()
      const presenter = h.socket('presenter', 'presenter-old', 1)
      const audience = h.socket('audience', 'audience-one')
      if (handler === 'webSocketClose') await h.worker.webSocketClose(presenter, 1006, '', false)
      else await h.worker.webSocketError(presenter)
      expect(h.state().status).toBe('open')
      expect(h.unregisters()).toBe(0)
      expect(audience.sent.some((m: any) => m.type === 'session.closed')).toBe(false)
    })
  }

  test('answers persist while the presenter is absent and a retry after poll closure counts once', async () => {
    const h = harness()
    const presenter = h.socket('presenter', 'presenter-one', 1)
    await deliver(h.worker, presenter, { type: 'poll.open', poll })
    await h.worker.webSocketError(presenter)
    const audience = h.socket('audience', 'audience-one')
    const vote = { type: 'vote.submit', submissionId: 'submission-one', pollId: poll.pollId, choice: 'a' }
    await deliver(h.worker, audience, vote)
    const accepted = audience.sent.find((m: any) => m.type === 'vote.ack')
    expect(accepted?.status).toBe('confirmed')
    const nextPresenter = h.socket('presenter', 'presenter-two', 1)
    await deliver(h.worker, nextPresenter, { type: 'poll.close', pollId: poll.pollId })
    const reconnected = h.socket('audience', 'audience-two')
    await deliver(h.reload(), reconnected, vote)
    expect(reconnected.sent.find((m: any) => m.type === 'vote.ack')).toEqual(accepted)
    expect(Object.values(h.state().polls[poll.pollId].votes)).toEqual(['a'])
  })

  test('a new submission cannot edit an accepted choice ballot', async () => {
    const h = harness()
    await deliver(h.worker, h.socket('presenter', 'presenter-one', 1), { type: 'poll.open', poll })
    const audience = h.socket('audience', 'audience-one')
    await deliver(h.worker, audience, { type: 'vote.submit', submissionId: 'submission-one', pollId: poll.pollId, choice: 'a' })
    await deliver(h.worker, audience, { type: 'vote.submit', submissionId: 'submission-two', pollId: poll.pollId, choice: 'b' })
    expect(audience.sent.at(-1)).toMatchObject({ type: 'vote.ack', status: 'rejected', error: 'already_answered' })
    expect(Object.values(h.state().polls[poll.pollId].votes)).toEqual(['a'])
  })

  test('a duplicate poll-open operation does not reopen a subsequently closed poll', async () => {
    const h = harness()
    const presenter = h.socket('presenter', 'presenter-one')
    const open = { type: 'operation', operationId: 'operation-open', action: { type: 'poll.open', poll } }
    await deliver(h.worker, presenter, open)
    await deliver(h.worker, presenter, { type: 'operation', operationId: 'operation-close', action: { type: 'poll.close', pollId: poll.pollId } })
    await deliver(h.reload(), presenter, open)
    expect(presenter.sent.at(-1)).toMatchObject({ type: 'operation.ack', operationId: 'operation-open', status: 'confirmed' })
    expect(h.state().polls[poll.pollId].open).toBe(false)
  })

  test('closed polls can be revealed and moderated, with audience-safe recovery snapshots', async () => {
    const h = harness()
    const presenter = h.socket('presenter', 'presenter-one', 1)
    await deliver(h.worker, presenter, { type: 'poll.open', poll: { ...poll, type: 'open', options: [], slideId: 'slide-one' } })
    const audience = h.socket('audience', 'audience-one')
    await deliver(h.worker, audience, { type: 'vote.submit', submissionId: 'submission-one', pollId: poll.pollId, choice: 'Private answer' })
    await deliver(h.worker, presenter, { type: 'poll.close', pollId: poll.pollId })
    await deliver(h.worker, audience, { type: 'session.sync', syncId: 'sync-before' })
    let snapshot = audience.sent.findLast((m: any) => m.type === 'session.snapshot')
    expect(snapshot?.polls[0]).toMatchObject({ open: false, slideId: 'slide-one' })
    expect(snapshot?.polls[0].responses).toBeUndefined()
    await deliver(h.worker, presenter, { type: 'poll.reveal', pollId: poll.pollId })
    const responseId = Object.keys(h.state().polls[poll.pollId].votes)[0]
    await deliver(h.worker, presenter, { type: 'poll.hide', pollId: poll.pollId, responseId })
    await deliver(h.worker, audience, { type: 'session.sync', syncId: 'sync-after' })
    snapshot = audience.sent.findLast((m: any) => m.type === 'session.snapshot')
    expect(snapshot?.polls[0].revealed).toBe(true)
    expect(snapshot?.polls[0].responses).toEqual([])
  })

  test('protocol 2 rejects raw votes and poll commands without mutating accepted state', async () => {
    const h = harness()
    const presenter = h.socket('presenter', 'presenter-raw-check')
    const audience = h.socket('audience', 'audience-raw-check')
    await deliver(h.worker, presenter, { type: 'poll.open', poll })
    expect(presenter.sent.at(-1)).toEqual({ type: 'protocol.error', code: 'acknowledged_message_required' })
    expect(h.state().polls).toEqual({})
    await deliver(h.worker, presenter, { type: 'operation', operationId: 'operation-raw-check', action: { type: 'poll.open', poll } })
    await deliver(h.worker, audience, { type: 'vote.submit', submissionId: 'submission-raw-check', pollId: poll.pollId, choice: 'a' })
    const before = h.state()
    await deliver(h.worker, audience, { type: 'poll.vote', pollId: poll.pollId, choice: 'b' })
    expect(audience.sent.at(-1)).toEqual({ type: 'protocol.error', code: 'acknowledged_message_required' })
    for (const action of [
      { type: 'poll.close', pollId: poll.pollId },
      { type: 'poll.reveal', pollId: poll.pollId },
      { type: 'poll.hide', pollId: poll.pollId, responseId: 'response-test', hidden: true },
    ]) {
      await deliver(h.worker, presenter, action)
      expect(presenter.sent.at(-1)).toEqual({ type: 'protocol.error', code: 'acknowledged_message_required' })
    }
    expect(h.state()).toEqual(before)
    await deliver(h.worker, presenter, { type: 'slide.publish', slideId: 'slide-allowed', reveal: 1, focus: null })
    expect(h.state().slideState.slideId).toBe('slide-allowed')
  })

  test('legacy votes enter immutable recovery history and cannot be edited on the same connection', async () => {
    const h = harness()
    const presenter = h.socket('presenter', 'presenter-legacy', 1)
    const audience = h.socket('audience', 'audience-legacy', 1)
    await deliver(h.worker, presenter, { type: 'poll.open', poll: { ...poll, slideId: 'slide-legacy' } })
    await deliver(h.worker, audience, { type: 'poll.vote', pollId: poll.pollId, choice: 'a' })
    const first = h.state().recovery.voteRecords
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ type: 'poll.vote-record', pollId: poll.pollId, choice: 'a', sequence: 1, slideId: 'slide-legacy' })
    expect(typeof first[0].submissionId).toBe('string')
    expect(Number.isFinite(first[0].acceptedAt)).toBe(true)
    await deliver(h.worker, audience, { type: 'poll.vote', pollId: poll.pollId, choice: 'b' })
    expect(audience.sent.at(-1)).toEqual({ type: 'protocol.error', code: 'invalid_poll_vote' })
    expect(h.state().recovery.voteRecords).toEqual(first)
    expect(Object.values(h.state().polls[poll.pollId].votes)).toEqual(['a'])
    const recovered = h.socket('presenter', 'presenter-legacy-recovered')
    await deliver(h.reload(), recovered, { type: 'session.sync', syncId: 'sync-legacy-recovered' })
    expect(recovered.sent.at(-1).voteRecords).toEqual(first)
  })

  const extendedOptions = ['a', 'b', 'c'].map(optionId => ({ optionId, label: optionId.toUpperCase() }))
  const extendedLabels = [{ optionId: 'often', label: 'A lot' }, { optionId: 'never', label: 'Never' }]
  const extendedCases = [
    {
      name: 'full ranking', definition: { type: 'ranking' }, choice: ['c', 'a', 'b'],
      invalid: [['a', 'b'], ['a', 'a', 'b'], ['a', 'b', 'unknown']],
      results: { tallies: { a: 2, b: 1, c: 3 }, firstPlaces: { a: 0, b: 0, c: 1 } },
    },
    {
      name: 'exact Top N ranking', definition: { type: 'ranking', rankCount: 2 }, choice: ['c', 'a'],
      invalid: [['a'], ['a', 'b', 'c'], ['a', 'a'], ['a', 'unknown']],
      results: { tallies: { a: 1, b: 0, c: 2 }, firstPlaces: { a: 0, b: 0, c: 1 } },
    },
    {
      name: 'required rating', definition: { type: 'rating', labels: extendedLabels },
      choice: { a: 'often', b: 'never', c: 'often' },
      invalid: [{ a: 'often' }, { a: 'often', b: 'never', c: 'unknown' }, { a: 'often', b: 'never', other: 'often' }],
      results: { categoryTallies: { a: { often: 1, never: 0 }, b: { often: 0, never: 1 }, c: { often: 1, never: 0 } } },
    },
    {
      name: 'optional categorisation', definition: { type: 'categorisation', labels: extendedLabels, allowSkip: true },
      choice: { b: 'never' }, invalid: [{ other: 'never' }, { b: 'unknown' }, ['never']],
      results: { categoryTallies: { a: { often: 0, never: 0 }, b: { often: 0, never: 1 }, c: { often: 0, never: 0 } } },
    },
  ]
  for (const scenario of extendedCases) {
    test(`${scenario.name} validates, survives reconnect and reload once, and keeps held recovery private`, async () => {
      const h = harness()
      const presenter = h.socket('presenter', 'presenter-extended')
      const audience = h.socket('audience', 'audience-extended')
      const definition = { ...poll, ...scenario.definition, options: extendedOptions, slideId: 'slide-extended' }
      await deliver(h.worker, presenter, {
        type: 'operation', operationId: 'operation-extended-open', action: { type: 'poll.open', poll: definition },
      })
      expect(presenter.sent.at(-1)).toMatchObject({ type: 'operation.ack', status: 'confirmed' })
      for (const [index, choice] of scenario.invalid.entries()) {
        await deliver(h.worker, audience, { type: 'vote.submit', submissionId: `submission-invalid-${index}`, pollId: poll.pollId, choice })
        expect(audience.sent.at(-1)).toMatchObject({ type: 'vote.ack', status: 'rejected' })
      }
      if (scenario.definition.type !== 'ranking') {
        await deliver(h.worker, audience, { type: 'vote.submit', submissionId: 'submission-empty-matrix', pollId: poll.pollId, choice: {} })
        expect(audience.sent.at(-1)).toMatchObject({ type: 'protocol.error' })
      }
      expect(Object.values(h.state().polls[poll.pollId].votes)).toEqual([])
      expect(h.state().recovery.voteRecords).toEqual([])
      const vote = { type: 'vote.submit', submissionId: 'submission-extended', pollId: poll.pollId, choice: scenario.choice }
      await deliver(h.worker, audience, vote)
      const accepted = audience.sent.at(-1)
      expect(accepted).toEqual({ type: 'vote.ack', submissionId: vote.submissionId, pollId: poll.pollId, status: 'confirmed', choice: scenario.choice })
      const records = h.state().recovery.voteRecords
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({ type: 'poll.vote-record', choice: scenario.choice, sequence: 1, slideId: 'slide-extended', submissionId: vote.submissionId })
      expect(presenter.sent.findLast((m: any) => m.type === 'poll.vote-record')).toEqual(records[0])

      await h.worker.webSocketClose(audience, 1006, '', false)
      await h.worker.webSocketError(presenter)
      const restored = h.reload()
      const nextPresenter = h.socket('presenter', 'presenter-extended-recovered')
      await deliver(restored, nextPresenter, {
        type: 'operation', operationId: 'operation-extended-close', action: { type: 'poll.close', pollId: poll.pollId },
      })
      const reconnected = h.socket('audience', 'audience-extended-recovered')
      await deliver(restored, reconnected, vote)
      expect(reconnected.sent.at(-1)).toEqual(accepted)
      expect(Object.values(h.state().polls[poll.pollId].votes)).toEqual([scenario.choice])
      expect(h.state().recovery.voteRecords).toEqual(records)
      expect(nextPresenter.sent.filter((m: any) => m.type === 'poll.vote-record')).toEqual([])
      await deliver(restored, reconnected, { type: 'session.sync', syncId: 'sync-extended-audience' })
      const audienceSnapshot = reconnected.sent.at(-1)
      expect(audienceSnapshot.receipts.filter((receipt: any) => receipt.status === 'confirmed')).toEqual([accepted])
      expect(audienceSnapshot.voteRecords).toBeUndefined()
      const { type, ...definitionFields } = scenario.definition
      expect(audienceSnapshot.polls[0]).toMatchObject({ ...definitionFields, pollType: type, options: extendedOptions, open: false, revealed: false, slideId: 'slide-extended' })
      for (const field of ['tallies', 'firstPlaces', 'categoryTallies', 'responseCount', 'responses']) {
        expect(audienceSnapshot.polls[0][field]).toBeUndefined()
        for (const message of audience.sent.filter((m: any) => m.type === 'poll.state')) expect(message[field]).toBeUndefined()
      }
      const other = h.socket('audience', 'audience-other', 2, 'participant-other')
      await deliver(restored, other, { type: 'session.sync', syncId: 'sync-extended-other' })
      expect(other.sent.at(-1).receipts).toEqual([])
      expect(other.sent.at(-1).voteRecords).toBeUndefined()
      await deliver(restored, nextPresenter, { type: 'session.sync', syncId: 'sync-extended-presenter' })
      const presenterSnapshot = nextPresenter.sent.at(-1)
      expect(presenterSnapshot.voteRecords).toEqual(records)
      expect(presenterSnapshot.polls[0]).toMatchObject({ responseCount: 1, ...scenario.results })
    })
  }

  test('legacy multiple-choice live records and recovered records share the accepted canonical ballot', async () => {
    const h = harness()
    const presenter = h.socket('presenter', 'presenter-multiple-legacy', 1)
    const modernPresenter = h.socket('presenter', 'presenter-multiple-modern')
    const audience = h.socket('audience', 'audience-multiple-legacy', 1)
    await deliver(h.worker, presenter, { type: 'poll.open', poll: { ...poll, type: 'multiple' } })
    await deliver(h.worker, audience, { type: 'poll.vote', pollId: poll.pollId, choice: ['b', 'a', 'b'] })
    const canonical = ['b', 'a']
    expect(Object.values(h.state().polls[poll.pollId].votes)).toEqual([canonical])
    expect(presenter.sent.findLast((m: any) => m.type === 'poll.vote-record')).toEqual({ type: 'poll.vote-record', pollId: poll.pollId, choice: canonical })
    expect(modernPresenter.sent.findLast((m: any) => m.type === 'poll.vote-record').choice).toEqual(canonical)
    await deliver(h.reload(), modernPresenter, { type: 'session.sync', syncId: 'sync-canonical-multiple' })
    expect(modernPresenter.sent.at(-1).voteRecords).toHaveLength(1)
    expect(modernPresenter.sent.at(-1).voteRecords[0].choice).toEqual(canonical)
    expect(modernPresenter.sent.at(-1).polls[0].tallies).toEqual({ a: 1, b: 1 })
  })

  for (const ending of ['explicit end', 'expiry']) {
    test(`authenticated recovery preserves final held answers after ${ending}`, async () => {
      const h = harness()
      const presenter = h.socket('presenter', 'presenter-final', 1)
      const audience = h.socket('audience', 'audience-final')
      await deliver(h.worker, presenter, { type: 'poll.open', poll: { ...poll, slideId: 'slide-final' } })
      await deliver(h.worker, audience, { type: 'vote.submit', submissionId: 'submission-final', pollId: poll.pollId, choice: 'b' })
      const state = h.state()
      const claims = { role: 'presenter' as const, sessionId: state.sessionId, exp: state.expiresAt }
      const token = await createSignedToken(claims, h.env.SESSION_SIGNING_SECRET)
      const url = `https://worker.test/sessions/${state.sessionId}`
      const request = (path: string, bearer?: string) => new Request(url + path, {
        headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
      })
      const clock = ending === 'expiry' ? spyOn(Date, 'now').mockReturnValue(state.expiresAt + 1) : null
      try {
        if (ending === 'expiry') await h.worker.alarm()
        else expect((await h.worker.fetch(new Request(url + '/close', {
          method: 'POST', headers: { authorization: `Bearer ${token}` },
        }))).status).toBe(200)
        expect(h.state().status).toBe('closed')
        expect(audience.sent.at(-1)).toMatchObject({ type: 'session.closed', reason: ending === 'expiry' ? 'expired' : 'ended' })
        const reloaded = h.reload()
        const response = await reloaded.fetch(request('/recovery', token))
        expect(response.status).toBe(200)
        const recovered = await response.json() as any
        expect(recovered.voteRecords).toEqual(state.recovery.voteRecords)
        expect(recovered.polls[0]).toMatchObject({ pollId: poll.pollId, visibility: 'held', revealed: false, tallies: { a: 0, b: 1 } })
        expect(recovered.moreRecords).toBe(false)
        const cursor = await reloaded.fetch(request('/recovery?afterSequence=1', token))
        expect((await cursor.json() as any).voteRecords).toEqual([])
        expect((await reloaded.fetch(request('/recovery?afterSequence=-1', token))).status).toBe(400)
        expect((await reloaded.fetch(request('/recovery'))).status).toBe(401)
        const invalidTokens = [
          'invalid-token',
          await createSignedToken(claims, 'wrong-signing-secret'),
          await createSignedToken({ ...claims, sessionId: 'another-session' }, h.env.SESSION_SIGNING_SECRET),
          await createSignedToken({ ...claims, exp: claims.exp + 1 }, h.env.SESSION_SIGNING_SECRET),
        ]
        for (const invalid of invalidTokens) {
          const rejected = await reloaded.fetch(request('/recovery', invalid))
          expect(rejected.status).toBe(401)
          expect(await rejected.json()).toMatchObject({ error: { code: 'presenter_auth_required' } })
        }
        await deliver(reloaded, audience, { type: 'vote.submit', submissionId: 'submission-after-end', pollId: poll.pollId, choice: 'a' })
        expect(h.state().recovery.voteRecords).toEqual(state.recovery.voteRecords)
      } finally { clock?.mockRestore() }
    })
  }

})

test('two tabs share a free-text allowance and simultaneous final submissions count once', async () => {
  const h = harness()
  const presenter = h.socket('presenter', 'presenter-one', 1)
  await deliver(h.worker, presenter, { type: 'poll.open', poll: { ...poll, type: 'open', options: [], maxSubmissions: 2 } })
  const a = h.socket('audience', 'tab-one')
  const b = h.socket('audience', 'tab-two')
  const other = h.socket('audience', 'another-browser', 2, 'participant-other')
  const vote = (submissionId: string) => ({ type: 'vote.submit', submissionId, pollId: poll.pollId, choice: submissionId })
  await deliver(h.worker, a, vote('submission-first'))
  expect(b.sent.some((m: any) => m.type === 'vote.ack' && m.submissionId === 'submission-first')).toBe(true)
  expect(other.sent.some((m: any) => m.type === 'vote.ack')).toBe(false)
  await Promise.all([deliver(h.worker, a, vote('submission-second')), deliver(h.worker, b, vote('submission-third'))])
  expect(Object.keys(h.state().polls[poll.pollId].votes)).toHaveLength(2)
  expect(b.sent.some((m: any) => m.submissionId === 'submission-third' && m.status === 'rejected')).toBe(true)
  await deliver(h.reload(), b, vote('submission-second'))
  expect(Object.keys(h.state().polls[poll.pollId].votes)).toHaveLength(2)
  await deliver(h.worker, other, vote('submission-other'))
  expect(Object.keys(h.state().polls[poll.pollId].votes)).toHaveLength(3)
})
