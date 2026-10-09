import { describe, expect, spyOn, test } from 'bun:test'
import { createSignedToken } from './auth'
import { LiveSession } from './index'
import { createSession } from './session-state'
import { recoveryState } from './recovery-state'

// Exercise the actual Durable Object handlers. Only the platform storage/socket boundary is fake.
function harness() {
  // Rows by key, like the Durable Object's kv table: 'session' and, once used, 'feedback'.
  const rows = new Map<string, string>([['session', JSON.stringify(createSession({
    sessionId: 'session-test', shortId: 'abcd', talkSlug: 'recovery-talk',
    createdAt: Date.now(), expiresAt: Date.now() + 60_000,
  }))]])
  let unregisters = 0
  const sockets: any[] = []
  const ctx: any = {
    storage: {
      sql: { exec(query: string, ...args: any[]) {
        if (query.startsWith('SELECT')) return rows.has(args[0]) ? [{ value: rows.get(args[0]) }] : []
        if (query.startsWith('INSERT')) rows.set(args[0], args[1])
        return []
      } },
      setAlarm: async () => {}, deleteAlarm: async () => {},
    },
    blockConcurrencyWhile: (fn: () => void) => fn(),
    getWebSockets: () => sockets.filter((s) => !s.closed), acceptWebSocket: (s: any) => sockets.push(s),
  }
  const registry: any = { idFromName: () => '', get: () => ({ fetch: async () => {
    unregisters++; return new Response('{}')
  } }) }
  const env: any = { SESSION_REGISTRY: registry, SESSION_SIGNING_SECRET: 'test-secret', ADMIN_SECRET: 'test-admin-secret' }
  const worker = new LiveSession(ctx, env)
  function socket(role: 'presenter' | 'audience', connectionId: string, protocol = 2, participantId = 'participant-test', kind?: 'screen') {
    const sent: any[] = []
    const ws: any = {
      sent, closed: false,
      deserializeAttachment: () => ({ role, connectionId, protocol, participantId, kind }),
      send: (message: string) => sent.push(JSON.parse(message)),
      close: () => { ws.closed = true },
    }
    sockets.push(ws)
    return ws
  }
  return {
    worker, ctx, env, socket, state: () => JSON.parse(rows.get('session')!),
    feedback: () => rows.has('feedback') ? JSON.parse(rows.get('feedback')!) : undefined, unregisters: () => unregisters,
    reload: () => new LiveSession(ctx, env),
  }
}
const poll = {
  pollId: 'poll-test', type: 'single', question: 'Choose', visibility: 'held',
  options: [{ optionId: 'a', label: 'A' }, { optionId: 'b', label: 'B' }],
}
const deliver = (worker: LiveSession, socket: any, message: unknown) => worker.webSocketMessage(socket, JSON.stringify(message))

