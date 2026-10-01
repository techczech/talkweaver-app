// Feedback-boards ticket 06 against a real live Worker (`wrangler dev`: local, throwaway secrets and
// state, nothing deployed).
//
// The share route (a Run's read-only link):
//   - only the admin creates a link; nothing shows until the first push; only the link's own owner
//     token pushes (a shared talk's owner token and the admin secret do not);
//   - the page is read-only: every other method is refused, a credential on it is refused, and it
//     carries no script, a strict CSP and escaped text; a push carrying a hidden card or a name is refused;
//   - expiry: a link pushed with a short lifetime answers 410 once it has passed (page and JSON), and
//     a push with a lifetime over 31 days is refused;
//   - revocation: Stop sharing needs the owner token (or the admin secret) and the link answers 410 after.
// A board left open after End live:
//   - End live with keepBoardsOpen closes the session for the presenter and following phones, but a
//     phone that joins later still reaches the board and adds a late card; the join link still
//     resolves; nothing else (a vote) is taken;
//   - the presenter's recovery reads the late card and when the board closes;
//   - "Close it now" needs the presenter token (checked as issued) and then the board refuses cards,
//     the join link stops resolving and no phone can join.
// A plain End live leaves nothing open.
// Usage: node scripts/test-run-boards-worker-integration.mjs
import assert from 'node:assert/strict'
import { startLiveWorker } from './lib/live-worker-harness.mjs'

async function openRecoverySocket(url) {
  const socket = new WebSocket(url)
  const messages = []
  const waiting = []
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    const index = waiting.findIndex((item) => item.matches(message))
    if (index < 0) messages.push(message)
    else {
      const [item] = waiting.splice(index, 1)
      clearTimeout(item.timer)
      item.resolve(message)
    }
  })
  const inbox = {
    socket,
    send: (message) => socket.send(JSON.stringify(message)),
    wait(type, predicate = () => true) {
      const matches = (message) => message.type === type && predicate(message)
      const index = messages.findIndex(matches)
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0])
      return new Promise((resolve, reject) => {
        const item = { matches, resolve, timer: null }
        item.timer = setTimeout(() => {
          waiting.splice(waiting.indexOf(item), 1)
          reject(new Error(`Timed out waiting for ${type}; queued: ${messages.map((m) => m.type).join(', ')}`))
        }, 5000)
        waiting.push(item)
      })
    },
    closed: new Promise((resolve) => socket.addEventListener('close', resolve, { once: true })),
  }
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out opening socket')), 5000)
    socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`Socket failed: ${url}`)) }, { once: true })
  })
  assert.equal((await inbox.wait('session.hello')).protocol, 2)
  return inbox
}

