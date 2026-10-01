// The pre-work form without a browser (feedback-boards ticket 10, ADR-0032 amendment): the pure module
// (what a person's entries say about each step, "Carry on", the minutes, the answer each poll accepts,
// what a submission and each refusal say, the icons) and the client that talks to the Worker (one
// submission at a time per thing, a later one waits and only the newest waiting one is kept; refusals and
// a dead connection come back as answers, never as throws). The screens on the real page are
// prework-form-dom.test.mjs; the Worker itself is test-prework-form-live.mjs.
// Usage: node scripts/prework-form.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import {
  createPreworkClient, normalisePreworkEntries, preworkAnswerReady, preworkDay, preworkDraftFromEntry, preworkEntryFromSubmission,
  preworkFormRuntimeSource, preworkIcons, preworkKindIcon, preworkKindLabel, preworkMerge, preworkMinutesText, preworkPollHint,
  preworkProgress, preworkRandomId, preworkRefusal, preworkStepState, preworkSubmission, preworkWhen,
} from '../compiler/assets/runtime/prework-form.js'

// ── The icons are lucide's own ───────────────────────────────────────────────────────────────
const lucide = JSON.parse(readFileSync(new URL('../compiler/assets/icons/lucide.json', import.meta.url), 'utf8'))
for (const [name, body] of Object.entries(preworkIcons())) assert.equal(body, lucide[name]?.body, `icon ${name} matches the vendored lucide set`)

// ── Random ids the Worker accepts ────────────────────────────────────────────────────────────
let counter = 0
const random = (n) => Uint8Array.from({ length: n }, () => (counter += 37) & 255)
const device = preworkRandomId(random, 16)
assert.match(device, /^[0-9a-f]{32}$/, 'a device id is 32 hex characters (the Worker wants 16 to 100 of A-Za-z0-9_-)')
assert.notEqual(preworkRandomId(random, 16), device)

// ── The form and a person's entries ──────────────────────────────────────────────────────────
const options = (...ids) => ids.map((id) => ({ optionId: id, label: id.toUpperCase() }))
const form = {
  title: 'Before the session', intro: 'Seven short steps.',
  steps: [
    { id: 's1', n: 1, title: 'Welcome', kind: 'slide', questions: true },
    { id: 's2', n: 2, title: 'Agent', kind: 'slide', questions: false },
    { id: 's3', n: 3, title: 'Check', kind: 'check', questions: true, poll: { type: 'single', question: 'Check', options: options('a', 'b', 'c') } },
    { id: 's4', n: 4, title: 'Tools', kind: 'question', questions: true, poll: { type: 'multiple', question: '', options: options('a', 'b', 'c'), maxSelections: 2 } },
    { id: 's5', n: 5, title: 'Task 1', kind: 'task', questions: true, done: true, minutes: 10 },
    { id: 's6', n: 6, title: 'Task 2', kind: 'task', questions: true, done: true, minutes: 5 },
    { id: 's7', n: 7, title: 'Hopes', kind: 'question', questions: true, poll: { type: 'open', question: 'Hopes', options: [] } },
  ],
}
const entry = (ref, stepId, kind, extra = {}) => ({ ref, stepId, kind, at: 1000, ...extra })
assert.deepEqual(preworkStepState(form.steps[0], []), { state: 'todo', label: 'Not started', tone: 'todo', answer: null, done: false, questions: [], read: false })
assert.equal(preworkStepState(form.steps[0], [entry('read:s1', 's1', 'read')]).label, 'Read')
assert.equal(preworkStepState(form.steps[2], [entry('read:s3', 's3', 'read')]).state, 'todo', 'a quick check is done by an answer, not by opening it')
assert.equal(preworkStepState(form.steps[2], [entry('answer:s3', 's3', 'answer', { choice: 'b' })]).label, 'Answered')
assert.equal(preworkStepState(form.steps[4], [entry('read:s5', 's5', 'read')]).label, 'Not done yet', 'a task opened and not marked done')
assert.equal(preworkStepState(form.steps[4], [entry('read:s5', 's5', 'read')]).tone, 'started')
assert.equal(preworkStepState(form.steps[4], [entry('done:s5', 's5', 'done', { done: false })]).label, 'Not done yet', 'an unticked task goes back to not done')
assert.equal(preworkStepState(form.steps[4], [entry('done:s5', 's5', 'done', { done: true })]).label, 'Done')
const readOnly = { ...form.steps[4], done: false }
assert.equal(preworkStepState(readOnly, [entry('read:s5', 's5', 'read')]).label, 'Read', 'a read-only task is read, not done')
assert.deepEqual(preworkStepState(form.steps[0], [entry('q:1', 's1', 'question', { text: 'Y' }), entry('q:0', 's1', 'question', { text: 'X', at: 500 })]).questions.map((q) => q.text), ['X', 'Y'], 'questions come oldest first')
assert.equal(preworkStepState(form.steps[0], [entry('q:1', 's1', 'question', { text: 'Y' })]).state, 'todo', 'a question does not make a step done')

