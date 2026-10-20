// Work-files ticket 13 against a real live Worker (`wrangler dev`: local, throwaway secrets and state,
// nothing deployed): the app's work service (src/main/run-prework.ts) with the real registry, an
// in-memory secrets store, a temp vault and the real atomic Run writer.
//   - one Run, pre-work and post-work: two objects, each pushed as its phase; participants answer each
//     on the public route; each pull lands in its own section of the Run (`prework`, `postwork`), by id;
//   - a phase closed by its date is reopened by a later closing time pushed without the form;
//   - the owner closes early; the Run's closing time moves later; syncWindows re-pushes it and it reopens;
//   - an admin's close stays closed whatever the owner pushes, and the service reports it;
//   - withdraw: the public status answers 404 not_available with no-store; serving again answers 200;
//     the answers can still be pulled.
// Usage: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/test-run-work-service-live.mjs
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startLiveWorker } from './lib/live-worker-harness.mjs'
import { createRunPrework, workWindowMs } from '../src/main/run-prework.ts'
import { normaliseRun, persistRunForTalk, readRunForTalk } from '../src/main/runs.ts'
import { memoryOwnerTokens } from './lib/memory-secrets.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const results = []
const pass = (name) => { results.push(name); console.log(`PASS  ${name}`) }
const SLUG = 'work-service-live'
const RUN = 'run-work-live'
const FORM = {
  title: 'Work', intro: '',
  steps: [
    { id: 's1', n: 1, title: 'Read this', kind: 'slide', questions: true },
    { id: 'q1', n: 2, title: 'Hopes', kind: 'question', questions: true, poll: { type: 'open', question: 'Hopes', options: [] } },
  ],
}
/** A wall-clock minute in UTC, `YYYY-MM-DDTHH:MM`, `minutes` from now (rounded down). */
const minute = (minutes) => new Date(Math.floor(Date.now() / 60_000) * 60_000 + minutes * 60_000).toISOString().slice(0, 16)

