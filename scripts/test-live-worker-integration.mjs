import assert from 'node:assert/strict'
import { createHmac, randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => error ? reject(error) : resolvePort(port))
    })
  })
}

async function waitForWorker(baseUrl, output) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try { await fetch(baseUrl); return } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 150))
  }
  throw new Error(`wrangler dev did not start\n${output().slice(-4000)}`)
}

function nextMessage(socket, timeoutMs = 5000) {
  return new Promise((resolveMessage, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for WebSocket message')), timeoutMs)
    socket.addEventListener('message', (event) => {
      clearTimeout(timer)
      resolveMessage(JSON.parse(String(event.data)))
    }, { once: true })
  })
}

function nextMessages(socket, count, timeoutMs = 5000) {
  return new Promise((resolveMessages, reject) => {
    const messages = []
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${count} WebSocket messages`)), timeoutMs)
    const onMessage = (event) => {
      messages.push(JSON.parse(String(event.data)))
      if (messages.length < count) return
      clearTimeout(timer)
      socket.removeEventListener('message', onMessage)
      resolveMessages(messages)
    }
    socket.addEventListener('message', onMessage)
  })
}

function openSocket(url, timeoutMs = 5000) {
  return new Promise((resolveSocket, reject) => {
    const socket = new WebSocket(url)
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error(`Timed out opening WebSocket: ${url}`))
    }, timeoutMs)
    socket.addEventListener('open', () => {
      clearTimeout(timer)
      resolveSocket(socket)
    }, { once: true })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error(`WebSocket failed: ${url}`))
    }, { once: true })
  })
}

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

const root = resolve(import.meta.dirname, '..')
const scratch = await mkdtemp(join(tmpdir(), 'talkweaver-live-worker-'))
const port = await freePort()
const baseUrl = `http://127.0.0.1:${port}`
const adminSecret = randomBytes(24).toString('hex')
const signingSecret = randomBytes(24).toString('hex')
let output = ''
const child = spawn('wrangler', [
  'dev', '--config', join(root, 'worker/wrangler.jsonc'), '--ip', '127.0.0.1', '--port', String(port),
  '--var', `ADMIN_SECRET:${adminSecret}`, '--var', `SESSION_SIGNING_SECRET:${signingSecret}`,
  '--persist-to', join(scratch, 'state'), '--show-interactive-dev-session=false', '--log-level=error',
], {
  cwd: root,
  env: { ...process.env, WRANGLER_LOG_PATH: join(scratch, 'wrangler.log') },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.on('data', (chunk) => { output += String(chunk) })
child.stderr.on('data', (chunk) => { output += String(chunk) })

const sockets = []
try {
  await waitForWorker(baseUrl, () => output)
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
  const [, secondAudienceQuickState] = await nextMessages(secondAudience, 2)
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
    protocol: 2, build: '7-integrated-polls',
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

  console.log('live-worker integration: v1 slide/poll/moderation compatibility; explicit close; v2 same-session reconnect, voting during absence, private snapshots, vote/operation acknowledgement replay, cursor deduplication, closed-poll reveal; immutable legacy answers; raw bypass rejection; authenticated final-answer recovery and explicit end passed')

} finally {
  for (const socket of sockets) try { socket.close() } catch {}
  child.kill('SIGTERM')
  await new Promise((resolveExit) => {
    if (child.exitCode !== null) return resolveExit()
    child.once('exit', resolveExit)
    setTimeout(() => { child.kill('SIGKILL'); resolveExit() }, 2000).unref()
  })
  await rm(scratch, { recursive: true, force: true })
}