const five = [
  entry('read:s1', 's1', 'read'), entry('read:s2', 's2', 'read'), entry('answer:s3', 's3', 'answer', { choice: 'b' }),
  entry('answer:s4', 's4', 'answer', { choice: ['a'] }), entry('read:s5', 's5', 'read'), entry('done:s5', 's5', 'done', { done: true }),
]
const progress = preworkProgress(form, five)
assert.equal(progress.doneCount, 5)
assert.equal(progress.total, 7)
assert.equal(progress.next, 5, '"Carry on" is the first step not done (step 6)')
assert.equal(progress.started, true)
assert.equal(progress.allDone, false)
assert.equal(preworkProgress(form, []).started, false)
assert.equal(preworkProgress(form, [entry('q:1', 's1', 'question', { text: 'Y' })]).started, true, 'asking a question counts as having started')
const all = [...five, entry('read:s6', 's6', 'read'), entry('done:s6', 's6', 'done', { done: true }), entry('answer:s7', 's7', 'answer', { text: 'x' })]
assert.equal(preworkProgress(form, all).allDone, true)
assert.equal(preworkProgress(form, all).next, null)

// ── Merging what the Worker took ─────────────────────────────────────────────────────────────
const merged = preworkMerge(five, entry('answer:s3', 's3', 'answer', { choice: 'c' }))
assert.equal(merged.length, five.length, 'a later entry with the same ref replaces the earlier one')
assert.equal(merged.find((e) => e.ref === 'answer:s3').choice, 'c')
assert.equal(preworkMerge(five, entry('q:9', 's1', 'question', { text: 'Z' })).length, five.length + 1)
assert.equal(five.find((e) => e.ref === 'answer:s3').choice, 'b', 'merging does not change the array it was given')
assert.deepEqual(normalisePreworkEntries({ entries: [{ ref: 'read:s1', stepId: 's1', kind: 'read', at: 5, extra: 1 }, { ref: 'x', stepId: 's1', kind: 'nope' }, null, { kind: 'read' }] }), [{ ref: 'read:s1', stepId: 's1', kind: 'read', at: 5 }])
assert.deepEqual(normalisePreworkEntries(null), [])

// ── Words ────────────────────────────────────────────────────────────────────────────────────
assert.equal(preworkMinutesText(form), 'About 20 minutes', 'tasks by their minutes, one minute for each other step')
assert.equal(preworkKindLabel(form.steps[4]), 'Pre-task · about 10 min')
assert.equal(preworkKindLabel(form.steps[5], true), 'Pre-task · about 5 minutes')
assert.equal(preworkKindLabel(form.steps[2]), 'Quick check')
assert.equal(preworkKindLabel(form.steps[3]), 'Question')
assert.equal(preworkKindLabel(form.steps[0]), 'Slide')
assert.equal(preworkKindIcon(form.steps[6]), 'text-cursor-input')
assert.equal(preworkKindIcon(form.steps[3]), 'chart-bar')
assert.equal(preworkWhen(Date.UTC(2026, 9, 6, 8, 0), 'Europe/London'), 'Tue 6 Oct 09:00')
assert.equal(preworkWhen(Date.UTC(2026, 8, 30, 9, 30), 'Europe/London'), 'Wed 30 Sep 10:30', 'September is Sep, as drawn')
assert.equal(preworkDay(Date.UTC(2026, 8, 30, 9, 30), 'Europe/London'), 'Wed 30 Sep')
assert.equal(preworkWhen(Number.NaN), '')
assert.match(preworkPollHint(form.steps[2]), /^Pick one\. There is no mark/, 'a quick check says there is no mark')
assert.equal(preworkPollHint(form.steps[3]), 'Pick up to 2.')
assert.equal(preworkPollHint(form.steps[6]), 'A sentence is plenty.')

