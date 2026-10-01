// Feedback-boards ticket 09 against a real live Worker (`wrangler dev`: local, throwaway secrets and
// state, nothing deployed): a planned Run's pre-work object and its routes.
//   - only the admin creates one; only its own owner token pushes the form or reads the answers (the
//     admin secret, a Run share link's owner token and a shared talk's are refused); nothing is served
//     until the first push; a form carrying a right answer is refused;
//   - open and closed by date: before it opens a submission is refused (409), while open it is taken,
//     after it closes it is refused (410) and the status says how many took part; the owner can close early;
//   - idempotency: the same submission again is answered with what was stored and changes nothing; a
//     different body under the same id is a conflict;
//   - public routes take no credential; wrong methods and oversize bodies are refused before the object;
//   - caps: one device's questions and its rate are capped, others still get in;
//   - a device reads back only its own entries; the owner pages the entries after a sequence number;
//   - one host (cf-connecting-ip) rotating participant ids is capped; another host still gets in during and
//     after the flood; refused ids are never counted;
//   - 50 simultaneous submits to one object: no 5xx, consistent counts and sequence numbers;
//   - purge: with no activity for the idle window after it closes (shortened for this run) everything is deleted (410).
// Usage: node scripts/test-prework-worker-integration.mjs
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { startLiveWorker } from './lib/live-worker-harness.mjs'

const IDLE_MS = 12_000
const { baseUrl, adminSecret, stop } = await startLiveWorker({ vars: { PREWORK_IDLE_PURGE_MS: String(IDLE_MS) } })
const results = []
const pass = (name) => { results.push(name); console.log(`PASS  ${name}`) }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const admin = { authorization: `Bearer ${adminSecret}` }
const json = { 'content-type': 'application/json' }
const device = () => randomBytes(16).toString('hex')
let submissionCounter = 0
const nextId = () => `sub-${Date.now().toString(36)}-${(submissionCounter += 1)}`

const form = () => ({
  title: 'Before the session', intro: 'Four short steps.',
  steps: [
    { id: 'pwwelcome', n: 1, title: 'Welcome', kind: 'slide', questions: false },
    { id: 'pwquiz', n: 2, title: 'Quick check', kind: 'check', questions: true,
      poll: { type: 'single', question: 'Quick check', options: [{ optionId: 'poll-pwquiz-option-1', label: 'A' }, { optionId: 'poll-pwquiz-option-2', label: 'B' }] } },
    { id: 'pwhope', n: 3, title: 'Hopes', kind: 'question', questions: true, poll: { type: 'open', question: 'Hopes', options: [] } },
    { id: 'pwtask1', n: 4, title: 'Task 1', kind: 'task', questions: true, done: true, minutes: 20 },
  ],
})