const worker = await startLiveWorker()
const root = mkdtempSync(join(tmpdir(), 'tw-work-service-live-'))
try {
  const vault = join(root, 'vault')
  mkdirSync(join(vault, '_PRESENTATIONS', SLUG), { recursive: true })
  const runWith = (work) => normaliseRun({
    id: RUN, talkSlug: SLUG, talkTitle: 'Work live', kind: 'delivery', status: 'planned', plannedDate: minute(0).slice(0, 10), startTime: '10:00', timeZone: 'UTC',
    slideSet: { kind: 'full' }, startedAt: new Date().toISOString(), endedAt: '', recordingMs: 0, wallClockMs: 0, timerTargetMin: 0, context: null, pathwayId: null,
    audio: null, transcript: null, slideTimeIndex: [], polls: [], pollResponses: [], work,
  })
  const work = {
    pre: { fileId: 'intake', opens: minute(-60), closes: minute(120), timeZone: 'UTC' },
    post: { fileId: 'feedback', opens: minute(-30), closes: minute(240), timeZone: 'UTC' },
  }
  persistRunForTalk(vault, SLUG, RUN, runWith(work))
  const tokens = memoryOwnerTokens()
  const registryPath = join(root, 'run-prework-registry.json')
  const service = createRunPrework({ registryPath, ownerTokens: tokens, endpoint: async () => ({ baseUrl: worker.baseUrl, adminSecret: worker.adminSecret }), vaultRoot: () => vault, fetch })
  const run = () => readRunForTalk(vault, SLUG, RUN)
  const status = (id) => fetch(`${worker.baseUrl}/prework/${id}`)
  const submit = (id, body) => fetch(`${worker.baseUrl}/prework/${id}/submit`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ participantId: `device-${randomBytes(8).toString('hex')}`, submissionId: `sub-${randomBytes(6).toString('hex')}`, ...body }) })

  // ── Two phases, one Run ─────────────────────────────────────────────────────────────────────
  const pre = await service.publish(SLUG, RUN, FORM, workWindowMs(run().work.pre), 'pre')
  const post = await service.publish(SLUG, RUN, FORM, workWindowMs(run().work.post), 'post')
  assert.notEqual(pre.preworkId, post.preworkId)
  assert.equal((await (await status(pre.preworkId)).json()).phase, 'pre')
  assert.equal((await (await status(post.preworkId)).json()).phase, 'post')
  const device = `device-${randomBytes(8).toString('hex')}`
  assert.equal((await submit(pre.preworkId, { participantId: device, stepId: 'q1', kind: 'answer', text: 'Before: a first answer' })).status, 201)
  assert.equal((await submit(pre.preworkId, { participantId: device, stepId: 'q1', kind: 'answer', text: 'Before: changed my mind' })).status, 201)
  assert.equal((await submit(post.preworkId, { stepId: 'q1', kind: 'answer', text: 'After: useful' })).status, 201)
  assert.equal((await submit(post.preworkId, { stepId: 's1', kind: 'read' })).status, 201)
  assert.equal((await service.pull(SLUG, RUN, 'pre')).ok, true)
  assert.equal((await service.pull(SLUG, RUN, 'post')).ok, true)
  assert.deepEqual(run().prework.entries.map((entry) => entry.text), ['Before: changed my mind'], 'pre-work: one answer per person and step, the latest')
  assert.deepEqual(run().postwork.entries.map((entry) => entry.text ?? entry.kind).sort(), ['After: useful', 'read'], 'post-work in its own section')
  const rows = Object.values(JSON.parse(readFileSync(registryPath, 'utf8')).preworks)
  assert.equal(rows.length, 2)
  assert.ok(rows.every((row) => !('ownerToken' in row)), 'the registry file holds no owner token')
  pass('one Run, two phases: each object holds its phase; answers land in prework and postwork, merged by id')

  // ── Closed by its date, reopened by a later closing time (window only) ──────────────────────
  const brief = { opensAt: Date.now() - 60_000, closesAt: Date.now() + 2_000 }
  const pushed = await service.pushWindow(SLUG, RUN, 'post', brief)
  assert.equal(pushed.ok, true, pushed.error)
  await sleep(Math.max(0, brief.closesAt - Date.now()) + 300)
  assert.equal((await (await status(post.preworkId)).json()).state, 'closed')
  assert.equal((await submit(post.preworkId, { stepId: 's1', kind: 'read' })).status, 410)
  const later = await service.pushWindow(SLUG, RUN, 'post', { opensAt: brief.opensAt, closesAt: Date.now() + 60 * 60_000 })
  assert.equal(later.ok && later.closedAt, undefined, 'reported open')
  assert.equal((await (await status(post.preworkId)).json()).state, 'open', 'a later closing time reopens it')
  assert.equal((await submit(post.preworkId, { stepId: 'q1', kind: 'answer', text: 'After: reopened' })).status, 201)
  pass('closed by its date, then a later closing time pushed without the form: reopened, answers taken again')

  // ── The owner closes early; the Run's closing time moves later: syncWindows reopens it ──────
  assert.equal((await service.close(SLUG, RUN, 'pre')).ok, true)
  assert.equal((await (await status(pre.preworkId)).json()).state, 'closed')
  assert.equal(typeof run().prework.closedAt, 'number', 'the Run says it closed early')
  persistRunForTalk(vault, SLUG, RUN, { ...run(), work: { ...run().work, pre: { ...work.pre, closes: minute(180) } } })
  const synced = await service.syncWindows(SLUG, RUN)
  assert.equal(synced.find((result) => result.phase === 'pre')?.ok, true, JSON.stringify(synced))
  assert.equal((await (await status(pre.preworkId)).json()).state, 'open', 'the owner\'s early close is lifted by the later closing time')
  assert.equal((await service.pull(SLUG, RUN, 'pre')).ok, true)
  assert.equal(run().prework.closedAt, undefined, 'and the Run no longer says closed')
  pass('the owner closed early, the Run\'s closing time moved later: syncWindows re-pushes it and the work reopens; the Run follows')

  // ── An admin's close stays ──────────────────────────────────────────────────────────────────
  assert.equal((await fetch(`${worker.baseUrl}/prework/${post.preworkId}/close`, { method: 'POST', headers: { authorization: `Bearer ${worker.adminSecret}` } })).status, 200)
  const kept = await service.pushWindow(SLUG, RUN, 'post', { opensAt: brief.opensAt, closesAt: Date.now() + 3 * 60 * 60_000 })
  assert.equal(kept.ok && typeof kept.closedAt, 'number', 'the push reports it still closed')
  assert.equal((await (await status(post.preworkId)).json()).state, 'closed', 'an admin close stays closed')
  pass('an admin\'s close stays closed whatever the owner pushes, and the service reports it')

  // ── Withdraw and serve again ────────────────────────────────────────────────────────────────
  assert.deepEqual(await service.withdraw(SLUG, RUN, 'pre'), { ok: true, withdrawn: true })
  const hidden = await status(pre.preworkId)
  assert.equal(hidden.status, 404)
  assert.equal(hidden.headers.get('cache-control'), 'no-store', '"not available" is never cached')
  assert.equal((await hidden.json()).error.code, 'not_available')
  assert.equal((await service.pull(SLUG, RUN, 'pre')).ok, true, 'the answers can still be pulled')
  assert.deepEqual(await service.withdraw(SLUG, RUN, 'pre', false), { ok: true, withdrawn: false })
  const back = await status(pre.preworkId)
  assert.equal(back.status, 200, 'published again, it is seen again')
  assert.equal(back.headers.get('cache-control'), 'no-store')
  pass('withdraw: "not available" with no-store; the answers can still be pulled; serving again answers at once')

  console.log(`\nrun work service live: ${results.length} groups passed`)
} finally {
  await worker.stop()
  rmSync(root, { recursive: true, force: true })
}
