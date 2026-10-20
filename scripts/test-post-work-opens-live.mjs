// Work-files ticket 19 against a real live Worker (`wrangler dev`: local, throwaway secrets and state,
// nothing deployed): the post-work opener (src/main/post-work-open.ts) over the app's work service with the
// real registry, an in-memory secrets store, a temp vault and the real atomic Run writer.
//   - post-work that opens when the session ends, sent with the publish: the public page says it is not open
//     yet and refuses an answer;
//   - the live session ends: the opening is pushed; the public page is open and accepts answers; the Run notes
//     when it opened; a repeat end event and a relaunch push nothing more; the answers are pulled onto the Run;
//   - Change time after close: the Run's closing time passes, a later one is set on the delivered Run and
//     pushed (syncWindows): the page takes answers again, with the opening kept;
//   - an unpublished Run (withdrawn, stamped): the session's end pushes nothing; the page stays "not available".
// Usage: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/test-post-work-opens-live.mjs
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startLiveWorker } from './lib/live-worker-harness.mjs'
import { createRunPrework, workPushWindowMs } from '../src/main/run-prework.ts'
import { createPostWorkOpener } from '../src/main/post-work-open.ts'
import { changeDeliveredRunWork, normaliseRun, persistRunForTalk, readRunForTalk, stampRunUnpublished } from '../src/main/runs.ts'
import { memoryOwnerTokens } from './lib/memory-secrets.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const results = []
const pass = (name) => { results.push(name); console.log(`PASS  ${name}`) }
const SLUG = 'post-open-live'
const FORM = {
  title: 'Feedback', intro: '',
  steps: [{ id: 'q1', n: 1, title: 'Useful?', kind: 'question', questions: true, poll: { type: 'open', question: 'Useful?', options: [] } }],
}
/** A wall-clock minute in UTC, `YYYY-MM-DDTHH:MM`, `minutes` from now (rounded down). */
const minute = (minutes) => new Date(Math.floor(Date.now() / 60_000) * 60_000 + minutes * 60_000).toISOString().slice(0, 16)