async function create() {
  const response = await fetch(`${baseUrl}/prework`, { method: 'POST', headers: { ...admin, ...json }, body: '{}' })
  assert.equal(response.status, 201)
  return response.json()
}
const pushForm = (prework, body, token = prework.ownerToken) => fetch(`${baseUrl}/prework/${prework.preworkId}/form`, {
  method: 'PUT', headers: { ...json, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
const status = (prework) => fetch(`${baseUrl}/prework/${prework.preworkId}`)
const submit = (prework, body, headers = {}) => fetch(`${baseUrl}/prework/${prework.preworkId}/submit`, {
  method: 'POST', headers: { ...json, ...headers }, body: JSON.stringify(body) })
const owned = (prework, path, init = {}) => fetch(`${baseUrl}/prework/${prework.preworkId}/${path}`, {
  ...init, headers: { authorization: `Bearer ${prework.ownerToken}`, ...(init.headers ?? {}) } })

try {
  // ── Creation and the owner token ──────────────────────────────────────────────────────────
  assert.equal((await fetch(`${baseUrl}/prework`, { method: 'POST' })).status, 401, 'creating pre-work needs the admin secret')
  const main = await create()
  assert.match(main.preworkId, /^[a-z0-9]{8}$/)
  assert.equal((await status(main)).status, 404, 'nothing is served before the first push')
  assert.equal((await status({ preworkId: 'zzzz9999' })).status, 404)
  const now = Date.now()
  const withRight = form()
  withRight.steps[1].right = { index: 0, label: 'A' }
  assert.equal((await pushForm(main, { opensAt: now + 3_000, closesAt: now + 9_000, form: withRight })).status, 400, 'a form carrying the right answer is refused')
  const window = { opensAt: now + 3_000, closesAt: now + 9_000, form: form() }
  assert.equal((await pushForm(main, window, null)).status, 401, 'a push without the owner token is refused')
  assert.equal((await pushForm(main, window, adminSecret)).status, 401, 'the admin secret is not an owner token')
  const link = await (await fetch(`${baseUrl}/results`, { method: 'POST', headers: { ...admin, ...json }, body: '{}' })).json()
  assert.equal((await pushForm(main, window, link.ownerToken)).status, 401, 'a Run share link\'s owner token cannot push pre-work')
  const other = await create()
  assert.equal((await pushForm(main, window, other.ownerToken)).status, 401, 'another pre-work\'s owner token cannot push this one')
  assert.equal((await owned(main, 'results')).status, 200)
  assert.equal((await fetch(`${baseUrl}/prework/${main.preworkId}/results`)).status, 401, 'the answers need the owner token')
  assert.equal((await pushForm(main, window)).status, 200)
  pass('only the admin creates pre-work; only its own owner token pushes the form or reads the answers; a right answer is refused')

  // ── Before it opens ───────────────────────────────────────────────────────────────────────
  const notYet = await status(main)
  assert.equal(notYet.status, 200)
  assert.equal(notYet.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await notYet.json(), { state: 'not_yet', opensAt: window.opensAt, closesAt: window.closesAt })
  const deviceA = device(), deviceB = device()
  const early = await submit(main, { participantId: deviceA, submissionId: nextId(), stepId: 'pwwelcome', kind: 'read' })
  assert.equal(early.status, 409)
  assert.equal((await early.json()).error.code, 'prework_not_open')
  pass('before it opens: the status says not yet and a submission is refused')

  // ── Public routes: no credentials, one method, bounded bodies ─────────────────────────────
  assert.equal((await fetch(`${baseUrl}/prework/${main.preworkId}`, { headers: { authorization: `Bearer ${main.ownerToken}` } })).status, 400, 'the status route takes no credential')
  assert.equal((await fetch(`${baseUrl}/prework/${main.preworkId}?token=x`)).status, 400)
  assert.equal((await submit(main, { participantId: deviceA, submissionId: nextId(), stepId: 'pwwelcome', kind: 'read' }, { authorization: `Bearer ${adminSecret}` })).status, 400)
  for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await fetch(`${baseUrl}/prework/${main.preworkId}`, { method })).status, 405, `${method} on the status is refused`)
  assert.equal((await fetch(`${baseUrl}/prework/${main.preworkId}/submit`)).status, 405)
  assert.equal((await submit(main, { participantId: deviceA, submissionId: nextId(), stepId: 'pwhope', kind: 'answer', text: 'x'.repeat(9_000) })).status, 413, 'an oversize submission is refused unread')
  assert.equal((await fetch(`${baseUrl}/prework/${main.preworkId}/other`)).status, 404)
  pass('public routes take no credential; wrong methods and oversize bodies are refused before the object')

  await sleep(Math.max(0, window.opensAt - Date.now()) + 200)

  // ── While it is open ──────────────────────────────────────────────────────────────────────
  assert.equal((await (await status(main)).json()).state, 'open')
  const read = { participantId: deviceA, submissionId: nextId(), stepId: 'pwwelcome', kind: 'read' }
  const first = await submit(main, read)
  assert.equal(first.status, 201)
  const firstBody = await first.json()
  assert.equal(firstBody.changed, true)
  assert.equal(JSON.stringify(firstBody).includes(deviceA), false, 'the device id is never echoed back')
  const replay = await submit(main, read)
  assert.equal(replay.status, 200, 'the same submission again is answered, not stored again')
  assert.deepEqual((await replay.json()).entry, firstBody.entry)
  const conflict = await submit(main, { ...read, stepId: 'pwquiz' })
  assert.equal(conflict.status, 409, 'a different body under a known submission id is a conflict')
  assert.equal((await submit(main, { participantId: deviceA, submissionId: nextId(), stepId: 'pwquiz', kind: 'answer', choice: 'poll-pwquiz-option-2' })).status, 201)
  assert.equal((await submit(main, { participantId: deviceA, submissionId: nextId(), stepId: 'pwquiz', kind: 'answer', choice: 'poll-pwquiz-option-1' })).status, 201, 'changing an answer is taken')
  assert.equal((await submit(main, { participantId: deviceA, submissionId: nextId(), stepId: 'pwquiz', kind: 'answer', choice: 'made-up' })).status, 400, 'a choice the step does not offer is refused')
  assert.equal((await submit(main, { participantId: deviceA, submissionId: nextId(), stepId: 'nosuch', kind: 'read' })).status, 400, 'an unknown step is refused')
  assert.equal((await submit(main, { participantId: deviceA, submissionId: nextId(), stepId: 'pwwelcome', kind: 'question', text: 'Why?' })).status, 400, 'questions off for the step')
  assert.equal((await submit(main, { participantId: deviceA, submissionId: nextId(), stepId: 'pwtask1', kind: 'done', done: true })).status, 201)
  assert.equal((await submit(main, { participantId: deviceB, submissionId: nextId(), stepId: 'pwhope', kind: 'answer', text: '<b>save time</b>' })).status, 201)
  pass('while open: reads, answers, done marks are taken; the same submission is idempotent; a conflict and off-form answers are refused')

  // Caps: one device's questions.
  let questionRefusal = null
  for (let i = 0; i < 21; i += 1) {
    const response = await submit(main, { participantId: deviceB, submissionId: nextId(), stepId: 'pwtask1', kind: 'question', text: `Question ${i}` })
    if (response.status !== 201) { questionRefusal = { status: response.status, code: (await response.json()).error.code }; break }
  }
  assert.deepEqual(questionRefusal, { status: 429, code: 'question_limit' }, 'the 21st question from one device is refused')
  assert.equal((await submit(main, { participantId: deviceA, submissionId: nextId(), stepId: 'pwtask1', kind: 'question', text: 'Mine still gets in' })).status, 201, 'other devices still get in')
  pass('caps: one device\'s questions are capped, others still get in')

  // A device reads back only its own entries.
  const mine = await fetch(`${baseUrl}/prework/${main.preworkId}/mine`, { method: 'POST', headers: json, body: JSON.stringify({ participantId: deviceA }) })
  assert.equal(mine.status, 200)
  const own = (await mine.json()).entries
  assert.deepEqual(own.map((entry) => entry.ref), ['read:pwwelcome', 'answer:pwquiz', 'done:pwtask1', own[3].ref])
  assert.equal(own[1].choice, 'poll-pwquiz-option-1', 'the latest answer')
  assert.equal(JSON.stringify(own).includes('save time'), false, 'another device\'s answer is not in mine')
  pass('a device reads back only its own entries, with the latest answer')

  // The owner pages the entries.
  const all = await (await owned(main, 'results?after=0')).json()
  assert.equal(all.people, 2)
  assert.equal(all.phase, 'open')
  assert.ok(all.entries.every((entry) => /^[0-9a-f]{16}$/.test(entry.participant)), 'participants are hashes')
  assert.equal(JSON.stringify(all).includes(deviceA), false, 'no device id is ever stored or served')
  const quiz = all.entries.filter((entry) => entry.stepId === 'pwquiz')
  assert.equal(quiz.length, 1, 'one answer per person and step')
  const afterSome = await (await owned(main, `results?after=${all.entries[2].seq}`)).json()
  assert.deepEqual(afterSome.entries.map((entry) => entry.seq), all.entries.slice(3).map((entry) => entry.seq))
  pass('the owner pages the entries after a sequence number; participants are hashes')

  await sleep(Math.max(0, window.closesAt - Date.now()) + 200)

  // ── After it closes ───────────────────────────────────────────────────────────────────────
  assert.deepEqual(await (await status(main)).json(), { state: 'closed', opensAt: window.opensAt, closesAt: window.closesAt, people: 2 })
  const late = await submit(main, { participantId: deviceA, submissionId: nextId(), stepId: 'pwwelcome', kind: 'read' })
  assert.equal(late.status, 410)
  assert.equal((await (await owned(main, 'results?after=0')).json()).entries.length, all.entries.length, 'the answers are kept for the owner after it closes')
  pass('after it closes: submissions are refused (410); the status says how many took part; the answers are kept')

  // ── Close early ───────────────────────────────────────────────────────────────────────────
  const early2 = await create()
  const openNow = { opensAt: Date.now() - 1_000, closesAt: Date.now() + 60 * 60_000, form: form() }
  assert.equal((await pushForm(early2, openNow)).status, 200)
  assert.equal((await submit(early2, { participantId: deviceA, submissionId: nextId(), stepId: 'pwwelcome', kind: 'read' })).status, 201)
  assert.equal((await fetch(`${baseUrl}/prework/${early2.preworkId}/close`, { method: 'POST' })).status, 401, 'closing needs a credential')
  assert.equal((await owned(early2, 'close', { method: 'POST' })).status, 200)
  assert.equal((await (await status(early2)).json()).state, 'closed')
  assert.equal((await pushForm(early2, openNow)).status, 200)
  assert.equal((await (await status(early2)).json()).state, 'closed', 'a later push does not reopen it')
  const early3 = await create()
  assert.equal((await pushForm(early3, openNow)).status, 200)
  assert.equal((await fetch(`${baseUrl}/prework/${early3.preworkId}/close`, { method: 'POST', headers: admin })).status, 200, 'the admin secret may also close it')
  pass('the owner (or admin) closes it early; it is never reopened')

  // ── Rate ──────────────────────────────────────────────────────────────────────────────────
  const busy = await create()
  assert.equal((await pushForm(busy, openNow)).status, 200)
  const flood = device()
  let rateRefusal = null
  for (let i = 0; i < 70 && !rateRefusal; i += 1) {
    const response = await submit(busy, { participantId: flood, submissionId: nextId(), stepId: 'pwhope', kind: 'answer', text: `answer ${i}` })
    if (response.status === 429) rateRefusal = { code: (await response.json()).error.code, retryAfter: response.headers.get('retry-after') }
  }
  assert.equal(rateRefusal?.code, 'rate_limited', 'one device is rate-limited')
  assert.ok(Number(rateRefusal.retryAfter) >= 1, 'with a retry-after')
  assert.equal((await submit(busy, { participantId: device(), submissionId: nextId(), stepId: 'pwwelcome', kind: 'read' })).status, 201, 'another device still gets in')
  pass('rate: one device is limited with a retry-after; another still gets in')

  // ── One network source rotating participant ids ───────────────────────────────────────
  // The Worker keys its source limits by cf-connecting-ip (set by Cloudflare; a local Worker passes
  // what the request carries, which lets this test stand in two hosts).
  const crowd = await create()
  assert.equal((await pushForm(crowd, openNow)).status, 200)
  const fromA = { 'cf-connecting-ip': '203.0.113.7' }, fromB = { 'cf-connecting-ip': '198.51.100.9' }
  let sourceRefusal = null
  let accepted = 0
  // 300 a minute per host: the flood pauses when rate-limited and goes on, until the hourly cap.
  for (let i = 0; i < 401 && !sourceRefusal; i += 1) {
    const body = { participantId: device(), submissionId: nextId(), stepId: 'pwwelcome', kind: 'read' }
    let response = await submit(crowd, body, fromA)
    while (response.status === 429 && (await response.clone().json()).error.code === 'rate_limited') {
      await sleep(Number(response.headers.get('retry-after') || 1) * 1_000)
      response = await submit(crowd, body, fromA)
    }
    if (response.status === 201) accepted += 1
    else sourceRefusal = { status: response.status, code: (await response.json()).error.code }
  }
  assert.equal(accepted, 400, 'one host brings at most 400 new participant ids an hour')
  assert.deepEqual(sourceRefusal, { status: 429, code: 'source_limit' }, 'the next new id from that host is refused')
  // The flooder keeps going; a second host is admitted during the flood and after it stops.
  const during = await Promise.all(Array.from({ length: 20 }, (_, i) => i % 2
    ? submit(crowd, { participantId: device(), submissionId: nextId(), stepId: 'pwwelcome', kind: 'read' }, fromA)
    : submit(crowd, { participantId: device(), submissionId: nextId(), stepId: 'pwwelcome', kind: 'read' }, fromB)))
  assert.deepEqual(during.filter((_, i) => i % 2).map((r) => r.status), Array(10).fill(429), 'the flooder\'s new ids stay refused')
  assert.deepEqual(during.filter((_, i) => !(i % 2)).map((r) => r.status), Array(10).fill(201), 'a second host\'s newcomers are admitted during the flood')
  assert.equal((await submit(crowd, { participantId: device(), submissionId: nextId(), stepId: 'pwwelcome', kind: 'read' }, fromB)).status, 201, 'and after it')
  assert.equal((await submit(crowd, { participantId: device(), submissionId: nextId(), stepId: 'pwwelcome', kind: 'read' }, { 'cf-connecting-ip': '192.0.2.44' })).status, 201, 'as is a third host')
  const crowdResults = await (await owned(crowd, 'results?after=0')).json()
  assert.equal(crowdResults.people, 412, 'refused ids were never counted: 400 from the flooder, 11 from the second host, 1 from the third')
  const spoof = await submit(crowd, { participantId: device(), submissionId: nextId(), stepId: 'pwwelcome', kind: 'read' }, { ...fromA, 'x-tw-prework-source': '192.0.2.1' })
  assert.equal(spoof.status, 429, 'the source header the Worker sets cannot be supplied by the client')
  pass('one host rotating participant ids is capped; other hosts are admitted during and after the flood; refused ids are never counted')

  // IPv6: addresses in one /64 are one source; another /64 is another.
  const v6 = await create()
  assert.equal((await pushForm(v6, openNow)).status, 200)
  const inPrefix = (n) => ({ 'cf-connecting-ip': `2001:db8:abcd:12::${n.toString(16)}` })
  let v6Refusal = null, v6Accepted = 0
  for (let i = 0; i < 401 && !v6Refusal; i += 1) {
    const body = { participantId: device(), submissionId: nextId(), stepId: 'pwwelcome', kind: 'read' }
    let response = await submit(v6, body, inPrefix(i + 1))
    while (response.status === 429 && (await response.clone().json()).error.code === 'rate_limited') {
      await sleep(Number(response.headers.get('retry-after') || 1) * 1_000)
      response = await submit(v6, body, inPrefix(i + 1))
    }
    if (response.status === 201) v6Accepted += 1
    else v6Refusal = (await response.json()).error.code
  }
  assert.deepEqual([v6Accepted, v6Refusal], [400, 'source_limit'], 'one /64 rotating its addresses is one source')
  assert.equal((await submit(v6, { participantId: device(), submissionId: nextId(), stepId: 'pwwelcome', kind: 'read' }, { 'cf-connecting-ip': '2001:db8:abcd:13::1' })).status, 201, 'another /64 is another source')
  pass('IPv6: addresses in one /64 share a source; another /64 does not')

  // Oversized bodies are refused unread (413), an unowned push 401, and the Worker keeps answering.
  const big = (bytes) => 'x'.repeat(bytes)
  for (const [label, size] of [['1 MB', 1024 * 1024], ['5 MB', 5 * 1024 * 1024]]) {
    const response = await fetch(`${baseUrl}/prework/${v6.preworkId}/submit`, { method: 'POST', headers: json, body: big(size) })
    assert.equal(response.status, 413, `a ${label} submission is refused 413`)
  }
  assert.equal((await fetch(`${baseUrl}/prework/${v6.preworkId}/mine`, { method: 'POST', headers: json, body: big(5 * 1024 * 1024) })).status, 413, 'a 5 MB my-answers is refused 413')
  assert.equal((await fetch(`${baseUrl}/prework/${v6.preworkId}/form`, { method: 'PUT', headers: { ...json, authorization: `Bearer ${v6.ownerToken}` }, body: big(300 * 1024) })).status, 413, 'an owner push over 256 KiB is refused 413')
  assert.equal((await fetch(`${baseUrl}/prework/${v6.preworkId}/form`, { method: 'PUT', headers: json, body: big(5 * 1024 * 1024) })).status, 401, 'an unowned 5 MB push is refused 401 unread')
  assert.equal((await status(v6)).status, 200, 'the Worker keeps answering')
  assert.equal((await submit(v6, { participantId: device(), submissionId: nextId(), stepId: 'pwwelcome', kind: 'read' }, { 'cf-connecting-ip': '198.51.100.77' })).status, 201)
  pass('oversized bodies are refused unread (413; 401 unowned) and the Worker keeps answering')

  // ── Concurrency: 50 simultaneous submits to one object ────────────────────────────────────
  const busyForm = await create()
  assert.equal((await pushForm(busyForm, openNow)).status, 200)
  const devices = Array.from({ length: 50 }, (_, i) => ({ id: device(), ip: `198.18.0.${i + 1}` }))
  const burst = await Promise.all(devices.flatMap((d) => [
    submit(busyForm, { participantId: d.id, submissionId: `c-${d.id}-a`, stepId: 'pwhope', kind: 'answer', text: `hope ${d.id.slice(0, 6)}` }, { 'cf-connecting-ip': d.ip }),
    submit(busyForm, { participantId: d.id, submissionId: `c-${d.id}-r`, stepId: 'pwwelcome', kind: 'read' }, { 'cf-connecting-ip': d.ip }),
  ]))
  const statuses = burst.map((r) => r.status)
  assert.equal(statuses.some((status) => status >= 500), false, `no 5xx under concurrency: ${statuses.join(',')}`)
  assert.ok(statuses.every((status) => status === 201), `every submit accepted: ${statuses.join(',')}`)
  const replays = await Promise.all(devices.map((d) => submit(busyForm, { participantId: d.id, submissionId: `c-${d.id}-a`, stepId: 'pwhope', kind: 'answer', text: `hope ${d.id.slice(0, 6)}` }, { 'cf-connecting-ip': d.ip })))
  assert.ok(replays.every((r) => r.status === 200), 'concurrent replays are answered, not stored again')
  const counted = await (await owned(busyForm, 'results?after=0')).json()
  assert.equal(counted.people, 50, 'fifty people')
  assert.equal(counted.entries.length, 100, 'one answer and one read each')
  assert.equal(counted.seq, 100, 'every change took exactly one sequence number')
  assert.deepEqual(new Set(counted.entries.map((entry) => entry.seq)).size, 100, 'no sequence number was used twice')
  pass('50 simultaneous submits (and their replays) to one object: no 5xx, consistent counts')

  // ── Purge after the idle window ───────────────────────────────────────────────────────────
  const idle = await create()
  // Purge counts from the later of the last activity and the close: this form closes in a moment.
  assert.equal((await pushForm(idle, { opensAt: Date.now() - 1_000, closesAt: Date.now() + 1_000, form: form() })).status, 200)
  assert.equal((await submit(idle, { participantId: deviceA, submissionId: nextId(), stepId: 'pwwelcome', kind: 'read' })).status, 201)
  await sleep(IDLE_MS + 1_500)
  const gone = await status(idle)
  assert.equal(gone.status, 410, 'purged after the idle window')
  assert.equal((await gone.json()).error.code, 'prework_gone')
  assert.equal((await owned(idle, 'results?after=0')).status, 410, 'the answers are gone for the owner too')
  assert.equal((await submit(idle, { participantId: deviceA, submissionId: nextId(), stepId: 'pwwelcome', kind: 'read' })).status, 410)
  pass('purged after the idle window: every route answers 410')

} finally {
  await stop()
}

// A submission with no cf-connecting-ip (refused 503 unless PREWORK_LOCAL_SOURCE) cannot be sent through
// `wrangler dev`, which always adds the header; worker/prework-object.test.ts covers both cases.
console.log(`\nprework worker integration: ${results.length} checks passed`)