const DAY = 86_400_000
/** True when the Worker refuses the WebSocket upgrade (the socket errors or closes without opening). */
function socketRefused(url) {
  return new Promise((resolve) => {
    const socket = new WebSocket(url)
    const timer = setTimeout(() => { socket.close(); resolve(false) }, 5000)
    socket.addEventListener('open', () => { clearTimeout(timer); socket.close(); resolve(false) }, { once: true })
    socket.addEventListener('error', () => { clearTimeout(timer); resolve(true) }, { once: true })
  })
}
const { baseUrl, adminSecret, stop } = await startLiveWorker()
const sockets = []
const results = []
const pass = (name) => { results.push(name); console.log(`PASS  ${name}`) }
try {
  const admin = { authorization: `Bearer ${adminSecret}` }
  const json = { 'content-type': 'application/json' }

  // ── The share route ─────────────────────────────────────────────────────────────────────────
  assert.equal((await fetch(`${baseUrl}/results`, { method: 'POST' })).status, 401, 'creating a link needs the admin secret')
  const createLink = async () => {
    const response = await fetch(`${baseUrl}/results`, { method: 'POST', headers: { ...admin, ...json }, body: '{}' })
    assert.equal(response.status, 201)
    return response.json()
  }
  const link = await createLink()
  assert.match(link.shareId, /^[a-z0-9]{8}$/)
  const page = `${baseUrl}/results/${link.shareId}`
  assert.equal((await fetch(page)).status, 404, 'nothing shows before the first push')
  pass('only the admin creates a link; nothing shows before the first push')

  const hostile = '<script>alert(1)</script>'
  const content = (extra = {}) => ({
    expiresAt: Date.now() + 30 * DAY, title: 'The current state of AI agents', subtitle: `Mon 28 Sep 2026 · ${hostile}`,
    boards: [{ question: 'What should we keep, change, try?', cardCount: 3, state: 'final', when: '28 Sep 2026', columns: [
      { label: 'Keep', count: 2, entries: [{ n: 1, text: 'More time for hands-on', count: 2 }] },
      { label: 'Try', count: 1, entries: [{ text: hostile }] },
    ] }],
    polls: [{ kind: 'bars', question: 'Which tools?', people: 3, rows: [{ label: 'ChatGPT', count: 2 }, { label: 'Claude', count: 1 }] }],
    ...extra,
  })
  const push = (body, token = link.ownerToken, shareId = link.shareId) => fetch(`${baseUrl}/results/${shareId}/content`, {
    method: 'PUT', headers: { ...json, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
  assert.equal((await push(content(), null)).status, 401, 'a push without the owner token is refused')
  assert.equal((await push(content(), adminSecret)).status, 401, 'the admin secret is not an owner token')
  const talkShare = await (await fetch(`${baseUrl}/shares`, { method: 'POST', headers: { ...admin, ...json },
    body: JSON.stringify({ talkSlug: 'results-talk', title: 'T' }) })).json()
  assert.equal((await push(content(), talkShare.ownerToken)).status, 401, 'a shared talk\'s owner token cannot push a Run link')
  const withHidden = content({ boards: [{ ...content().boards[0], columns: [{ label: 'Keep', count: 1, entries: [{ text: 'x', hidden: true }] }] }] })
  assert.equal((await push(withHidden)).status, 400, 'a push carrying a hidden card is refused')
  const withName = content({ boards: [{ ...content().boards[0], columns: [{ label: 'Keep', count: 1, entries: [{ text: 'x', name: 'Sam' }] }] }] })
  assert.equal((await push(withName)).status, 400, 'a push carrying a name is refused')
  assert.equal((await push(content({ expiresAt: Date.now() + 40 * DAY }))).status, 400, 'a lifetime over 31 days is refused')
  const pushed = await push(content())
  assert.equal(pushed.status, 200)
  pass('only the link\'s own owner token pushes; hidden cards, names and over-long lifetimes are refused')

  const served = await fetch(page)
  assert.equal(served.status, 200)
  const html = await served.text()
  assert.match(served.headers.get('content-security-policy'), /default-src 'none'/)
  assert.equal(served.headers.get('cache-control'), 'no-store')
  assert.ok(html.includes('More time for hands-on') && html.includes('×2') && html.includes('Final board · 28 Sep 2026'))
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'card text is escaped')
  assert.equal(/<script/i.test(html), false, 'the page carries no script')
  assert.equal(/<form/i.test(html), false, 'the page carries no form')
  assert.ok(html.includes('No names were collected.'))
  assert.equal((await fetch(`${page}/results.json`)).status, 404, 'there is no JSON route')
  const unknown = await fetch(`${baseUrl}/results/zzzz9999`)
  const notPushed = await fetch(`${baseUrl}/results/${(await createLink()).shareId}`)
  assert.equal(unknown.status, 404)
  assert.equal(notPushed.status, 404)
  assert.equal(await unknown.text(), await notPushed.text(), 'an unknown link and one not pushed yet answer the same')
  assert.equal((await fetch(page, { headers: { authorization: `Bearer ${link.ownerToken}` } })).status, 400, 'the page takes no credential')
  assert.equal((await fetch(`${page}?token=x`)).status, 400)
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) assert.equal((await fetch(page, { method })).status, 405, `${method} on the page is refused`)
  assert.equal((await fetch(`${page}/content`)).status, 405, 'the content route is not readable')
  assert.equal((await fetch(`${page}/items`, { method: 'POST' })).status, 404, 'there is nowhere to post')
  pass('the page is read-only, escaped, script-free, and takes no credential')

  // Expiry: a short lifetime (the Worker accepts any time up to 31 days; the app sends 7 or 30).
  const shortLink = await createLink()
  assert.equal((await push(content({ expiresAt: Date.now() + 2_500 }), shortLink.ownerToken, shortLink.shareId)).status, 200)
  assert.equal((await fetch(`${baseUrl}/results/${shortLink.shareId}`)).status, 200)
  await new Promise((resolve) => setTimeout(resolve, 3_500))
  const expired = await fetch(`${baseUrl}/results/${shortLink.shareId}`)
  assert.equal(expired.status, 410)
  assert.match(await expired.text(), /expired/)
  assert.equal((await push(content(), shortLink.ownerToken, shortLink.shareId)).status, 410, 'an expired link cannot be revived by a push')
  pass('a link answers 410 once its lifetime has passed')

  // Revocation.
  assert.equal((await fetch(`${page}/close`, { method: 'POST' })).status, 401, 'stopping needs the owner token')
  assert.equal((await fetch(`${page}/close`, { method: 'POST', headers: { authorization: `Bearer ${talkShare.ownerToken}` } })).status, 401)
  assert.equal((await fetch(`${page}/close`, { method: 'POST', headers: { authorization: `Bearer ${link.ownerToken}` } })).status, 200)
  const stopped = await fetch(page)
  assert.equal(stopped.status, 410)
  assert.match(await stopped.text(), /stopped sharing/)
  assert.equal((await push(content())).status, 410, 'a stopped link cannot be pushed again')
  const adminStop = await createLink()
  await push(content(), adminStop.ownerToken, adminStop.shareId)
  assert.equal((await fetch(`${baseUrl}/results/${adminStop.shareId}/close`, { method: 'POST', headers: admin })).status, 200, 'the admin secret can stop a link')
  assert.equal((await fetch(`${baseUrl}/results/${adminStop.shareId}`)).status, 410)
  pass('Stop sharing revokes the link: 410 from then on')

  // ── A board left open after End live ──────────────────────────────────────────────────────
  const startSession = async (talkSlug) => {
    const created = await (await fetch(`${baseUrl}/sessions`, { method: 'POST', headers: { ...admin, ...json }, body: JSON.stringify({ talkSlug }) })).json()
    const ws = `${baseUrl.replace('http:', 'ws:')}/sessions/${created.sessionId}`
    return { ...created, ws, presenterUrl: `${ws}/presenter?protocol=2&token=${encodeURIComponent(created.presenterToken)}`,
      phoneUrl: (name) => `${ws}/audience?protocol=2&participantId=participant-late-${name}` }
  }
  const connect = async (url) => { const client = await openRecoverySocket(url); sockets.push(client.socket); return client }
  const operation = async (client, operationId, action) => {
    client.send({ type: 'operation', operationId, action })
    assert.equal((await client.wait('operation.ack', (m) => m.operationId === operationId)).status, 'confirmed')
  }
  const addCard = async (phone, submissionId, text, column = 'keep', pollId = 'poll-late') => {
    phone.send({ type: 'card.add', submissionId, pollId, column, text })
    return phone.wait('card.ack', (m) => m.submissionId === submissionId)
  }
  const boardDefinition = { pollId: 'poll-late', slideId: 'slide-44', type: 'board', question: 'What should we keep, change, try?', visibility: 'live',
    options: [{ optionId: 'keep', label: 'Keep' }, { optionId: 'try', label: 'Try' }], board: { closesAfterDays: 1 } }

  const session = await startSession('late-board-talk')
  const presenter = await connect(session.presenterUrl)
  await operation(presenter, 'operation-open', { type: 'poll.open', poll: boardDefinition })
  const ann = await connect(session.phoneUrl('ann'))
  assert.equal((await addCard(ann, 'sub-ann-1', 'More time for hands-on')).status, 'confirmed')
  const before = Date.now()
  const ended = await fetch(`${baseUrl}/sessions/${session.sessionId}/close`, { method: 'POST',
    headers: { authorization: `Bearer ${session.presenterToken}`, ...json }, body: JSON.stringify({ keepBoardsOpen: true }) })
  assert.equal(ended.status, 200)
  const endBody = await ended.json()
  assert.ok(endBody.lateBoards['poll-late'] >= before + DAY && endBody.lateBoards['poll-late'] <= Date.now() + DAY, 'the board closes a day after the end (its setting)')
  assert.equal((await presenter.wait('session.closed')).reason, 'ended')
  assert.equal((await ann.wait('session.closed')).reason, 'ended', 'phones following the talk stop following')
  await ann.closed
  pass('End live keeping the board open closes the session for the presenter and following phones')

  const discovery = await (await fetch(`${baseUrl}/session/late-board-talk`)).json()
  assert.deepEqual(discovery, { live: true, sessionId: session.sessionId }, 'the join link still resolves while the board is open')
  const ben = await connect(session.phoneUrl('ben'))
  ben.send({ type: 'session.sync', syncId: 'sync-late' })
  const snapshot = await ben.wait('session.snapshot')
  assert.equal(snapshot.slideState, null, 'nothing to follow')
  assert.deepEqual(snapshot.polls.map((p) => [p.pollId, p.open]), [['poll-late', true]])
  assert.equal(snapshot.polls[0].boardState.cardCount, 1)
  const late = await addCard(ben, 'sub-ben-1', 'Recording of the demo, please', 'try')
  assert.equal(late.status, 'confirmed', 'a late card lands')
  ben.send({ type: 'vote.submit', submissionId: 'sub-vote', pollId: 'poll-late', choice: 'keep' })
  assert.equal((await ben.wait('protocol.error')).code, 'session_not_live', 'nothing but cards is taken after the end')
  assert.equal(await socketRefused(`${session.ws}/audience`), true, 'an old phone (protocol 1) cannot join a board left open')
  pass('a phone that joins after the end sees only the board and adds a late card; nothing else is taken')

  const recovery = await (await fetch(`${baseUrl}/sessions/${session.sessionId}/recovery`, { headers: { authorization: `Bearer ${session.presenterToken}` } })).json()
  const board = recovery.polls.find((p) => p.pollId === 'poll-late')
  assert.deepEqual(board.boardState.cards.map((c) => c.text), ['More time for hands-on', 'Recording of the demo, please'])
  assert.ok(board.boardState.cards[1].acceptedAt > before, 'the late card was accepted after the end')
  assert.deepEqual(Object.keys(recovery.lateBoards), ['poll-late'])
  assert.ok(recovery.endedAt >= before)
  const status = await (await fetch(`${baseUrl}/sessions/${session.sessionId}/status`, { headers: { authorization: `Bearer ${session.presenterToken}` } })).json()
  assert.equal(status.status, 'ended')
  assert.deepEqual(Object.keys(status.lateBoards), ['poll-late'])
  pass('the presenter\'s recovery reads the late card and when the board closes')

  assert.equal((await fetch(`${baseUrl}/sessions/${session.sessionId}/close`, { method: 'POST' })).status, 401, 'Close it now needs the presenter token')
  assert.equal((await fetch(`${baseUrl}/sessions/${session.sessionId}/close`, { method: 'POST', headers: { authorization: 'Bearer forged.token' } })).status, 401)
  const closedNow = await fetch(`${baseUrl}/sessions/${session.sessionId}/close`, { method: 'POST', headers: { authorization: `Bearer ${session.presenterToken}` } })
  assert.equal(closedNow.status, 200)
  assert.equal((await ben.wait('poll.state', (m) => m.pollId === 'poll-late' && !m.open)).open, false, 'the phone hears the board closed')
  assert.equal((await ben.wait('session.closed')).reason, 'ended')
  assert.deepEqual(await (await fetch(`${baseUrl}/session/late-board-talk`)).json(), { live: false }, 'the join link stops resolving')
  assert.equal(await socketRefused(session.phoneUrl('cat')), true, 'no phone can join a closed board')
  const after = await (await fetch(`${baseUrl}/sessions/${session.sessionId}/recovery`, { headers: { authorization: `Bearer ${session.presenterToken}` } })).json()
  assert.equal('lateBoards' in after, false, 'no board is left open')
  assert.equal(after.polls.find((p) => p.pollId === 'poll-late').boardState.cards.length, 2, 'every card is kept for the Run')
  pass('Close it now: the board refuses cards, the join link stops resolving, the cards are kept')

  // A new live session on the same talk takes the join link: the board left open by the earlier one closes, saying why.
  const first = await startSession('handover-talk')
  const firstPresenter = await connect(first.presenterUrl)
  await operation(firstPresenter, 'operation-open-handover', { type: 'poll.open', poll: { ...boardDefinition, pollId: 'poll-handover' } })
  const keptFirst = await fetch(`${baseUrl}/sessions/${first.sessionId}/close`, { method: 'POST',
    headers: { authorization: `Bearer ${first.presenterToken}`, ...json }, body: JSON.stringify({ keepBoardsOpen: true }) })
  assert.deepEqual(Object.keys((await keptFirst.json()).lateBoards), ['poll-handover'])
  const latePhone = await connect(first.phoneUrl('fay'))
  const second = await startSession('handover-talk')
  assert.deepEqual(await (await fetch(`${baseUrl}/session/handover-talk`)).json(), { live: true, sessionId: second.sessionId }, 'the join link reaches the new session')
  assert.equal((await latePhone.wait('poll.state', (m) => m.pollId === 'poll-handover' && !m.open)).open, false, 'the late phone hears the board closed')
  const handedOver = await (await fetch(`${baseUrl}/sessions/${first.sessionId}/recovery`, { headers: { authorization: `Bearer ${first.presenterToken}` } })).json()
  assert.equal('lateBoards' in handedOver, false, 'nothing is left open on the earlier session')
  assert.equal(handedOver.closedBoards['poll-handover'].reason, 'superseded')
  assert.equal(await socketRefused(first.phoneUrl('gus')), true, 'no phone can join the earlier session')
  pass('a new live session on the same talk closes the board left open by the earlier one (reason: superseded)')

  // A plain End live leaves nothing open.
  const plain = await startSession('plain-board-talk')
  const plainPresenter = await connect(plain.presenterUrl)
  await operation(plainPresenter, 'operation-open-plain', { type: 'poll.open', poll: { ...boardDefinition, pollId: 'poll-plain' } })
  const plainEnd = await fetch(`${baseUrl}/sessions/${plain.sessionId}/close`, { method: 'POST', headers: { authorization: `Bearer ${plain.presenterToken}` } })
  assert.deepEqual((await plainEnd.json()).lateBoards, {})
  assert.deepEqual(await (await fetch(`${baseUrl}/session/plain-board-talk`)).json(), { live: false })
  assert.equal(await socketRefused(plain.phoneUrl('dan')), true, 'no phone can join after a plain end')
  pass('a plain End live leaves no board open')

  console.log(`\nrun boards worker integration: ${results.length} checks passed`)
} finally {
  for (const socket of sockets) { try { socket.close() } catch {} }
  await stop()
}