// ── The answer a poll accepts (the Worker's own rule) ────────────────────────────────────────
const single = form.steps[2].poll, multiple = form.steps[3].poll, open = form.steps[6].poll
assert.deepEqual(preworkAnswerReady(single, 'b'), { choice: 'b' })
assert.equal(preworkAnswerReady(single, 'zzz'), null, 'an option the step does not offer is not an answer')
assert.equal(preworkAnswerReady(single, ['a']), null)
assert.deepEqual(preworkAnswerReady(multiple, ['a', 'b', 'a']), { choice: ['a', 'b'] })
assert.equal(preworkAnswerReady(multiple, ['a', 'b', 'c']), null, 'more than maxSelections')
assert.equal(preworkAnswerReady(multiple, []), null)
assert.deepEqual(preworkAnswerReady(open, '  Try one thing  '), { text: 'Try one thing' })
assert.equal(preworkAnswerReady(open, '   '), null)
assert.equal(preworkAnswerReady(open, 'x'.repeat(1001)), null)
const ranking = { type: 'ranking', question: '', options: options('a', 'b', 'c'), rankCount: 2 }
assert.deepEqual(preworkAnswerReady(ranking, ['c', 'a']), { choice: ['c', 'a'] })
assert.equal(preworkAnswerReady(ranking, ['c']), null, 'a ranking needs exactly rankCount')
assert.equal(preworkAnswerReady(ranking, ['c', 'c']), null)
const rating = { type: 'rating', question: '', options: options('a', 'b'), labels: options('lo', 'hi') }
assert.deepEqual(preworkAnswerReady(rating, { a: 'lo', b: 'hi' }), { choice: { a: 'lo', b: 'hi' } })
assert.equal(preworkAnswerReady(rating, { a: 'lo' }), null, 'every item needs a label unless skipping is allowed')
assert.deepEqual(preworkAnswerReady({ ...rating, allowSkip: true }, { a: 'lo' }), { choice: { a: 'lo' } })
assert.equal(preworkAnswerReady(rating, { a: 'lo', b: 'nope' }), null)
assert.equal(preworkDraftFromEntry(entry('answer:s7', 's7', 'answer', { text: 'hi' })), 'hi')
assert.deepEqual(preworkDraftFromEntry(entry('answer:s4', 's4', 'answer', { choice: ['a'] })), ['a'])
assert.equal(preworkDraftFromEntry(null), null)

// ── What a submission is ─────────────────────────────────────────────────────────────────────
assert.deepEqual(preworkSubmission(device, 's1', 'p', 'read'), { participantId: device, submissionId: 's1', stepId: 'p', kind: 'read' })
assert.deepEqual(preworkSubmission(device, 's1', 'p', 'answer', { choice: 'b' }), { participantId: device, submissionId: 's1', stepId: 'p', kind: 'answer', choice: 'b' })
assert.deepEqual(preworkSubmission(device, 's1', 'p', 'answer', { text: 'hi' }), { participantId: device, submissionId: 's1', stepId: 'p', kind: 'answer', text: 'hi' })
assert.deepEqual(preworkSubmission(device, 's1', 'p', 'done', { done: true }), { participantId: device, submissionId: 's1', stepId: 'p', kind: 'done', done: true })
assert.equal(preworkSubmission(device, 's1', 'p', 'done', {}).done, false)
assert.equal('name' in preworkSubmission(device, 's1', 'p', 'question', { text: ' Why? ', name: '  ' }), false, 'no name is sent unless one was typed')
assert.equal(preworkSubmission(device, 's1', 'p', 'question', { text: ' Why? ', name: ' Sam ' }).name, 'Sam')
assert.equal(preworkSubmission(device, 's1', 'p', 'question', { text: ' Why? ' }).text, 'Why?')
const asEntry = preworkEntryFromSubmission(preworkSubmission(device, 'sid', 'p', 'question', { text: 'Why?' }), 7)
assert.deepEqual(asEntry, { ref: 'q:sid', stepId: 'p', kind: 'question', at: 7, text: 'Why?' })
assert.equal(preworkEntryFromSubmission(preworkSubmission(device, 'sid', 'p', 'answer', { choice: 'b' }), 7).ref, 'answer:p')
assert.equal(JSON.stringify(preworkSubmission(device, 'sid', 'p', 'answer', { choice: 'b' })).includes('right'), false, 'a submission never names a right answer')

// ── What a refusal says ──────────────────────────────────────────────────────────────────────
assert.deepEqual(preworkRefusal(410, 'prework_closed'), { text: 'Pre-work has closed, so this could not be saved.', retry: false, closed: true, waitMs: 0 })
assert.equal(preworkRefusal(409, 'prework_not_open').retry, true)
assert.equal(preworkRefusal(429, 'rate_limited', 2000).waitMs, 2000)
assert.equal(preworkRefusal(429, 'rate_limited').waitMs, 8000)
assert.equal(preworkRefusal(429, 'question_limit').retry, false, 'a question cap is final for this device')
assert.equal(preworkRefusal(0, 'network').retry, true)
assert.match(preworkRefusal(0, 'network').text, /Not saved yet/)
assert.equal(preworkRefusal(503, 'prework_unavailable').retry, true)
assert.equal(preworkRefusal(400, 'invalid_answer').retry, false)
assert.equal(preworkRefusal(429, 'rate_limited', 99999999).waitMs, 3600000, 'a wait is capped at an hour')

