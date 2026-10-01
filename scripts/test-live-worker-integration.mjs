import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { nextMessage, nextMessages, openSocket, startLiveWorker } from './lib/live-worker-harness.mjs'

// Attach the inbox before the handshake so immediate v2 hello/snapshot messages cannot race a listener.
async function openRecoverySocket(url) {
  const socket = new WebSocket(url)
  const messages = []
  const waiting = []
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data))
    const index = waiting.findIndex(item => item.matches(message))
    if (index < 0) messages.push(message)
    else {
      const [item] = waiting.splice(index, 1)
      clearTimeout(item.timer)
      item.resolve(message)
    }
  })
  const inbox = {
    socket,
    send: message => socket.send(JSON.stringify(message)),
    wait(type, predicate = () => true) {
      const matches = message => message.type === type && predicate(message)
      const index = messages.findIndex(matches)
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0])
      return new Promise((resolve, reject) => {
        const item = { matches, resolve, timer: null }
        item.timer = setTimeout(() => {
          waiting.splice(waiting.indexOf(item), 1)
          reject(new Error(`Timed out waiting for ${type}; queued: ${messages.map(m => m.type).join(', ')}`))
        }, 5000)
        waiting.push(item)
      })
    },
    async disconnect() {
      if (socket.readyState === WebSocket.CLOSED) return
      const closed = new Promise(resolve => socket.addEventListener('close', resolve, { once: true }))
      socket.close(1000, 'Simulated presenter or audience disconnect')
      await closed
    },
  }
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out opening recovery socket')), 5000)
    socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Recovery socket failed')) }, { once: true })
  })
  const hello = await inbox.wait('session.hello')
  assert.equal(hello.protocol, 2)
  return inbox
}

