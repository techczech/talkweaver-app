// Route tests for the SharedTalk object against `wrangler dev`: create, push with the revision
// rule, page and talk.json, idempotent items of every kind, status patches, both sockets with
// since-replay, credential separation, and Stop sharing.
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { nextMessage, nextMessages, openSocket, startLiveWorker } from './lib/live-worker-harness.mjs'

const { baseUrl, wsUrl, adminSecret, stop } = await startLiveWorker()
const sockets = []

async function call(path, { method = 'GET', token, body, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
  const text = await response.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: response.status, text, json, headers: response.headers }
}

async function socketRefused(url) {
  try {
    const socket = await openSocket(url, 3000)
    socket.close()
    return false
  } catch {
    return true
  }
}

const slides = [
  { slideId: 'slide-1', title: 'Why assessment breaks first', text: '# Why assessment breaks first' },
  { slideId: 'slide-3', title: 'The rubric problem', text: '# The rubric problem\nCriteria written for humans reward fluent prose.' },
]
const handout = '<!doctype html><html><head><title>AI and assessment workshop</title></head><body><main id="deck">Slides</main></body></html>'

try {
  // ── create ──────────────────────────────────────────────────────────────────────────────
  assert.equal((await call('/shares', { method: 'POST', body: { talkSlug: 'ai-assessment', title: 'T' } })).status, 401)
  assert.equal((await call('/shares', { method: 'POST', token: 'wrong', body: { talkSlug: 'ai-assessment', title: 'T' } })).status, 401)
  assert.equal((await call('/shares', { method: 'POST', token: adminSecret, body: { talkSlug: 'Bad Slug', title: 'T' } })).json.error.code, 'invalid_talk_slug')
  const created = await call('/shares', { method: 'POST', token: adminSecret, body: { talkSlug: 'ai-assessment', title: 'AI and assessment workshop' } })
  assert.equal(created.status, 201, created.text)
  assert.deepEqual(Object.keys(created.json).sort(), ['ownerToken', 'shareId'])
  const { shareId, ownerToken } = created.json
  assert.match(shareId, /^[a-z0-9]{8}$/)
  const share = `/shares/${shareId}`

  assert.equal((await call('/shares/by-talk/ai-assessment')).status, 401)
  assert.equal((await call('/shares/by-talk/ai-assessment', { token: ownerToken })).status, 401)
  assert.deepEqual((await call('/shares/by-talk/ai-assessment', { token: adminSecret })).json, { active: true, shareId })
  assert.equal((await call('/shares/zzzzzzzz/talk.json')).status, 404)

  // ── before the first push ───────────────────────────────────────────────────────────────
  const early = await call(share)
  assert.equal(early.status, 404)
  assert.match(early.headers.get('content-type'), /text\/html/)
  assert.equal((await call(`${share}/items`, { method: 'POST', body: { itemId: 'early', kind: 'note', slideId: 'slide-1', text: 'x' } })).json.error.code, 'talk_not_pushed')

  const owner = await openSocket(`${wsUrl}${share}/owner?token=${encodeURIComponent(ownerToken)}`)
  sockets.push(owner)
  const audience = await openSocket(`${wsUrl}${share}/audience`)
  sockets.push(audience)

  // ── push: owner token only, strict revision + 1 ──────────────────────────────────────────
  const push1 = { revision: 1, html: handout, slides }
  assert.equal((await call(`${share}/talk`, { method: 'PUT', body: push1 })).status, 401)
  assert.equal((await call(`${share}/talk`, { method: 'PUT', token: adminSecret, body: push1 })).status, 401)
  const gap = await call(`${share}/talk`, { method: 'PUT', token: ownerToken, body: { ...push1, revision: 2 } })
  assert.equal(gap.status, 409)
  assert.equal(gap.json.error.code, 'revision_conflict')
  assert.equal(gap.json.revision, 0)
  const audienceUpdate1 = nextMessage(audience)
  const pushed1 = await call(`${share}/talk`, { method: 'PUT', token: ownerToken, body: push1 })
  assert.equal(pushed1.status, 200, pushed1.text)
  assert.deepEqual(pushed1.json, { revision: 1, seq: 1 })
  assert.deepEqual(await audienceUpdate1, { type: 'talk.updated', revision: 1, seq: 1 })
  assert.equal((await call(`${share}/talk`, { method: 'PUT', token: ownerToken, body: push1 })).status, 409)
  assert.equal((await call(`${share}/talk`, { method: 'PUT', token: ownerToken, body: { ...push1, revision: 2, html: '' } })).json.error.code, 'invalid_html')

  // Only the route grammar reaches an object: an extra segment is refused by the entry Worker
  // ("Route not found."), never treated as a push that skips the body cap.
  for (const path of [`${share}/talk/x`, `${share}/talk/`, `${share}/close/x`, `${share}/items/a/b`]) {
    const refused = await call(path, { method: 'PUT', token: ownerToken, body: { ...push1, revision: 2 } })
    assert.equal(refused.status, 404, path)
    assert.deepEqual(refused.json.error, { code: 'not_found', message: 'Route not found.' }, path)
  }
  assert.equal((await call(`${share}/talk.json`)).json.revision, 1)

  // Security review, ticket 07: `internal` and `sessions` are reserved share ids (worker/share-id.ts)
  // precisely because the bare-id grammar would otherwise let a crafted request read as one, and
  // `close` is a real action word — a GET to `/sessions` or a POST to `/internal/close` used to
  // reach the object's raw, credential-free internal Stop handler. All of these now 404 at the
  // entry, unauthenticated (`POST /sessions` itself is a genuine, unrelated route — the live-session
  // creation endpoint — and correctly still 401s without a token; that one is not in this list).
  for (const [method, path] of [
    ['GET', '/internal'], ['POST', '/internal/close'], ['POST', '/internal/init'], ['POST', '/internal/discard'],
    ['GET', '/shares/internal'], ['POST', '/shares/internal/close'],
    ['GET', '/sessions'], ['GET', '/shares/sessions'],
  ]) {
    const refused = await call(path, { method })
    assert.equal(refused.status, 404, `${method} ${path}`)
    assert.deepEqual(refused.json.error, { code: 'not_found', message: 'Route not found.' }, `${method} ${path}`)
  }
  // The genuine article (a real, non-reserved share, closed the ordinary way through the entry
  // Worker's route grammar) still closes normally — the fix refuses the reserved word, not the
  // 'close' action itself. A throwaway share, so the rest of this script keeps using `share` above.
  const throwaway = await call('/shares', { method: 'POST', token: adminSecret, body: { talkSlug: 'reserved-id-check', title: 'T' } })
  assert.equal(throwaway.status, 201, throwaway.text)
  assert.equal((await call(`/shares/${throwaway.json.shareId}/close`, { method: 'POST', token: throwaway.json.ownerToken })).status, 200)

  // ── page and talk.json ──────────────────────────────────────────────────────────────────
  const page = await call(share)
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-type'), /text\/html/)
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer')
  assert.ok(page.text.includes('<main id="deck">Slides</main>'))
  assert.ok(page.text.includes('<script id="tw-shared-talk-runtime" data-slot="shared-talk-runtime"></script></head>'))
  const config = JSON.parse(page.text.match(/<script type="application\/json" id="tw-shared-talk-config">(.*?)<\/script>/)[1])
  assert.deepEqual(config, { shareId, revision: 1, seq: 1, api: share, audienceSocket: `${share}/audience` })
  assert.ok(!page.text.includes(ownerToken) && !page.text.includes(adminSecret))
  const talk = await call(`${share}/talk.json`)
  assert.deepEqual(talk.json, { shareId, title: 'AI and assessment workshop', revision: 1, updatedAt: talk.json.updatedAt, slides })

  // Audience routes take no credentials: neither the owner token nor the admin bearer.
  for (const token of [ownerToken, adminSecret]) {
    assert.equal((await call(share, { token })).json.error.code, 'credentials_not_allowed')
    assert.equal((await call(`${share}/talk.json`, { token })).json.error.code, 'credentials_not_allowed')
    assert.equal((await call(`${share}/items`, { method: 'POST', token, body: { itemId: 'cred', kind: 'note', slideId: 'slide-1', text: 'x' } })).json.error.code, 'credentials_not_allowed')
  }
  assert.equal((await call(`${share}?token=${encodeURIComponent(ownerToken)}`)).json.error.code, 'credentials_not_allowed')
  assert.ok(await socketRefused(`${wsUrl}${share}/audience?token=${encodeURIComponent(ownerToken)}`))
  assert.ok(await socketRefused(`${wsUrl}${share}/owner`))
  assert.ok(await socketRefused(`${wsUrl}${share}/owner?token=${encodeURIComponent(adminSecret)}`))

  // ── items: every kind, idempotent, validated ────────────────────────────────────────────
  const note = { itemId: 'item-note', kind: 'note', slideId: 'slide-3', text: 'Too dense for a workshop slide.', name: 'Colleague' }
  const ownerNew = nextMessage(owner)
  const posted = await call(`${share}/items`, { method: 'POST', body: note })
  assert.equal(posted.status, 201, posted.text)
  assert.deepEqual(posted.json.item, { ...note, createdAt: posted.json.item.createdAt, seq: 2, status: 'new', statusSeq: 2 })
  assert.deepEqual(await ownerNew, { type: 'item.new', item: posted.json.item, seq: 2 })
  const retried = await call(`${share}/items`, { method: 'POST', body: note })
  assert.equal(retried.status, 200)
  assert.deepEqual(retried.json.item, posted.json.item)
  assert.equal((await call(`${share}/items`, { method: 'POST', body: { ...note, text: 'Different' } })).status, 409)
  assert.equal((await call(`${share}/items`, { method: 'POST', body: { ...note, itemId: 'x', kind: 'vote' } })).json.error.code, 'invalid_item_kind')
  assert.equal((await call(`${share}/items`, { method: 'POST', body: { ...note, itemId: 'x', text: 'x'.repeat(20_001) } })).json.error.code, 'item_too_large')
  assert.equal((await call(`${share}/items`, { method: 'POST', body: 'not json' })).json.error.code, 'invalid_item')

  const proposals = [
    { itemId: 'item-replace', kind: 'replace', slideId: 'slide-3', baseRevision: 1, text: '# The rubric problem\nRubrics reward fluent prose.' },
    { itemId: 'item-delete', kind: 'delete', slideId: 'slide-1', baseRevision: 1, reason: 'Covered in the intro' },
    { itemId: 'item-insert', kind: 'insert', afterSlideId: 'start', baseRevision: 1, text: '# Welcome', section: 'Opening' },
  ]
  const ownerProposals = nextMessages(owner, 3)
  for (const proposal of proposals) assert.equal((await call(`${share}/items`, { method: 'POST', body: proposal })).status, 201)
  assert.deepEqual((await ownerProposals).map((message) => [message.type, message.item.kind, message.seq]), [
    ['item.new', 'replace', 3], ['item.new', 'delete', 4], ['item.new', 'insert', 5],
  ])
  assert.equal((await call(`${share}/items`, { method: 'POST', body: { ...proposals[0], itemId: 'future', baseRevision: 9 } })).json.error.code, 'invalid_base_revision')

  // ── second push reaches the audience; status patch is owner-only ────────────────────────
  const audienceUpdate2 = nextMessage(audience)
  assert.equal((await call(`${share}/talk`, { method: 'PUT', token: ownerToken, body: { ...push1, revision: 2 } })).status, 200)
  assert.deepEqual(await audienceUpdate2, { type: 'talk.updated', revision: 2, seq: 6 })

  assert.equal((await call(`${share}/items/item-replace`, { method: 'PATCH', body: { status: 'accepted' } })).status, 401)
  assert.equal((await call(`${share}/items/item-replace`, { method: 'PATCH', token: adminSecret, body: { status: 'accepted' } })).status, 401)
  assert.equal((await call(`${share}/items/item-replace`, { method: 'PATCH', token: ownerToken, body: { status: 'archived' } })).json.error.code, 'invalid_status')
  assert.equal((await call(`${share}/items/missing`, { method: 'PATCH', token: ownerToken, body: { status: 'accepted' } })).status, 404)
  const audienceStatus = nextMessage(audience)
  const patched = await call(`${share}/items/item-replace`, { method: 'PATCH', token: ownerToken, body: { status: 'accepted' } })
  assert.equal(patched.status, 200, patched.text)
  assert.equal(patched.json.item.status, 'accepted')
  const statusMessage = await audienceStatus
  assert.deepEqual(statusMessage, { type: 'item.status', itemId: 'item-replace', status: 'accepted', at: statusMessage.at, seq: 7 })

  // ── reconnect with ?since replays only what was missed ──────────────────────────────────
  const ownerAgain = await openSocket(`${wsUrl}${share}/owner?since=3`, 5000, { headers: { authorization: `Bearer ${ownerToken}` } })
  sockets.push(ownerAgain)
  const ownerReplay = await nextMessages(ownerAgain, 2)
  assert.deepEqual(ownerReplay.map((message) => message.item.itemId), ['item-delete', 'item-insert'])
  const audienceAgain = await openSocket(`${wsUrl}${share}/audience?since=5`)
  sockets.push(audienceAgain)
  assert.deepEqual(await nextMessages(audienceAgain, 2), [
    { type: 'talk.updated', revision: 2, seq: 6 },
    statusMessage,
  ])
  const audienceLate = await openSocket(`${wsUrl}${share}/audience?since=7`)
  sockets.push(audienceLate)
  await assert.rejects(nextMessage(audienceLate, 750))

  // ── any status → any status: done for notes, new for Undo ────────────────────────────────
  const doneStatus = nextMessage(audience)
  assert.equal((await call(`${share}/items/item-note`, { method: 'PATCH', token: ownerToken, body: { status: 'done' } })).json.item.status, 'done')
  assert.equal((await doneStatus).status, 'done')
  const undoStatus = nextMessage(audience)
  assert.equal((await call(`${share}/items/item-replace`, { method: 'PATCH', token: ownerToken, body: { status: 'new' } })).json.item.status, 'new')
  assert.deepEqual([(await undoStatus).itemId, (await undoStatus).status], ['item-replace', 'new'])

  // ── a large handout survives chunked storage byte for byte ──────────────────────────────
  const bigHandout = `<!doctype html><html><head><title>Big</title></head><body>${'é<p>slide</p>'.repeat(120_000)}</body></html>`
  const audienceUpdate3 = nextMessage(audience)
  assert.equal((await call(`${share}/talk`, { method: 'PUT', token: ownerToken, body: { ...push1, revision: 3, html: bigHandout } })).status, 200)
  assert.deepEqual(await audienceUpdate3, { type: 'talk.updated', revision: 3, seq: 10 })
  const bigPage = await call(share)
  assert.equal(bigPage.text.length, bigHandout.length + bigPage.text.indexOf('</head>') - bigHandout.indexOf('</head>'))
  assert.ok(bigPage.text.endsWith(bigHandout.slice(bigHandout.indexOf('</head>'))))

  // An emoji whose surrogate pair straddles the 524,288-unit chunk boundary comes back intact.
  const prefix = '<!doctype html><html><head></head><body>'
  const boundaryHandout = `${prefix}${'a'.repeat(512 * 1024 - 1 - prefix.length)}😀 after</body></html>`
  assert.equal(boundaryHandout.charCodeAt(512 * 1024 - 1), 0xd83d)
  const audienceUpdate4 = nextMessage(audience)
  assert.equal((await call(`${share}/talk`, { method: 'PUT', token: ownerToken, body: { ...push1, revision: 4, html: boundaryHandout } })).status, 200)
  await audienceUpdate4
  const boundaryPage = await fetch(`${baseUrl}${share}`).then((response) => response.arrayBuffer())
  const tail = Buffer.from(boundaryPage).subarray(Buffer.from(boundaryPage).indexOf('</head>'))
  assert.ok(tail.equals(Buffer.from(boundaryHandout.slice(boundaryHandout.indexOf('</head>')), 'utf8')), 'boundary emoji round-trips byte-identical')
  assert.ok(!tail.toString('utf8').includes('\ufffd'))

  // ── Stop sharing ────────────────────────────────────────────────────────────────────────
  assert.equal((await call(`${share}/close`, { method: 'POST' })).status, 401)
  const audienceClosed = nextMessage(audience)
  const ownerClosed = nextMessage(owner)
  assert.equal((await call(`${share}/close`, { method: 'POST', token: ownerToken })).status, 200)
  assert.deepEqual(await audienceClosed, { type: 'share.closed', reason: 'stopped' })
  assert.deepEqual(await ownerClosed, { type: 'share.closed', reason: 'stopped' })
  assert.deepEqual((await call('/shares/by-talk/ai-assessment', { token: adminSecret })).json, { active: false })
  assert.equal((await call(share)).status, 410)
  assert.equal((await call(`${share}/talk.json`)).json.error.code, 'share_closed')
  assert.equal((await call(`${share}/items`, { method: 'POST', body: { ...note, itemId: 'after' } })).status, 410)
  assert.equal((await call(`${share}/talk`, { method: 'PUT', token: ownerToken, body: { ...push1, revision: 5 } })).status, 410)

  // In the 7-day window after Stop sharing the owner can still reconnect and collect items.
  const lateOwner = await openSocket(`${wsUrl}${share}/owner?since=0`, 5000, { headers: { authorization: `Bearer ${ownerToken}` } })
  sockets.push(lateOwner)
  const lateReplay = await nextMessages(lateOwner, 5)
  assert.deepEqual(lateReplay.slice(0, 4).map((message) => message.item.itemId), ['item-note', 'item-replace', 'item-delete', 'item-insert'])
  assert.deepEqual(lateReplay[4], { type: 'share.closed', reason: 'stopped' })
  assert.ok(await socketRefused(`${wsUrl}${share}/audience`))

  // Re-sharing a slug stops its active share first; the admin bearer can also stop a share.
  const second = await call('/shares', { method: 'POST', token: adminSecret, body: { talkSlug: 'ai-assessment', title: '' } })
  assert.equal(second.status, 201)
  const secondShare = `/shares/${second.json.shareId}`
  assert.equal((await call(`${secondShare}/talk`, { method: 'PUT', token: ownerToken, body: push1 })).status, 401)
  assert.equal((await call(`${secondShare}/talk`, { method: 'PUT', token: second.json.ownerToken, body: push1 })).status, 200)
  const secondAudience = await openSocket(`${wsUrl}${secondShare}/audience?since=1`)
  sockets.push(secondAudience)
  const secondClosed = nextMessage(secondAudience)
  const third = await call('/shares', { method: 'POST', token: adminSecret, body: { talkSlug: 'ai-assessment', title: 'Again' } })
  assert.equal(third.status, 201)
  assert.deepEqual(await secondClosed, { type: 'share.closed', reason: 'stopped' })
  assert.equal((await call(secondShare)).status, 410)
  assert.equal((await call(`${secondShare}/items`, { method: 'POST', body: { ...note, itemId: 'orphan' } })).status, 410)
  assert.deepEqual((await call('/shares/by-talk/ai-assessment', { token: adminSecret })).json, { active: true, shareId: third.json.shareId })
  assert.equal((await call(`/shares/${third.json.shareId}/close`, { method: 'POST', token: adminSecret })).status, 200)
  assert.deepEqual((await call('/shares/by-talk/ai-assessment', { token: adminSecret })).json, { active: false })

  // ── per-share rate limit on new items ───────────────────────────────────────────────────
  const busy = await call('/shares', { method: 'POST', token: adminSecret, body: { talkSlug: 'busy-talk', title: 'Busy' } })
  const busyShare = `/shares/${busy.json.shareId}`
  assert.equal((await call(`${busyShare}/talk`, { method: 'PUT', token: busy.json.ownerToken, body: push1 })).status, 200)
  const statuses = []
  for (let index = 0; index < 40; index += 1) {
    const result = await call(`${busyShare}/items`, { method: 'POST', body: { ...note, itemId: `burst-${index}` } })
    statuses.push(result.status)
    if (result.status === 429) {
      assert.equal(result.json.error.code, 'rate_limited')
      assert.ok(Number(result.headers.get('retry-after')) >= 1)
    }
  }
  assert.ok(statuses.filter((status) => status === 201).length >= 30, statuses.join(','))
  assert.ok(statuses.includes(429), statuses.join(','))
  assert.equal((await call(`${busyShare}/items`, { method: 'POST', body: { ...note, itemId: 'burst-0' } })).status, 200)

  console.log('shared-talk worker integration: create + registry; revision gap 409; page with runtime slot; talk.json; four item kinds, idempotent retry, conflict, kind and size validation; owner-only push/patch; audience talk.updated + item.status; owner item.new; since-replay on both sockets; credentials refused on audience routes; Stop sharing by owner and admin; re-share stops the previous share; late owner replay after stop; extra-segment and reserved-id paths (/internal/*, /sessions) 404 at the entry; boundary emoji intact; done/new statuses; rate limit')
} finally {
  for (const socket of sockets) try { socket.close() } catch {}
  await stop()
}