// ── The client: one at a time per thing, the newest waits, nothing throws ────────────────────
const calls = []
const gates = []
const fakeFetch = (respond) => async (url, init) => {
  const body = JSON.parse(init.body)
  calls.push({ url, body, init })
  const gate = new Promise((resolve) => gates.push(resolve))
  await gate
  return respond(body)
}
const reply = (status, body) => ({ ok: status < 400, status, json: async () => body })
const client = createPreworkClient({ workerBaseUrl: 'https://w.example.test/', preworkId: 'abc12345', fetch: fakeFetch((body) => reply(201, { entry: { at: 5 }, echo: body.submissionId })) })
const first = client.submit('answer:s3', { submissionId: 'one' })
const second = client.submit('answer:s3', { submissionId: 'two' })
const third = client.submit('answer:s3', { submissionId: 'three' })
const other = client.submit('read:s1', { submissionId: 'r1' })
await new Promise((resolve) => setImmediate(resolve))
assert.deepEqual(calls.map((c) => c.body.submissionId), ['one', 'r1'], 'the same key waits for the one in flight; another key goes at once')
assert.equal(calls[0].url, 'https://w.example.test/prework/abc12345/submit')
assert.equal(calls[0].init.credentials, 'omit', 'no credential is ever sent')
assert.equal(calls[0].init.method, 'POST')
gates[0](); gates[1]()
assert.equal((await first).ok, true)
assert.equal((await second).superseded, true, 'a waiting submission that a newer one replaces is dropped, not sent')
await other
await new Promise((resolve) => setImmediate(resolve))
assert.deepEqual(calls.map((c) => c.body.submissionId), ['one', 'r1', 'three'], 'then the newest waiting one runs')
gates[2]()
assert.equal((await third).data.echo, 'three')

const refused = createPreworkClient({ workerBaseUrl: 'https://w.example.test', preworkId: 'abc12345', fetch: async () => reply(429, { error: { code: 'rate_limited' }, retryAfterMs: 1500 }) })
assert.deepEqual(await refused.submit('k', { submissionId: 'x' }), { ok: false, status: 429, code: 'rate_limited', retryAfterMs: 1500 })
const closed = createPreworkClient({ workerBaseUrl: 'https://w.example.test', preworkId: 'abc12345', fetch: async () => reply(410, { error: { code: 'prework_closed' } }) })
assert.deepEqual(await closed.submit('k', { submissionId: 'x' }), { ok: false, status: 410, code: 'prework_closed', retryAfterMs: undefined })
const dead = createPreworkClient({ workerBaseUrl: 'https://w.example.test', preworkId: 'abc12345', fetch: async () => { throw new TypeError('Failed to fetch') } })
assert.deepEqual(await dead.submit('k', { submissionId: 'x' }), { ok: false, status: 0, code: 'network' })
assert.deepEqual(await dead.load('device'), { ok: false, entries: [] }, 'loading with no connection is an answer, not a throw')
const notJson = createPreworkClient({ workerBaseUrl: 'https://w.example.test', preworkId: 'abc12345', fetch: async () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError('no') } }) })
assert.equal((await notJson.submit('k', { submissionId: 'x' })).status, 502)
const mineCalls = []
const mine = createPreworkClient({ workerBaseUrl: 'https://w.example.test', preworkId: 'abc12345', fetch: async (url, init) => { mineCalls.push({ url, body: JSON.parse(init.body) }); return reply(200, { entries: [{ ref: 'read:s1', stepId: 's1', kind: 'read', at: 3 }] }) } })
assert.deepEqual(await mine.load('device'), { ok: true, entries: [{ ref: 'read:s1', stepId: 's1', kind: 'read', at: 3 }] })
assert.deepEqual(mineCalls[0], { url: 'https://w.example.test/prework/abc12345/mine', body: { participantId: 'device' } })

// ── The page embeds each function by toString: nothing may reach for a name outside the source ──
const sandbox = {}
vm.createContext(sandbox)
vm.runInContext(preworkFormRuntimeSource() + '\nthis.exports = { createPreworkClient, createPreworkForm, createPreworkAnswerControls, showPreworkClosed, preworkProgress, preworkAnswerReady, preworkRefusal }', sandbox)
for (const name of ['createPreworkClient', 'createPreworkForm', 'createPreworkAnswerControls', 'showPreworkClosed', 'preworkProgress', 'preworkAnswerReady', 'preworkRefusal']) {
  assert.equal(typeof sandbox.exports[name], 'function', `${name} is defined by the embedded source alone`)
}
assert.equal(sandbox.exports.preworkProgress(form, five).doneCount, 5, 'and the embedded copy computes the same')
assert.equal(preworkFormRuntimeSource().includes('innerHTML ='), true, 'sanity: the source is the real one')
assert.equal((preworkFormRuntimeSource().match(/innerHTML/g) || []).length, 2, 'HTML is written in two places only (the icon helpers), never for participant or author text')

console.log('prework-form: ok')