const { baseUrl, adminSecret, signingSecret, stop } = await startLiveWorker()
const sockets = []
try {
  const createdResponse = await fetch(`${baseUrl}/sessions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminSecret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ talkSlug: 'integration-talk' }),
  })
  const createdText = await createdResponse.text()
  assert.equal(createdResponse.status, 201, createdText)
  const created = JSON.parse(createdText)

  const audience = await openSocket(`${baseUrl.replace('http:', 'ws:')}/sessions/${created.sessionId}/audience`)
  sockets.push(audience)
  const presenter = await openSocket(
    `${baseUrl.replace('http:', 'ws:')}/sessions/${created.sessionId}/presenter?token=${encodeURIComponent(created.presenterToken)}`,
  )
  sockets.push(presenter)

  const firstState = nextMessage(audience)
  presenter.send(JSON.stringify({
    type: 'slide.publish', slideId: 'slide-2', reveal: 1, focus: { kind: 'reveal', step: 2 },
  }))
  assert.deepEqual(await firstState, {
    type: 'slide.state', slideId: 'slide-2', reveal: 1, focus: { kind: 'reveal', step: 2 }, revision: 1,
  })

  audience.close()
  const lateAudience = await openSocket(`${baseUrl.replace('http:', 'ws:')}/sessions/${created.sessionId}/audience`)
  sockets.push(lateAudience)
  // A new join's connect-time `session.presence` broadcast (acceptSocket's `broadcastPresence()`)
  // always precedes the direct `slide.state` current-state send that follows it in the same,
  // synchronous handler — deterministic ordering, not a race, so asserted strictly.
  assert.deepEqual(await nextMessage(lateAudience), { type: 'session.presence', presenterConnected: true, venueScreens: 0 })
  assert.deepEqual(await nextMessage(lateAudience), {
    type: 'slide.state', slideId: 'slide-2', reveal: 1, focus: { kind: 'reveal', step: 2 }, revision: 1,
  })

  const liveDiscovery = await fetch(`${baseUrl}/session/integration-talk`).then((response) => response.json())
  assert.deepEqual(liveDiscovery, { live: true, sessionId: created.sessionId })

  const liveOpenState = nextMessage(lateAudience)
  const presenterLiveOpenState = nextMessage(presenter)
  presenter.send(JSON.stringify({
    type: 'poll.open',
    poll: {
      pollId: 'poll-live', type: 'single', question: 'Choose one', visibility: 'live',
      options: [{ optionId: 'option-a', label: 'A' }, { optionId: 'option-b', label: 'B' }],
    },
  }))
  assert.deepEqual(await liveOpenState, {
    type: 'poll.state', pollId: 'poll-live', pollType: 'single', question: 'Choose one',
    options: [{ optionId: 'option-a', label: 'A' }, { optionId: 'option-b', label: 'B' }],
    visibility: 'live', open: true, revealed: true, tallies: { 'option-a': 0, 'option-b': 0 },
  })
  await presenterLiveOpenState
  const liveVoteState = nextMessage(lateAudience)
  const presenterVoteMessages = nextMessages(presenter, 2)
  lateAudience.send(JSON.stringify({ type: 'poll.vote', pollId: 'poll-live', choice: 'option-a' }))
  assert.deepEqual(await liveVoteState, {
    type: 'poll.state', pollId: 'poll-live', pollType: 'single', question: 'Choose one',
    options: [{ optionId: 'option-a', label: 'A' }, { optionId: 'option-b', label: 'B' }],
    visibility: 'live', open: true, revealed: true, tallies: { 'option-a': 1, 'option-b': 0 },
  })
  const [voteRecord, aggregateState] = await presenterVoteMessages
  assert.deepEqual(voteRecord, { type: 'poll.vote-record', pollId: 'poll-live', choice: 'option-a' })
  assert.deepEqual(aggregateState, {
    type: 'poll.state', pollId: 'poll-live', pollType: 'single', question: 'Choose one',
    options: [{ optionId: 'option-a', label: 'A' }, { optionId: 'option-b', label: 'B' }],
    visibility: 'live', open: true, revealed: true, tallies: { 'option-a': 1, 'option-b': 0 },
  })

  const rejectedLegacyEdit = nextMessage(lateAudience)
  lateAudience.send(JSON.stringify({ type: 'poll.vote', pollId: 'poll-live', choice: 'option-b' }))
  assert.deepEqual(await rejectedLegacyEdit, { type: 'protocol.error', code: 'invalid_poll_vote' },
    'legacy audience cannot change an accepted answer on the same connection')

  const heldOpenStates = nextMessages(lateAudience, 2)
  const presenterHeldOpenStates = nextMessages(presenter, 2)
  presenter.send(JSON.stringify({
    type: 'poll.open',
    poll: {
      pollId: 'poll-held', type: 'multiple', question: 'Choose any', visibility: 'held',
      options: [{ optionId: 'option-a', label: 'A' }, { optionId: 'option-b', label: 'B' }],
    },
  }))
  const [closedLiveState, heldOpenState] = await heldOpenStates
  assert.deepEqual(closedLiveState, {
    type: 'poll.state', pollId: 'poll-live', pollType: 'single', question: 'Choose one',
    options: [{ optionId: 'option-a', label: 'A' }, { optionId: 'option-b', label: 'B' }],
    visibility: 'live', open: false, revealed: true, tallies: { 'option-a': 1, 'option-b': 0 },
  })
  assert.deepEqual(heldOpenState, {
    type: 'poll.state', pollId: 'poll-held', pollType: 'multiple', question: 'Choose any',
    options: [{ optionId: 'option-a', label: 'A' }, { optionId: 'option-b', label: 'B' }],
    visibility: 'held', open: true, revealed: false,
  })
  await presenterHeldOpenStates
  const heldRecordedState = nextMessage(lateAudience)
  const presenterHeldVoteMessages = nextMessages(presenter, 2)
  lateAudience.send(JSON.stringify({ type: 'poll.vote', pollId: 'poll-held', choice: ['option-a', 'option-b'] }))
  assert.deepEqual(await heldRecordedState, {
    type: 'poll.state', pollId: 'poll-held', pollType: 'multiple', question: 'Choose any',
    options: [{ optionId: 'option-a', label: 'A' }, { optionId: 'option-b', label: 'B' }],
    visibility: 'held', open: true, revealed: false, recorded: true,
  })
  assert.deepEqual((await presenterHeldVoteMessages)[0], {
    type: 'poll.vote-record', pollId: 'poll-held', choice: ['option-a', 'option-b'],
  })
  const heldRevealedState = nextMessage(lateAudience)
  const presenterHeldRevealState = nextMessage(presenter)
  presenter.send(JSON.stringify({ type: 'poll.reveal', pollId: 'poll-held' }))
  assert.deepEqual(await heldRevealedState, {
    type: 'poll.state', pollId: 'poll-held', pollType: 'multiple', question: 'Choose any',
    options: [{ optionId: 'option-a', label: 'A' }, { optionId: 'option-b', label: 'B' }],
    visibility: 'held', open: true, revealed: true, tallies: { 'option-a': 1, 'option-b': 1 },
  })
  await presenterHeldRevealState

  const quickOpenAudienceStates = nextMessages(lateAudience, 2)
  const quickOpenPresenterStates = nextMessages(presenter, 2)
  presenter.send(JSON.stringify({
    type: 'poll.open',
    poll: {
      pollId: 'quick-integration-open', type: 'open', question: 'What matters now?',
      visibility: 'live', options: [],
    },
  }))
  const [, quickOpenState] = await quickOpenAudienceStates
  assert.deepEqual(quickOpenState, {
    type: 'poll.state', pollId: 'quick-integration-open', pollType: 'open', question: 'What matters now?',
    options: [], visibility: 'live', open: true, revealed: true, responses: [],
  })
  await quickOpenPresenterStates

  const secondAudience = await openSocket(`${baseUrl.replace('http:', 'ws:')}/sessions/${created.sessionId}/audience`)
  sockets.push(secondAudience)
  // Same deterministic ordering as the late joiner above: presence, then the current slide state,
  // then the one open poll's state — three sends in the same synchronous handler, always in order.
  assert.deepEqual(await nextMessage(secondAudience), { type: 'session.presence', presenterConnected: true, venueScreens: 0 })
  assert.deepEqual(await nextMessage(secondAudience), {
    type: 'slide.state', slideId: 'slide-2', reveal: 1, focus: { kind: 'reveal', step: 2 }, revision: 1,
  })
  const secondAudienceQuickState = await nextMessage(secondAudience)
  assert.deepEqual(secondAudienceQuickState, quickOpenState)

  const firstAudienceUpdates = nextMessage(lateAudience)
  const firstSecondAudienceUpdates = nextMessage(secondAudience)
  const firstPresenterUpdates = nextMessages(presenter, 2)
  lateAudience.send(JSON.stringify({ type: 'poll.vote', pollId: 'quick-integration-open', choice: 'Accountability' }))
  const firstOpenVoteState = await firstAudienceUpdates
  assert.deepEqual(await firstSecondAudienceUpdates, firstOpenVoteState)
  await firstPresenterUpdates

  const secondAudienceUpdates = nextMessage(lateAudience)
  const secondSecondAudienceUpdates = nextMessage(secondAudience)
  const secondPresenterUpdates = nextMessages(presenter, 2)
  secondAudience.send(JSON.stringify({ type: 'poll.vote', pollId: 'quick-integration-open', choice: 'Judgement' }))
  const twoResponseAudienceState = await secondAudienceUpdates
  assert.deepEqual(await secondSecondAudienceUpdates, twoResponseAudienceState)
  const [, twoResponsePresenterState] = await secondPresenterUpdates
  const hiddenResponseId = twoResponsePresenterState.responses.find((response) => response.text === 'Accountability')?.responseId
  assert.ok(hiddenResponseId)

  const hiddenAudienceUpdate = nextMessage(lateAudience)
  const hiddenSecondAudienceUpdate = nextMessage(secondAudience)
  const hiddenPresenterUpdate = nextMessage(presenter)
  presenter.send(JSON.stringify({
    type: 'poll.hide', pollId: 'quick-integration-open', responseId: hiddenResponseId, hidden: true,
  }))
  const audienceAfterHide = await hiddenAudienceUpdate
  assert.deepEqual(await hiddenSecondAudienceUpdate, audienceAfterHide)
  assert.deepEqual(audienceAfterHide.responses.map((response) => response.text), ['Judgement'])
  const presenterAfterHide = await hiddenPresenterUpdate
  assert.deepEqual(presenterAfterHide.responses, [
    { responseId: hiddenResponseId, text: 'Accountability', hidden: true },
    twoResponsePresenterState.responses.find((response) => response.text === 'Judgement'),
  ])

  const closedMessage = nextMessage(lateAudience)
  const closeResponse = await fetch(`${baseUrl}/sessions/${created.sessionId}/close`, {
    method: 'POST', headers: { authorization: `Bearer ${created.presenterToken}` },
  })
  assert.equal(closeResponse.status, 200, await closeResponse.text())
  assert.deepEqual(await closedMessage, { type: 'session.closed' })
  const endedDiscovery = await fetch(`${baseUrl}/session/integration-talk`).then((response) => response.json())
  assert.deepEqual(endedDiscovery, { live: false })
  const legacyRecoveryResponse = await fetch(`${baseUrl}/sessions/${created.sessionId}/recovery`, {
    headers: { authorization: `Bearer ${created.presenterToken}` },
  })
  assert.equal(legacyRecoveryResponse.status, 200)
  const legacyRecovery = await legacyRecoveryResponse.json()
  assert.equal(legacyRecovery.voteRecords.length, 4, 'all accepted v1 answers remain recoverable after ending')
  assert.deepEqual(legacyRecovery.voteRecords.map(record => record.sequence), [1, 2, 3, 4])
  assert.equal(legacyRecovery.voteRecords.filter(record => record.pollId === 'poll-live').length, 1)
  assert.equal(legacyRecovery.voteRecords.find(record => record.pollId === 'poll-live').choice, 'option-a')
  assert.equal(legacyRecovery.polls.find(poll => poll.pollId === 'quick-integration-open').responses.find(response => response.text === 'Accountability').hidden, true,
    'presenter recovery retains a moderated answer with its hidden flag')


  assert.deepEqual(await fetch(`${baseUrl}/capabilities`).then(response => response.json()), {
    protocol: 2, build: '19-board-seed',
  })
  const recoveryResponse = await fetch(`${baseUrl}/sessions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminSecret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ talkSlug: 'presenter-recovery-talk' }),
  })
  const recoveryCreated = await recoveryResponse.json()
  assert.equal(recoveryResponse.status, 201, JSON.stringify(recoveryCreated))
  const sessionUrl = `${baseUrl}/sessions/${recoveryCreated.sessionId}`
  const wsSessionUrl = sessionUrl.replace('http:', 'ws:')
  const presenterUrl = `${wsSessionUrl}/presenter?protocol=2&token=${encodeURIComponent(recoveryCreated.presenterToken)}`
  const audienceUrl = participantId => `${wsSessionUrl}/audience?protocol=2&participantId=${participantId}`
  async function connectRecovery(url) {
    const client = await openRecoverySocket(url)
    sockets.push(client.socket)
    return client
  }
  async function sync(client, syncId, extra = {}) {
    client.send({ type: 'session.sync', syncId, ...extra })
    return client.wait('session.snapshot', snapshot => snapshot.syncId === syncId)
  }
  async function operation(client, operationId, action) {
    client.send({ type: 'operation', operationId, action })
    const ack = await client.wait('operation.ack', message => message.operationId === operationId)
    assert.deepEqual(ack, { type: 'operation.ack', operationId, status: 'confirmed' })
    return ack
  }
  const originalPresenter = await connectRecovery(presenterUrl)
  const originalAudience = await connectRecovery(audienceUrl('participant-first'))
  const initialSnapshot = await sync(originalPresenter, 'sync-initial', {
    slideState: { slideId: 'recovery-slide', reveal: 2, focus: { kind: 'focus', step: 1 } },
  })
  assert.equal(initialSnapshot.sessionId, recoveryCreated.sessionId)
  assert.equal(initialSnapshot.expiresAt, recoveryCreated.expiresAt)
  const recoveryPoll = {
    pollId: 'recovery-poll', slideId: 'recovery-slide', type: 'single', question: 'Keep these votes?',
    visibility: 'held', options: [{ optionId: 'a', label: 'A' }, { optionId: 'b', label: 'B' }],
  }
  const openAction = { type: 'poll.open', poll: recoveryPoll }
  originalPresenter.send(openAction)
  assert.deepEqual(await originalPresenter.wait('protocol.error'), { type: 'protocol.error', code: 'acknowledged_message_required' })
  assert.deepEqual((await sync(originalPresenter, 'sync-raw-open-denied')).polls, [], 'v2 cannot open a poll without an operation identity')
  const opened = await operation(originalPresenter, 'operation-open-recovery', openAction)
  const firstVote = { type: 'vote.submit', submissionId: 'submission-first', pollId: recoveryPoll.pollId, choice: 'a' }
  originalAudience.send(firstVote)
  const firstAck = await originalAudience.wait('vote.ack')
  assert.deepEqual(firstAck, { type: 'vote.ack', submissionId: firstVote.submissionId,
    pollId: recoveryPoll.pollId, status: 'confirmed', choice: 'a' })
  originalAudience.send({ type: 'poll.vote', pollId: recoveryPoll.pollId, choice: 'b' })
  assert.deepEqual(await originalAudience.wait('protocol.error'), { type: 'protocol.error', code: 'acknowledged_message_required' })
  for (const rawAction of [
    { type: 'poll.close', pollId: recoveryPoll.pollId },
    { type: 'poll.reveal', pollId: recoveryPoll.pollId },
    { type: 'poll.hide', pollId: recoveryPoll.pollId, responseId: 'response-test', hidden: true },
  ]) {
    originalPresenter.send(rawAction)
    assert.deepEqual(await originalPresenter.wait('protocol.error'), { type: 'protocol.error', code: 'acknowledged_message_required' })
  }
  const bypassRejectedState = await sync(originalPresenter, 'sync-raw-bypass-denied')
  assert.equal(bypassRejectedState.polls[0].open, true)
  assert.equal(bypassRejectedState.polls[0].revealed, false)
  assert.deepEqual(bypassRejectedState.polls[0].tallies, { a: 1, b: 0 })
  assert.equal(bypassRejectedState.voteRecords.length, 1, 'raw commands cannot overwrite an accepted answer or add a history record')
  const firstRecord = await originalPresenter.wait('poll.vote-record')
  assert.equal(firstRecord.sequence, 1)
  assert.equal(firstRecord.submissionId, firstVote.submissionId)

  await originalPresenter.disconnect()
  assert.deepEqual(await fetch(`${baseUrl}/session/presenter-recovery-talk`).then(response => response.json()), {
    live: true, sessionId: recoveryCreated.sessionId,
  }, 'presenter disconnect leaves the same session discoverable')
  const absentSnapshot = await sync(originalAudience, 'sync-presenter-absent')
  assert.equal(absentSnapshot.sessionId, recoveryCreated.sessionId)
  assert.equal(absentSnapshot.polls[0].open, true)
  assert.equal(absentSnapshot.polls[0].tallies, undefined, 'held tallies remain private during recovery')
  assert.equal(absentSnapshot.voteRecords, undefined, 'audience never receives raw recovered votes')
  assert.deepEqual(absentSnapshot.receipts, [firstAck])
  const secondRecoveryAudience = await connectRecovery(audienceUrl('participant-second'))
  secondRecoveryAudience.send({ type: 'vote.submit', submissionId: 'submission-second', pollId: recoveryPoll.pollId, choice: 'b' })
  assert.equal((await secondRecoveryAudience.wait('vote.ack')).status, 'confirmed', 'audience votes continue while presenter is absent')

  const recoveredPresenter = await connectRecovery(presenterUrl)
  const recovered = await sync(recoveredPresenter, 'sync-after-reconnect')
  assert.equal(recovered.sessionId, recoveryCreated.sessionId)
  assert.deepEqual(recovered.slideState, initialSnapshot.slideState, 'slide and reveal/focus recover without creating a new session')
  assert.equal(recovered.polls[0].pollId, recoveryPoll.pollId)
  assert.equal(recovered.polls[0].open, true)
  assert.deepEqual(recovered.polls[0].tallies, { a: 1, b: 1 })
  assert.deepEqual(recovered.voteRecords.map(record => [record.sequence, record.submissionId, record.choice, record.slideId]), [
    [1, 'submission-first', 'a', 'recovery-slide'], [2, 'submission-second', 'b', 'recovery-slide'],
  ])
  assert.ok(recovered.voteRecords.every(record => Number.isFinite(record.acceptedAt)))
  assert.equal(recovered.moreRecords, false)
  assert.deepEqual((await sync(recoveredPresenter, 'sync-after-record-cursor', { afterSequence: 2 })).voteRecords, [], 'confirmed record cursor avoids replaying already imported votes')

  await originalAudience.disconnect()
  const recoveredAudience = await connectRecovery(audienceUrl('participant-first'))
  recoveredAudience.send(firstVote)
  assert.deepEqual(await recoveredAudience.wait('vote.ack'), firstAck, 'lost acknowledgement retry uses the same submission receipt')
  await operation(recoveredPresenter, 'operation-close-recovery', { type: 'poll.close', pollId: recoveryPoll.pollId })
  recoveredPresenter.send({ type: 'operation', operationId: 'operation-open-recovery', action: openAction })
  assert.deepEqual(await recoveredPresenter.wait('operation.ack', message => message.operationId === 'operation-open-recovery'), opened,
    'lost poll-open acknowledgement replays its receipt after reconnect')
  recoveredAudience.send(firstVote)
  assert.deepEqual(await recoveredAudience.wait('vote.ack'), firstAck, 'accepted submission retry remains confirmed after poll closes')
  const closedRecovery = await sync(recoveredPresenter, 'sync-after-dedup')
  assert.equal(closedRecovery.polls[0].open, false, 'replayed open operation cannot reopen a subsequently closed poll')
  assert.deepEqual(closedRecovery.polls[0].tallies, { a: 1, b: 1 }, 'retries never count a vote twice')
  assert.equal(closedRecovery.voteRecords.length, 2, 'retries do not append duplicate vote records')
  const audienceRecovery = await sync(recoveredAudience, 'sync-closed-audience')
  assert.equal(audienceRecovery.polls[0].open, false, 'closed polls remain available in a v2 recovery snapshot')
  assert.equal(audienceRecovery.polls[0].tallies, undefined)
  assert.deepEqual(audienceRecovery.receipts, [firstAck], 'reconnecting audience recovers only its own receipt')

  await operation(recoveredPresenter, 'operation-reveal-recovery', { type: 'poll.reveal', pollId: recoveryPoll.pollId })
  const revealedRecovery = await sync(recoveredAudience, 'sync-closed-revealed')
  assert.deepEqual(revealedRecovery.polls[0].tallies, { a: 1, b: 1 }, 'results of a closed recovered poll can be revealed')
  const endRecovery = await fetch(`${sessionUrl}/close`, {
    method: 'POST', headers: { authorization: `Bearer ${recoveryCreated.presenterToken}` },
  })
  assert.equal(endRecovery.status, 200)
  assert.deepEqual(await recoveredAudience.wait('session.closed'), { type: 'session.closed', reason: 'ended' })
  assert.deepEqual(await fetch(`${baseUrl}/session/presenter-recovery-talk`).then(response => response.json()), { live: false })

  const finalRecoveryResponse = await fetch(`${sessionUrl}/recovery`, {
    headers: { authorization: `Bearer ${recoveryCreated.presenterToken}` },
  })
  assert.equal(finalRecoveryResponse.status, 200)
  const finalRecovery = await finalRecoveryResponse.json()
  assert.deepEqual(finalRecovery.voteRecords, closedRecovery.voteRecords, 'last accepted answers remain recoverable after explicit End')
  assert.deepEqual(finalRecovery.polls[0].tallies, { a: 1, b: 1 })
  const finalCursor = await fetch(`${sessionUrl}/recovery?afterSequence=2`, {
    headers: { authorization: `Bearer ${recoveryCreated.presenterToken}` },
  }).then(response => response.json())
  assert.deepEqual(finalCursor.voteRecords, [])
  assert.equal(finalCursor.moreRecords, false)
  assert.equal((await fetch(`${sessionUrl}/recovery?afterSequence=invalid`, {
    headers: { authorization: `Bearer ${recoveryCreated.presenterToken}` },
  })).status, 400)
  const alteredClaims = Buffer.from(JSON.stringify({ role: 'presenter', sessionId: recoveryCreated.sessionId,
    exp: recoveryCreated.expiresAt + 1 })).toString('base64url')
  const mismatchedExpiry = `${alteredClaims}.${createHmac('sha256', signingSecret).update(alteredClaims).digest('base64url')}`
  for (const invalidToken of [null, 'invalid-token', created.presenterToken, mismatchedExpiry]) {
    const denied = await fetch(`${sessionUrl}/recovery`, {
      headers: invalidToken ? { authorization: `Bearer ${invalidToken}` } : {},
    })
    assert.equal(denied.status, 401, 'recovery denies absent, invalid, other-session or altered-expiry capabilities')
    assert.deepEqual(await denied.json(), { error: { code: 'presenter_auth_required', message: 'Presenter authentication is required.' } })
  }

  const extendedResponse = await fetch(`${baseUrl}/sessions`, {
    method: 'POST', headers: { authorization: `Bearer ${adminSecret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ talkSlug: 'extended-ballot-integration' }),
  })
  assert.equal(extendedResponse.status, 201)
  const extendedCreated = await extendedResponse.json()
  const extendedUrl = `${baseUrl}/sessions/${extendedCreated.sessionId}`
  const extendedWsUrl = extendedUrl.replace('http:', 'ws:')
  const extendedPresenterUrl = `${extendedWsUrl}/presenter?protocol=2&token=${encodeURIComponent(extendedCreated.presenterToken)}`
  const extendedAudienceUrl = id => `${extendedWsUrl}/audience?protocol=2&participantId=${id}`
  let extendedPresenter = await connectRecovery(extendedPresenterUrl)
  const spectator = await connectRecovery(extendedAudienceUrl('participant-extended-spectator'))
  const options = ['a', 'b', 'c'].map(optionId => ({ optionId, label: optionId.toUpperCase() }))
  const labels = [{ optionId: 'often', label: 'A lot' }, { optionId: 'never', label: 'Never' }]
  const cases = [
    { id: 'ranking-all', type: 'ranking', fields: {}, choice: ['c', 'a', 'b'], invalid: ['a', 'a', 'b'],
      results: { tallies: { a: 2, b: 1, c: 3 }, firstPlaces: { a: 0, b: 0, c: 1 } } },
    { id: 'ranking-top', type: 'ranking', fields: { rankCount: 2 }, choice: ['c', 'a'], invalid: ['a', 'b', 'c'],
      results: { tallies: { a: 1, b: 0, c: 2 }, firstPlaces: { a: 0, b: 0, c: 1 } } },
    { id: 'rating-required', type: 'rating', fields: { labels, allowSkip: false },
      choice: { a: 'often', b: 'never', c: 'often' }, invalid: { a: 'often' },
      results: { categoryTallies: { a: { often: 1, never: 0 }, b: { often: 0, never: 1 }, c: { often: 1, never: 0 } } } },
    { id: 'categorisation-skip', type: 'categorisation', fields: { labels, allowSkip: true },
      choice: { b: 'never' }, invalid: { b: 'unknown' },
      results: { categoryTallies: { a: { often: 0, never: 0 }, b: { often: 0, never: 1 }, c: { often: 0, never: 0 } } } },
  ]
  const extendedRecords = []
  function assertHeldDefinition(state, scenario, open) {
    assert.equal(state.pollType, scenario.type)
    assert.equal(state.slideId, `slide-${scenario.id}`)
    assert.equal(state.open, open)
    assert.equal(state.visibility, 'held')
    assert.equal(state.revealed, false)
    assert.deepEqual(state.options, options)
    for (const field of ['rankCount', 'labels', 'allowSkip']) assert.deepEqual(state[field], scenario.fields[field])
    for (const field of ['tallies', 'firstPlaces', 'categoryTallies', 'responseCount', 'responses']) {
      assert.equal(state[field], undefined, `${scenario.id}: held ${field} must not reach the audience`)
    }
  }
  for (const scenario of cases) {
    const pollId = `poll-${scenario.id}`
    const participantId = `participant-${scenario.id}`
    const voter = await connectRecovery(extendedAudienceUrl(participantId))
    const definition = { pollId, type: scenario.type, question: 'Choose your priorities', visibility: 'held',
      options, slideId: `slide-${scenario.id}`, ...scenario.fields }
    await operation(extendedPresenter, `operation-open-${scenario.id}`, { type: 'poll.open', poll: definition })
    assertHeldDefinition(await voter.wait('poll.state', message => message.pollId === pollId), scenario, true)
    voter.send({ type: 'vote.submit', submissionId: `invalid-${scenario.id}`, pollId, choice: scenario.invalid })
    assert.equal((await voter.wait('vote.ack')).status, 'rejected', `${scenario.id}: invalid ballot rejected by workerd`)
    const vote = { type: 'vote.submit', submissionId: `submission-${scenario.id}`, pollId, choice: scenario.choice }
    voter.send(vote)
    const receipt = await voter.wait('vote.ack')
    assert.deepEqual(receipt, { type: 'vote.ack', submissionId: vote.submissionId, pollId, status: 'confirmed', choice: scenario.choice })
    const record = await extendedPresenter.wait('poll.vote-record', message => message.pollId === pollId)
    assert.deepEqual(record.choice, scenario.choice, `${scenario.id}: live record preserves ordered or mapped choices`)
    assert.equal(record.slideId, definition.slideId)
    assert.equal(record.submissionId, vote.submissionId)
    assert.equal(record.sequence, extendedRecords.length + 1)
    extendedRecords.push(record)

    await voter.disconnect()
    await extendedPresenter.disconnect()
    const retryVoter = await connectRecovery(extendedAudienceUrl(participantId))
    retryVoter.send(vote)
    assert.deepEqual(await retryVoter.wait('vote.ack'), receipt, `${scenario.id}: disconnected receipt retry is idempotent`)
    extendedPresenter = await connectRecovery(extendedPresenterUrl)
    await operation(extendedPresenter, `operation-close-${scenario.id}`, { type: 'poll.close', pollId })
    retryVoter.send(vote)
    assert.deepEqual(await retryVoter.wait('vote.ack'), receipt, `${scenario.id}: retry after closure keeps the accepted receipt`)
    const voterSnapshot = await sync(retryVoter, `sync-voter-${scenario.id}`)
    assertHeldDefinition(voterSnapshot.polls.find(state => state.pollId === pollId), scenario, false)
    assert.equal(voterSnapshot.voteRecords, undefined)
    assert.deepEqual(voterSnapshot.receipts.filter(item => item.status === 'confirmed'), [receipt])
    const spectatorSnapshot = await sync(spectator, `sync-spectator-${scenario.id}`)
    assertHeldDefinition(spectatorSnapshot.polls.find(state => state.pollId === pollId), scenario, false)
    assert.deepEqual(spectatorSnapshot.receipts, [], 'another participant cannot recover the voter receipt')
    assert.equal(spectatorSnapshot.voteRecords, undefined)
    const recoveredBallots = await sync(extendedPresenter, `sync-presenter-${scenario.id}`)
    assert.deepEqual(recoveredBallots.voteRecords, extendedRecords, `${scenario.id}: retries append no recovered records`)
    const result = recoveredBallots.polls.find(state => state.pollId === pollId)
    assert.equal(result.responseCount, 1, `${scenario.id}: retries count once`)
    for (const [field, value] of Object.entries(scenario.results)) assert.deepEqual(result[field], value)
    await retryVoter.disconnect()
  }
  assert.equal((await fetch(`${extendedUrl}/close`, {
    method: 'POST', headers: { authorization: `Bearer ${extendedCreated.presenterToken}` },
  })).status, 200)
  const extendedFinalResponse = await fetch(`${extendedUrl}/recovery`, {
    headers: { authorization: `Bearer ${extendedCreated.presenterToken}` },
  })
  assert.equal(extendedFinalResponse.status, 200)
  const extendedFinal = await extendedFinalResponse.json()
  assert.deepEqual(extendedFinal.voteRecords, extendedRecords, 'ordered rankings and matrix maps remain recoverable after End')
  for (const scenario of cases) {
    const state = extendedFinal.polls.find(poll => poll.pollId === `poll-${scenario.id}`)
    for (const field of ['rankCount', 'labels', 'allowSkip']) assert.deepEqual(state[field], scenario.fields[field])
    assert.equal(state.responseCount, 1)
  }

  console.log('live-worker integration: v1 slide/poll/moderation compatibility; explicit close; v2 same-session reconnect, voting during absence, private snapshots, vote/operation acknowledgement replay, cursor deduplication, closed-poll reveal; immutable legacy answers; raw bypass rejection; authenticated final-answer recovery; ranking, exact Top N, rating and categorisation metadata, receipts, held privacy and retry deduplication passed')
  // Real WebSockets and persistence: limits are authoritative across tabs.
  const limitsCreated = await fetch(`${baseUrl}/sessions`, {
    method: 'POST', headers: { authorization: `Bearer ${adminSecret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ talkSlug: 'limits-talk' }),
  }).then(response => response.json())
  const limitsWs = `${baseUrl.replace('http:', 'ws:')}/sessions/${limitsCreated.sessionId}`
  const limitsPresenter = await connectRecovery(`${limitsWs}/presenter?protocol=2&token=${encodeURIComponent(limitsCreated.presenterToken)}`)
  const limitsAudienceUrl = `${limitsWs}/audience?protocol=2&participantId=participant-limits`
  const tabOne = await connectRecovery(limitsAudienceUrl)
  const tabTwo = await connectRecovery(limitsAudienceUrl)
  const textPoll = { pollId: 'limits-text', type:'open', question:'Ideas', options:[], visibility:'held', maxSubmissions:2 }
  await operation(limitsPresenter, 'operation-limits-open', { type:'poll.open', poll:textPoll })
  const limitsVote = id => ({ type:'vote.submit', pollId:textPoll.pollId, submissionId:id, choice:id })
  tabOne.send(limitsVote('submission-limits-one'))
  assert.equal((await tabOne.wait('vote.ack')).status, 'confirmed')
  assert.equal((await tabTwo.wait('vote.ack')).status, 'confirmed', 'the other tab gets the receipt')
  tabOne.send(limitsVote('submission-limits-two'))
  tabTwo.send(limitsVote('submission-limits-three'))
  const boundary = await Promise.all([
    tabOne.wait('vote.ack', m => m.submissionId === 'submission-limits-two'),
    tabTwo.wait('vote.ack', m => m.submissionId === 'submission-limits-three'),
  ])
  assert.deepEqual(boundary.map(m => m.status).sort(), ['confirmed', 'rejected'])
  await operation(limitsPresenter, 'operation-limits-close', { type:'poll.close', pollId:textPoll.pollId })
  await operation(limitsPresenter, 'operation-limits-reopen', { type:'poll.open', poll:{...textPoll,maxSubmissions:null} })
  await tabOne.disconnect()
  const tabReload = await connectRecovery(limitsAudienceUrl)
  const allowance = await sync(tabReload, 'sync-limits-reload')
  assert.equal(allowance.polls[0].maxSubmissions, 2)
  assert.equal(allowance.polls[0].responses, undefined, 'held answers remain private')
  assert.equal(allowance.receipts.filter(m => m.status === 'confirmed').length, 2)
  tabReload.send(limitsVote('submission-limits-one'))
  assert.equal((await tabReload.wait('vote.ack')).status, 'confirmed', 'retry keeps its receipt')
  tabReload.send(limitsVote('submission-limits-four'))
  assert.equal((await tabReload.wait('vote.ack')).status, 'rejected', 'reopening never refunds allowance')
  const choices = { pollId:'limits-choice', type:'multiple', question:'Choose', visibility:'held',
    options:['a','b','c'].map(optionId => ({optionId,label:optionId})), maxSelections:2 }
  await operation(limitsPresenter, 'operation-limits-choices', { type:'poll.open', poll:choices })
  tabReload.send({type:'vote.submit',pollId:choices.pollId,submissionId:'submission-too-many',choice:['a','b','c']})
  assert.equal((await tabReload.wait('vote.ack')).status, 'rejected')
  tabReload.send({type:'vote.submit',pollId:choices.pollId,submissionId:'submission-up-to-two',choice:['a','b']})
  assert.equal((await tabReload.wait('vote.ack')).status, 'confirmed')
  console.log('live Worker response limits: per-participant allowances, simultaneous tabs, selections and reopening passed')

  // Reactions and questions (ADR-0027): presenter-only relay over real WebSockets and storage.
  const feedbackCreated = await fetch(`${baseUrl}/sessions`, {
    method: 'POST', headers: { authorization: `Bearer ${adminSecret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ talkSlug: 'feedback-talk' }),
  }).then(response => response.json())
  const feedbackWs = `${baseUrl.replace('http:', 'ws:')}/sessions/${feedbackCreated.sessionId}`
  const feedbackPresenterUrl = `${feedbackWs}/presenter?protocol=2&token=${encodeURIComponent(feedbackCreated.presenterToken)}`
  const feedbackPresenter = await connectRecovery(feedbackPresenterUrl)
  const phoneOne = await connectRecovery(`${feedbackWs}/audience?protocol=2&participantId=participant-phone-one`)
  const phoneTwo = await connectRecovery(`${feedbackWs}/audience?protocol=2&participantId=participant-phone-two`)
  const venue = await connectRecovery(`${feedbackWs}/audience?protocol=2&participantId=participant-venue&kind=screen`)
  const legacyPhone = await openSocket(`${feedbackWs}/audience`)
  sockets.push(legacyPhone)
  const legacyMessages = []
  legacyPhone.addEventListener('message', event => legacyMessages.push(JSON.parse(String(event.data))))
  // Everything any audience socket receives from here on is recorded, to prove nothing leaks.
  const audienceSeen = new Map()
  for (const [name, client] of [['phoneOne', phoneOne], ['phoneTwo', phoneTwo], ['venue', venue]]) {
    audienceSeen.set(name, [])
    client.socket.addEventListener('message', event => audienceSeen.get(name).push(JSON.parse(String(event.data))))
  }
  const react = (client, submissionId, body) => {
    client.send({ type: 'reaction.send', submissionId, slideId: 'slide-7', tMs: 70_000, ...body })
    return client.wait('reaction.ack', m => m.submissionId === submissionId)
  }
  const nextCounts = () => feedbackPresenter.wait('reaction.counts')

  let counts = nextCounts()
  assert.deepEqual(await react(phoneOne, 'reaction-int-1', { reaction: 'puzzled' }),
    { type: 'reaction.ack', submissionId: 'reaction-int-1', status: 'confirmed' })
  assert.deepEqual((await counts).counts, { puzzled: 1 })
  counts = nextCounts()
  await react(phoneOne, 'reaction-int-2', { reaction: 'bookmark' })
  assert.deepEqual((await counts).counts, { puzzled: 1, bookmark: 1 })
  counts = nextCounts()
  await react(phoneOne, 'reaction-int-3', { reaction: 'helped' })
  const replaced = await counts
  assert.deepEqual(replaced.counts, { helped: 1, bookmark: 1 }, 'a new meaning reaction replaces the previous one; the bookmark stays')
  assert.deepEqual(replaced.records.map(r => [r.reaction, r.withdrawn === true]), [['puzzled', true], ['helped', false]])
  counts = nextCounts()
  await react(phoneTwo, 'reaction-int-1', { reaction: 'custom:Too fast' })
  assert.deepEqual((await counts).counts, { helped: 1, bookmark: 1, 'custom:Too fast': 1 })
  counts = nextCounts()
  await react(phoneOne, 'reaction-int-4', { reaction: 'helped', withdrawn: true })
  assert.deepEqual((await counts).counts, { bookmark: 1, 'custom:Too fast': 1 }, 'withdrawal nets out')
  assert.deepEqual(await react(phoneTwo, 'reaction-int-bad', { reaction: 'wow' }),
    { type: 'reaction.ack', submissionId: 'reaction-int-bad', status: 'rejected', error: 'unknown_reaction' })

  phoneTwo.send({ type: 'question.submit', submissionId: 'question-int-1', text: '  <img src=x onerror=alert(1)> Why? ', name: ' Priya ', slideId: 'slide-7', tMs: 71_000 })
  assert.deepEqual(await phoneTwo.wait('question.ack'), { type: 'question.ack', submissionId: 'question-int-1', status: 'confirmed' })
  const questionsState = await feedbackPresenter.wait('questions.state')
  assert.equal(questionsState.questions.length, 1)
  assert.equal(questionsState.questions[0].text, '<img src=x onerror=alert(1)> Why?', 'question text is kept as text, trimmed')
  assert.equal(questionsState.questions[0].name, 'Priya')

  // Pause: meaning reactions and questions refused, bookmarks accepted, every following device told.
  await operation(feedbackPresenter, 'operation-int-pause', { type: 'switches.set', questionsAllowed: false, reactionsAllowed: false })
  assert.deepEqual(await phoneOne.wait('switches.state'), { type: 'switches.state', questionsAllowed: false, reactionsAllowed: false })
  assert.equal((await react(phoneOne, 'reaction-int-paused', { reaction: 'puzzled' })).error, 'reactions_paused')
  // A bookmark during the pause is stored, but its count reaches the presenter only when reactions resume.
  const presenterCountsSeen = []
  feedbackPresenter.socket.addEventListener('message', event => {
    const m = JSON.parse(String(event.data))
    if (m.type === 'reaction.counts') presenterCountsSeen.push(m)
  })
  assert.equal((await react(phoneTwo, 'reaction-int-bookmark-paused', { reaction: 'bookmark' })).status, 'confirmed')
  phoneOne.send({ type: 'question.submit', submissionId: 'question-int-paused', text: 'Paused?', slideId: 'slide-7', tMs: 72_000 })
  assert.equal((await phoneOne.wait('question.ack')).error, 'questions_paused')
  assert.deepEqual(presenterCountsSeen, [], 'no counts reach the presenter while reactions are paused')
  counts = nextCounts()
  await operation(feedbackPresenter, 'operation-int-resume', { type: 'switches.set', questionsAllowed: true, reactionsAllowed: true })
  const caughtUp = await counts
  assert.deepEqual(caughtUp.counts, { bookmark: 2, 'custom:Too fast': 1 }, 'resuming pushes the current counts')
  assert.deepEqual(caughtUp.records.map(r => r.reaction), ['bookmark'], 'with the bookmark stored during the pause')
  await phoneOne.wait('switches.state', m => m.reactionsAllowed)
  await operation(feedbackPresenter, 'operation-int-answer', { type: 'question.answer', questionId: 'question-1' })
  assert.equal((await feedbackPresenter.wait('questions.state')).questions[0].answered, true)

  // An audience device reconnects and resends its queued messages: acknowledged once, counted once.
  await phoneOne.disconnect()
  const phoneOneBack = await connectRecovery(`${feedbackWs}/audience?protocol=2&participantId=participant-phone-one`)
  assert.deepEqual(await react(phoneOneBack, 'reaction-int-3', { reaction: 'helped' }),
    { type: 'reaction.ack', submissionId: 'reaction-int-3', status: 'confirmed' })
  // The presenter reconnects and recovers counts, questions and reaction records.
  await feedbackPresenter.disconnect()
  const feedbackPresenterBack = await connectRecovery(feedbackPresenterUrl)
  const feedbackRecovered = await sync(feedbackPresenterBack, 'sync-feedback-recovered')
  assert.deepEqual(feedbackRecovered.reactionCounts, { 'slide-7': { bookmark: 2, 'custom:Too fast': 1 } }, 'retry never counts twice')
  assert.equal(feedbackRecovered.questions.length, 1)
  assert.equal(feedbackRecovered.questions[0].answered, true)
  assert.deepEqual(feedbackRecovered.switches, { questionsAllowed: true, reactionsAllowed: true })
  assert.equal(feedbackRecovered.reactionRecords.length, 7)
  const phoneSnapshot = await sync(phoneOneBack, 'sync-feedback-phone')
  assert.deepEqual(phoneSnapshot.switches, { questionsAllowed: true, reactionsAllowed: true })
  assert.equal(phoneSnapshot.reactionCounts, undefined)
  assert.equal(phoneSnapshot.questions, undefined)

  const leaked = [...audienceSeen.values(), legacyMessages].flat()
    .filter(m => ['reaction.counts', 'questions.state'].includes(m.type) || JSON.stringify(m).includes('Priya'))
  assert.deepEqual(leaked, [], 'no audience socket receives counts or questions')
  assert.deepEqual(audienceSeen.get('venue').map(m => m.type).filter(t => t !== 'session.presence'),
    ['switches.state', 'switches.state'], 'the venue screen hears only the pause switches')
  assert.equal(legacyMessages.some(m => m.type === 'switches.state'), false)
  legacyPhone.send(JSON.stringify({ type: 'reaction.send', reaction: 'puzzled', slideId: 'slide-7', tMs: 1 }))
  const legacyError = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for legacy error')), 5000)
    legacyPhone.addEventListener('message', event => {
      const m = JSON.parse(String(event.data))
      if (m.type === 'protocol.error') { clearTimeout(timer); resolve(m) }
    })
  })
  assert.deepEqual(legacyError, { type: 'protocol.error', code: 'invalid_or_inert_message' })
  console.log('live-worker reactions and questions: presenter-only counts and questions, replace/withdraw/bookmark, bad input reasons, pause switches with bookmarks, answered marks, idempotent retry and presenter recovery passed')

  // Feedback boards (ADR-0032 amendment point 1): cards from three phones, presenter operations,
  // the big-screen view derived in the worker, and nothing private on any audience socket.
  const boardCreated = await fetch(`${baseUrl}/sessions`, {
    method: 'POST', headers: { authorization: `Bearer ${adminSecret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ talkSlug: 'board-talk' }),
  }).then(response => response.json())
  const boardWs = `${baseUrl.replace('http:', 'ws:')}/sessions/${boardCreated.sessionId}`
  const boardPresenterUrl = `${boardWs}/presenter?protocol=2&token=${encodeURIComponent(boardCreated.presenterToken)}`
  const boardPhoneUrl = name => `${boardWs}/audience?protocol=2&participantId=participant-board-${name}`
  let boardPresenter = await connectRecovery(boardPresenterUrl)
  const phones = { ann: await connectRecovery(boardPhoneUrl('ann')), ben: await connectRecovery(boardPhoneUrl('ben')), cat: await connectRecovery(boardPhoneUrl('cat')) }
  const boardVenue = await connectRecovery(`${boardWs}/audience?protocol=2&participantId=participant-board-venue&kind=screen`)
  const boardSeen = new Map()
  const record = (name, client) => {
    boardSeen.set(name, boardSeen.get(name) ?? [])
    client.socket.addEventListener('message', event => boardSeen.get(name).push(JSON.parse(String(event.data))))
  }
  for (const [name, client] of Object.entries(phones)) record(name, client)
  record('venue', boardVenue)
  const boardPollId = 'poll-slide-board'
  const boardDefinition = { pollId: boardPollId, slideId: 'slide-board', type: 'board', question: 'What should we keep, change, try?', visibility: 'live',
    options: [{ optionId: 'keep', label: 'Keep' }, { optionId: 'change', label: 'Change' }, { optionId: 'try', label: 'Try' }],
    board: { limit: 12, cardsPerPhone: 5, cardChars: 140, names: true, instructions: 'One idea per card.' } }
  await operation(boardPresenter, 'operation-board-open', { type: 'poll.open', poll: boardDefinition })
  const boardOpened = await phones.ann.wait('poll.state', m => m.pollId === boardPollId)
  assert.deepEqual(boardOpened.board, { limit: 12, cardChars: 140, cardsPerPhone: 5, names: true, closesAfterDays: 7, instructions: 'One idea per card.' })
  assert.equal(boardOpened.boardState.cardCount, 0)
  const boardState = (client, predicate) => client.wait('poll.state', m => m.pollId === boardPollId && predicate(m.boardState)).then(m => m.boardState)
  let cardSequence = 0
  async function sendCard(name, column, text, extra = {}) {
    const submissionId = extra.submissionId ?? `submission-board-${++cardSequence}`
    phones[name].send({ type: 'card.add', submissionId, pollId: boardPollId, column, text, ...extra })
    return phones[name].wait('card.ack', m => m.submissionId === submissionId)
  }
  // Each phone sends cards; the first reaches the presenter and the room at once.
  const annFirst = await sendCard('ann', 'keep', ' More time for hands-on ', { name: 'Ann Private' })
  assert.deepEqual(annFirst, { type: 'card.ack', submissionId: 'submission-board-1', pollId: boardPollId, status: 'confirmed', cardId: 'card-1', cardsUsed: 1 })
  const presenterFirst = await boardState(boardPresenter, b => b.cardCount === 1)
  assert.equal(presenterFirst.cards[0].name, 'Ann Private', 'the presenter sees a typed name')
  await boardState(boardVenue, b => b.cardCount === 1)
  const texts = { ann: ['Live demo', 'Small tables', 'Real examples', 'The handout'], ben: ['Shorter breaks', 'Less theory', 'Bigger room', 'Links first', 'Less jargon'], cat: ['Pair work', 'Follow-up session', 'Agent clinic', 'Reading list', 'Show and tell'] }
  const columnFor = { ann: 'keep', ben: 'change', cat: 'try' }
  for (let i = 0; i < 5; i++) for (const name of ['ann', 'ben', 'cat']) {
    const text = texts[name][i]
    if (!text) continue
    assert.equal((await sendCard(name, columnFor[name], text)).status, 'confirmed')
  }
  // One phone cannot use up the board: Ann's sixth card is refused, Ben's and Cat's still count.
  assert.equal((await sendCard('ann', 'keep', 'One too many')).error, 'card_limit_reached')
  assert.equal((await sendCard('ben', 'change', 'x'.repeat(141))).error, 'card_too_long')
  const full = await boardState(boardPresenter, b => b.cardCount === 15)
  assert.deepEqual([full.entries, full.shown, full.waiting], [15, 12, 3], 'limit 12: the three newest wait')
  assert.deepEqual(full.columns.map(c => c.waiting), [0, 1, 2])
  // A retry after a reconnect repeats the receipt and adds nothing.
  await phones.ann.disconnect()
  phones.ann = await connectRecovery(boardPhoneUrl('ann'))
  record('ann', phones.ann)
  phones.ann.send({ type: 'card.add', submissionId: 'submission-board-1', pollId: boardPollId, column: 'keep', text: ' More time for hands-on ', name: 'Ann Private' })
  assert.deepEqual(await phones.ann.wait('card.ack'), annFirst)
  const annSnapshot = await sync(phones.ann, 'sync-board-ann')
  // Arrival order: Ann's first card, then Ann, Ben, Cat in turn (Ann had four more, Ben and Cat five).
  const own = { ann: ['card-1', 'card-2', 'card-5', 'card-8', 'card-11'], ben: ['card-3', 'card-6', 'card-9', 'card-12', 'card-14'], cat: ['card-4', 'card-7', 'card-10', 'card-13', 'card-15'] }
  assert.deepEqual(annSnapshot.myCards.map(c => c.cardId), own.ann)
  assert.equal(annSnapshot.polls.find(p => p.pollId === boardPollId).boardState.cardCount, 15)

  // Merge, split, hide, freeze, limit and release: each acknowledged once, even when resent.
  const ack = (operationId, action) => operation(boardPresenter, operationId, { pollId: boardPollId, ...action })
  await ack('operation-board-merge-1', { type: 'board.merge', source: { cardId: 'card-2' }, target: { cardId: 'card-1' } })
  await ack('operation-board-merge-2', { type: 'board.merge', source: { cardId: 'card-5' }, target: { cardId: 'card-1' } })
  await ack('operation-board-merge-1', { type: 'board.merge', source: { cardId: 'card-2' }, target: { cardId: 'card-1' } })
  let presenterBoard = await boardState(boardPresenter, b => b.groups.length === 1 && b.groups[0].count === 3)
  assert.deepEqual(presenterBoard.groups, [{ n: 1, column: 'keep', cardIds: ['card-1', 'card-2', 'card-5'], count: 3 }])
  // Ann can no longer edit a card that is in a group; she can still edit or withdraw one that is not.
  phones.ann.send({ type: 'card.edit', submissionId: 'submission-board-edit-1', pollId: boardPollId, cardId: 'card-1', text: 'Changed' })
  assert.equal((await phones.ann.wait('card.ack', m => m.submissionId === 'submission-board-edit-1')).error, 'card_sorted')
  phones.ann.send({ type: 'card.edit', submissionId: 'submission-board-edit-2', pollId: boardPollId, cardId: 'card-8', text: 'Real examples from our work' })
  assert.equal((await phones.ann.wait('card.ack', m => m.submissionId === 'submission-board-edit-2')).status, 'confirmed')
  phones.ben.send({ type: 'card.withdraw', submissionId: 'submission-board-steal-1', pollId: boardPollId, cardId: 'card-11' })
  assert.equal((await phones.ben.wait('card.ack', m => m.submissionId === 'submission-board-steal-1')).error, 'card_not_found', 'another phone’s card is not yours')
  phones.ann.send({ type: 'card.withdraw', submissionId: 'submission-board-withdraw-1', pollId: boardPollId, cardId: 'card-11' })
  assert.equal((await phones.ann.wait('card.ack', m => m.submissionId === 'submission-board-withdraw-1')).status, 'confirmed')
  await ack('operation-board-split-1', { type: 'board.split', group: 1 })
  await ack('operation-board-merge-3', { type: 'board.merge', source: { cardId: 'card-6' }, target: { cardId: 'card-3' } })
  presenterBoard = await boardState(boardPresenter, b => b.groups.length === 1 && b.groups[0].n === 2)
  assert.equal(presenterBoard.cards.find(c => c.cardId === 'card-2').fromGroup, 1, 'split cards say where they came from')
  // Ticket 05 (D13): the group's own wording reaches the room; nothing presenter-only comes with it.
  await ack('operation-board-relabel-1', { type: 'board.relabel', group: 2, text: '  Shorter, lighter sessions  ' })
  await ack('operation-board-relabel-1', { type: 'board.relabel', group: 2, text: '  Shorter, lighter sessions  ' })
  const wordedPublic = await boardState(boardVenue, b => b.groups.some(g => g.n === 2 && g.label === 'Shorter, lighter sessions'))
  assert.equal(JSON.stringify(wordedPublic).match(/"(hidden|name|fromGroup|touched|participant)"/), null, 'the room gets the wording and nothing presenter-only')
  const phoneWorded = (await sync(phones.ben, 'sync-board-ben-worded')).polls.find(p => p.pollId === boardPollId).boardState
  assert.equal(phoneWorded.groups.find(g => g.n === 2).label, 'Shorter, lighter sessions', 'a phone sees the group\'s wording')
  assert.equal((await boardState(boardPresenter, b => b.groups.some(g => g.label))).groups.find(g => g.n === 2).label, 'Shorter, lighter sessions')
  boardPresenter.send({ type: 'operation', operationId: 'operation-board-relabel-long', action: { type: 'board.relabel', pollId: boardPollId, group: 2, text: 'x'.repeat(141) } })
  assert.equal((await boardPresenter.wait('operation.ack', m => m.operationId === 'operation-board-relabel-long')).error, 'card_too_long')
  await ack('operation-board-hide-1', { type: 'board.hide', target: { cardId: 'card-4' }, hidden: true })
  await ack('operation-board-move-1', { type: 'board.move', target: { cardId: 'card-7' }, column: 'change' })
  await ack('operation-board-limit-1', { type: 'board.limit', limit: 6 })
  let publicBoard = await boardState(boardVenue, b => b.limit === 6)
  assert.equal(publicBoard.cards.some(c => c.cardId === 'card-4'), false, 'a hidden card is off every public board')
  assert.equal(publicBoard.shown, 6)
  await ack('operation-board-release-1', { type: 'board.release', mode: 'next', count: 3 })
  publicBoard = await boardState(boardVenue, b => b.release.extra === 3)
  assert.equal(publicBoard.shown, 9, '“Show next” adds exactly what it released')
  await ack('operation-board-release-2', { type: 'board.release', mode: 'all' })
  publicBoard = await boardState(boardVenue, b => b.release.all)
  assert.equal(publicBoard.waiting, 0)
  await ack('operation-board-freeze-1', { type: 'board.freeze', frozen: true })
  await boardState(boardVenue, b => b.frozen)
  phones.cat.send({ type: 'card.withdraw', submissionId: 'submission-board-frozen-1', pollId: boardPollId, cardId: 'card-15' })
  assert.equal((await phones.cat.wait('card.ack', m => m.submissionId === 'submission-board-frozen-1')).error, 'board_frozen')
  boardPresenter.send({ type: 'operation', operationId: 'operation-board-merge-frozen', action: { type: 'board.merge', pollId: boardPollId, source: { cardId: 'card-10' }, target: { cardId: 'card-3' } } })
  assert.deepEqual(await boardPresenter.wait('operation.ack', m => m.operationId === 'operation-board-merge-frozen'),
    { type: 'operation.ack', operationId: 'operation-board-merge-frozen', status: 'rejected', error: 'board_frozen' })
  boardPresenter.send({ type: 'operation', operationId: 'operation-board-relabel-frozen', action: { type: 'board.relabel', pollId: boardPollId, group: 2, text: 'Frozen words' } })
  assert.equal((await boardPresenter.wait('operation.ack', m => m.operationId === 'operation-board-relabel-frozen')).error, 'board_frozen')
  // Hiding is moderation and still works on a frozen board; putting the card back too.
  await ack('operation-board-hide-frozen', { type: 'board.hide', target: { cardId: 'card-15' }, hidden: true })
  await boardState(boardVenue, b => b.frozen && !b.cards.some(c => c.cardId === 'card-15'))
  await ack('operation-board-show-frozen', { type: 'board.hide', target: { cardId: 'card-15' }, hidden: false })
  await boardState(boardVenue, b => b.cards.some(c => c.cardId === 'card-15'))

  // The presenter reconnects: the full board comes back, and a resent operation changes nothing.
  await boardPresenter.disconnect()
  boardPresenter = await connectRecovery(boardPresenterUrl)
  const boardRecovered = (await sync(boardPresenter, 'sync-board-presenter')).polls.find(p => p.pollId === boardPollId).boardState
  assert.equal(boardRecovered.frozen, true)
  assert.equal(boardRecovered.cards.find(c => c.cardId === 'card-4').hidden, true, 'the presenter keeps the hidden card')
  assert.deepEqual(boardRecovered.groups.map(g => g.n), [2])
  await ack('operation-board-merge-3', { type: 'board.merge', source: { cardId: 'card-6' }, target: { cardId: 'card-3' } })
  await ack('operation-board-freeze-2', { type: 'board.freeze', frozen: false })
  await ack('operation-board-merge-4', { type: 'board.merge', source: { cardId: 'card-9' }, target: { cardId: 'card-12' } })
  const renumbered = await boardState(boardPresenter, b => b.groups.length === 2)
  assert.deepEqual(renumbered.groups.map(g => g.n).sort(), [2, 3], 'number 1 retired with the split; the new group is 3')
  const boardFinalRecovery = await fetch(`${baseUrl}/sessions/${boardCreated.sessionId}/recovery`, {
    headers: { authorization: `Bearer ${boardCreated.presenterToken}` },
  }).then(response => response.json())
  const recoveredBoard = boardFinalRecovery.polls.find(p => p.pollId === boardPollId).boardState
  assert.deepEqual([recoveredBoard.cards.length, recoveredBoard.cardCount], [14, 13], 'the Run can read every card, the hidden one included')

  // Nothing private reached any audience socket: no hidden card, no name, no other phone's identity.
  const audienceBoards = [...boardSeen.values()].flat().filter(m => m.type === 'poll.state' && m.boardState)
  assert.ok(audienceBoards.length > 10)
  const everything = JSON.stringify([...boardSeen.values()].flat())
  for (const secret of ['Ann Private', 'participant-board', '"hidden"', '"name"', 'fromGroup', 'touched']) {
    assert.equal(everything.includes(secret), false, `audience sockets never see ${secret}`)
  }
  // The venue screen saw card 4 before it was hidden and never after (the limit changed after the hide).
  const venueBoards = boardSeen.get('venue').filter(m => m.type === 'poll.state' && m.boardState)
  assert.ok(venueBoards.some(m => m.boardState.cards.some(c => c.cardId === 'card-4')))
  const afterHide = venueBoards.slice(venueBoards.findIndex(m => m.boardState.limit === 6))
  assert.equal(afterHide.some(m => m.boardState.cards.some(c => c.cardId === 'card-4')), false, 'once hidden, a card never reappears to the room')
  // Receipts and snapshots name only the phone's own cards.
  const benAcks = boardSeen.get('ben').filter(m => m.type === 'card.ack' && m.cardId)
  assert.equal(benAcks.every(m => own.ben.includes(m.cardId)), true)
  const benSnapshot = await sync(phones.ben, 'sync-board-ben')
  assert.deepEqual(benSnapshot.myCards.map(c => c.cardId), own.ben)
  const catSnapshot = await sync(phones.cat, 'sync-board-cat')
  assert.deepEqual(catSnapshot.myCards.map(c => c.cardId), own.cat.filter(id => id !== 'card-4'), 'a hidden own card leaves the phone silently')
  assert.deepEqual(catSnapshot.myBoards, [{ pollId: boardPollId, cardsUsed: 5, cardsPerPhone: 5 }], 'the hidden card still counts, so Cat’s box stays closed')
  console.log('live-worker boards: cards from three phones, per-phone limit, idempotent retry after reconnect, own-card edit and withdraw, merge/split with retired numbers, hide, move, limit, release, freeze, presenter recovery, and no hidden card, name or identity on any audience socket passed')

  console.log('live-worker integration: v1 slide/poll/moderation compatibility; explicit close; v2 same-session reconnect, voting during absence, private snapshots, vote/operation acknowledgement replay, cursor deduplication, closed-poll reveal; immutable legacy answers; raw bypass rejection; authenticated final-answer recovery and explicit end passed')

} finally {
  for (const socket of sockets) try { socket.close() } catch {}
  await stop()
}