// ── uploads refused before they are read ─────────────────────────────────────────────────────
// Each runs against its own `wrangler dev`: after the Worker answers without reading an upload,
// miniflare's local entry worker (not ours, and absent in production) fails the next request with
// "Network connection lost", so these cannot share an instance with other checks.
async function refusedUpload(label, send) {
  const worker = await startLiveWorker()
  try {
    const post = (path, body, token) => fetch(`${worker.baseUrl}${path}`, {
      method: path.endsWith('/talk') ? 'PUT' : 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    }).then((response) => response.json())
    const created = await post('/shares', { talkSlug: 'upload-talk', title: 'Upload' }, worker.adminSecret)
    const share = `/shares/${created.shareId}`
    assert.deepEqual(await post(`${share}/talk`, { revision: 1, html: '<p>x</p>', slides: [] }, created.ownerToken), { revision: 1, seq: 1 })
    await send({ ...worker, share, ownerToken: created.ownerToken })
    console.log(`  refused upload: ${label}`)
  } finally {
    await worker.stop()
  }
}

/**
 * Stream up to `totalBytes` as a chunked body (no Content-Length) with backpressure, and stop
 * writing as soon as a response arrives. `sentAtResponse` is how much had been written by then.
 */
function streamed(baseUrl, path, totalBytes, { method = 'POST', headers = {} } = {}) {
  return new Promise((resolveResult, reject) => {
    const chunk = Buffer.alloc(64 * 1024, 'x')
    let sent = 0
    let answered = false
    const request = httpRequest(`${baseUrl}${path}`, { method, agent: false, headers: { 'content-type': 'application/json', ...headers } }, (response) => {
      answered = true
      const sentAtResponse = sent
      let text = ''
      response.on('data', (part) => { text += part })
      response.on('end', () => {
        request.destroy()
        let json = null
        try { json = JSON.parse(text) } catch {}
        resolveResult({ status: response.statusCode, json, sentAtResponse, ...(json ? {} : { text: text.slice(0, 300) }) })
      })
    })
    request.on('error', (error) => { if (!answered) reject(error) })
    const pump = () => {
      while (!answered && sent < totalBytes) {
        sent += chunk.byteLength
        if (!request.write(chunk)) { request.once('drain', pump); return }
      }
      if (!answered) request.end()
    }
    pump()
  })
}