const worker = await startLiveWorker()
const root = mkdtempSync(join(tmpdir(), 'tw-post-open-live-'))
try {
  const vault = join(root, 'vault')
  mkdirSync(join(vault, '_PRESENTATIONS', SLUG), { recursive: true })
  const runWith = (id, post) => normaliseRun({
    id, talkSlug: SLUG, talkTitle: 'Post open live', kind: 'delivery', status: 'planned', plannedDate: minute(0).slice(0, 10), startTime: '00:00', timeZone: 'UTC',
    slideSet: { kind: 'full' }, startedAt: new Date().toISOString(), endedAt: '', recordingMs: 0, wallClockMs: 0, timerTargetMin: 0, context: null, pathwayId: null,
    audio: null, transcript: null, slideTimeIndex: [], polls: [], pollResponses: [], handoutUrl: 'https://h.test/dl/post-open', work: { post },
  })
  const tokens = memoryOwnerTokens()
  const registryPath = join(root, 'run-prework-registry.json')
  const ended = new Set()
  const makeService = () => createRunPrework({ registryPath, ownerTokens: tokens, endpoint: async () => ({ baseUrl: worker.baseUrl, adminSecret: worker.adminSecret }), vaultRoot: () => vault, fetch })
  let service = makeService()
  let opener = createPostWorkOpener({ service, vaults: () => [vault], liveEnded: (talkSlug, runId, vaultRoot) => vaultRoot === vault && ended.has(`${talkSlug}/${runId}`) })
  const relaunch = () => { service = makeService(); opener = createPostWorkOpener({ service, vaults: () => [vault], liveEnded: (talkSlug, runId, vaultRoot) => vaultRoot === vault && ended.has(`${talkSlug}/${runId}`) }) }
  const run = (id) => readRunForTalk(vault, SLUG, id)
  const status = (id) => fetch(`${worker.baseUrl}/prework/${id}`)
  const submit = (id, text) => fetch(`${worker.baseUrl}/prework/${id}/submit`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ participantId: `device-${randomBytes(8).toString('hex')}`, submissionId: `sub-${randomBytes(6).toString('hex')}`, stepId: 'q1', kind: 'answer', text }) })
  /** Publish for this run, as ticket 16 pushes post-work: the window that never opens, until the session ends. */
  const publish = async (id) => {
    const current = run(id)
    const sent = await service.publish(SLUG, id, FORM, workPushWindowMs(current.work.post, service.status(SLUG, id, 'post')), 'post', vault)
    persistRunForTalk(vault, SLUG, id, { ...current, work: { post: { ...current.work.post, publishedAt: new Date().toISOString() } } })
    return sent.preworkId
  }

  // ── Sent before the session: not open ──────────────────────────────────────────────────────
  const RUN = 'run-post-open-live'
  persistRunForTalk(vault, SLUG, RUN, runWith(RUN, { fileId: 'session-feedback', opens: 'session-end', closes: minute(240), timeZone: 'UTC' }))
  const id = await publish(RUN)
  const before = await (await status(id)).json()
  assert.equal(before.phase, 'post')
  assert.notEqual(before.state, 'open', 'sent before the session, post-work is not open')
  const early = await submit(id, 'Too early')
  assert.equal(early.status, 409, 'and refuses an answer')
  assert.equal((await opener.open(SLUG, RUN, vault)).why, 'not-ended')
  pass('post-work that opens when the session ends, sent with the publish: not open, refuses an answer')

  // ── The live session ends: opened once, answers accepted ──────────────────────────────────────
  ended.add(`${SLUG}/${RUN}`)
  const opened = await opener.open(SLUG, RUN, vault)
  assert.equal(opened.ok && opened.opened && opened.pushed, true, JSON.stringify(opened))
  assert.equal((await (await status(id)).json()).state, 'open', 'the public page is open')
  assert.equal((await submit(id, 'After: useful')).status, 201, 'post-work accepts answers after the push')
  assert.equal(run(RUN).work.post.openedAt, opened.openedAt, 'the Run notes when it opened')
  const openedAt = service.status(SLUG, RUN, 'post').opensAt
  // A repeat end event, the Run marked delivered, a relaunch: nothing pushed again.
  persistRunForTalk(vault, SLUG, RUN, { ...run(RUN), status: 'delivered', endedAt: new Date().toISOString() })
  assert.equal((await opener.open(SLUG, RUN, vault)).why, 'already-open')
  relaunch()
  assert.deepEqual((await opener.openDue()).map((result) => result.why), ['already-open'])
  assert.equal(service.status(SLUG, RUN, 'post').opensAt, openedAt, 'the opening is the one pushed at the end')
  assert.equal((await submit(id, 'After: still open')).status, 201)
  assert.equal((await service.pull(SLUG, RUN, 'post')).ok, true)
  assert.deepEqual(run(RUN).postwork.entries.map((entry) => entry.text).sort(), ['After: still open', 'After: useful'], 'the answers land on the Run, none reset')
  pass('the session ends: post-work opens once and accepts answers; repeat events and a relaunch push nothing more')

  // ── Change time after close reopens it ─────────────────────────────────────────────────────────
  const soon = minute(1)
  changeDeliveredRunWork(vault, SLUG, RUN, { work: { post: { fileId: 'session-feedback', opens: 'session-end', closes: soon } } })
  assert.deepEqual((await service.syncWindows(SLUG, RUN)).map((result) => result.ok), [true])
  await sleep(Math.max(0, Date.parse(`${soon}:00Z`) - Date.now()) + 500)
  assert.equal((await (await status(id)).json()).state, 'closed', 'closed by its date')
  assert.equal((await submit(id, 'After close')).status, 410)
  changeDeliveredRunWork(vault, SLUG, RUN, { work: { post: { fileId: 'session-feedback', opens: 'session-end', closes: minute(240) } } })
  assert.deepEqual((await service.syncWindows(SLUG, RUN)).map((result) => result.ok), [true])
  assert.equal((await (await status(id)).json()).state, 'open', 'a later closing time reopens it')
  assert.equal((await submit(id, 'After: reopened')).status, 201)
  assert.equal(service.status(SLUG, RUN, 'post').opensAt, openedAt, 'with the opening kept')
  assert.equal((await opener.open(SLUG, RUN, vault)).why, 'already-open')
  pass('Change time after close: the delivered Run\'s later closing time reopens post-work, its opening kept')

  // ── An unpublished Run never opens ─────────────────────────────────────────────────────────────
  const GONE = 'run-post-open-unpublished'
  persistRunForTalk(vault, SLUG, GONE, runWith(GONE, { fileId: 'session-feedback', opens: 'session-end', closes: minute(240), timeZone: 'UTC' }))
  const goneId = await publish(GONE)
  assert.deepEqual(await service.withdraw(SLUG, GONE, 'post'), { ok: true, withdrawn: true })
  persistRunForTalk(vault, SLUG, GONE, stampRunUnpublished(run(GONE), new Date().toISOString()))
  persistRunForTalk(vault, SLUG, GONE, { ...run(GONE), status: 'delivered' })
  ended.add(`${SLUG}/${GONE}`)
  const window = service.status(SLUG, GONE, 'post')
  assert.equal((await opener.open(SLUG, GONE, vault)).why, 'unpublished')
  assert.deepEqual(service.status(SLUG, GONE, 'post'), window, 'nothing pushed')
  const hidden = await status(goneId)
  assert.equal(hidden.status, 404)
  assert.equal((await hidden.json()).error.code, 'not_available')
  pass('an unpublished Run: the session\'s end pushes nothing; the page stays "not available"')

  console.log(`\npost-work opens live: ${results.length} groups passed`)
} finally {
  await worker.stop()
  rmSync(root, { recursive: true, force: true })
}