describe('live recovery through actual Worker handlers', () => {
  test('broadcasts gallery steps and restores the current image to a joining screen', async () => {
    const h = harness()
    const presenter = h.socket('presenter', 'presenter-gallery')
    const screen = h.socket('audience', 'screen-gallery', 2, 'participant-screen-gallery', 'screen')
    await deliver(h.worker, presenter, { type: 'slide.publish', slideId: 'gallery', reveal: 0,
      focus: null, lightbox: { open: true, index: 1 } })
    expect(screen.sent.findLast((m: any) => m.type === 'slide.state')?.lightbox).toEqual({ open: true, index: 1 })
    const rejoined = h.socket('audience', 'screen-rejoined', 2, 'participant-screen-rejoined', 'screen')
    await deliver(h.reload(), rejoined, { type: 'session.sync', syncId: 'sync-gallery-screen' })
    expect(rejoined.sent.findLast((m: any) => m.type === 'session.snapshot')?.slideState.lightbox)
      .toEqual({ open: true, index: 1 })
  })
  test('broadcasts the talk QR overlay and restores it to a joining screen', async () => {
    const h = harness()
    const presenter = h.socket('presenter', 'presenter-qr')
    const screen = h.socket('audience', 'screen-qr', 2, 'participant-screen-qr', 'screen')
    await deliver(h.worker, presenter, { type: 'slide.publish', slideId: 'slide-2', reveal: 0, focus: null, talkQr: true })
    expect(screen.sent.findLast((m: any) => m.type === 'slide.state')?.talkQr).toBe(true)
    const rejoined = h.socket('audience', 'screen-qr-rejoined', 2, 'participant-screen-qr-rejoined', 'screen')
    await deliver(h.reload(), rejoined, { type: 'session.sync', syncId: 'sync-qr-screen' })
    expect(rejoined.sent.findLast((m: any) => m.type === 'session.snapshot')?.slideState.talkQr).toBe(true)
    await deliver(h.worker, presenter, { type: 'slide.publish', slideId: 'slide-2', reveal: 0, focus: null })
    expect(screen.sent.findLast((m: any) => m.type === 'slide.state')?.talkQr).toBeUndefined()
  })
  test('screen sockets count across hibernation, and presenter loss and return reach audiences', async () => {
    const h = harness()
    const presenter = h.socket('presenter', 'presenter-one')
    const screen1 = h.socket('audience', 'screen-one', 2, 'participant-screen-one', 'screen')
    const screen2 = h.socket('audience', 'screen-two', 2, 'participant-screen-two', 'screen')
    const phone = h.socket('audience', 'phone-one')
    await deliver(h.worker, presenter, { type: 'session.sync', syncId: 'sync-presenter-one' })
    expect(presenter.sent.findLast((m: any) => m.type === 'session.snapshot')?.presence).toEqual({ presenterConnected: true, venueScreens: 2 })
    await h.worker.webSocketClose(presenter, 1006, '', false)
    expect(screen1.sent.findLast((m: any) => m.type === 'session.presence')).toEqual({ type: 'session.presence', presenterConnected: false, venueScreens: 2 })
    expect(phone.sent.findLast((m: any) => m.type === 'session.presence')?.presenterConnected).toBe(false)
    await deliver(h.reload(), screen2, { type: 'session.sync', syncId: 'sync-screen-two' })
    expect(screen2.sent.findLast((m: any) => m.type === 'session.snapshot')?.presence).toEqual({ presenterConnected: false, venueScreens: 2 })
    const next = h.socket('presenter', 'presenter-two')
    await deliver(h.reload(), next, { type: 'session.sync', syncId: 'sync-presenter-two' })
    expect(screen1.sent.findLast((m: any) => m.type === 'session.presence')?.presenterConnected).toBe(true)
    await h.worker.webSocketClose(screen2, 1000, '', true)
    expect(next.sent.findLast((m: any) => m.type === 'session.presence')?.venueScreens).toBe(1)
  })
  test('instant slide broadcasts and survives an audience reconnect until cleared', async () => {
    const h = harness()
    const presenter = h.socket('presenter', 'presenter-one')
    const audience = h.socket('audience', 'audience-one')
    const slide = { kind: 'link', url: 'https://example.test/topic', qrSvg: '<svg viewBox="0 0 1 1"></svg>', shownAt: 1000 }
    await deliver(h.worker, presenter, { type: 'operation', operationId: 'instant-show-1', action: { type: 'instant.show', slide } })
    expect(presenter.sent.at(-1)).toMatchObject({ type: 'operation.ack', status: 'confirmed' })
    expect(audience.sent.at(-1)).toEqual({ type: 'instant.state', slide })
    const rejoined = h.socket('audience', 'audience-two')
    await deliver(h.reload(), rejoined, { type: 'session.sync', syncId: 'sync-instant-1' })
    expect(rejoined.sent.at(-1).instantSlide).toEqual(slide)
    await deliver(h.worker, presenter, { type: 'operation', operationId: 'instant-clear-1', action: { type: 'instant.clear' } })
    expect(audience.sent.at(-1)).toEqual({ type: 'instant.state', slide: null })
    expect(h.state().instantSlide).toBeNull()
  })
  test('image instant slide reaches a following phone and survives the stored snapshot', async () => {
    const h = harness()
    const presenter = h.socket('presenter', 'presenter-image')
    const phone = h.socket('audience', 'phone-image')
    const slide = { kind: 'image', dataUrl: 'data:image/webp;base64,' + 'A'.repeat(119_976), width: 960, height: 600, shownAt: 1000 }
    await deliver(h.worker, presenter, { type: 'operation', operationId: 'image-show-1', action: { type: 'instant.show', slide } })
    expect(presenter.sent.at(-1)).toMatchObject({ status: 'confirmed' })
    expect(phone.sent.at(-1)).toEqual({ type: 'instant.state', slide })
    expect(JSON.stringify(h.state()).length).toBeLessThan(130_000)
    const reconnecting = h.socket('audience', 'phone-image-reconnected')
    await deliver(h.reload(), reconnecting, { type: 'session.sync', syncId: 'sync-image-1' })
    expect(reconnecting.sent.at(-1).instantSlide).toEqual(slide)
  })
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

describe('reactions and questions through actual Worker handlers', () => {
  const reaction = (submissionId: string, body: Record<string, unknown>) =>
    ({ type: 'reaction.send', submissionId, slideId: 'slide-5', tMs: 12_000, ...body })
  const question = (submissionId: string, body: Record<string, unknown> = {}) =>
    ({ type: 'question.submit', submissionId, text: 'What about <b>cost</b>?', slideId: 'slide-5', tMs: 13_000, ...body })
  const types = (socket: any) => socket.sent.map((m: any) => m.type)

  test('presenters receive counts and questions; audiences hear only their own receipt', async () => {
    const h = harness()
    const presenter = h.socket('presenter', 'presenter-feedback')
    const sender = h.socket('audience', 'phone-one', 2, 'participant-one')
    const bystander = h.socket('audience', 'phone-two', 2, 'participant-two')
    const screen = h.socket('audience', 'screen-one', 2, 'participant-screen', 'screen')
    for (const s of [presenter, sender, bystander, screen]) s.sent.length = 0
    await deliver(h.worker, sender, reaction('reaction-sub-1', { reaction: 'puzzled' }))
    await deliver(h.worker, sender, reaction('reaction-sub-2', { reaction: 'bookmark' }))
    await deliver(h.worker, bystander, reaction('reaction-sub-1', { reaction: 'helped' }))
    await deliver(h.worker, sender, question('question-sub-1', { name: ' Priya ' }))
    expect(sender.sent).toEqual([
      { type: 'reaction.ack', submissionId: 'reaction-sub-1', status: 'confirmed' },
      { type: 'reaction.ack', submissionId: 'reaction-sub-2', status: 'confirmed' },
      { type: 'question.ack', submissionId: 'question-sub-1', status: 'confirmed' },
    ])
    expect(types(bystander)).toEqual(['reaction.ack'])
    expect(screen.sent).toEqual([])
    const counts = presenter.sent.filter((m: any) => m.type === 'reaction.counts')
    expect(counts.map((m: any) => m.counts)).toEqual([{ puzzled: 1 }, { puzzled: 1, bookmark: 1 }, { puzzled: 1, bookmark: 1, helped: 1 }])
    expect(counts[0].records).toEqual([{ reaction: 'puzzled', slideId: 'slide-5', tMs: 12_000, sequence: 1, acceptedAt: expect.any(Number) }])
    const questions = presenter.sent.findLast((m: any) => m.type === 'questions.state').questions
    expect(questions).toEqual([{ questionId: 'question-1', text: 'What about <b>cost</b>?', name: 'Priya',
      slideId: 'slide-5', tMs: 13_000, acceptedAt: expect.any(Number), answered: false }])
    expect(JSON.stringify(presenter.sent)).not.toContain('participant-')
    // State survives hibernation: a reloaded object has the same counts and questions.
    const reloaded = h.reload()
    await deliver(reloaded, presenter, { type: 'session.sync', syncId: 'sync-feedback-reload' })
    const snapshot = presenter.sent.at(-1)
    expect(snapshot.reactionCounts).toEqual({ 'slide-5': { puzzled: 1, bookmark: 1, helped: 1 } })
    expect(snapshot.questions).toEqual(questions)
    expect(snapshot.switches).toEqual({ questionsAllowed: true, reactionsAllowed: true })
    expect(snapshot.reactionRecords.map((r: any) => r.sequence)).toEqual([1, 2, 3])
    await deliver(reloaded, presenter, { type: 'session.sync', syncId: 'sync-feedback-cursor', afterReactionSequence: 2 })
    expect(presenter.sent.at(-1).reactionRecords.map((r: any) => r.sequence)).toEqual([3])
    await deliver(reloaded, sender, { type: 'session.sync', syncId: 'sync-feedback-audience' })
    const audienceSnapshot = sender.sent.at(-1)
    expect(audienceSnapshot.switches).toEqual({ questionsAllowed: true, reactionsAllowed: true })
    for (const key of ['reactionCounts', 'questions', 'reactionRecords']) expect(audienceSnapshot[key]).toBeUndefined()
    expect(h.state().feedback).toBeUndefined()
    expect(h.feedback().questions).toHaveLength(1)
  })

  test('queued retries are acknowledged once and never counted twice', async () => {
    const h = harness()
    const presenter = h.socket('presenter', 'presenter-retry')
    const phone = h.socket('audience', 'phone-retry', 2, 'participant-retry')
    const message = reaction('reaction-offline-1', { reaction: 'helped', slideId: 'slide-2', tMs: 500 })
    await deliver(h.worker, phone, message)
    const countsBefore = presenter.sent.filter((m: any) => m.type === 'reaction.counts').length
    const reconnected = h.socket('audience', 'phone-retry-2', 2, 'participant-retry')
    await deliver(h.reload(), reconnected, message)
    expect(reconnected.sent.at(-1)).toEqual({ type: 'reaction.ack', submissionId: 'reaction-offline-1', status: 'confirmed' })
    expect(presenter.sent.filter((m: any) => m.type === 'reaction.counts').length).toBe(countsBefore)
    expect(h.feedback().reactions).toHaveLength(1)
    await deliver(h.worker, reconnected, question('question-offline-1'))
    await deliver(h.reload(), reconnected, question('question-offline-1'))
    expect(reconnected.sent.filter((m: any) => m.type === 'question.ack')).toHaveLength(2)
    expect(h.feedback().questions).toHaveLength(1)
  })

  test('bad input is rejected with a reason and changes nothing', async () => {
    const h = harness()
    const presenter = h.socket('presenter', 'presenter-bad')
    const phone = h.socket('audience', 'phone-bad', 2, 'participant-bad')
    presenter.sent.length = 0
    await deliver(h.worker, phone, reaction('reaction-bad-1', { reaction: '👍' }))
    await deliver(h.worker, phone, reaction('reaction-bad-2', { reaction: 'puzzled', slideId: '' }))
    await deliver(h.worker, phone, question('question-bad-1', { text: 'x'.repeat(501) }))
    expect(phone.sent.slice(-3)).toEqual([
      { type: 'reaction.ack', submissionId: 'reaction-bad-1', status: 'rejected', error: 'unknown_reaction' },
      { type: 'reaction.ack', submissionId: 'reaction-bad-2', status: 'rejected', error: 'missing_slide_id' },
      { type: 'question.ack', submissionId: 'question-bad-1', status: 'rejected', error: 'question_too_long' },
    ])
    expect(presenter.sent).toEqual([])
    expect(h.feedback()).toBeUndefined()
    // A flood of invalid submissions from one id is refused with its reason and stores nothing.
    for (let i = 0; i < 2_000; i++) await deliver(h.worker, phone, reaction(`reaction-flood-${i}`, { reaction: 'nope' }))
    expect(phone.sent.at(-1)).toMatchObject({ status: 'rejected', error: 'unknown_reaction' })
    expect(h.feedback()).toBeUndefined()
    const other = h.socket('audience', 'phone-other', 2, 'participant-other')
    await deliver(h.worker, other, reaction('reaction-other-1', { reaction: 'helped' }))
    await deliver(h.worker, other, question('question-other-1'))
    expect(other.sent.map((m: any) => m.status)).toEqual(['confirmed', 'confirmed'])
    // A presenter cannot react, and protocol-1 audiences keep reactions inert.
    await deliver(h.worker, presenter, reaction('reaction-presenter', { reaction: 'puzzled' }))
    expect(presenter.sent.at(-1)).toEqual({ type: 'protocol.error', code: 'wrong_role' })
    // An audience socket cannot send presenter operations (answer a question, set the switches).
    await deliver(h.worker, phone, { type: 'operation', operationId: 'operation-from-phone',
      action: { type: 'switches.set', questionsAllowed: false } })
    expect(phone.sent.at(-1)).toEqual({ type: 'protocol.error', code: 'wrong_role' })
    expect(h.feedback().questionsAllowed).toBe(true)
    const legacy = h.socket('audience', 'legacy-phone', 1)
    await deliver(h.worker, legacy, { type: 'reaction.send', reaction: 'puzzled', slideId: 'slide-1', tMs: 1 })
    expect(legacy.sent.at(-1)).toEqual({ type: 'protocol.error', code: 'invalid_or_inert_message' })
  })

  test('pause switches refuse the right messages, keep bookmarks, and reach every following device', async () => {
    const h = harness()
    const presenter = h.socket('presenter', 'presenter-pause')
    const phone = h.socket('audience', 'phone-pause', 2, 'participant-pause')
    const legacy = h.socket('audience', 'legacy-pause', 1)
    await deliver(h.worker, phone, reaction('reaction-before-pause', { reaction: 'puzzled' }))
    await deliver(h.worker, presenter, { type: 'operation', operationId: 'operation-pause-both',
      action: { type: 'switches.set', questionsAllowed: false, reactionsAllowed: false } })
    expect(presenter.sent.at(-1)).toEqual({ type: 'operation.ack', operationId: 'operation-pause-both', status: 'confirmed' })
    const paused = { type: 'switches.state', questionsAllowed: false, reactionsAllowed: false }
    expect(phone.sent.at(-1)).toEqual(paused)
    expect(presenter.sent.at(-2)).toEqual(paused)
    expect(legacy.sent.some((m: any) => m.type === 'switches.state')).toBe(false)
    await deliver(h.worker, phone, reaction('reaction-paused', { reaction: 'helped' }))
    expect(phone.sent.at(-1)).toMatchObject({ status: 'rejected', error: 'reactions_paused' })
    const countsBeforeBookmark = presenter.sent.filter((m: any) => m.type === 'reaction.counts').length
    await deliver(h.worker, phone, reaction('bookmark-paused', { reaction: 'bookmark' }))
    expect(phone.sent.at(-1)).toMatchObject({ status: 'confirmed' })
    expect(presenter.sent.filter((m: any) => m.type === 'reaction.counts').length).toBe(countsBeforeBookmark,
      'a bookmark during a pause is stored, but its count waits for the resume')
    await deliver(h.worker, phone, question('question-paused'))
    expect(phone.sent.at(-1)).toMatchObject({ type: 'question.ack', status: 'rejected', error: 'questions_paused' })
    expect(presenter.sent.findLast((m: any) => m.type === 'reaction.counts').counts).toEqual({ puzzled: 1 })
    // Raw presenter commands still need the acknowledged path.
    await deliver(h.worker, presenter, { type: 'switches.set', reactionsAllowed: true })
    expect(presenter.sent.at(-1)).toEqual({ type: 'protocol.error', code: 'acknowledged_message_required' })
    await deliver(h.reload(), phone, { type: 'session.sync', syncId: 'sync-paused-phone' })
    expect(phone.sent.at(-1).switches).toEqual({ questionsAllowed: false, reactionsAllowed: false })
    // Resuming pushes each slide's current counts, with the records made during the pause.
    const resumed = h.reload()
    presenter.sent.length = 0
    await deliver(resumed, presenter, { type: 'operation', operationId: 'operation-resume',
      action: { type: 'switches.set', reactionsAllowed: true } })
    const catchUp = presenter.sent.filter((m: any) => m.type === 'reaction.counts')
    expect(catchUp.map((m: any) => [m.slideId, m.counts, m.records.map((r: any) => r.reaction)]))
      .toEqual([['slide-5', { puzzled: 1, bookmark: 1 }, ['bookmark']]])
    expect(presenter.sent.at(-1)).toMatchObject({ type: 'operation.ack', status: 'confirmed' })
    // A retried resume replays its receipt without a second catch-up.
    await deliver(resumed, presenter, { type: 'operation', operationId: 'operation-resume',
      action: { type: 'switches.set', reactionsAllowed: true } })
    expect(presenter.sent.filter((m: any) => m.type === 'reaction.counts')).toHaveLength(1)
  })

  test('the presenter marks a question answered; the asker is not told', async () => {
    const h = harness()
    const presenter = h.socket('presenter', 'presenter-answer')
    const phone = h.socket('audience', 'phone-answer', 2, 'participant-answer')
    await deliver(h.worker, phone, question('question-answer-1'))
    phone.sent.length = 0
    await deliver(h.worker, presenter, { type: 'operation', operationId: 'operation-answer-1',
      action: { type: 'question.answer', questionId: 'question-1' } })
    expect(presenter.sent.at(-1)).toEqual({ type: 'operation.ack', operationId: 'operation-answer-1', status: 'confirmed' })
    expect(presenter.sent.at(-2).questions[0].answered).toBe(true)
    expect(phone.sent).toEqual([])
    await deliver(h.worker, presenter, { type: 'operation', operationId: 'operation-answer-2',
      action: { type: 'question.answer', questionId: 'question-7' } })
    expect(presenter.sent.at(-1)).toEqual({ type: 'operation.ack', operationId: 'operation-answer-2', status: 'rejected', error: 'question_not_found' })
    expect(h.reload() && h.feedback().questions[0].answered).toBe(true)
  })

  test('authenticated recovery returns questions, counts and reaction records after the session ends', async () => {
    const h = harness()
    const phone = h.socket('audience', 'phone-final', 2, 'participant-final')
    await deliver(h.worker, phone, reaction('reaction-final-1', { reaction: 'puzzled' }))
    await deliver(h.worker, phone, reaction('reaction-final-2', { reaction: 'helped' }))
    await deliver(h.worker, phone, question('question-final-1'))
    const state = h.state()
    const token = await createSignedToken({ role: 'presenter', sessionId: state.sessionId, exp: state.expiresAt }, h.env.SESSION_SIGNING_SECRET)
    const url = `https://worker.test/sessions/${state.sessionId}`
    expect((await h.worker.fetch(new Request(url + '/close', { method: 'POST', headers: { authorization: `Bearer ${token}` } }))).status).toBe(200)
    await deliver(h.worker, phone, reaction('reaction-after-end', { reaction: 'bookmark' }))
    const recovered = await (await h.reload().fetch(new Request(url + '/recovery?afterReactionSequence=1', {
      headers: { authorization: `Bearer ${token}` } }))).json() as any
    expect(recovered.reactionCounts).toEqual({ 'slide-5': { helped: 1 } })
    expect(recovered.reactionRecords.map((r: any) => [r.sequence, r.reaction, r.withdrawn === true])).toEqual([[2, 'puzzled', true], [3, 'helped', false]])
    expect(recovered.moreReactionRecords).toBe(false)
    expect(recovered.questions).toHaveLength(1)
  })
})

test('a feedback row the storage refuses leaves memory as storage holds it and refuses the sender', async () => {
  const h = harness()
  const presenter = h.socket('presenter', 'presenter-storage')
  const phone = h.socket('audience', 'phone-storage', 2, 'participant-storage')
  const send = (id: string, reaction: string) => deliver(h.worker, phone,
    { type: 'reaction.send', submissionId: id, reaction, slideId: 'slide-1', tMs: 1 })
  await send('reaction-storage-1', 'puzzled')
  const exec = h.ctx.storage.sql.exec
  h.ctx.storage.sql.exec = (query: string, ...args: any[]) => {
    if (query.startsWith('INSERT') && args[0] === 'feedback') throw new Error('SQLITE_TOOBIG')
    return exec(query, ...args)
  }
  presenter.sent.length = 0
  await send('reaction-storage-2', 'helped')
  expect(phone.sent.at(-1)).toEqual({ type: 'reaction.ack', submissionId: 'reaction-storage-2', status: 'rejected', error: 'storage_failed' })
  expect(presenter.sent).toEqual([])
  h.ctx.storage.sql.exec = exec
  // Memory went back to storage: the refused change is gone and the same message can be sent again.
  await send('reaction-storage-2', 'helped')
  expect(phone.sent.at(-1)).toMatchObject({ status: 'confirmed' })
  expect(presenter.sent.at(-1).counts).toEqual({ helped: 1 })
  expect(h.feedback().reactions).toHaveLength(3)
})

describe('feedback boards through actual Worker handlers', () => {
  const board = { pollId: 'poll-board', type: 'board', question: 'Keep, change, try?', visibility: 'live',
    options: [{ optionId: 'keep', label: 'Keep' }, { optionId: 'try', label: 'Try' }], board: { cardsPerPhone: 2 } }
  test('each board lives in its own row, survives hibernation, and a failed write refuses the card', async () => {
    const h = harness()
    const presenter = h.socket('presenter', 'presenter-board')
    const phone = h.socket('audience', 'phone-board', 2, 'participant-phone-board')
    await deliver(h.worker, presenter, { type: 'operation', operationId: 'operation-board-open', action: { type: 'poll.open', poll: board } })
    const card = { type: 'card.add', submissionId: 'submission-board-one', pollId: 'poll-board', column: 'keep', text: 'Hands-on' }
    await deliver(h.worker, phone, card)
    expect(phone.sent.findLast((m: any) => m.type === 'card.ack')).toMatchObject({ status: 'confirmed', cardId: 'card-1' })
    expect(presenter.sent.findLast((m: any) => m.type === 'poll.state')?.boardState.cardCount).toBe(1)
    expect(h.state().boards).toBeUndefined()
    const row = JSON.parse(h.ctx.storage.sql.exec('SELECT value FROM kv WHERE key = ?', 'board:poll-board')[0].value)
    expect(row.cards.map((c: any) => c.text)).toEqual(['Hands-on'])
    expect(JSON.stringify(row)).not.toContain('participant-phone-board')

    // After hibernation the board is read back from its row: the retry repeats its receipt.
    const woken = h.reload()
    await deliver(woken, phone, card)
    expect(phone.sent.findLast((m: any) => m.type === 'card.ack')).toMatchObject({ status: 'confirmed', cardId: 'card-1' })
    await deliver(woken, phone, { type: 'session.sync', syncId: 'sync-board-phone' })
    expect(phone.sent.findLast((m: any) => m.type === 'session.snapshot')?.myCards)
      .toEqual([{ pollId: 'poll-board', cardId: 'card-1', column: 'keep', text: 'Hands-on', sorted: false, waiting: false }])

    // Storage refuses the board row: the card is refused and memory goes back to what storage holds.
    const exec = h.ctx.storage.sql.exec
    h.ctx.storage.sql.exec = (query: string, ...args: any[]) => {
      if (query.startsWith('INSERT') && args[0] === 'board:poll-board') throw new Error('disk full')
      return exec(query, ...args)
    }
    await deliver(woken, phone, { ...card, submissionId: 'submission-board-two', text: 'Pairs' })
    expect(phone.sent.findLast((m: any) => m.type === 'card.ack')).toMatchObject({ status: 'rejected', error: 'storage_failed' })
    await deliver(woken, presenter, { type: 'operation', operationId: 'operation-board-hide', action: { type: 'board.hide', pollId: 'poll-board', target: { cardId: 'card-1' } } })
    expect(presenter.sent.findLast((m: any) => m.type === 'operation.ack')).toMatchObject({ status: 'rejected', error: 'storage_failed' })
    h.ctx.storage.sql.exec = exec
    // Neither the refused card nor the refused hide happened; the same ids can be sent again.
    await deliver(woken, phone, { ...card, submissionId: 'submission-board-two', text: 'Pairs' })
    expect(phone.sent.findLast((m: any) => m.type === 'card.ack')).toMatchObject({ status: 'confirmed', cardId: 'card-2' })
    await deliver(woken, presenter, { type: 'operation', operationId: 'operation-board-hide', action: { type: 'board.hide', pollId: 'poll-board', target: { cardId: 'card-1' } } })
    expect(presenter.sent.findLast((m: any) => m.type === 'operation.ack')).toMatchObject({ status: 'confirmed' })
    expect(phone.sent.findLast((m: any) => m.type === 'poll.state')?.boardState.cards.map((c: any) => c.cardId)).toEqual(['card-2'])
  })

  test('a board opened but never written takes its definition’s limit on load, and the phone learns its allowance', async () => {
    for (const limit of [12, null]) {
      const h = harness()
      const presenter = h.socket('presenter', `presenter-limit-${limit}`)
      const phone = h.socket('audience', `phone-limit-${limit}`, 2, 'participant-limit')
      await deliver(h.worker, presenter, { type: 'operation', operationId: `operation-open-${limit}`,
        action: { type: 'poll.open', poll: { ...board, board: { limit, cardsPerPhone: 2 } } } })
      // The board's row is lost (it was never written, or storage dropped it): the load rebuilds it.
      const exec = h.ctx.storage.sql.exec
      h.ctx.storage.sql.exec = (query: string, ...args: any[]) =>
        query.startsWith('SELECT') && args[0] === 'board:poll-board' ? [] : exec(query, ...args)
      const woken = h.reload()
      h.ctx.storage.sql.exec = exec
      await deliver(woken, phone, { type: 'session.sync', syncId: `sync-limit-${limit}` })
      const snapshot = phone.sent.findLast((m: any) => m.type === 'session.snapshot')
      expect(snapshot.polls[0].boardState.limit).toBe(limit)
      expect(snapshot.myBoards).toEqual([{ pollId: 'poll-board', cardsUsed: 0, cardsPerPhone: 2 }])
    }
  })

  test('a protocol-1 board open whose row cannot be written is refused, not sent to the room', async () => {
    const h = harness()
    const presenter = h.socket('presenter', 'presenter-v1-fail', 1)
    const phone = h.socket('audience', 'phone-v1-fail', 1)
    const exec = h.ctx.storage.sql.exec
    h.ctx.storage.sql.exec = (query: string, ...args: any[]) => {
      if (query.startsWith('INSERT') && args[0] === 'board:poll-board') throw new Error('disk full')
      return exec(query, ...args)
    }
    await deliver(h.worker, presenter, { type: 'poll.open', poll: board })
    h.ctx.storage.sql.exec = exec
    expect(presenter.sent.at(-1)).toEqual({ type: 'protocol.error', code: 'storage_failed' })
    expect(phone.sent.some((m: any) => m.type === 'poll.state')).toBe(false)
  })

  test('protocol-1 sockets cannot send board operations or cards', async () => {
    const h = harness()
    const presenter = h.socket('presenter', 'presenter-v1', 1)
    const phone = h.socket('audience', 'phone-v1', 1)
    await deliver(h.worker, presenter, { type: 'poll.open', poll: board })
    await deliver(h.worker, presenter, { type: 'board.freeze', pollId: 'poll-board', frozen: true })
    expect(presenter.sent.at(-1)).toEqual({ type: 'protocol.error', code: 'invalid_or_inert_message' })
    await deliver(h.worker, phone, { type: 'card.add', submissionId: 'submission-v1-card', pollId: 'poll-board', column: 'keep', text: 'x' })
    expect(phone.sent.at(-1)).toEqual({ type: 'protocol.error', code: 'invalid_or_inert_message' })
    expect(h.ctx.storage.sql.exec('SELECT value FROM kv WHERE key = ?', 'board:poll-board')).toHaveLength(1)
  })
})


describe('Pointer through the actual Worker socket seam', () => {
  test('authenticated presenter only, venue only, no echo, rate capped and never persisted', async () => {
    const h = harness()
    const presenter = h.socket('presenter', 'pointer-owner')
    const screen = h.socket('audience', 'pointer-screen', 2, 'screen-user', 'screen')
    const phone = h.socket('audience', 'pointer-phone')
    const message = { type: 'pointer.live', pointer: { x: 640, y: 360, space: 'slide', slideId: 'text' } }
    const before = h.state()
    await deliver(h.worker, screen, message)
    expect(screen.sent.filter((m:any)=>m.type==='pointer.live')).toHaveLength(0)
    for(let i=0;i<25;i++) await deliver(h.worker,presenter,message)
    expect(screen.sent.filter((m:any)=>m.type==='pointer.live')).toHaveLength(20)
    expect(phone.sent.filter((m:any)=>m.type==='pointer.live')).toHaveLength(0)
    expect(presenter.sent).toHaveLength(0)
    expect(presenter.closed).toBe(false)
    expect(h.state()).toEqual(before)
    expect(h.feedback()).toBeUndefined()
    const clock = spyOn(Date, 'now').mockReturnValue(Date.now() + 1001)
    try { await deliver(h.worker,presenter,{type:'pointer.live',pointer:'gone'}) } finally { clock.mockRestore() }
    expect(screen.sent.filter((m:any)=>m.type==='pointer.live')).toHaveLength(21)
    expect(screen.sent.at(-1)).toEqual({type:'pointer.live',pointer:'gone'})
    const rejoined = h.socket('audience','pointer-rejoin',2,'rejoin','screen')
    await deliver(h.reload(),rejoined,{type:'session.sync',syncId:'pointer-sync'})
    expect(JSON.stringify(rejoined.sent)).not.toContain('pointer.live')
  })
  test('phone frames and oversized presenter frames skip the extra transient parse', async () => {
    const h = harness()
    const phone = h.socket('audience', 'pointer-parse-phone', 1)
    const presenter = h.socket('presenter', 'pointer-parse-presenter', 1)
    for (const [socket, raw] of [
      [phone, JSON.stringify({ type: 'pointer.live', pointer: 'gone' })],
      [presenter, JSON.stringify({ type: 'pointer.live', pointer: 'gone', padding: 'x'.repeat(600) })],
    ]) {
      const parse = JSON.parse
      let incomingParses = 0
      const probe = spyOn(JSON, 'parse').mockImplementation((value, reviver) => {
        if (value === raw) incomingParses++
        return parse(value, reviver)
      })
      try { await h.worker.webSocketMessage(socket, raw) } finally { probe.mockRestore() }
      // The original role-specific routing may parse; the transient branch must add no parse.
      expect(incomingParses).toBe(1)
    }
  })
  test('a superseded presenter cannot send pointer.live after a reconnect', async () => {
    const h = harness()
    const old = h.socket('presenter', 'pointer-old')
    const screen = h.socket('audience', 'pointer-reconnect-screen', 2, 'screen', 'screen')
    await deliver(h.worker, old, { type: 'session.sync', syncId: 'old-sync' })
    const next = h.socket('presenter', 'pointer-new')
    await deliver(h.worker, next, { type: 'session.sync', syncId: 'new-sync' })
    // acceptSocket persists the new authenticated owner before closing the previous socket.
    const state = h.state()
    recoveryState(state).presenterConnectionId = 'pointer-new'
    h.ctx.storage.sql.exec('INSERT INTO kv (key, value) VALUES (?, ?)', 'session', JSON.stringify(state))
    const reconnected = h.reload()
    await deliver(reconnected, old, { type: 'pointer.live', pointer: { x: 123, y: 456, space: 'slide', slideId: 'text' } })
    expect(screen.sent.filter((message: any) => message.type === 'pointer.live')).toHaveLength(0)
    expect(old.sent.at(-1)).toEqual({ type: 'session.superseded' })
    await deliver(reconnected, next, { type: 'pointer.live', pointer: 'gone' })
    expect(screen.sent.at(-1)).toEqual({ type: 'pointer.live', pointer: 'gone' })
  })
  test('malformed and oversized pointers never reach a screen; recovery operations cannot persist them', async () => {
    const h = harness()
    const p = h.socket('presenter', 'pointer-validate')
    const v = h.socket('audience', 'pointer-venue', 2, 'venue', 'screen')
    const before=h.state()
    const invalid = [{ x: -1, y: 0, space: 'slide', slideId: 'text' },
      { x: 1, y: 2, space: 'image', slideId: 'image' }, null]
    for (const pointer of invalid) await deliver(h.worker, p, { type: 'pointer.live', pointer })
    await deliver(h.worker,p,{type:'pointer.live',pointer:'gone',padding:'x'.repeat(600)})
    await deliver(h.worker,p,{type:'operation',operationId:'pointer-operation',action:{type:'pointer.live',pointer:'gone'}})
    expect(v.sent.filter((m:any)=>m.type==='pointer.live')).toHaveLength(0)
    expect(h.state()).toEqual(before)
  })
})

describe('Pen ink through the actual Worker socket seam', () => {
  const stroke = { tool: 'arrow', ink: 'red', width: 'thick', points: [[640, 360], [900, 500]] }
  const message = { type: 'ink.live', ink: { slideId: 'text', space: 'slide', strokes: [stroke], draft: null } }
  const inkSent = (socket: any) => socket.sent.filter((m: any) => m.type === 'ink.live')
  test('authenticated presenter only, venue screens only, rate capped, never written to session storage', async () => {
    const h = harness()
    const presenter = h.socket('presenter', 'ink-owner')
    const screen = h.socket('audience', 'ink-screen', 2, 'ink-screen-user', 'screen')
    const phone = h.socket('audience', 'ink-phone')
    const before = h.state()
    await deliver(h.worker, screen, message)
    await deliver(h.worker, phone, message)
    expect(inkSent(screen)).toHaveLength(0)
    for (let i = 0; i < 25; i++) await deliver(h.worker, presenter, message)
    expect(inkSent(screen)).toHaveLength(20)
    expect(inkSent(screen).at(-1)).toEqual(message)
    expect(inkSent(phone)).toHaveLength(0)
    expect(presenter.sent).toHaveLength(0)
    expect(h.state()).toEqual(before)
    expect(h.feedback()).toBeUndefined()
    expect(JSON.stringify([...h.ctx.storage.sql.exec('SELECT', 'session')])).not.toContain('ink')
  })
  test('a venue screen that joins or reconnects gets the current drawing; a phone does not; ending the session forgets it', async () => {
    const h = harness()
    const presenter = h.socket('presenter', 'ink-late-owner')
    await deliver(h.worker, presenter, message)
    const late = h.socket('audience', 'ink-late-screen', 2, 'ink-late', 'screen')
    await deliver(h.worker, late, { type: 'session.sync', syncId: 'ink-late-sync' })
    expect(late.sent.at(-2).type).toBe('session.snapshot')
    expect(late.sent.at(-1)).toEqual(message)
    const phone = h.socket('audience', 'ink-late-phone', 2, 'ink-late-phone')
    await deliver(h.worker, phone, { type: 'session.sync', syncId: 'ink-phone-sync' })
    expect(inkSent(phone)).toHaveLength(0)
    // Cleared by the presenter: the empty layer replaces the drawing for screens that join later.
    const cleared = { type: 'ink.live', ink: { slideId: 'text', space: 'slide', strokes: [], draft: null } }
    await deliver(h.worker, presenter, cleared)
    const later = h.socket('audience', 'ink-later-screen', 2, 'ink-later', 'screen')
    await deliver(h.worker, later, { type: 'session.sync', syncId: 'ink-later-sync' })
    expect(later.sent.at(-1)).toEqual(cleared)
    await deliver(h.worker, presenter, message)
    // A reloaded object (memory gone) holds no ink, as it lived in memory only: a screen that joins
    // has the presenter asked to resend its layer at once, and the answer reaches the screen.
    const reloaded = h.reload()
    const storedBefore = JSON.stringify([...h.ctx.storage.sql.exec('SELECT', 'session')])
    const afterReload = h.socket('audience', 'ink-reload-screen', 2, 'ink-reload', 'screen')
    const requestsBefore = presenter.sent.filter((m: any) => m.type === 'ink.request').length
    expect(requestsBefore).toBe(0)
    await deliver(reloaded, afterReload, { type: 'session.sync', syncId: 'ink-reload-sync' })
    expect(inkSent(afterReload)).toHaveLength(0)
    expect(presenter.sent.at(-1)).toEqual({ type: 'ink.request' })
    // A second screen within the second does not ask again; a phone never asks.
    const second = h.socket('audience', 'ink-reload-screen-2', 2, 'ink-reload-2', 'screen')
    await deliver(reloaded, second, { type: 'session.sync', syncId: 'ink-reload-sync-2' })
    const reloadPhone = h.socket('audience', 'ink-reload-phone', 2, 'ink-reload-phone')
    await deliver(reloaded, reloadPhone, { type: 'session.sync', syncId: 'ink-reload-phone-sync' })
    expect(presenter.sent.filter((m: any) => m.type === 'ink.request')).toHaveLength(1)
    await deliver(reloaded, presenter, message)
    expect(inkSent(afterReload)).toEqual([message])
    expect(inkSent(second)).toEqual([message])
    expect(inkSent(reloadPhone)).toHaveLength(0)
    // Held in memory again; never written to storage.
    const third = h.socket('audience', 'ink-reload-screen-3', 2, 'ink-reload-3', 'screen')
    await deliver(reloaded, third, { type: 'session.sync', syncId: 'ink-reload-sync-3' })
    expect(inkSent(third)).toEqual([message])
    expect(JSON.stringify([...h.ctx.storage.sql.exec('SELECT', 'session')])).toBe(storedBefore)
    expect(storedBefore).not.toContain('"strokes"')
    const ender = h.worker as any
    await ender.endSession('ended')
    expect(ender.liveInk).toBeNull()
  })
  test('a screen that syncs again and again gets the cached layer at most once a second, and new ink at once', async () => {
    const h = harness()
    const presenter = h.socket('presenter', 'ink-sync-owner')
    await deliver(h.worker, presenter, message)
    const screen = h.socket('audience', 'ink-sync-screen', 2, 'ink-sync', 'screen')
    let now = Date.now()
    const clock = spyOn(Date, 'now').mockImplementation(() => now)
    try {
      for (let i = 0; i < 10; i++) await deliver(h.worker, screen, { type: 'session.sync', syncId: 'ink-sync-' + i })
      expect(inkSent(screen)).toHaveLength(1)
      now += 1001
      await deliver(h.worker, screen, { type: 'session.sync', syncId: 'ink-sync-later' })
      expect(inkSent(screen)).toHaveLength(2)
      const next = { ...message, ink: { ...message.ink, strokes: [] } }
      await deliver(h.worker, presenter, next)
      expect(inkSent(screen).at(-1)).toEqual(next)
      expect(presenter.sent.filter((m: any) => m.type === 'ink.request')).toHaveLength(0)
    } finally { clock.mockRestore() }
  })
  test('a superseded presenter cannot draw; malformed and oversized ink never reaches a screen; operations cannot carry it', async () => {
    const h = harness()
    const old = h.socket('presenter', 'ink-old')
    const screen = h.socket('audience', 'ink-reconnect-screen', 2, 'ink-screen', 'screen')
    await deliver(h.worker, old, { type: 'session.sync', syncId: 'ink-old-sync' })
    const next = h.socket('presenter', 'ink-new')
    await deliver(h.worker, next, { type: 'session.sync', syncId: 'ink-new-sync' })
    const state = h.state()
    recoveryState(state).presenterConnectionId = 'ink-new'
    h.ctx.storage.sql.exec('INSERT INTO kv (key, value) VALUES (?, ?)', 'session', JSON.stringify(state))
    const reconnected = h.reload()
    await deliver(reconnected, old, message)
    expect(inkSent(screen)).toHaveLength(0)
    expect(old.sent.at(-1)).toEqual({ type: 'session.superseded' })
    const before = h.state()
    for (const ink of [{ ...message.ink, strokes: [{ ...stroke, ink: 'purple' }] }, { ...message.ink, strokes: [{ ...stroke, points: [[-5, 0], [1, 1]] }] },
      { ...message.ink, strokes: Array.from({ length: 101 }, () => stroke) }, { ...message.ink, slideId: '' }, null]) {
      await deliver(reconnected, next, { type: 'ink.live', ink })
    }
    await deliver(reconnected, next, { ...message, padding: 'x'.repeat(70_000) })
    await deliver(reconnected, next, { type: 'operation', operationId: 'ink-operation', action: message })
    expect(inkSent(screen)).toHaveLength(0)
    expect(h.state()).toEqual(before)
    await deliver(reconnected, next, message)
    expect(inkSent(screen)).toEqual([message])
  })
})