await refusedUpload('chunked item body over 64 KiB with no Content-Length → 413', async ({ baseUrl, share }) => {
  const result = await streamed(baseUrl, `${share}/items`, 200 * 1024)
  assert.equal(result.status, 413)
  assert.equal(result.json.error.code, 'body_too_large')
})

for (const [label, authorization] of [['no token', undefined], ['admin bearer', 'admin'], ['presenter-shaped garbage', 'x.y']]) {
  await refusedUpload(`40 MB chunked push with ${label} → 401, body unread`, async ({ baseUrl, share, adminSecret }) => {
    const token = authorization === 'admin' ? adminSecret : authorization
    const result = await streamed(baseUrl, `${share}/talk`, 40 * 1024 * 1024, { method: 'PUT', headers: token ? { authorization: `Bearer ${token}` } : {} })
    assert.equal(result.status, 401, JSON.stringify(result))
    assert.equal(result.json.error.code, 'owner_auth_required')
    // Had the Worker read the body before checking the token it would have answered 413 (see the
    // control case below). Local wrangler buffers the upload before the Worker sees it, so byte
    // counts cannot show this locally; the status does.
  })
}

await refusedUpload('40 MB chunked body on PUT /talk/x → 404 at the entry Worker', async ({ baseUrl, share }) => {
  const result = await streamed(baseUrl, `${share}/talk/x`, 40 * 1024 * 1024, { method: 'PUT' })
  assert.equal(result.status, 404, JSON.stringify(result))
  assert.deepEqual(result.json.error, { code: 'not_found', message: 'Route not found.' })
})

await refusedUpload('control: the same 40 MB push WITH the owner token is read and cut (not 401)', async ({ baseUrl, share, ownerToken }) => {
  const result = await streamed(baseUrl, `${share}/talk`, 40 * 1024 * 1024, { method: 'PUT', headers: { authorization: `Bearer ${ownerToken}` } })
  // In production this is 413 body_too_large. Locally, miniflare's own entry worker loses the
  // response once the Worker cancels an upload this large and answers 500 "Network connection
  // lost". Either way it is not 401: reading the body gives a different answer, which is what makes
  // the 401s above proof that unauthenticated bodies are not read.
  const localArtifact = result.status === 500 && /Network connection lost/.test(result.text ?? '') && /miniflare/.test(result.text ?? '')
  assert.ok(result.status === 413 || localArtifact, JSON.stringify(result))
  if (result.status === 413) assert.equal(result.json.error.code, 'body_too_large')
})

console.log('shared-talk worker integration: uploads refused before reading (413 cap, 401 unread push, 404 extra segment)')
